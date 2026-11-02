#!/usr/bin/env node
// Rebuild the LA home addition dataset behind
// /blog/los-angeles-home-addition-report-2026.
//
// Source: City of Los Angeles open data, dataset pi9x-tg5x
// ("Building and Safety - Building Permits Issued from 2020 to Present").
// Public, no API key, updated daily. Portal is data.lacity.org — .gov does not resolve.
//
// Usage:
//   node examples/la-building-permits/la-home-addition-data.mjs                  # rewrite the published dataset
//   node examples/la-building-permits/la-home-addition-data.mjs --out /tmp/x     # dry run
//   node examples/la-building-permits/la-home-addition-data.mjs --cutoff 12-31   # move the matched window
//   node examples/la-building-permits/la-home-addition-data.mjs --audit          # print classification samples
//
// WHAT IS MEASURED: Bldg-Addition permits on single-family houses (use_desc 'Dwelling - Single
// Family') that add LIVING SPACE and do NOT create or convert an ADU. ADUs are deliberately out of
// scope for this report. New houses (the comparison) are Bldg-New with the same use_desc.
//
// ⚠️ TRAP 1 — REVISIONS. A supplemental permit revises an earlier one. An original's middle block
// ends in 0000 (e.g. 25014-20000-01234); a revision counts up from it (-20001-). A few revisions carry
// an original-style number but say "supplemental to permit #…" (sometimes misspelt). ~2,550 removed.
//
// ⚠️ TRAP 2 — NOT EVERY "ADDITION" IS LIVING SPACE. Patio covers, decks, trellises, carports and
// porte-cocheres are filed as additions too (~1,700). Classify by what each "addition" is OF, not by
// whether a porch is mentioned: "addition to SFD with new porch" is living space.
//
// ⚠️ TRAP 3 — square_footage IS NOT THE AREA ADDED. Where the description states a single square
// footage, the field matches it only ~38% of the time: it holds the area of ALL the work (remodel,
// conversions, sometimes the whole house). No size statistics are produced from it.
//
// ⚠️ TRAP 4 — "2-STORY" USUALLY DESCRIBES THE EXISTING HOUSE. "(E) 2-story SFD" is not a second-story
// addition. Phrases about the existing house are stripped before the upper-floor test, EXCEPT that
// "1-story to 2-story" is checked first. Misspellings are common ("ADDTION", "ADDT'N").
//
// ⚠️ TRAP 5 — NEAR-REBUILDS. Some "additions" remove the house except for a stated length of wall or
// foundation. Flag only with removal / "major remodel" / "only" wording, never a garage teardown, and
// sum every stated piece of wall kept ("13'5" LF at south side and 20'8" at east" = 34.1 ft).
//
// ⚠️ TRAP 6 — the cpa field has truncated duplicates of three areas; merge them.
//
// Every rule above was hand-audited on random samples; see the report's Method section.
// Declared valuation is NOT used: it is a fee figure.

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd(); // run from the site root: output defaults to ./public/data/<slug>
const SLUG = "los-angeles-home-addition-report-2026";
const API = "https://data.lacity.org/resource/pi9x-tg5x.json";
const DATASET_URL = "https://data.lacity.org/City-Infrastructure-Service-Requests/Building-and-Safety-Building-Permits-Issued-from-2/pi9x-tg5x";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";

