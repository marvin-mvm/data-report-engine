// Netlify Edge Function — serve an article published AFTER the last deploy, without a rebuild.
//
// The blog is prerendered at build time, so an article inserted between deploys has no static
// page yet and would 404. For a /blog/<slug> that is NOT in blog-rendered.json (written by
// site/blog-manifest.mjs), this fetches the published row and returns a complete, SEO-valid page:
// title, meta, canonical, JSON-LD and the body, styled with the site's own CSS and wrapped in the
// live header and footer copied from the home page. Prerendered slugs pass straight through.
//
// The page deliberately ships NO app bundle (the client router doesn't know the route and would
// 404 it). That is why an article served here is only HALF-LIVE: until a deploy prerenders it, it
// is missing from the index and sitemap and nothing on the page is interactive.
//
// Install: copy to netlify/edge-functions/blog-article.ts and set the environment variables below
// in Netlify. It only READS published rows with the public key — no secrets.

import type { Config, Context } from "https://edge.netlify.com/v1/index.ts";

declare const Netlify: { env: { get(name: string): string | undefined } };
const env = (k: string, d = "") => Netlify.env.get(k) ?? d;

const SUPABASE_URL = env("SUPABASE_URL").replace(/\/$/, "");
const SUPABASE_ANON = env("SUPABASE_ANON_KEY");
const SITE_URL = env("SITE_URL").replace(/\/$/, "");
const TABLE = env("ARTICLES_TABLE", "articles");
const BRAND = env("BRAND_NAME");
const DEFAULT_SOCIAL_IMAGE = env("DEFAULT_SOCIAL_IMAGE");
// Where to cut the header and footer out of the home page's HTML.
const HEADER = [env("EDGE_HEADER_START", "<header"), env("EDGE_HEADER_END", "</header>")];
const FOOTER = [env("EDGE_FOOTER_START", "<footer"), env("EDGE_FOOTER_END", "</footer>")];
// Removed articles: a real 410 lets search engines drop them fast, unlike an SPA soft-404.
const GONE_SLUGS = new Set(env("GONE_SLUGS").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));

type Chrome = { cssLinks: string; header: string; footer: string };

// Isolates are reused across requests: cache the manifest and chrome briefly.
let manifestCache: { v: Set<string>; ts: number } | null = null;
let chromeCache: { v: Chrome; ts: number } | null = null;
const MANIFEST_TTL = 5 * 60 * 1000;
const CHROME_TTL = 10 * 60 * 1000;

export default async (request: Request, context: Context) => {
  try {
    if (request.headers.get("x-blog-edge")) return context.next(); // our own sub-requests
    if (!SUPABASE_URL || !SUPABASE_ANON) return context.next();    // not configured

    const url = new URL(request.url);
    const m = url.pathname.match(/^\/blog\/([^/]+)\/?$/);
    if (!m) return context.next(); // the index, assets, etc.
    const slug = decodeURIComponent(m[1]).toLowerCase();

    if (GONE_SLUGS.has(slug)) {
      return new Response(goneHtml(), {
        status: 410,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=3600" },
      });
    }

    const manifest = await getManifest(url.origin);
    if (!manifest || manifest.has(slug)) return context.next(); // prerendered, or can't tell

    const article = await fetchArticle(slug);
    if (!article) return context.next(); // unknown slug: let the site 404

    const chrome = await getChrome(url.origin);
    if (!chrome) return context.next();

    return new Response(renderArticle(article, chrome, url.origin), {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        // Short cache spares the database; a deploy purges it and the static page takes over.
        "cache-control": "public, max-age=60",
        "netlify-cdn-cache-control": "public, max-age=120, stale-while-revalidate=600",
      },
    });
  } catch {
    return context.next();
  }
};

export const config: Config = { path: "/blog/*" };

// --- helpers -----------------------------------------------------------------

async function getManifest(origin: string): Promise<Set<string> | null> {
  if (manifestCache && Date.now() - manifestCache.ts < MANIFEST_TTL) return manifestCache.v;
  try {
    const res = await fetch(`${origin}/blog-rendered.json`, { headers: { "x-blog-edge": "1" } });
    if (!res.ok) return manifestCache?.v ?? null;
    const arr = await res.json();
    if (!Array.isArray(arr)) return manifestCache?.v ?? null;
    const v = new Set<string>(arr.map((s: unknown) => String(s).toLowerCase()));
    manifestCache = { v, ts: Date.now() };
    return v;
  } catch {
    return manifestCache?.v ?? null;
  }
}

