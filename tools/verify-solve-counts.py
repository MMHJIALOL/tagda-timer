"""
Session counts and heatmap times read from the indexes (Solves.countsBySession,
Solves.createdTimes) must match what the old full read (Solves.all) gives,
including rows that only exist in the recovery journal.

    python serve.py 5199 --no-browser
    python tools/verify-solve-counts.py http://localhost:5199 [--browser firefox]
"""

import sys

from playwright.sync_api import sync_playwright

URL = (sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("-") else "http://localhost:5199").rstrip("/")
BROWSER = "firefox" if "--browser" in sys.argv and sys.argv[sys.argv.index("--browser") + 1] == "firefox" else "chromium"

SEED = """
async () => {
  const db = await import('/js/db.js');
  const now = Date.now(), day = 86400000, list = [];
  for (let i = 0; i < 2500; i++) list.push({ id: 'c' + i, sessionId: 's' + (i % 7), event: '333',
    timeMs: 9000 + i, penalty: null, createdAt: now - i * 3 * 3600000, scramble: 'R U' });
  // Two solves with the same timestamp, so the journal has to drop the right one.
  list.push({ id: 'twin', sessionId: 's1', event: '333', timeMs: 1, penalty: null, createdAt: list[5].createdAt, scramble: '' });
  await db.Solves.putMany(list);
  // The journal: an edit that moves a solve to another session, a delete,
  // a solve that never reached the DB, and a delete of one that never did.
  localStorage.setItem('tagda:unsaved', JSON.stringify([
    { store: 'solves', id: 'c3', value: { ...list[3], sessionId: 's6', createdAt: now - 400 * day } },
    { store: 'solves', id: 'c10', value: null },
    { store: 'solves', id: 'fresh', value: { id: 'fresh', sessionId: 'new', event: '333', timeMs: 1, createdAt: now } },
    { store: 'solves', id: 'ghost', value: null },
    { store: 'solves', id: 'twin', value: null },
  ]));
  return list.length;
}
"""

CHECK = """
async () => {
  const db = await import('/js/db.js');
  const all = await db.Solves.all();
  const want = new Map();
  for (const s of all) want.set(s.sessionId, (want.get(s.sessionId) || 0) + 1);
  const got = await db.Solves.countsBySession();
  const since = Date.now() - 395 * 86400000;
  const wantTimes = all.map(s => s.createdAt).filter(t => t >= since).sort((a, b) => a - b);
  const gotTimes = await db.Solves.createdTimes(since);
  return {
    unsaved: db.getLocalStatus().unsaved,
    want: [...want].sort(), got: [...got].filter(([, n]) => n).sort(),
    timesOk: JSON.stringify(wantTimes) === JSON.stringify(gotTimes),
    times: [wantTimes.length, gotTimes.length],
  };
}
"""

with sync_playwright() as p:
    b = getattr(p, BROWSER).launch()
    page = b.new_page()
    page.goto(URL + "/README.md")
    print("seeded", page.evaluate(SEED))
    page.reload()  # db.js reads the journal when it loads
    r = page.evaluate(CHECK)
    b.close()

print("journal rows:", r["unsaved"])
print("counts:", r["got"])
print("heatmap times:", r["times"])
ok = r["want"] == r["got"] and r["timesOk"] and r["unsaved"] == 5
if r["want"] != r["got"]:
    print("MISMATCH, full read gives", r["want"])
print("PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
