# Playbook: public-data research reports

The method behind the engine. The aim is to become a source that people **and AI agents** cite:
easy-to-read text, with the data published beside it. Each rule below exists because breaking it
produced a wrong number at least once.

## 1. What a report is

**Format:** Dataset → Findings → Possible readings → Opportunity spotlight → Method → Download the
data → FAQ → Recommended (links to related live articles).

- **Never claim causation.** Report the measurement, then list the competing explanations and leave
  them open. If the data genuinely can't tell them apart, say so, but check first that it can't.
- **State the caveats up front:** what each field actually means, and what the source excludes.
- **Pick topics from data you can get free and verify.** Prefer official open-data portals. Paid
  aggregators cost money per pull and you can't audit their cleaning.
- **Dedupe every topic against live titles before drafting** (`engine/export-published.mjs`
  writes `index.json`).

## 2. Data rules

- **Match the comparison window.** A partial current year is compared like-for-like (every year cut
  to Jan 1 – the extract date), never against full prior years.
- **Verify what a filter really contains.** A category called "new 1–2 family dwelling" turned out
  to include ADUs, garages, patio covers and sheds, overstating "new houses" about 3x. Sample the
  rows behind every filter.
- **Check what a numeric field measures before publishing it.** A `square_footage` field matched the
  stated addition size only 38% of the time: it recorded the area of all the work. A declared
  valuation is a fee figure, not a cost.
- **Search the free-text fields before declaring something unmeasurable.** "The record doesn't say
  which permits are fire rebuilds" was wrong for two reports: the description field opened with
  "WILDFIRE REBUILD" on 1,200 of them.
- **Check field coverage.** If only a third of a category carries a date, measuring the rest
  selects for a biased minority. Leave the category out and say why.
- **Remove revisions and duplicates.** Supplemental permits revise earlier ones and can be a quarter
  of a category. Find the rule (often in the permit number), then catch misspelled wording too.
- **Classify from free text, then hand-audit.** Read 25–40 random rows per rule and fix what's wrong.
  Phrases describing the existing building ("(E) 2-story house") are not new work.
- **Clean label fields.** Truncated duplicates of the same area name split its count.
- **⚠️ Survivorship in any duration measure.** Averaging "time to finish" over records that HAVE
  finished drops everything still in progress, and recent cohorts have had less time, so the newest
  years look fastest because they are least complete. Report a **fixed-horizon share of a whole
  cohort** (of everything started in year Y, the share finished within N months), publish a horizon
  only once every record has had the full N months, and quote medians only for mature cohorts.
- **Cohort by the event that guarantees membership.** If the source only holds records that reached
  a stage, cohort by that stage's date. An earlier-stage cohort is missing its slowest members and
  invents a downward trend.
- **Watch batch effects.** Group releases (a tract finaled on one day) distort medians; publish the
  figure without them alongside.

## 3. Verification

- **Independent re-implementation.** Rewrite the pipeline separately (a different language helps)
  and require **0 mismatches** on every published figure.
- **Generate the article from the data** (`report-kit/`). No figure is typed by hand, and `claim()`
  guards every sentence that states a pattern.
- **Preview** at desktop and 390px phone width: no horizontal page scroll, charts readable, one H1.
- **Build the site locally** before publishing.

## 4. The article

- **No H1 in `content_html`.** The template renders the title.
- **Charts are HTML first, inline SVG for time series, and never `<script>`.** Article HTML is
  injected without a sanitizer, and a script would run on the prerendered page only. Print every
  value as text beside its mark: that is what scrapers read.
- **Excerpt = meta description.** Primary keyword near the start, the place name if local,
  **≤160 characters**, and only what the article covers. Set `meta_description` to the same text.
- **Structured data:** `json_ld` as an `@graph` holding the `Article` and a schema.org **`Dataset`**
  (name, description, `isBasedOn`, `temporalCoverage`, `spatialCoverage`, `variableMeasured`, a
  `distribution` per file). That makes the report eligible for Google Dataset Search. Add `license`
  only after reading the source portal's terms. FAQ goes in `faq_json_ld` as `FAQPage`.
- **Publish the data:** CSV + JSON at `/data/<slug>/`, linked from "Download the Data", and list them
  in `llms.txt` under an Open Data section, which points AI agents at the files.
- **Links:** internal links only to live pages. Outbound links go to authoritative public primary
  sources (government, official releases, standards bodies, established news) and are **dofollow**.
  Never link to competitors, and never join a link exchange.

## 5. Cover image

- **Every article needs one**, or the index card and social preview fall back to a placeholder.
- Generate editorial-style photography at 3:2. In the prompt, state: no logos, no brand marks, no
  lettering, no text, no people. Some video models reject real-estate scenes as IP and still charge.
- **Look at it at full size before using it.** Image models draw real trademarks (a heat-pump maker's
  logo, an excavator brand) and garbled text. Regenerate anything with a mark.
- Downscale (`tools/cover.py`) and **host it on your own storage** (`engine/upload-image.mjs`).
  Never point at a vendor's CDN: their URLs keep working until the day they delete the bucket, and
  then every article breaks at once. When migrating, download the bytes, upload, confirm the new
  URL serves, then repoint, in that order. Check in-body images and the Markdown twin too.

## 6. Publishing

- **A human approves every article. Never auto-publish.**
- **An insert is not a publish.** After `engine/publish-article.mjs`, the article is HALF-LIVE: the
  direct URL works through the edge fallback, but it is missing from the blog index and the
  sitemap, and the page ships without the app bundle, so nothing on it is interactive. The page
  looks right at rest, which is what makes this easy to miss.
- The build reads the database at build time, so rebuilding the same commit after a publish changes
  the output: "nothing changed in git" does not mean "nothing to deploy".
- **Verify after the deploy:** `publish-article.mjs --verify <slug>` (index, sitemap, bundle), then
  open each data file and check its content type. A 200 on `/data/…` before the deploy is the SPA
  fallback page, not the file.
- After an article is prerendered, later edits need a redeploy to appear.
- Snapshot published rows to a private repo (`engine/export-published.mjs`) after each publish.

## 7. What not to do (from a vendor that was dropped)

- **No scaled, templated content.** Dozens of near-identical articles on a timer, or one page per
  town ("doorway pages"), match search engines' scaled-content-abuse pattern. Removed pages return
  HTTP 410.
- **No off-topic "Top 5 alternatives to X" listicles.** They were the vendor's link-exchange
  mechanism, and reciprocal links disappear when the subscription ends. A backlink is only worth
  having if it would exist without a subscription.
- **No hotlinked images** (see section 5).

## 8. Research tooling

- Try plain `curl` with a browser User-Agent first. It clears most 403s at no cost.
- A scraping API (e.g. Firecrawl) handles JS-rendered pages, PDFs and hard bot protection. It may
  fail on CSV files; a reader proxy (`https://r.jina.ai/<url>` with `X-Return-Format: text`)
  fetches those for a remote check.
- Cite primary sources and attribute every figure in the text.
