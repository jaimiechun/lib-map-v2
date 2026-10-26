"""
Renders the map's default view to a standalone SVG (assets/wise-map.svg).

Mirrors what app.js draws on load — Equal Earth projection, the same land /
border / sea colours, nationally-representative shading, and one dot per
(location, tool) group sized by entry count and shaded by status — so the file
can go into slides or a paper without screenshotting the browser.

Run after rebuilding the data:

    python3 scripts/export_map_svg.py [--width 2000] [--out path.svg]

Keep the constants here in step with the ones at the top of app.js if those
change; they're duplicated rather than shared because the site has no build
step and this script never runs in the browser.
"""
import argparse
import json
import math
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

SEA = "#20B2AA"
LAND = "#fbfaf6"
BORDER = "#d6d0c5"
REP_FILL = "#82AEF3"
TEAL = "#0e7c7b"
TOOL_COLORS = {
    "HWISE-12": "#00AEE5",
    "HWISE-4": "#00DF30",
    "IWISE-12": "#00DDDC",
    "IWISE-4": "#0078C4",
    "Healthcare Facility (HCF) - WISE": "#00C6A1",
    "SCHOOL-WISE": "#002565",
}

# Equal Earth (Šavrič, Patterson & Jenny 2018) — same polynomial as app.js.
A1, A2, A3, A4 = 1.340264, -0.081106, 0.000893, 0.003796
M = math.sqrt(3) / 2
DEG = math.pi / 180


def eq_earth(lat, lng):
    lat = max(-90.0, min(90.0, lat))
    theta = math.asin(M * math.sin(lat * DEG))
    denom = M * (A1 + 3 * A2 * theta**2 + theta**6 * (7 * A3 + 9 * A4 * theta**2))
    x = lng * DEG * math.cos(theta) / denom
    y = theta * (A1 + A2 * theta**2 + theta**6 * (A3 + A4 * theta**2))
    return x, y


def load_js_global(path, name):
    text = (ROOT / path).read_text()
    return json.loads(text[text.index("=") + 1: text.rindex(";")].strip())


def percentile_bounds(points, p=2):
    """The app's default framing: trim outliers so the dense band fills the
    frame instead of fitting all 360° for a few Pacific sites."""
    def at(values, q):
        s = sorted(values)
        i = min(len(s) - 1, max(0, round(q / 100 * (len(s) - 1))))
        return s[i]
    lats = [pt[0] for pt in points]
    lngs = [pt[1] for pt in points]
    return (at(lats, p), at(lngs, p), at(lats, 100 - p), at(lngs, 100 - p))


def aggregate_status(entries):
    statuses = {e["status"] for e in entries}
    if statuses <= {"Completed"}:
        return "completed"
    if statuses <= {"Planned"}:
        return "planned"
    return "mixed"


