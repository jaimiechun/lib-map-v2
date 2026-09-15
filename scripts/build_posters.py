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
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

SHEET_CSV = (
    "https://docs.google.com/spreadsheets/d/"
    "1ZBlnDJlD6_urP0JhnOnw9knpoMkIrtsZE0i4sKMNcZI/export?format=csv&gid=0"
)

CANVA_COL = "Canva Link (Use Canada as Master Document)"
DOI_COL = "DIO LINKS"

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


def load_centroids():
    centroids = json.loads((DATA / "country_centroids.json").read_text())
    return {c["name"].lower(): c for c in centroids}


def resolve_country(raw, by_name):
    key = raw.strip().rstrip(",").lower()
    key = SHEET_ALIASES.get(key, key)
    return by_name.get(key.lower())


def main():
    by_name = load_centroids()
    rows = list(csv.DictReader(io.StringIO(fetch(SHEET_CSV))))

    posters = {}
    unmatched, no_doi = set(), []
    for row in rows:
        name = (row.get("country") or "").strip()
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
        embed = resolve_canva(canva)
        if not embed:
            print(f"WARNING: could not parse Canva link for {name}: {canva}")
            continue
        posters[country["cca3"]] = {"embed": embed, "doi": doi, "country": country["name"]}

    out = DATA / "posters.js"
    out.write_text("window.WISE_POSTERS = " + json.dumps(posters, ensure_ascii=False) + ";\n")
    print(f"Wrote {len(posters)} posters to {out}")
    for iso3, p in sorted(posters.items()):
        print(f"  {iso3} {p['country']} -> {p['doi']}")
    if no_doi:
        print(f"\n{len(no_doi)} countries have a Canva poster but no DOI yet (skipped):")
        print("  " + ", ".join(sorted(no_doi)))
    if unmatched:
        print("\nWARNING: unmatched country names (add to SHEET_ALIASES):")
        for u in sorted(unmatched):
            print(f"  - {u!r}")


if __name__ == "__main__":
    main()
