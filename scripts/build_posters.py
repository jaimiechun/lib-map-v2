"""
Builds data/posters.js - the per-country poster (Canva design) shown at the
bottom of a country's detail card, linking out to that country's DOI.

Source: the "INWISE DOI tracker" Google Sheet, read as CSV over the network
(SHEET_CSV below). Column M holds the Canva design link, column S the DOI.
Only countries that have BOTH are emitted, since the poster's whole job is to
be a clickable route to the DOI. Re-run this whenever more DOIs land in the
sheet:

    python3 scripts/build_posters.py

Canva links come in two shapes: full /design/<id>/<token>/edit URLs and
canva.link/<slug> shorteners (resolved here by following the redirect). Both
are rewritten to /design/<id>/<token>/view?embed, the form Canva's embed
viewer expects.

SECURITY NOTE: that <token> is the design's share token, and if the design is
shared as "anyone with the link can edit", the same token also opens the
editor. Publishing it puts edit access on the public web. Before shipping,
either set the designs to view-only in Canva, or export each poster to PNG and
serve it from assets/posters/ instead (see POSTER IMAGES in README).
"""
import csv
import io
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

SHEET_XLSX = (
    "https://docs.google.com/spreadsheets/d/"
    "1ZBlnDJlD6_urP0JhnOnw9knpoMkIrtsZE0i4sKMNcZI/export?format=xlsx"
)

CANVA_COL = "Canva Link (Use Canada as Master Document)"
DOI_COL = "DIO LINKS"

# Columns are looked up by header text, not position, because the sheet gets
# columns inserted into it (the DOI column has already moved from S to T).
# The country is the first column whatever it happens to be titled — its
# header has been "country" and "Man" at different points.

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"

# Sheet spellings that don't match data/country_centroids.json.
SHEET_ALIASES = {
    "congo kinshasa (drc": "DR Congo",
    "congo kinshasa (drc)": "DR Congo",
    "congo brazzaville": "Congo",
    "usa": "United States",
}

DESIGN_RE = re.compile(r"/design/([^/]+)/([^/?#]+)")


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req) as resp:
        return resp.read().decode("utf-8")


def resolve_canva(url):
    """Returns the /view?embed form of a Canva design link, or None."""
    url = url.strip()
    if not url:
        return None
    if "canva.link/" in url:
        # Shortener: follow it to the underlying /design/<id>/<token>/... URL.
        # Canva answers the final hop with 403 to non-browser clients, but the
        # redirect has already told us the URL we need.
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        try:
            with urllib.request.urlopen(req) as resp:
                url = resp.url
        except urllib.error.HTTPError as e:
            url = e.url
        except urllib.error.URLError:
            return None
    m = DESIGN_RE.search(url)
    if not m:
        return None
    return f"https://www.canva.com/design/{m.group(1)}/{m.group(2)}/view?embed"


def read_sheet():
    """Reads the sheet as xlsx, preferring each cell's hyperlink to its text.

    A cell in Sheets can display one URL while linking to another — paste a
    link over a cell that already had one and the visible text keeps the old
    value. The CSV export only carries the text, which is how the UK's poster
    came to point at Canada's DOI: the text was stale, the actual link right.
    xlsx keeps both, so take the hyperlink where there is one.
    """
    try:
        import openpyxl
    except ImportError:
        sys.exit("ERROR: needs openpyxl (pip3 install openpyxl) to read cell hyperlinks")

    raw = urllib.request.urlopen(
        urllib.request.Request(SHEET_XLSX, headers={"User-Agent": UA})
    ).read()
    ws = openpyxl.load_workbook(io.BytesIO(raw)).worksheets[0]

    grid = list(ws.iter_rows())
    fieldnames = [str(c.value).strip() if c.value is not None else "" for c in grid[0]]
    rows, relinked = [], []
    for cells in grid[1:]:
        row = {}
        for header, cell in zip(fieldnames, cells):
            text = str(cell.value).strip() if cell.value is not None else ""
            link = cell.hyperlink.target.strip() if cell.hyperlink and cell.hyperlink.target else ""
            if link and text and link != text:
                relinked.append((cells[0].value, header, text, link))
            row[header] = link or text
        rows.append(row)

    for country, header, text, link in relinked:
        print(f"NOTE: {str(country).strip()} {header!r} shows {text} but links to {link} — using the link")
    return rows, fieldnames


def load_centroids():
    centroids = json.loads((DATA / "country_centroids.json").read_text())
    return {c["name"].lower(): c for c in centroids}


def resolve_country(raw, by_name):
    key = raw.strip().rstrip(",").lower()
    key = SHEET_ALIASES.get(key, key)
    return by_name.get(key.lower())


def main():
    by_name = load_centroids()
    rows, fieldnames = read_sheet()
    country_col = fieldnames[0]
    for col in (CANVA_COL, DOI_COL):
        if col not in fieldnames:
            sys.exit(f"ERROR: column {col!r} is gone from the sheet; headers are {fieldnames}")

    previous = {}
    out_path = DATA / "posters.js"
    if out_path.exists():
        raw = out_path.read_text()
        previous = json.loads(raw[raw.index("{"): raw.rindex("}") + 1])

    posters = {}
    unmatched, no_doi = set(), []
    for row in rows:
        name = (row.get(country_col) or "").strip()
        if not name:
            continue
        doi = (row.get(DOI_COL) or "").strip()
        canva = (row.get(CANVA_COL) or "").strip()
        if not canva:
            continue
        country = resolve_country(name, by_name)
        if not country:
            unmatched.add(name)
            continue
        if not doi:
            no_doi.append(country["name"])
            continue
        # Deliberately NOT emitting the Canva URL. Those share links are edit
        # links — signed out they open the full editor — so shipping one in
        # data/posters.js would publish edit access to the design. The poster
        # image comes from import_posters.py instead; a country with a DOI but
        # no imported PNG simply shows no poster until one is exported.
        posters[country["cca3"]] = {"doi": doi, "country": country["name"]}
        # Keep the imported PNG, which lives only in posters.js — rebuilding
        # for a DOI change must not blank out every poster on the map.
        existing = previous.get(country["cca3"], {}).get("image")
        if existing and (ROOT / existing).exists():
            posters[country["cca3"]]["image"] = existing

    out = DATA / "posters.js"
    out.write_text("window.WISE_POSTERS = " + json.dumps(posters, ensure_ascii=False) + ";\n")
    print(f"Wrote {len(posters)} posters to {out}")
    for iso3, p in sorted(posters.items()):
        print(f"  {iso3} {p['country']} -> {p['doi']}")
    # Two countries pointing at one record means a paste went astray in the
    # sheet; the poster still links somewhere, so nothing here would otherwise
    # look broken until someone followed it to the wrong country's data.
    by_doi = {}
    for iso3, p in posters.items():
        by_doi.setdefault(p["doi"].rstrip("/"), []).append(p["country"])
    shared = {doi: cs for doi, cs in by_doi.items() if len(cs) > 1}
    if shared:
        print("\nWARNING: one DOI used by several countries — check the sheet:")
        for doi, cs in shared.items():
            print(f"  {doi} <- {', '.join(sorted(cs))}")
    if no_doi:
        print(f"\n{len(no_doi)} countries have a Canva poster but no DOI yet (skipped):")
        print("  " + ", ".join(sorted(no_doi)))
    if unmatched:
        print("\nWARNING: unmatched country names (add to SHEET_ALIASES):")
        for u in sorted(unmatched):
            print(f"  - {u!r}")


if __name__ == "__main__":
    main()
