# Roux reconstruction

The reconstruction workbench (the **Reconstruct** button, `Y`, or *Reconstruct this solve* from a
solve's menu) used to read every solve as CFOP. It looked for a cross, split the moves into cross,
four pairs, OLL and PLL, and suggested only cross, F2L, OLL, PLL and ZBLL lines. A Roux solve has no
cross, so it was stuck on "Cross" the whole way through, and the suggestions were no use.

The workbench now has a **CFOP | Roux** switch. Roux gets its own phase detection, its own progress
strip and its own suggestions, and the moves you type are the same either way.

---

## Using it

1. Open the workbench and paste a scramble, or open it from a solve.
2. In the **Position** panel header, click **Roux**. The choice is remembered on this device
   (`localStorage` key `tagda.recon.method`). If storage is blocked, as in some private windows, it
   falls back to CFOP on every visit.
3. The colour row under the cube now reads **bottom** instead of **cross**:
   - **auto** (the Roux default) weighs every first block on the cube and follows the one furthest
     along. Use it if you are colour neutral.
   - A colour fixes the **bottom colour of your first block**. The side is still worked out from the
     cube, so a yellow-bottom solver can build on orange or red and be read correctly.
4. Type your moves or click suggestions, exactly as in CFOP. `M`, `M'`, `M2`, `r`, `Rw` and
   rotations are all accepted.
5. Switching method re-cuts the lines already typed. Nothing is lost; only where one step ends and the
   next begins changes.

### What each phase suggests

| Phase | Strip bar | Suggestions | How they're found |
|---|---|---|---|
| **FB**, first block | `fb` | Whole first blocks, labelled by colour, e.g. *red side, blue bottom* | Optimal search over all 18 face turns. If no block is found in time, first-block **squares** are offered instead. |
| **SB**, second block | `sb sq`, then `sb` | The easier of the two squares first (*front* or *back*, as the cube is held), then lines that finish the block | Optimal search in **U, R, r, M**, the moves people actually use for SB |
| **CMLL** | `cmll` | Every alg in the app's CMLL set (42 cases plus alternates) that solves the corners, with its case name, e.g. *CMLL Sune Right Bar* | Simulated: every alg tried with every pre- and post-AUF, like OLL and PLL |
| **EO**, LSE 4a | `eo` | Lines that orient the six edges | Search in **U, M** |
| **UL/UR**, LSE 4b | `ul/ur` | Lines that place UL and UR | Search in **U, M** |
| **LSE**, 4c | `lse` | Lines that finish the solve, including lining up the M slice | Search in **U, M** |

From the second block on, a suggestion opens with the rotation that puts your first block on the
left with its bottom down, if you aren't already holding it that way (e.g. `x2 y2 U M U r U' r'`).
After that it is written in U, R, r and M, the way a Roux solve is usually written out.

Move counts are in **slice turn metric**: `M` counts as one move, rotations count as zero. That's the
same counter the workbench has always shown.

---

## How it works

### The problem: centres don't move in this cube model

`js/cube3.js` stores a cube as 8 corners and 12 edges relative to **six fixed centres**. A slice turn
is expanded into outer turns plus a rotation: `M` is `L' x' R`. For CFOP that never matters. For Roux
it matters a lot: after an `M` the model sees the first block turned a quarter on its own layer (the
`L'`), even though nobody touched it. A naive "is the first block home?" check fails straight after
the first `M` of the second block.

### Blocks are recognised under a turn of their own layer

`rouxStatus(state, side, bottom)` (in `js/cube3.js`) answers one question: how far has a Roux solve
got, given a first block on `side` with its bottom on `bottom`?

1. **First block**: some turn `k` of the block's own layer (`side^k`) puts all five first-block pieces
   home. `k` is the M-slice offset as the model sees it.
2. **Normalise**: turn the side layer by `k` and the opposite layer by `-k`. Clockwise on opposite
   faces goes opposite ways round, so `X^k X'^-k` is the same physical turn of both outer layers. That
   is exactly an M-slice offset, which Roux treats as free. In the normalised cube both blocks are home
   and the M-slice centres line up with them.
3. Every later milestone is read off the normalised cube:
   - **SB square**: one second-block square home. Squares get their own rank so a square that goes
     in starts a new line, the way a pair does in CFOP.
   - **SB**: both squares home. They have to be lined up with the first block: a second block built
     upside down is not a second block.
   - **CMLL**: the four top corners home.
   - **EO**: each of the six LSE edges has its top/bottom-coloured sticker on the top or bottom face.
     Normalising takes care of the "M slice is off by one, so read the other colour" rule on its own.
   - **UL/UR**: those two edges home.
   - **Solved**: the real, un-normalised cube is solved. So "only the M slice is off" is still LSE
     (rank 6), not done.

The result is a single increasing **rank** from 0 to 7, the same shape as CFOP's rank (cross, pairs,
OLL, PLL). So the line-splitting (`joinsLast`, `explode`) and the seven-bar strip work for both methods
without special cases.

