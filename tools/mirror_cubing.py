"""
Mirror the parts of cubing.js that TagDaTimer uses into vendor/cubing/.

cubing.js is served as ES modules that import further chunks and .wasm files at
runtime. This walks those imports from the two entry points we need and saves
everything under the same relative paths, so the app can run with no network.

    python tools/mirror_cubing.py
"""

import os
import re
import sys
import urllib.request
from urllib.parse import urljoin

BASE = "https://cdn.cubing.net/v0/js/"
ENTRIES = ["cubing/scramble", "cubing/twisty"]
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "vendor", "cubing")

# import "x" / from "x" / import("x") / new URL("x", import.meta.url)
PATTERNS = [
    # static import / export ... from "x"
    re.compile(r"""(?<![\w.$])(?:import|export)\s*[\w{},*\s]*?\s*from\s*["']([^"']+)["']"""),
    # dynamic import("x") — may follow &&, ?, (, = etc.
    re.compile(r"""(?<![\w.$])import\s*\(\s*["']([^"']+)["']\s*\)"""),
    # bare side-effect import "x"
    re.compile(r"""(?<![\w.$])import\s*["']([^"']+)["']"""),
    # new URL("x", import.meta.url) — how workers are located
    re.compile(r"""new\s+URL\s*\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)"""),
    # any relative asset reference we might otherwise miss
    re.compile(r"""["'](\.{1,2}/[\w./-]+\.(?:wasm|js|json))["']"""),
]

# strings that look like modules but are not actually served
SKIP = ("search-worker-entry.js",)

seen = set()
queue = []
count = {"files": 0, "bytes": 0}


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "tagdatimer-mirror"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read(), r.headers.get("Content-Type", "")


def local_path(url):
    rel = url[len(BASE):]
    if rel.endswith("/"):
        rel += "index.js"
    # a bare entry like "cubing/scramble" is served as JS
    if not os.path.splitext(rel)[1]:
        rel += ".js"
    return os.path.join(OUT, *rel.split("/"))


def walk(url):
    if url in seen or not url.startswith(BASE):
        return
    seen.add(url)
    try:
        data, ctype = fetch(url)
    except Exception as e:  # noqa: BLE001
        print(f"  ! {url} -> {e}")
        return

    path = local_path(url)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)
    count["files"] += 1
    count["bytes"] += len(data)
    print(f"  + {url[len(BASE):]}  ({len(data) // 1024} KB)")

    if "javascript" not in ctype and not url.endswith(".js"):
        return

    text = data.decode("utf-8", "replace")
    for pat in PATTERNS:
        for spec in pat.findall(text):
            if spec.startswith(("http://", "https://", "data:", "node:")):
                continue
            if any(spec.endswith(s) for s in SKIP):
                continue
            child = urljoin(url, spec)
            if child.startswith(BASE) and child not in seen:
                queue.append(child)


def main():
    for e in ENTRIES:
        queue.append(BASE + e)
    while queue:
        walk(queue.pop(0))
    print(f"\nmirrored {count['files']} files, {count['bytes'] // 1024} KB -> vendor/cubing/")
    if count["files"] == 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
