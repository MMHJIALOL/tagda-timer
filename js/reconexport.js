/* ===========================================================
   Tagda Timer — export a reconstruction's playback as a GIF

   Loaded on demand, the same way sharedlg.js and the solver worker are:
   most sessions never open this.

   The cube preview's canvas has no preserveDrawingBuffer, so scraping it
   with drawImage() on a raw rAF tick can hand back a blank frame depending
   on exactly when the browser swaps buffers. Two stages sidestep that
   entirely, both built on APIs that are reliable for this:

     1. Record the real playback as WebM with canvas.captureStream() +
        MediaRecorder. captureStream() reads the compositor's output, not
        the WebGL buffer directly, so it does not have the same problem.
     2. Decode that recording back into frames through a hidden <video> —
        a normal 2D drawImage() from a video element is always safe — and
        hand each one to gif.js, vendored in vendor/gifjs/ and run in its
        own worker so encoding never blocks the page.

   Nothing here is shown to the caller until the finished GIF blob: the
   WebM is an internal implementation detail, not a second export option.
   =========================================================== */

const GIF_SRC = new URL('../vendor/gifjs/gif.js', import.meta.url).href;
const GIF_WORKER_SRC = new URL('../vendor/gifjs/gif.worker.js', import.meta.url).href;

/* The canvas is nested a few shadow roots deep — the player's own, and then
   whatever its 3D viewer builds inside that — so a plain querySelector on
   the player's shadowRoot will not find it even once recon.js has forced
   those roots open; querySelector never crosses a shadow boundary, open or
   not. This walks into every open shadow root it meets until it does. */
function findCanvas(root) {
  const direct = root.querySelector('canvas');
  if (direct) return direct;
  for (const node of root.querySelectorAll('*')) {
    if (node.shadowRoot) {
      const found = findCanvas(node.shadowRoot);
      if (found) return found;
    }
  }
  return null;
}

/* recon.js's own comments say it already: "twisty-player restarts itself
   for each attribute it is handed" — writing setup-alg/alg tears down and
   rebuilds its 3D viewer, asynchronously, not in the same tick. Exporting
   right after clicking a suggestion (which just wrote those same attributes
   to show the new position) can catch that rebuild mid-flight, when the
   canvas has been torn down but not yet rebuilt. Retrying past that window
   is simpler and more honest than pretending a single lookup is enough. */
async function waitForCanvas(player, { attempts = 15, intervalMs = 100 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const canvas = player?.shadowRoot && findCanvas(player.shadowRoot);
    if (canvas) return canvas;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

let gifLoaded = null;
async function loadGif() {
  if (gifLoaded !== null) return gifLoaded;
  if (window.GIF) { gifLoaded = true; return true; }
  gifLoaded = await new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = GIF_SRC;
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.head.append(s);
  });
  return gifLoaded;
}

/* ---------------- stage 1: record the playback ---------------- */

/**
 * How long `player` will take to play the alg it currently has queued up,
 * in ms. `TwistyPlayer.timestamp` and friends are write-only from the
 * outside — reading them throws — but `experimentalModel.detailedTimelineInfo`
 * (the same reactive-property mechanism recon.js already reads the camera
 * off of in `watchCamera()`) hands back `timeRange.end` the moment anything
 * subscribes to it, before playback has even started. It only updates on
 * its own when something is actively polling it, like a visible scrubber —
 * with `control-panel` set to `none` nothing is, so this reads it once
 * rather than trying to watch it live.
 */
function playbackDuration(player) {
  return new Promise((resolve) => {
    const timeline = player.experimentalModel?.detailedTimelineInfo;
    if (typeof timeline?.addFreshListener !== 'function') { resolve(null); return; }
    let done = false;
    timeline.addFreshListener((info) => {
      if (done) return;
      done = true;
      resolve(Number.isFinite(info?.timeRange?.end) ? info.timeRange.end : null);
    });
  });
}

/** Record `canvas` for `durationMs`, capped at `maxMs` either way. */
function recordWebm(canvas, durationMs, maxMs) {
  return new Promise((resolve, reject) => {
    if (!canvas.captureStream || typeof MediaRecorder === 'undefined') {
      reject(new Error('This browser cannot record the cube preview'));
      return;
    }
    const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
      .find((t) => MediaRecorder.isTypeSupported(t));
    if (!mime) { reject(new Error('No recordable video format here')); return; }

    const stream = canvas.captureStream(30);
    const rec = new MediaRecorder(stream, { mimeType: mime });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onerror = (e) => reject(e.error || new Error('Recording the cube preview failed'));
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      resolve(new Blob(chunks, { type: mime }));
    };

    // A beat of "solved" at the tail before it loops, not a cut the instant
    // the last turn lands.
    const wait = Math.min(Math.max(durationMs, 0) + 500, maxMs);
    rec.start();
    setTimeout(() => { if (rec.state === 'recording') rec.stop(); }, wait);
  });
}

