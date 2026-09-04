#!/usr/bin/env python3
"""Build js/alglibrary-{oll,zbll,f2l}.js from the scraped SpeedCubeDB JSON.

    python tools/build-alglibrary.py

Run from the repository root. Rewrites the three generated set modules in
place; js/alglibrary-pll.js is hand-researched and is not touched.

The scrape is not usable as-is, and none of its problems are visible by reading
it -- each was found by executing the algorithms against a cube. The three
correction tables below record what had to change and why. They are data, not
guesses: every entry was produced by running the candidates through the app's
own simulator via tools/verify-alglibrary.html, which is also what gates the
result. After running this, open that page; it must say PASS.

See ALGLIBRARY.md sections 3.4 and 7.1 for the full account.
"""
import io
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOKEN = re.compile(r"^(\d*)([URFDLBurfdlbMESxyz])(w?)([2']*)$")

# ---------------------------------------------------------------- corrections

# OLL rows that are the case's *setup* rather than its solution -- the moves
# that create the case, not the ones that solve it. Caught because each one
# oriented some other OLL case instead of its own; inverting all 50 made every
# one solve the case it is filed under. Keyed by (case number, cleaned alg).
OLL_INVERT = {
    (1, "F R' F' R U2' F R' F' R2' U2' R'"),
    (3, "F U R U' R' F' U f U R U' R' f' y"),
    (4, "F U R U' R' F' U' f U R U' R' f' y"),
    (5, "r' U' R U' R' U2' r"),
    (6, "r U R' U R U2' r'"),
    (7, "r U2' R' U' R U' r'"),
    (8, "r' U2' R U R' U r y2'"),
    (9, "F U R U' R2' F' R U R U' R' y'"),
    (10, "R U2' R' F R' F' R U' R U' R'"),
    (11, "M U' R U2' R' U' R U' R2' r"),
    (12, "F U R U' R' F' U' F U R U' R' F'"),
    (13, "F' U' F r U' r' U r U r'"),
    (14, "F U F' R' F R U' R' F' R"),
    (15, "r' U' r U' R' U R r' U r"),
    (16, "r U r' U R U' R' r U' r'"),
    (17, "F R' F' R U2' F R' F' R U' R U' R'"),
    (18, "r' U2' R U R' U r2' U2' R' U' R U' r'"),
    (19, "F R' F' R M U R U' R' U' M'"),
    (23, "R U2' R D R' U2' R D' R2'"),
    (24, "F R' F' r U R U' r'"),
    (25, "R' F' r U R U' r' F y'"),
    (26, "R U R' U R U2' R' y'"),
    (27, "R U2' R' U' R U' R'"),
    (28, "R U R' U' M' U R U' r'"),
    (29, "M F R' F' R U R U' R' U' M'"),
    (30, "F U R U2' R' U R U2' R' U' F' y2'"),
    (31, "R' F R U R' U' F' U R"),
    (32, "f R' F' R U R U' R' S'"),
    (33, "F R' F' R U R U' R'"),
    (34, "F U R' U' R' F' R U R2' U' R' y2'"),
    (35, "R U2' R' F R' F' R2' U2' R'"),
    (36, "F' L F L' U' L' U' L U L' U L y2'"),
    (37, "F R U' R' U R U R' F'"),
    (38, "F R' F' R U R U R' U' R U' R'"),
    (39, "L U F' U' L' U L F L' y'"),
    (40, "R' U' F U R U' R' F' R y'"),
    (41, "F U R U' R' F' R U2' R' U' R U' R' y2'"),
    (42, "F U R U' R' F' R' U2' R U R' U R"),
    (43, "f' U' L' U L f"),
    (44, "f U R U' R' f'"),
    (45, "F U R U' R' F'"),
    (46, "R' U' F R' F' R U R"),
    (47, "F' U' L' U L U' L' U L F"),
    (48, "F U R U' R' U R U' R' F'"),
    (49, "r' U r2' U' r2' U' r2' U r' y2'"),
    (50, "r U' r2' U r2' U r2' U' r"),
    (51, "f U R U' R' U R U' R' f'"),
    (55, "F R' F' U2' R U R' U R2' U2' R'"),
    (56, "r U r' R U R' U' R U R' U' r U' r'"),
    (57, "r U R' U' M U R U' R'"),
}

