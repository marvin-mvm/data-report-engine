#!/usr/bin/env node
// Publish an article row, and verify it is ACTUALLY live — not just reachable.
//
// Inserting a row alone leaves an article HALF-LIVE: its direct URL works (the edge fallback in
// site/ renders it from the database), but it is missing from the blog index and the sitemap,
// which are prerendered at build time, and the page ships without the app bundle. Only a deploy
// finishes the job, so this script never reports "published" from the insert alone.
//
// Usage:
//   node engine/publish-article.mjs <row.json> --dry-run    # run every check, write nothing
//   node engine/publish-article.mjs <row.json>              # insert (refuses an existing slug)
//   node engine/publish-article.mjs <row.json> --patch      # update the existing row by slug
//   node engine/publish-article.mjs <row.json> --deploy     # insert, then POST DEPLOY_HOOK_URL and verify
//   node engine/publish-article.mjs --verify <slug> [--timeout <minutes>]
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, need, die, rest, publicImagePrefix } from "./config.mjs";

const cfg = loadConfig();
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f, d) => { const i = args.indexOf(f); return i > -1 && args[i + 1] ? args[i + 1] : d; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function checkRow(row) {
  const problems = [], warnings = [];
  for (const f of ["slug", "title", "content_html", "status"]) if (!row[f]) problems.push(`missing required field: ${f}`);
  if (row.slug && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(row.slug)) problems.push(`slug is not lowercase-hyphenated: ${row.slug}`);
  if (row.status && !["publish", "draft", "pending"].includes(row.status)) problems.push(`status must be publish, draft or pending: ${row.status}`);
  const html = row.content_html || "";
  // The page template renders the title as the H1; a second one in the body hurts SEO.
  if (/<h1[\s>]/i.test(html)) problems.push("content_html contains an <h1>: the template renders the title. Remove it.");
  // Article HTML is injected without a sanitizer: a <script> would run on the prerendered page only.
  if (/<script[\s>]/i.test(html)) problems.push("content_html contains a <script>: build charts from HTML and inline SVG instead.");
  // Images must live on storage we control. A vendor-hosted image keeps loading until the day the
  // vendor deletes it, and then every article that used it breaks at once.
  const prefix = publicImagePrefix(cfg);
  if (!row.hero_image_url) warnings.push("no hero_image_url: the index card and social preview fall back to a placeholder");
  else if (cfg.supabaseUrl && !row.hero_image_url.startsWith(prefix)) problems.push(`hero_image_url is not on our own bucket (${prefix}…)`);
  // The excerpt is the meta description: keep it whole in search results and keyword-led.
  if (!row.excerpt) warnings.push("no excerpt: it becomes the meta description");
  else if (row.excerpt.length > 160) problems.push(`excerpt is ${row.excerpt.length} characters; keep it at 160 or fewer`);
  const imgs = [...html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/gi)].map((m) => m[1]);
  const foreign = imgs.filter((u) => /^https?:/.test(u) && cfg.supabaseUrl && !u.startsWith(cfg.supabaseUrl) && !(cfg.siteUrl && u.startsWith(cfg.siteUrl)));
  if (foreign.length) warnings.push(`${foreign.length} in-body image(s) hosted elsewhere, e.g. ${foreign[0]}`);
  return { problems, warnings };
}

async function slugExists(slug) {
  // Read with the service key so drafts count too: the public key only sees published rows.
  const r = rest(cfg, cfg.serviceKey || cfg.anonKey);
  const res = await fetch(r.url(`?select=slug&slug=eq.${encodeURIComponent(slug)}`), { headers: r.headers });
  if (!res.ok) die(`lookup failed (${res.status}): ${await res.text()}`);
  return (await res.json()).length > 0;
}

