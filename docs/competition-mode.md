# Competition Mode handover

## Preview

Run `python serve.py 5184 --no-browser` and open <http://localhost:5184>. Select Session → Start Competition Mode. Competition history is next to that action. On phones, those actions are in the Sessions section of the event sheet.

## Automated verification

The revised times list draws each Competition set in its own box, with a set number, attempt numbers and its own recalculated AoX result. The timer's progress control hides during inspection/solving and after leaving the set view. The Competition score card keeps a paper table with a larger round heading and a distinct final-result block.

Whole-set footage now uses the same replay player and export templates as ordinary solves: **Original**, **Landscape**, and **Reel**, including crop selection, progress, cancellation and file sharing. Original retains the filmed dimensions and small watermark; Landscape and Reel retain their existing themed composition with the whole-set attempt clock. The separate paper video template was removed.

The revised UI checks passed in Chrome and Firefox: two distinct Ao5 boxes, numbered attempts, penalty/result refresh, reload persistence, hidden inspection progress, mobile layout, and all three layouts exported from the replay player. The downloaded files were decoded and checked for nonblank frames and dimensions (camera dimensions, 1920×1080 and 1080×1920). Both browsers also passed all 412 existing self-tests.

All 412 `test.html` checks passed in Chrome and Firefox, including Competition scoring and Spanish phone controls. All 50 `sync-test.html` checks passed in Chrome. Disposable browser contexts were used; tests did not access a saved browser profile.

After integrating current `main`, all 448 self-tests passed in Chrome and Firefox. The three video layouts, grouped set UI, database guards and mixed/Ao100 history checks passed too. The headless UI fixture uses a static background, waits for video metadata/attempt markers, and releases the video page before the general suite to avoid competing for graphics/encoding resources. An individual browser can be selected with `node tools/verify-competition-ui.cjs http://localhost:5184 Firefox`.

The focused browser checks cover Ao5/Ao12, custom input validation, refresh at attempt 2 with the original next scramble, member deletion through the database/menu/Delete key, +2 correction and unchanged raw time, exact whole-set removal with unrelated solves preserved, duplicate JSON restores, portrait cards and 375px layout, continuous capture including an inter-attempt gap, one-file MP4 export, and interrupted replay recovery after refresh. Normal keyboard timing, session switching/resumption and a second tab adopting membership/progress also passed.

Database checks cover upgrading IndexedDB v3 while preserving old solves, only one of two concurrent submissions being accepted for the same attempt, rejecting raw-time/membership changes, rejecting mixed partial deletion atomically, validating a corrupt backup before destructive restore, resisting old-backup resurrection and preserving ordinary v1 imports.

Controlled capture checks cover denied camera permission (setup itself requests no camera), short test duration/byte limits, simulated quota exhaustion, a disconnected track, and tab hiding. Timing continued and recorded solves remained available in every case. Real hardware unplug/sleep, sustained 30-minute capture and authenticated cross-device Firebase synchronization still need manual verification.

Recorded fake-camera evidence, about five seconds including gaps:

| Browser | Stored video | Duration | Exported MP4 |
| --- | ---: | ---: | ---: |
| Chrome | 215,243 bytes | 4.82 s | 1,125,848 bytes |
| Firefox | 122,461 bytes | 4.97 s | 1,065,814 bytes |

These are fake-camera files, not estimates of real-camera storage. Capture retains the chosen existing webcam quality and audio behavior. Capture and export hold the existing per-solve conversion queue so it cannot compete for the encoder.

Run focused checks with Playwright available:

```text
node tools/verify-competition.cjs
node tools/verify-competition-data.cjs
node tools/verify-competition-replay.cjs
node tools/verify-competition-ui.cjs
node tools/verify-competition-history.cjs
```

`TAGDA_PLAYWRIGHT_PATH` can point to a bundled Playwright package; `TAGDA_QA_OUTPUT` chooses the screenshot directory for the main check. All default to the preview server on port 5184 and accept the server URL as their first argument.

## Manual release checks

1. With the real camera (and a phone acting as webcam if used), record an Ao5 with several visible gaps. Confirm one continuous replay, matching attempt boundaries, sound if enabled, correct penalties after edits, and a playable full export.
2. Unplug the camera, hide the tab and put the device to sleep mid-set. Confirm interrupted labeling, surviving footage when available, and continued solve recording. Refresh after two attempts and resume the same event/size/scramble.
3. Deploy the updated Firebase rules together with the feature. On two authenticated devices, verify an active set, completion, penalty correction and whole-set deletion. Video must remain on the capture device; reconnecting an offline device must not recreate a deleted average.
4. Check the phone's Session entry point, active strip, attempts, Ao12 score sheet and copy/save/native share using real device sharing targets.

## Data and recording details

The main database upgrades to version 4 with a `competitionSets` store and indexes. Solves and ordered membership commit in one transaction. Whole-set deletion commits solves, metadata, durable deletion bookkeeping and a retryable media-cleanup entry together. Cloud set deletions retain a discarded metadata record to stop stale offline uploads from resurrecting it. Local video uses `tagdatimer-competition-media`; chunks are committed every two seconds and excluded from sync/JSON exports.

Capture caps are 30 minutes and 256 MiB with a 32 MiB quota reserve. Reaching a limit stops capture, keeps saved chunks and leaves timing active. No unrelated clips are pruned to make room. Hidden tabs stop capture explicitly; background capture is not promised. A refresh/closed tab marks unfinished media interrupted. No segmented restart is presented as a seamless replay.

Set scoring calls `averageOf`, `eff` and `trimmedIndices` from the existing statistics module. Size validation accepts safe integers ≥5 without silently clamping. Cards paginate at 12 rows and have the final result on each page. Large set histories/results paginate independently of the timer boundary.

Production deployment remains separate from this pull request. The updated Firebase rules must be published with the feature for authenticated set synchronization.
