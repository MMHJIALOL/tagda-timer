# Main-timer smart cubes

## Restore i Carry 4 support — v182, 24 November 2026

The live v181 main site served the original 72,700-character GAN bundle and
omitted the i Carry 4 controller/core/model changes that were deployed in v175.
The independent lab still served `carry4-state-sync-2`. CubeStation calibration
therefore fixed the tester's earlier R-prime offset without fixing the separate
main-site decoder regression.

The release restores the complete v175 support branch on top of the verified
v181 production source (`dde5c1f`), retaining the subsequent layout and replay
changes and the live AdSense account meta tag. Both app version and service
worker cache advance so a normal reload replaces the cached original bundle.

The new `test:gan-carry4-disconnect` exercises the actual site bundle through
simulated encrypted Bluetooth/GATT transport. Against live v181 it reproduces
a connection on the first turn and a disconnect on the second: the stock driver
requests pre-connection history from the zero state counter, then its blocked
move buffer exceeds 16 entries. The restored bundle stays connected on both
turns and makes no spurious history request.

`test:gan-carry4-main` now simulates only the BLE device. It no longer replaces
the site protocol bundle with a separately built decoder, which had hidden the
missing deployed adapter. Pairing, chooser activation, setup exclusion, an exact
solve across counter wrap, calibration confirmation, persistence and replay pass.
The 25 smart-cube unit tests, raw-packet Chrome replay, connection UI, main-cube
browser and offline capture checks also pass. `test:gan-carry4-upgrade` verifies
that a v181 service worker upgrades to v182 on reload, replaces the stock bundle
and preserves local settings. Transport is simulated; a physical main-site
retest by the owner remains necessary.

## GAN i Carry 4 main-timer release — 23 November 2026

Version 175 adds the corrected GANic4 adapter to the main timer. It retains the
existing GAN Gen2/3/4 connections and identifies GANic4 separately from GANi4.
Both pairing rows explain the slow-turn-and-undo setup while waiting for the
first confirmed state. The device settings label the model as early support.
Setup turns remain in stream evidence but cannot enter a timed solve. Hardware
calibration still requires the existing physical-solved confirmation.

The release is based on production v174, commit `d87d77e`. The live AdSense
account meta tag is preserved. The service-worker cache and asset version change
together, including the self-contained Bluetooth bundle. The separate lab worker
and hardware fixtures are excluded from main-site static assets.

`test:gan-carry4-main` exercises real controller pairing from Settings, initial
matching scramble/inspection, setup-turn exclusion, native browser timers,
counter wrap, exact captured moves, model metadata, calibration cancellation,
keyboard fallback, persistent reload and replay at a 390-pixel viewport. The 25
smart-cube unit tests, actual raw-packet Chrome replay, existing main-cube browser
suite, connection UI suite and offline recording suite pass. Physical completed
solve testing of the new cube remains pending; the release does not claim that
every GAN model or firmware has been physically verified.

Deployed main-timer v175, Cloudflare version
`41d3608f-9495-4073-91c3-322c5a5d6b9f`, from commit `578114d`.
Live version, controller, panels, core, protocol bundle and service worker match
the tested files. The live main-controller browser test also passes with mocked
BLE transport. The existing AdSense verification tag remains singular, the lab
continues serving sync 2, and the raw fixtures/lab worker source return 404 from
the main asset deployment. No database rules or stored user data changed.

## i Carry 4 raw-packet retest — 23 November 2026

Three new reports from 22 November, 23:03–23:26 IST, identify the first patch
build: `4c7c2ad9973b4369951d441f4f3eb5df`,
`3560c634aeff448da3fa18e63182fa00`, and
`b10c8727dc3c47f6a9b9157d6fb72ec2`. They contain 40 live turn packets and 278
state packets, but no decoded events or completed test solves. Native browser
setTimeout/clearTimeout methods were stored on the adapter and invoked with the
adapter as their receiver. Chrome throws Illegal invocation, preventing decoded
events from reaching the page. The earlier Node-based tests did not expose this
browser restriction. Default timer callbacks now call the native methods through
arrow functions. The Chrome regression fails on build 1 and passes on build 2.

All 278 state packets decode into physically valid 8-corner/12-edge states using
the same Gen4 bit layout as the i4 driver. All state counters are zero. The i4
recordings have advancing counters and contain gyro events; these i Carry 4
recordings contain no gyro packets. This establishes shared state/turn decoding,
not the identity of the Bluetooth IC. There are no captured raw i4 packets for a
byte-for-byte comparison, only decoded i4 events.

`tools/verify-gan-carry4-browser.mjs` replays the actual packets in Chrome with
native timers. All 40 turns are emitted in sequence, with no state discrepancies,
invented history requests or adapter-driven disconnects. These captures contain
turn exercises rather than completed solves, so the real-cube solve test remains
open. Version 175 subsequently enabled the adapter as early support in the main timer.

All three captures end at the facelets for R-prime from solved. This is reported
by the cube itself and agrees with the received turns. The owner recalls an older
R2 D2 display offset before the fixes but cannot confirm the latest physical
ending position. These observations do not establish that calibration is needed;
do not automatically reset the hardware state.

Build `carry4-state-sync-2` also restricts packet diagnostics to recognized
state/turn/hardware types. Build 1 captured 0xFF address notifications; existing
build-1 reports can contain those bytes. The new raw regression fixture excludes
0xFF and unrelated packet types, and build 2 does not log them.

Build 2 was deployed to https://tagdatimer.me/smart-cube/ on 23 November 2026,
worker version `ba9451b7-e3db-4c65-aa75-9700efe8bd3f`. Live HTML/JavaScript match
the tested artifacts. Chrome page startup has no errors; the mobile page fits
390 pixels. Main timer v174 remains unchanged. Validation: 25 smart-cube unit
tests, six worker tests, and the real-packet Chrome replay pass.

