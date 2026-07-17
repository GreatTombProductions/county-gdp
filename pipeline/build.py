#!/usr/bin/env python3
"""
County GDP by Industry — pipeline.

Downloads BEA CAGDP2 county-level GDP data (2001–2024) from apps.bea.gov,
aggregates by county × industry, and builds static-site shards:
  - letter-sharded county search index
  - MD5-keyed county detail shards (industry breakdown + yearly trends)
  - per-state county rankings by total GDP
  - proximity shards (county centroids from neighborhood-health)

~3,100 counties, 24 years, 15 industries. Single ZIP download (~15MB → 26MB CSV).
"""

from __future__ import annotations

import csv
import hashlib
import json
import math
import subprocess
import sys
import zipfile
from collections import defaultdict
from pathlib import Path

sys.stdout.reconfigure(line_buffering=True)

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent
RAW_DIR = Path("/tmp/bea-gdp")
SITE_DIR = PROJECT_DIR / "site"
DATA_DIR = SITE_DIR / "data"
DETAIL_DIR = DATA_DIR / "details"
SEARCH_DIR = DATA_DIR / "search"
STATE_DIR = DATA_DIR / "states"
PROX_DIR = DATA_DIR / "proximity"

ZIP_URL = "https://apps.bea.gov/regional/zip/CAGDP2.zip"
ZIP_PATH = RAW_DIR / "CAGDP2.zip"
CSV_NAME = "CAGDP2__ALL_AREAS_2001_2024.csv"

NUM_DETAIL_SHARDS = 256

STATE_NAMES = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas",
    "CA": "California", "CO": "Colorado", "CT": "Connecticut", "DE": "Delaware",
    "FL": "Florida", "GA": "Georgia", "HI": "Hawaii", "ID": "Idaho",
    "IL": "Illinois", "IN": "Indiana", "IA": "Iowa", "KS": "Kansas",
    "KY": "Kentucky", "LA": "Louisiana", "ME": "Maine", "MD": "Maryland",
    "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota",
    "MS": "Mississippi", "MO": "Missouri", "MT": "Montana", "NE": "Nebraska",
    "NV": "Nevada", "NH": "New Hampshire", "NJ": "New Jersey",
    "NM": "New Mexico", "NY": "New York", "NC": "North Carolina",
    "ND": "North Dakota", "OH": "Ohio", "OK": "Oklahoma", "OR": "Oregon",
    "PA": "Pennsylvania", "RI": "Rhode Island", "SC": "South Carolina",
    "SD": "South Dakota", "TN": "Tennessee", "TX": "Texas", "UT": "Utah",
    "VT": "Vermont", "VA": "Virginia", "WA": "Washington",
    "WV": "West Virginia", "WI": "Wisconsin", "WY": "Wyoming",
    "DC": "District of Columbia", "PR": "Puerto Rico",
}

# Industry codes we surface (main 2-digit NAICS categories + totals)
INDUSTRY_CODES = {
    "1": "All industry total",
    "2": "Private industries",
    "3": "Agriculture, forestry, fishing and hunting",
    "6": "Mining, quarrying, and oil and gas extraction",
    "10": "Utilities",
    "11": "Construction",
    "12": "Manufacturing",
    "34": "Wholesale trade",
    "35": "Retail trade",
    "36": "Transportation and warehousing",
    "45": "Information",
    "50": "Finance, insurance, real estate, rental, and leasing",
    "59": "Professional and business services",
    "68": "Educational services, health care, and social assistance",
    "75": "Arts, entertainment, recreation, accommodation, and food services",
    "82": "Other services (except government and government enterprises)",
    "83": "Government and government enterprises",
}

YEAR_COLS = [str(y) for y in range(2001, 2025)]


def md5_shard(key: str) -> str:
    return hashlib.md5(key.encode()).hexdigest()[:2]


def parse_dollars(val: str) -> int | None:
    """Parse a dollar value from CSV. Returns int (thousands of dollars) or None."""
    val = val.strip().strip('"')
    if not val or val in ("(NA)", "(D)", ""):
        return None
    try:
        return int(val)
    except ValueError:
        return None


