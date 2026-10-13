"""
Memory baseline for RAM-OPTIMISATION-PLAN.md (step 0).

Seeds a profile through js/db.js, boots the timer and records memory at the
moments the plan cares about. Run it against the tree you want to measure:

    python serve.py 5199 --no-browser
    python tools/ram-measure.py http://localhost:5199 --browser chrome --solves 20000

Two numbers per moment:
  private  - private bytes of every browser process this run started (what
             Task Manager's "Memory" column adds up to). Works in both browsers.
  js heap  - Chrome only, after a forced GC (CDP JSHeapUsedSize). The steadier
             of the two for spotting a list that is kept alive.

Firefox can't be made to GC from here, so its numbers are noisier: compare
runs, not single readings. Live Firebase hosts are blocked (requests and
websockets) and the page loads with ?emu=1, so nothing reaches the real
database.
"""

import argparse
import json
import os
import shutil
import tempfile
import sys
import time

import psutil
from playwright.sync_api import sync_playwright

LIVE_HOSTS = ("firebaseio.com", "firebaseapp.com", "identitytoolkit.googleapis.com",
              "securetoken.googleapis.com", "firebasedatabase.app")

SEED_JS = """
async ({ solves, sessions, settings }) => {
  const db = await import('/js/db.js');
  const events = ['333', '222', '444', 'pyram', 'skewb'];
  const day = 86400000, now = Date.now();
  const list = [];
  for (let i = 0; i < sessions; i++) {
    list.push({ id: 'ram-s' + i, name: 'RAM ' + i, event: events[i % events.length],
      createdAt: now - (sessions - i) * day, order: i });
  }
  for (const s of list) await db.Sessions.put(s);
  const scr = "R U R' U' F2 D' L2 B2 U' R2 F' L D2 R' B U2 F2 L' D R";
  let batch = [];
  for (let i = 0; i < solves; i++) {
    const s = list[i % list.length];
    batch.push({ id: 'ram-' + i, sessionId: s.id, event: s.event, mode: 'random', scramble: scr,
      caseId: null, caseName: null, cubeId: null, timeMs: 8000 + (i * 7919) % 9000,
      penalty: i % 41 === 0 ? 'DNF' : i % 23 === 0 ? '+2' : null, inspectionMs: 6000,
      comment: '', createdAt: now - Math.floor((solves - i) * (500 * day / solves)) });
    if (batch.length === 1000) { await db.Solves.putMany(batch); batch = []; }
  }
  if (batch.length) await db.Solves.putMany(batch);
  await db.KV.set('settings', { sessionId: list[0].id, event: list[0].event, ...settings });
  return db.Solves.count();
}
"""


def browser_pids():
    """Every process descended from this Python process (driver + browser)."""
    me = psutil.Process(os.getpid())
    return [p for p in me.children(recursive=True)]


def private_mb():
    total = 0
    for p in browser_pids():
        try:
            mi = p.memory_info()
            total += getattr(mi, "private", 0) or mi.rss
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
    return round(total / 2**20, 1)


class Meter:
    def __init__(self, page, kind):
        self.page, self.kind, self.cdp = page, kind, None
        if kind == "chrome":
            self.cdp = page.context.new_cdp_session(page)
            self.cdp.send("Performance.enable")

    def peak(self, ms):
        """Highest JS heap seen while the page boots, sampled without forcing a
        GC: a list built once and dropped never shows at idle, only here."""
        if not self.cdp:
            self.page.wait_for_timeout(ms)
            return None
        top, end = 0, time.time() + ms / 1000
        while time.time() < end:
            m = {x["name"]: x["value"] for x in self.cdp.send("Performance.getMetrics")["metrics"]}
            top = max(top, m.get("JSHeapUsedSize", 0))
            self.page.wait_for_timeout(50)
        return round(top / 2**20, 1)

    def read(self):
        js = None
        if self.cdp:
            self.cdp.send("HeapProfiler.collectGarbage")
            m = {x["name"]: x["value"] for x in self.cdp.send("Performance.getMetrics")["metrics"]}
            js = round(m["JSHeapUsedSize"] / 2**20, 1)
        dom = self.page.evaluate("document.getElementsByTagName('*').length")
        twisty = self.page.evaluate("document.querySelectorAll('twisty-player').length")
        return {"private_mb": private_mb(), "js_heap_mb": js, "dom": dom, "twisty": twisty}


def guard(ctx, blocked):
    def is_live(url):
        host = url.split("/")[2] if "://" in url else ""
        return any(host.endswith(h) for h in LIVE_HOSTS)

    def on_route(route):
        if is_live(route.request.url):
            blocked.append(route.request.url)
            return route.abort()
        return route.continue_()

    ctx.route("**/*", on_route)
    ctx.route_web_socket(lambda u: is_live(u), lambda ws: (blocked.append(ws.url), ws.close()))


