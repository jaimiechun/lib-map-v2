"""
Normalizes the two raw WISE CSVs (site-level + national-level) into a single
per-country dataset consumed by the frontend map.

Run: python3 scripts/build_data.py
Re-run any time data/raw/site_data.csv or data/raw/national_data.csv change.
"""
import csv
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"

# Fixes typos and name variants found in the raw CSVs that don't match the
# canonical country names in data/country_centroids.json.
COUNTRY_ALIASES = {
    "afganistan": "Afghanistan",
    "colombua": "Colombia",
    "congo (brazzaville)": "Congo",
    "congo, drc": "DR Congo",
    "democratic republic of congo": "DR Congo",
    "democratic republic of the congo": "DR Congo",
    "democratic republic of the congo (drc)": "DR Congo",
    "india:": "India",
    "lao pdr": "Laos",
    "palestinian territories": "Palestine",
    "papau new guinea": "Papua New Guinea",
    "russian federation": "Russia",
    "sao tome and principe": "São Tomé and Príncipe",
    "timor leste": "Timor-Leste",
    "turkey": "Türkiye",
    "usa": "United States",
    "united states of america": "United States",
    "west bank and gaza": "Palestine",
}

STATUS_MAP = {
    "completed": "Completed",
    "planned": "Planned",
    "ongoing": "Ongoing",
}


def load_centroid_lookup():
    centroids = json.loads((ROOT / "data" / "country_centroids.json").read_text())
    by_name = {c["name"].lower(): c for c in centroids}
    return by_name


def resolve_country(raw_name, by_name):
    name = raw_name.strip()
    key = name.lower()
    key = COUNTRY_ALIASES.get(key, name).lower()
    return by_name.get(key)


def normalize_status(raw_status):
    return STATUS_MAP.get(raw_status.strip().lower(), raw_status.strip())


def extract_link(*fields):
    for f in fields:
        f = (f or "").strip()
        if f.lower().startswith("http"):
            return f
    return None


def extract_contact(*fields):
    for f in fields:
        f = (f or "").strip()
        if f.lower().startswith("mailto:"):
            return f[len("mailto:"):]
        if re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", f):
            return f
    return None


def load_site_rows(by_name):
    rows = []
    unmatched = set()
    with open(RAW / "site_data.csv", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            country = resolve_country(row["Country"], by_name)
            if not country:
                unmatched.add(row["Country"].strip())
                continue
            rows.append({
                "iso3": country["cca3"],
                "country": country["name"],
                "level": "site",
                "location": (row["Location"] or "").strip() or None,
                "lat": float(row["Latitude"]) if row["Latitude"].strip() else None,
                "lng": float(row["Longitude"]) if row["Longitude"].strip() else None,
                "tool": (row["Tool"] or "").strip() or None,
                "status": normalize_status(row["Status"]),
                "nationallyRepresentative": (row["Location"] or "").strip().lower() == "national",
                "source": None,
                "dates": (row["Data Collection Dates"] or "").strip() or None,
                "link": extract_link(row["More info"], row["Website"]),
                "contact": extract_contact(row["Email"], row["Website"], row["More info"]),
            })
    return rows, unmatched


def load_national_rows(by_name):
    rows = []
    unmatched = set()
    with open(RAW / "national_data.csv", encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            country = resolve_country(row["Country"], by_name)
            if not country:
                unmatched.add(row["Country"].strip())
                continue
            rows.append({
                "iso3": country["cca3"],
                "country": country["name"],
                "level": "national",
                "location": None,
                "lat": None,
                "lng": None,
                "tool": (row["Tool"] or "").strip() or None,
                "status": normalize_status(row["Status"]),
                "nationallyRepresentative": True,
                "source": (row["Source"] or "").strip() or None,
                "dates": (row["When collected"] or "").strip() or None,
                "link": extract_link(row["More info"]),
                "contact": None,
            })
    return rows, unmatched


def aggregate(entries_by_country, by_name):
    centroid_by_iso3 = {c["cca3"]: c for c in by_name.values()}
    countries = []
    for iso3, entries in sorted(entries_by_country.items()):
        centroid = centroid_by_iso3[iso3]
        statuses = {e["status"] for e in entries}
        if statuses <= {"Completed"}:
            status = "completed"
        elif statuses <= {"Planned"}:
            status = "planned"
        else:
            status = "mixed"
        countries.append({
            "iso3": iso3,
            "name": centroid["name"],
            "lat": centroid["lat"],
            "lng": centroid["lng"],
            "status": status,
            "nationallyRepresentative": any(e["nationallyRepresentative"] for e in entries),
            "entries": entries,
        })
    return countries


def main():
    by_name = load_centroid_lookup()

    site_rows, site_unmatched = load_site_rows(by_name)
    national_rows, national_unmatched = load_national_rows(by_name)

    entries_by_country = {}
    for row in site_rows + national_rows:
        iso3 = row.pop("iso3")
        row.pop("country", None)
        entries_by_country.setdefault(iso3, []).append(row)

    countries = aggregate(entries_by_country, by_name)

    out_path = ROOT / "data" / "countries.json"
    out_path.write_text(json.dumps(countries, indent=2, ensure_ascii=False))

    # Also emit a script version so index.html works when opened directly
    # from the filesystem (fetch() is blocked on file:// pages).
    js_path = ROOT / "data" / "countries.js"
    js_path.write_text(
        "window.WISE_COUNTRIES = "
        + json.dumps(countries, ensure_ascii=False)
        + ";\n"
    )

    total_entries = len(site_rows) + len(national_rows)
    print(f"Wrote {len(countries)} countries ({total_entries} entries) to {out_path} and {js_path}")
    unmatched = site_unmatched | national_unmatched
    if unmatched:
        print("WARNING: unmatched country names (add to COUNTRY_ALIASES):")
        for u in sorted(unmatched):
            print(f"  - {u!r}")
    else:
        print("All country names matched.")


if __name__ == "__main__":
    main()
