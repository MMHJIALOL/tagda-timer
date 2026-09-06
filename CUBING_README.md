# Cubing Algorithm Data — F2L / OLL / PLL / ZBLL

Scraped algorithm data for the cubing site, plus the spec for the requested
site changes.

## Status — all four site changes are built

| # | Change | State |
|---|---|---|
| 1 | Yellow on top | Done — every case picture, all four sets |
| 2 | All 57 OLL cases | Done — 185 algs, 3-5 per case |
| 3 | ZBLL section | Done — 472 cases, 1791 algs, subset navigation |
| 4 | F2L section | Done — 41 cases, 622 algs, grouped by pair state |

591 cases and 2680 algorithms, every one executed against its own case by
`tools/verify-alglibrary.html` before being committed. The data as scraped did
not survive that check — see [ALGLIBRARY.md](ALGLIBRARY.md) §3.4 for the four
classes of error it caught and §7.1 for the one that was the app's fault rather
than the data's.

The answer to the question at the bottom of this file is yes: F2L is its own
section.

One thing this file recommended that was **not** done that way:

- **`setup: "z2"` is applied as a recolour, not a rotation.** Rotating the state
  for real puts the case on the D face and mirrors every side bar, because the
  side-strip winding is derived from the face geometry. Same picture, and the
  diagrams stay correct.

`stickering` is honoured rather than read: F2L is drawn in CubeRoot's style — an
isometric cube with the last layer greyed out, the pair in colour, and the first
two layers you have already built drawn solid so the empty slot shows as a notch
in them. That notch is the target, and nothing marks it out explicitly; it is
drawn by not drawing it. The pair and the built layers are both worked out by
grouping facelets into pieces, rather than by trusting a field. The last-layer
sets use the flat U-face-plus-side-strips diagram, which is what `"pll"`
stickering means.

Side colours are this app's own scheme flipped by that `z2` (green front, orange
right), not CubeRoot's red-front palette — the orientation is the one the data
specifies, and it is consistent across all four tabs.

## Data files

| File | Contents | Source |
| --- | --- | --- |
| `f2l_algorithms.json` | 41 cases / 622 algorithms | Scraped from SpeedCubeDB |
| `zbll_algorithms.json` | 472 cases / 1800 algorithms | Scraped from SpeedCubeDB |
| `oll_algorithms.json` | 57 cases / 285 algorithms | Supplied (5 algs per case) |
| `scrape_scdb.py` | Re-runnable scraper for F2L + ZBLL | — |

### The scraper

```bash
python scrape_scdb.py            # scrape everything
python scrape_scdb.py f2l        # scrape one set
```

The SpeedCubeDB pages are fully server-rendered, so the scraper is plain
`requests` + BeautifulSoup — no Playwright, no scrolling, no Cloudflare bypass.
Every set uses the same markup: each case is a
`div.row.singlealgorithm[data-alg]` containing one `div.formatted-alg` per
algorithm, so one parser handles F2L and all seven ZBLL pages.

It sleeps 1s between requests and checks the case count against a known
expected total, exiting non-zero if the site layout shifts. Run it once and
commit the JSON rather than calling it from a request path.

### `f2l_algorithms.json`

Flat `{case_name: {...}}`, `"F2L 1"` through `"F2L 41"`:

```json
{
  "F2L 1": {
    "index": 1,
    "subgroup": "Free Pairs",
    "algs": ["U R U' R'", "R' F R F'", "y' r' U' R U M'", "..."],
    "setup": "z2",
    "stickering": "f2l"
  }
}
```

Cases are grouped by how the pair is positioned:

| Subgroup | Cases |
| --- | --- |
| Free Pairs | 4 |
| Disconnected Pairs | 10 |
| Connected Pairs | 10 |
| Corner In Slot | 6 |
| Edge In Slot | 6 |
| Pieces In Slot | 5 |
| **Total** | **41** |

Between **10 and 16 algorithms per case** — far more than OLL's 5, because F2L
cases have many slot-and-angle variants (`y`/`y'`/`d` rotations, `L`-side
mirrors, slice-move alternatives). The UI must not assume a small fixed count.

### `zbll_algorithms.json`

Shape is `{subset: {case_name: {...}}}` — one extra level of nesting versus F2L,
because ZBLL is split across seven pages:

