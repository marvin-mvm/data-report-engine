#!/usr/bin/env node
/* prebuild — fetch PUBLISHED articles and write them where the site's prerenderer reads them, so
   each article ships as a static /blog/<slug> page: real HTML for crawlers, no client fetch.

   Wire it as the site's "prebuild" script. Output is BLOG_GENERATED_OUT (default
   src/data/blog.generated.json); a .ts path gets an `export const GENERATED_POSTS = …` module.
   Resilient by design: if the database is unreachable it writes an EMPTY set so the build still
   succeeds. The build reads the database at BUILD time, so rebuilding the same commit after a new
   publish produces different output: "nothing changed in git" does not mean "nothing to deploy". */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadConfig, rest } from "../engine/config.mjs";

const cfg = loadConfig();
const OUT = resolve(process.env.BLOG_GENERATED_OUT || "src/data/blog.generated.json");

function write(posts) {
  mkdirSync(dirname(OUT), { recursive: true });
  const json = JSON.stringify(posts, null, 2);
  writeFileSync(OUT, OUT.endsWith(".ts")
    ? `// AUTO-GENERATED at build time by build-blog.mjs — DO NOT EDIT.\nexport const GENERATED_POSTS = ${json};\n`
    : json + "\n");
}

try {
  if (!cfg.supabaseUrl || !cfg.anonKey) throw new Error("SUPABASE_URL / SUPABASE_ANON_KEY not set");
  const r = rest(cfg, cfg.anonKey);
  const res = await fetch(r.url("?select=slug,title,excerpt,content_html,hero_image_url,meta_description,json_ld,faq_json_ld,published_at,created_at&status=eq.publish&order=published_at.desc&limit=10000"), { headers: r.headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const posts = (await res.json()).map((a) => ({
    slug: a.slug,
    title: a.title,
    date: String(a.published_at || a.created_at || "").slice(0, 10),
    // excerpt wins over meta_description: it becomes the page's meta description.
    excerpt: a.excerpt || a.meta_description || "",
    html: a.content_html || "",
    ...(a.hero_image_url ? { heroImageUrl: a.hero_image_url } : {}),
    ...(a.json_ld ? { jsonLd: a.json_ld } : {}),
    ...(a.faq_json_ld ? { faqJsonLd: a.faq_json_ld } : {}),
  }));
  write(posts);
  console.log(`[build-blog] wrote ${posts.length} published article(s) → ${OUT}`);
} catch (e) {
  console.warn(`[build-blog] could not load articles (${e?.message || e}); writing empty set`);
  write([]);
}