const arg = (f, d) => { const i = process.argv.indexOf(f); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const OUT = resolve(ROOT, arg("--out", `public/data/${SLUG}`));
const CUTOFF = arg("--cutoff", "10-31");
const AUDIT = process.argv.includes("--audit");
const FIRST_YEAR = 2020, AREA_FROM = "2023-01-01";
const PAL = "Brentwood - Pacific Palisades";
const MIN_AREA = 150, MIN_NEAR = 8, DEDUPE_DAYS = 180;

// ---- text rules ---------------------------------------------------------------------------------
const SUPPL_TO = /SUPPL\w*\.?\s+(PERMIT\s+)?(TO|FOR|REF)|SUPPL\w*\s*#|SUPPL\w*\s+\d{5}-|REVISION TO PERMIT/i;
const RENEWAL = /\bRENEW|EXPIRED|COMPLETE WORK|\d+\s*%\s*COMPLETE/i;
const OUT_SRC = "(PORTE[\\s-]*COCHERE|PATIO\\s*COVER|COVERED\\s+PATIO|PATIO|TRELLIS|PERGOLA|BALCON\\w*|DECK|PORCH|CARPORT|LOGGIA|AWNING|GAZEBO|SHADE\\s+STRUCTURE|LATTICE)";
const OUTW = new RegExp(OUT_SRC, "i");
const ROOM = /BED\s*ROOM|BDRM|BATH|KITCHEN|FAMILY\s*ROOM|LIVING|DINING|\bDEN\b|OFFICE|CLOSET|MASTER|SUITE|LAUNDRY|\bGYM\b|STUDY|LIBRARY|GREAT\s*ROOM|REC\s*ROOM|HABITABLE|LIVABLE|CONDITIONED|FLOOR\s+AREA|ENLARGE|EXPAND|\bADU\b|ACCESSORY\s+DWELLING|\bROOMS?\b|FOYER|MUD\s*ROOM|POWDER|ENCLOS\w*|CONVERT/i;
const ADDW = /\bADD(ITION|ITIONS|ED|ING)?\b/gi;
const REBUILD = /\bERECT\b|REBUILD\s[^.;]{0,40}(SFD|DWELLING|HOUSE|STORY)|(DEMO\w*|REMOV\w*)\s+(ALL|EXIST\w*|\(E\))[^.;]{0,60}\bWALLS?\b|MAJOR\s+(REMODEL|ALTERATION|RENOVATION)/i;
const WITHIN = /(WITHIN|INSIDE)\s+(THE\s+)?(E\)\s*|EXISTING\s+)?(FOOTPRINT|BUILDING|STRUCTURE|ENVELOPE|SHELL)/i;
const ADU = /\bADU\b|ACCESSORY\s+DWELLING|\bJADU\b/i;
const ADDV = "(ADDT'N|ADDT\\b|ADD\\w*|ADDTION\\w*|ADDITON\\w*|ADDN|\\(N\\)|NEW|PROPOSED|BUILD|CONSTRUCT\\w*|EXTEND\\w*|ENLARGE\\w*|EXPAND\\w*|ENCLOS\\w*)";
const EXISTING_STORY = /(\((E|EX|EXIST\w*)\)|\bEXISTING|\bEXIST\.?|\bEX\.)\s*(\w+\s+){0,2}?(\d|ONE|TWO|THREE)[\s-]*STOR(Y|IES|Y)\b/gi;
const UPPER = "((2ND|SECOND|UPPER|3RD|THIRD|4TH|FOURTH)[\\s-]*(FLOOR|FLR|STORY|STY|LEVEL|LVL))";
const LEN = "(\\d+(?:\\.\\d+)?)\\s*(?:['’]|\\s*FT\\b|\\s*FEET\\b|\\s*LF\\b|\\s*L\\.F\\.|\\s*LINEAR)";
const NEAR = new RegExp(
  "(REMOV\\w*|DEMO\\w*|DEMOLISH\\w*)\\b[^;]{0,110}?\\b(EXCEPT|LEAVING|KEEP\\w*|RETAIN\\w*|BUT|ONLY|WITH)\\b[^;]{0,70}?(" + LEN + "|\\bPORTION)[^;]{0,40}?\\b(WALLS?|FOUNDATION|FOOTINGS?|FDN|LF|L\\.F\\.|LINEAR)"
  + "|\\bONLY\\b[^;]{0,25}?" + LEN + "[^;]{0,40}?\\b(WALLS?|FOOTINGS?|FOUNDATION|LF|LINEAR)"
  + "|\\bONLY\\b[^;]{0,20}?\\bPORTIONS?\\s+OF\\b[^;]{0,25}?\\bWALLS?"
  + "|" + LEN + "[^;]{0,30}?\\bWALLS?\\b[^;]{0,35}?\\b(TO\\s+REMAIN|TO\\s+BE\\s+RETAINED|TO\\s+STAY|REMAINS?)\\b"
  + "|\\bKEEP\\w*\\s+(?:\\(E\\)\\s+|ONLY\\s+)?[^;]{0,10}?" + LEN + "[^;]{0,25}?\\b(WALLS?|FOOTINGS?|FOUNDATION)", "i");
