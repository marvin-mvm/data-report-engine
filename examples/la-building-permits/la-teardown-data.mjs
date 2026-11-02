#!/usr/bin/env node
// Rebuild the LA teardown & replacement dataset behind
// /blog/los-angeles-teardown-replacement-report-2026.
//
// Source: City of Los Angeles open data, dataset pi9x-tg5x
// ("Building and Safety - Building Permits Issued from 2020 to Present").
// Public, no API key, updated daily. Portal is data.lacity.org — .gov does not resolve.
//
// Usage:
//   node examples/la-building-permits/la-teardown-data.mjs                # rewrite the published dataset
//   node examples/la-building-permits/la-teardown-data.mjs --out /tmp/x   # dry run
//
// WHAT IS MEASURED: single-family houses demolished, joined by parcel (APN) to any later
// Bldg-New permit on the same parcel. APN coverage is 100% of demolitions and 99.99% of
// new builds, so the join is sound.
//
// ⚠️ TRAP 1 — THE UNIT IS THE PARCEL, NOT THE PERMIT. 4,943 demolition permits cover only
// 4,544 parcels; 201 parcels carry more than one. Counting permits inflates every
// denominator by ~8%. Deduplicate to the earliest demolition permit per APN.
//
// ⚠️ TRAP 2 — DEMOLITION IS OFTEN NOT THE FIRST STEP. 7.4% of parcels had the new house
// permit BEFORE the demolition permit. Counting only permits issued on/after the demolition
// silently drops them and understates replacement by several points. A replacement therefore
// counts within LOOKBACK months before the demolition through N months after. The lookback
// is a judgement call: 12 months captures 91.8% of pre-demolition permits (they cluster at a
// median of 1.0 month); 24 would capture 99.1% and raise the shares slightly.
//
// ⚠️ TRAP 3 — THE DEMOLITION LABEL CHANGED DURING 2025. use_desc 'Dwelling - Single Family'
// went 678 (2024) -> 508 (2025) -> 73 (2026) while a generic use_desc 'Demolition' went
// ~1/year -> 375 -> 970. Read naively that is an 86% collapse; the real total ROSE. The
// generic bucket also mixes houses with garages and patio covers, so it cannot simply be
// added. This is why cohorts stop at 2024. (Bldg-New is NOT affected — checked.)
//
// ⚠️ TRAP 4 — LOT MERGES AND SPLITS CHANGE THE APN, so a parcel rebuilt under a new parcel
// identifier looks like it was never rebuilt. The "nothing permitted" share is an UPPER BOUND.
//
// Fixed-horizon cohort shares throughout: a horizon is reported only once every parcel in
// that cohort has had the full period to run against the extract date.

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd(); // run from the site root: output defaults to ./public/data/<slug>
const SLUG = "los-angeles-teardown-replacement-report-2026";
const API = "https://data.lacity.org/resource/pi9x-tg5x.json";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";

