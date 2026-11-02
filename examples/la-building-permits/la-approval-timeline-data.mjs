#!/usr/bin/env node
// Rebuild the LA permit approval timeline dataset behind
// /blog/los-angeles-permit-approval-timeline-report-2026.
//
// Source: City of Los Angeles open data, dataset pi9x-tg5x
// ("Building and Safety - Building Permits Issued from 2020 to Present").
// Public, no API key, updated daily. The portal is data.lacity.org — data.lacity.gov
// does not resolve.
//
// Usage:
//   node examples/la-building-permits/la-approval-timeline-data.mjs                # rewrite the published dataset
//   node examples/la-building-permits/la-approval-timeline-data.mjs --out /tmp/x   # write elsewhere (dry run)
//   node examples/la-building-permits/la-approval-timeline-data.mjs --cutoff 12-31 # move the matched window
//
// WHAT IS MEASURED: calendar months from submitted_date to issue_date on the same permit.
// That is the approval/plan-check phase only. It is NOT "city processing time": the clock
// includes applicant time spent revising drawings and answering corrections, and the record
// cannot separate the two. Say so wherever these numbers are used.
//
// ⚠️ TRAP 1 — THE DATASET CONTAINS ONLY PERMITS THAT WERE ISSUED. Applications still in
// plan check, withdrawn or abandoned never appear in it at all. So every figure here
// describes the permits that MADE IT, not what an application faces. The real distribution,
// including the applications that never got a permit, is not knowable from this source and
// is necessarily worse. This belongs up front in any write-up, not in a footnote.
//
// ⚠️ TRAP 2 — COHORT BY ISSUE YEAR, NEVER BY SUBMITTED YEAR. A submitted-year cohort is
// missing its own slow members: an application submitted recently that is still stuck has
// not been issued, so it is absent from the data entirely. That manufactures a clean
// "approvals keep getting faster" trend out of nothing. An issue-year cohort is complete —
// every permit issued in year Y is present no matter how long it waited. The script emits
// BOTH so the biased framing can be published as a worked illustration.
//
// ⚠️ TRAP 3 — BATCH RELEASES DISTORT AREA MEDIANS. Mission Hills-Panorama City showed a
// 77.6-month median until checked: 28 of its 52 permits were submitted in 2017 and all
// issued on one day (2023-12-14) — a single subdivision, not a property of the area. Area
// figures therefore exclude days where 5+ permits were issued in the same area.
//
// ⚠️ TRAP 4 — COMMUNITY PLAN AREA NAMES ARE NOT CLEAN. "Sherman Oaks-Studio City-Toluca
// Lake-Cahuenga Pass" also appears truncated as "...-Cahuenga", and at least one row carries
// two areas comma-joined. Normalise before grouping or the ranking is wrong.
//
// Keep the cutoff behind the extract date: permits enter the record days after issue, so a
// cutoff too close to extraction undercounts the current year against settled prior years.

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd(); // run from the site root: output defaults to ./public/data/<slug>
const SLUG = "los-angeles-permit-approval-timeline-report-2026";
const API = "https://data.lacity.org/resource/pi9x-tg5x.json";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";