/* ---------------- stage 2: decode frames ---------------- */

/** Cover-fit `video`'s current frame into a `size`x`size` square. */
function drawFrame(ctx, video, size) {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return;
  const scale = Math.max(size / vw, size / vh);
  const dw = vw * scale, dh = vh * scale;
  ctx.drawImage(video, (size - dw) / 2, (size - dh) / 2, dw, dh);
}

/** Seek `video` to `time` seconds and resolve once that frame has actually
    decoded. `seeked` is universally supported — unlike
    `requestVideoFrameCallback`, which is newer, and which Firefox will
    register without ever actually invoking for a MediaRecorder-sourced
    recording, hanging the export forever with no error at all. */
function seekTo(video, time) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('Seeking the recording timed out')); }, 4000);
    function cleanup() { clearTimeout(timer); video.removeEventListener('seeked', onSeeked); }
    function onSeeked() { cleanup(); resolve(); }
    video.addEventListener('seeked', onSeeked);
    video.currentTime = time;
  });
}

/**
 * Sample `webmBlob` at roughly `fps`, downscaled to a `size`x`size` square.
 * `targetDurationMs` is what we already know the recording covers (from
 * `recordWebm`'s own wait time) — MediaRecorder output routinely reports
 * `Infinity` for `video.duration` until something forces a full scan, on
 * every browser, so this doesn't lean on that being accurate.
 */
async function sampleFrames(webmBlob, { size, fps, maxFrames, targetDurationMs }) {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  // Off-screen, not detached — decode is markedly less reliable for a
  // video that was never actually part of the document.
  video.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;top:0;left:0';
  document.body.append(video);
  const url = URL.createObjectURL(webmBlob);

  function cleanup() { URL.revokeObjectURL(url); video.remove(); }

  try {
    await new Promise((resolve, reject) => {
      const stuck = setTimeout(() => reject(new Error('The recording never loaded')), 8000);
      video.addEventListener('error', () => { clearTimeout(stuck); reject(new Error('Could not decode the recording')); });
      video.addEventListener('loadedmetadata', () => { clearTimeout(stuck); resolve(); }, { once: true });
      video.src = url;
    });

    // Force a real duration out of it: MediaRecorder webm often has no
    // duration in its header, so video.duration reads Infinity until the
    // browser has scanned to the end at least once. Chrome fixes this up
    // on its own eventually; Firefox needs the nudge below every time.
    let duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      duration = await new Promise((resolve) => {
        const fallback = (targetDurationMs || 0) / 1000;
        // This nudge is a well-worn cross-browser fix, not exotic — but
        // nothing here is worth trusting to fire on every browser without
        // a way out, after everything that already hasn't.
        const timer = setTimeout(() => { cleanup(); resolve(fallback || 1); }, 4000);
        const onTimeUpdate = () => { cleanup(); resolve(Number.isFinite(video.duration) ? video.duration : fallback || 1); };
        function cleanup() { clearTimeout(timer); video.removeEventListener('timeupdate', onTimeUpdate); }
        video.addEventListener('timeupdate', onTimeUpdate);
        video.currentTime = 1e10;
      });
    }
    const totalSeconds = Math.max(0.1, Math.min(duration, (targetDurationMs || duration * 1000) / 1000));
    const frameCount = Math.min(maxFrames, Math.max(2, Math.round(totalSeconds * fps)));

    const scratch = document.createElement('canvas');
    scratch.width = size; scratch.height = size;
    const ctx = scratch.getContext('2d', { willReadFrequently: true });

    const frames = [];
    for (let i = 0; i < frameCount; i++) {
      const t = Math.min((i / (frameCount - 1)) * totalSeconds, Math.max(0, totalSeconds - 0.01));
      await seekTo(video, t);
      ctx.clearRect(0, 0, size, size);
      drawFrame(ctx, video, size);
      frames.push(ctx.getImageData(0, 0, size, size));
    }
    return frames;
  } finally {
    cleanup();
  }
}

