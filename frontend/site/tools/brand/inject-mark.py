"""Put the AquaNexus emblem to the left of the header wordmark.

The site ships as one self-contained HTML file, so the mark is embedded as a
base64 data URI (no extra request, works from file:// too). Runs over the main
page and over the escaped sub-pages that live inside the embedded-pages JSON.
Idempotent: re-running does not stack images or styles.
"""
from __future__ import annotations

import pathlib
import re
import sys

HERE = pathlib.Path(__file__).resolve().parent
SITE = HERE.parent.parent
MARK_B64 = (HERE / "aquanexus-mark.b64").read_text(encoding="utf-8").strip()

BRAND_TEXT = "AQUANEXUS<small>FIELD NOTES &amp; WATER SYSTEMS</small></a>"
BRAND_PATTERN = re.compile(
    r'(<a [^>]{0,160}?class=\\?"(?:brand|rrt-brand)\\?"[^>]*>)'
    r"(AQUANEXUS<small>FIELD NOTES &amp; WATER SYSTEMS</small></a>)"
)

BRAND_CSS = (
    "<style id=\"aqn-brand\">"
    "header .brand,header .rrt-brand{display:inline-flex;align-items:center;gap:11px}"
    "header .brand-name{display:block}"
    "header .brand-mark{flex:none;width:40px;height:40px;border-radius:50%;display:block}"
    "@media(max-width:1000px){header .brand-mark{width:34px;height:34px;gap:9px}}"
    "@media(max-width:560px){header .brand,header .rrt-brand{gap:8px}"
    "header .brand-mark{width:30px;height:30px}}"
    "</style>"
)

# Same rules, but with no double quotes at all: this copy is injected inside a
# JSON string, where bare quotes would terminate the string.
BRAND_CSS_ESCAPED_SAFE = BRAND_CSS  # already quote-free except the id attribute
assert '"' not in BRAND_CSS.replace('<style id="aqn-brand">', "<style id=aqn-brand>")


PLAIN_IMG = (
    '<img class="brand-mark" alt="" aria-hidden="true" width="40" height="40"'
    ' decoding="async" src="data:image/png;base64,' + MARK_B64 + '">'
)
# Inside the embedded-pages JSON every attribute quote must be backslash-escaped.
ESCAPED_IMG = PLAIN_IMG.replace('"', '\\"')


def replace_brands(text: str) -> tuple[str, int]:
    count = 0

    def render(match: re.Match[str]) -> str:
        nonlocal count
        opening, closing = match.group(1), match.group(2)
        escaped = '\\"' in opening
        img = ESCAPED_IMG if escaped else PLAIN_IMG
        span = '<span class=\\"brand-name\\">' if escaped else '<span class="brand-name">'
        body = closing[: -len("</a>")]
        count += 1
        return opening + img + span + body + "</span></a>"

    return BRAND_PATTERN.sub(render, text), count


def main() -> None:
    path = SITE / "index.html"
    html = path.read_text(encoding="utf-8")
    if 'id="aqn-brand"' in html:
        print("already applied — nothing to do")
        return

    html, brands = replace_brands(html)
    if brands == 0:
        sys.exit("FAILED: no header wordmark found")

    css_plain = BRAND_CSS.replace('id="aqn-brand"', 'id="aqn-brand"')
    css_json = BRAND_CSS.replace('id="aqn-brand"', "id=aqn-brand")

    # Main page: land the styles before </head>.
    head = html.index("</head>")
    html = html[:head] + css_plain + html[head:]

    # Embedded sub-pages: same styles, quote-free so the JSON payload stays valid.
    def add_to_pages(match: re.Match[str]) -> str:
        doc = match.group(0)
        return doc.replace("</head>", css_json + "</head>", 1)

    html = re.sub(r'(?s)<style id=\\"aqn-type\\">.*?</head>', add_to_pages, html)

    path.write_text(html, encoding="utf-8")
    print("brand marks added:", brands)
    print("bytes:", len(html.encode("utf-8")))


if __name__ == "__main__":
    main()
