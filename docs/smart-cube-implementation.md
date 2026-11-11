# Main-timer smart cubes

Implemented 9 November 2026. Select **Settings → Timing input → Smart cube (GAN)**.
This is a local implementation; no site or production database rules were deployed.

## Recording

The first release records standard 3×3 practice (`333`, `wca`). Other events,
trainer modes, virtual sessions, races, Competition Mode, relays, multiphase,
scrambles-only and Scramble of the Day do not arm smart-cube timing. Their
screen offers Keyboard input. Connection and preview can remain active.

Connect one GAN cube, with other cube apps closed. Apply the displayed scramble
until the state matches. With inspection enabled, press Start inspection; a turn
before that action disarms the match rather than starting a timer. Without
inspection, matching arms directly. The first accepted execution turn starts the
timer; the turn producing solved ends it. Inspection uses the existing Timer
penalty thresholds. The execution interval excludes picking up and putting down
the cube. Result penalties never enter replay timing or execution TPS.

The cube always starts from its reported URFDLB facelets. The existing
CubeView/twisty-player renderer and a flat net use the current colour scheme.
Rendering is coalesced to one
animation frame and has no animation queue. Recording uses `cube3.js`, including
a new physical-state decoder with piece, orientation and parity checks. Preview
errors cannot stop capture. Settings → Smart cube and the connected cube's gear
open size, rear sticker visibility and device controls. Reduced motion selects the net.

Pairing does not reset the cube. **Calibrate solved cube** sends a reset only
after the user confirms that the physical cube is solved. A Bluetooth-address
fallback uses a local prompt; the address is not stored in captures or diagnostics.
Reconnect uses a fresh stream/epoch, even for a cube with the same advertised name.
Reconnect is explicit through the chooser; there is no automatic retry loop.

Raw decoded events are copied before processing. Canonical turns retain serial,
epoch, original cube/local clocks, receive clocks, recovery flags and positions.
Serial arithmetic uses the library's documented 8-bit sequence counter for GAN
Gen2/3/4. Duplicates remain in evidence but apply once. Unknown intervals and
snapshot disagreements interrupt attempts. Older snapshots never overwrite a
newer preview. A late mismatch associated with a recently finished capture also
invalidates that record, preserving its moves and the new evidence.

Timing fits the production library's clock helper on copies only when at least
three observations have finite, nondecreasing clocks and a fitted slope between
0.9 and 1.1. Missing recovered clocks are not interpolated. Otherwise the capture
uses monotonic local timestamps or receive timestamps and labels timing estimated.
Equal playback timestamps remain ordered. The first playback timestamp is zero;
the last is the execution duration. Internal precision survives UI rounding.

Interrupted attempts retain their original session, scramble and inspection
settings. They enter the normal solve path with DNF and a separate interrupted
capture status. A crash recovery is interrupted, never silently resumed across
an unknown hardware interval. Recovery offers retry and JSON export.

## Review

Click a smart time, including phone recent times and session-detail time cells.
The independent historical view provides play/pause, restart, step, seek and
0.25×/0.5×/1×/2× speed. Checkpoints every 24 turns bound random seeks. Closing
disposes its preview, animation frame and colour subscription. Live turning does
not change historical replay.

Each move shows the original turn, elapsed timestamp and preceding gap. Selected
ranges show start/end, QTM, first-to-last execution span, entry gap and execution
TPS. Single-turn ranges have no execution TPS. Whole-solve QTM counts half turns
as two without cancelling inverse pairs. The optional chart uses trailing
one-second QTM windows sampled every 100 ms, retaining quiet windows during pauses.
The default highlighted-gap threshold is 500 ms and is editable.

The default method profile is Unknown. Selecting CFOP and a cross face enables
conservative state analysis: a boundary must survive the remaining analysed
states, rather than accepting the first fleeting match. Unidentifiable boundaries
say Unknown. Phase durations include entry gaps and add to execution time. The
selected range can supply persistent manual Cross/F2L/OLL boundary corrections.

Exact algorithm analysis loads only on request. It compares the observed
face-turn sequence against existing OLL/PLL alternatives, with explicit AUF and
rotation handling. It does not infer slice/wide turns from unsensed movement.
Unambiguous complete last-layer suffixes on a D cross can establish phase
landmarks even when intermediate algorithm turns disturb F2L. Other cross faces
retain state/manual analysis; suffix recognition currently targets D cross.
Ambiguous AUF allocations and unmatched algorithms remain unnamed. Saved matches
include case IDs, matching method, reference version and confidence. These are
inferences, not measurements of recognition or thinking time.

Named move ranges, profile choices, pause settings and corrected boundaries
persist separately from original move evidence. Reconstruction copy and versioned
capture JSON export are available. Solve details retain penalties, comments,
deletion and existing webcam replay actions. Smart-cube capture does not create a
second video recorder. Optional physical gyro orientation and free-scramble arming
were not added.

## Persistence and cloud ownership

IndexedDB v5 adds `smartCubeCaptures`, keyed by the solve ID. `recordSolve()` still
owns normal IDs/context, statistics and solve-list integration; smart attempts
supply their stable ID. Completed solve and capture writes share one transaction.
The existing failed-write journal retains both payloads and retries atomically.
Deleting solves and clearing sessions remove captures. Smart undo creates a copy
with a new identity so stale uploads cannot revive a deliberately deleted ID.

Active attempts checkpoint every 500 ms in foreground use, with a localStorage
emergency copy. The journal writer coalesces pending updates instead of accumulating
a write per turn. Background browser throttling can exceed that foreground window;
a freeze or evidence gap interrupts the attempt. Buffers are capped at 4,000
canonical moves, 5,000 raw events and a 1.8-million-character capture payload, with
earlier byte-budget cutoffs. Overflow retains the valid prefix as interrupted.