const FT = /(\d+(?:\.\d+)?)\s*['’]\s*-?\s*(\d+(?:\.\d+)?)?(?:\s*\d\/\d)?\s*(?:["”]|IN\b)?|(\d+(?:\.\d+)?)\s*(?:FT\b|FEET\b|LF\b|L\.F\.|LINEAR)/gi;

const middle = (nbr) => { const m = /^\d{5}-(\d{5})-\d+/.exec(nbr || ""); return m ? Number(m[1]) : null; };
const isRevision = (p) => { const m = middle(p.permit_nbr); return m === null || m % 10000 !== 0 || SUPPL_TO.test(p.work_desc || ""); };

function additionObjects(w) {
  const res = [];
  for (const m of w.matchAll(ADDW)) {
    const s = m.index, e = s + m[0].length;
    const before = w.slice(Math.max(0, s - 28), s), after = w.slice(e, e + 55);
    const sep = /[.;,]|\bAND\b|&|\bW\/|\bWITH\b/i.exec(after);
    const clause = sep ? after.slice(0, sep.index) : after;
    if (new RegExp(OUT_SRC + "\\s*$", "i").test(before.trim()) || new RegExp(OUT_SRC + "\\s+(\\(\\w+\\)\\s*)?$", "i").test(before)) res.push("out");
    else if (new RegExp("^\\s*(OF\\s+|A\\s+|AN\\s+|NEW\\s+|\\(N\\)\\s+)?[^.;]{0,30}?" + OUT_SRC, "i").test(clause) && !/ADDITION\s+TO/i.test(w.slice(s, e + 5))) res.push("out");
    else res.push("live");
  }
  return res;
}
export function classify(p) {
  const w = p.work_desc || "";
  if (isRevision(p)) return "revision";
  if (RENEWAL.test(w)) return "renewal";
  if (!OUTW.test(w)) return "living";
  if (REBUILD.test(w)) return "living";
  if (ROOM.test(w) && !(WITHIN.test(w) && !additionObjects(w).includes("live"))) return "living";
  return additionObjects(w).includes("live") ? "living" : "outdoor";
}
export function nearRebuild(w = "") {
  if (!NEAR.test(w)) return false;
  if (/(REMOV\w*|DEMO\w*)\s+(THE\s+)?(ENTIRE\s+|EXISTING\s+|\(E\)\s+)?(DETACHED\s+|ATTACHED\s+)?GARAGE\b[^.;]{0,15}\bEXCEPT/i.test(w)) return false;
  return /REMOV\w*|DEMO\w*|MAJOR\s+(REMODEL|ALTERATION|RENOVATION)|\bONLY\b/i.test(w);
}
export function keptLengthFt(w = "") {
  if (!nearRebuild(w)) return null;
  const k = /\b(EXCEPT|ONLY|KEEP\w*|RETAIN\w*|LEAVING)\b/i.exec(w);
  const start = k ? k.index : NEAR.exec(w).index;
  const rest = w.slice(start);
  const stop = /[.;](\s|$)|\bREBUILD|\bRE-?BUILT|\bERECT|\b(AND\s+)?(BUILD|ADD|CREATE|CONSTRUCT)\b|\bTO\s+CREATE|\bTO\s+MAKE|\bNEW\s+OVERALL/i.exec(rest.slice(6));
  const seg = stop ? rest.slice(0, 6 + stop.index) : rest.slice(0, 140);
  let total = 0, found = false;
  for (const m of seg.matchAll(FT)) {
    const tail = seg.slice(m.index + m[0].length, m.index + m[0].length + 4), head = seg.slice(Math.max(0, m.index - 3), m.index);
    if (/^\s*[X×]/i.test(tail) || /[X×]\s*$/i.test(head)) continue;          // a dimension, not a kept length
    total += m[3] ? Number(m[3]) : Number(m[1]) + (m[2] ? Number(m[2]) / 12 : 0);
    found = true;
  }
  return found ? total : null;
}
export function upperFloor(w = "") {
  if (nearRebuild(w)) return false;
  if (/\b(1|ONE)[\s-]*STORY\s+(\S+\s+){0,3}?TO\s+(A\s+)?(2|TWO)[\s-]*STORY/.test(w.toUpperCase())) return true;
  const t = w.replace(EXISTING_STORY, " ").toUpperCase();
  for (const m of t.matchAll(new RegExp(UPPER, "g"))) {
    const win = t.slice(Math.max(0, m.index - 110), m.index + m[0].length + 45);
    if (new RegExp(ADDV).test(win)) {
      if (/CONVERT/.test(win) && !new RegExp("ADD\\w*|ADDTION|ADDITON|ADDN|ADDT'N|ENCLOS|NEW\\s+" + UPPER).test(win)) continue;
      const nearObj = t.slice(Math.max(0, m.index - 40), m.index + m[0].length + 25);
      if (OUTW.test(nearObj) && !ROOM.test(nearObj) && !/ADDITION/.test(t.slice(m.index + m[0].length, m.index + m[0].length + 12))) continue;
      return true;
    }
  }
  for (const m of t.matchAll(/\b(2|TWO|3|THREE)[\s-]*STOR(Y|IES)\b((?:\s+\S+){0,7}?)\s+(ADDITIONS?|ADDTION|ADDITON|ADDN|ADDT'N|ADU\b|ACCESSORY)/g)) {
    const between = m[3] || "";
    if (/SFD|S\.F\.D|DWELLING|RESIDENCE|\bHOME\b|\bSFR\b/.test(between)) continue;
    if (between.includes("HOUSE") && !/HOUSE\s*$/.test(between)) continue;
    return true;
  }
  if (/(ADDITIONS?|ADDTION|ADDITON|ADDT'N)\s*\(?\s*(2|TWO)[\s-]*STORY|(ADDITIONS?|ADDTION|ADDITON|ADDT'N)\s+OF\s+(A\s+)?(2|TWO)[\s-]*STOR|\bADD\w*\s+(\(N\)\s+|NEW\s+|A\s+)*(2ND|SECOND|TWO|2)[\s-]*STOR/.test(t)) return true;
  return /(CREATE|MAKE|BECOME|RESULT\w*\s+IN|INTO)\s+(A\s+|AN\s+)?(\S+\s+){0,6}?(2|TWO|3|THREE|4|FOUR)[\s-]*STORY/.test(t);
}

// ---- helpers ------------------------------------------------------------------------------------
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
const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : null);
const r2 = (x) => (x === null ? null : Math.round(x * 100) / 100);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
const atFrac = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(q * (s.length - 1))]; };
const inWindow = (iso) => iso.slice(5, 10) <= CUTOFF;
const key = (s) => (s || "").toLowerCase().replace(/[^a-z]/g, "");
function areaNormalizer(labels) {
  const canon = [...new Set(labels.filter(Boolean).map((l) => l.split(", ")[0].trim()))].sort((a, b) => b.length - a.length);
  const memo = new Map();
  return (label) => {
    if (!label) return null;
    if (!memo.has(label)) { const f = label.split(", ")[0].trim(), k = key(f); memo.set(label, canon.find((c) => key(c) === k || key(c).startsWith(k)) ?? f); }
    return memo.get(label);
  };
}