### Picking which block you're building

`analyseRoux(state, preferBottom, frame)` scores all 24 first-block orientations (six sides times four
bottoms), or 4 if a bottom colour is picked. The score is:

- **rank** first;
- before any block is done, the **number of first-block pieces already in place** under the best
  layer turn;
- then a **tie-break toward the block already sitting bottom-left the way you're holding the cube**
  (`frame`). Without this, once both blocks are in, either one counts as the "first" block, and after
  UL/UR so does every block along that axis. The panel would flip between them and start every
  suggestion with `y2` or `x'`;
- finally yellow-bottom and left-side, to match a standard grip.

### The searches

Everything lives in the Roux section of `js/solver.js`, behind the same `suggest()` the panel and its
web worker already call. `suggest` hands over to `suggestRoux` when `analysis.method === 'roux'`, so
the worker protocol is unchanged.

- **Pruning tables** (`pieceTable`): exact distance for one square's three pieces (13,824 states)
  to *any* of the four goal positions on its layer, built by breadth-first search. The first block's
  tables use the 18 face turns. The second block's tables also include M, which is two face turns to
  the model and one to a Roux solver. A table that charged two would be a heuristic that is not a
  lower bound, and the search would miss short lines.
- **First block** (`rouxFirstBlock`): candidates are ranked by `max(front-square, back-square)`
  distance. The best three (two if a colour is picked) are searched with the existing
  iterative-deepening search, and the budget is split between them. Answers are optimal in face
  turns. An `r` shows up as `L` and an `M` as `L' R`, because that's how the model spells them.
- **Second block and LSE** (`searchPhys` / `solvePhys`): an iterative-deepening search whose moves are
  physical U, R, r and M (or just U and M). Each move carries the rotation it causes (an `r` is an
  `x`, an `M` an `x'`), so the next `U` is always the layer on top as you hold the cube. Redundant
  spellings are pruned: `R` then `M'` is an `r`, so it's only walked once, and nothing follows an `r`
  or `M` on the same axis. LSE needs no table, because `<U, M>` branches three ways a move.
- **CMLL**: `hits()`, the same simulator OLL and PLL use, run over `js/algsets/CMLL.js`. A case
  where the corners only need a U turn is reported as a *CMLL skip*.

On 40 random scrambles, driving the whole solve from top suggestions solved all 40. Typical
single-search time was well under 100 ms, and the worst was about 300 ms: the first question, which
builds the first-block tables. That runs in the solver worker, so the page never freezes.

---

## Files

| File | Change |
|---|---|
| `js/cube3.js` | `rouxPieces`, `rouxStatus`, `analyseRoux`, `ROUX_PHASES` |
| `js/solver.js` | Roux section: piece tables, `rouxGrip`, `physMoves`, `searchPhys`, `suggestRoux`; `suggest()` dispatch |
| `js/recon.js` | CFOP/Roux switch, remembered method, per-method colour preference, rank-driven strip and legend, Roux phase names and "what's next" wording, re-cutting lines on switch |
| `css/recon.css` | `.rc-method` for the switch |
| `index.html` | stylesheet version bump (`?v=61`), required for any change under `css/` |
| `test.html` | Roux milestone checks and a full Roux solve driven only by suggestions |

## Testing

- **Self test**: open `test.html` from the local server. The *reconstruction* section now includes
  *Roux milestones are read with the M slice free* and *the solver can talk itself through a whole
  Roux solve, a milestone a step*.
- **By hand**: open the workbench, paste
  `R' U' F D2 L2 F2 R2 B2 D' B2 U' R2 D' F' L' R2 B U R' F2 U2 R' U' F`, pick **Roux**, and keep
  clicking the top suggestion. It goes FB, SB square, SB, CMLL, EO, UL/UR, LSE, solved in seven lines.
  Then switch to **CFOP** and back to see the same moves re-cut.

## Known limits

- **First-block lines are in face turns.** The search walks the 18 face turns, so an `r` is
  written `L` and an `M` as `L' R`. Both do the same thing to the cube, and the second-block and LSE
  suggestions do use `r` and `M`.
- **No EOLR or other LSE shortcuts.** EO, UL/UR and the rest are suggested one at a time. A line that
  happens to do EO and UL/UR together is still offered under EO; the workbench just doesn't look for
  them on purpose.
- **Second-block lines use U, R, r and M only.** Lines that need F, B or wide `Rw`-plus-`F` tricks
  won't be suggested, though you can still type them and they're read correctly.
- **The method is per device, not per solve.** A reconstruction saved on a solve is just its move
  string. Open it in Roux mode and it's cut as Roux.
