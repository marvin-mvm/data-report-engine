#!/usr/bin/env node
// Upload an image to the public images bucket and print the URL to use as hero_image_url.
// Name it by the article slug. Resize first with tools/cover.py (a 2k PNG is ~9 MB; the webp ~300 KB).
//
// Usage: node engine/upload-image.mjs <file.webp> [<name-in-bucket>]
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { loadConfig, need, die, publicImagePrefix } from "./config.mjs";

const cfg = loadConfig();
need(cfg, "supabaseUrl", "serviceKey");
const file = process.argv[2] || die("usage: node engine/upload-image.mjs <file> [<name>]");
const name = process.argv[3] || basename(file);
const types = { ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };
const type = types[extname(name).toLowerCase()] || die(`unsupported image type: ${name}`);

const res = await fetch(`${cfg.supabaseUrl}/storage/v1/object/${cfg.bucket}/${encodeURIComponent(name)}`, {
  method: "POST",
  headers: { apikey: cfg.serviceKey, authorization: `Bearer ${cfg.serviceKey}`, "Content-Type": type, "x-upsert": "true" },
  body: readFileSync(file),
});
if (!res.ok) die(`upload failed (${res.status}): ${await res.text()}`);

// Confirm it serves before anything points at it.
const url = publicImagePrefix(cfg) + encodeURIComponent(name);
const head = await fetch(url, { method: "HEAD" });
if (!head.ok) die(`uploaded, but ${url} returns ${head.status}`);
console.log(url);