/* ---------------- stage 3: encode ---------------- */

function encodeGif(frames, { size, fps, onProgress }) {
  return new Promise((resolve, reject) => {
    if (!frames.length) { reject(new Error('Nothing was captured')); return; }
    const gif = new window.GIF({
      workers: 2,
      quality: 10,
      width: size,
      height: size,
      workerScript: GIF_WORKER_SRC,
      repeat: 0,
    });
    gif.on('progress', (p) => onProgress?.(p));
    gif.on('finished', (blob) => resolve(blob));
    gif.on('abort', () => reject(new Error('GIF export was cancelled')));
    for (const frame of frames) gif.addFrame(frame, { delay: 1000 / fps });
    gif.render();
  });
}

/* ---------------- entry point ---------------- */

/**
 * Export whatever alg `player` already has queued up as a looping GIF.
 * `player` must already be mounted AND cued up — setup-alg, alg and
 * jumpToStart all set the same way recon.js's own `showCube()` does it,
 * `canonical()` included, *before* this is called. Getting the cube onto
 * the right position is recon.js's job, same as everywhere else in the
 * workbench; this only captures what plays.
 */
/* Temporary while this feature is still being shaken out across browsers —
   logs which stage is running and how long each one took, so a stuck
   export tells us where, not just that it eventually timed out. */
const stageLog = (label, t0) => console.log(`[recon] export gif — ${label}${t0 ? ` (${Math.round(performance.now() - t0)}ms)` : ''}`);

async function runExport({ player, moveCount, size, fps, maxSeconds, onProgress }) {
  let t = performance.now();
  stageLog('loading gif.js');
  if (!await loadGif() || !window.GIF) throw new Error('Could not load the GIF encoder');
  stageLog('gif.js ready', t); t = performance.now();

  stageLog('waiting for the cube canvas');
  const canvas = await waitForCanvas(player);
  if (!canvas) throw new Error('Cube preview unavailable');
  stageLog('canvas found', t); t = performance.now();

  const fallbackMs = moveCount * 1000;   // roughly what a move costs when the timeline API is unreadable
  stageLog('reading playback duration');
  const durationMs = (await playbackDuration(player)) ?? fallbackMs;
  stageLog(`duration ${durationMs}ms`, t); t = performance.now();

  stageLog('starting recording');
  // The same beat-of-"solved" wait recordWebm actually applies internally —
  // kept in step here so sampleFrames knows the real recorded span without
  // trusting the recording's own (often-Infinity) reported duration.
  const recordedMs = Math.min(Math.max(durationMs, 0) + 500, maxSeconds * 1000);
  const recording = recordWebm(canvas, durationMs, maxSeconds * 1000);
  // showCube()'s own comment explains why this can't just be called here
  // directly: writing a fresh position and starting the animation in the
  // same tick makes the player re-seat instead of actually playing. Waiting
  // a frame first is what makes play() reliably take.
  await new Promise((r) => requestAnimationFrame(r));
  try { player.play?.(); } catch { /* ignore */ }

  const webm = await recording;
  stageLog(`recorded ${webm.size}B ${webm.type}`, t); t = performance.now();

  stageLog('decoding frames');
  const frames = await sampleFrames(webm, { size, fps, maxFrames: fps * maxSeconds, targetDurationMs: recordedMs });
  stageLog(`decoded ${frames.length} frames`, t); t = performance.now();

  // A one-frame "animation" is a recording that silently failed, not a short
  // solve — surface that rather than handing back a still image with a .gif
  // extension. Two-move solves still clear this easily at 15fps.
  if (frames.length < 2) throw new Error('Could not capture the animation — try again');

  stageLog('encoding gif');
  const gif = await encodeGif(frames, { size, fps, onProgress });
  stageLog(`encoded ${gif.size}B`, t);
  return gif;
}

export async function exportReconGif({
  player, moveCount = 0, size = 480, fps = 15, maxSeconds = 8, onProgress,
} = {}) {
  // Every stage already bounds itself, but they chain through browser APIs
  // (MediaRecorder, video decode) this code does not control — this is the
  // backstop that guarantees the button in recon.js always comes back,
  // rather than trusting that every layer's own timeout actually fires.
  return Promise.race([
    runExport({ player, moveCount, size, fps, maxSeconds, onProgress }),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error('Export timed out')), maxSeconds * 1000 + 15000,
    )),
  ]);
}
