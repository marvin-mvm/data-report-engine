"""Helpers for generating a data-report article row from a published dataset.

The article is generated from the data, never typed by hand: every figure in the text is read from
the dataset JSON, and each sentence that states a pattern is guarded by claim(), so a data refresh
that makes a sentence untrue stops the build instead of publishing it.

Charts are plain HTML and inline SVG. Article HTML is usually injected without a sanitizer, and a
<script> would run on the prerendered page but not after hydration, so none is used. Every chart
prints its values as text beside the marks, which is what scrapers and AI crawlers read.

Python 3.9+, standard library only.
"""
import html
import json

esc = html.escape

# Neutral defaults. Override per site with set_theme(...) before building any chart.
THEME = {
    "bar": "#3d5a80", "track": "#e5e7eb", "muted": "#6b7280", "grid": "#e5e7eb",
    "series": ["#3d5a80", "#c26d3f", "#5b8c5a", "#8e6c8a"],
}


def set_theme(**kw):
    THEME.update(kw)


# ---- number formatting --------------------------------------------------------------------------
def n(x):
    return f"{x:,}"


def pct(x, d=1):
    return f"{x:.{d}f}%"


def chg(a, b):
    """Percent change from b to a."""
    return (a - b) / b * 100


def claim(cond, msg):
    """Guard a sentence. Unlike assert, this still runs under python -O."""
    if not cond:
        raise SystemExit(f"CLAIM NO LONGER TRUE, reword before publishing: {msg}")


# ---- charts and tables --------------------------------------------------------------------------
def caption(text):
    return f'<p style="font-size:.9rem;color:{THEME["muted"]};margin:0 0 1.6em">{text}</p>'


def bars(rows, maxv, cap, label_pct=34, value_pct=26):
    """Horizontal bar chart from divs. rows = [(label_html, value, value_text), ...]."""
    o = ['<div style="margin:0 0 1.6em">']
    for label, v, txt in rows:
        o.append(
            f'<div style="display:flex;align-items:center;gap:10px;margin:0 0 6px;font-size:.92rem">'
            f'<div style="flex:0 0 {label_pct}%;text-align:right;line-height:1.3">{label}</div>'
            f'<div style="flex:1 1 auto;background:{THEME["track"]};border-radius:2px;height:18px">'
            f'<div style="width:{100 * v / maxv:.1f}%;background:{THEME["bar"]};height:18px;border-radius:2px"></div></div>'
            f'<div style="flex:0 0 {value_pct}%;font-variant-numeric:tabular-nums">{txt}</div></div>')
    o.append("</div>")
    return "\n".join(o) + "\n" + caption(cap)


def table(head, rows):
    """Plain table in a horizontal scroller, so it never widens the page on a phone."""
    cell = 'style="padding:5px 20px 5px 0;text-align:left;vertical-align:top"'
    t = ['<div style="overflow-x:auto;margin:0 0 1.5em"><table style="border-collapse:collapse">',
         "<thead><tr>" + "".join(f"<th {cell}>{h}</th>" for h in head) + "</tr></thead>", "<tbody>"]
    t += ["<tr>" + "".join(f"<td {cell}>{c}</td>" for c in r) + "</tr>" for r in rows]
    t.append("</tbody></table></div>")
    return "\n".join(t)


def line_chart(x_labels, series, y_ticks, aria_label, cap, fmt=n, width=640, height=270):
    """Inline-SVG line chart with every point labelled.

    series = [(name, [values...]), ...], one value per x label. The legend is HTML above the chart,
    not text inside it, so long names never collide with the lines.
    """
    L, R, T, B = 60, width - 34, 26, height - 44
    vmax = y_ticks[-1]
    x = lambda i: L + i * (R - L) / max(1, len(x_labels) - 1)
    y = lambda v: B - v / vmax * (B - T)
    colors = THEME["series"]
    legend = '<div style="display:flex;flex-wrap:wrap;gap:6px 22px;font-size:.88rem;margin:0 0 .4em">' + "".join(
        f'<span><span style="display:inline-block;width:18px;height:3px;background:{colors[k % len(colors)]};'
        f'vertical-align:middle;margin-right:7px"></span>{esc(name)}</span>' for k, (name, _) in enumerate(series)) + "</div>"
    g = [legend, f'<div style="margin:0 0 .6em"><svg viewBox="0 0 {width} {height}" width="100%" role="img" '
                 f'aria-label="{esc(aria_label)}" style="max-width:{width}px;height:auto;font-family:inherit">']
    for v in y_ticks:
        g.append(f'<line x1="{L}" y1="{y(v):.1f}" x2="{R}" y2="{y(v):.1f}" stroke="{THEME["grid"]}" stroke-width="1"/>'
                 f'<text x="{L - 8}" y="{y(v) + 5:.1f}" text-anchor="end" font-size="14" fill="{THEME["muted"]}">{fmt(v)}</text>')
    for i, lab in enumerate(x_labels):
        g.append(f'<text x="{x(i):.1f}" y="{B + 26}" text-anchor="middle" font-size="14" fill="{THEME["muted"]}">{esc(str(lab))}</text>')
    for k, (_, values) in enumerate(series):
        c = colors[k % len(colors)]
        g.append(f'<polyline fill="none" stroke="{c}" stroke-width="2.5" stroke-linejoin="round" '
                 f'points="{" ".join(f"{x(i):.1f},{y(v):.1f}" for i, v in enumerate(values))}"/>')
        for i, v in enumerate(values):
            g.append(f'<circle cx="{x(i):.1f}" cy="{y(v):.1f}" r="3.2" fill="{c}"/>'
                     f'<text x="{x(i):.1f}" y="{y(v) - 10:.1f}" text-anchor="middle" font-size="14" fill="{c}" font-weight="600">{fmt(v)}</text>')
    g.append("</svg></div>")
    return "".join(g) + caption(cap)


