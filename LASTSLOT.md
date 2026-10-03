# Last slot — ZBLS, VHLS and Summer Variation

> Three last-slot sets for the 3x3, in the alg library (`algs.html`) and as
> trainer modes on the timer: **ZBLS** (all 302 cases), **VHLS** (its 32-case
> starter subset) and **Summer Variation** (27 cases). Every case was rebuilt
> from its algorithms on the timer's own cube model, every algorithm was
> executed against the case it is filed under, and no case lists the same
> algorithm twice — not even spelt with a rotation.

**Status: shipped.** Regenerate with `node tools/import-lastslot.mjs <folder>`
(§3); check with `node tools/verify-alglibrary.mjs` (§10).

---

## 0. TL;DR

| Set | What it does | Cases | Algorithms | Grouped by | Trainer mode |
|---|---|---|---|---|---|
| ZBLS | insert the last pair **and** orient the last-layer edges | 302 | 643 | F2L case (`F2L 1` … `F2L 41`) | `zbls` |
| VHLS | the same, for a pair that is already made or one move away | 32 | 64 | F2L case (`F2L 1` … `F2L 4`) | `vhls` |
| SV | insert an `R U' R'` pair **and** orient the corners (edges already oriented) | 27 | 63 | corners already facing up (`3 Oriented` … `0 Oriented`) | `sv` |

- They sit in a new **Last slot** tab group next to WV: CFOP · **Last slot (WV,
  SV, VHLS, ZBLS)** · Advanced (COLL, OLLCP, ZBLL) · Roux.
- ZBLS cases are named `ZBLS <F2L case>-<edge case>`. The F2L number is the
  timer's own F2L numbering, and the importer proves it (§4.4): `ZBLS 12-3` is
  F2L 12 with the third edge-orientation case on top. VHLS uses the same names
  (`VHLS 3-5` is `ZBLS 3-5`), so moving on from VHLS to ZBLS loses nothing.
- **"The same algorithm" means the same turns of the same layers**, however the
  cube is held: `y L' U' L` is `F' U' F`, `d' F R U R' F'` is `U' R B U B' R'`.
  Where a source listed both, one survives (§5).
- A ZBLS or VHLS trainer scramble also shuffles the last-layer corners, so you
  cannot learn a case by corners the picture greys out (§8).
- Nothing was lost: every case in every source made it in. Two algorithms were
  dropped because they solve no case at all, and one was moved to the case it
  actually solves (§6).

---

## 1. What the three sets are

**ZBLS** (Zborowski–Bruchem last slot, also called ZBF2L or EOLS) solves the
last F2L pair while orienting the four last-layer edges, so the last layer is
always one of the seven OCLL shapes — ready for ZBLL or COLL + EPLL. It is the
F2L case (41 of them) times the edge-orientation state on top (eight per F2L
case, fewer for a few pieces-in-slot cases): 302 in all.

**VHLS** (Vandenbergh–Harris last slot) is the part of ZBLS you meet if you
first set the pair up: F2L cases 1–4, eight edge cases each. It is the usual
stepping stone to full ZBLS, so it gets a tab of its own.

