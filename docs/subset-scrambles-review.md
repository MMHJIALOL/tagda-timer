# Subset scrambles: review and fix

Branch `fix/subset-scrambles`, off `origin/main` at b21a731 (v140 → v141).

Reported in Artyom's screen recording (ScreenRecording_10-17-2026 03-17-01_1.mp4):
"Last slot + LL" and "Cross solved" scrambles gave wrong positions on a real cube.
He thought the other subsets looked fine and wasn't sure about the Roux ones.

Every scramble subset the timer offers was reviewed, not just the two in the video.
Four were broken. Each one is reproduced below, with what it produced, why, and
how it was fixed.

---

## 1. What the video shows

| Time | Mode | Scramble on screen | What happened |
|---|---|---|---|
| 0:02–0:24 | Last slot + LL | `U' B' U' B U L' U L U2` | After scrambling, more than one F2L slot is open |
| 0:28–0:48 | Cross solved | `B U2 B' F' U F U F' U2 F B U B' L U' L'` | Cross is intact, but a slot is already finished and the F2L is barely mixed |
| 0:50–0:58 | Opens the mode menu | — | He scrolls through 2-look CMLL / EOLR / Roux LSE; "not sure about roux subsets" |

Both scrambles from the video, replayed on the app's own cube model (`js/cube3.js`):

```
Last slot + LL  U' B' U' B U L' U L U2
  edges home:   DR DF DL DB FR BR      corners home: DFR DRB
  → only the FR and BR slots are solved. FL and BL are both open: two slots, not one.

Cross solved    B U2 B' F' U F U F' U2 F B U B' L U' L'
  edges home:   DR DF DL DB FR FL      corners home: URF DLF
  → cross fine, but the FL pair is already in its slot.
```

---

## 2. Root causes

### 2a. "Cross solved" and "Last slot + LL" were the same generator (`kind: 'trigger'`)

`triggerScramble()` in `js/scramble.js` glued together 3–7 random "cross-safe
triggers" (`R U R'`, `F' U2 F`, `B U B'`, …), each followed by a random U turn,
then inverted the result. The two modes differed only in how many triggers they
used:

```js
'cross':    { kind: 'trigger', depth: [5, 7] }
'lastslot': { kind: 'trigger', depth: [3, 4] }
```

- **Last slot + LL:** every trigger family touches a *different* slot (`R U R'` → FR,
  `L' U L` → FL, `B U B'` → BR, …), so 3–4 random triggers almost always open
  several slots. Nothing kept the other three pairs solved. "Last slot" only meant
  "fewer triggers than Cross solved".
- **Cross solved:** 5–7 short triggers often never reach some slots, and they
  pair pieces up instead of scattering them. The cross was always kept, but the
  F2L was nowhere near random.

Measured on `main`, 2,000 scrambles each:

| | Slots open: 0 | 1 | 2 | 3 | 4 | Pairs already built | Avg length |
|---|---|---|---|---|---|---|---|
| **Last slot + LL (main)** | 0.1% | **5.8%** | 45.5% | 44.6% | 4.0% | 2.32 | 13.2 |
| Last slot + LL (fixed) | 0% | **100%** | 0% | 0% | 0% | 3.06 ¹ | 18.2 |
| **Cross solved (main)** | 0% | 0.8% | 15.3% | 51.5% | 32.3% | 1.45 | 21.1 |
| Cross solved (fixed) | 0% | 0% | 0.1% | 1.1% | **98.9%** | 0.17 | 20.3 |

¹ Three of those are the three solved slots; the fourth pair is built by chance.

So on `main`, **"Last slot + LL" gave an actual last-slot position only 5.8% of the
time.** In 37% of scrambles the FR pair was even already solved, with other slots open.

### 2b. "Roux L10P" turned R, which breaks the second block (`kind: 'subgroup', pool: 'roux'`)

L10P ("last 10 pieces") means both 1x2x3 blocks are built; only the 4 top corners
(CMLL) and the 6 M/U edges (LSE) are left. The generator threw random moves from
`R, U, M, r` at the cube. Any `R` or `r` breaks the right block. **982 of 1,000**
scrambles on `main` had a broken second block. Its description, "R, U and M moves
only", described the generator, not the subset.

### 2c. "2-gen" and "Roux LSE" were random moves, not random-state

12–15 random `R/U` turns, and 10–14 random `M/U` turns. These always stayed in the
right group, so nothing was wrong with what they kept solved. But short random-move
scrambles are biased towards positions close to solved. That is the same weakness
the trigger generator had, just milder.

### 2d. ZBLS and VHLS: 33 cases scrambled into the wrong slot

