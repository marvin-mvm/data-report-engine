#!/usr/bin/env node
/* postbuild — inject PUBLISHED article URLs into the BUILT sitemap, between the
   <!-- ARTICLES:START --> and <!-- ARTICLES:END --> markers. It edits the build output
   (default dist/sitemap.xml, override with SITEMAP_PATH), so the source sitemap stays clean.
   Resilient: on any failure it leaves the sitemap untouched. */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, rest } from "../engine/config.mjs";

const cfg = loadConfig();
const SITEMAP = resolve(process.env.SITEMAP_PATH || "dist/sitemap.xml");
const START = "<!-- ARTICLES:START -->";
const END = "<!-- ARTICLES:END -->";
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

try {
  if (!cfg.siteUrl || !cfg.supabaseUrl || !cfg.anonKey) throw new Error("SITE_URL / SUPABASE_URL / SUPABASE_ANON_KEY not set");
  if (!existsSync(SITEMAP)) throw new Error(`${SITEMAP} not found`);
  let xml = readFileSync(SITEMAP, "utf8");
  if (!xml.includes(START) || !xml.includes(END)) throw new Error("article markers missing");

  const r = rest(cfg, cfg.anonKey);
  const res = await fetch(r.url("?select=slug,published_at,updated_at,created_at&status=eq.publish&order=published_at.desc&limit=10000"), { headers: r.headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const rows = await res.json();

  const entries = rows.map((a) => {
    const lastmod = String(a.updated_at || a.published_at || a.created_at || "").slice(0, 10);
    return `  <url>\n    <loc>${esc(`${cfg.siteUrl}${cfg.blogPath}/${a.slug}/`)}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <priority>0.7</priority>\n  </url>`;
  }).join("\n");

  xml = xml.replace(new RegExp(`${START}[\\s\\S]*?${END}`), entries ? `${START}\n${entries}\n  ${END}` : `${START}\n  ${END}`);
  writeFileSync(SITEMAP, xml);
  console.log(`[inject-sitemap] wrote ${rows.length} article URL(s) into ${SITEMAP}`);
} catch (e) {
  console.warn(`[inject-sitemap] skipped (${e?.message || e})`);
}