**Summer Variation** is Winter Variation's partner. WV inserts an `R U R'` pair
and orients the corners; SV does the same for an `R U' R'` pair. Both assume the
edges are already oriented.

All three start from the same place: the cross and three pairs are in, and
only the front-right slot and the top layer are disturbed.

---

## 2. Sources and licences

| Set | Source | Pinned at | Licence |
|---|---|---|---|
| ZBLS, VHLS | Tao Yu's [Alg-Trainer](https://github.com/tao-yu/Alg-Trainer), `js/alg_list.js` (`var ZBLS`, `var VHLS`). Algorithms by Chad Batten and Tao Yu. | `cb95945` | MIT |
| ZBLS (extra alternatives) | [@moishy/algsets](https://github.com/moishy-r/moishy-cubing), `packages/algsets/src/zbls/index.ts` — the same community ZBLS sheet, with 54 alternatives Alg-Trainer does not have | `8b37b70` | MIT |
| SV | [speedcubedb.com/a/3x3/SV](https://speedcubedb.com/a/3x3/SV) | fetched 2026-10-03 | none stated |

speedcubedb has **no** ZBLS or VHLS page (`/a/3x3/ZBLS` answers "Category
[ZBLS] not found!"), which is why those two come from Alg-Trainer.

**What MIT asks for, and where it is.** MIT lets anyone copy and change the
data, commercially included, on one condition: the copyright line and the
licence text travel with it. Both MIT notices are reproduced in the header
comment of `js/algsets/ZBLS.js` and `js/algsets/VHLS.js`. Nothing is credited in
the UI — the timer does not show website credits for algorithm data, and the
licence does not require it to.

**SV** has no licence on its page. Individual algorithms are community
knowledge rather than anyone's creative work, and the set is 27 cases from a
single page fetched once. The source is named in `js/algsets/SV.js`'s header
comment, not in the UI.

Fetch the three files into one folder:

```bash
mkdir lastslot-src && cd lastslot-src
gh api -H "Accept: application/vnd.github.raw" "repos/tao-yu/Alg-Trainer/contents/js/alg_list.js?ref=cb95945c3e4839ee1e4b058d4a79bc022615b220" > alg_list.js
gh api -H "Accept: application/vnd.github.raw" "repos/moishy-r/moishy-cubing/contents/packages/algsets/src/zbls/index.ts?ref=8b37b707ee2403a0feb503027d9ae009e07b2ca8" > zbls.ts
curl -sL -A "Mozilla/5.0" https://speedcubedb.com/a/3x3/SV -o SV.html
```

`Rouxles/Alg-Trainer` is a fork of `tao-yu/Alg-Trainer`; its `ZBLS` and `VHLS`
tables are byte-for-byte the same.

---

## 3. Running the import

```bash
node tools/import-lastslot.mjs lastslot-src
```

It writes `js/algsets/ZBLS.js`, `VHLS.js` and `SV.js` — only after all three
sets have built — and prints:

```
ZBLS  302 cases · 643 algorithms · 589 listed twice · 13 the same algorithm spelt another way
ZBLS  every case is the F2L case its group names, with the edges to orient on top
VHLS  32 cases · 64 algorithms · 33 listed twice · 1 the same algorithm spelt another way
SV    27 cases · 63 algorithms · 1 listed twice · 0 the same algorithm spelt another way
```

followed by every algorithm it refiled, merged or dropped, with the reason
(§5, §6). "Listed twice" is mostly the two ZBLS sources agreeing: they come
from the same sheet, so 589 of moishy's 648 algorithms are already in
Alg-Trainer.

The files are generated. Don't edit them by hand — change the importer and
run it again.

---

## 4. Nothing is filed on trust

### 4.1 A case is a state, not a cell

Each algorithm is run backwards on `js/cubenet.js` from a solved cube. The
result is the case it solves, written as a string:

- **recoloured by its own centres.** An algorithm that starts with `y` is held
  with another colour in front. Its case is still the slot in front of you on
  the right, so colours are read relative to the centres, not as absolute
  colours.
- **grey stickers blanked**: whatever the set's picture leaves out (§7).
- **the smallest of the four U turns that could come first**, because a U turn
  before the algorithm is free.

Two algorithms solve the same case exactly when their strings match.

### 4.2 Majority vote per cell

A source cell is supposed to be one case. Its case is whatever **most** of its
algorithms agree on, so one stray in the cell can't redefine it. Every
algorithm, the cell's own included, is then filed under the case its string
matches, wherever that case lives. That is how
`F' U r' F' r U r' F r F` (written under ZBLS 11-6) ended up under ZBLS 9-6,
the case it actually solves.

No two cells may be the same case. 302 distinct ZBLS cases, 32 VHLS and 27 SV
are checked, not assumed.

### 4.3 The set's premise

Every case must leave everything below the top layer home except the
front-right slot, judged against the centres. A case that disturbs anything
else stops the import.

### 4.4 The F2L numbers are real

With the whole last layer greyed out, every `ZBLS n-k` must be exactly the
timer's own F2L case `n` (`js/alglibrary-f2l.js`). All 302 match. That is
what lets the groups say `F2L 12`. Every `VHLS n-k` must also be the same case
as `ZBLS n-k`, and all 32 are.

### 4.5 The page's own checks

Finally every algorithm goes through the same functions the library page uses:

1. `verifyAlgForCase` — does it solve the case, allowing a U turn either side;
2. `alignAlg` — give it the U turn or `y` it needs in front so it works **from
   the angle the case is drawn at**, which is what a listed algorithm promises;
3. a strict re-check of every aligned algorithm once the set is registered.

Nothing failed any of them.

---

## 5. "The same algorithm" — no repeats

You asked for no repeated algorithm, including one that is another spelled with
a rotation instead of a U turn. Two algorithms in a case count as the same when
`tools/same-alg.mjs` gives them the same key:

1. **Rotations come out.** Each move is renamed for the face it really turns on
   the cube as it was first held: after `y` the face on the left is the one that
   was in front, so `y L' U' L` turns the front face and becomes `F' U' F`.
2. **A wide turn is the opposite face plus a rotation**: `d` = `y' U`,
   `u` = `y D`, `r` = `x L`, `l` = `x' R`, `f` = `z B`, `b` = `z' F`. So
   `d' F R U R' F'` and `U' R B U B' R'` are the same turns.