const arg = (f, d) => { const i = process.argv.indexOf(f); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const OUT = resolve(ROOT, arg("--out", `public/data/${SLUG}`));
const LOOKBACK = Number(arg("--lookback", "12"));
const HORIZONS = [12, 24, 36, 48];
const HEADLINE_H = 24;
const MIN_AREA_N = 40;
const LAST_CLEAN_COHORT = 2024;   // trap 3

const HOUSE = new Set(["Dwelling - Single Family"]);
const MULTI = new Set(["Duplex", "Apartment", "Condominium", "Townhouse"]);

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

const day = (s) => (s ? new Date(`${s.slice(0, 10)}T00:00:00Z`) : null);
const addMonths = (d, m) => {
  const t = d.getUTCMonth() + m, y = d.getUTCFullYear() + Math.floor(t / 12), mo = ((t % 12) + 12) % 12;
  const last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, mo, Math.min(d.getUTCDate(), last)));
};
const MS = 86400000;
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const pct = (a, b) => (b ? r1((a / b) * 100) : null);
const med = (v) => { const s = [...v].sort((a, b) => a - b); const n = s.length;
  return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
const quant = (v, p) => { const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : null; };

const main = async () => {
  const [{ refreshed }] = await soql(`SELECT max(refresh_time) AS refreshed`);
  const EXTRACT = day(refreshed);
  console.log(`extract ${refreshed.slice(0, 10)} | lookback ${LOOKBACK}mo`);

  const demoRaw = await fetchAll(
    `permit_type='Bldg-Demolition' AND use_desc='Dwelling - Single Family'`,
    "permit_nbr, apn, issue_date, cpa");
  const newRaw = await fetchAll(`permit_type='Bldg-New'`, "permit_nbr, apn, issue_date, use_desc");

  // trap 1 — one row per parcel, earliest demolition
  const parcelsMap = new Map();
  for (const r of demoRaw) {
    if (!r.apn || !r.issue_date) continue;
    const iss = day(r.issue_date);
    const cur = parcelsMap.get(r.apn);
    if (!cur || iss < cur.iss) parcelsMap.set(r.apn, { apn: r.apn, iss, cpa: (r.cpa || "").trim() });
  }
  const parcels = [...parcelsMap.values()];
  console.log(`  ${parcels.length} parcels from ${demoRaw.length} demolition permits`);

  const byApn = new Map();
  for (const r of newRaw) {
    if (!r.apn || !r.issue_date) continue;
    if (!byApn.has(r.apn)) byApn.set(r.apn, []);
    byApn.get(r.apn).push({ iss: day(r.issue_date), use: r.use_desc });
  }

  // trap 2 — window spans LOOKBACK months BEFORE the demolition
  const usesWithin = (p, h) => {
    const lo = addMonths(p.iss, -LOOKBACK), hi = addMonths(p.iss, h);
    const s = new Set();
    for (const x of byApn.get(p.apn) || []) if (x.iss >= lo && x.iss <= hi) s.add(x.use);
    return s;
  };
  const has = (set, group) => [...set].some((u) => group.has(u));
  const observable = (coh, h) => addMonths(new Date(Math.max(...coh.map((p) => +p.iss))), h) <= EXTRACT;

  const years = [...new Set(parcels.map((p) => p.iss.getUTCFullYear()))].sort();

  // ---- replacement curves -------------------------------------------------------------
  const curves = years.map((y) => {
    const coh = parcels.filter((p) => p.iss.getUTCFullYear() === y);
    const row = { demolition_year: y, parcels: coh.length };
    for (const h of HORIZONS) {
      row[`replaced_by_house_${h}mo_pct`] = observable(coh, h)
        ? pct(coh.filter((p) => has(usesWithin(p, h), HOUSE)).length, coh.length) : null;
    }
    return row;
  });

  // ---- outcome mix at the headline horizon ---------------------------------------------
  const mix = years.filter((y) => y <= LAST_CLEAN_COHORT).flatMap((y) => {
    const coh = parcels.filter((p) => p.iss.getUTCFullYear() === y);
    if (!observable(coh, HEADLINE_H)) return [];
    const c = { house: 0, multi: 0, adu: 0, other: 0, none: 0 };
    for (const p of coh) {
      const u = usesWithin(p, HEADLINE_H);
      if (has(u, HOUSE)) c.house++;
      else if (has(u, MULTI)) c.multi++;
      else if (u.has("Accessory Dwelling Unit")) c.adu++;
      else if (u.size) c.other++;
      else c.none++;
    }
    return [{ demolition_year: y, parcels: coh.length,
      to_house_pct: pct(c.house, coh.length), to_multifamily_pct: pct(c.multi, coh.length),
      to_adu_only_pct: pct(c.adu, coh.length), to_other_pct: pct(c.other, coh.length),
      no_new_build_pct: pct(c.none, coh.length) }];
  });
  const mixYears = mix.map((m) => m.demolition_year);

  // ---- by community plan area, pooled over the observable cohorts -----------------------
  const g = new Map();
  for (const p of parcels) {
    if (!p.cpa || !mixYears.includes(p.iss.getUTCFullYear())) continue;
    if (!g.has(p.cpa)) g.set(p.cpa, { n: 0, house: 0, multi: 0, none: 0 });
    const e = g.get(p.cpa); e.n++;
    const u = usesWithin(p, HEADLINE_H);
    if (has(u, HOUSE)) e.house++; else if (has(u, MULTI)) e.multi++; else if (!u.size) e.none++;
  }
  const byArea = [...g.entries()].filter(([, v]) => v.n >= MIN_AREA_N)
    .map(([cpa, v]) => ({ cpa, parcels: v.n, to_house_pct: pct(v.house, v.n),
      to_multifamily_pct: pct(v.multi, v.n), no_new_build_pct: pct(v.none, v.n) }))
    .sort((a, b) => b.to_multifamily_pct - a.to_multifamily_pct);

  // ---- timing (signed: negative = house permit before the demolition permit) ------------
  const gaps = [];
  for (const p of parcels) {
    if (p.iss.getUTCFullYear() > LAST_CLEAN_COHORT) continue;
    const lo = addMonths(p.iss, -LOOKBACK), hi = addMonths(p.iss, 48);
    const hs = (byApn.get(p.apn) || []).filter((x) => HOUSE.has(x.use) && x.iss >= lo && x.iss <= hi).map((x) => +x.iss);
    if (hs.length) gaps.push((Math.min(...hs) - +p.iss) / MS / 30.44);
  }
  const timing = { n: gaps.length, median_months: r1(med(gaps)), q1_months: r1(quant(gaps, 0.25)),
    q3_months: r1(quant(gaps, 0.75)), p90_months: r1(quant(gaps, 0.9)),
    pct_house_permit_before_demolition: pct(gaps.filter((x) => x < 0).length, gaps.length),
    pct_within_one_month_either_side: pct(gaps.filter((x) => x >= -1 && x <= 1).length, gaps.length) };

  // ---- trap 3 evidence, published so the relabelling is checkable ------------------------
  const relabel = await soql(
    `SELECT date_extract_y(issue_date) AS yr, use_desc, count(1) AS n
     WHERE permit_type='Bldg-Demolition' AND use_desc in('Dwelling - Single Family','Demolition')
     GROUP BY yr, use_desc ORDER BY yr`);
  const relabelByYear = {};
  for (const r of relabel) {
    const y = Number(r.yr); relabelByYear[y] ||= { year: y, labelled_single_family: 0, labelled_generic: 0 };
    if (r.use_desc === "Demolition") relabelByYear[y].labelled_generic = Number(r.n);
    else relabelByYear[y].labelled_single_family = Number(r.n);
  }
  const relabelRows = Object.values(relabelByYear).map((r) => ({ ...r,
    combined: r.labelled_single_family + r.labelled_generic }));

  mkdirSync(OUT, { recursive: true });
  const csv = (rows, cols) => [cols.join(","), ...rows.map((r) => cols.map((c) => {
    const v = r[c] ?? ""; return typeof v === "string" && v.includes(",") ? `"${v}"` : v;
  }).join(","))].join("\n") + "\n";

  writeFileSync(`${OUT}/replacement-by-demolition-year.csv`,
    csv(curves, ["demolition_year", "parcels", ...HORIZONS.map((h) => `replaced_by_house_${h}mo_pct`)]));
  writeFileSync(`${OUT}/outcome-by-community-plan-area.csv`,
    csv(byArea, ["cpa", "parcels", "to_house_pct", "to_multifamily_pct", "no_new_build_pct"]));
  writeFileSync(`${OUT}/teardown-replacement.json`, JSON.stringify({
    report: "2026 Los Angeles Teardown & Replacement Report",
    source: { portal: "data.lacity.org", dataset: "pi9x-tg5x",
      dataset_url: "https://data.lacity.org/City-Infrastructure-Service-Requests/Building-and-Safety-Building-Permits-Issued-from-2/pi9x-tg5x",
      extract_date: refreshed.slice(0, 10) },
    measure: `single-family demolitions joined by parcel (APN) to Bldg-New permits, from ${LOOKBACK} months before the demolition permit to N months after`,
    headline_horizon_months: HEADLINE_H,
    lookback_months: LOOKBACK,
    caveats: [
      "The unit is the parcel, not the permit: 201 parcels carry more than one demolition permit, so counting permits inflates every denominator by about 8%.",
      "A replacement counts whether the new-build permit came before or after the demolition permit, because 7.4% of parcels permitted the house first. The 12-month lookback captures 91.8% of those; 24 months would capture 99.1%.",
      "The City relabelled demolition permits during 2025, so single-family-labelled counts fall while the real total rises. Cohorts stop at 2024 for that reason. Bldg-New is not affected.",
      "Lot merges and splits change the APN, so a parcel rebuilt under a new identifier looks unrebuilt. The 'no new-build permit' share is an upper bound.",
      "A demolition permit is not proof the building came down, and a new-build permit is not proof anything was built.",
      "Multi-family figures count parcels, not dwelling units.",
    ],
    parcels_total: parcels.length, demolition_permits_total: demoRaw.length,
    replacement_by_demolition_year: curves,
    outcome_mix_at_24_months: mix,
    outcome_by_community_plan_area: byArea,
    timing_demolition_to_house_permit: timing,
    demolition_label_change: relabelRows,
  }, null, 2) + "\n");

  console.log(`wrote 3 files to ${OUT}`);
  console.table(curves.map((c) => ({ year: c.demolition_year, parcels: c.parcels,
    "12mo": c.replaced_by_house_12mo_pct, "24mo": c.replaced_by_house_24mo_pct,
    "36mo": c.replaced_by_house_36mo_pct, "48mo": c.replaced_by_house_48mo_pct })));
  console.table(mix);
  console.log("timing:", timing);
  console.log(`areas: ${byArea.length} | top ${byArea[0].cpa} ${byArea[0].to_multifamily_pct}% multi | bottom ${byArea.at(-1).cpa} ${byArea.at(-1).to_multifamily_pct}%`);
};
main().catch((e) => { console.error(e.message); process.exit(1); });