async function getChrome(origin: string): Promise<Chrome | null> {
  if (chromeCache && Date.now() - chromeCache.ts < CHROME_TTL) return chromeCache.v;
  try {
    const res = await fetch(`${origin}/`, { headers: { "x-blog-edge": "1" } });
    if (!res.ok) return chromeCache?.v ?? null;
    const html = await res.text();
    const cssLinks = (html.match(/<link\b[^>]*\brel="stylesheet"[^>]*>/gi) || []).join("\n");
    const header = extractTag(html, HEADER[0], HEADER[1]);
    const footer = extractTag(html, FOOTER[0], FOOTER[1]);
    if (!cssLinks || !header || !footer) return chromeCache?.v ?? null;
    const v: Chrome = { cssLinks, header, footer };
    chromeCache = { v, ts: Date.now() };
    return v;
  } catch {
    return chromeCache?.v ?? null;
  }
}

function extractTag(html: string, start: string, end: string): string {
  const i = html.indexOf(start);
  if (i < 0) return "";
  const j = html.indexOf(end, i);
  return j < 0 ? "" : html.slice(i, j + end.length);
}

async function fetchArticle(slug: string): Promise<Record<string, unknown> | null> {
  try {
    const q = new URL(`${SUPABASE_URL}/rest/v1/${TABLE}`);
    q.searchParams.set("slug", `eq.${slug}`);
    q.searchParams.set("status", "eq.publish");
    q.searchParams.set("select", "slug,title,excerpt,content_html,meta_description,hero_image_url,json_ld,faq_json_ld,published_at,created_at");
    q.searchParams.set("limit", "1");
    const res = await fetch(q.toString(), { headers: { apikey: SUPABASE_ANON, authorization: `Bearer ${SUPABASE_ANON}` } });
    if (!res.ok) return null;
    const rows = await res.json();
    return Array.isArray(rows) && rows.length ? rows[0] : null;
  } catch {
    return null;
  }
}

// deno-lint-ignore no-explicit-any
function renderArticle(a: Record<string, any>, chrome: Chrome, origin: string): string {
  const title = String(a.title ?? "").trim();
  const fullTitle = BRAND ? `${title} - ${BRAND}` : title;
  const desc = String(a.excerpt ?? a.meta_description ?? "").trim();
  const canonical = `${SITE_URL || origin}/blog/${String(a.slug ?? "").trim()}/`;
  const image = String(a.hero_image_url || DEFAULT_SOCIAL_IMAGE);
  const dateLabel = formatDate(String(a.published_at || a.created_at || "").slice(0, 10));
  const ld = [a.json_ld, a.faq_json_ld].filter(Boolean).map(ldScript).join("\n");
  const meta = (k: string, v: string, attr = "name") => (v ? `\n<meta ${attr}="${k}" content="${escapeAttr(v)}">` : "");

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(fullTitle)}</title>
<meta name="robots" content="index, follow">${meta("description", desc)}${meta("og:title", fullTitle, "property")}${meta("og:description", desc, "property")}${meta("og:image", image, "property")}${meta("og:url", canonical, "property")}
<meta property="og:type" content="article">${meta("twitter:card", "summary_large_image")}${meta("twitter:title", fullTitle)}${meta("twitter:description", desc)}${meta("twitter:image", image)}
<link rel="canonical" href="${escapeAttr(canonical)}">
${chrome.cssLinks}
${ld}
</head>
<body>
${chrome.header}
<main class="blog-article" style="max-width:760px;margin:0 auto;padding:48px 20px">
<article>
<h1 class="blog-article__title">${escapeHtml(title)}</h1>
<p class="blog-article__date"><em>${escapeHtml(dateLabel)}</em></p>
<div class="blog-article__body">${String(a.content_html ?? "")}</div>
<p class="blog-article__all"><a href="/blog">← Back to all articles</a></p>
</article>
</main>
${chrome.footer}
</body></html>`;
}

function goneHtml(): string {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex">' +
    `<title>Page removed${BRAND ? ` — ${escapeHtml(BRAND)}` : ""}</title>` +
    '<meta name="viewport" content="width=device-width, initial-scale=1"></head>' +
    '<body style="font-family:system-ui,sans-serif;max-width:640px;margin:12vh auto;padding:0 24px;text-align:center;line-height:1.6">' +
    '<h1 style="font-weight:600">This page no longer exists</h1><p>The article you were looking for has been permanently removed.</p>' +
    '<p><a href="/blog">See the latest articles &rarr;</a></p></body></html>';
}

function formatDate(iso: string): string {
  if (!iso) return "";
  try {
    return new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  } catch {
    return iso;
  }
}

function ldScript(obj: unknown): string {
  // Escape "<" so a stray "</script>" inside the JSON can't break out.
  return `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, "\\u003c")}</script>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}
