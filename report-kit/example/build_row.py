#!/usr/bin/env python3
"""Worked example: generate an article row from a dataset. Copy this file per report.

Usage: python3 -I build_row.py <dataset.json> <published-date YYYY-MM-DD> [row.json] [--preview preview.html]

Pattern: read every figure from the dataset, derive the comparisons, guard each sentence that
states a pattern with claim(), then assemble HTML, Markdown, JSON-LD and the row. The data here is
fictional; the structure is the point.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # report_kit.py (works under -I)
from report_kit import (bars, caption, chg, claim, downloads, faq_html, line_chart, make_row, n, pct,
                        report_json_ld, table, write_preview, write_row)

args = [a for a in sys.argv[1:] if not a.startswith("--")]
d = __import__("json").load(open(args[0]))
PUB = args[1]
OUT = args[2] if len(args) > 2 else "row.json"

# ---- site settings (per site) ----
SITE = "https://www.example.com"
SLUG = "example-city-deck-permit-report-2026"
TITLE = "2026 Example City Deck Permit Report"
HERO = f"https://YOUR-PROJECT.supabase.co/storage/v1/object/public/blog-images/{SLUG}.webp"
DATA = f"{SITE}/data/{SLUG}"
ORG = {"@type": "Organization", "name": "Your Company", "url": SITE}

# ---- figures, all read from the data ----
SRC, C = d["source"], d["counts"]
Y = {r["year"]: r for r in d["by_year"]}
LY, PY = max(Y), max(Y) - 1
PEAK = max(Y, key=lambda y: Y[y]["permits"])
yoy, vs_peak = chg(Y[LY]["permits"], Y[PY]["permits"]), chg(Y[LY]["permits"], Y[PEAK]["permits"])
areas = sorted(d["by_area_since_2024"], key=lambda a: -a["permits"])
total_area = sum(a["permits"] for a in areas)

# ---- the claims the text makes; a refresh that breaks one stops the build ----
claim(PEAK == 2022, "the peak year moved: reword Finding 1")
claim(yoy < 0 and vs_peak < -25, "the latest year is no longer well below the peak: reword Finding 1")
claim(areas[0]["area"] == "Harbor", "Harbor no longer leads: reword Finding 2")

# ---- HTML (no <h1>: the template renders the title) ----
P = []
P.append(f"<p>{n(C['in_scope'])} deck permits in Example City since 2021, every year cut to the same January 1 – October 31 window. "
         f"Permits peaked in {PEAK} and {LY} is {pct(abs(vs_peak))} below that peak.</p>")
P.append("<h2>The Dataset</h2>")
P.append(f"<p>Source: {SRC['name']}, extracted {SRC['extract_date']}. {n(C['revisions_removed'])} revisions to earlier permits "
         f"were removed, and {n(C['not_in_scope'])} permits that were not decks were set aside.</p>")
P.append(f"<h2>Finding 1: Deck Permits Peaked in {PEAK}</h2>")
P.append(f"<p>{LY} is {pct(abs(yoy))} below {PY} at the same point in the year.</p>")
P.append(line_chart(sorted(Y), [("Deck permits", [Y[y]["permits"] for y in sorted(Y)])], [0, 500, 1000, 1500],
                    "Deck permits in Example City, January 1 to October 31 of each year",
                    "Permits issued January 1 – October 31 of each year, revisions removed."))
P.append(table(["Year", "Jan 1 – Oct 31", "Full year"],
               [[y, n(Y[y]["permits"]), n(Y[y]["permits_full_year"]) if Y[y]["permits_full_year"] else "—"] for y in sorted(Y)]))
P.append(f"<h2>Finding 2: {areas[0]['area']} Leads</h2>")
P.append(bars([(a["area"], a["permits"], f"{n(a['permits'])} ({pct(100 * a['permits'] / total_area)})") for a in areas],
              areas[0]["permits"], "Deck permits by area since January 2024."))
P.append("<h2>Possible Readings</h2>")
P.append("<p>List the explanations that fit the pattern and say what the record can and cannot tell apart. Do not pick one.</p>")
P.append("<h2>Opportunity Spotlight</h2><p>What a reader could do with this, stated without overclaiming.</p>")
P.append("<h2>Method</h2><p>Filters, exclusions, the matched window, and what each field does and does not measure.</p>")
FILES = [("deck-permits-by-year.csv", "permits by year in the matched window"),
         ("deck-permits.json", "the complete dataset with counts at every cleaning step")]
P.append("<h2>Download the Data</h2>" + downloads(DATA, FILES))
FAQ = [("How many deck permits does Example City issue a year?",
        f"Between {n(min(Y[y]['permits_full_year'] for y in Y if Y[y]['permits_full_year']))} and "
        f"{n(max(Y[y]['permits_full_year'] for y in Y if Y[y]['permits_full_year']))} in each full year since 2021.")]
P.append("<h2>FAQ</h2>" + faq_html(FAQ))
content_html = "\n".join(P)

# ---- Markdown twin: same figures, plain text for readers and crawlers ----
M = [f"# {TITLE}", "", f"Source: {SRC['name']} ({SRC['dataset_url']}), extracted {SRC['extract_date']}.", "",
     "| Year | Jan 1 – Oct 31 | Full year |", "| --- | --- | --- |"]
M += [f"| {y} | {n(Y[y]['permits'])} | {n(Y[y]['permits_full_year']) if Y[y]['permits_full_year'] else '-'} |" for y in sorted(Y)]
M += ["", "## Download", ""] + [f"- [{f}]({DATA}/{f})" for f, _ in FILES]
content_markdown = "\n".join(M) + "\n"

EXCERPT = f"Example City deck permit data: permits peaked in {PEAK} and {LY} is {pct(abs(vs_peak), 0)} below the peak, with {areas[0]['area']} leading."
json_ld = report_json_ld(
    title=TITLE, description=EXCERPT, page_url=f"{SITE}/blog/{SLUG}", image=HERO, published=PUB, org=ORG,
    source_url=SRC["dataset_url"], dataset_name=f"Example City deck permits, 2021-{LY}",
    dataset_description="Deck permits by year in a matched January 1 - October 31 window, and by area.",
    temporal=f"2021-01-01/{SRC['extract_date']}", place="Example City", variables=["Deck permits by year", "Deck permits by area"],
    data_url=DATA, files=FILES)
row = make_row(slug=SLUG, title=TITLE, excerpt=EXCERPT, content_html=content_html, content_markdown=content_markdown,
               hero_image_url=HERO, published=PUB, json_ld=json_ld, faq=FAQ)
write_row(row, OUT)
if "--preview" in sys.argv:
    write_preview(row, sys.argv[sys.argv.index("--preview") + 1])
