# Memory: baseline and results

Measured for RAM-OPTIMISATION-PLAN.md on 2026-10-14, Windows 11, Chrome
(channel `chrome`) and Playwright Firefox, both headless, each run in a
fresh profile on disk. "Before" is main at #180 (v129); "after" is the whole
stack (counts, cubes, workers, replay, stats).

    python serve.py 5199 --no-browser
    python tools/ram-measure.py http://localhost:5199 --browser chrome --solves 20000

## How to read the numbers

- **JS heap** (Chrome only) is after a forced GC, so it is steady between
  runs and is the number to compare. **Boot peak** is the highest JS heap
  seen while the page boots, without a forced GC: a list built once and then
  dropped never shows at idle, only there.
- **Private MB** is every browser process the run started, added up. It moves
  by ±100 MB between identical runs (GPU process, camera, compositor), so
  only large differences in it mean anything. Firefox gives nothing else.
- Playwright's default context keeps IndexedDB **in memory**, which counts
  every stored solve and clip as RAM. The script runs in a profile on disk;
  an earlier run without one made chunked recording look worse than it is.

## Solves, stats panel, cubes (Chrome, JS heap MB)

| Moment | 200 before | 200 after | 20,000 before | 20,000 after |
|---|---|---|---|---|
| Boot peak | 8.6 | 8.2 | **25.1** | **15.6** |
| Fresh load, idle 30 s | 6.0 | 6.0 | 6.4 | 6.5 |
| After 20 solves | 7.3 | 7.3 | 7.8 | 7.8 |
| Stats panel, this session | 7.6 | 7.6 | 8.3 | 8.3 |
| Stats panel, all sessions | 8.4 | 8.4 | 15.1 | 15.1 |
| Stats panel closed | 8.4 | 8.4 | **15.2** | **8.9** |
| Virtual cube on | 8.9 | 8.9 | 9.0 | 8.9 |
| Virtual cube off | 8.9 | 8.7 | 9.5 | 9.2 |

- Boot peak: the session badges no longer read all 20,000 solves.
- Stats panel closed: the drawer is emptied on close, so "All sessions" no
  longer keeps every solve alive.
- `twisty-player` elements after leaving virtual mode: 2 before, 1 after.
  DOM nodes with the stats panel closed: 3,026 before, 1,391 after.

"Show cube" off (Chrome, 200 solves): JS heap at idle 3.7 MB before,
3.3 MB after, and no `twisty-player` and no twisty.js request at all
(before, the preview was built and hidden).

Firefox private MB, same moments, moved within its own noise (1,128 to
1,287 MB before, 1,140 to 1,238 MB after); nothing in it contradicts the
Chrome figures, and nothing in it is precise enough to add to them.

## Webcam replay while filming (Chrome, Full HD fake camera)

A 2-minute recording (228 MB clip), private MB above the moment the
attempt started, sampled every 5 s:

| | 10 s | 60 s | 120 s |
|---|---|---|---|
| Before (whole clip in the recorder) | +248 | +367 | **+552** |
| After (2 s chunks written as they arrive) | +170 | +107 | **+106** |

The same clip either way: 3,618 and 3,632 packets, 232 keyframes. Apart
from the camera itself, before held the clip in the page until the stop
(in a bare recorder test, 76 MB of page memory for a 77 MB clip).

## Converting clips

Seeks on a 12 s 720p clip, median of 40 random seeks:

| | Recorder file | Remuxed (seek index, no re-encode) | Re-encoded |
|---|---|---|---|
| Chrome | 52 ms | 57 ms | 54 ms (2.3 s to make) |
| Firefox | 423 ms | 316 ms | 60 ms (15 s to make) |

So Chrome clips, whose keyframes already come every half second, are kept
as recorded; Firefox clips still convert in the background.

## Workers

After X+1 is closed, its solver worker is gone 20 s later and back on the
next question. After 5 idle minutes the Square-1 worker is gone too; on
switching back to Square-1 (Firefox, service worker on) the first scramble
took 0.5 s (from the queue's stash), the next 1.9 s, the rest as usual.
