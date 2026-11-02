#!/usr/bin/env node
// Rebuild the LA home build timeline dataset behind
// /blog/los-angeles-home-build-timeline-report-2026.
//
// Source: City of Los Angeles open data, dataset pi9x-tg5x
// ("Building and Safety - Building Permits Issued from 2020 to Present").
// Public, no API key, updated daily. The portal is data.lacity.org — data.lacity.gov
// does not resolve.
//
// Usage:
//   node examples/la-building-permits/la-build-timeline-data.mjs                # rewrite the published dataset
//   node examples/la-building-permits/la-build-timeline-data.mjs --out /tmp/x   # write elsewhere (dry run)
//
// WHAT IS BEING MEASURED: calendar months from permit issue to the certificate of
// occupancy date (cofo_date) on the same permit. That is the construction-and-signoff
// phase only. Design, plan check and entitlement all happen BEFORE issue and are not in
// this number, so it is not "how long a project takes" — say so in any write-up.
//
// ⚠️ SURVIVORSHIP IS THE TRAP HERE. Averaging issue->CofO over "permits that have a CofO"
// silently drops everything still under construction, and recent cohorts have had less
// time to finish. That makes recent years look FASTER the less complete they are. Two
// defences, both load-bearing:
//   1. Completion is reported as a FIXED-HORIZON COHORT SHARE — of everything issued in
//      year Y, what share reached CofO within N months. Denominator is the whole cohort.
//   2. A horizon is only reported when EVERY permit in that cohort has had N months to
//      run against the extract date. Otherwise it is null, never a partial number.
// Median duration is therefore quoted only for mature cohorts (2020-2022).
//
// ⚠️ COMPLETION SHARES ARE A FLOOR. ~4% of 2020-22 permits carry a finished-looking
// status (CofO Corrected / Permit Finaled / CofO in Progress) with no cofo_date to
// measure from. They count as not-yet-complete here because there is no date.
//
// ⚠️ TRACT BUILDS PULL THE CITYWIDE MEDIAN DOWN. ~18% of completions sit in groups of 5+
// permits sharing one CofO date in one area — subdivision phases finaled together.
// Chatsworth-Porter Ranch alone is ~19% of completed houses at a 13.0-month median.
// The citywide median and the ex-tract median are both published for that reason.
//
// use_desc 'Dwelling - Single Family' is the real new-house filter; permit_sub_type
// '1 or 2 Family Dwelling' also contains ADUs, garages, patio covers, carports and sheds.
// valuation and square_footage are stored as TEXT and must be cast before comparison.

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd(); // run from the site root: output defaults to ./public/data/<slug>
const SLUG = "los-angeles-home-build-timeline-report-2026";
const API = "https://data.lacity.org/resource/pi9x-tg5x.json";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const OUT = resolve(ROOT, arg("--out", `public/data/${SLUG}`));

const USES = [
  ["house", "Dwelling - Single Family"],
  ["adu", "Accessory Dwelling Unit"],
];
const HORIZONS = [12, 24, 36, 48];
const TRACT_AREA = "Chatsworth - Porter Ranch";
const MIN_AREA_N = 40; // don't publish an area median off a handful of permits

async function soql(query) {
  const res = await fetch(`${API}?$query=${encodeURIComponent(query)}`, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`Socrata ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  if (!Array.isArray(body)) throw new Error(`Socrata error: ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}

const day = (s) => (s ? new Date(`${s.slice(0, 10)}T00:00:00Z`) : null);
const addMonths = (d, m) => {
  const x = new Date(d);
  const target = x.getUTCMonth() + m;
  const y = x.getUTCFullYear() + Math.floor(target / 12);
  const mo = ((target % 12) + 12) % 12;
  const last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, mo, Math.min(x.getUTCDate(), last)));
};
const months = (a, b) => (b - a) / 86400000 / 30.44;
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const quantile = (sorted, q) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : null;
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const pct = (x) => (x == null ? null : Math.round(x * 1000) / 10);

async function load(useDesc) {
  const rows = await soql(
    `SELECT permit_nbr, issue_date, cofo_date, status_desc, cpa, zip_code, valuation, square_footage
     WHERE permit_type='Bldg-New' AND use_desc='${useDesc}' LIMIT 50000`
  );
  return rows.flatMap((r) => {
    const iss = day(r.issue_date);
    if (!iss) return [];
    let cof = day(r.cofo_date);
    if (cof && cof < iss) cof = null; // guard: no such rows today, but never trust it
    return [{
      nbr: r.permit_nbr, iss, cof, status: r.status_desc || "",
      cpa: (r.cpa || "").trim(), val: num(r.valuation), sqft: num(r.square_footage),
    }];
  });
}

const stats = (rows) => {
  const d = rows.filter((r) => r.cof).map((r) => months(r.iss, r.cof)).sort((a, b) => a - b);
  if (!d.length) return null;
  return { n: d.length, median: r1(quantile(d, 0.5)), q1: r1(quantile(d, 0.25)),
           q3: r1(quantile(d, 0.75)), p90: r1(quantile(d, 0.9)), max: r1(d[d.length - 1]) };
};

