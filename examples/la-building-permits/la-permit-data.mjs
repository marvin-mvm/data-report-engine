#!/usr/bin/env node
// Rebuild the LA residential building permit dataset behind
// /blog/los-angeles-residential-building-permit-report-2026.
//
// Source: City of Los Angeles open data, dataset pi9x-tg5x
// ("Building and Safety - Building Permits Issued from 2020 to Present").
// Public, no API key, updated daily. The portal is data.lacity.org — data.lacity.gov
// does not resolve.
//
// Usage:
//   node examples/la-building-permits/la-permit-data.mjs                 # rewrite the published dataset
//   node examples/la-building-permits/la-permit-data.mjs --out /tmp/x    # write elsewhere (dry run)
//   node examples/la-building-permits/la-permit-data.mjs --cutoff 12-31  # move the year cutoff
//
// WHY THE CUTOFF: every year is trimmed to the same Jan 1 – <cutoff> window so a partial
// current year compares like with like. Keep the cutoff well behind "today" — permits are
// filed into the record for days after issue, so a cutoff too close to the extract date
// undercounts the current year against fully settled prior years.
//
// WHY use_desc MATTERS: permit_sub_type '1 or 2 Family Dwelling' also contains ADUs,
// garages, patio covers, carports and sheds. Counting that as "new houses" overstates it
// roughly threefold. New houses are use_desc 'Dwelling - Single Family'.
//
// valuation is stored as TEXT in the source and must be cast: valuation::number.
// It is the declared construction value used for permit fees — not land, not market
// price, and not a finished build cost. Describe it that way in any write-up.

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd(); // run from the site root: output defaults to ./public/data/<slug>
const SLUG = "los-angeles-residential-building-permit-report-2026";
const API = "https://data.lacity.org/resource/pi9x-tg5x.json";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const OUT = resolve(ROOT, arg("--out", `public/data/${SLUG}`));
const [CM, CD] = arg("--cutoff", "9-19").split("-").map(Number);
const YEARS = Array.from({ length: new Date().getFullYear() - 2019 }, (_, i) => 2020 + i);
const WINDOW = `(date_extract_m(issue_date) < ${CM} OR (date_extract_m(issue_date) = ${CM} AND date_extract_d(issue_date) <= ${CD}))`;

const NEW_HOUSE = `permit_type='Bldg-New' AND use_desc='Dwelling - Single Family'`;
const ADU = `permit_type='Bldg-New' AND use_desc='Accessory Dwelling Unit'`;
const RENO = `permit_sub_type='1 or 2 Family Dwelling' AND permit_type in('Bldg-Alter/Repair','Bldg-Addition')`;