3. **Slices stay slices.** `M` is two layers at once, and an `M` algorithm
   is not the same execution as an `R L'` one.
4. Notation is tidied: brackets go, `R2'` is `R2`, `R R` is `R2`.
5. **The opening and closing U turns are ignored.** The trainer adds the one a
   case needs, and every check already treats them as free.

When two algorithms share a key, the one with **fewer moves** survives (a
rotation counts as a move). On a tie, the one with **fewer rotations** wins,
then the one listed first. The survivor keeps the earlier one's place in the
list. Mirrors and inverses are different algorithms and stay.

Fourteen pairs merged this way (eight distinct, some appearing in both ZBLS
sources):

| Case | Kept | Dropped |
|---|---|---|
| ZBLS 1-5 | `U2 F2 r U r' F` | `y' U2 R2 F R F' R` |
| ZBLS 2-5, VHLS 2-5 | `U2 R2 B' R' B R'` | `U2 l R U' R' U l'` |
| ZBLS 2-7 | `d' F R U R' F'` | `U' R B U B' R'` |
| ZBLS 6-6 | `U2 F' L' U' L U2 F` | `U2 y' R' F' U' F U2 R` |
| ZBLS 29-5 | `R' F R F' R' F R F'` | `x R' U R U' R' U R U' x'` |
| ZBLS 31-1 | `R U' R' U F' U F` | `R U' R' U y' R' U R y` |
| ZBLS 35-3 | `R U R2 F R F' R' F R F'` | `R U R' l' U R U' R' U R U' x'` |

`tools/verify-alglibrary.mjs` enforces the rule (§10), so a later re-import
cannot bring a repeat back.

---

## 6. What was moved or dropped

| Algorithm | Where it was | What happened |
|---|---|---|
| `F' U r' F' r U r' F r F` | ZBLS 11-6 (both sources) | **moved** to ZBLS 9-6, the case it solves |
| `U' R U R' U R U' l U' R' U R'` | moishy's ZBLS 24-3 | **dropped** — solves no ZBLS case |
| `R U2 R' U R U' R' U …` (a 40-move repeat) | speedcubedb SV 7 | **dropped** — solves no SV case; SV 7 keeps its other algorithms |

No case was lost. moishy's copy also files one case twice (its 33-2 and 34-2
are the same case), which is why it reports 301. Here its algorithms are
filed by what they solve (§4.2), so that slip never reaches the timer.

---

## 7. Pictures

All three sets use the three-quarter `3d` picture WV uses: U, F and R faces,
with the stickers the case does not care about in the dark "ignored" colour.

