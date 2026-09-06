"""Scrape 3x3 algorithm sets (ZBLL, F2L) from SpeedCubeDB.

The pages are fully server-rendered, so no browser/Playwright is needed:
each case is a <div class="row singlealgorithm" data-alg="ZBLL T 1">
containing one <div class="formatted-alg"> per algorithm.

Usage:
    python scrape_scdb.py            # scrape everything
    python scrape_scdb.py f2l        # scrape one set
"""

import json
import re
import sys
import time

import requests
from bs4 import BeautifulSoup

BASE = "https://speedcubedb.com/a/3x3/{}"
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    )
}

# name -> (url slugs, expected case count)
# ZBLL is split across seven pages, one per corner-orientation subset.
SETS = {
    "zbll": (["ZBLL" + s for s in ("T", "U", "L", "Pi", "H", "S", "AS")], 472),
    "f2l": (["F2L"], 41),
}


def clean(text):
    """Collapse the tabs/newlines SCDB pads its alg text with."""
    return " ".join(text.split())


def scrape_page(session, slug):
    """Return {case_name: record} for one SCDB page."""
    html = session.get(BASE.format(slug), headers=HEADERS, timeout=30).text
    soup = BeautifulSoup(html, "html.parser")

    cases = {}
    for row in soup.select("div.singlealgorithm[data-alg]"):
        name = row["data-alg"].strip()           # e.g. "ZBLL T 1" / "F2L 1"
        algs = []
        for node in row.select("div.formatted-alg"):
            alg = clean(node.get_text())
            if alg and alg not in algs:
                algs.append(alg)

        # Recognition metadata the site uses to render the cube image.
        gen = row.select_one("[data-stickering]")
        cases[name] = {
            "index": int(re.search(r"(\d+)$", name).group(1)),
            "subgroup": row.get("data-subgroup", ""),
            "algs": algs,
            "setup": gen.get("data-setup", "") if gen else "",
            "stickering": gen.get("data-stickering", "") if gen else "",
        }
    return cases


def scrape_set(session, name):
    slugs, expected = SETS[name]
    data = {}
    for slug in slugs:
        cases = scrape_page(session, slug)
        if len(slugs) > 1:
            # ZBLL: keep the per-subset nesting, tagging each case with it.
            subset = slug.replace("ZBLL", "")
            for case in cases.values():
                case["subset"] = subset
            data[subset] = cases
            label = subset
        else:
            data = cases
            label = name.upper()

        n_algs = sum(len(c["algs"]) for c in cases.values())
        empty = [k for k, c in cases.items() if not c["algs"]]
        print(f"  {label:>3}: {len(cases):>3} cases, {n_algs:>4} algs"
              + (f"  WARNING {len(empty)} empty: {empty[:5]}" if empty else ""))
        time.sleep(1)  # be polite

    total = (sum(len(v) for v in data.values()) if len(slugs) > 1 else len(data))
    out = f"{name}_algorithms.json"
    with open(out, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    print(f"  -> {total} cases saved to {out}")

    if total != expected:
        print(f"  Expected {expected} cases, got {total} -- check the site layout.",
              file=sys.stderr)
        return False
    return True


def main():
    wanted = sys.argv[1:] or list(SETS)
    unknown = [w for w in wanted if w not in SETS]
    if unknown:
        print(f"Unknown set(s): {unknown}. Choose from {list(SETS)}.",
              file=sys.stderr)
        return 2

    session = requests.Session()
    ok = True
    for name in wanted:
        print(f"{name.upper()}:")
        ok &= scrape_set(session, name)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