def main():
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    for d in [DATA_DIR, DETAIL_DIR, SEARCH_DIR, STATE_DIR, PROX_DIR]:
        d.mkdir(parents=True, exist_ok=True)

    # ── Download ──
    if not ZIP_PATH.exists():
        print(f"Downloading BEA CAGDP2 from {ZIP_URL}...")
        subprocess.run(
            ["curl", "-sL", "-o", str(ZIP_PATH), ZIP_URL],
            check=True,
        )
    else:
        print(f"Using cached ZIP: {ZIP_PATH}")

    # ── Extract ──
    csv_path = RAW_DIR / CSV_NAME
    if not csv_path.exists():
        print("Extracting CSV from ZIP...")
        with zipfile.ZipFile(ZIP_PATH, "r") as zf:
            zf.extract(CSV_NAME, RAW_DIR)

    # ── Parse CSV, group by county FIPS × industry ──
    print("Parsing CSV (latin-1, 26MB)...")
    # Structure: counties[fips] = {"name": ..., "state_abbr": ..., "state_name": ...,
    #                                "industries": {industry_code: {year: value}}}
    counties = {}

    with open(csv_path, encoding="latin-1", newline="") as f:
        reader = csv.reader(f, skipinitialspace=True)
        header = next(reader)
        for row in reader:
            if len(row) < 30:
                continue

            fips = row[0]
            geo_name = row[1]
            line_code = row[4]
            desc = row[6]

            # Filter to county-level only (5-digit FIPS, not ending in "000")
            if not fips.isdigit() or len(fips) != 5:
                continue
            if fips == "00000" or fips.endswith("000"):
                continue

            # Only keep industries in our set
            if line_code not in INDUSTRY_CODES:
                continue

            # Initialize county entry
            if fips not in counties:
                # Parse county name and state from GeoName ("Autauga, AL" → "Autauga", "AL")
                parts = geo_name.rsplit(",", 1)
                county_name = parts[0].strip() if len(parts) > 1 else geo_name.strip()
                state_abbr = parts[1].strip() if len(parts) > 1 else ""
                state_name = STATE_NAMES.get(state_abbr, state_abbr)

                counties[fips] = {
                    "name": county_name,
                    "state": state_abbr,
                    "state_name": state_name,
                    "industries": {},
                }

            c = counties[fips]

            # Parse yearly values
            if line_code not in c["industries"]:
                c["industries"][line_code] = {}

            for i, year in enumerate(YEAR_COLS):
                col_idx = 8 + i  # Year columns start at index 8
                if col_idx < len(row):
                    val = parse_dollars(row[col_idx])
                    if val is not None:
                        c["industries"][line_code][year] = val

    print(f"Parsed: {len(counties)} counties")

    # ── Aggregate: compute per-county totals + industry breakdowns ──
    print("Computing aggregates...")
    county_list = []

    for fips, c in counties.items():
        ind = c["industries"]

        # Total GDP (line code 1)
        total_gdp = ind.get("1", {}).get("2024")
        total_gdp_2023 = ind.get("1", {}).get("2023")

        # YoY change
        yoy_change = None
        if total_gdp is not None and total_gdp_2023 is not None and total_gdp_2023 > 0:
            yoy_change = round((total_gdp - total_gdp_2023) / total_gdp_2023 * 100, 1)

        # Build industry breakdown for latest year (2024)
        industries = {}
        for code, label in INDUSTRY_CODES.items():
            if code in ind and "2024" in ind[code]:
                industries[code] = {
                    "label": label,
                    "value": ind[code]["2024"],
                }

        # Build yearly trend for all-industry total
        yearly = []
        if "1" in ind:
            for year in YEAR_COLS:
                val = ind["1"].get(year)
                if val is not None:
                    yearly.append({"year": int(year), "value": val})

        # Build per-industry yearly trends (for detail view)
        industry_yearly = {}
        for code in INDUSTRY_CODES:
            if code in ind:
                trend = []
                for year in YEAR_COLS:
                    val = ind[code].get(year)
                    if val is not None:
                        trend.append({"year": int(year), "value": val})
                if trend:
                    industry_yearly[code] = trend

        c["total_gdp"] = total_gdp
        c["yoy_change"] = yoy_change
        c["industries_2024"] = industries
        c["yearly"] = yearly
        c["industry_yearly"] = industry_yearly
        c["lat"] = None
        c["lon"] = None

        if total_gdp is not None:
            county_list.append((fips, c))

    # ── Load county centroids from neighborhood-health detail shards ──
    print("Loading county centroids from neighborhood-health...")
    nh_detail_dir = Path(
        "/home/ray/greattomb/0th-floor-exterior/east-mausoleum/"
        "projects/neighborhood-health/site/data/details"
    )
    if nh_detail_dir.exists():
        centroid_count = 0
        for shard_file in sorted(nh_detail_dir.glob("*.json")):
            with open(shard_file) as f:
                shard_data = json.load(f)
            for fid, data in shard_data.items():
                if fid in counties:
                    lat = data.get("lat")
                    lon = data.get("lon")
                    if lat is not None and lon is not None:
                        counties[fid]["lat"] = lat
                        counties[fid]["lon"] = lon
                        centroid_count += 1
        print(f"  Matched {centroid_count} centroids")
    else:
        print("  WARNING: neighborhood-health details not found — proximity search will be empty")

    # ── Compute national stats ──
    print("Computing national aggregates...")
    all_totals = sorted(
        [c["total_gdp"] for c in counties.values() if c["total_gdp"] is not None]
    )
    if all_totals:
        n = len(all_totals)
        mid = n // 2
        national_median = all_totals[mid] if n % 2 else (all_totals[mid - 1] + all_totals[mid]) // 2
        national_total = sum(all_totals)
    else:
        national_median = None
        national_total = 0

    # ── Build letter-sharded search indices ──
    print("Building search indices...")
    letter_bins = defaultdict(list)
    for fips, c in counties.items():
        name = c["name"]
        first = name[0].upper() if name else "?"
        if not first.isalpha():
            first = "?"
        letter_bins[first].append(fips)

    for letter, fips_list in letter_bins.items():
        entries = []
        for fips in fips_list:
            c = counties[fips]
            entries.append({
                "fips": fips,
                "name": c["name"],
                "state": c["state"],
                "total_gdp": c["total_gdp"],
                "yoy_change": c["yoy_change"],
            })
        entries.sort(key=lambda x: x["name"])
        out_path = SEARCH_DIR / f"{letter.lower()}.json"
        with open(out_path, "w") as f:
            json.dump({"letter": letter, "counties": entries}, f)

    # ── Build MD5 detail shards ──
    print("Building detail shards...")
    detail_shards = defaultdict(dict)
    for fips, c in counties.items():
        shard = md5_shard(fips)
        detail_shards[shard][fips] = {
            "name": c["name"],
            "state": c["state"],
            "state_name": c["state_name"],
            "total_gdp": c["total_gdp"],
            "yoy_change": c["yoy_change"],
            "industries": c["industries_2024"],
            "yearly": c["yearly"],
            "industry_yearly": c["industry_yearly"],
            "lat": c["lat"],
            "lon": c["lon"],
        }

    for shard_key, shard_data in detail_shards.items():
        out_path = DETAIL_DIR / f"{shard_key}.json"
        with open(out_path, "w") as f:
            json.dump(shard_data, f)

    print(f"  Built {len(detail_shards)} detail shards")

    # ── Build state browse ──
    print("Building state files...")
    state_bins = defaultdict(list)
    for fips, c in counties.items():
        state = c["state"]
        if state:
            state_bins[state].append(fips)

    for state, fips_list in state_bins.items():
        state_entries = []
        for fips in fips_list:
            c = counties[fips]
            state_entries.append({
                "fips": fips,
                "name": c["name"],
                "total_gdp": c["total_gdp"],
                "yoy_change": c["yoy_change"],
            })
        state_entries.sort(key=lambda x: x["total_gdp"] if x["total_gdp"] is not None else 0, reverse=True)
        out_path = STATE_DIR / f"{state.lower()}.json"
        state_name = STATE_NAMES.get(state, state)
        with open(out_path, "w") as f:
            json.dump({
                "state": state,
                "state_name": state_name,
                "counties": state_entries,
                "count": len(state_entries),
            }, f)

    # ── Build proximity shards ──
    print("Building proximity shards...")
    prox_bins = defaultdict(list)
    for fips, c in counties.items():
        state = c["state"]
        if state and c["lat"] is not None and c["lon"] is not None:
            prox_bins[state].append({
                "fips": fips,
                "name": c["name"],
                "lat": c["lat"],
                "lon": c["lon"],
                "total_gdp": c["total_gdp"],
            })

    for state, entries in prox_bins.items():
        out_path = PROX_DIR / f"{state.lower()}.json"
        with open(out_path, "w") as f:
            json.dump(entries, f)

    # ── Write meta.json ──
    print("Writing meta.json...")
    all_states = sorted(set(c["state"] for c in counties.values() if c["state"]))

    meta = {
        "name": "County GDP by Industry",
        "description": (
            "Gross Domestic Product by county and industry, 2001–2024. "
            "See what drives each county's economy — from manufacturing and agriculture "
            "to professional services and government. Compare industry mix between counties."
        ),
        "source": "U.S. Bureau of Economic Analysis (BEA)",
        "source_url": "https://www.bea.gov/data/gdp/gdp-county-metro-and-other-areas",
        "total_counties": len(counties),
        "total_states": len(all_states),
        "national_total_gdp": national_total,
        "national_median_gdp": national_median,
        "year_range": "2001–2024",
        "industries": len(INDUSTRY_CODES),
        "index_letters": sorted(letter_bins.keys()),
        "detail_shards": NUM_DETAIL_SHARDS,
        "unit": "thousands_of_dollars",
        "generated": __import__("datetime").datetime.now().isoformat(),
    }

    with open(DATA_DIR / "meta.json", "w") as f:
        json.dump(meta, f)

    # ── Summary ──
    print(f"\nDone. {len(counties)} counties across {len(all_states)} states.")
    print(f"  National total GDP (2024):  ${national_total:,.0f}K")
    print(f"  National median GDP (2024): ${national_median:,.0f}K")
    print(f"  Search indices:             {len(letter_bins)} letters")
    print(f"  Detail shards:              {len(detail_shards)}")
    print(f"  State files:                {len(state_bins)}")
    print(f"  Proximity:                  {len(prox_bins)} states")
    centroid_count = sum(1 for c in counties.values() if c["lat"] is not None)
    print(f"  With centroids:             {centroid_count}")


if __name__ == "__main__":
    main()