## GAN i Carry 4 test patch — 22 November 2026

Ten new Smart Cube Lab reports identify GANic4, firmware 1.0. Every decoded
snapshot has serial zero. The stock driver bootstraps its move counter from
that zero and recovers old turns before the connection. In report
`0c52542a4fbf4371991893959dfc2120`, three stale U turns cause a U-prime offset;
the timer saves the second T-perm only after an extra U. Removing that prefix
matches all 106 snapshots from the first connection.

The model-specific adapter in `js/gan-carry4.js` establishes the counter from
the first live move and waits for an independently matching state snapshot
before publishing the initial state. The tester makes one slow turn and undoes
it after each connection. Later snapshot positions are inferred only from
matching turn history, with the original serial retained. Unknown snapshots
hold turn callbacks for up to three seconds; unresolved contradictions interrupt
the attempt. Genuine missing move notifications still use the driver's history
recovery. Other models retain the original driver.

The first test worker recorded build `carry4-state-sync-1` and at most 256 decrypted
notification packets per connection. See the raw-packet retest above for the
browser correction and narrower diagnostics in build 2. The existing seven-day
expiry and upload protections are unchanged.

Validation covers all ten decoded reports, reconstructed decoder inputs, the
T-perm through the actual lab UI, high starting counters, serial wrapping,
600-turn sessions, missing-move recovery, fixed contradiction deadlines and
capture interruption. The main smart-cube unit/browser/connection suites and
the worker API/DOM suite pass. These checks do not establish real radio behavior.
The main-timer source is prepared in this branch; production main-timer assets
remain unchanged pending the tester's real-cube retest of the patched lab.

The patched lab was deployed at https://tagdatimer.me/smart-cube/ on 22 November
2026. Cloudflare worker version: `f22b65ea-67b3-4aa9-a4bb-c3b8f6ba4072`.
The live HTML, JavaScript and CSS match the tested files. The live mobile page
starts without browser errors, and the earlier report remains readable with
its original expiry. Main-timer v174 and its protocol bundle were verified
unchanged. Share the trailing-slash URL; the exact `/smart-cube` route does not
match query strings, while `/smart-cube/` does.

## Connection rows — 21 November 2026

The Cube panel (now titled **Your cubes**) and **Settings → Bluetooth cube**
share a highlighted connection row. Smart cubes have moved out of the general
timing-input chips. Both rows connect through the existing GAN controller and
show the device name, battery, Configure and Disconnect. A connected device on
another timing input offers **Use cube**. Pairing changes the timing input only
after an initial cube state is received; cancelling keeps the previous input.
Disconnecting through either row returns smart cube input to the keyboard.

Opening a row prepares the protocol before enabling Connect cube, so the click
opens the browser chooser with user activation intact. Connection state,
hardware labels and battery updates reach both panels without a redraw.
Drawer cleanup removes connection listeners and cancels stale gear rendering.

Local hardware test: open `http://127.0.0.1:5388/` in Chrome or Edge, choose
**Cube → Connect cube** or **Settings → Bluetooth cube → Connect cube**, then
select the GAN cube in the native Bluetooth picker. Close the drawer, apply the
displayed 3×3 scramble and solve. This URL serves the real timer and protocol;
`smart-cube-placement-demo.html` remains a simulated UI study.

Validation: `npm run test:smart-cube-connection-ui` checks both entry points,
chooser activation, cancellation, automatic input selection, device/battery
updates, Configure, Use cube, Disconnect, search, subscription cleanup, phone
widths and an unsupported browser. Browser pairing is mocked in this check.
`test:smart-cube`, `test:smart-cube-ui` and `test:smart-cube-demo` cover the existing
turn recording, recovery, replay and responsive behavior. Physical pairing is
left for the user's hardware test. This UI ships as release v173.

## GAN i4 release — v172, 21 November 2026

This release is based on the verified v171 production checkout. It adds the
GAN i4 model label and lets observed valid orientation samples take precedence
over gan-web-bluetooth 3.0.2's incomplete Gen4 gyro model list. The library's
original hardware capability flag remains unchanged in saved evidence.

Recorded i4 history arrives as much as 2.004 seconds after its state snapshot,
so the bounded recovery wait is now three seconds. All 4,116 turns across the
three uploaded i4 recordings apply without sequence or state errors. All 26
completed recorded attempts validate. Recovered turns with missing clocks use
estimated receive timing; missing history still interrupts at the fixed deadline.

The release carries hardware-trace, orientation and browser-controller regression
checks, plus a version/cache update. The local recording replay page is not part
of this deployment. No Firebase rules, Worker runtime, bindings or other site
features change. Physical pairing in the main timer and independent timing
accuracy remain outside the recorded/simulated checks.

Implemented 9 November 2026. Select **Settings → Timing input → Smart cube (GAN)**.
This is a local implementation; no site or production database rules were deployed.

## Recording

The first release records standard 3×3 practice (`333`, `wca`). Other events,
trainer modes, virtual sessions, races, Competition Mode, relays, multiphase,
scrambles-only and Scramble of the Day do not arm smart-cube timing. Their
screen offers Keyboard input. Connection and preview can remain active.

Connect one GAN cube, with other cube apps closed. Apply the displayed scramble
until the state matches. With inspection enabled, matching starts inspection
automatically; the next turn starts the solve. Without inspection, matching arms
directly. Cancelling inspection leaves the cube ready for an explicit restart
or for moving away from and returning to the scramble. The first accepted
execution turn starts the timer; the turn producing solved ends it. Inspection uses the existing Timer
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
   check that inspection starts automatically, then solve. Repeat with inspection
   disabled, +2 and DNF.
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
