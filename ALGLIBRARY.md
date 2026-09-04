# Algorithm library — browse, compare, and personalize every alg

> A CubeDB/algdb.net-style library living inside Tagda Timer: every PLL/OLL
> case shown as a picture first (not a bare letter), 3-6 community-ranked
> algorithm alternates per case, and a way for you to drag your own preferred
> alg to the top or add one that isn't listed at all. Reached from one quiet
> link in the footer — it never competes with the timer screen for space.

---

## 0. TL;DR of what gets built

- A standalone page (`algs.html`), not a panel. Reached from an **Alg library**
  button in the topbar's picker row, next to *Session* — the same shape as the
  pickers beside it, but ending in an arrow rather than a chevron, because it
  goes somewhere instead of dropping something down.
- A case grid (PLL first, OLL after) where every card leads with a small
  colored top-face diagram of the case, not its letter name — the name and
  group are secondary metadata underneath. See §2.
- Clicking a card opens a **detail view**: every known alternate algorithm for
  that case, ranked best → worst by community usage (§3), each annotated with
  move count and a one-line reason it ranks where it does.
- You can **drag-and-drop reorder** the alternates into your own preference
  order. Your order is personal and persists locally — it does not change the
  community ranking other people would see if this ever gets shared (§4).
- You can **add your own algorithm** to any case if none of the listed ones
  suit you, or if the case is missing entirely (§5).
- Your #1-ranked alg per case is what the app's trainer mode actually feeds
  you as "the" algorithm for that case wherever it needs one (§6) — so
  reordering isn't just cosmetic, it's the thing that decides what you drill.
- Every algorithm — researched or user-submitted — is checked against a
  solved cube before it's trusted, using the solver the app already has
  (§7). Nothing gets shown as valid without passing that check.

---

## 1. Why a separate page, and why the footer

This was the fourth placement considered, and the first three were rejected
for concrete reasons worth keeping on record so this doesn't get re-litigated:

> **Overruled in review, and this is what shipped:** a labelled **Alg library**
> button in the picker row, immediately after *Session*. Not an icon — an icon
> in the right-hand cluster was tried first and rejected on sight, because a
> glyph among eight other glyphs says nothing about what it opens. The pickers
> are already the row of labelled things you go to, and this is one of them.
> The deciding argument against the footer was the one this table made *for*
> it: it is quiet. A tool nobody can find is a tool nobody uses. The footer is
> back to being just the credit.

| Placement | Why it was rejected |
|---|---|
| New topbar icon button | Topbar-right already held 7 icon buttons (stats, recon, theme, settings, spotify, help, about — and race since), so an 8th is the crowding problem, not a fix for it. Still true: the button that shipped is a labelled picker, not an icon. |
| Trainer picker dropdown (`btn-mode`) | Buried under a control most people only touch to *start* a drill, not to *browse* algs at leisure. Confusing entry point. |
| Case-label click-through under the scramble | Same objection — only reachable mid-trainer-session, not a general-purpose library. |
| Sidebar panel (like `panel-stats`/`panel-spotify`) | Sidebar is already dense on desktop and actively bad on small/laptop screens — confirmed by the user as already-crowded, not a place to add a permanent block. |
| Settings-panel row | Viable fallback, but undersells a feature meant to be *browsed* — a link buried one level into a settings dropdown reads as an afterthought. |

The footer credit line (`built by Ishaan · @cubingngagng`) is dead space on
every screen size, seen by nobody during an actual solve, and that was the
original argument for it: zero layout weight on the screens that matter, and
a placement matching the feature's real importance.

It was built that way, looked at, and rejected — for the reason the argument
itself concedes (it makes the feature undiscoverable) and for one it missed:
the credit chip is `display: none` below 860px, because it used to sit on the
times column. A footer-only link therefore had no entry point at all on a
phone unless the chip came back and started covering the times list again.
Keeping it clear of the panels meant reinstating the sidebar's
`--chip-clearance` at mobile width — paying layout weight, on the smallest
screen, for the least discoverable placement. The topbar icon has neither
problem, and it is the only surface that already folds itself away when
space runs out.

### 1.1 Mobile-only hamburger (separate, but shipped alongside this)

Independent of the library's own placement, the topbar's 7 icon buttons
collapse into a single `☰` menu **only below the existing 860px mobile
breakpoint** this codebase already uses (see `@media (max-width: 860px)` in
`css/base.css`/`css/components.css`). Tablet and laptop keep every icon
inline exactly as today — this is a mobile-crowding fix, not a redesign.

