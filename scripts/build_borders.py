"""
Builds data/borders.js: country boundary polygons for every country in
data/countries.json that has nationally representative data. Loaded by
index.html via a script tag (window.WISE_BORDERS) so it works on file://.

Sources: data/raw/world_borders.geo.json (Natural Earth 110m via
johan/world.geo.json) plus data/raw/islands_supplement.geo.json (four small
island nations missing at 110m, extracted from Natural Earth 50m).

Run: python3 scripts/build_borders.py
Re-run after build_data.py whenever the set of countries changes.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"


def main():
    countries = json.loads((DATA / "countries.json").read_text())
    rep_iso3 = {c["iso3"] for c in countries if c["nationallyRepresentative"]}

    features = {}
    for src in ("world_borders.geo.json", "islands_supplement.geo.json"):
        for f in json.loads((DATA / "raw" / src).read_text())["features"]:
            if f["id"] in rep_iso3:
                features[f["id"]] = f

    out = {"type": "FeatureCollection", "features": list(features.values())}
    js_path = DATA / "borders.js"
    js_path.write_text("window.WISE_BORDERS = " + json.dumps(out) + ";\n")

    # Full world landmass, drawn as the basemap (no raster tiles).
    world = json.loads((DATA / "raw" / "world_borders.geo.json").read_text())
    world_path = DATA / "world.js"
    world_path.write_text("window.WISE_WORLD = " + json.dumps(world) + ";\n")
    print(f"Wrote {len(world['features'])} world landmass features to {world_path}")

    missing = sorted(rep_iso3 - features.keys())
    print(f"Wrote {len(features)} country borders to {js_path}")
    if missing:
        print(f"WARNING: no border polygon found for: {', '.join(missing)}")


if __name__ == "__main__":
    main()