Case scrambles are "AUF + the algorithm reversed + AUF". Reversing the letters is
only right if the algorithm ends held the same way it started. Take ZBLS 2-1,
`y U' L' U L`. Reversed, that's `L' U' L U y'`. Nobody performs the `y'` at the end
of a scramble, so held normally the scramble opens the **front-left** slot. The
algorithm then can't solve it from the front-right. A `d` hides the same rotation
inside a wide turn (`d' F R U R' F'`).

| Set | Cases affected on main |
|---|---|
| ZBLS | 29 / 302 |
| VHLS | 4 / 32 |
| OLLCP | 8 / 342 (harmless: on a last-layer case a stray y only changes the AUF) |
| Library ZBLL | 315 / 472 (harmless for the same reason; the trainer's own ZBLL set had none) |

---

## 3. The fix

### Random-state subsets (new `js/subsets.js`, run in `js/subsets.worker.js`)

These now work like csTimer's subsets: pick a uniformly random position among all
the ones the mode allows, then find a sequence that reaches it.

| Mode | What is left free | How the scramble is found | Length |
|---|---|---|---|
| Cross solved | All 8 corners, the 8 non-cross edges | min2phase (the 3x3 solver already vendored inside cubing.js), reversed | ~20 |
| Last slot + LL | The 4 top corners + DFR, the 4 top edges + FR; a position with FR already solved is redrawn | min2phase | ~18 |
| Roux L10P | The 4 top corners, the 6 M/U edges (UF UL UB UR DF DB); both blocks stay built | min2phase | ~19 |
| 2-gen (R,U) | A uniform position of the whole `<R,U>` group (73,483,200 positions) | Own IDA* search using only R and U: two small tables, 29,160 corner and 5,040 edge positions; ~2 ms per scramble | ~16, R/U only |
| Roux LSE (M,U) | A uniform position of the whole `<M,U>` group: 184,320 positions, centres and AUF included | Breadth-first table of the whole group (33 ms, 5 MB, built once); the scramble is a shortest path | ~11, M/U only |

Twist, flip and permutation parity are always kept legal. The generators run off
the page in a module worker, like square-1. A 15 s watchdog falls back to
generating on the page, and if the solver can't load at all there's a
non-random-state fallback that still keeps the mode's promise (FR-only triggers
for last slot, etc.).

Timings (first scramble includes building the tables):

| | Chromium | Firefox (SW controlling, like Zen) |
|---|---|---|
| Cross solved, first | 668 ms | 294 ms |
| Cross solved, then | ~20 ms | ~2 ms |
| Last slot / L10P | 5–31 ms | 4–19 ms |
| 2-gen, first / then | ~250 ms / ~2 ms | ~200 ms / ~2 ms |
| LSE, first | ~45 ms | ~40 ms |

The scramble queue already keeps several ready, so you never wait on this.

### Case scrambles (`backwards()` in `js/scramble.js`, `js/faceturns.js`)

If an algorithm ends rotated (through `x/y/z` or a wide turn like `d`/`r`), it is
now reversed by its *face turns* instead of its letters. `y U' L' U L` → `F' U' F`
→ scramble `F' U F U`. Every rewrite is checked on the cube model before it's used:
it has to bring the centres home and leave the cube exactly one algorithm from
solved. Algorithms that don't rotate are reversed exactly as before. That includes
every LSE algorithm, since an M-slice offset is part of those cases. `faceTurns`
moved from `tools/same-alg.mjs` into `js/faceturns.js` (the tool re-exports it) and
now reads `Rw`-style wide turns.

### Mode definitions (`js/events.js`)

`cross`, `lastslot`, `2gen`, `lse`, `roux` are now `kind: 'subset'`. The L10P
description now reads "Both blocks done — CMLL and LSE to go" (Spanish string
updated). The old `trigger`/`subgroup` kinds are gone. `POOLS` and
`CROSS_SAFE_TRIGGERS` stay, as fallbacks only.

---

## 4. Every subset, reviewed

Checked by the new `tools/verify-subsets.mjs` (`npm run test:subsets`). Each case set
is walked case by case through the real generator. The checker confirms the scramble
keeps what the mode promises, then plays the case's own algorithm and confirms it
solves the case. Random modes are sampled 1,000 times each.