# Three ZBLL algs written from a different recognition angle than the case is
# drawn at. With this rotation in front, each solves the case it is filed under;
# storing the rotation as part of the algorithm is what makes the listed moves
# true for the listed picture.
ZBLL_ROT = {
    ("ZBLL-S-1", "R U R' U R U2 R' l' U R' D2 R U' R' D2 R2"): "y",
    ("ZBLL-S-28", "z U R2 U F U' R' U' R U F' R2 U'"): "y2",
    ("ZBLL-S-35", "y2 z U2 R U R U' R' U' R' D' U' R U' R' D"): "y'",
}

# The canonical alg is index 0, and for F2L it decides the picture: the case
# state is that alg run backwards, so a left-slot variant leaves the pair in the
# front-left slot, where the three-quarter view can show only two of its five
# stickers. These three shipped that way and rendered as identical grey cubes.
# Each value is the first alternate in that case's list leaving both pieces in
# the U layer or the front-right slot.
F2L_CANONICAL = {
    13: "M' U' R U R' U2 R U' r'",
    18: "F' U2 F U F' U' F",
    20: "U' R U' R2 F R F' R U' R'",
}

# ---------------------------------------------------------------- helpers


def clean(alg):
    """Strip SpeedCubeDB's finger-trick parentheses; collapse whitespace."""
    return " ".join(alg.replace("(", " ").replace(")", " ").split())


def parses(alg):
    toks = alg.split()
    return bool(toks) and all(TOKEN.match(t) for t in toks)


def invert(alg):
    """Same semantics as invert() in js/util.js."""
    out = []
    for m in reversed(alg.split()):
        out.append(m[:-1] if m.endswith("'") else m if m.endswith("2") else m + "'")
    return " ".join(out)


def js(s):
    assert '"' not in s, s
    return '"%s"' % s


def load(name):
    with io.open(os.path.join(ROOT, name), encoding="utf-8") as fh:
        return json.load(fh)