| Set | Shown | Greyed |
|---|---|---|
| ZBLS, VHLS | the F2L pair wherever it is, the built layers, and the **top sticker of each last-layer edge** (top colour showing = oriented) | the corners' top stickers and every top-layer side sticker |
| SV | the pair, the built layers, and the **U sticker of every top-layer piece** | every top-layer side sticker |

A ZBLS or VHLS picture with a dark top-centre-edge sticker is an edge facing
the wrong way. SV is drawn exactly like WV.

ZBLS has 41 groups, so the library shows its group picker as a dropdown and
opens on `F2L 1` rather than painting all 302 pictures. That's the same as
OLLCP's 57 subsets.

---

## 8. Trainer scrambles

A case scramble is `pre` + the case's first algorithm reversed + an AUF, like
every library set (`libraryScramble` in `js/scramble.js`).

- **SV** uses a plain AUF for `pre`, like WV.
- **ZBLS and VHLS** use an AUF **plus one of the seven OCLL algorithms (or
  none) reversed** for `pre`. Those keep F2L and the edge orientation, which is
  all a ZBLS case is, but they leave the corners twisted and swapped
  differently from one scramble to the next. Without this, each case would
  always show the same corners, and you would end up recognising it by stickers
  the picture deliberately greys out. The case you are dealt is unchanged:
  the importer checks every OCLL keeps F2L and EO before it is used. Scrambles
  run about eight moves longer.

25 ZBLS and 3 VHLS cases have a first algorithm that opens with a rotation
(`y U' L' U L`, for example), so their scramble ends with the rotation back.
That is how OLLCP has always worked. Drag a rotation-free alternative to the
top of the case in the library if you prefer, and the trainer builds the
scramble from that one instead.

---

## 9. Where it lives

| File | What changed |
|---|---|
| `js/algsets/ZBLS.js`, `VHLS.js`, `SV.js` | the generated sets |
| `tools/import-lastslot.mjs` | the importer |
| `tools/same-alg.mjs` | the "same algorithm" rule, shared with the verifier |
| `js/alglibrary.js` | the three ids in `GENERATED`, the new **Last slot** tab group, their tab labels |
| `js/events.js` | trainer modes `sv`, `vhls`, `zbls`, listed right after `wv` |
| `locales/es.js` | Spanish for the group name and the mode descriptions |
| `index.html`, `algs.html` | `?v=` bumped so returning visitors get the new modules |
| `tools/verify-alglibrary.mjs` | the rule in §5, and the case counts |

Like every generated set, each one is a single dynamic import, fetched the
first time someone opens its tab or trainer. Nothing new loads on the timer's
boot path. ZBLS is the biggest at 78 kB, smaller than OLLCP.

"Train these cases" on the library page hands the selection to the timer
(`index.html?train=zbls&cases=…`), as for every other set.

---

## 10. Verification

```bash
node tools/verify-alglibrary.mjs
```

```
33 sets · 2411 cases · 6944 listed algorithms
PASS every listed algorithm solves its case as drawn, none listed twice
PASS no ZBLS, VHLS or SV case lists the same algorithm twice, rotations and wide turns included
PASS every canonical algorithm solves its own case
PASS all 1527 3x3 setups build their case and are solved by their algorithm
```

That also checks the setup moves under each picture. They are built from the
listed algorithms, so every new case has one.

In the browser: the three tabs render every picture with the expected greys,
a "Train these cases" hand-off lands on the right mode with the right cases,
and a ZBLS trainer scramble builds the case the picture shows.

---

## 11. Not done here

- **The older sets have the same kind of repeats.** Run against every set, the
  rule in §5 finds 397 pairs, mostly F2L's slot variants (`U R U' R'` next to
  `y2 U L U' L'`) and ZBLL. Some are deliberate, since F2L lists an algorithm
  per slot. Cleaning them up is a separate change to sets people already have
  personal orders on.
- **Rotation-free scrambles.** A first algorithm that opens with `y` gives a
  scramble that ends with one. That's true of every set, not just these; see §8.