```
Mobile ≥860px broken:            Mobile ☰ open:
┌───────────────────────┐        ┌───────────────────────┐
│ 🧊 Tagda           ☰   │        │ 🧊 Tagda           ✕   │
│  [3x3x3▾][Trainer▾]    │        ├───────────────────────┤
├───────────────────────┤        │  📊 Statistics          │
│        SCRAMBLE        │        │  📦 Reconstruct         │
...                               │  🎨 Appearance          │
├───────────────────────┤        │  ⚙  Settings            │
│ built by Ishaan · Alg  │        │  🎵 Spotify              │
│ library →              │        │  ❓ Shortcuts           │
└───────────────────────┘        │  ⓘ  About               │
                                  └───────────────────────┘
```

The alg-library button is in the picker row, not the icon row, so the
hamburger does not affect it — the pickers keep their own line and scroll
sideways, exactly as they did with three of them.

A fourth picker did move one number, though. The rule that gives the pickers a
row of their own was set at 620px for three of them; four at full width plus
the wordmark and the icon row need about 1040px on one line, and below that the
centre group's `overflow: hidden` was cutting the last picker in half on an
ordinary laptop window. The threshold is now 1040px: two rows there rather than
a button nobody can read or reach.

---

## 2. The case grid — pictures first, letters second

The single biggest UX bug in a first pass at this (caught before it shipped):
a card labeled only `Case: T` means nothing to anyone who hasn't memorized
PLL letter names. Speedcubers recognize cases **by shape**, not by name —
that's how recognition actually works mid-solve. So the card leads with the
picture; the name is supporting metadata, not the headline.

```
┌────────────────────────────────────────────────────────┐
│  Algorithm library                                       │
├────────────────────────────────────────────────────────┤
│  [ PLL ] [ OLL ]                    search: [________]  │
├────────────────────────────────────────────────────────┤
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐            │
│  │ [net]  │ │ [net]  │ │ [net]  │ │ [net]  │            │
│  │Headlights│  H perm │ │ T perm │ │ Y perm │            │
│  │ corners│ │  edges │ │  both  │ │  both  │            │
│  └────────┘ └────────┘ └────────┘ └────────┘            │
└────────────────────────────────────────────────────────┘
```

