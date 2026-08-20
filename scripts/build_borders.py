"""
Builds data/borders.js (country boundary polygons for every nationally
representative country) and data/world.js (the full world landmass basemap).
Both are loaded by index.html via script tags (window.WISE_BORDERS /
window.WISE_WORLD) so they work on file://.

Sources, layered lowest to highest priority:
  1. data/raw/world_borders.geo.json - Natural Earth 110m (johan/world.geo.json),
     180 countries. The base layer.
  2. data/raw/land_overrides.geo.json - higher-resolution replacements for
     specific countries where the 110m polygon clips off territory that a
     data point actually sits on (e.g. Ecuador's Galapagos Islands, present
     at 50m but not 110m). Replaces the matching ISO3 entirely.
  3. data/raw/islands_supplement.geo.json - small nations missing from the
     110m set altogether (Comoros, Mauritius, Sao Tome and Principe, Tonga,
     Samoa), extracted from Natural Earth 50m. Only added for ISO3s not
     already present.

Run: python3 scripts/build_borders.py
Re-run after build_data.py whenever the set of countries or data points
changes. If a new data point lands in open water, check whether its
country's 110m polygon simply omits that territory (common for remote
islands) - if so add a higher-res override the same way ECU was fixed,
rather than assuming the coordinate is wrong.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"


def build_land_features():
    features = {}
    for f in json.loads((DATA / "raw" / "world_borders.geo.json").read_text())["features"]:
        features[f["id"]] = f
    for f in json.loads((DATA / "raw" / "land_overrides.geo.json").read_text())["features"]:
        features[f["id"]] = f  # replace, even if already present
    for f in json.loads((DATA / "raw" / "islands_supplement.geo.json").read_text())["features"]:
        features.setdefault(f["id"], f)  # only fill gaps
    return features


def main():
    countries = json.loads((DATA / "countries.json").read_text())
    rep_iso3 = {c["iso3"] for c in countries if c["nationallyRepresentative"]}

    land_features = build_land_features()

    border_features = {iso3: f for iso3, f in land_features.items() if iso3 in rep_iso3}
    out = {"type": "FeatureCollection", "features": list(border_features.values())}
    js_path = DATA / "borders.js"
    js_path.write_text("window.WISE_BORDERS = " + json.dumps(out) + ";\n")

    world = {"type": "FeatureCollection", "features": list(land_features.values())}
    world_path = DATA / "world.js"
    world_path.write_text("window.WISE_WORLD = " + json.dumps(world) + ";\n")
    print(f"Wrote {len(world['features'])} world landmass features to {world_path}")

    missing = sorted(rep_iso3 - border_features.keys())
    print(f"Wrote {len(border_features)} country borders to {js_path}")
    if missing:
        print(f"WARNING: no border polygon found for: {', '.join(missing)}")


if __name__ == "__main__":
    main()
