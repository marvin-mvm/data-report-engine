#!/usr/bin/env node
// Rebuild the LA swimming pool permit dataset behind
// /blog/los-angeles-swimming-pool-permit-report-2026.
//
// Source: City of Los Angeles open data, dataset pi9x-tg5x
// ("Building and Safety - Building Permits Issued from 2020 to Present").
// Public, no API key, updated daily. Portal is data.lacity.org — .gov does not resolve.
//
// Usage:
//   node examples/la-building-permits/la-pool-permit-data.mjs                  # rewrite the published dataset
//   node examples/la-building-permits/la-pool-permit-data.mjs --out /tmp/x     # dry run
//   node examples/la-building-permits/la-pool-permit-data.mjs --cutoff 12-31   # move the matched window
//   node examples/la-building-permits/la-pool-permit-data.mjs --audit          # print classification samples
//
// WHAT IS MEASURED: permits of type 'Swimming-Pool/Spa' on houses
// (permit_sub_type '1 or 2 Family Dwelling'), classified from the work description into
// new pool / remodel / spa only / removal / other. The headline unit is the NEW POOL PERMIT.
//
// ⚠️ TRAP 1 — ABOUT A QUARTER OF POOL PERMITS ARE REVISIONS, NOT POOLS. A supplemental permit
// revises an earlier one. The permit number shows it: an original's middle block ends in 0000
// (e.g. 26047-20000-00123) and a revision counts up from it (-20001-, -20002-). A few revisions
// carry an original-style number but say "supplemental to permit #..." — caught by wording.
// Left in, revisions inflate every count by roughly a third.
//
// ⚠️ TRAP 2 — THE PERMIT TYPE DOES NOT SAY WHAT WAS BUILT. New pools, remodels, spa-only jobs,
// equipment moves and renewals of expired permits all share the type. Classification is from
// work_desc. A renewal ("complete work under expired permit", "70% complete") is NOT a new pool:
// it double-counts a pool permitted years earlier. "Remove the existing pool and construct a new
// one" IS a new pool. Run --audit after any change to the rules and read the samples.
//
// ⚠️ TRAP 3 — THE AREA FIELD IS NOT CLEAN. community plan area (cpa) carries truncated
// variants of three areas ("...Woodland Hill", "...Cahuenga", "...Shadow Hls-Tu") and a few
// two-area labels ("A, B"). Merge to one canonical name each, or areas are undercounted.
//
// ⚠️ TRAP 4 — THE DATASET STARTS IN JANUARY 2020. A pool is permitted up to ~2 years after its
// house (median 3.3 months), so the "built with a new house" share can only be measured for pool
// cohorts whose full lookback lies inside the data: 2022 onward. Earlier years would be
// understated, and the current year is reported only up to cutoff minus the 6-month lookahead.
//
// Matched windows: every year is cut to January 1 – cutoff (default 10-23), so a partial
// current year is compared like-for-like. Declared valuation is NOT used: it is a fee figure.

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd(); // run from the site root: output defaults to ./public/data/<slug>
const SLUG = "los-angeles-swimming-pool-permit-report-2026";
const API = "https://data.lacity.org/resource/pi9x-tg5x.json";
const DATASET_URL = "https://data.lacity.org/City-Infrastructure-Service-Requests/Building-and-Safety-Building-Permits-Issued-from-2/pi9x-tg5x";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";

