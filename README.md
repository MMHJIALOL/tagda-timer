# Tagda Timer

A modern WCA speedcubing timer. Official random-state scrambles for all 17 WCA events,
real competition inspection, 3x3 trainers with per-case stats, deep statistics, and a
theme engine that lets you rebuild the entire look.

Built by [@cubingngagng](https://instagram.com/cubingngagng).

---

## Run it

Double-click **`start.bat`**. Your browser opens on its own.

From a terminal instead:

```bash
python serve.py
```

> **Do not open `index.html` by double-clicking it.** Browsers refuse to load
> JavaScript modules from `file://` addresses, so you get a dead page with a
> frozen timer. It has to be served over http. If you do it anyway, the page now
> tells you so rather than sitting there silently.

`serve.py` is a normal static server with caching turned off, so edits show up on
refresh instead of you fighting a stale cache.

There is **no build step** — no Node, no npm, no bundler. It is plain ES modules,
so any static file server works, and deploying later means uploading the folder as-is.

To check everything still works after a change, open <http://localhost:5173/test.html>.
It runs the statistics maths, the learn-mode scheduler, every trainer algorithm verified by simulating a
real cube, the reconstruction model and solver (superflip, the wide-turn identities, and
whole CFOP solves driven only by the suggestions it hands back), and the rendered page
itself (that no overlay is stuck on screen).

---

## What it does

### Scrambles
- **All 17 official WCA events** — 2x2 through 7x7, 3BLD/4BLD/5BLD, FMC, OH, MBLD,
  Clock, Megaminx, Pyraminx, Skewb, Square-1.
- Generated with **cubing.js**, which wraps the same random-state solvers TNoodle
  (the WCA's own scrambler) uses. These are competition-grade scrambles, not random moves.
- A **queue keeps three scrambles pre-generated** at all times. A 4x4 random-state
  scramble takes about 3.5 seconds to compute — you never wait for one, because the next
  is already made before you finish the current solve.
- cubing.js is **vendored into `vendor/`**, so the timer works with no internet at all.
  Re-mirror it any time with `python tools/mirror_cubing.py`.
- **Your own scrambles.** Paste a list — a competition round, a set of cases, ten
  thousand lines — and the generator steps aside: every *next* hands you the following
  line, in order, and each solve is recorded against the scramble it was actually done
  on. The list survives a reload, and the timer goes back to generating on its own once
  the list runs out. Button beside the scramble, or `X`.

### Trainers (3x3)
Every trainer knows which case it dealt you, which is what makes **per-case statistics**
possible — the app can tell you your G-perm is 1.4 s slower than everything else.

| Mode | What you get |
|---|---|
| F2L | all 41 first-two-layers cases, grouped the way they are taught |
| PLL | all 21 permutation cases |
| OLL | all 57 orientation cases |
| ZBLL | all 472 one-look last layers, by family (T, U, L, H, Pi, Sune, Antisune) |
| 2-look OLL / 2-look PLL / OCLL | the beginner subsets |
| Last layer | a random OLL and PLL stacked together |
| Cross solved | cross already done — drill F2L + LL |
| Last slot + LL | three pairs in, one to go |
| 2-gen (R,U) · Roux LSE (M,U) · Roux L10P | restricted move sets |
| Cross practice | full WCA scramble, time your cross only |

#### Learn mode
The trainers deal a case and time it. **Learn mode** (`L`) is the part that teaches
one, and it works on top of whichever trainer you are already in — PLL is still PLL,
learn only changes *which* PLL you are handed next.

- **A case you have never seen arrives with its algorithm on screen.** There is
  nothing to recall yet, so nothing is hidden.
- **After that it is recall.** The alg is gone; `G` brings it back, and asking for it
  counts as not knowing it — that is the whole signal, so it is never taken quietly.
- **It grades the solve you actually did.** Clean and at or under your own average on
  that case moves it forward. Slow, or a +2, holds it where it is. A DNF or a peek
  sends it back to the start and puts it in front of you again within a few solves,
  not tomorrow. "Slow" is a multiple of *your* average on *that* case, because 1.5x is
  a different number for a sub-10 solver and someone learning their first PLL.
- **Nothing is called known on evidence that does not exist.** Until there are enough
  solves of a case to have an average, everything passes — so a case stops one step
  short of *known* and waits for one rather than graduating on three lucky attempts.
- **New cases arrive a few at a time** (five per sitting by default), so switching learn
  on in ZBLL teaches you five cases rather than dumping 472 unknowns on you.
- It works on exactly the cases switched on in the case picker, so *my worst 8* plus
  learn mode is a session about the eight cases you are worst at.
- The strip under the scramble is the state of the set: how many are new, being
  learned, known, and due right now. When nothing is due it says so and goes back to
  dealing the set at random.
- Schedules live in your browser with everything else, and ride along in the JSON
  backup — restoring an old one merges rather than resetting what you have learned since.

Press **K** to pick exactly which cases you want, including a "my worst 8" button that
selects the cases you are slowest at. Where a set has groups — F2L's six pair states,
ZBLL's seven families, OLL's shapes — a row of chips narrows the grid to one of them, and
`all` / `none` / `invert` then work on just what is showing. Picking only the Sune set out
of ZBLL's 472 is two clicks.

Trainer cases are previewed **yellow on top, white cross underneath** — the way the
algorithm sites draw them and the way you are already holding the cube. Official WCA
scrambles keep the white-on-top, green-front orientation they are defined in, because
there the preview's job is to match the cube you just scrambled. Turn it off under
Appearance → *Yellow on top*.

Every algorithm in the tables is verified by cube simulation in `test.html` — all 21 PLLs,
57 OLLs, 41 F2L cases and 472 ZBLLs produce the correct, distinct case.

### Inspection
Exactly as in competition: 15 seconds, spoken or tonal callouts at 8 and 12, automatic
**+2 past 15 seconds** and automatic **DNF past 17**. The countdown is not a small number
in a corner — a ring of light drains around the screen edge, the background warms from
neutral to amber to red, and the digits breathe faster as time runs out.

Inspection is turned off automatically for the blindfolded events and FMC.

### Blindfolded

On 3BLD a **Show breakdown** button appears under the scramble. It stays collapsed until
you ask for it, and then reads the scramble out as your memo: edge and corner letter pairs
for your own buffer and letter scheme, cycle breaks marked, flipped and twisted pieces
flagged, and a parity badge when there is one. Buffers, the orientation the letters were
assigned in, and all 48 letters are editable in Settings → Blindsolving — Speffz and white
top / green front are only the defaults.

Click any pair to see the word, image, commutator and notes you saved for it, without
leaving the timer. On a blind event the first press mid-solve ends the memo instead of the
solve, so every solve records a memo and an execution time, and the statistics drawer
tracks how that split is drifting against your own average. After a DNF you can click the
pieces that were still wrong on a flat net and have them matched back against the memo
that solve actually stored.

The bigger blind events are timed and split like 3BLD but not traced — only the 3x3 is
modelled, and guessing at wing and centre cycles would be worse than saying so.

### Timing input
Three sources, one at a time, chosen in Settings:

- **Keyboard / touch** — the spacebar, or a tap on a phone.
- **Typed times** — type under the clock and press Enter. It reads `12.34`, `1:05.67`,
  bare digits (`1234` is 12.34), `12.34+2` for a plus two, and `DNF`. Each entry records
  against the scramble on screen and moves on to the next.
- **Stackmat on the aux jack** — run a 3.5 mm cable from the timer's data port into the
  microphone socket. The 1200-baud stream is decoded in an AudioWorklet, either polarity,
  any Stackmat revision (the packet checksum is what is matched, not the frame length).
  A bar under the clock says whether packets are actually arriving, so a wrong socket or
  a muted input shows up in a second rather than a session.

Bluetooth smart timers are deliberately **not** supported — every model speaks its own
encrypted protocol and an untested implementation would be a button that fails silently.
The aux route works with any Stackmat, which is what those timers emulate anyway.

### Timing
All timing comes from `performance.now()` timestamps, never from counted frames, so no
amount of animation or lag can change a recorded time. The inspection penalty is read
from a fresh clock reading at the instant the timer starts, not from the last animation
frame.

### The times list
The strip in the sidebar scrolls all the way back to the first solve of the
session, a page at a time as you reach the bottom, ending on a `start of the
session` marker. Only what is on screen is built, and a render diffs against
what is already there rather than tearing the list down — so on a 5,000-solve
session, appending a page costs about a millisecond and toggling a penalty with
every row expanded costs about 30, against two full seconds for a naive rebuild.
Recording a solve folds the strip back to its top page, because that is where
you are looking.

Beside every time are two rolling averages — ao5 and ao12 out of the box, and
whichever two you actually chase after that: the pencil on a column heading
turns it into a number box, so the column can be an ao3, an ao25 or an ao100.
Clicking a heading orders the whole session by that column, fastest first, and
clicking it again puts the list back in solve order; solve numbers stay with
their solves, and a row with no value for that column (an ao12 before the
twelfth solve) sorts to the bottom rather than pretending to be zero. Any
average in the list opens the solves behind it, not just the current one and
the session best.

### Reconstruction
A workbench for working out what you actually did, and what you could have done
instead. It is off the timer entirely — it opens from a solve's menu
(*Reconstruct this solve*), from the topbar cube button, or with `Y`, and the timer
screen is untouched until you ask for it.

- **One click from the times list.** Hover a solve and a **reconstruct** button
  appears in the column kept for it; the solve's menu carries the same entry,
  which is how you get there on a touch screen.
- **It suggests the moves.** From wherever the cube currently stands it works out
  every shortest way on, ranked by move count and then by how comfortably they turn.
  The search runs in a worker, so a hard last-slot position thinks for a second
  or two without the page — or the cube mid-turn — freezing while it does.
  Cross and F2L are solved by search against a pruning table, so "6 moves" means six
  and not "six that I happened to find". The last layer is not searched, it is
  simulated against the full alg libraries, so you get the alg you recognise.
- **Every spelling of the case, not just one.** The last-layer libraries carry
  every alg the community actually uses — 228 for the 57 OLLs, 83 for the 21 PLLs
  — so the alg *your* fingers know is on the list and you never have to type it
  out. Every one of them is checked against the cube model in `test.html`: an alg
  is in the file only if applying it really does solve the case it is filed under.
- **ZBLL, when the cross is already there.** If F2L leaves the last layer's edges
  already oriented, the whole layer can go in one alg instead of two. The panel
  spots that, puts all 472 ZBLL cases (1790 algs) at it, and lists what it finds
  above the OLLs — highlighted, tagged `ZBLL`, with the summary line saying how
  many moves finish it in one. A step made that way is labelled **ZBLL** in the
  reconstruction, in the copied text, and on the share card.
- **Nothing is ever refused.** Type a move that is not in the list and it simply
  becomes the new position — a fresh set of suggestions is built from there. The
  counter above the list is the honest feedback: it goes up, and turns amber, when
  the move you made cost you something.
- **The cube keeps up.** Hover a suggestion and it plays on the cube beside the
  list; click it and the position advances. *Replay the whole solve* turns the panel
  into a scrubbable playback of everything from the scramble.
- **The move box types in caps and adds as you go.** Finish a move, press space, and
  it lands — there is no Enter key in the loop. Wide turns are `RW`, `LW`, `UW`;
  they are stored and drawn as `Rw`, `Lw`, `Uw`, which is the notation the cube
  preview reads, and they animate as the two-layer turns they are.
- **The scramble sits above the cube as well.** The bar at the top of the panel
  is where you edit it; the line over the cube is where you read it, next to the
  position it produced.
- **Pick your cross colour.** Six swatches under the cube, white selected by
  default. Say white and every question after that is asked about the white
  cross, finished or not; `auto` works it out from the cube instead, which is
  what reads a solve that starts `x2` or `z'` correctly.
- Reconstructions are **saved onto the solve**, so reopening one picks up where you
  left off, split back into cross, four pairs, OLL and PLL.
- **Copy it or make a card.** The two buttons beside the scramble: one puts the
  whole thing on the clipboard as text, the other draws a share card with the
  scramble, the cube it makes, and the solution one line per phase — the cross
  is one line however many goes it took, all four pairs are F2L, and a trailing
  U turn is written out as the AUF it is. The time is the headline and the move
  count the footnote under it; a ZBLL finish is called out under both.

Any scramble works, not just a recorded solve — paste one into the field at the top,
or pick a past solve from *from a solve*.

### Statistics
WCA-correct averages — trim the best and worst, DNFs count as worst, and two DNFs inside
a window make the whole average a DNF. Current and best ao5 / ao12 / ao50 / ao100, mo3,
mean, median, standard deviation, and a consistency score.

Five charts, all hand-drawn SVG: a trend line with rolling ao5/ao12 and your PB, a
distribution histogram, a practice heatmap with streaks, a consistency dial, and a
per-case ranking for trainer sessions.

### Making it yours
The entire design is CSS custom properties, so the appearance panel rewrites variables
live — drag a slider and the app changes under your hand, no reload.

- Seven themes: Nebula, Carbon, Vaporwave, Ice, Terminal, Speedcube, Paper.
- Custom accent colours on top of any theme.
- Backgrounds: five animated WebGL shaders (aurora, mesh, plasma, grid, stars), a CSS
  gradient, a solid colour, **your own image**, or **your own looping video**. Uploaded
  media is stored in your browser and never leaves your machine.
- Background dim, blur, saturation and zoom, so any photo can be made readable.
- Timer font, weight, size and glow.
- Show or hide any panel; compact / comfortable / spacious density.
- Motion: full, reduced, or off (and `prefers-reduced-motion` is respected by default).
- Export your theme as JSON and send it to someone.

### Sharing
Any solve, and any average, can be exported as a card rather than a wall of text.

- **One solve** — the time, the scramble, and the cube exactly as that scramble leaves
  it, drawn as a flat net from a facelet simulation rather than screenshotted.
- **An average** — ao5, ao12, ao50, ao100, mo3: the counting times with their scrambles,
  trimmed solves in brackets the way results are written up.
- Copy the image to the clipboard, save the PNG, or hand it to the device's own share
  sheet (the only route that reaches Instagram). X, WhatsApp, Telegram and Reddit links
  are there when there is no native sheet.
- The card takes its colours from whatever theme you are on.

Share a solve from its context menu in the times list; share an average from the
`share card` button on any statistic.

### Gear
The cube picker in the topbar row — beside event, mode and session, where the
rest of "what this sitting is" already lives (**U**) — is the cube on your desk.
It carries the active cube's name, so which one you are logging against is
readable without opening anything: brand and model, the tension you set
it to, what you lubed it with, and a dated log of what you changed — re-lubed,
tension changed, magnets, cleaned, broke.

- **The cube you mark active is tagged onto every solve you record after that.**
  Past solves are left exactly as they were: they were done on whatever they were
  done on, and back-filling them would invent the answer the statistics exist to
  give you.
- **The trend chart can be filtered to one cube**, with a dashed line wherever you
  logged a change to it — so a step in your times can be read against the thing you
  changed rather than remembered.
- The pickers are seeded from `cubes.json` (GAN, MoYu, QiYi/X-Man, YJ, DaYan) and
  `lubes.json` (Cubelelo, Cubicle Labs, SpeedCubeShop, GAN), but **they are
  autocomplete, never a menu you are stuck in** — new cubes ship faster than those
  files get edited, so anything you type is kept exactly as typed.
- Deleting a cube leaves its solves alone. They really were done on it.

### Your data
Everything lives in your browser's IndexedDB. No account, no server, nothing uploaded.

- Full JSON backup and restore.
- Per-session CSV export.
- **csTimer import** — one picker takes either a Tagda backup (`.json`) or a csTimer
  export (`.txt`) and works out which it is from the contents, because csTimer writes
  JSON into a `.txt` and an extension filter is exactly the wrong thing to trust. Every
  session comes across with its name, times, scrambles, comments and penalties, and the
  event is read from the session's scramble type. Tested at ~12,000 solves across 23
  sessions in under five seconds.

---

## Keyboard shortcuts

| | |
|---|---|
| **hold Space** | start / stop |
| **Esc** | cancel inspection, close any panel |
| **Delete** | delete the last solve |
| **Ctrl + Z** | undo that delete |
| **2** / **D** / **0** | +2 · DNF · clear penalty |
| **C** | comment on the last solve |
| **N** | new scramble |
| **← →** | previous / next scramble |
| **Ctrl + C** | copy the scramble |
| **X** | enter your own scrambles |
| **E** / **M** / **S** | event · mode · session |
| **A** / **H** | statistics · all solves |
| **T** / **,** | appearance · settings |
| **U** | gear — your cubes, lube and tension |
| **K** | pick trainer cases |
| **L** | learn mode on / off |
| **G** | show the alg (counts as not knowing it) |
| **Y** | reconstruct (topbar button, or a solve's menu) |
| **Ctrl + K** or **/** | command palette |
| **?** | shortcut list |
| **Z** / **F** / **V** | zen mode · fullscreen · 3D↔2D preview |
| **I** | toggle inspection |
| **Ctrl + Shift + Del** | clear the whole session |

Shortcuts are ignored while you are typing in a field.

---

## Layout

```
index.html            markup
css/tokens.css        every design value, as CSS variables
css/base.css          reset, layout, background, timer
css/components.css    panels, controls, overlays, charts
css/recon.css         the reconstruction workbench (fetched on first open)
js/main.js            wiring — the entry point
js/timer.js           timer state machine + WCA inspection
js/scramble.js        cubing.js integration, trainers, pre-generation queue
js/learn.js           the learn-mode scheduler — pure, and tested
js/learnmode.js       learn mode around it: which case next, the alg, the verdict
js/algs.js            trainer PLL / OLL / trigger tables (verified in test.html)
js/algsets.js         every OLL, PLL and ZBLL alg, all checked in test.html
js/stats.js           WCA-correct averages
js/charts.js          hand-built SVG charts
js/theme.js           settings model + live theming
js/bg.js              WebGL background shaders
js/cube.js            static scramble preview
js/cube3.js           the 3x3 model: notation, state, CFOP phase detection
js/solver.js          cross / F2L search, last layer by simulation
js/solver.worker.js   runs that search off the main thread
js/recon.js           the reconstruction workbench
js/panels.js          settings / stats / history / case picker drawers
js/db.js              IndexedDB
js/gear.js            the gear log — your cubes, their lube and tension, what changed when
cubes.json            cube picker seeds (brand, model, event, tags)
lubes.json            lube picker seeds (brand, name, viscosity, type)
js/fx.js              confetti, shockwave, audio callouts
vendor/cubing/        mirrored cubing.js (works offline)
tools/mirror_cubing.py  re-download that mirror
serve.py              no-cache dev server
start.bat             double-click launcher
test.html             self test — open it in a browser to run it
```

---

## Deploying

The folder is already a static site — no build step, no server, no environment
variables. Drag it onto Netlify, or:

```bash
npx vercel --prod
```

`netlify.toml` and `vercel.json` are committed and set the caching that matters:
`vendor/` is content-hashed so it is cached for a year, while `js/`, `css/` and
`index.html` revalidate on every load so a deploy can never leave a visitor with
half the old app and half the new one.

For GitHub Pages, push the folder to a `gh-pages` branch and enable Pages on it —
the `.nojekyll` file stops Jekyll from touching anything.

### Sign-in and the `/__/auth/*` proxy

Google sign-in normally opens a popup, and that popup reports its result back to
the page through a hidden iframe on Firebase's `authDomain`
(`tagda-timer.firebaseapp.com`). Served from anywhere else, that iframe is
third-party — so every browser that partitions third-party storage by default
(Firefox strict mode, and therefore Zen; Safari's ITP) blocks the relay. The
popup opens, Google signs you in, and the answer never makes it home. The only
way through is a full-page redirect out to Google and back, which tears down the
running timer.

The fix is to stop being third-party. `vercel.json` rewrites `/__/auth/*` to the
firebaseapp.com handler, so the iframe and the popup are served from the app's
own origin and there is no partitioned storage left to block. Two things have to
line up for that, and sign-in breaks outright if only one of them does:

1. `SAME_ORIGIN_AUTH_HOSTS` in `js/raceapp.js` lists the hosts that actually
   carry the rewrite. Anywhere else — localhost, a Vercel preview URL, a fork on
   another host — `/__/auth/*` is a 404, so those keep the firebaseapp.com
   default and fall back to the redirect flow.
2. Each host in that list needs `https://<host>/__/auth/handler` added to the
   **Authorized redirect URIs** of the project's OAuth client (Google Cloud
   Console → APIs & Services → Credentials → "Web client (auto created by Google
   Service)"), *and* the host itself in Firebase Console → Authentication →
   Settings → Authorized domains. Without the first, Google refuses the sign-in
   with `redirect_uri_mismatch`.

Deploying to a new domain therefore means editing `SAME_ORIGIN_AUTH_HOSTS`, both
console lists, and — on a host that is not Vercel — porting the rewrite to that
host's own config (`netlify.toml` has no equivalent yet, because nothing is
deployed there).

Whatever the host, it must serve the whole folder (`vendor/` included) with
JavaScript files as `text/javascript`. Every host above does that by default.
Opening `index.html` straight off disk will not work: browsers refuse to load ES
modules over `file://`, and the page says so if you try.

---

## Not in this version

Accounts and cloud sync, Bluetooth smart cubes, and Bluetooth smart timers. FMC
currently records a time rather than running the full 60-minute solution editor.

The reconstructor suggests and animates, but it cannot know what you actually turned —
without a smart cube it removes the typing, not the recall. It reads CFOP; Roux, ZZ and
freestyle solves will not phase-detect cleanly, and it says so rather than guessing.