// ---- main ---------------------------------------------------------------------------------------
const main = async () => {
  const raw = await fetchAll(`permit_type='Bldg-Addition' AND permit_sub_type='1 or 2 Family Dwelling' AND issue_date >= '${FIRST_YEAR}-01-01'`,
    "permit_nbr, apn, cpa, use_desc, work_desc, submitted_date, issue_date");
  const housesRaw = await fetchAll(`permit_type='Bldg-New' AND use_desc='Dwelling - Single Family' AND issue_date >= '${FIRST_YEAR}-01-01'`,
    "permit_nbr, apn, cpa, work_desc, issue_date");
  const A = raw.filter((a) => a.use_desc === "Dwelling - Single Family");
  const extract = new Date(Math.max(...[...raw, ...housesRaw].map((x) => day(x.issue_date))) * 86400000).toISOString().slice(0, 10);
  const lastYear = +extract.slice(0, 4);
  const norm = areaNormalizer([...A.map((a) => a.cpa), ...housesRaw.map((h) => h.cpa)]);

  const counts = { single_family_addition_permits: A.length };
  const classed = A.map((a) => ({ ...a, k: classify(a), adu: ADU.test(a.work_desc || "") }));
  for (const k of ["revision", "renewal", "living", "outdoor"]) counts[k] = classed.filter((a) => a.k === k).length;
  counts.adu_linked_living_excluded = classed.filter((a) => a.k === "living" && a.adu).length;
  counts.adu_linked_near_rebuilds_excluded = classed.filter((a) => a.k === "living" && a.adu && nearRebuild(a.work_desc || "")).length;
  const rows = classed.filter((a) => (a.k === "living" || a.k === "outdoor") && !a.adu)
    .map((a) => ({ ...a, apn: a.apn || `NO-${a.permit_nbr}`, iss: a.issue_date.slice(0, 10), d: day(a.issue_date), area: norm(a.cpa) }));
  rows.sort((x, y) => (x.apn < y.apn ? -1 : x.apn > y.apn ? 1 : x.k < y.k ? -1 : x.k > y.k ? 1 : x.iss < y.iss ? -1 : x.iss > y.iss ? 1 : 0));
  const kept = [], last = new Map();
  for (const r of rows) {
    const kk = `${r.apn}|${r.k}`;
    if (last.has(kk) && r.d - last.get(kk) <= DEDUPE_DAYS) continue;
    last.set(kk, r.d); kept.push(r);
  }
  counts.same_parcel_repeats_removed = rows.length - kept.length;
  const LV = kept.filter((r) => r.k === "living").map((r) => {
    const w = r.work_desc || "";
    return { ...r, up: upperFloor(w), near: nearRebuild(w), keptFt: keptLengthFt(w) };
  });
  counts.living_space_additions = LV.length;
  counts.outdoor_only_additions = kept.length - LV.length;
  const NH = housesRaw.filter((h) => { const m = middle(h.permit_nbr); return m !== null && m % 10000 === 0 && !SUPPL_TO.test(h.work_desc || ""); })
    .map((h) => ({ iss: h.issue_date.slice(0, 10), area: norm(h.cpa) }));
  counts.new_house_permits = NH.length;

  if (AUDIT) for (const [label, xs] of [["living", LV], ["outdoor", kept.filter((r) => r.k === "outdoor")], ["upper floor", LV.filter((r) => r.up)], ["near-rebuild", LV.filter((r) => r.near)]]) {
    console.log(`\n== ${label} (${xs.length})`);
    for (let i = 0; i < Math.min(12, xs.length); i++) { const r = xs[Math.floor((i * xs.length) / 12)]; console.log("  ", r.keptFt != null && r.near ? `[${r.keptFt.toFixed(1)} ft]` : "", (r.work_desc || "").slice(0, 130)); }
  }

  const years = Array.from({ length: lastYear - FIRST_YEAR + 1 }, (_, i) => FIRST_YEAR + i);
  const byYear = years.map((y) => {
    const lv = LV.filter((r) => +r.iss.slice(0, 4) === y && inWindow(r.iss));
    const nh = NH.filter((h) => +h.iss.slice(0, 4) === y && inWindow(h.iss));
    const restA = lv.filter((r) => r.area !== PAL).length, restH = nh.filter((h) => h.area !== PAL).length;
    return { year: y, window: `Jan 1 - ${CUTOFF}`, additions: lv.length, rest_of_city_additions: restA, new_houses: nh.length, rest_of_city_new_houses: restH,
      additions_per_new_house_rest_of_city: restH ? r2(restA / restH) : null, upper_floor_additions: lv.filter((r) => r.up).length,
      upper_floor_pct: pct(lv.filter((r) => r.up).length, lv.length), near_rebuilds: lv.filter((r) => r.near).length,
      outdoor_only: kept.filter((r) => r.k === "outdoor" && +r.iss.slice(0, 4) === y && inWindow(r.iss)).length,
      additions_full_year: y < lastYear ? LV.filter((r) => +r.iss.slice(0, 4) === y).length : null };
  });

  const recent = LV.filter((r) => r.iss >= AREA_FROM), recentH = NH.filter((h) => h.iss >= AREA_FROM);
  const areaNames = [...new Set([...recent.map((r) => r.area), ...recentH.map((h) => h.area)])].filter(Boolean).sort();
  const byArea = areaNames.map((a) => {
    const ad = recent.filter((r) => r.area === a), nh = recentH.filter((h) => h.area === a).length, near = ad.filter((r) => r.near).length;
    return { community_plan_area: a, additions_since_2023: ad.length, new_houses_since_2023: nh,
      additions_per_new_house: ad.length + nh >= MIN_AREA && nh ? r2(ad.length / nh) : null,
      upper_floor_pct: ad.length >= MIN_AREA ? pct(ad.filter((r) => r.up).length, ad.length) : null,
      near_rebuilds_since_2023: near, near_rebuild_share_of_rebuilds_pct: near >= MIN_NEAR ? pct(near, near + nh) : null };
  });

  const NR = LV.filter((r) => r.near), lens = NR.map((r) => r.keptFt).filter((v) => v !== null).sort((a, b) => a - b);
  const nearRecent = recent.filter((r) => r.near).length, palNear = recent.filter((r) => r.near && r.area === PAL).length, palNH = recentH.filter((h) => h.area === PAL).length;
  const near = { total: NR.length, by_year_full: Object.fromEntries(years.map((y) => [y, NR.filter((r) => +r.iss.slice(0, 4) === y).length])),
    kept_length_stated: lens.length, median_kept_ft: r2(median(lens)), quarter_kept_at_most_ft: r2(lens[Math.floor(lens.length / 4)]),
    three_quarters_kept_at_most_ft: r2(lens[Math.floor((3 * lens.length) / 4)]), kept_2ft_or_less: lens.filter((v) => v <= 2).length, kept_5ft_or_less: lens.filter((v) => v <= 5).length,
    since_2023: nearRecent, share_of_rebuilds_since_2023_pct: pct(nearRecent, nearRecent + recentH.length),
    share_of_rebuilds_since_2023_excl_palisades_pct: pct(nearRecent - palNear, nearRecent - palNear + recentH.length - palNH),
    adu_linked_near_rebuilds_excluded: counts.adu_linked_near_rebuilds_excluded };

  const days = (xs) => { const v = xs.filter((r) => r.submitted_date).map((r) => r.d - day(r.submitted_date)).filter((x) => x >= 0); return { permits: v.length, median_days: median(v), p25_days: atFrac(v, 0.25), p75_days: atFrac(v, 0.75) }; };
  const approval = [["Ground floor only", recent.filter((r) => !r.up && !r.near)], ["Upper floor", recent.filter((r) => r.up)], ["Near-rebuild", recent.filter((r) => r.near)]]
    .map(([type, xs]) => ({ addition_type: type, ...days(xs) }));

  mkdirSync(OUT, { recursive: true });
  const csv = (rows_, cols) => [cols.join(","), ...rows_.map((r) => cols.map((c) => { const v = r[c] ?? ""; return typeof v === "string" && /[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; }).join(","))].join("\n") + "\n";
  writeFileSync(`${OUT}/home-additions-by-year.csv`, csv(byYear, Object.keys(byYear[0])));
  writeFileSync(`${OUT}/home-additions-by-community-plan-area.csv`, csv(byArea, Object.keys(byArea[0])));
  writeFileSync(`${OUT}/near-rebuilds-by-year.csv`, csv(years.map((y) => ({ year: y, near_rebuild_permits: near.by_year_full[y], partial_year: y === lastYear ? `Jan 1 - ${extract.slice(5)}` : "" })), ["year", "near_rebuild_permits", "partial_year"]));
  writeFileSync(`${OUT}/addition-permit-approval-days.csv`, csv(approval, ["addition_type", "permits", "median_days", "p25_days", "p75_days"]));
  writeFileSync(`${OUT}/home-additions.json`, JSON.stringify({
    report: "2026 Los Angeles Home Addition Report",
    source: { portal: "data.lacity.org", dataset: "pi9x-tg5x", dataset_url: DATASET_URL, extract_date: extract },
    measure: "Bldg-Addition permits on single-family houses that add living space and do not create or convert an ADU; revisions removed; classified from the work description; matched January 1 - cutoff window each year",
    matched_window: `Jan 1 - ${CUTOFF}`,
    caveats: [
      "Permits, not buildings: completion is not measured.",
      "Revisions of earlier permits are removed, identified by permit number and wording.",
      "Additions that create or convert an accessory dwelling unit (ADU/JADU) are excluded throughout; this report is about additions to the house.",
      "Patio covers, decks, trellises, carports and similar outdoor structures filed as additions are excluded from the living-space count.",
      "The source square_footage field is not the area added (it matches a stated addition size in only about 38% of permits that state one), so no size figures are published.",
      "Upper-floor and near-rebuild flags are read from free text and were hand-audited; shares carry small error rates.",
      "Near-rebuild counts are a floor: some are phrased in ways the rule does not catch, and those that also include an ADU are excluded.",
      "Application-to-issue days include time the application spends with the applicant, and cover only permits that were issued.",
      "Declared valuation is not used: it is a fee figure, not a construction cost.",
    ],
    counts, additions_by_year: byYear, by_community_plan_area: byArea, near_rebuilds: near, approval_days_since_2023: approval,
    upper_floor_share_all_years_pct: pct(LV.filter((r) => r.up).length, LV.length),
  }, null, 2) + "\n");

  console.log(`extract ${extract} | window Jan 1 - ${CUTOFF} | wrote 5 files to ${OUT}`);
  console.log("counts:", JSON.stringify(counts));
  console.table(byYear.map(({ window, ...r }) => r));
  console.log("near:", JSON.stringify(near));
  console.table(approval);
};
main().catch((e) => { console.error(e.message); process.exit(1); });