Cloud uploads use the existing account-scoped durable queue. Initial solve and
capture updates share one Firebase multi-path operation. Captures are JSON strings
inside versioned envelopes, preserving empty arrays and raw values through RTDB.
Details download on demand, not with ordinary solve history or averages. Missing
details display pending download and offer retry. Opening local details also tries
to refresh them without making offline review depend on the network.

The first account upload claims an unowned local capture. Captures already owned
by another account are not published on account switches. Revision checks reject
stale annotation writes; the sender merges append-only annotations by ID and
chooses the later profile correction, then retries with a higher revision. Conflicting
original evidence is retained as a visible sync error. Deletions remove summary,
capture and add a durable server deletion marker, blocking delayed resurrection.

Native backup version 3 carries captures and annotations; old ordinary backups
still import. Full backup refuses to silently omit a referenced capture that
cannot be downloaded. Plain reconstruction strings are never promoted into timed
captures. CSV and other ordinary-result exports do not represent timed evidence;
use native backup or capture JSON to retain replay data.

`firebase.rules.json` is the release rules source. Its capture ownership,
revision and deletion checks were compiled and exercised in the local emulator.
Deploy these rules with the feature before enabling production capture sync.
The separate diagnostic dashboard and its fixed 24-hour retention are unchanged.

## Checks and measured coverage

Run a static server at port 5186 for browser checks. The rule check expects a
Realtime Database emulator at `127.0.0.1:9400`, overridable with `RTDB`.

```text
npm run build:smart-cube
npm run test:smart-cube
npm run test:smart-cube-ui
npm run test:smart-cube-sync
npm run test:smart-cube-offline
npm run test:smart-cube-rules
node --test js/sync-queue.check.mjs js/stackmat.check.mjs js/cube.check.mjs js/puzzle-colors.check.mjs js/settings-search.check.mjs js/stats-session.check.mjs
node tools/verify-competition-data.cjs http://localhost:5186
node tools/verify-timer-performance.cjs http://localhost:5186
npm test --prefix tools/smart-cube-worker
```

Coverage includes simulator parity, impossible states, immutable clock fitting,
clock fallback/reset cases, duplicates/wraps/gaps/epochs, deterministic replay,
200 synthetic complete captures, range/phase sums, exact PLL suffixes, annotation
merging, failed transactions and retry, native backups and deletion. Main-app
browser checks cover initial snapshots before command promises resolve, clickable
times, replay after reload, inspection/+2/DNF, one-time finalisation, session
freezing, active journaling and renderer-failure isolation. The sync fixture
exercises actual sync entry points, offline uploads, pending detail downloads,
account switches, annotation conflicts and deletion. Twelve emulator assertions
cover ownership, payload bounds, revisions, deletion and ordinary legacy solves.

Windows desktop, headless Chromium 141, 1280×900 and a 390×844 phone viewport:

| Check | Observed |
| --- | --- |
| Current startup to first scramble | About 0.98–1.29 s in recent runs |
| Canonical fast-turn preview burst | 600 turns, exact count; recent p95 about 18–22 ms |
| Connection/capture soak | 200 cycles, 200 captures with exact move counts, zero retained cube subscriptions |
| Repeated historical review | 20 opens/closes; no remaining replay renderer/dialog |
| Retained heap after review/GC | About +0.67 MiB; includes warmed UI caches |
| Offline first-load assets | Offline reload, lazy Bluetooth entry and atomic recording passed |

These are synthetic desktop measurements, not Bluetooth radio latency or physical
phone performance. A pre-change startup/heap baseline was not captured, so no
before/after performance claim is made. Phone viewport QA does not replace a
physical mobile performance run. Existing keyboard performance/Stackmat, cube,
colour, stats, sync queue, Competition persistence and diagnostic-dashboard
regressions passed after fixing an unrelated-store health-warning interaction.

## Hardware and release checklist

No physical cube was available in this implementation environment. The handoff's
previous GAN i3 / GANi3x3s, firmware 7.76, Edge-on-Windows diagnostic evidence is
historical coverage, not validation of this new main-timer path. The second cube's
exact model remains unknown. External timing accuracy is unmeasured.

Before release, validate the GAN i3 in the main timer:

1. Connect while already scrambled. Verify all face colours/orientation against
   the physical cube. Disconnect/reconnect, and test the local address fallback
   if the browser requests it. Never calibrate a scrambled physical cube.
2. Solve physically, apply the displayed scramble, confirm the matched state,
   start inspection, then solve. Repeat with inspection disabled, +2 and DNF.
   Include a fast solve and a longer turning session.
3. Click each saved time. Verify every move/state, pauses, first/final timestamps,
   range timings and final solved state. Review after reload and disconnect.
4. Disconnect during a solve, switch event/session and test recovery after reload.
   Verify interrupted evidence survives and no completed result is fabricated.
5. Test offline recording, native backup/restore, annotations on two devices,
   account switching and offline deletion after the reviewed production rules are
   deployed. Confirm deleted details do not return.
6. Measure a real phone separately. Compare with an independent timing reference
   if external accuracy is to be claimed. Validate the second cube separately.

Changed implementation files: `js/smart-cube*.js`, `js/cube3.js`, `js/timer.js`,
`js/main.js`, `js/db.js`, `js/sync.js`, `js/panels.js`, `js/phoneshell.js`,
`css/smart-cube.css`, `index.html`, `locales/es.js`, `sw.js`, `js/version.js`,
Firebase rules, `package.json`/lockfile, `vendor/gan/`, and the smart-cube
build/verification scripts. The protocol is pinned to gan-web-bluetooth 3.0.2;
its bundled dependency notices are under `vendor/gan/`.