def marker_groups(country):
    """Group by real coordinate + tool, nudging co-located tools into a ring —
    the same shape as markersFor() in app.js."""
    groups = {}
    for e in country["entries"]:
        has = isinstance(e.get("lat"), (int, float)) and isinstance(e.get("lng"), (int, float))
        lat = e["lat"] if has else country["lat"]
        lng = e["lng"] if has else country["lng"]
        loc_key = f"{e['lat']:.4f},{e['lng']:.4f}" if has else "centroid"
        key = (loc_key, e.get("tool") or "Other")
        groups.setdefault(key, {"lat": lat, "lng": lng, "loc": loc_key,
                                "tool": key[1], "entries": []})["entries"].append(e)

    by_loc = {}
    for g in groups.values():
        by_loc.setdefault(g["loc"], []).append(g)

    out = []
    for loc, at_loc in by_loc.items():
        offset = 1.1 if loc == "centroid" else 0.35
        for i, g in enumerate(at_loc):
            lat, lng = g["lat"], g["lng"]
            if len(at_loc) > 1:
                angle = 2 * math.pi * i / len(at_loc)
                lat_cos = max(math.cos(g["lat"] * DEG), 0.2)
                lat += offset * math.sin(angle)
                lng += offset * math.cos(angle) / lat_cos
            out.append((lat, lng, g["tool"], g["entries"]))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--width", type=int, default=2000, help="output width in px")
    ap.add_argument("--out", default="assets/wise-map.svg")
    ap.add_argument(
        "--extent",
        choices=("world", "data"),
        default="world",
        help="world (default): the whole globe, nothing cropped. data: the "
        "site's default framing, which trims outliers like the Pacific sites "
        "so the dense band fills the frame.",
    )
    ap.add_argument(
        "--aspect",
        help="force a canvas shape, e.g. 16:9, 4:3, 1:1. The sea colour fills "
        "the whole canvas and the map is centred in it, so the image sits "
        "edge-to-edge in a slide instead of leaving bars.",
    )
    args = ap.parse_args()

    countries = json.loads((DATA / "countries.json").read_text())
    world = load_js_global("data/world.js", "WISE_WORLD")
    borders = load_js_global("data/borders.js", "WISE_BORDERS")
    rep_iso3 = {f["id"] for f in borders["features"]}

    pts = []
    for c in countries:
        for e in c["entries"]:
            has = isinstance(e.get("lat"), (int, float)) and isinstance(e.get("lng"), (int, float))
            pts.append((e["lat"] if has else c["lat"], e["lng"] if has else c["lng"]))
    if args.extent == "world":
        # Antarctica is cut at -60: it carries no data, and including it to
        # the pole wastes a third of the canvas on empty ice.
        south, west, north, east = -60.0, -180.0, 84.0, 180.0
    else:
        south, west, north, east = percentile_bounds(pts)

    # Fit those bounds to the requested width, then lean in half a zoom step
    # like the site does, and derive the matching aspect for the viewport.
    x0, _ = eq_earth(0, west)
    x1, _ = eq_earth(0, east)
    _, ylo = eq_earth(south, 0)
    _, yhi = eq_earth(north, 0)
    # The site leans half a zoom step past the fit because its viewport is
    # taller than the data band needs; a standalone image has no such slack,
    # so fit the band fully and keep a small margin instead of cropping it.
    scale = args.width * 0.97 / (x1 - x0)
    height = round((yhi - ylo) * scale * 1.22)
    if args.aspect:
        w_ratio, h_ratio = (float(n) for n in re.split(r"[:/x]", args.aspect))
        height = round(args.width * h_ratio / w_ratio)
    cx, cy = (x0 + x1) / 2, (ylo + yhi) / 2

    def to_px(lat, lng):
        x, y = eq_earth(lat, lng)
        return ((x - cx) * scale + args.width / 2, (cy - y) * scale + height / 2)

    def path_for(geom):
        parts = []
        polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
        for poly in polys:
            for ring in poly:
                d = []
                for i, (lng, lat) in enumerate(ring):
                    px, py = to_px(lat, lng)
                    d.append(f"{'M' if i == 0 else 'L'}{px:.1f} {py:.1f}")
                parts.append("".join(d) + "Z")
        return "".join(parts)

    # Dot sizing mirrors radiusFor()/zoomScale(). Those are CSS pixels at the
    # size the map occupies in a browser, so scale them by how much wider this
    # export is than that — not by the projection scale, which would balloon
    # the dots at large output sizes.
    REFERENCE_MAP_PX = 1100  # roughly the map area on a desktop browser
    zoom = math.log2(scale * 2 * math.pi / 256)
    zoom_scale = min(1.0, 0.45 + (zoom - 2) * 0.18)
    dot_px = args.width / REFERENCE_MAP_PX

    out = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{args.width}" height="{height}" '
        f'viewBox="0 0 {args.width} {height}" font-family="Geist, sans-serif">',
        f'<rect width="{args.width}" height="{height}" fill="{SEA}"/>',
        f'<g stroke="{BORDER}" stroke-width="{max(0.4, scale * 0.0015):.2f}" stroke-linejoin="round">',
    ]
    for f in world["features"]:
        fill = REP_FILL if f["id"] in rep_iso3 else LAND
        opacity = ' fill-opacity="0.35"' if f["id"] in rep_iso3 else ""
        if f["id"] in rep_iso3:
            out.append(f'<path d="{path_for(f["geometry"])}" fill="{LAND}"/>')
        out.append(f'<path d="{path_for(f["geometry"])}" fill="{fill}"{opacity}/>')
    out.append("</g>")

    out.append('<g stroke="none">')
    for c in countries:
        for lat, lng, tool, entries in marker_groups(c):
            px, py = to_px(lat, lng)
            if not (-50 < px < args.width + 50 and -50 < py < height + 50):
                continue
            r = min(6 + math.sqrt(len(entries)) * 3, 20) * zoom_scale * dot_px
            color = TOOL_COLORS.get(tool, TEAL)
            status = aggregate_status(entries)
            if status == "completed":
                out.append(f'<circle cx="{px:.1f}" cy="{py:.1f}" r="{r:.1f}" fill="{color}"/>')
            elif status == "planned":
                out.append(f'<circle cx="{px:.1f}" cy="{py:.1f}" r="{r:.1f}" fill="{color}" fill-opacity="0.35"/>')
            else:
                out.append(f'<circle cx="{px:.1f}" cy="{py:.1f}" r="{r * 1.6:.1f}" fill="{color}" fill-opacity="0.3"/>')
                out.append(f'<circle cx="{px:.1f}" cy="{py:.1f}" r="{r * 0.75:.1f}" fill="{color}"/>')
    out.append("</g></svg>")

    dest = ROOT / args.out
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text("\n".join(out))
    kb = dest.stat().st_size // 1024
    print(f"Wrote {dest} — {args.width}x{height}, {kb} KB")


if __name__ == "__main__":
    main()
