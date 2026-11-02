#!/usr/bin/env node
// Snapshot every PUBLISHED article into <out>/<slug>.json, plus index.json, for a versioned backup.
// The database is the only home of the article text unless something copies it out; commit the
// snapshot to a private repo after each publish.
//
// Uses the public read key, so drafts are not included (row-level security hides them).
// Usage: node engine/export-published.mjs <out-dir>
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig, need, die, rest } from "./config.mjs";

const cfg = loadConfig();
need(cfg, "supabaseUrl", "anonKey");
const out = resolve(process.argv[2] || "published-rows");
const r = rest(cfg, cfg.anonKey);

const res = await fetch(r.url("?select=*&status=eq.publish&order=published_at.desc&limit=10000"), { headers: r.headers });
if (!res.ok) die(`fetch failed (${res.status}): ${await res.text()}`);
const rows = await res.json();
if (!rows.length) die("no published rows returned; refusing to empty the snapshot");

mkdirSync(out, { recursive: true });
for (const f of readdirSync(out)) if (f.endsWith(".json")) rmSync(join(out, f)); // unpublished rows drop out
for (const row of rows) writeFileSync(join(out, `${row.slug}.json`), JSON.stringify(row, null, 2) + "\n");
writeFileSync(join(out, "index.json"), JSON.stringify(
  rows.map((x) => ({ slug: x.slug, title: x.title, published_at: x.published_at, updated_at: x.updated_at })), null, 2) + "\n");
console.log(`exported ${rows.length} published article(s) → ${out}`);
