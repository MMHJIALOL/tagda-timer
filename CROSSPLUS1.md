# Cross+1 Trainer — plan and predict your first F2L pair, not just the cross

> A new top-level panel, same family as the reconstruction workbench: closed
> until you ask for it, built on the solver that already exists, and it never
> touches the main timer's scramble/session/stats state.

**Status: built and verified.** This document was written as the plan and has
been updated to describe what actually shipped. Where the build departed from
the plan, §12 says so and why — three of those departures were forced by things
that only showed up once the search was running against real scrambles.

Open it with the cross-and-block icon in the top bar, `L`, or the command
palette ("Cross + 1 trainer").

---

## 0. TL;DR

- A new icon in the top bar (`#btn-xp1`, next to Reconstruct) opens a
  full-screen panel, the same way `js/recon.js` does today.
- You get a scramble, look at it for as long as you like (**infinite
  inspection is the default** — no 15s countdown, no penalties), plan your
  cross **and** your first F2L pair in your head, then start the timer.
- The moment you start, the scramble text and cube preview **black out**.
  You execute on the physical cube blind, then stop the timer.
- After you stop, the panel reveals what the solver actually found: every
  short cross+1 line it could search up, which of the four F2L pairs each one
  sets up, and — if you typed in what you planned — how your plan compares.
- Solutions are ranked by **shortest**, **easy on the hands** (an ergonomic
  score — see §4, this replaced a strict R/U/L/D filter that turned out to
  match nothing), and **preserves a pre-built pair**, as independent
  toggles — not a single hardcoded "best" order. A toggle that cannot reorder
  anything on the current scramble shows itself as idle rather than sitting
  there looking broken.
- **A turnable 3D cube** shows the position and plays the line you are looking
  at. Rotate it with the `x`/`y`/`z` buttons and **every line, every slot name
  and every ergonomic score is rewritten for the grip you are actually
  holding** — no re-search, because the answers did not change, only the way
  they are written down. See §5.1; this is the single most important thing the
  panel gets right, and it was not in the original plan.
- A flat net is one click away, for when you want all six faces at once. On it,
  the three pairs the line did *not* solve are ringed and colour-coded by how
  far each still is — the "which pair should I track" question the feature
  exists to answer.
- **The per-pair table is clickable**: tap `FR 7` to see only the lines that
  build the FR pair. Without that the list is just the shortest pair's lines
  over and over, and the comparison has nowhere to go.
- Everything is a setting: cross colour (or colour-neutral), inspection mode,
  ranking weights, blackout on/off, starting grip, 3D-or-net, how many lines to
  search for. Nothing below is hardcoded to one cross colour, one orientation
  or one scramble shape.
- **Not built in v1: X-cross.** The brief was explicit about this — Cross+1
  first. §10 says exactly what else is deliberately left out and why.

---

## 1. The one-paragraph reason this is a small feature, not a big one

`js/solver.js` already contains almost the entire algorithm this needs. It
has an exact BFS distance table for a 4-edge cross (`crossTable`), an exact
distance table for one corner+edge pair in isolation (`pairTable`), a goal
function for "cross solved and this specific pair solved"
(`pairGoal`), and an IDA*-style exhaustive search that returns every solution
at the shortest length (`solveGoal`/`searchDepth`). The F2L branch of the
existing `suggest()` (solver.js:446-533) already loops over the four
unsolved slots of a cross and searches each one with exactly this
machinery — it just does it **after** the cross is already solved, because
that's what the reconstruction panel needs (finish the pair I'm stuck on
right now).

Cross+1 needs the same search run **from the scrambled position directly**,
without insisting the cross finishes first — i.e. call
`solveGoal(scrambledState, pairGoal(homes, [], slot), h, opts)` once per
slot, straight from the scramble. That one change — search from the
scramble instead of from a solved cross — is what turns "solve the cross,
then solve the pair" (two separate, sequential optimalities, which is what
csTimer's solver-adjacent tools effectively give you) into genuine joint
Cross+1 optimality, where a cross move that happens to also set up part of
the pair is worth taking even if a shorter cross alone existed.

