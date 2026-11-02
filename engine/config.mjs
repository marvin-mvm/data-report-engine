// Engine settings. process.env wins; otherwise the env file named by ENGINE_ENV (default ./.env).
// Keep that file OUT of git: it holds the service-role key. See config.example.env.
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export function loadConfig() {
  const envFile = resolve(process.env.ENGINE_ENV || ".env");
  const fromFile = {};
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (m) fromFile[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
  const get = (k, d = "") => process.env[k] || fromFile[k] || d;
  return {
    envFile,
    siteUrl: get("SITE_URL").replace(/\/$/, ""),
    blogPath: get("BLOG_PATH", "/blog").replace(/\/$/, ""),
    supabaseUrl: get("SUPABASE_URL").replace(/\/$/, ""),
    anonKey: get("SUPABASE_ANON_KEY"),
    serviceKey: get("SUPABASE_SERVICE_ROLE_KEY"),
    table: get("ARTICLES_TABLE", "articles"),
    bucket: get("IMAGES_BUCKET", "blog-images"),
    // What a fully deployed article page loads. A page served before the deploy (by the edge
    // fallback) ships the CSS but not this, which is how "half-live" is detected.
    bundlePattern: new RegExp(get("BUNDLE_PATTERN", "assets/[\\w.-]+\\.js")),
    deployHook: get("DEPLOY_HOOK_URL"),
  };
}

export function need(cfg, ...keys) {
  const names = { siteUrl: "SITE_URL", supabaseUrl: "SUPABASE_URL", anonKey: "SUPABASE_ANON_KEY", serviceKey: "SUPABASE_SERVICE_ROLE_KEY" };
  const missing = keys.filter((k) => !cfg[k]).map((k) => names[k] || k);
  if (missing.length) die(`missing setting(s): ${missing.join(", ")} (set them in ${cfg.envFile} or the environment)`);
}

export const die = (msg) => { console.error(`\n✗ ${msg}`); process.exit(1); };

export const rest = (cfg, key) => ({
  url: (q) => `${cfg.supabaseUrl}/rest/v1/${cfg.table}${q}`,
  headers: { apikey: key, authorization: `Bearer ${key}` },
});

export const publicImagePrefix = (cfg) => `${cfg.supabaseUrl}/storage/v1/object/public/${cfg.bucket}/`;
