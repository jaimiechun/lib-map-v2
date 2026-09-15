"""
Imports poster PNGs exported from Canva into assets/posters/, named by ISO3,
and rewires data/posters.js to serve those local files instead of Canva embeds.

Usage:
    python3 scripts/import_posters.py ~/Downloads/canva-posters

Canva's bulk download names files after the design title (e.g.
"v3 Insecurity Experiences in Bolivian - AK.png"), so each file is matched to a
country by looking for a known country name inside the filename. Anything it
can't match confidently is left alone and reported, so nothing is silently
filed under the wrong country.

Matched files are copied to assets/posters/<ISO3>.png (downscaled to a
web-sized image via `sips` when available), and each country's entry in
data/posters.js switches from {"embed": <canva url>} to {"image":
"assets/posters/<ISO3>.png"} — the card renders whichever is present.

Re-run build_posters.py first if the sheet has new DOIs, then re-run this.
"""
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
POSTER_DIR = ROOT / "assets" / "posters"

# Longest edge of the stored PNG. Posters are decorative thumbnails in a ~300px
# card; 1200px keeps them crisp on retina without shipping 20MB of print art.
MAX_PX = 1200

# Canva titles don't always use the same country spelling as the map data.
TITLE_ALIASES = {
    "bolivian": "Bolivia",
    "canadian": "Canada",
    "chadian": "Chad",
    "israeli": "Israel",
    "lebanese": "Lebanon",
    "libyan": "Libya",
    "mozambican": "Mozambique",
    "burmese": "Myanmar",
    "palestinian": "Palestine",
    "sri lankan": "Sri Lanka",
    "british": "United Kingdom",
    "uk": "United Kingdom",
    "usa": "United States",
    "american": "United States",
    "ukrainian": "Ukraine",
    "uruguayan": "Uruguay",
    "venezuelan": "Venezuela",
    "vietnamese": "Vietnam",
}


def norm(s):
    return re.sub(r"[^a-z ]+", " ", s.lower())


def match_country(filename, names_by_iso3):
    """Finds which country a Canva export belongs to, or None if ambiguous."""
    hay = " " + " ".join(norm(filename).split()) + " "
    hits = set()
    for iso3, name in names_by_iso3.items():
        if f" {norm(name).strip()} " in hay:
            hits.add(iso3)
    for adj, name in TITLE_ALIASES.items():
        if f" {adj} " in hay:
            for iso3, n in names_by_iso3.items():
                if n == name:
                    hits.add(iso3)
    return hits.pop() if len(hits) == 1 else None


def downscale(dest):
    """Shrinks in place with macOS `sips`; a no-op elsewhere."""
    if not shutil.which("sips"):
        return
    subprocess.run(
        ["sips", "-Z", str(MAX_PX), str(dest)],
        check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )


def main():
    if len(sys.argv) < 2:
        sys.exit("usage: python3 scripts/import_posters.py <folder-of-pngs>")
    src_dir = Path(sys.argv[1]).expanduser()
    if not src_dir.is_dir():
        sys.exit(f"not a folder: {src_dir}")

    posters_js = DATA / "posters.js"
    raw = posters_js.read_text()
    posters = json.loads(raw[raw.index("{"): raw.rindex("}") + 1])
    names_by_iso3 = {iso3: p["country"] for iso3, p in posters.items()}

    POSTER_DIR.mkdir(parents=True, exist_ok=True)
    files = sorted(
        p for p in src_dir.rglob("*")
        if p.suffix.lower() in {".png", ".jpg", ".jpeg"} and not p.name.startswith(".")
    )
    if not files:
        sys.exit(f"no images found in {src_dir}")

    # Every country on the map, so a file can be told apart from a file whose
    # country simply has no DOI yet (the common case, not an error).
    all_names = {
        c["iso3"]: c["name"] for c in json.loads((DATA / "countries.json").read_text())
    }

    imported, waiting, unmatched = [], [], []
    for f in files:
        iso3 = match_country(f.stem, names_by_iso3)
        if not iso3:
            other = match_country(f.stem, all_names)
            (waiting if other else unmatched).append(all_names[other] if other else f.name)
            continue
        dest = POSTER_DIR / f"{iso3}{f.suffix.lower()}"
        shutil.copy2(f, dest)
        downscale(dest)
        posters[iso3] = {
            "image": f"assets/posters/{dest.name}",
            "doi": posters[iso3]["doi"],
            "country": posters[iso3]["country"],
        }
        size_kb = dest.stat().st_size // 1024
        imported.append(f"  {iso3} {posters[iso3]['country']:<16} {f.name}  ({size_kb} KB)")

    posters_js.write_text("window.WISE_POSTERS = " + json.dumps(posters, ensure_ascii=False) + ";\n")

    print(f"Imported {len(imported)} posters into {POSTER_DIR}:")
    print("\n".join(imported))

    still_embed = [p["country"] for p in posters.values() if "embed" in p]
    if still_embed:
        print(f"\n{len(still_embed)} still using a Canva embed (no PNG matched):")
        print("  " + ", ".join(sorted(still_embed)))
    if waiting:
        print(f"\n{len(waiting)} poster(s) held back until their country has a DOI:")
        print("  " + ", ".join(sorted(set(waiting))))
        print("  Add the DOI in the sheet, re-run build_posters.py, then re-run this.")
    if unmatched:
        print(f"\n{len(unmatched)} file(s) I couldn't match to any country (left alone):")
        for u in unmatched:
            print(f"  - {u}")
        print("  Rename the file to include the country name, or add to TITLE_ALIASES.")
    print("\nNext: python3 scripts/bump_cache_version.py")


if __name__ == "__main__":
    main()