| Mode | Kind | main | fixed | What's checked |
|---|---|---|---|---|
| F2L | 41 cases | ✅ | ✅ | cross + 3 slots before; F2L solved after |
| PLL / OLL / ZBLL | 21 / 57 / 472 | ✅ | ✅ | F2L before; solved / oriented after |
| 2-look OLL / PLL, OCLL | 10 / 6 / 7 | ✅ | ✅ | F2L before; right step done after |
| Winter / Summer Variation | 27 / 27 | ✅ | ✅ | cross + 3 slots; LL / corners oriented after |
| **VHLS** | 32 cases | ❌ 4 wrong slot | ✅ | cross + 3 slots; F2L + EO after |
| **ZBLS** | 302 cases | ❌ 29 wrong slot | ✅ | cross + 3 slots; F2L + EO after |
| COLL / OLLCP | 40 / 342 | ✅ | ✅ | F2L before; oriented after |
| 2-look CMLL / CMLL / OH CMLL | 9 / 42 / 42 | ✅ | ✅ | both blocks before; corners solved after |
| LSE EO / EOLR | 11 / 46 | ✅ | ✅ | blocks + CMLL before; edges oriented after ² |
| Last layer (OLL+PLL) | random | ✅ | ✅ | F2L solved (unchanged) |
| **Cross solved** | random | ⚠️ cross kept, F2L barely mixed | ✅ random-state | cross; slot/pair statistics |
| **Last slot + LL** | random | ❌ 948/1000 broken | ✅ random-state | cross + exactly 3 slots |
| **2-gen** | random | ⚠️ random-move | ✅ random-state | R/U only, left block untouched |
| **Roux LSE** | random | ⚠️ random-move | ✅ random-state | M/U only, blocks + CMLL kept |
| **Roux L10P** | random | ❌ 982/1000 broken | ✅ random-state | both blocks built |
| 2x2 OLL / PBL / CLL / EG-1 / EG-2 | 7 / 8 / 40 / 40 / 40 | ✅ | ✅ | bottom face/layer before; solved after |

² Measured on an exact M,U model: "oriented" means reachable from solved (with the
centres off by any M) using only edge-orientation-safe moves `U, M2, M' U2 M,
M U2 M'`. That set is exactly 1/32 of the group (5,760 positions), one per EO case,
which confirms the definition. One EOLR algorithm turns R and wasn't checked this
way (`LSEEOLR-2-opp-0-df-db`); the existing `verify-alglibrary` covers it.

**Not covered by the new tool:** 4x4 PLL parity, 4x4 centres-solved (already
tested in `test.html`), pyraminx, skewb and square-1 case sets. Their scrambles
weren't changed by this branch, and `tools/verify-alglibrary.mjs` already checks
that each of their algorithms solves its case. Cross practice is a full WCA
scramble, untouched.

**One convention to know:** the CFOP subsets keep the cross on **D**. That's the
scrambling orientation (white top, green front), so it's yellow in standard
colours. Same as before, and the same as csTimer. Hold white on top while
scrambling, then flip as usual.

---

## 5. Tests run

- `node tools/verify-subsets.mjs 1000`: all 29 modes pass (on `main`: 1,963 failures).
- `node tools/verify-alglibrary.mjs`: unchanged, all pass.
- `test.html` in Playwright Chromium **and** Firefox: 490/490. New checks: cross
  solved hands out ≤ 6 solved slots in 60 scrambles (got 0–1); last slot leaves
  exactly the front-right pair open; L10P keeps both blocks.
- `tools/verify-site.cjs` (3 suites): 23/23.
- In the app (Browser pane): picked each mode in the menu. Scrambles show and the
  preview draws, no console errors. The scramble shown for Last slot + LL left
  cross + FL/BL/BR solved, FR open. For L10P, both blocks built.

## 6. Files

| File | Change |
|---|---|
| `js/subsets.js` | new: random-state generators (cross, last slot, L10P, 2-gen, LSE) |
| `js/subsets.worker.js` | new: runs them off the page |
| `js/faceturns.js` | new: `faceTurns` moved out of `tools/same-alg.mjs`, `slices: false` option, `Rw` support |
| `js/scramble.js` | subset worker + watchdog + fallbacks; `backwards()` for rotated algorithms |
| `js/events.js` | the five modes → `kind: 'subset'`; L10P description |
| `locales/es.js` | L10P description |
| `tools/verify-subsets.mjs` | new: the review above, as a repeatable check |
| `tools/same-alg.mjs` | re-exports `faceTurns` |
| `test.html` | stricter cross / last slot / L10P checks |
| `index.html`, `algs.html`, `js/version.js`, `package.json` | v141; `npm run test:subsets` |

**Heads-up:** `js/subsets.js` points at the vendored min2phase file by its hashed
name (`search-dynamic-solve-3x3x3-B2L4IN34-HY5MHBSJ.js`). If cubing.js is
re-mirrored and that name changes, `verify-subsets.mjs` fails until the constant is
updated. In the app it degrades to the trigger fallback rather than breaking.
