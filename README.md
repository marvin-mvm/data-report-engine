# data-report-engine

A pipeline for publishing **public-data research reports** on a prerendered blog: pull an open
dataset, clean and verify it, generate the article from the data, publish it to a Supabase table,
deploy, and verify that it is actually live. Each report ships with its CSV and JSON so people and
AI agents can cite the numbers.

> **Provenance:** generalized public edition of a pipeline I built and run in production; client
> details removed. The LA examples run against the City's public open data.

Read [`PLAYBOOK.md`](PLAYBOOK.md) first. It holds the method, and most of it is about not
publishing a wrong number.

## Layout

| Path | What it does |
|---|---|
| `engine/publish-article.mjs` | Checks a row (no H1 or script, own-bucket hero, excerpt ≤160), then inserts, patches or dry-runs it. `--verify <slug>` confirms index, sitemap and app bundle after a deploy. |
| `engine/upload-image.mjs` | Uploads a cover to the public images bucket and prints its URL once it serves. |
| `engine/export-published.mjs` | Snapshots every published row to JSON for a versioned backup. |
| `engine/config.mjs` | Settings from the environment or an env file. |
| `site/build-blog.mjs` | Prebuild: writes published articles where the prerenderer reads them. |
| `site/inject-sitemap.mjs` | Postbuild: adds article URLs to the built sitemap. |
| `site/blog-manifest.mjs` | Postbuild: lists prerendered slugs for the edge fallback. |
| `site/blog-article.edge.ts` | Netlify edge function: serves an article published after the last deploy. |
| `supabase/articles.sql` | Table, row-level security, grants and the images bucket. |
| `report-kit/report_kit.py` | Chart, table, FAQ and JSON-LD helpers, plus `claim()` guards. Standard library only. |
| `report-kit/example/` | A worked `build_row.py` on fictional sample data. |
| `adapters/socrata.mjs` | Paged queries against any Socrata open-data portal, plus CSV and stats helpers. |
| `examples/la-building-permits/` | Six complete dataset scripts on LA permit data, with their traps documented. |
| `tools/cover.py` | Downscales a generated cover to a 1400px webp. |

## Setup

1. **Database.** Run `supabase/articles.sql` in the Supabase project.
2. **Config.** Copy `config.example.env` to `.env` (git-ignored) or set `ENGINE_ENV` to a file
   outside the repo. The service-role key bypasses row-level security: never print or commit it.
3. **Site.** The site prerenders `/blog/<slug>` from the generated file. Wire the hooks:
   ```json
   "prebuild": "node <engine>/site/build-blog.mjs",
   "postbuild": "node <engine>/site/inject-sitemap.mjs && node <engine>/site/blog-manifest.mjs"
   ```
   Put `<!-- ARTICLES:START -->` and `<!-- ARTICLES:END -->` in the source sitemap. On Netlify, copy
   `site/blog-article.edge.ts` to `netlify/edge-functions/blog-article.ts` and set its variables.

Node 18+ and Python 3.9+. Pillow only for `tools/cover.py`.

## One report, end to end

```bash
# 1. dedupe the topic against what's live
node engine/export-published.mjs out/published && cat out/published/index.json

# 2. build the dataset (from the site root; --out for a dry run)
node examples/la-building-permits/la-home-addition-data.mjs --out /tmp/check

# 3. generate the article from the data (copy report-kit/example/build_row.py per report)
python3 -I build_row.py public/data/<slug>/<file>.json 2026-11-02 row.json --preview preview.html

# 4. cover: generate, LOOK at it, downscale, upload
python3 -I tools/cover.py cover.png <slug>.webp && node engine/upload-image.mjs <slug>.webp

# 5. publish: dry run, then for real
node engine/publish-article.mjs row.json --dry-run
node engine/publish-article.mjs row.json

# 6. deploy the site, then confirm it is fully live
node engine/publish-article.mjs --verify <slug> --timeout 10
```

The insert alone leaves the article half-live. See the playbook, section 6.

## License

MIT. See [`LICENSE`](LICENSE).