async function write(row, patch) {
  const r = rest(cfg, cfg.serviceKey);
  const body = { ...row };
  if (patch) delete body.published_at; // an edit must not move the publication date
  const res = await fetch(patch ? r.url(`?slug=eq.${encodeURIComponent(row.slug)}`) : r.url(""), {
    method: patch ? "PATCH" : "POST",
    headers: { ...r.headers, "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify(body),
  });
  if (!res.ok) die(`${patch ? "update" : "insert"} failed (${res.status}): ${await res.text()}`);
  const saved = await res.json();
  if (!saved.length) die(`no row matched slug ${row.slug}`);
  console.log(`  ✓ ${patch ? "updated" : "inserted"}  ${saved[0].slug}  (${saved[0].status})`);
}

async function deploy() {
  if (!cfg.deployHook) {
    console.log("\n  ! DEPLOY_HOOK_URL is not set. Deploy the site by your usual route, then run --verify.");
    return false;
  }
  const res = await fetch(cfg.deployHook, { method: "POST" });
  if (!res.ok) die(`deploy hook returned ${res.status}`);
  console.log("  ✓ deploy triggered");
  return true;
}

// A 200 on the article URL proves nothing: check the three things only a deploy produces.
async function verify(slug, minutes) {
  need(cfg, "siteUrl");
  const blog = `${cfg.siteUrl}${cfg.blogPath}`;
  const check = async () => {
    const get = (u) => fetch(u).then((r) => r.text()).catch(() => "");
    const [index, sitemap, page] = await Promise.all([get(blog), get(`${cfg.siteUrl}/sitemap.xml`), get(`${blog}/${slug}`)]);
    return { listed: index.includes(slug), sitemap: sitemap.includes(slug), bundle: cfg.bundlePattern.test(page) };
  };
  const until = Date.now() + minutes * 60_000;
  let r = await check();
  if (minutes > 0) process.stdout.write("  … waiting for the deploy (index, sitemap, app bundle)");
  while (!(r.listed && r.sitemap && r.bundle) && Date.now() < until) {
    process.stdout.write(".");
    await sleep(15_000);
    r = await check();
  }
  const mark = (ok) => (ok ? "ok" : "MISSING");
  console.log(`\n  blog index : ${mark(r.listed)}\n  sitemap    : ${mark(r.sitemap)}\n  app bundle : ${mark(r.bundle)}`);
  if (r.listed && r.sitemap && r.bundle) { console.log("  ✓ live"); return true; }
  console.log("  ✗ not fully live: the deploy has not run or has not finished.");
  return false;
}

if (flag("--verify")) {
  const slug = opt("--verify") || die("--verify needs a slug");
  process.exit((await verify(slug, Number(opt("--timeout", "0")))) ? 0 : 1);
}

const rowPath = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--timeout");
if (!rowPath) die("usage: node engine/publish-article.mjs <row.json> [--dry-run | --patch | --deploy]");
const row = JSON.parse(readFileSync(resolve(rowPath), "utf8"));
need(cfg, "supabaseUrl");

const { problems, warnings } = checkRow(row);
for (const w of warnings) console.log(`  ! ${w}`);
if (problems.length) die(`row failed ${problems.length} check(s):\n  - ${problems.join("\n  - ")}`);
console.log(`  ✓ row checks passed  (${row.slug}, excerpt ${row.excerpt?.length ?? 0} chars)`);

if (flag("--dry-run")) {
  need(cfg, "anonKey");
  const exists = await slugExists(row.slug);
  console.log(exists ? `  ! slug already exists: publishing would need --patch` : "  ✓ slug is free");
  console.log("  (dry run: nothing written)");
  process.exit(0);
}

need(cfg, "serviceKey");
const patch = flag("--patch");
const exists = await slugExists(row.slug);
if (!patch && exists) die(`slug already exists: ${row.slug}. Use --patch to edit it.`);
if (patch && !exists) die(`no article with slug ${row.slug} to patch`);
await write(row, patch);

if (!flag("--deploy")) {
  console.log("\n  ! The article is HALF-LIVE: the direct URL works, but it is not in the blog index or");
  console.log("    the sitemap and ships without the app bundle until the site is deployed.");
  console.log(`    After deploying: node engine/publish-article.mjs --verify ${row.slug}`);
  process.exit(0);
}
if (!(await deploy())) process.exit(1);
process.exit((await verify(row.slug, 10)) ? 0 : 1);