- The `[net]` thumbnail is a small 3×3 grid of the case's affected top-layer
  stickers, generated the same way the app already draws scrambles/cases
  elsewhere (`cube.js` / `cube3.js` / `cubenet.js` — reuse, don't reinvent).
  This is a real cube diagram, not a stock photo, which is both accurate per
  case and free (no image assets to source or host).
- Card subtitle is a plain-English descriptor ("opposite swaps", "adjacent
  swap") alongside the formal name/letter, so it reads correctly to someone
  who's never learned PLL naming *and* to someone who has.
- PLL, OLL, ZBLL and F2L are separate tabs; the two big sets add a second row
  of chips beneath (§8.1). Search filters by name, letter, or descriptor text.

---

## 3. Ranked alternates — sourcing and what "best to worst" means

"Best" is a proxy, not an objective fact, and the doc should say so plainly
rather than pretend otherwise: it means **most commonly used by the speedcubing
community**, approximated by real vote/usage data pulled from public
algorithm databases, tie-broken toward fewer moves and better-known finger
tricks. It is not a personal claim that alg #1 is mathematically optimal for
every hand.

### 3.1 Sources

- **SpeedCubeDB** (speedcubedb.com) — has actual community vote counts per
  algorithm variant per case. This is the primary ranking signal: vote share
  approximates "what most speedcubers actually drill."
- **Speedsolving.com wiki** — used to cross-verify move sequences match a
  second independent source, catching transcription errors.
- (Future, optional) **J Perm's algorithm sheets**, **CubeSkills** — as
  further cross-reference for cases where the above two disagree.

### 3.2 What "5-6 per case" actually means in practice

The original ask was 5-6 alternates per case. In practice (confirmed during
the first PLL research pass, §3.3 below), most cases only have **3-4
genuinely distinct, actually-taught variants** before vote counts drop into
single digits — i.e., the "5th/6th best" algorithm for most cases isn't a
meaningfully-ranked choice, it's an obscure novelty nobody teaches. The rule
this project follows:

> List every alternate that has real, verifiable community usage. Stop when
> remaining candidates are single-digit-vote novelties. Never pad a case to
> hit a round number — a case with 3 honest alternates beats a case with 6
> where the last 3 are filler.

Cases with a genuinely thin field (some EPLL-only cases, some OLL corner
cases) may legitimately show only 2-3 alternates. That's correct, not a gap.

### 3.3 Status

| Set | Status | Cases | File |
|---|---|---|---|
| PLL | Researched, then verified against a cube | 21/21, 3-4 alternates each, none below 3 | [`js/alglibrary-pll.js`](js/alglibrary-pll.js) |
| OLL | Scraped, corrected, verified | 57/57, 185 algs, 3-5 each | [`js/alglibrary-oll.js`](js/alglibrary-oll.js) |
| ZBLL | Scraped, corrected, verified | 472/472, 1791 algs | [`js/alglibrary-zbll.js`](js/alglibrary-zbll.js) |
| F2L | Scraped, verified | 41/41, 622 algs, 10-16 each | [`js/alglibrary-f2l.js`](js/alglibrary-f2l.js) |

2680 entries across the four sets, every one of them executed against its own
case by the harness in §7 before being committed.

### 3.4 What executing the data caught

The three scraped sets were not usable as scraped, and none of the problems
were visible by reading the files — each was found by running the algorithms:

- **Finger-trick parentheses.** SpeedCubeDB prints algs as
  `(R U R' U') (R' F R F')`. Parentheses are not move notation, so 100 OLL rows
  failed to parse. Stripped; most then turned out to be duplicates of the same
  case's unparenthesised entry, which is why OLL ships 185 algs rather than 285.
- **Setups filed as solutions.** 50 of the 285 OLL rows were the *inverse* of an
  algorithm — the moves that create the case, not the ones that solve it. They
  were caught because each oriented some *other* OLL case, and inverting all 50
  made every one solve the case it was filed under.
- **Three ZBLL algs written from another angle**, fixed by storing the `y`
  rotation as part of the algorithm so the moves are true for the picture shown.
- **Three F2L cases anchored to the wrong slot.** A case's picture is its
  canonical alg run backwards, so cases 13, 18 and 20 — whose first listed alg
  was a left-slot variant — put the pair in the front-left slot, where the
  three-quarter view shows two of its five stickers. All three rendered as the
  same grey cube. Each is now anchored to the first alternate that leaves both
  pieces in the U layer or the front-right slot. All 41 diagrams are distinct.
- **Nine unparseable ZBLL algs** containing `R3`, which is not a move. Dropped;
  no case lost an entire entry.

The F2L failures were not the data's fault at all — see §7.1.

Running the harness in §7 over the first PLL pass found more than the one
error the spot-check had caught, which is the argument for the harness:

- **Ab**, second alternate: `y' x L U' L D2 L' U L D2 L2` does not solve Ab.
  Replaced with `y x' L2 D2 L U L' D2 L U' L`, which does.
- **Ub**, third alternate: contained `R3`, which is not a move. Corrected, it
  was the same algorithm as the entry below it, so it was dropped rather than
  padded back to four (§3.2).
- **Seven notes** claimed to match this app's default alg when they did not,
  including the Ua one found by hand below. Two of those (Ga, Gc) turned out
  to *be* the default with two commuting moves written in the other order; two
  (Jb, Ra) were the default minus its trailing AUF; Rb had the claim on the
  wrong entry entirely. All are now accurate.

None of that is visible by reading the file. All of it is one page load away.

The PLL pass cross-checked SpeedCubeDB vote share against the Speedsolving
wiki for every case. **One unverified claim was caught on spot-check** before
being trusted: the Ua entry's second alternate was labeled as matching this
project's existing default algorithm in `js/algs.js`, but the move sequence
written down did not actually match — either the label or the alg itself was
wrong, and there was no way to tell which without executing it against a
solved cube. It was the label: the algorithm is sound and stays, the note is
now accurate, and the app's actual default turned out to be the *fourth*
entry, which was also mislabelled. That is exactly the failure mode §7's
verification pass exists to catch automatically rather than by luck.

---

## 4. Data model

Three layers, kept separate so community research, your personal reordering,
and your own custom algs never clobber each other:

```
┌─────────────────────────┐
│ js/algs.js               │  existing — one canonical alg per case,
│                          │  used today for trainer scramble generation.
│                          │  UNCHANGED by this feature.
├─────────────────────────┤
│ js/alglibrary-pll.js      │  NEW — researched community alternates,
│ js/alglibrary-oll.js      │  ranked best→worst. Read-only, ships with the
│ (static, in-repo)         │  app, updated only by a future research pass.
├─────────────────────────┤
│ IndexedDB `kv` store      │  NEW — per-user data, never touches the files
│  alglib:order:<caseId>    │  above:
│  alglib:custom:<caseId>   │  - your drag-reordered preference order
│                          │  - your own added algorithms
└─────────────────────────┘
```

This project already has a generic key-value object store in IndexedDB
(`db.js`, the `kv` store used for settings) — the natural, zero-new-machinery
place for both of these, rather than inventing a fourth storage mechanism.

### 4.1 Static library file shape (already established by the PLL pass)

```js
export const PLL_LIBRARY = {
  T: {
    alternates: [
      { alg: "R U R' U' R' F R2 U' R' U' R U R' F'", moveCount: 14,
        notes: "overwhelmingly the most popular T-perm, matches this app's existing default alg" },
      // ...
    ],
  },
  // ...
};
```

### 4.2 Per-case merged view at runtime

What the detail view actually renders for a case is the static `alternates`
array **plus** any user-added entries from the `kv` store, in the order the
`kv` store's saved order says — falling back to the static best→worst order
when the user has never touched that case. Merge logic:

```
displayOrder(caseId):
  base      = ALGLIBRARY[set][caseId].alternates   // community order
  custom    = kv.get('alglib:custom:' + caseId) ?? []   // user-added
  all       = [...base, ...custom]   // each tagged { source: 'community' | 'custom' }
  savedOrder = kv.get('alglib:order:' + caseId)         // array of alg strings, user's drag order
  return savedOrder
    ? savedOrder.map(alg => all.find(a => a.alg === alg)).filter(Boolean)
      .concat(all.filter(a => !savedOrder.includes(a.alg)))  // anything new since last visit, appended
    : all
```

New alternates added to the static file in a future research update
naturally append after whatever the user already ordered, rather than
silently reshuffling a list they've already personalized.

---

## 5. Adding your own algorithm

Every case's detail view ends with an "add your own" row:

```
┌──────────────────────────────────────────────────────────┐
│  + Add your algorithm                                       │
│    [ enter moves, e.g. R U R' U' ... ]        [ Save ]      │
└──────────────────────────────────────────────────────────┘
```

- Input is validated the same way as the custom-scramble feature already
  validates move notation (reuse existing move-parsing code — this project
  already parses/tokenizes move sequences for scrambles, don't write a second
  parser).
- Before being saved, the entered alg is run through the §7 verification
  check against that case's solved-state pattern. If it doesn't actually
  solve the case, it's rejected with a clear inline error — never silently
  saved as unverified.
- On success, it's appended to that case's `alglib:custom:<caseId>` entry in
  `kv`, tagged so the UI can show a small "yours" badge distinguishing it
  from the researched community alternates.
- Custom algs are draggable exactly like community ones (§6) — no
  second-class treatment once they've passed verification.

---

## 6. Drag-and-drop personal ordering

Each alternate in the detail view is a row with a drag handle (reusing this
project's existing grip-icon visual language from `panel-*` drag handles in
`drag.js`, though the underlying mechanism is different — see below):

```
┌──────────────────────────────────────────────────────────┐
│  T perm                                              ✕     │
│  ⠿  R U R' U' R' F R2 U' R' U' R U R' F'   14 moves  ★1st  │
│  ⠿  R U R' U' R' F R2 U' R' U F' L' U L    14 moves        │
│  ⠿  R2 u R2 u' R2 F2 u' F2 u F2            10 moves        │
│  ⠿  (yours) M2 U ...                        badge: yours   │
│  + Add your algorithm                                       │
└──────────────────────────────────────────────────────────┘
```

- This is a **sortable list**, not a free-floating draggable widget —
  `js/drag.js`'s `makeDraggable` (pointer-drag with a persisted `{x,y}`) is
  the wrong primitive for this and won't be reused directly; this needs a new
  small helper (native HTML5 drag-and-drop events, or a pointer-based
  reorder-within-list implementation) scoped to `js/alglibrary.js`.
- On drop, the new order is written immediately to
  `kv.set('alglib:order:' + caseId, newOrderArray)` — no explicit save step,
  matching how this app treats other preferences (instant, silent persist).
  A brief toast (existing `toast.js`) confirms the reorder took, consistent
  with how other silent saves in this app are acknowledged.
- The row currently in position 1 gets a small `★ 1st` marker — this isn't
  decorative, it's communicating the consequence described in §6.1.
- Reordering is per-device (IndexedDB is local, not synced) unless/until this
  project ever grows an account system — consistent with everything else
  being local-first today (see `PLAN.md` §1, "no backend in v1").

### 6.1 Reordering has a real consequence, not just cosmetic

Whatever sits at position 1 for a case becomes the algorithm the trainer mode
actually uses when it needs to generate/label that case (the existing
inverse-algorithm scramble generation described in `PLAN.md` §2.3(a) and the
header comment of `js/algs.js`). Concretely: today `js/algs.js` hardcodes one
alg per case for this purpose; after this feature ships, the trainer looks up
`displayOrder(caseId)[0].alg` instead, falling back to the `js/algs.js`
default when the user has never opened the library for that case. This is
the reason drag-reordering matters beyond browsing — it's how you tell the
app "this is the alg I actually drill," and it should feel like that, not
like rearranging a wishlist.

---

## 7. Verification: nothing ships or saves unverified

This project already has a cube solver (`js/solver.js`, running in
`js/solver.worker.js`) used for scramble generation. The same machinery
verifies every algorithm before it is trusted, in two places:

1. **Research pass output** — before a static `alglibrary-*.js` file is
   accepted into the repo, every entry is programmatically checked: apply
   the case's defining pattern to a solved cube, apply the candidate alg,
   confirm the cube ends solved. This is what would have caught the Ua
   mismatch in §3.3 automatically instead of by manual spot-check luck.
2. **User-submitted algs** (§5) — checked live, synchronously, in the "add
   your own" flow, before the entry is ever written to `kv`.

Verification check, conceptually:

```
verifyAlgForCase(caseId, algString, setName):
  pattern = CASE_DEFINITIONS[setName][caseId]   // the scrambled-state pattern
  cube    = applyMoves(SOLVED_CUBE, pattern)
  result  = applyMoves(cube, algString)
  return isSolved(result)
```

No alg — community-researched or user-typed — is displayed, drag-reordered,
or fed to the trainer without having passed this. This is a hard requirement,
not a nice-to-have: a wrong algorithm in a cubing app actively teaches
someone the wrong thing, which is worse than the feature not existing.

### 7.1 "Solved" is not the same question for every set

The check above says `isSolved(result)`, and that is right for PLL and ZBLL and
wrong for the other two. Each set finishes a different job:

| Set | What counts as done |
|---|---|
| PLL, ZBLL | whole cube solved |
| OLL | U face one colour, lower layers untouched |
| F2L | bottom layer and both lower rows of every side face — **U ignored** |

F2L is the one that bites, and it cost a full debugging pass: 562 of its 622
algorithms were reported as failures on the first run. They were all fine. An
F2L alg pairs a corner with its edge and puts them in a slot; whatever it does
to the last layer on the way is incidental, and two correct algs for the same
case routinely leave the U layer permuted differently. Demanding a solved cube
therefore only ever accepts the single alg the case state was built from — so
every case would appear to have exactly one solution, which is the precise
opposite of the truth for the set whose whole character is having a dozen ways
into the same slot.

F2L also gets a cube rotation in the search, which the last-layer sets do not.
The same pair state occurs in all four slots and SpeedCubeDB lists algs for
each; turning the cube to bring a slot to the front is free, and is what the
`y`s already inside those algs are doing. Rotations that would take the cross
off the bottom are not free and are not tried.

---

## 8. Rollout order

1. **Verification harness** (§7) — build this first, and re-run it against
   the existing `js/alglibrary-pll.js` output to close out the Ua discrepancy
   found in §3.3 before anything else is built on top of unverified data.
2. **PLL library page** — case grid + detail view + read-only alternates,
   no drag/custom-alg yet. Validates the picture-first card design and the
   footer entry point in real use before more is built on top.
3. **Drag-to-reorder + trainer hookup** (§6) — the personal-order layer and
   its consequence for trainer generation.
4. **Add-your-own-alg** (§5) — the custom-alg flow, gated on the
   verification harness from step 1 already existing.
5. **OLL research pass** — same sourcing method as §3, run only once steps
   1-4 have proven the format/UI is right, since OLL is ~2.7x the case count
   of PLL and not worth redoing if the shape changes.
6. **Mobile hamburger** (§1.1) — listed last as unrelated to the library
   itself, which stopped being true the moment the entry point moved into the
   topbar: the fold-away is what makes that placement affordable at all.

### 8.1 What shipped

All six steps. Step 5 (OLL) landed together with two sets this document had put
out of scope — ZBLL and F2L — once scraped data for all three existed; §3.4 is
what it took to make that data trustworthy.

Four things the implementation had to decide beyond what step 5 described:

- **Yellow on top.** Every case picture was drawn white-face-up, because the
  simulator in `cubenet.js` keeps white on U — correct for a scramble preview,
  upside down for a case you only ever see after solving the cross. The fix is
  `z2` (the rotation SpeedCubeDB itself stores as these cases' setup) applied as
  a *recolour* rather than a move: rotating the state for real would put the
  case on the D face and mirror every side bar, because the side-strip winding
  in `drawCase` is derived from the face geometry.
- **The two big sets are lazy-loaded.** `js/main.js` imports `alglibrary.js` on
  the timer's boot path, and ZBLL alone is bigger than every other alg list in
  the app combined. Both are dynamic imports, fetched when their tab is first
  opened, so the timer never pays for a page most sessions never open. They also
  carry their own case lists, since neither set exists in `algs.js`.
- **A second level of navigation.** 472 cards in one scroll is not navigation,
  so ZBLL opens on a subset (T/U/L/Pi/H/S/AS) and F2L offers its six pair states
  plus All. Search reaches across the whole set regardless of the chip, capped
  at 96 cards — obeying the chip would mean typing a case's own name and being
  told it does not exist.
- **F2L needed a different picture.** The last-layer diagram is the U face
  ringed by four side strips, which simply does not show a case that lives down
  the front and right faces. F2L is drawn the way CubeRoot draws it: the cube in
  isometric three-quarter view, with the last layer greyed out.

  Three things are in colour, and the third took a correction to get right —
  the pair's corner, its edge, and **the first two layers already built**.
  Greying the built layers was the first attempt and it was wrong: the pair on
  its own says what you are holding but not where it is going, and the
  destination is half of what you read when you recognise an F2L case. Drawing
  the finished layers solid leaves the empty slot as a notch in them, and that
  notch is the target. Nothing marks the slot out explicitly — it is drawn by
  not drawing it.

  Two things this needs that a facelet grid cannot answer on its own:

  - **Which pieces are the pair**, found by colour rather than position — the
    corner carrying the cross colour plus both slot colours, the edge carrying
    just the slot colours — because the case *is* a statement about where those
    two have ended up.
  - **Whether a piece is home**, tested per piece and never per sticker. A
    displaced last-layer corner sitting in the slot can easily show the front
    colour on the front face; one matching sticker was enough in the first
    version, so the slot was painted as finished F2L and stopped reading as
    empty. A piece counts as built only when every one of its stickers faces
    the right way.

  Both need stickers grouped into the piece they belong to before anything is
  drawn, which is what `stickerAt()` in `cubenet.js` is for: a facelet on its
  own carries a colour, not an identity.

Two things the implementation had to decide that this document did not:

- **Which angle a case is drawn at.** `invert(alg)` lands wherever the alg's
  own U turns leave it: the Z perm's default alg makes five quarter turns of
  U, so the raw picture came out a quarter turn off with every corner
  apparently swapped. PLL pictures are therefore rotated to the angle where the
  corners look solved — a U turn is free on a permutation case. **OLL pictures
  are not rotated**, because an OLL alg only works from the angle it was
  written for, and turning the picture to look tidier would be drawing a case
  the listed algorithm does not solve.
- **Where the topbar's menu button lives.** Outside `.topbar-right`, not
  inside it, because that row is what becomes the dropdown. Each item's label
  is its button's own `title`, so no button needed a second copy of its name.

## 9. Open questions (answered by shipping v1 as written)

- ~~**F2L / other subsets**: explicitly out of scope for v1 (§2)~~ — **shipped.**
  The objection was right about the browsing model and wrong about the case
  count: F2L does have a fixed 41, but it is browsed by the six pair states
  rather than by number, exactly as predicted. ZBLL came with it. The one thing
  neither has is a trainer mode, so their detail view does not claim position 1
  feeds the trainer the way §6.1 describes for PLL and OLL — it says what it
  actually is, your own reference order.
- **Case coverage beyond 3x3 PLL/OLL**: this doc assumes 3x3 only, matching
  where `js/algs.js` currently lives. Other events are not addressed.
- **Sharing/export of your custom algs**: not designed here — today this is
  purely local (IndexedDB), consistent with the rest of the app's no-backend
  stance. If you want your custom algs to survive a device change, that rides
  on this app's existing export/import (`db.js` `exportAll`/`importAll`),
  not a new mechanism — worth confirming that's sufficient rather than
  building alg-specific sync.
