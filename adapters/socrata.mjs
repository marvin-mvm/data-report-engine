// Read any Socrata open-data portal (most US city and county portals: data.<city>.gov / .org).
// Public datasets need no key. A browser User-Agent avoids the occasional bot block.
//
//   import { soql, fetchAll, toCsv, median, atFrac, pct } from "../adapters/socrata.mjs";
//   const api = "https://data.lacity.org/resource/pi9x-tg5x.json";
//   const rows = await fetchAll(api, { select: "permit_nbr, issue_date", where: "issue_date >= '2024-01-01'", order: "permit_nbr" });
//
// Always ORDER BY a unique column when paging, or rows can repeat or go missing between pages.
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function soql(api, query, { tries = 4 } = {}) {
  for (let i = 1; ; i++) {
    const res = await fetch(`${api}?$query=${encodeURIComponent(query)}`, { headers: { "User-Agent": UA } });
    if (res.ok) return res.json();
    if (i >= tries || res.status < 500) throw new Error(`SoQL ${res.status}: ${(await res.text()).slice(0, 300)}`);
    await sleep(2000 * i);
  }
}

export async function fetchAll(api, { select = "*", where = "1=1", order, pageSize = 50000 } = {}) {
  if (!order) throw new Error("fetchAll needs an order column (a unique one) for stable paging");
  const out = [];
  for (let off = 0; ; off += pageSize) {
    const page = await soql(api, `SELECT ${select} WHERE ${where} ORDER BY ${order} LIMIT ${pageSize} OFFSET ${off}`);
    out.push(...page);
    if (page.length < pageSize) return out;
  }
}

export function toCsv(rows, cols = Object.keys(rows[0] ?? {})) {
  const cell = (v) => (v === null || v === undefined ? "" : typeof v === "string" && /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n") + "\n";
}

export const median = (xs) => { const s = [...xs].sort((a, b) => a - b), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
export const atFrac = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(q * (s.length - 1))]; };
export const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : null);
