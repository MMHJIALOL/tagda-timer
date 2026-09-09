"""
Mirror gif.js into vendor/gifjs/, the same way mirror_cubing.py mirrors
cubing.js: pinned version, saved under vendor/ so the app never needs the
network to build a GIF.

gif.js is a plain UMD bundle (window.GIF) plus a worker script it spawns
by URL, so there is nothing to walk here — just the two files.

    python tools/mirror_gifjs.py
"""

import os
import urllib.request

VERSION = "0.2.0"
BASE = f"https://cdn.jsdelivr.net/npm/gif.js@{VERSION}/dist/"
FILES = ["gif.js", "gif.worker.js"]
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "vendor", "gifjs")


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "tagdatimer-mirror"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def main():
    os.makedirs(OUT, exist_ok=True)
    total = 0
    for name in FILES:
        data = fetch(BASE + name)
        path = os.path.join(OUT, name)
        with open(path, "wb") as f:
            f.write(data)
        total += len(data)
        print(f"  + {name}  ({len(data) // 1024} KB)")
    print(f"\nmirrored {len(FILES)} files, {total // 1024} KB -> vendor/gifjs/  (gif.js {VERSION})")


if __name__ == "__main__":
    main()