const arg = (f, d) => { const i = process.argv.indexOf(f); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const OUT = resolve(ROOT, arg("--out", `public/data/${SLUG}`));
const [CM, CD] = arg("--cutoff", "9-30").split("-").map(Number);
const PALISADES = "Brentwood - Pacific Palisades";
const BATCH_MIN = 5;   // 5+ permits issued the same day in one area = a batch release
const MIN_AREA_N = 25; // don't rank an area off a handful of permits

const SETS = [
  ["new_house", `permit_type='Bldg-New' AND use_desc='Dwelling - Single Family'`],
  ["adu", `permit_type='Bldg-New' AND use_desc='Accessory Dwelling Unit'`],
  // Bldg-Addition ONLY. 'Bldg-Alter/Repair' is deliberately excluded: only 33.7% of those
  // permits (65,248 of 193,396) carry a submitted_date at all, because most are issued
  // over the counter with no plan-check phase to record. Measuring the third that DO have
  // one would select for the slow, plan-checked minority and overstate a remodel's wait.
  // Additions have 99.9% coverage (33,408 of 33,433) and are a like-for-like construction
  // project, so they are the honest third category.
  ["addition", `permit_sub_type='1 or 2 Family Dwelling' AND permit_type='Bldg-Addition'`],
];

async function soql(query) {
  const res = await fetch(`${API}?$query=${encodeURIComponent(query)}`, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`Socrata ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  if (!Array.isArray(body)) throw new Error(`Socrata error: ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}

// the remodel set is >200k rows, past Socrata's cap — page it
async function fetchAll(where) {
  const rows = [];
  for (let off = 0; ; off += 50000) {
    const page = await soql(
      `SELECT permit_nbr, submitted_date, issue_date, cpa, work_desc WHERE ${where}
       ORDER BY permit_nbr LIMIT 50000 OFFSET ${off}`
    );
    rows.push(...page);
    if (page.length < 50000) break;
  }
  return rows;
}

const day = (s) => (s ? new Date(`${s.slice(0, 10)}T00:00:00Z`) : null);
const MS = 86400000;
const months = (d) => d / 30.44;
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const med = (v) => { const s = [...v].sort((a, b) => a - b); const n = s.length;
  return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
const quant = (v, p) => { const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : null; };

const normCpa = (c) => {
  let x = (c || "").trim();
  if (x.includes(",")) x = x.split(",")[0].trim();          // comma-joined multi-area rows
  if (x.startsWith("Sherman Oaks-Studio City")) x = "Sherman Oaks-Studio City-Toluca Lake-Cahuenga Pass";
  if (x.toUpperCase() === "BRENTWOOD-PACIFIC PALISADES") x = PALISADES;  // case/spacing variant
  return x;
};

// The permit record labels these itself: work_desc on a post-January-2025 rebuild opens
// "2025 WILDFIRE REBUILD" and many also carry an Executive Order eligibility note. That is
// the record's own classification, not an inference of ours from geography or dates.
const isRebuild = (w) => /WILDFIRE REBUILD/i.test(w || "");

const stats = (days) => days.length ? {
  n: days.length, median: r1(months(med(days))), q1: r1(months(quant(days, 0.25))),
  q3: r1(months(quant(days, 0.75))), p90: r1(months(quant(days, 0.9))), max: r1(months(Math.max(...days))),
  pct_over_1yr: r1(days.filter((d) => d > 365).length / days.length * 100),
  pct_over_2yr: r1(days.filter((d) => d > 730).length / days.length * 100),
  pct_over_3yr: r1(days.filter((d) => d > 1095).length / days.length * 100),
} : null;

const main = async () => {
  const [{ refreshed }] = await soql(`SELECT max(refresh_time) AS refreshed`);
  const EXTRACT = refreshed.slice(0, 10);
  console.log(`source extract: ${EXTRACT}  |  matched window: Jan 1 – ${CM}/${CD}`);

  const data = {};
  for (const [key, where] of SETS) {
    const raw = await fetchAll(where);
    let dropped = 0;
    data[key] = raw.flatMap((r) => {
      const sub = day(r.submitted_date), iss = day(r.issue_date);
      if (!sub || !iss) { dropped++; return []; }
      if (iss < sub) { dropped++; return []; }             // guard: none today, never trust it
      return [{ sub, iss, days: (iss - sub) / MS, cpa: normCpa(r.cpa), rebuild: isRebuild(r.work_desc) }];
    });
    console.log(`  ${key}: ${data[key].length} usable (${dropped} dropped)`);
  }

  const inWindow = (r) => {
    const m = r.iss.getUTCMonth() + 1, d = r.iss.getUTCDate();
    return m < CM || (m === CM && d <= CD);
  };
  const years = [...new Set(data.new_house.map((r) => r.iss.getUTCFullYear()))].sort();

  // ---- headline: issue-year cohorts, matched window, all three permit types -------------
  const byYear = [];
  for (const y of years) {
    const row = { issue_year: y };
    for (const [key] of SETS) {
      const s = stats(data[key].filter((r) => r.iss.getUTCFullYear() === y && inWindow(r)).map((r) => r.days));
      row[`${key}_n`] = s?.n ?? null;
      row[`${key}_median_months`] = s?.median ?? null;
    }
    byYear.push(row);
  }

  // ---- the biased framing, published deliberately as an illustration --------------------
  const submittedCohort = [...new Set(data.new_house.map((r) => r.sub.getUTCFullYear()))].sort()
    .map((y) => {
      const d = data.new_house.filter((r) => r.sub.getUTCFullYear() === y).map((r) => r.days);
      return { submitted_year: y, permits: d.length, median_months: r1(months(med(d))) };
    }).filter((r) => r.permits >= 50);

  // ---- wildfire rebuilds vs every other new house, by the record's own label -----------
  const rebuildSplit = years.map((y) => {
    const coh = data.new_house.filter((r) => r.iss.getUTCFullYear() === y && inWindow(r));
    const rb = stats(coh.filter((r) => r.rebuild).map((r) => r.days));
    const ot = stats(coh.filter((r) => !r.rebuild).map((r) => r.days));
    return { issue_year: y,
      wildfire_rebuild_n: rb?.n ?? 0, wildfire_rebuild_median_months: rb?.median ?? null,
      all_other_n: ot?.n ?? 0, all_other_median_months: ot?.median ?? null };
  });

  // ---- distribution detail for new houses -----------------------------------------------
  const distribution = years.map((y) => ({ issue_year: y,
    ...stats(data.new_house.filter((r) => r.iss.getUTCFullYear() === y && inWindow(r)).map((r) => r.days)) }));

  // ---- by community plan area, batch days removed ----------------------------------------
  const recent = data.new_house.filter((r) => [2023, 2024].includes(r.iss.getUTCFullYear()) && r.cpa);
  const batch = new Map();
  for (const r of recent) {
    const k = `${r.iss.toISOString().slice(0, 10)}|${r.cpa}`;
    batch.set(k, (batch.get(k) || 0) + 1);
  }
  const clean = recent.filter((r) => batch.get(`${r.iss.toISOString().slice(0, 10)}|${r.cpa}`) < BATCH_MIN);
  const areaGroups = new Map();
  for (const r of clean) {
    if (!areaGroups.has(r.cpa)) areaGroups.set(r.cpa, []);
    areaGroups.get(r.cpa).push(r.days);
  }
  const byArea = [...areaGroups.entries()]
    .filter(([, v]) => v.length >= MIN_AREA_N)
    .map(([cpa, v]) => ({ cpa, ...stats(v) }))
    .sort((a, b) => b.median - a.median);

  // ---- write ------------------------------------------------------------------------------
  mkdirSync(OUT, { recursive: true });
  const csv = (rows, cols) =>
    [cols.join(","), ...rows.map((r) => cols.map((c) => {
      const v = r[c] ?? "";
      return typeof v === "string" && v.includes(",") ? `"${v}"` : v;
    }).join(","))].join("\n") + "\n";

  writeFileSync(`${OUT}/approval-months-by-year.csv`,
    csv(byYear, ["issue_year", "new_house_n", "new_house_median_months", "adu_n", "adu_median_months",
                 "addition_n", "addition_median_months"]));
  writeFileSync(`${OUT}/approval-months-by-community-plan-area.csv`,
    csv(byArea, ["cpa", "n", "median", "q1", "q3", "p90", "max"]));

  writeFileSync(`${OUT}/approval-timeline.json`, JSON.stringify({
    report: "2026 Los Angeles Permit Approval Timeline Report",
    source: { portal: "data.lacity.org", dataset: "pi9x-tg5x",
      dataset_url: "https://data.lacity.org/City-Infrastructure-Service-Requests/Building-and-Safety-Building-Permits-Issued-from-2/pi9x-tg5x",
      extract_date: EXTRACT },
    measure: "calendar months from submitted_date to issue_date on the same permit",
    matched_window: `January 1 – ${CM}/${CD}, applied to every year`,
    caveats: [
      "The dataset contains only permits that were ISSUED. Applications still in plan check, withdrawn or abandoned are absent entirely, so these figures describe the permits that made it, not what an application faces.",
      "The clock includes applicant time spent revising drawings and answering corrections; the record cannot separate applicant time from city time.",
      "Cohorts are grouped by issue year. Grouping by submitted year is biased because recently submitted applications that are still stuck have not been issued and so are missing from their own cohort; that version is published alongside as an illustration.",
      "Area figures exclude days where 5 or more permits were issued in the same area, which are batch releases of a single development.",
      "Community plan area names were normalised: one area appears under a truncated second spelling, and some rows carry two areas comma-joined.",
      "Wildfire rebuilds are identified by the permit record's own work_desc label (\'2025 WILDFIRE REBUILD\'), not inferred from location or date. 1,207 such permits appear, all issued in 2025-2026 and almost entirely in one community plan area.",
      "Bldg-Alter/Repair permits are excluded: only 33.7% carry a submitted_date, because most are issued over the counter with no plan-check phase, so the third that do would select for the slow minority. Additions (99.9% coverage) are used as the third category instead.",
    ],
    universe: Object.fromEntries(SETS.map(([k]) => [k, data[k].length])),
    median_approval_months_by_issue_year: byYear,
    new_house_distribution_by_issue_year: distribution,
    wildfire_rebuild_vs_all_other_new_houses: rebuildSplit,
    new_house_by_community_plan_area_2023_2024: byArea,
    biased_submitted_year_cohort_illustration: submittedCohort,
    batch_permits_excluded_from_area_figures: recent.length - clean.length,
  }, null, 2) + "\n");

  console.log(`wrote 3 files to ${OUT}`);
  console.table(byYear.map((r) => ({ year: r.issue_year, house: r.new_house_median_months,
    adu: r.adu_median_months, addition: r.addition_median_months })));
  console.log("rebuild vs other:", rebuildSplit
    .map((p) => `${p.issue_year} ${p.wildfire_rebuild_median_months ?? "-"}/${p.all_other_median_months}`).join("  "));
};

main().catch((e) => { console.error(e.message); process.exit(1); });
