#!/usr/bin/env node
/* postbuild — write <dist>/blog-rendered.json, the list of article slugs that have a prerendered
   page in this build. The edge fallback (blog-article.edge.ts) reads it to decide whether a
   /blog/<slug> request is already prerendered (pass it through) or brand-new (render it live from
   the database). It sits OUTSIDE /blog/* so the edge function never intercepts its own fetch.
   DIST_DIR defaults to dist; BLOG_PATH (default /blog) names the folder inside it. */
import { readdirSync, statSync, existsSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { loadConfig } from "../engine/config.mjs";

const cfg = loadConfig();
const dist = resolve(process.env.DIST_DIR || "dist");
const blogDir = join(dist, cfg.blogPath.replace(/^\//, ""));
const OUT = join(dist, "blog-rendered.json");

const slugs = new Set();
try {
  for (const entry of readdirSync(blogDir)) {
    if (entry.endsWith(".html")) { slugs.add(entry.replace(/\.html$/, "").toLowerCase()); continue; } // /blog/<slug>.html
    const nested = join(blogDir, entry);
    if (statSync(nested).isDirectory() && existsSync(join(nested, "index.html"))) slugs.add(entry.toLowerCase()); // /blog/<slug>/index.html
  }
} catch (e) {
  console.warn(`[blog-manifest] could not read ${blogDir} (${e?.message || e})`);
}
writeFileSync(OUT, JSON.stringify([...slugs]));
console.log(`[blog-manifest] wrote ${slugs.size} prerendered slug(s) → ${OUT}`);