Everything else — the panel chrome, the timer, the blackout, the settings,
the net diagram — is new, but it's all UI wrapped around a search that was
already sitting in the repo, mostly unused for this purpose.

---

## 2. Scope: Cross+1, not X-cross

This plan builds a **1-pair predictor**: cross plus the single best next
F2L pair. X-cross (cross + first pair solved *together as one block*, which
is a stronger and much more expensive claim — it forces the cross itself to
be sub-optimal in exchange for a pair that's already fully inserted) is
explicitly out of scope, per the brief. The search infrastructure below is
written so X-cross is a natural extension later (§10.1 says what it would
take), but nothing here assumes it's coming.

---

## 3. The core search: joint cross+1

### 3.1 What "best pair" means, computed generically

`slotsFor(face)` (cube3.js:287-293) already derives the four
`{corner, edge}` pairs for *any* cross face from `CORNER_NAMES`/`EDGE_NAMES` —
nothing about which face is the cross is hardcoded there, and nothing here
should hardcode it either. For a chosen cross face `f`:

```js
const { dist: crossDist, slotOf, homes } = crossTable(f);   // solver.js, already memoized
const slots = slotsFor(f);                                   // cube3.js, all 4 pairs for this face

const results = slots.map(slot => {
  const pd = pairTable(slot.corner, slot.edge);               // exact, 576 states, memoized
  const h = (s) => Math.max(crossDist[crossIndex(s, slotOf)], pairDistanceOf(s, slot, pd));
  const { best, solutions } = solveGoal(
    scrambledState, pairGoal(homes, /* keep */ [], slot), h,
    { want: 40, slack: 2, maxDepth: 12, budget },
  );
  return { slot, best, solutions };
});
```

This is literally the F2L-todo loop already in `suggest()`
(solver.js:469-502), pointed at the scrambled state instead of a post-cross
state, and run for all four slots unconditionally (nothing is "already
done" yet). `pairGoal(homes, [], slot)` is already exported-shape-compatible
— it doesn't care whether the cross is currently solved when the search
starts, only that it ends solved.

### 3.2 Colour-neutral mode

`analyse(state, prefer)` (cube3.js:304) already has a "which face is
closest" heuristic for picking a default face, but it's a cheap proxy (count
of home edges), not a real answer to "which colour gives the shortest
Cross+1." When the user's setting is `crossPref: 'auto'`, the trainer runs
§3.1 for **all six faces** (the same `crossTable`/`pairTable` calls are
already cached across faces via `solver.js`'s module-level `crossCache` /
`pairCache`, so this is six independent searches, not six times the table
build) and surfaces the best-scoring face, with the other five one tab away.
This is a real answer, not a guess — the user asked for a genuine "what's
actually best," not a heuristic standing in for one.

### 3.3 Search budget

A joint cross+1 is typically 8–12 STM for a 3x3 — deeper than the plain
cross (`MAX_DEPTH = 11` today, solver.js:137) and deeper than a standalone
pair search. `solveGoal`'s existing `slack`/`maxDepth`/`budget` machinery
(the same `NODE_BUDGET = 5_000_000` ceiling used everywhere else in
solver.js) is reused as-is; the trainer just calls it with a larger
`maxDepth` (12–13) and a longer `timeMs` for the worker call, and honours the
existing `partial: true` flag on the result exactly the way `suggest()`
already does when the budget runs out — the panel says "searched as far as
I could in the time given" rather than silently returning nothing.

This runs in the existing `js/solver.worker.js`, not the main thread — see
§8.2 for the protocol change needed to route a second kind of request there.

---

## 4. Ranking: optimal vs. ergonomic, as independent toggles

Every solution `solveGoal` returns is a literal sequence of face turns (the
search's move table, `MOVES` in cube3.js, is quarter/half turns of the six
faces — no `x`/`y`/`z` rotation ever enters the search). That has one
consequence worth calling out explicitly: **"rotationless" is not a filter
to build — it's already true of every result the engine can produce.**
There is no regrip cost to rank by, because the search never introduces one.
This is documented here so nobody re-derives it as a TODO later.

The three ranking dimensions that *do* need building, all computed on the
already-returned list of `{alg, moves}` and shown as independent,
combinable toggles (checkbox-style, not a locked dropdown) so nothing is
hardcoded to a single "best" definition:

| Ranking | How it's computed |
|---|---|
| **Shortest move count** | Already the primary sort key (`byNiceness`, solver.js) — free. |
| **Easy on the hands** | An ergonomic score, `ergo = Σ {R,U,L,D: 0, F: 1, B: 3}` over the tokens. See the note below — this started as the strict R/U/L/D filter the brief asked for and had to become a score. |
| **Preserves a pre-built pair** | See §4.1 — a real, exact structural check, not a move-count proxy. |

**Why the R/U/L/D filter became a score.** Implemented as specified — keep only
the lines whose every token is on `RULD` — it matched **0 of 300 lines** across
five real scrambles. That is structural, not bad luck: two of the four cross
edges generally need an `F` or a `B` to reach the bottom layer at all, so a
joint cross+1 that touches neither face and still lands inside 8 moves is a
curiosity rather than something you can rank a list by. A binary preference
that is false for every row is a dead control.

The score discriminates where the filter could not — a spread of 1–10 on
**6 of 6** scrambles — and, more to the point, it picks a *genuinely different*
line about half the time: on 3 of 6 it traded an 8-move solution containing a
`B` for a 9-move solution with none. That is the real trade-off a cuber makes,
and it is now the one the toggle offers. `B` is weighted heaviest because a `B`
in a cross is the move people actually rebuild their solution to avoid; rows
carry a `1 B move` tag so the cost is visible without switching the toggle on.
Lines that *are* pure R/U/L/D still get an `R U L D only` tag when they turn up.

### 4.1 "Preserved pairs," defined precisely

Some scrambles hand you a corner and its matching edge already sitting
adjacent to each other with matching colours touching — a **connected
pair** in normal CFOP terminology. Cross execution that carelessly breaks
one of these costs you a pair you'd already been handed. Detecting this
needs to be exact, not a fudge-factor on move count, so here is the actual
check, generalized rather than written per-case:

1. **Which corner/edge slots can even touch, geometrically** — computed
   once, not hardcoded per face: for corner slot `cp` (name e.g. `"URF"`),
   its three adjacent edge slots are the edges named by each letter-pair of
   its name (`"UR"`, `"UF"`, `"FR"`), resolved through `edgeIndex()`
   (cube3.js:30). This works for any of the 8 corners without a lookup
   table.
2. **Where each slot's stickers land on the flat facelet array** — `CF`/`EF`
   in cube3.js already map slot index → facelet indices; the face each
   facelet belongs to is `FACES[Math.floor(facelet_index / 9)]`. Precompute
   `slotFaceAt(slot, face) → facelet index` once per corner/edge slot.
3. **Connected, exactly**: for adjacent `(cp, ep)`, let `sharedFaces` be the
   two face letters in the edge's name (e.g. `"U"`, `"R"` for edge `UR`).
   The pair is connected in state `s` iff, for **both** shared faces,
   `facelets(s)[slotFaceAt(cp, face)] === facelets(s)[slotFaceAt(ep, face)]`
   — the corner and the edge are showing the same colour on both faces they
   share, which is exactly "sitting docked as a block."
4. A candidate cross+1 solution is flagged **preserves pairs** when every
   connected pair present in the *scramble* (excluding the slot the solution
   is solving) is still connected — not necessarily solved, just still
   docked — in the position the solution leaves behind, checked the same
   way against the post-solution state.

This is exact and deterministic — no distance thresholds, no guessing. Its
one honest limitation: it only recognises **connected** pairs (adjacent,
matching colours touching), the strong and easy-to-spot kind. A corner and
edge that are near each other but not docked ("non-connected" pairs, in CFOP
terms) are not detected in v1 — see §10.

**Two things this bought that weren't in the plan.** Measured over real
scrambles, only about **1 in 3** hands you a connected pair at all. That has
two consequences the build acts on:

- The same check answers a question worth asking on its own, so the panel now
  says it outright: *"the scramble already built your FR pair — the lines below
  say which ones survive."* A pair you were given for free is lookahead you
  should know you have, and it explains why a line two moves longer might be
  the right one.
- On the other two thirds of scrambles there is nothing to protect, every line
  trivially "preserves", and the toggle is a control that cannot change the
  order of anything. Rather than let someone press it and watch the list sit
  perfectly still, it renders **idle** (dimmed, struck through) with a title
  saying why. The same treatment applies to the ergonomic toggle when every
  line scores identically.

---

## 5. Visual trajectory & first-pair predictor

Given a cross line (either one the user is hovering/selecting from the
result list, or the one they actually executed), show where all four F2L
pairs sit afterward.

The panel draws its own DOM net — a 12×9 CSS grid of 54 cells — rather than
painting `drawNet` onto a canvas, because individual stickers have to carry
rings and tooltips and a canvas can do neither.

- Get the 54 face letters for `scramble + rotation + line` and colour each cell
  through `SCHEME` (cubenet.js).
- For each of the three pairs the line *didn't* solve, ring its five stickers
  (3 corner + 2 edge), tinted by how far that pair still is: `≤3` easy/green,
  `4–5` fair/amber, `≥6` awkward/red, `0` already in. The distances come back
  from the solver with each line (`after[]`), so the panel never needs the
  pruning tables itself.
- Underneath, the same three pairs as chips: *"FR · 3 away · easy"*. This is
  the first-pair predictor — for whichever line you're inspecting, not fixed to
  one scramble or one cross colour.

**Correction to the plan: this does use `cubenet.js`'s simulator, and it has
to.** The plan said to reshape `facelets(state)` and avoid running a second
engine. That's wrong, for a reason that only surfaced when the answers started
coming back written for a cube held with the cross on the bottom: `cube3.js`
models a rotation as *a change in what the next letter means*, not as something
that moves stickers, so it fundamentally cannot produce a picture of a cube
that has been turned over. `cubenet.js` can — its `faceletsFor()` treats
`x`/`y`/`z` as real whole-cube rotations. Since the moves are written for the
cross on the bottom, a net drawn white-side-up would be a picture that
contradicts its own caption. So the net is built from
`faceletsFor(scramble + rotation + line)`.

Finding the pieces to ring then needs no geometry at all, which is the part
that makes this cheap rather than fiddly: **`CORNER_FACELETS`/`EDGE_FACELETS`
describe the net layout, not the cube state**, so they are the same triples and
pairs of cell indices whichever way the cube is held. A cubie is simply the
unique corner (or edge) showing that set of colours, so a piece is located by
matching colour sets against those tables — exact, orientation-independent, and
about ten lines. Verified: exactly 15 cells ring, 5 per remaining pair.

---

## 5.1 Orientation is state, not a constant

The plan got this wrong and the panel was shipped wrong once because of it.

The first build computed **one** rotation — whatever puts the chosen cross on
the bottom — and wrote every answer in that frame, permanently. That is fine
right up until you hold the cube any other way, at which point every single
thing on screen is subtly false: each `R` should be an `F`, the pair you were
told to go for has a different name, and the `B` move the ergonomic score was
steering you away from is not a `B` any more. A cross+1 that assumes a grip is
only correct for people who happen to share it.

So the holding orientation is now first-class, changeable state:

- It lives as an **alg** (`z2`, `z2 y`, …), because that is the form both
  consumers want: the 3D cube is set up with it, and the frame is derived from
  it with `applyAlg`.
- `x` / `x'` / `y` / `y'` / `z` / `z'` buttons compose onto it (through `tidy`,
  so `z2 z2` cancels rather than accumulating); **reset** returns to the
  starting grip.
- A new scramble, or a new cross colour, resets it to the default. In
  colour-neutral mode the default can only be settled once the search reports
  which colour it picked, so it is applied then.

**Turning the cube must not cost a search.** The answers are the same answers.
So `suggestCrossPlusOne` now splits each solution in two: the frame-independent
facts (the move `path`, the raw slot name, which pairs it broke, how far the
remaining pairs are) and the reading of those facts in one orientation, done by
an exported `decorateSolution`. `reframeResult(result, frame)` re-reads a whole
stored result — every line, the per-pair table, the per-colour table and the
built-pairs note — for a new grip, off data already in hand. Rotating is
instant.

Two consequences worth spelling out, because both are correct rather than bugs:

- **The list genuinely reorders when you rotate.** Ergonomics are a property of
  the grip, not of the solution, so a line that was carrying a `B` move stops
  carrying one from another angle and moves up. That is the ranking doing its
  job. To stop the line you were studying sliding out from under you, the
  selection is tracked by its **move path**, not its row index.
- **Slot names are re-sorted into notation order** (`U`/`D`, then `F`/`B`, then
  `R`/`L`) after mapping through the frame. Mapping the letters straight
  through spells them in whatever order the original happened to be in, and
  "RF pair" is a slot nobody has ever called that.

---

## 6. Blind Cross+1 drill mode (the timer)

### 6.1 A second, panel-scoped `Timer`

`js/timer.js`'s `Timer` class already does everything this needs — it's
instantiated fresh here (`new Timer({...})`, the same way `main.js:220`
instantiates the app's main one), not shared with the solving timer, so
opening this panel mid-session never disturbs an in-progress solve or its
stats.

### 6.2 Infinite inspection, on by default

"Infinite inspection" here means: no forced countdown, no `+2`/DNF penalty
for taking your time, self-paced planning — which is exactly what
`Timer`'s existing `useInspection: false` already gives you (timer.js:50-52,
63-69): pressing down goes straight to the hold/ready state instead of
starting the 15s countdown. **This is the default** for the trainer. A
toggle in settings flips it to `useInspection: true`, which reuses the
*exact* existing WCA inspection — 15s, "8 seconds"/"12 seconds" callouts,
`+2` past 15s, `DNF` past 17s (timer.js:11-15) — unchanged, for people
specifically drilling comp-realistic timing. No new Timer states are
invented; both modes are the existing class with one config flag flipped.

### 6.3 Blackout

On the trainer's own `Timer` emitting `'start'`, a CSS class toggles on the
panel root (`.xp1-blackout`) that hides the scramble text and the trajectory
net inside *this panel only* — it does not touch the main app's
`hidden-digits` mechanism (main.js:626-631), which hides the timer's own
digits during BLD events and is a different concern. On `'stop'` or
`'cancel'`, the class comes off and the reveal (§6.4) runs. Whether the
panel additionally hides the running time itself (full-BLD style) is a
setting, not fixed — some people practising this drill still want to watch
the clock while executing blind.

### 6.4 Reveal

The joint search (§3) is kicked off in the background the moment the
scramble loads — during planning, not after the user stops the timer — so
the reveal is instant rather than a compute stall right when the user wants
their answer. Nothing about the search results is shown or hinted at before
`'stop'` fires; the worker computes, the panel just doesn't render it yet.

On stop, the panel shows: the ranked cross+1 list (§4), the trajectory net
for the top line (§5), and — if the user typed in what they actually
planned into a move box (reusing the same `parse()`/`canonical()` pair
`recon.js` already uses for free-typed algs) — a direct comparison: your
line was N moves, optimal was M, here's what it sets up vs. what the optimal
line sets up.

### 6.5 Scramble source

A setting, not a fixed choice: **"generate practice scrambles here"** (an
independent `ScrambleQueue('333', 'wca')`, same class main.js already uses)
or **"use whatever's on the main timer right now"** (read the scramble the
app already generated, so a Cross+1 rep can immediately precede the actual
timed solve of the same scramble). Both are real WCA random-state scrambles
either way — there is no separate "trainer scramble" format, because
Cross+1 is a skill you're building for real solves, not a puzzle-mode case
set.

---

## 7. Settings — nothing below is hardcoded

Persisted as one object under a new `KV` key, `xp1Settings`
(`js/db.js`'s existing `KV.get`/`KV.set`, no schema change needed — `kv` is
already a plain key→value store):

| Setting | Values | Default |
|---|---|---|
| `crossPref` | a face letter, or `'auto'` (colour-neutral, §3.2) | `'auto'` |
| `inspectionMode` | `'infinite'` \| `'wca'` (§6.2) | `'infinite'` |
| `rankBy` | any combination of `shortest` / `highTps` / `preservePairs` (§4) | `shortest` only |
| `blackout` | on/off (§6.3) | on |
| `hideDigitsToo` | on/off, only meaningful with `blackout` on | off |
| `scrambleSource` | `'own'` \| `'timer'` (§6.5) | `'own'` |
| `searchDepth`, `searchTimeMs` | advanced, tunable search budget (§3.3) | `12`, `2500` |
| `showLines` | how many ranked cross+1 lines to list | `8` |

The settings UI for this panel is a section inside the panel itself (same
pattern as `recon.js`'s own cross-colour picker, recon.js:80-91), not buried
in the app-wide settings dialog — it's specific to this trainer.

---

## 8. Architecture — file by file

| File | Change |
|---|---|
| `js/xplus1.js` | **New.** Panel controller, same shape as `recon.js`: module-level `S` state object, `openXp1()`/`closeXp1()`/`xp1Open()`, lazy CSS load (§8.1), owns its own `Timer` instance (§6.1), owns its own `ScrambleQueue` when `scrambleSource === 'own'`. |
| `js/solver.js` | **Extend, append-only.** New exports `suggestCrossPlusOne()`, `connectedPairs()`, `crossRotation()` and `crossFrame()`, built from the already-private `crossTable`/`pairTable`/`pairGoal`/`searchDepth`/`render`/`dedupe`/`byNiceness` in this module — no pruning table or search duplicated. **No existing function was modified**, so the reconstruction panel's behaviour is bit-for-bit unchanged. |
| `js/cube3.js` | **Two new exports, nothing else changed:** `CORNER_FACELETS` / `EDGE_FACELETS` (the existing private `CF`/`EF` tables), which §4.1 needs to ask "are these two pieces showing the same colour on the face they share?" and §5 needs to locate a piece on the net. |
| `js/solver.worker.js` | **Extend.** Currently one message shape in, one out (solver.worker.js:17-25). Add a `type` field to the envelope (`'suggest'` default, for back-compat with every existing caller; `'xp1'` routes to `suggestCrossPlusOne`). |
| `js/cubenet.js` | **Untouched.** The plan called for a `faceletsFromState()` reshape here; §5 explains why the net goes through the existing `faceletsFor()` instead, which needed no change. |
| `css/xplus1.css` | **New.** Same lazy-load-on-first-open pattern as `css/recon.css` (recon.js:27-41) — fetched once, versioned off whatever `?v=` the page's own stylesheet links are already using, so it can never drift out of step with a cache-busted deploy. |
| `js/db.js` | **Untouched.** `xp1Settings` and the capped rolling history (§9) both live in the existing `kv` store — no schema change. |
| `js/main.js` | Six small insertions, no rewrites: the `loadXp1` lazy loader beside `loadRecon`; `xp1Open`/`closeXp1` shims plus an `openXp1()` helper; `xp1Open()` added to `modalOpen()`; the `#btn-xp1` click handler; an Escape branch; the `L` key case; and a command-palette entry. |
| `index.html` | One new `.icon-btn` in `#topbar .topbar-right`. The panel itself is built by `xplus1.js` on first open, so there is no markup for it here. The `?v=` cache version is **not** bumped — no existing stylesheet changed, and `css/xplus1.css` is a new URL. |

### 8.1 Lazy loading

Nobody who never opens this panel should pay for it — same reasoning
`main.js` already documents for `recon.js` (main.js:131-134) and Spotify
(main.js:97-105). `xplus1.js`, its CSS, and the extra worker code path only
load on first click of `#btn-xp1`.

### 8.2 Worker protocol

```js
// solver.worker.js, extended
self.onmessage = (e) => {
  const { id, type = 'suggest', state, frame, analysis, face, opts } = e.data || {};
  try {
    const result = type === 'xp1'
      ? suggestCrossPlusOne(new Uint8Array(state), frame, { face, ...opts })
      : suggest(new Uint8Array(state), frame, analysis, opts || {});
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
```

Every existing caller of the worker keeps working unmodified — `type`
defaults to the current behaviour.

---

## 9. Stats — kept deliberately small in v1

A capped rolling history (last ~200 attempts) stored as a single array under
a `KV` key (`xp1History`) — not a new IndexedDB object store, and not
folded into the existing `Solves` store (which is keyed and indexed for the
main timer's session/PB machinery that this feature has no business in).
Each entry: scramble, cross face used, best cross+1 length found, the user's
typed plan if given, moves-off-optimal, and whether they finished inside
inspection/hold or blacked out and stopped. Enough to eyeball "am I getting
closer to optimal" without building a second stats subsystem. A real
per-slot chart (which of the four pair positions you actually track well)
is a reasonable v2 once there's usage data to look at — building it now
would be guessing at a shape nobody's confirmed is useful yet.

---

## 10. Explicitly out of scope for v1 (and why)

| Left out | Why |
|---|---|
| **X-cross** | Not what was asked for. The search in §3 generalizes to it later — `pairGoal` already supports a non-empty `keep` list (pairs that must stay solved), which is most of what a "cross + 2 pairs, jointly" goal needs — but it's a materially bigger search (deeper, more branching) that deserves its own pass at the budget/UX once Cross+1 is proven out, not a half-built toggle bolted on now. |
| **Non-connected pair detection** | §4.1's "preserved pairs" check only recognises pairs that are already docked (matching colours touching). Pairs that are merely nearby but not docked are a real, softer concept in CFOP theory with no single agreed formal test — flagging them today would mean picking an arbitrary threshold and calling it exact, which it wouldn't be. |
| **Per-slot / per-colour stats charts** | See §9 — the rolling history captures enough to build this once there's real data; building the chart first would be guessing at what it should show. |
| **Multi-line memo (BLD-style alternate lines)** | The brief describes one blind attempt at a time, not a full-solve memo tool. |

---

## 11. What verification actually found

Run against real random-state scrambles in the browser, not asserted from the
code reading correctly.

**Every returned line genuinely works.** Over 6 scrambles × 60 lines (360
lines), each was applied to the scrambled state and re-analysed: all 360
finished the cross *and* the pair they claimed, with the claimed slot matching
the slot actually solved. **0 failures.** Some lines solve two pairs — a free
X-cross — which is a bonus, not a fault.

**The joint search is doing real work.** Compared against the decomposed path
the plan warned about (optimal cross, then optimal pair from there, using the
existing `suggest()`):

| | result |
|---|---|
| Joint never longer than decomposed | **8/8** |
| Joint *strictly* shorter | **8/8**, by 1–3 moves |
| Exact cross table agrees with an independent cross search | **8/8** |

That last row matters for the headline: *"the cross alone is 6, so the pair
costs 2"* is a fact, not an estimate — the optimal cross is a pruning-table
lookup, and it was cross-checked against a real search.

**Rotation does not corrupt the answers.** Every line was re-read into four
other orientations (`y`, `x'`, `z2`, `y' x`) and re-checked from scratch in
each: **~1,100 reframed lines, 0 invalid**, every one still finishing the cross
and its pair when applied in that orientation, and every one keeping the same
move count. Spelling changes; the solution does not.

**Colour-neutral is affordable.** All six faces (24 searches) in 143 ms–2.1 s,
all lines valid. It initially exhausted the node budget on 2 of 4 scrambles,
which would have left gaps in the per-colour table that mode exists for; giving
`auto` one depth of slack instead of two fixed it — 0/4 partial afterwards, and
6× faster.

**Watched, not inferred** — per the rule that UI is verified by what renders:

- **Blackout**: screenshotted mid-attempt. The scramble text and the net are
  genuinely gone from the rendered page, not merely class-toggled.
- **Net rings**: exactly **15** cells carry a ring, **5 per remaining pair**,
  with a real painted `box-shadow` distinct from unmarked cells.
- **Plan checker**: correct verdicts for optimal / 2-off-optimal / cross
  unfinished / unreadable / empty.
- **Inspection**: default is unlimited; toggling to WCA makes the first press
  start a 15 s countdown and the second start the solve.
- **Escape**: abandons an in-flight attempt without closing the panel; a second
  Escape closes it. A running solve is not abandonable, matching the timer.
- **The timer screen still works** after closing the trainer: idle →
  inspecting → running → idle, and a solve records normally.
- **No console errors** at any point.

### The one real bug this caught

The entrance animation was `from { opacity: 0 }`. A CSS animation only advances
while the page is producing frames, so in a tab that isn't rendering, the panel
sits on its first keyframe — and a full-screen surface stuck at `opacity: 0`
is a *transparent* one, with the timer, its scramble and its digits reading
straight through the trainer. That is exactly what the panel exists to hide,
and a screenshot caught it. The animation is now transform-only: stuck at 98.5%
scale is a frame nobody can distinguish from the finished one.

---

## 12. Where the build departed from the plan

| Plan said | What shipped | Why |
|---|---|---|
| Rank by a strict `R/U/L/D`-only filter | An ergonomic **score** (`F`=1, `B`=3) | The filter matched 0 of 300 lines. Structural, not luck — see §4. |
| Reshape `facelets(state)`; don't use `cubenet.js` | Uses `cubenet.js`'s `faceletsFor()` | `cube3.js` cannot draw a cube that has been rotated; the answers are written cross-on-the-bottom, so the picture has to be too — see §5. |
| Add `faceletsFromState()` to `cubenet.js` | `cubenet.js` untouched | Follows from the above. |
| — | `built` output + idle-toggle states | Only ~1 in 3 scrambles hands you a pair, so the preserve toggle is often a control that cannot do anything. Saying so beats looking broken. |
| — | Transform-only entrance animation | See the bug above. |
| A single fixed "cross on the bottom" frame | **Turnable 3D cube; orientation is live state** | The fixed frame is wrong for anyone not holding the cube that way — see §5.1. This was the biggest miss in the plan. |
| — | `decorateSolution` / `reframeResult` split | So rotating re-reads the answers instead of re-finding them. |
| Per-pair table as static labels | Clickable filters | Sorted shortest-first, the top 8 lines are usually all the *same* pair, so the other three were unreachable. |

---

## 13. Round two — what the first working version got wrong

Everything below was found by using the panel rather than by reading it, which
is the argument for shipping something runnable early.

1. **Only one pair's lines were ever visible.** Shortest-first sorting meant the
   eight rows on screen were eight ways to build the *same* pair; the per-pair
   table sat next to them looking like a summary. It is now a row of buttons —
   click `FR 7` and the list becomes FR lines, with a "show all" to come back.
   Verified: all four filter correctly, 8 lines each, every row matching.
2. **The moves assumed a grip.** Addressed in §5.1 — the largest change in this
   round, and the one that makes the feature correct rather than merely useful.
3. **The "prefer" toggles did not read as controls.** Transparent border, faint
   text, no hover. They worked; nobody could tell they were meant to be pressed.
   Now they have an edge, a hover, a focus ring and real padding.
4. **The scramble was too small to read** at `.8rem` — on the one screen whose
   entire job is "look at this and plan". Now `clamp(.95rem, 1.5vw, 1.15rem)`,
   and selectable, since copying it out is reasonable.
5. **Two layout bugs the screenshots caught, not the DOM:**
   - The net overflowed its box and painted *over* the scramble and the
     rotation controls. Cause: a plain `1fr` grid track carries an automatic
     min-content floor, so the row grew to the net's natural 345px inside a
     250px area. Fixed with `minmax(0, 1fr)`, plus sizing the net from the
     scarce axis (height) so the 4:3 ratio survives clamping — clamping a
     definite width by `max-height` squashes the cells instead of scaling them.
   - `twisty-player` brings its own intrinsic sizing, which beat the box it was
     given and let the cube be quietly cropped top and bottom. Needed an
     explicit `max-height: 100%`.