async function soql(query) {
  const res = await fetch(`${API}?$query=${encodeURIComponent(query)}`, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`Socrata ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  if (!Array.isArray(body)) throw new Error(`Socrata error: ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}
const byYear = (where) =>
  soql(`SELECT date_extract_y(issue_date) AS yr, count(1) AS n, sum(valuation::number) AS val
        WHERE ${where} AND ${WINDOW} GROUP BY yr ORDER BY yr`);
const byArea = (where) =>
  soql(`SELECT cpa, date_extract_y(issue_date) AS yr, count(1) AS n, sum(valuation::number) AS val
        WHERE ${where} AND cpa IS NOT NULL AND ${WINDOW} GROUP BY cpa, yr ORDER BY cpa, yr LIMIT 5000`);

const idx = (rows) => Object.fromEntries(rows.map((r) => [Number(r.yr), { n: Number(r.n), val: Number(r.val || 0) }]));
const nest = (rows) => rows.reduce((m, r) => (((m[r.cpa] ??= {})[Number(r.yr)] = { n: Number(r.n), val: Number(r.val || 0) }), m), {});
const csvRow = (cells) => cells.map((c) => (/[",]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c)).join(",");

const [houses, adus, reno, housesArea, adusArea, meta] = await Promise.all([
  byYear(NEW_HOUSE), byYear(ADU), byYear(RENO), byArea(NEW_HOUSE), byArea(ADU),
  soql("SELECT count(1) AS rows, max(issue_date) AS last"),
]);
const H = idx(houses), A = idx(adus), R = idx(reno), HA = nest(housesArea), AA = nest(adusArea);
const years = YEARS.filter((y) => H[y]);
const areas = [...new Set([...Object.keys(HA), ...Object.keys(AA)])].sort();
const win = `Jan 1 - ${new Date(2000, CM - 1, CD).toLocaleString("en-US", { month: "short" })} ${CD}`;
const asOf = new Date().toISOString().slice(0, 10);

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/citywide-by-year.csv`,
  [csvRow(["year","window","new_houses","new_house_valuation_usd","adus","adu_valuation_usd","alterations_additions","alteration_valuation_usd"]),
   ...years.map((y) => csvRow([y, win, H[y].n, Math.round(H[y].val), A[y]?.n ?? 0, Math.round(A[y]?.val ?? 0), R[y]?.n ?? 0, Math.round(R[y]?.val ?? 0)]))].join("\n") + "\n");

const latest = years.at(-1);
writeFileSync(`${OUT}/by-community-plan-area.csv`,
  [csvRow(["community_plan_area", ...years.map((y) => `new_houses_${y}`), `new_house_valuation_${latest}_usd`, `avg_declared_valuation_${latest}_usd`, ...years.map((y) => `adus_${y}`)]),
   ...areas.map((a) => {
     const n = HA[a]?.[latest]?.n ?? 0, v = HA[a]?.[latest]?.val ?? 0;
     return csvRow([a, ...years.map((y) => HA[a]?.[y]?.n ?? 0), Math.round(v), n ? Math.round(v / n) : "", ...years.map((y) => AA[a]?.[y]?.n ?? 0)]);
   })].join("\n") + "\n");

writeFileSync(`${OUT}/permit-data.json`, JSON.stringify({
  source: "City of Los Angeles open data, dataset pi9x-tg5x (Building Permits Issued 2020-present)",
  window: `January 1 - ${win.split("- ")[1]} of each year, matched for comparability`,
  extracted: asOf,
  records_in_source: Number(meta[0].rows),
  latest_permit_in_source: meta[0].last.slice(0, 10),
  citywide: years.map((y) => ({ year: y, new_houses: H[y].n, new_house_valuation_usd: Math.round(H[y].val),
    adus: A[y]?.n ?? 0, adu_valuation_usd: Math.round(A[y]?.val ?? 0),
    alterations_additions: R[y]?.n ?? 0, alteration_valuation_usd: Math.round(R[y]?.val ?? 0) })),
  by_community_plan_area: areas.map((a) => ({ community_plan_area: a,
    new_houses: Object.fromEntries(years.map((y) => [y, HA[a]?.[y]?.n ?? 0])),
    adus: Object.fromEntries(years.map((y) => [y, AA[a]?.[y]?.n ?? 0])),
    [`new_house_valuation_${latest}_usd`]: Math.round(HA[a]?.[latest]?.val ?? 0) })),
}, null, 1) + "\n");

// headline figures, so a refresh can be written up without re-deriving them
const PAL = "Brentwood - Pacific Palisades";
const palN = HA[PAL]?.[latest]?.n ?? 0;
console.log(`\n  window ${win} · extracted ${asOf} · source has ${Number(meta[0].rows).toLocaleString()} records through ${meta[0].last.slice(0, 10)}`);
console.log(`  ${areas.length} community plan areas → ${OUT}\n`);
for (const y of years)
  console.log(`   ${y}  houses ${String(H[y].n).padStart(5)}  ADUs ${String(A[y]?.n ?? 0).padStart(5)}  renovations ${String(R[y]?.n ?? 0).padStart(6)}  avg $${Math.round(H[y].val / H[y].n).toLocaleString()}`);
console.log(`\n   ${latest}: ${PAL} ${palN} (${((palN / H[latest].n) * 100).toFixed(1)}% of citywide) · rest of city ${H[latest].n - palN}`);
console.log(`   ADUs vs new houses ${latest}: ${A[latest]?.n ?? 0} vs ${H[latest].n}\n`);