const arg = (f, d) => { const i = process.argv.indexOf(f); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const OUT = resolve(ROOT, arg("--out", `public/data/${SLUG}`));
const CUTOFF = arg("--cutoff", "10-23");              // matched window: Jan 1 - CUTOFF
const AUDIT = process.argv.includes("--audit");
const FIRST_YEAR = 2020;
const PAL = "Brentwood - Pacific Palisades";
const MIN_AREA_N = 60;                                // engineering shares need n >= 60
const DEDUPE_DAYS = 180;                              // "part 1 of 2" repeats on one parcel
const HOUSE_BEFORE_MO = 24, HOUSE_AFTER_MO = 6;       // trap 4 window
const MO = 30.44;

// ---- classification (trap 2) ---------------------------------------------------------------
const SUPPL_TO = /SUPPLEMENTAL\s+(PERMIT\s+)?(TO|FOR|REF)|SUPPL\.?\s+(PERMIT\s+)?TO|SUPPLEMENTAL\s+#|REVISION TO PERMIT/i;
const RENEWAL = /\bRENEW|EXPIRED|COMPLETE WORK|\d+\s*%\s*COMPLETE/i;
const REPLACE_NEW = /REMOV\w*[^.;]{0,40}\b(POOL|SHELL)\b[^.;]{0,60}\b(NEW|CONSTRUCT|BUILD)\b[^.;]{0,30}\bPOOL|\bPOOL\b[^.;]{0,25}\bTO BE REMOVED\b[^.;]{0,60}\bNEW\b[^.;]{0,40}\bPOOL|REPLACE\s+W(ITH|\/)\s*NEW\s+POOL|REMOVE\s+EXISTING\s+POOL\s+FOR\s+NEW\s+POOL/i;
const REMOVAL = /\bDEMO|REMOV(E|AL)\b.*\b(POOL|SPA)|(POOL|SPA)\b.*\bREMOV|\bFILL(ING|ED)?\s*(IN|-IN)?\b.*\bPOOL|\bPOOL\b.*\bFILL|ABANDON|DECOMMISSION/i;
const REMODEL = /REMODEL|\(E\)\s*(SWIMMING\s+)?(POOL|SPA)|EXISTING\s+(SWIMMING\s+)?(POOL|SPA)|RENOVAT|REPLASTER|RE-?PLASTER|RESURFAC|REPAIR|ALTERATION|\bALTER\b|\bCONVERT/i;
const POOL = /\bPOOL/i;
const SPA = /\bSPA\b|HOT\s*TUB|JACUZZI/i;
const NEW_SIGNAL = /\b(NEW|\(N\)|PROPOSED|BUILD|CONSTRUCT|INSTALL)\b|\d\s*['’"”]?\s*-?\s*\d*\s*['’"”]?\s*[X×]\s*\d|IRREG|IRR\.?\s*SHAPE|STANDARD\s*PLAN|STD\.?\s*PLAN|SHOTCRETE|GUNITE/i;
const NOT_A_POOL_JOB = /RELOCAT|ENCLOSURE|EQUIP|FENCE|\bGATE\b|BARRIER|DROWNING|ALARM|HEATER|\bSOLAR\b|LIGHT/i;
const POND = /\bPOND\b|\bKOI\b/i;
const POOL_SIZE_WITH_SPA = /\d[^.;X×]{0,12}[X×][^.;]{0,12}\d[^.;]{0,25}\bWITH\b[^.;]{0,6}\d[^.;X×]{0,12}[X×][^.;]{0,12}\d[^.;]{0,15}\bSPA\b/i;

export const isOriginal = (nbr) => { const m = /^\d{5}-(\d{5})-\d+/.exec(nbr || ""); return !!m && Number(m[1]) % 10000 === 0; };
export function classify(p) {
  const w = p.work_desc || "";
  if (!isOriginal(p.permit_nbr) || SUPPL_TO.test(w)) return "revision";
  if (RENEWAL.test(w)) return "other";
  if (REPLACE_NEW.test(w)) return "new_pool";
  if (REMODEL.test(w)) return "remodel";
  if (REMOVAL.test(w)) return POOL.test(w) && NEW_SIGNAL.test(w) ? "new_pool" : "removal";
  if (POOL.test(w)) {
    if (POND.test(w) && !/SWIMMING|SPA/i.test(w)) return "other";
    if (NOT_A_POOL_JOB.test(w) && !NEW_SIGNAL.test(w)) return "other";
    return "new_pool";
  }
  if (POOL_SIZE_WITH_SPA.test(w)) return "new_pool";   // "(N) 35' X 16' WITH 10' X 9' SPA": a pool never named
  if (SPA.test(w)) return "spa_only";
  return "other";
}
const STANDARD_PLAN = /STANDARD\s*PLAN|STD\.?\s*PLAN|STANDART PLAN|PLAN\s*#?\s*N?O?\.?\s*2(54|65|68|70)\b/i;
const PLAN_268 = /268/;
const PILES = /\bPILES?\b|CAISSON|DRILLED|\bPIER/i;
const WILDFIRE = /WILDFIRE|FIRE REBUILD|EXECUTIVE ORDER|\bEO\s*-?\s*\d/i;

// ---- helpers ---------------------------------------------------------------------------------
async function soql(q) {
  const r = await fetch(`${API}?$query=${encodeURIComponent(q)}`, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`Socrata ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const b = await r.json();
  if (!Array.isArray(b)) throw new Error(`Socrata error: ${JSON.stringify(b).slice(0, 200)}`);
  return b;
}
async function fetchAll(where, select) {
  const out = [];
  for (let off = 0; ; off += 50000) {
    const page = await soql(`SELECT ${select} WHERE ${where} ORDER BY permit_nbr LIMIT 50000 OFFSET ${off}`);
    out.push(...page);
    if (page.length < 50000) break;
  }
  return out;
}
const day = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86400000;
const iso = (d) => new Date(d * 86400000).toISOString().slice(0, 10);
const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : null);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
const pctile = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(q * (s.length - 1))]; };
const inWindow = (isoDate) => isoDate.slice(5, 10) <= CUTOFF;
const key = (s) => (s || "").toLowerCase().replace(/[^a-z]/g, "");

function areaNormalizer(labels) {
  const canon = [...new Set(labels.filter(Boolean).map((l) => l.split(", ")[0].trim()))].sort((a, b) => b.length - a.length);
  const memo = new Map();
  return (label) => {
    if (!label) return null;
    if (memo.has(label)) return memo.get(label);
    const first = label.split(", ")[0].trim(), k = key(first);
    const hit = canon.find((c) => key(c) === k || key(c).startsWith(k)) ?? first;
    memo.set(label, hit);
    return hit;
  };
}

// ---- main ----------------------------------------------------------------------------------
const main = async () => {
  const sel = "permit_nbr, apn, cpa, permit_sub_type, use_desc, work_desc, submitted_date, issue_date";
  const raw = await fetchAll(`permit_type='Swimming-Pool/Spa' AND issue_date >= '${FIRST_YEAR}-01-01'`, sel);
  const houses = await fetchAll(`permit_type='Bldg-New' AND use_desc='Dwelling - Single Family' AND issue_date >= '${FIRST_YEAR}-01-01'`,
    "permit_nbr, apn, cpa, work_desc, issue_date");
  const extract = iso(Math.max(...raw.map((p) => day(p.issue_date)), ...houses.map((h) => day(h.issue_date))));
  const E = day(extract), lastYear = +extract.slice(0, 4);
  const norm = areaNormalizer([...raw.map((p) => p.cpa), ...houses.map((h) => h.cpa)]);

  // classify, homes only, then dedupe repeats on one parcel
  const counts = { all_pool_type_permits: raw.length };
  const cls = raw.map((p) => ({ ...p, apn: p.apn || `NOAPN-${p.permit_nbr}`, k: classify(p), d: day(p.issue_date),
    iss: p.issue_date.slice(0, 10), area: norm(p.cpa) }));
  counts.revisions = cls.filter((p) => p.k === "revision").length;
  const homes = cls.filter((p) => p.permit_sub_type === "1 or 2 Family Dwelling" && p.use_desc !== "No Fee/Dept. Error");
  counts.non_home_or_error_records = cls.length - homes.length;
  homes.sort((a, b) => (a.apn < b.apn ? -1 : a.apn > b.apn ? 1 : a.k < b.k ? -1 : a.k > b.k ? 1 : a.d - b.d));
  const kept = [], lastKept = new Map();
  for (const p of homes) {
    const kk = `${p.apn}|${p.k}`;
    if ((p.k === "new_pool" || p.k === "spa_only") && lastKept.has(kk) && p.d - lastKept.get(kk) <= DEDUPE_DAYS) continue;
    lastKept.set(kk, p.d); kept.push(p);
  }
  counts.same_parcel_repeats_removed = homes.length - kept.length;
  const byClass = (k) => kept.filter((p) => p.k === k);
  const NP = byClass("new_pool");
  counts.classes_on_homes = Object.fromEntries(["new_pool", "remodel", "spa_only", "removal", "other", "revision"].map((k) => [k, byClass(k).length]));

  if (AUDIT) {
    for (const k of ["new_pool", "remodel", "removal", "spa_only", "other"]) {
      const xs = byClass(k); console.log(`\n== ${k} (${xs.length})`);
      for (let i = 0; i < Math.min(12, xs.length); i++) console.log("  ", (xs[Math.floor((i * xs.length) / 12)].work_desc || "").slice(0, 140));
    }
  }

  // Finding 1 + 2: by year, matched window; Palisades vs rest
  const years = Array.from({ length: lastYear - FIRST_YEAR + 1 }, (_, i) => FIRST_YEAR + i);
  const byYear = years.map((y) => {
    const inY = (p) => +p.iss.slice(0, 4) === y;
    const m = NP.filter((p) => inY(p) && inWindow(p.iss));
    const pal = m.filter((p) => p.area === PAL).length;
    return { year: y, window: `Jan 1 - ${CUTOFF}`, new_pools: m.length, brentwood_pacific_palisades: pal, rest_of_city: m.length - pal,
      remodels: byClass("remodel").filter((p) => inY(p) && inWindow(p.iss)).length,
      spa_only: byClass("spa_only").filter((p) => inY(p) && inWindow(p.iss)).length,
      new_pools_full_year: y < lastYear ? NP.filter(inY).length : null };
  });

  // Finding 2b: by area
  const areas = new Map();
  for (const p of NP) {
    if (!p.area) continue;
    const a = areas.get(p.area) ?? { area: p.area, y: {}, recent: [] };
    if (inWindow(p.iss)) a.y[+p.iss.slice(0, 4)] = (a.y[+p.iss.slice(0, 4)] ?? 0) + 1;
    if (p.iss >= "2023-01-01") a.recent.push(p);
    areas.set(p.area, a);
  }
  const cityLast = byYear.at(-1).new_pools;
  const byArea = [...areas.values()].map((a) => {
    const row = { community_plan_area: a.area };
    for (const y of years) row[`new_pools_${y}`] = a.y[y] ?? 0;
    row[`share_of_city_${lastYear}_pct`] = pct(a.y[lastYear] ?? 0, cityLast);
    row.new_pools_2023_to_date = a.recent.length;
    const ok = a.recent.length >= MIN_AREA_N;
    row.custom_engineered_pct_2023_to_date = ok ? pct(a.recent.filter((p) => !STANDARD_PLAN.test(p.work_desc || "")).length, a.recent.length) : null;
    row.on_piles_or_caissons_pct_2023_to_date = ok ? pct(a.recent.filter((p) => PILES.test(p.work_desc || "")).length, a.recent.length) : null;
    return row;
  }).sort((x, y) => y[`new_pools_${lastYear}`] - x[`new_pools_${lastYear}`] || x.community_plan_area.localeCompare(y.community_plan_area));

  // Finding 3: wildfire rebuild
  const fireFirst = new Map();
  for (const h of houses) if (h.apn && WILDFIRE.test(h.work_desc || "")) {
    const d = day(h.issue_date); if (!fireFirst.has(h.apn) || d < fireFirst.get(h.apn)) fireFirst.set(h.apn, d);
  }
  const palNow = NP.filter((p) => p.area === PAL && +p.iss.slice(0, 4) === lastYear);
  const poolsByApn = new Map(); for (const p of NP) poolsByApn.set(p.apn, [...(poolsByApn.get(p.apn) ?? []), p.d]);
  const quarter = (d) => { const s = iso(d); return `${s.slice(0, 4)}Q${Math.floor((+s.slice(5, 7) - 1) / 3) + 1}`; };
  const rebuildQuarters = {}; for (const d of fireFirst.values()) rebuildQuarters[quarter(d)] = (rebuildQuarters[quarter(d)] ?? 0) + 1;
  const horizons = [6, 12].map((hz) => {
    const base = [...fireFirst].filter(([, d]) => E - d >= hz * MO);
    const hits = base.filter(([apn, d]) => (poolsByApn.get(apn) ?? []).some((pd) => pd - d >= -183 && pd - d <= hz * MO));
    return { horizon_months: hz, rebuild_parcels_with_full_horizon: base.length, with_new_pool_permit: hits.length, share_pct: pct(hits.length, base.length) };
  });
  const wildfire = {
    palisades_new_pools_current_year: palNow.length,
    with_wildfire_wording: palNow.filter((p) => WILDFIRE.test(p.work_desc || "")).length,
    on_a_wildfire_rebuild_parcel: palNow.filter((p) => fireFirst.has(p.apn)).length,
    tied_to_rebuild_either_way: palNow.filter((p) => WILDFIRE.test(p.work_desc || "") || fireFirst.has(p.apn)).length,
    wildfire_rebuild_house_parcels: fireFirst.size,
    rebuild_house_permits_by_quarter: Object.fromEntries(Object.entries(rebuildQuarters).sort()),
    pool_permit_within_horizon_of_rebuild_house_permit: horizons,
  };
  wildfire.tied_share_pct = pct(wildfire.tied_to_rebuild_either_way, palNow.length);

  // Finding 4: built with a new house (trap 4)
  const housesByApn = new Map(); for (const h of houses) if (h.apn) housesByApn.set(h.apn, [...(housesByApn.get(h.apn) ?? []), day(h.issue_date)]);
  const withHouse = (p) => (housesByApn.get(p.apn) ?? []).some((hd) => { const g = (p.d - hd) / MO; return g >= -HOUSE_AFTER_MO && g <= HOUSE_BEFORE_MO; });
  const lookaheadEnd = iso(E - 183);
  const cohorts = [];
  for (let y = 2022; y <= lastYear; y++) {
    const lo = `${y}-01-01`, hi = y < lastYear ? `${y}-12-31` : lookaheadEnd;
    if (hi < lo) continue;
    const c = NP.filter((p) => p.iss >= lo && p.iss <= hi);
    if (!c.length) continue;
    const rest = c.filter((p) => p.area !== PAL), pal = c.filter((p) => p.area === PAL);
    cohorts.push({ pool_permits_issued: y < lastYear ? String(y) : `${y} (Jan 1 - ${hi.slice(5)})`,
      all_pct: pct(c.filter(withHouse).length, c.length), all_n: c.length,
      rest_of_city_pct: pct(rest.filter(withHouse).length, rest.length), rest_of_city_n: rest.length,
      brentwood_pacific_palisades_pct: pct(pal.filter(withHouse).length, pal.length), brentwood_pacific_palisades_n: pal.length });
  }

  // Finding 5 + 6: engineering and approval time, 2023 onward
  const recent = NP.filter((p) => p.iss >= "2023-01-01");
  const std = recent.filter((p) => STANDARD_PLAN.test(p.work_desc || ""));
  const engineering = { new_pools: recent.length, standard_plan: std.length, standard_plan_pct: pct(std.length, recent.length),
    custom_engineered_pct: pct(recent.length - std.length, recent.length),
    standard_plan_citing_268_pct: pct(std.filter((p) => PLAN_268.test(p.work_desc || "")).length, std.length),
    on_piles_or_caissons_pct: pct(recent.filter((p) => PILES.test(p.work_desc || "")).length, recent.length) };
  const approval = [["City standard plan", std], ["Custom-engineered", recent.filter((p) => !STANDARD_PLAN.test(p.work_desc || ""))]].map(([label, xs]) => {
    const ds = xs.filter((p) => p.submitted_date).map((p) => p.d - day(p.submitted_date)).filter((v) => v >= 0);
    return { plan_type: label, permits: ds.length, median_days: median(ds), p25_days: pctile(ds, 0.25), p75_days: pctile(ds, 0.75) };
  });
  const approvalByYear = years.map((y) => {
    const ds = NP.filter((p) => +p.iss.slice(0, 4) === y && p.submitted_date).map((p) => p.d - day(p.submitted_date)).filter((v) => v >= 0);
    return { issue_year: y, permits: ds.length, median_days: median(ds) };
  });

  // ---- write ----
  mkdirSync(OUT, { recursive: true });
  const csv = (rows, cols) => [cols.join(","), ...rows.map((r) => cols.map((c) => {
    const v = r[c] ?? ""; return typeof v === "string" && /[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  }).join(","))].join("\n") + "\n";
  writeFileSync(`${OUT}/new-pool-permits-by-year.csv`, csv(byYear,
    ["year", "window", "new_pools", "brentwood_pacific_palisades", "rest_of_city", "remodels", "spa_only", "new_pools_full_year"]));
  const areaCols = ["community_plan_area", ...years.map((y) => `new_pools_${y}`), `share_of_city_${lastYear}_pct`,
    "new_pools_2023_to_date", "custom_engineered_pct_2023_to_date", "on_piles_or_caissons_pct_2023_to_date"];
  writeFileSync(`${OUT}/new-pool-permits-by-community-plan-area.csv`, csv(byArea, areaCols));
  writeFileSync(`${OUT}/pools-with-a-new-house.csv`, csv(cohorts,
    ["pool_permits_issued", "all_pct", "all_n", "rest_of_city_pct", "rest_of_city_n", "brentwood_pacific_palisades_pct", "brentwood_pacific_palisades_n"]));
  writeFileSync(`${OUT}/pool-permit-approval-days.csv`, csv(approval, ["plan_type", "permits", "median_days", "p25_days", "p75_days"]));
  writeFileSync(`${OUT}/swimming-pool-permits.json`, JSON.stringify({
    report: "2026 Los Angeles Swimming Pool Permit Report",
    source: { portal: "data.lacity.org", dataset: "pi9x-tg5x", dataset_url: DATASET_URL, extract_date: extract },
    measure: "permits of type Swimming-Pool/Spa on houses (permit_sub_type '1 or 2 Family Dwelling'), revisions removed, classified from the work description; matched January 1 - cutoff window each year",
    matched_window: `Jan 1 - ${CUTOFF}`,
    caveats: [
      "A permit is permission to build, not proof that a pool was built. Completion is not measured.",
      "About a quarter of pool-type permits are revisions of an earlier permit (identified by permit number and wording) and are excluded.",
      "Work type is classified from the free-text work description, so a small share of records may be misclassified; renewals of expired permits are excluded as they repeat an earlier pool.",
      "'With a new house' means a new single-family house permit on the same parcel number from 24 months before to 6 months after the pool permit. Lot splits and merges change parcel numbers, so it is a lower bound. Measured only for cohorts whose full window lies inside the dataset (2022 onward).",
      "Custom-engineered means the work description does not cite a City standard pool plan.",
      "Application-to-issue days include time the application spends with the applicant, and cover only permits that were issued.",
      "The community plan area field contains truncated duplicates of three areas; they are merged.",
      "Declared valuation is not used: it is a fee figure, not a construction cost.",
    ],
    counts,
    new_pool_permits_by_year: byYear,
    new_pool_permits_by_community_plan_area: byArea,
    wildfire_rebuild: wildfire,
    pools_with_a_new_house: cohorts,
    engineering_2023_to_date: engineering,
    approval_days_2023_to_date: approval,
    approval_median_days_by_issue_year: approvalByYear,
  }, null, 2) + "\n");

  console.log(`extract ${extract} | window Jan 1 - ${CUTOFF} | wrote 5 files to ${OUT}`);
  console.log("counts:", JSON.stringify(counts));
  console.table(byYear);
  console.table(byArea.slice(0, 12).map((a) => ({ area: a.community_plan_area.slice(0, 40), [lastYear - 1]: a[`new_pools_${lastYear - 1}`], [lastYear]: a[`new_pools_${lastYear}`], share: a[`share_of_city_${lastYear}_pct`], custom: a.custom_engineered_pct_2023_to_date, piles: a.on_piles_or_caissons_pct_2023_to_date })));
  console.log("wildfire:", JSON.stringify(wildfire));
  console.table(cohorts);
  console.log("engineering:", JSON.stringify(engineering));
  console.table(approval);
};
main().catch((e) => { console.error(e.message); process.exit(1); });