```json
{
  "H": {
    "ZBLL H 1": {
      "index": 1,
      "subgroup": "H1",
      "algs": ["y F' r U R' U' r' F R2 U2 R' U' R U' R'", "..."],
      "setup": "z2",
      "stickering": "pll",
      "subset": "H"
    }
  }
}
```

Case counts, which sum to the full 472-case ZBLL set:

| Subset | Cases | Algs |
| --- | --- | --- |
| T | 72 | 287 |
| U | 72 | 285 |
| L | 72 | 279 |
| Pi | 72 | 277 |
| H | 40 | 151 |
| S | 72 | 265 |
| AS | 72 | 256 |
| **Total** | **472** | **1800** |

### `oll_algorithms.json`

Flat `{case_name: [algs]}`, `"OLL 1"` through `"OLL 57"`, exactly 5 algorithms
each. Verified: numbering complete with no gaps, no duplicate algorithms within a
case, all algorithms parse as valid WCA notation (including wide moves `r u f`,
slices `M E S`, and rotations `x y z`).

### Shape differences — read before wiring these up

The three files are **not** the same shape:

| File | Nesting | Case value |
| --- | --- | --- |
| `oll_algorithms.json` | flat | bare array of algs |
| `f2l_algorithms.json` | flat | object with metadata |
| `zbll_algorithms.json` | nested by subset | object with metadata |

If the site loads them through one code path, normalise on read. OLL is the odd
one out — it carries no `setup`/`stickering`, so the renderer needs defaults for
it (`setup: "z2"`, `stickering: "oll"`) to match the others.

## Site changes

### 1. Yellow on top for F2L / OLL / PLL / ZBLL

All case images must render with **yellow as the U face** (white cross on the
bottom), which is the standard CFOP convention and what every other algorithm
site shows. Currently they render white-on-top, which is upside down relative to
how the case is actually seen while solving.

Two places this is typically set, depending on the renderer:

- **Flat SVG / CSS sticker grids** — change the U-face fill constant from white
  (`#FFFFFF`) to yellow (`#FFD500`), and swap the side-face colours to match.
- **`cubing.js` `<twisty-player>` or similar 3D renderers** — keep the colour
  scheme at `crosscolor: white` and apply a `z2` setup rotation, which flips
  white to the bottom and yellow to the top.

The scraped data already encodes SpeedCubeDB's own answer: **all 472 ZBLL cases
and all 41 F2L cases** carry `"setup": "z2"` with a white cross colour — and
`z2` is precisely the rotation that puts yellow on top. Reuse the per-case
`setup` and `stickering` values rather than hardcoding a rotation, so any case
that ever needs a different orientation still renders correctly.

Note F2L uses `"stickering": "f2l"` while ZBLL uses `"pll"` — the renderer has to
support both modes, since F2L greys out different pieces (it highlights the
target pair and slot, not the whole last layer).

### 2. Add all OLL cases

Replace the current partial OLL set with the full 57 cases from
`oll_algorithms.json`. Every case has 5 algorithm options, so the UI should
expose alternatives (a list or a picker) rather than showing only the first.

### 3. New ZBLL section

Add ZBLL alongside OLL and PLL, with case images, same yellow-on-top rendering.
Structural notes:

- It is **472 cases**, roughly 8x the size of OLL — it needs subset navigation
  (T / U / L / Pi / H / S / AS), not one flat scroll. The `subset` and `subgroup`
  fields are there for exactly this.
- `subgroup` (`"T1"`, `"H1"`, …) groups cases that share a corner orientation,
  which is the natural second-level grouping under each subset.
- Case images are **not** scrapeable as static files. SpeedCubeDB generates them
  client-side from the `setup` + `stickering` values, so the site has to render
  them itself from those fields.

### 4. F2L section

F2L data is ready on the same terms as ZBLL — case images rendered client-side
from `setup` + `stickering`, yellow on top. Two differences from the last-layer
sets:

- Group by the six `subgroup` values rather than by case number; that grouping is
  how F2L is actually taught (recognise the pair state first, then the case).
- With 10–16 algs per case, showing all of them inline will bury the page. A
  primary alg plus an expandable list of alternatives works better here than the
  flat list that suits OLL's 5.

Confirm whether you want F2L as its own section — the original request covered
PLL/OLL/ZBLL, and this data was added afterwards.