def write(name, text):
    with io.open(os.path.join(ROOT, name), "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)


def alternates(algs, dropped, invert_key=None, rot_key=None):
    """Cleaned, corrected, de-duplicated, original order preserved."""
    seen, keep = set(), []
    for raw in algs:
        a = clean(raw)
        if not parses(a):
            dropped.append(a)
            continue
        if invert_key and (invert_key, a) in OLL_INVERT:
            a = invert(a)
        rot = ZBLL_ROT.get((rot_key, a)) if rot_key else None
        if rot:
            a = rot + " " + a
        if a not in seen:
            seen.add(a)
            keep.append(a)
    return keep


def rows(algs, notes_for=None):
    out = []
    for a in algs:
        note = notes_for(a) if notes_for else ""
        out.append('    { alg: %s, moveCount: %d%s },' % (js(a), len(a.split()), note))
    return "\n".join(out)


# ---------------------------------------------------------------- OLL

def build_oll():
    data = load("oll_algorithms.json")
    with io.open(os.path.join(ROOT, "js", "algs.js"), encoding="utf-8") as fh:
        src = fh.read()
    defaults = {}
    for m in re.finditer(r"O\(\s*(\d+),\s*'[^']*',\s*'[^']*',\s*\"([^\"]+)\"\s*\)", src):
        defaults[int(m.group(1))] = " ".join(m.group(2).split())

    dropped, body, total = [], [], 0
    for n in range(1, 58):
        keep = alternates(data["OLL %d" % n], dropped, invert_key=n)
        total += len(keep)
        note = lambda a, n=n: (', notes: "this app\'s own default for the case"'
                               if a == defaults.get(n) else "")
        body.append("  OLL%d: { alternates: [\n%s\n  ] }," % (n, rows(keep, note)))

    write("js/alglibrary-oll.js", HEAD_OLL + "\n".join(body) + "\n};\n")
    print("OLL  : 57 cases, %d algs, %d unparseable dropped" % (total, len(dropped)))


# ---------------------------------------------------------------- ZBLL

SUBSETS = ["T", "U", "L", "Pi", "H", "S", "AS"]


def build_zbll():
    data = load("zbll_algorithms.json")
    dropped, cases, lib, total = [], [], [], 0
    for sub in SUBSETS:
        for _, c in sorted(data[sub].items(), key=lambda kv: kv[1]["index"]):
            cid = "ZBLL-%s-%d" % (sub, c["index"])
            keep = alternates(c["algs"], dropped, rot_key=cid)
            if not keep:
                continue
            total += len(keep)
            cases.append('  { id: %s, name: %s, subset: %s, group: %s, alg: %s },' % (
                js(cid), js("%s %d" % (sub, c["index"])), js(sub), js(c["subgroup"]), js(keep[0])))
            lib.append("  %s: { alternates: [\n%s\n  ] }," % (js(cid), rows(keep)))

    write("js/alglibrary-zbll.js", HEAD_ZBLL + "\n".join(cases) + "\n];\n\n"
          "export const ZBLL_LIBRARY = {\n" + "\n".join(lib) + "\n};\n" + TAIL_ZBLL)
    print("ZBLL : %d cases, %d algs, %d unparseable dropped" % (len(cases), total, len(dropped)))


# ---------------------------------------------------------------- F2L

F2L_GROUPS = ["Free Pairs", "Disconnected Pairs", "Connected Pairs",
              "Corner In Slot", "Edge In Slot", "Pieces In Slot"]


def build_f2l():
    data = load("f2l_algorithms.json")
    dropped, cases, lib, total = [], [], [], 0
    for i in range(1, 42):
        c = data["F2L %d" % i]
        keep = alternates(c["algs"], dropped)
        if not keep:
            continue
        first = F2L_CANONICAL.get(i)
        if first:
            assert first in keep, "F2L %d: canonical override missing from the list" % i
            keep.remove(first)
            keep.insert(0, first)
        total += len(keep)
        cases.append('  { id: "F2L%d", name: "%d", group: %s, alg: %s },'
                     % (i, i, js(c["subgroup"]), js(keep[0])))
        lib.append("  F2L%d: { alternates: [\n%s\n  ] }," % (i, rows(keep)))

    write("js/alglibrary-f2l.js", HEAD_F2L + "\n".join(cases) + "\n];\n\n"
          "export const F2L_LIBRARY = {\n" + "\n".join(lib) + "\n};\n" + TAIL_F2L)
    print("F2L  : %d cases, %d algs, %d unparseable dropped" % (len(cases), total, len(dropped)))


# ---------------------------------------------------------------- file headers

HEAD_OLL = '''/* ===========================================================
   Tagda Timer — OLL algorithm library: all 57 cases.

   GENERATED by tools/build-alglibrary.py. Do not hand-edit; corrections
   belong in that script's tables, where they are explained.

   Scraped from SpeedCubeDB, which orders the variants of a case by how
   many of its users actually drill each one, and kept in that order —
   index 0 is the one most people reach for, not the one with the fewest
   moves.

   Two things had to be corrected on the way in, and both were found by
   executing the data rather than by reading it: finger-trick parentheses
   that are not move notation, and 50 rows that were the inverse of an
   algorithm — the moves that create the case, not the ones that solve
   it. ALGLIBRARY.md §3.4 has the detail.

   Nothing here is trusted because a website printed it:
   tools/verify-alglibrary.html executes every entry against its own case.

   `notes` appears only where there is something true to say. The pass did
   not invent a rationale for each algorithm — a plausible-sounding
   fabricated reason on 185 entries is worse than no reason at all.
   =========================================================== */

export const OLL_LIBRARY = {
'''

HEAD_ZBLL = '''/* ===========================================================
   Tagda Timer — ZBLL: 472 cases, the whole last layer in one alg.

   GENERATED by tools/build-alglibrary.py. Do not hand-edit.

   Loaded on demand, never at startup. This file is an order of
   magnitude bigger than every other alg list in the app put together,
   and js/main.js imports alglibrary.js on the timer's boot path — a
   static import here would put ~470 cases of data in front of the
   first scramble of every session, for a page most sessions never open.
   alglibrary.js pulls it in with a dynamic import when the ZBLL tab is
   first shown.

   Unlike PLL and OLL, these cases are not in algs.js — the trainer has
   no ZBLL mode — so the set carries its own case list. A case's
   canonical alg is the first alternate, which is also what the case
   picture is drawn from.

   Subsets are the seven corner-orientation families (T, U, L, Pi, H, S,
   AS) and `group` is the finer split inside one — 472 cases is not a
   list anybody scrolls, so the page navigates by these.
   =========================================================== */

export const ZBLL_CASES = [
'''

TAIL_ZBLL = '''
export const SET = {
  id: 'ZBLL',
  label: 'ZBLL',
  title: 'Last layer in one algorithm, edges already oriented',
  cases: ZBLL_CASES,
  library: ZBLL_LIBRARY,
  /* 472 cards in one scroll is not navigation. The tab opens on T and you
     pick a subset, which is how every ZBLL sheet is organised too. */
  groups: [%s],
  groupOf: (c) => c.subset,
  defaultGroup: 'T',
  caseLabel: (c) => 'ZBLL ' + c.name,
  describe: (c) => c.subset + ' subset \\u00b7 corner group ' + c.group,
};
''' % ", ".join("'%s'" % s for s in SUBSETS)

HEAD_F2L = '''/* ===========================================================
   Tagda Timer — F2L: 41 cases, 10-16 algs each.

   GENERATED by tools/build-alglibrary.py. Do not hand-edit.

   Lazy-loaded for the same reason as ZBLL (see that file's header):
   alglibrary.js is on the timer's boot path and this is not.

   F2L is the odd set here and the page has to treat it differently in
   two ways:

     • It is not a last-layer set. The case is a corner and an edge
       waiting to go into the front-right slot, so the picture cannot be
       the U face and four side strips that PLL/OLL/ZBLL share — it is
       the cube in three-quarter view, last layer greyed out, with the
       built first two layers solid so the empty slot reads as a notch.

     • The case number is not how F2L is taught. You recognise the state
       of the pair first (is it split? is a piece already in the slot?)
       and the case second, so `group` is the six-way split
       SpeedCubeDB uses and the page navigates by it.

   Between 10 and 16 algs per case, far more than OLL's handful, because
   each case has slot-and-angle variants: y/y'/d rotations, L-side
   mirrors, slice alternatives. They are all real and all verified.
   =========================================================== */

export const F2L_CASES = [
'''

TAIL_F2L = '''
export const SET = {
  id: 'F2L',
  label: 'F2L',
  title: 'Pairing a corner and edge into the front-right slot',
  cases: F2L_CASES,
  library: F2L_LIBRARY,
  groups: [%s],
  groupOf: (c) => c.group,
  defaultGroup: null,
  caseLabel: (c) => 'F2L ' + c.name,
  describe: (c) => c.group.toLowerCase(),
};
''' % ", ".join("'%s'" % g for g in F2L_GROUPS)


if __name__ == "__main__":
    build_oll()
    build_zbll()
    build_f2l()
    print("\nNow open tools/verify-alglibrary.html — it must say PASS.", file=sys.stderr)