def downloads(base_url, files):
    """files = [(filename, description), ...] -> a list of links to the published data."""
    return "<ul>" + "".join(f'<li><a href="{base_url}/{f}">{f}</a> — {d}</li>' for f, d in files) + "</ul>"


# ---- FAQ and structured data ----------------------------------------------------------------------
def faq_html(faq):
    return "\n".join(f"<h3>{esc(q)}</h3><p>{esc(a)}</p>" for q, a in faq)


def faq_json_ld(faq):
    return {"@context": "https://schema.org", "@type": "FAQPage", "mainEntity": [
        {"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": a}} for q, a in faq]}


def report_json_ld(*, title, description, page_url, image, published, org, source_url,
                   dataset_name, dataset_description, temporal, place, variables, data_url, files, license_url=None):
    """An @graph holding the Article and a schema.org Dataset, which is what makes the report
    eligible for Google Dataset Search. Pass license_url only after reading the source portal's
    terms; leave it out otherwise."""
    dataset = {
        "@type": "Dataset", "name": dataset_name, "description": dataset_description, "url": page_url,
        "creator": org, "isBasedOn": source_url, "temporalCoverage": temporal,
        "spatialCoverage": {"@type": "Place", "name": place}, "variableMeasured": variables,
        "distribution": [{"@type": "DataDownload", "name": f, "contentUrl": f"{data_url}/{f}",
                          "encodingFormat": "application/json" if f.endswith(".json") else "text/csv"} for f, _ in files],
    }
    if license_url:
        dataset["license"] = license_url
    return {"@context": "https://schema.org", "@graph": [
        {"@type": "Article", "headline": title, "description": description, "image": image, "author": org,
         "publisher": org, "datePublished": published, "dateModified": published, "isBasedOn": source_url,
         "mainEntityOfPage": {"@type": "WebPage", "@id": page_url}},
        dataset]}


# ---- the row --------------------------------------------------------------------------------------
def make_row(*, slug, title, excerpt, content_html, content_markdown, hero_image_url, published,
             json_ld, faq=None, language="en"):
    claim(len(excerpt) <= 160, f"excerpt is {len(excerpt)} characters; keep it at 160 or fewer")
    claim("<h1" not in content_html.lower(), "content_html has an <h1>; the template renders the title")
    claim("<script" not in content_html.lower(), "content_html has a <script>; use HTML and inline SVG")
    return {
        "slug": slug, "title": title, "excerpt": excerpt, "meta_description": excerpt,
        "content_html": content_html, "content_markdown": content_markdown, "hero_image_url": hero_image_url,
        "language_code": language, "status": "publish", "published_at": f"{published}T16:00:00+00:00",
        "json_ld": json_ld, "faq_json_ld": faq_json_ld(faq) if faq else None,
    }


def write_row(row, path):
    with open(path, "w") as f:
        json.dump(row, f, indent=2, ensure_ascii=False)
    print(f"{path} written | excerpt {len(row['excerpt'])} | html {len(row['content_html']):,} "
          f"| md {len(row['content_markdown']):,}")


def write_preview(row, path):
    """A bare page for eyeballing the article before it goes near the site."""
    page = (f'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            f"<title>{esc(row['title'])}</title></head>"
            f'<body style="font-family:system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 16px;line-height:1.6">'
            f"<h1>{esc(row['title'])}</h1>{row['content_html']}</body></html>")
    with open(path, "w") as f:
        f.write(page)
