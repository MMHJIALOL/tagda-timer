# 3BLD Workflow Suite — implementation spec

> Goal: stop blind solvers from tabbing out to a spreadsheet. Everything a 3BLD
> solver needs during review — target breakdown, letter-pair recall, memo/exec
> split, DNF post-mortem — lives inside Tagda Timer, opt-in and never in the way
> of a solve.

This spec assumes the codebase as it stands today: vanilla ES modules, IndexedDB
via [js/db.js](js/db.js), a real cube-state simulator in [js/cube3.js](js/cube3.js)
(`applyAlg`, `SOLVED`, `CORNER_NAMES`, `EDGE_NAMES`, all Kociemba-ordered), scrambles
from [js/scramble.js](js/scramble.js), and panel UI patterns in [js/panels.js](js/panels.js).
[PLAN.md](PLAN.md) already promises "BLD events — no inspection, memo/exec split
timing" (§3.2) and lists `333bf`/`444bf`/`555bf` as supported events, but as of this
writing **no BLD-specific logic exists yet** — `main.js` only has a display-name
alias (`js/main.js:2202`) and there is no phase-split, no target tracing, nothing
in `db.js` for it. This doc is the real spec for building that.

---

## 0. Two UX rules the whole feature hangs off

These came from the user directly and override anything more elaborate below:

1. **The target breakdown is hidden by default.** A solver who doesn't want to
   see cycles (most of the time, mid-training) sees exactly what they see today:
   scramble, timer, nothing else. A **"Show Breakdown"** button appears — only
   when the active event is a BLD event (`333bf`, `444bf`, `555bf`) — next to the
   scramble display. Clicking it expands the breakdown panel. It stays collapsed
   across scrambles until toggled again (persist the toggle state per session,
   not globally forced-on).
2. **Orientation and letter scheme both default to the traditional values, but
   are user-editable, not hard-coded.** Default buffer/scheme orientation is
   **white on top, green on front** (WCA standard orientation) with the
   **Speffz** lettering. A settings panel lets a solver override the orientation
   (which face is "up"/"front" when letters were assigned) and remap any letter,
   without touching code.

Everything else in this doc is in service of those two rules.

---

## 1. Data model

### 1.1 Settings (`db.js` KV store, key `settings.bld`)

Extends the existing `KV.get('settings', {})` pattern (`js/db.js:89`) with a
nested `bld` object. No schema migration needed — it's just a new key.

```js
// KV.get('settings.bld', DEFAULT_BLD_SETTINGS)
{
  version: 1,
  edgeBuffer: 'UF',        // one of EDGE_NAMES (js/cube3.js:26)
  cornerBuffer: 'UFR',     // one of CORNER_NAMES (js/cube3.js:25), any rotation accepted
  orientation: { up: 'U', front: 'F' },   // defines which physical face is "up"/"front"
                                          // for the purpose of letter assignment — default WCA orientation
  scheme: 'speffz',        // 'speffz' | 'custom'
  letters: { ...DEFAULT_SPEFFZ_MAP },     // 24 sticker-position -> letter, always fully populated
                                          // (custom scheme = same map, user-edited entries)
  showBreakdownByDefault: false,          // per-rule-1, always starts false; button toggles per-session
  memoExecSplit: true,                    // native memo/exec split enabled
}
```