def solve_once(page):
    page.keyboard.down("Space"); page.wait_for_timeout(700); page.keyboard.up("Space")
    page.wait_for_timeout(900)
    page.keyboard.down("Space"); page.keyboard.up("Space")
    page.wait_for_timeout(500)


def settle(page, ms):
    page.wait_for_timeout(ms)


def tap(page, sel):
    """Click by event, not by pointer: the launch cards and toasts that come and
    go over the topbar would otherwise swallow a real click now and then."""
    page.locator(sel).first.dispatch_event("click")


def open_settings_chip(page, label):
    tap(page, "#btn-settings")
    page.get_by_text(label, exact=True).first.dispatch_event("click")
    page.wait_for_timeout(300)
    tap(page, "#drawer-close")


def run(args):
    out = {"browser": args.browser, "solves": args.solves, "url": args.url, "at": time.strftime("%Y-%m-%d %H:%M"), "rows": []}
    blocked = []
    with sync_playwright() as p:
        # A profile on disk, not Playwright's default throwaway context: that one
        # keeps IndexedDB in memory, which counts every stored solve as RAM.
        profile = tempfile.mkdtemp(prefix="ram-measure-")
        launch = p.chromium.launch_persistent_context if args.browser == "chrome" else p.firefox.launch_persistent_context
        ctx = launch(profile, **({"channel": "chrome"} if args.browser == "chrome" else {}), headless=not args.headed,
                     viewport={"width": 1400, "height": 900}, service_workers="block")
        guard(ctx, blocked)
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.goto(args.url + "/README.md")
        n = page.evaluate(SEED_JS, {"solves": args.solves, "sessions": args.sessions,
                                    "settings": {"showCube": not args.cube_off}})
        print(f"seeded {n} solves", file=sys.stderr)

        meter = Meter(page, args.browser)
        page.goto(args.url + "/index.html?emu=1", wait_until="commit")
        out["boot_peak_js_mb"] = meter.peak(8000)
        page.wait_for_function("window.__tdtBooted === true", timeout=60000)

        def row(name):
            r = {"moment": name, **meter.read()}
            out["rows"].append(r)
            print(json.dumps(r), file=sys.stderr)

        settle(page, args.idle * 1000); row(f"fresh load, idle {args.idle} s")

        page.mouse.click(700, 600)  # focus the page, not the address bar
        for _ in range(20):
            solve_once(page)
        settle(page, 3000); row("after 20 solves")

        tap(page, "#btn-stats"); settle(page, 3000); row("stats panel (current session)")
        page.select_option("select[aria-label='Statistics session']", "")
        page.wait_for_function("!document.querySelector('.stats-filters [role=status]')?.textContent", timeout=60000)
        settle(page, 3000); row("stats panel (all sessions)")
        tap(page, "#drawer-close"); settle(page, 5000); row("stats panel closed")

        if not args.skip_vcube:
            open_settings_chip(page, "Virtual cube"); settle(page, 5000); row("virtual cube on")
            open_settings_chip(page, "Keyboard"); settle(page, 5000); row("virtual cube off")

        ctx.close()
        shutil.rmtree(profile, ignore_errors=True)
    leaks = [u for u in blocked if "config.json" not in u and "announcements.json" not in u]
    out["blocked_live"] = len(blocked)
    if leaks:
        print("BLOCKED LIVE REQUESTS:", leaks[:5], file=sys.stderr)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("url", nargs="?", default="http://localhost:5199")
    ap.add_argument("--browser", choices=["chrome", "firefox"], default="chrome")
    ap.add_argument("--solves", type=int, default=200)
    ap.add_argument("--sessions", type=int, default=12)
    ap.add_argument("--idle", type=int, default=30)
    ap.add_argument("--cube-off", action="store_true", help="seed showCube: false")
    ap.add_argument("--skip-vcube", action="store_true")
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--json", help="append the run to this JSON-lines file")
    args = ap.parse_args()
    args.url = args.url.rstrip("/")
    out = run(args)
    print(f"\n{out['browser']}, {out['solves']} solves ({out['at']}), JS heap peak during boot: {out['boot_peak_js_mb']} MB")
    print("| Moment | Private MB | JS heap MB | DOM nodes | twisty-players |")
    print("|---|---|---|---|---|")
    for r in out["rows"]:
        print(f"| {r['moment']} | {r['private_mb']} | {r['js_heap_mb'] if r['js_heap_mb'] is not None else '–'} | {r['dom']} | {r['twisty']} |")
    if args.json:
        with open(args.json, "a", encoding="utf-8") as f:
            f.write(json.dumps(out) + "\n")


if __name__ == "__main__":
    main()