const main = async () => {
  const [{ refreshed }] = await soql(`SELECT max(refresh_time) AS refreshed`);
  const EXTRACT = day(refreshed);
  console.log(`source extract: ${refreshed.slice(0, 10)}`);

  const data = {};
  for (const [key, useDesc] of USES) data[key] = await load(useDesc);

  // ---- cohort completion at fixed horizons -------------------------------------------
  const cohorts = [];
  for (const [key] of USES) {
    const rows = data[key];
    const years = [...new Set(rows.map((r) => r.iss.getUTCFullYear()))].sort();
    for (const yr of years) {
      const coh = rows.filter((r) => r.iss.getUTCFullYear() === yr);
      const latest = new Date(Math.max(...coh.map((r) => +r.iss)));
      const row = { use: key, issue_year: yr, permits: coh.length };
      for (const h of HORIZONS) {
        // only observable once the LAST permit in the cohort has had h months to run
        row[`pct_${h}mo`] = addMonths(latest, h) > EXTRACT
          ? null
          : pct(coh.filter((r) => r.cof && r.cof <= addMonths(r.iss, h)).length / coh.length);
      }
      row.no_cofo_to_date = coh.filter((r) => !r.cof).length;
      cohorts.push(row);
    }
  }

  // ---- duration for mature cohorts ----------------------------------------------------
  const MATURE = new Set([2020, 2021, 2022]);
  const mature = (key) => data[key].filter((r) => MATURE.has(r.iss.getUTCFullYear()));
  const duration = {
    house: stats(mature("house")),
    house_excl_tract: stats(mature("house").filter((r) => r.cpa !== TRACT_AREA)),
    house_tract_only: stats(mature("house").filter((r) => r.cpa === TRACT_AREA)),
    adu: stats(mature("adu")),
  };

  // ---- by community plan area (houses, mature cohorts) --------------------------------
  const byArea = [];
  const groups = new Map();
  for (const r of mature("house")) {
    if (!r.cpa || !r.cof) continue;
    if (!groups.has(r.cpa)) groups.set(r.cpa, []);
    groups.get(r.cpa).push(r);
  }
  for (const [cpa, rows] of groups) {
    if (rows.length < MIN_AREA_N) continue;
    byArea.push({ cpa, completed_permits: rows.length, ...stats(rows) });
  }
  byArea.sort((a, b) => b.median - a.median);

  // ---- by size band (houses, mature cohorts) ------------------------------------------
  const BANDS = [[0, 2000], [2000, 4000], [4000, 6000], [6000, 10000], [10000, Infinity]];
  const bySize = BANDS.flatMap(([lo, hi]) => {
    const rows = mature("house").filter((r) => r.sqft != null && r.sqft >= lo && r.sqft < hi && r.cof);
    if (rows.length < 30) return [];
    return [{ sqft_min: lo, sqft_max: hi === Infinity ? null : hi, ...stats(rows) }];
  });

  // ---- batch-final share (how much of the record is subdivision phases) ---------------
  const completed = mature("house").filter((r) => r.cof);
  const batchKeys = new Map();
  for (const r of completed) {
    const k = `${r.cof.toISOString().slice(0, 10)}|${r.cpa}`;
    batchKeys.set(k, (batchKeys.get(k) || 0) + 1);
  }
  const inBatch = [...batchKeys.values()].filter((n) => n >= 5).reduce((a, b) => a + b, 0);

  // ---- write ---------------------------------------------------------------------------
  mkdirSync(OUT, { recursive: true });
  const csv = (rows, cols) =>
    [cols.join(","), ...rows.map((r) => cols.map((c) => (r[c] ?? "")).join(","))].join("\n") + "\n";

  writeFileSync(`${OUT}/cohort-completion.csv`,
    csv(cohorts, ["use", "issue_year", "permits", "pct_12mo", "pct_24mo", "pct_36mo", "pct_48mo", "no_cofo_to_date"]));
  writeFileSync(`${OUT}/duration-by-community-plan-area.csv`,
    csv(byArea, ["cpa", "completed_permits", "median", "q1", "q3", "p90", "max"]));

  const json = {
    report: "2026 Los Angeles Home Build Timeline Report",
    source: { portal: "data.lacity.org", dataset: "pi9x-tg5x",
      dataset_url: "https://data.lacity.org/City-Infrastructure-Service-Requests/Building-and-Safety-Building-Permits-Issued-from-2/pi9x-tg5x",
      extract_date: refreshed.slice(0, 10) },
    measure: "calendar months from permit issue_date to cofo_date on the same permit",
    caveats: [
      "Excludes design, plan check and entitlement, which all precede permit issue.",
      "Completion shares are a floor: ~4% of 2020-22 permits have a finished-looking status but no cofo_date.",
      "~18% of completions fall in groups of 5+ permits sharing a CofO date in one area (subdivision phases).",
      "Permit issue is not a construction start date, and a CofO is not a move-in date.",
    ],
    universe: Object.fromEntries(USES.map(([k]) => [k, data[k].length])),
    cohort_completion: cohorts,
    duration_months: duration,
    duration_by_community_plan_area: byArea,
    duration_by_size_band: bySize,
    batch_final_share_of_completions: pct(inBatch / completed.length),
  };
  writeFileSync(`${OUT}/build-timeline.json`, JSON.stringify(json, null, 2) + "\n");

  console.log(`wrote 3 files to ${OUT}`);
  console.log(`houses ${data.house.length} | ADUs ${data.adu.length}`);
  console.log(`house median (2020-22): ${duration.house.median} mo  (excl tract ${duration.house_excl_tract.median} mo)`);
  console.log(`ADU median (2020-22):   ${duration.adu.median} mo`);
  console.log("24-month completion, houses:",
    cohorts.filter((c) => c.use === "house" && c.pct_24mo != null).map((c) => `${c.issue_year} ${c.pct_24mo}%`).join("  "));
  console.log(`slowest area ${byArea[0].cpa} ${byArea[0].median} mo | fastest ${byArea[byArea.length-1].cpa} ${byArea[byArea.length-1].median} mo`);
};

main().catch((e) => { console.error(e.message); process.exit(1); });