`letters` is keyed by **sticker position**, not by piece — e.g. `UBL`, `UBR`,
`UFL`, `UFR` for the U-face corner stickers, `UB`, `UR`, `UF`, `UL`, ... for edge
stickers, following Speffz's own convention (buffer sticker is skipped / never
assigned a letter it needs to target itself with). Store the full 24-entry map
even when `scheme === 'speffz'`, generated once from `DEFAULT_SPEFFZ_MAP` — this
means the tracing engine (§2) never special-cases "is this custom or not," it
just reads `settings.letters`. Switching `scheme` back to `'speffz'` resets
`letters` to defaults; editing any single letter flips `scheme` to `'custom'`
automatically (mirrors how `theme.js` already treats "custom" as "any edit was
made," per the existing theme-editor pattern — reuse it here, don't reinvent).

### 1.2 Letter-pair dictionary (new IndexedDB store: `letterPairs`)

Bump `DB_VER` from `1` to `2` in `js/db.js` and add in `onupgradeneeded`:

```js
if (!db.objectStoreNames.contains('letterPairs')) {
  const s = db.createObjectStore('letterPairs', { keyPath: 'pair' }); // e.g. "BK", "ST"
}
```

Record shape:

```js
{
  pair: 'BK',              // exactly 2 letters, uppercase, primary key
  word: 'Book',
  imageUrl: null,          // optional: data: URI or blob key into `assets` store
  alg: null,               // optional, see §5 — user-supplied commutator/algorithm text
  notes: '',
  updatedAt: 1234567890,
}
```

Add a `LetterPairs` export to `db.js` mirroring the existing `Assets`/`Sessions`
CRUD shape (`get`, `put`, `del`, `all`) — no new abstraction needed, same
`tx()`/`wrap()` helpers already in the file.

### 1.3 Solve record extensions (`solves` store)

For BLD solves only, extend the existing solve object (whatever shape
`Solves.put` currently receives from the timer) with:

```js
{
  // ...existing fields (id, sessionId, createdAt, time, penalty, scramble, ...)
  bld: {
    edgeCycles:   [['A','B'], ['C','D'], ['E','F'], ['G']],   // computed at scramble time, see §2
    cornerCycles: [['K','M'], ['S','T']],
    parity: false,               // true if odd number of edge target pairs (needs a parity alg)
    memoMs: 12500,                // time from start to memo/exec split key press
    execMs: 8100,
    dnfPieces: null,              // filled in only on post-mortem, see §4
    dnfDiagnosis: null,
  },
}
```

This is what makes the DNF post-mortem (§4) and the memo:exec dashboard (§6)
possible after the fact — the breakdown is computed once, at scramble-display
time, and stored with the solve rather than recomputed from scratch during
review.

---

## 2. Target tracing engine (`js/bldtrace.js`, new file)

This is the core of feature #1 and the only genuinely new algorithmic work —
everything else in this doc is UI and storage around it. It's a pure function
of `(scrambleAlg, settings.bld)`, so it's easy to unit-test the same way
`test.html` already verifies PLL/OLL algs (PLAN.md §2.3).

### 2.1 Approach

1. Apply the scramble to `SOLVED` via `applyAlg` (`js/cube3.js:204`) to get the
   scrambled state array (40 bytes: corner perm/ori, edge perm/ori — see the
   layout comment at `js/cube3.js:9-16`).
2. Re-express corner/edge permutation and orientation **relative to the chosen
   orientation** (`settings.bld.orientation`). The state array is already
   solver-frame-relative; `orientation` only affects which physical stickers map
   to which letters in step 4, not the cycle math itself, so this step is just
   bookkeeping for the label lookup.
3. **Cycle decomposition**, standard blindfolded-solving algorithm, run once for
   corners and once for edges:
   - Start at the buffer piece's *position*. Look up what piece currently sits
     there (from the permutation array). That piece's home sticker (converted
     to a letter via `settings.bld.letters`) is the first target.
   - Follow the permutation: the piece now at the buffer's home moves to
     wherever *it* is currently sitting; continue until the cycle returns to
     the buffer, closing that cycle.
   - If closing the cycle lands back on the buffer with only one piece moved
     (a 2-cycle would already be closed by then) — a cycle of length 1 (the
     buffer's own piece is already home) is skipped, not reported as `[X]`.
   - **Orientation is checked as each piece is visited**: for edges, an `eo`
     value of `1` at that position means the edge is flipped and needs a
     "flip" flag on that target; for corners, `co` of `1`/`2` means twisted
     clockwise/counter-clockwise. These render as e.g. `[AB]*` with a tooltip,
     not baked into a second letter — Speffz-style schemes don't have "flipped"
     letters, the solver already knows to flip on insert.
   - When a cycle can't be closed by following live pieces because the buffer's
     home is currently occupied by a piece that is *also already home* for a
     different reason (shouldn't happen with a correct permutation array, but
     guard it) or because the remaining unsolved pieces don't form a path back
     to the buffer (a **cycle break**), start a **new cycle** from any
     remaining unsolved piece and flag the transition — this is exactly the
     "flags cycle breaks" behavior requested. Cycle breaks cost an extra target
     (a 3-cycle-completing swap), so flag them visibly, don't silently merge.
   - If exactly one edge and one corner both have odd-length leftover (the
     classic "one piece left" case for either wing), that's **parity** — flag
     it per §2.2 rather than emitting a malformed odd-length cycle.
4. Pair up consecutive letters into 2-letter targets for display: `[AB] [CD]
   [EF] [G]` — an odd final single letter means either parity (if it's the last
   remaining piece across both edges/corners with no partner) or a buffer
   float, which for a first version can just render as `[G]` with a note "odd
   target — pairs with next solve's leftover / needs a parity alg," rather than
   trying to auto-suggest which specific parity algorithm to run (that's scheme-
   and buffer-dependent and belongs in the user's own algorithm sheet, not
   invented here).

### 2.2 Parity

Report parity as a single boolean per solve: **odd total number of corner
targets XOR odd total number of edge targets** is the standard 3-style parity
condition (one of the two must have an odd number of remaining targets when
buffers are on different piece types). Surface it as a badge, not as a computed
algorithm — see §2.1 point 4 for why.

### 2.3 Output shape

```ts
{
  edges:   { cycles: [{ letters: ['A','B'], flipped: [false, true] }, ...], breaks: [1] },
  corners: { cycles: [{ letters: ['K','M'], twisted: [false, false] }, ...], breaks: [] },
  parity: boolean,
}
```

`breaks` is a list of cycle indices that started a fresh cycle rather than
continuing the previous one — used both for rendering a visual separator and
for the DNF back-trace in §4.

### 2.4 Verification

Follow the project's existing convention (PLAN.md §2.3: "verified, not
assumed") — add cases to `test.html` that scramble a known state, hand-compute
the expected cycle breakdown for a fixed buffer/scheme, and assert the engine
matches. At minimum: a solved cube (empty breakdown), a single 3-cycle, a
double cycle break, and one hand-verified parity case.

---

## 3. Breakdown panel UI

- Lives in the scramble area, only mounted when `currentEvent` is a BLD event.
- Collapsed state (default): a single **"Show Breakdown"** button, no cycle
  data computed or rendered until clicked (don't even run the trace engine
  eagerly — compute on first reveal, cache on the in-memory scramble object so
  toggling twice doesn't recompute).
- Expanded state: two rows, `Edges:` and `Corners:`, each a sequence of pill
  chips like `[AB]` `[CD]` `[EF]` `[G]`, cycle-break pills visually separated
  (e.g. a thin divider or a different chip tone), flipped/twisted pieces marked
  with a small corner-dot on the chip. A `Parity` badge appears inline when
  `parity` is true.
- Each pill is hoverable/tappable (§4 in the feature list = letter-pair
  dictionary hookup, §5 below).
- A small settings-gear icon on the panel opens the BLD settings section
  (§1.1) directly — buffer pickers, orientation, scheme editor — so a solver
  doesn't have to hunt through the general settings panel mid-session.
- State to persist: only the **collapsed/expanded toggle**, and only for the
  current session (resets to collapsed on reload / new session) — this keeps
  rule #1 honest; it's not a "set it once and forget the rule" escape hatch.

---

## 4. Letter-pair dictionary UI

- A dedicated settings/reference panel (new entry in whatever nav `panels.js`
  uses for Trainer/Stats/etc.) listing all saved pairs, searchable, with
  inline add/edit for `word`, `imageUrl`, `alg`, `notes`.
- **Inline recall during breakdown review**: hovering (desktop) or tapping
  (touch) a pill in the breakdown panel (§3) opens a small popover — reuse
  [js/popover.js](js/popover.js), which already exists for exactly this kind
  of anchored micro-UI — showing the saved word/image/alg for that pair, or an
  "add a memo for this pair" prompt if none exists yet. This is the
  no-context-switch requirement from the feature list.
- Import/export as JSON (mirrors the existing theme import/export and
  `db.js exportAll`/`importAll` pattern) so a solver can bring in a pair sheet
  they already built elsewhere instead of re-typing 500+ entries by hand.

---

## 5. 3-Style commutator linking — scoped down, and why

The original ask was "the timer links your target pairs directly to your
commutator sheet ... displays the optimal commutator alg." Shipping an actual
*optimal-comm solver* for arbitrary buffer/scheme combinations means either:

- **Encoding a curated 800+ alg dataset** the way [js/algsets.js](js/algsets.js)
  does for OLL/PLL (111KB of hand-verified algorithms) — this is a huge,
  buffer-and-scheme-specific data entry project (the "optimal" comm for `KM`
  depends on *your* buffer, *your* scheme, and often personal fingertrick
  preference), not something to fabricate or scrape without attribution, and
  it would silently be wrong for anyone whose buffer/scheme differs from
  whatever set gets typed in. Per the standing rule about not shipping
  hardware/feature work that won't actually work end-to-end, **this is not
  included in v1.**
- **What ships instead**: the `alg` field already on the letter-pair record
  (§1.2/§4). A solver fills in their *own* commutator for a pair once (from
  their own sheet, notes, or a generator they trust), and from then on the
  same popover that shows the word/image (§4) also shows their saved alg —
  "post-solve, click a pair, see the alg you already told the timer about."
  That satisfies the actual workflow benefit (no external sheet tab) without
  the app pretending to know 3-style theory it hasn't verified.
- If there's appetite later for a real curated comm set, it's a separate,
  much larger project (community-sourced, needs a license check per the
  copyright rule, needs the same `test.html`-style verification as PLL/OLL)
  and should get its own spec — flagged here as explicitly deferred, not
  silently dropped.

---

## 6. Memo/execution split timing

- On BLD events, a single key press (default: **spacebar**, same key used to
  stop a normal solve) mid-solve marks the memo→execution transition instead
  of stopping the timer:
  - **Memo phase**: timer display in amber/amber-tinted state from solve start.
  - **Execution phase**: display switches to green from the split press to
    the final stop press.
- This is a genuine gap in the current timer — `js/timer.js` has no phase
  concept today (confirmed: no `phase`/`memo`/`split` tokens in the file) even
  though PLAN.md §3.2 already promises it and §3.3 gestures at "multiphase
  timing" for cross/F2L/OLL/PLL splits. Implement BLD's memo/exec split as the
  *first* concrete instance of a general split-timing primitive in
  `timer.js`, so the CFOP phase-split feature from PLAN.md can reuse the same
  mechanism later instead of a parallel one-off.
- Store `memoMs`/`execMs` on the solve (§1.3).
- **Dashboard**: a new stat block (alongside ao5/ao12/etc. in the existing
  stats panel — `js/stats.js`) showing, per session: mean memo:exec ratio,
  a trend of that ratio over time, and a flag when the ratio drifts far from
  the ~30/70 elite benchmark the feature list names — phrased as "your memo is
  taking proportionally longer than usual" / "your execution TPS is likely the
  bottleneck," derived just from comparing the ratio trend against the
  solver's own rolling average, not against a hard-coded universal target
  (a sub-20 solver and a sub-60 solver both benefit from tracking *their own*
  drift, the 30/70 number is a reference point in the UI copy, not a threshold
  that changes behavior).

---

## 7. DNF post-mortem / error tracing

- After a DNF is marked on a BLD solve, offer a "diagnose" action (button on
  the solve detail view, not forced automatically) that:
  1. Shows the solver a simple facelet/net view (reuse
     [js/cubenet.js](js/cubenet.js), which already renders a flat 2D net —
     PLAN.md §0 lists a 2D view as an existing feature) of the *solved* state
     so they can identify which stickers ended up wrong.
  2. Lets them click the 2-3 pieces that were left scrambled.
  3. Back-traces against the **stored** `edgeCycles`/`cornerCycles`/`breaks`
     from that solve (§1.3 — this is exactly why the breakdown is persisted
     per-solve, not just displayed and discarded) to find which target(s)
     involve those pieces, and reports the specific target index and cycle
     type: `"Target 5 — missed cycle break at [EF]→[G]"`,
     `"Corner pair [KM] — piece ended up twisted the wrong way (likely an
     insert/interchange swap)"`, `"Leftover pieces match the flagged parity —
     likely an unresolved or misapplied parity algorithm."`
  4. This is pattern-matching against known failure shapes (which pieces are
     wrong relative to which target broke), not a mystery-diagnosis AI feature
     — keep the mapping from "these 2-3 pieces" to "this failure mode" as an
     explicit, readable table in code so it can be sanity-checked and extended
     later.

---

## 8. Settings panel additions

New "Blindsolving" section (alongside existing settings groups driven by
`panels.js`):

| Control | Default | Notes |
|---|---|---|
| Edge buffer | `UF` | dropdown of the 12 `EDGE_NAMES` |
| Corner buffer | `UFR` | dropdown of the 8 `CORNER_NAMES` |
| Orientation (up/front) | `U` / `F` (white top, green front) | two face pickers; determines which physical stickers the letter scheme's positions refer to |
| Letter scheme | Speffz | "Reset to Speffz" always available; editing any cell switches to Custom |
| Scheme editor | — | 24-cell grid (one per non-buffer sticker position), each cell an editable single-letter text input, live-validated for duplicates |
| Show breakdown by default | Off | per rule #1 — exposed so a solver *can* choose to always see it, but the shipped default stays off |
| Memo/exec split | On | can be disabled to get a plain single-phase BLD timer |

---

## 9. Phased build order

1. **Phase 1 (core value, smallest surface area)**: tracing engine (§2) +
   collapsed-by-default breakdown panel (§3) + buffer/orientation/scheme
   settings (§1.1, §8). Ships the headline feature and the two UX rules.
2. **Phase 2**: memo/exec split timing (§6), since it's pure timer-state work
   independent of the tracing engine and delivers immediate value on its own.
3. **Phase 3**: letter-pair dictionary + popover recall (§4, §1.2).
4. **Phase 4**: DNF post-mortem back-trace (§7) — depends on Phase 1's stored
   `bld` solve data and benefits from Phase 3's UI patterns (net view, popovers).
5. **Deferred, not scheduled**: full 3-style commutator dataset (§5) — ships
   only the user-editable `alg` field per pair in Phase 3, full auto-lookup
   stays out of scope until it can be built and verified properly.

---

## 10. Explicit non-goals for v1

- No auto-suggested "optimal" commutators (§5).
- No auto-solved parity algorithm suggestion — parity is flagged, not solved for you (§2.2).
- No forcing the breakdown panel open, ever, regardless of settings — "by
  default" toggles what the *default* is, not a way to make it mandatory.
- No support for buffers on already-oriented/permuted pieces mid-scramble
  edits (i.e. this traces the scramble's effect on a solved cube only, not
  arbitrary mid-solve states) — matches how `applyAlg` is used everywhere else
  in the codebase, from `SOLVED`.
