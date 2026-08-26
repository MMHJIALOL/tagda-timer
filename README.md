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
It runs 39 checks: the statistics maths, every trainer algorithm verified by simulating a
real cube, and the rendered page itself (that no overlay is stuck on screen).

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

### Trainers (3x3)
Every trainer knows which case it dealt you, which is what makes **per-case statistics**
possible — the app can tell you your G-perm is 1.4 s slower than everything else.

| Mode | What you get |
|---|---|
| PLL | all 21 permutation cases |
| OLL | all 57 orientation cases |
| 2-look OLL / 2-look PLL / OCLL | the beginner subsets |
| Last layer | a random OLL and PLL stacked together |
| Cross solved | cross already done — drill F2L + LL |
| Last slot + LL | three pairs in, one to go |
| 2-gen (R,U) · Roux LSE (M,U) · Roux L10P | restricted move sets |
| Cross practice | full WCA scramble, time your cross only |

Press **K** to pick exactly which cases you want, including a "my worst 8" button that
selects the cases you are slowest at.

Every algorithm in the tables is verified by cube simulation in `test.html` — all 21 PLLs
and all 57 OLLs produce the correct, distinct case.

### Inspection
Exactly as in competition: 15 seconds, spoken or tonal callouts at 8 and 12, automatic
**+2 past 15 seconds** and automatic **DNF past 17**. The countdown is not a small number
in a corner — a ring of light drains around the screen edge, the background warms from
neutral to amber to red, and the digits breathe faster as time runs out.

Inspection is turned off automatically for the blindfolded events and FMC.

### Timing
All timing comes from `performance.now()` timestamps, never from counted frames, so no
amount of animation or lag can change a recorded time. The inspection penalty is read
from a fresh clock reading at the instant the timer starts, not from the last animation
frame.

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

### Your data
Everything lives in your browser's IndexedDB. No account, no server, nothing uploaded.

- Full JSON backup and restore.
- Per-session CSV export.
- **csTimer import** — bring your entire existing history across.

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
| **E** / **M** / **S** | event · mode · session |
| **A** / **H** | statistics · all solves |
| **T** / **,** | appearance · settings |
| **K** | pick trainer cases |
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
js/main.js            wiring — the entry point
js/timer.js           timer state machine + WCA inspection
js/scramble.js        cubing.js integration, trainers, pre-generation queue
js/algs.js            PLL / OLL / trigger tables (verified in test.html)
js/stats.js           WCA-correct averages
js/charts.js          hand-built SVG charts
js/theme.js           settings model + live theming
js/bg.js              WebGL background shaders
js/cube.js            static scramble preview
js/panels.js          settings / stats / history / case picker drawers
js/db.js              IndexedDB
js/fx.js              confetti, shockwave, audio callouts
vendor/cubing/        mirrored cubing.js (works offline)
tools/mirror_cubing.py  re-download that mirror
serve.py              no-cache dev server
start.bat             double-click launcher
test.html             39-check self test
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

Whatever the host, it must serve the whole folder (`vendor/` included) with
JavaScript files as `text/javascript`. Every host above does that by default.
Opening `index.html` straight off disk will not work: browsers refuse to load ES
modules over `file://`, and the page says so if you try.

---

## Not in this version

Accounts and cloud sync, multiplayer racing, Bluetooth smart cubes, Stackmat input,
and solve reconstruction. FMC currently records a time rather than running the full
60-minute solution editor.
