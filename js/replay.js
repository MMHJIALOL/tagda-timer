import { t } from './i18n.js';
/* ===========================================================
   Tagda Timer — webcam replay

   With the setting on, every attempt on the main timer is filmed, from the
   press (or the start of inspection) until a second after the stop, and kept
   against its solve. The solve menu, W for the last solve and the stats rows
   play it back with the clock running in a bar under the picture, never on
   top of the cube.

   Local only, on purpose. Clips live in an IndexedDB database of their own,
   so nothing here can reach sync, the backup file or another device. It is a
   separate database rather than one more store in 'tagdatimer' because a new
   store means a version bump, and a version bump waits for every tab still
   running the old code to let go of the database: the freshly loaded tab sat
   on a blank timer until the old one was closed.

   One way out, and only when asked: a Scramble of the Day clip can be shared
   (js/sotd-replays.js, DAILY.md §8). That uploads a copy, made from the clip
   here, when Share replay is pressed or "Always share my SOTD replay" is on.
   It never changes or deletes the clip on this device, and nothing else is
   ever uploaded.

   A clip is handed straight to its solve. main.js takes it the moment the
   timer stops (takeClip) and gives it the solve once one is recorded, so a
   misfire thrown away is simply never saved, and nothing has to guess which
   solve a clip belongs to from timestamps. The newest `webcamKeep` (50, 200
   or 1000) are kept, within a budget per clip for the quality picked
   (CLIP_BYTES for Standard and HD, FHD_CLIP_BYTES for Full HD) and never more
   than half of what the browser lets this site store. A PB single's clip is
   pinned and never pruned, and so is any clip pinned by hand in the player.

   Quality is Standard (640x480), HD (1280x720) or Full HD (1920x1080). Full
   HD is offered only where the camera can film it, or where that is not
   known (canFullHd), and the preview says when it is slower than 24 fps or
   smaller than asked.

   Recorders put a keyframe in only every six or seven seconds, so every seek
   decoded up to 200 frames and stepping back and forth glitched. Chrome takes
   a keyframe interval; Firefox ignores it. So once a clip is saved, and only
   while the timer is idle, it is converted (replay-media.js, Mediabunny) to a
   WebM with a keyframe every half second and a seek index, its frame times
   read back out of the result. Starting an attempt pauses a conversion in
   flight; it carries on when you are idle. A clip whose keyframes are
   already that close (Chrome's, seeksWell) is kept as it is, with its frame
   times noted, since converting it changed nothing you could see.

   The camera is any video input the browser can see (a phone connected as a
   webcam included), picked in Settings and remembered by id and by name. It
   is on only while it is needed: from the press (or the start of inspection)
   until the clip's last second is filmed, and while a preview is on screen to
   aim it with. Then it is let go, light and all, and the next press wakes it.
   A hidden tab lets it go at once. "Keep the camera on between solves"
   (webcamKeepOn) holds it instead, for solving without inspection, where the
   second it takes to wake would cost the start of the clip. It is never
   asked for in a way that could put a permission prompt over a held
   spacebar unless permission was already given on this page.

   Sync. The first frame in a clip is the newest one the camera had delivered
   when MediaRecorder.start() was called: measured in Chrome and Firefox, it
   was captured anywhere from 0 to one frame before the call, so video time 0
   is taken as half a frame before it (±17 ms at 30 fps), less however long
   the camera takes to deliver a frame. Chrome reports that through
   requestVideoFrameCallback's captureTime; Firefox does not. Whatever is left,
   the player's Sync control fixes once per camera: pause on the frame where
   your hand stops the timer and press "Stopped here".

   Sound is opt-in ("Record sound", webcamSound): it records voices too. The
   mic is its own getUserMedia beside the camera's, so a refused mic never
   costs the picture, and it comes and goes with the camera (cam.mic). Which
   mic: the one picked in Settings (webcamMic, by id and then by name), else
   the camera's own (the audioinput sharing its groupId), else the system
   default. With the Stackmat as the input, never the device the Stackmat is
   listening on: another mic if there is one, else video only, and the line
   under the preview says why. Raw, as the Stackmat takes it (echo
   cancellation, noise suppression and gain control off, one channel), and
   Opus at about 48 kbps.

   The player reads the frame times out of the clip itself (webmFrames). The
   browsers disagree about what time a paused frame is at (Firefox reports
   the time asked for, not the frame's own), and webcam frames do not come
   evenly, so the file is the only thing that knows where each frame is.
   =========================================================== */

import { el, fmt, fmtLive } from './util.js';
import { replayStore, replayRequest as wrap } from './replay-store.js';
import { replayJournal, commitJournaledReplay, inspectLegacyChunks } from './replay-journal.js';
import { toast, confirmToast } from './toast.js';
import { featureOff } from './audience.js';

const KEEP_DEFAULT = 200;
const CLIP_BYTES = 12 * 1024 * 1024;     // room budgeted per kept clip at Standard and HD: about a 30 s HD solve
// At Full HD, with room for a 30 s solve: on a busy test picture its stored
// copy measured 18.3 MB in Chrome and 21.3 MB in Firefox (HD's 12.6 and 14.5).
const FHD_CLIP_BYTES = 24 * 1024 * 1024;
const TAIL_MS = 1000;                    // keep filming this long after the stop
const MAX_MS = 10 * 60 * 1000;           // a clip stops growing here (multi-blind)
const IDLE_MS = 10 * 60 * 1000;          // kept on between solves: let go after this long without one
/* Full HD's 5 Mbps is where the picture stops getting better: against the
   source, 3 Mbps measured 33.1 dB, 4 Mbps 33.7, 5 Mbps 34.1, 8 Mbps 34.2.
   `clip`: the room budgeted per kept clip, so Keep 200 still means about 200. */
const QUALITY = {
  sd: { width: 640, height: 480, bps: 1_000_000, clip: CLIP_BYTES },
  hd: { width: 1280, height: 720, bps: 2_500_000, clip: CLIP_BYTES },
  fhd: { width: 1920, height: 1080, bps: 5_000_000, clip: FHD_CLIP_BYTES },
};
/* Full HD is a long side of 1920 and a short side of 1080: a phone held
   upright films 1080x1920, and that counts. */
const isFullHd = (w, h) => Math.max(w, h) >= 1920 && Math.min(w, h) >= 1080;
const LOW_FPS = 24;                      // Full HD slower than this: the preview says so

/* The first format this browser can both record and play back. VP8 first: it
   is the cheapest of them to encode, which is CPU the timer keeps. Safari
   records only MP4. */
const VIDEO_TYPES = ['video/webm;codecs=vp8', 'video/webm', 'video/mp4;codecs=avc1', 'video/mp4'];
const firstType = (types) => {
  if (typeof document === 'undefined' || !globalThis.MediaRecorder?.isTypeSupported) return '';
  const v = document.createElement('video');
  return types.find(m => MediaRecorder.isTypeSupported(m) && v.canPlayType(m)) || '';
};
const MIME = firstType(VIDEO_TYPES);
// With sound: VP8 and Opus, else whatever the browser pairs with the plain types.
const MIME_AV = firstType(['video/webm;codecs=vp8,opus', ...VIDEO_TYPES]);
const MIC_BPS = 48_000;
// The Stackmat's settings, for the same reason: speech clean-up mangles the sound of a solve.
const RAW = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 };
export const replaySupported = () => !!MIME && !!navigator.mediaDevices?.getUserMedia;
/** Why filming is switched off from the admin console (features.webcamReplay, ADMIN.md §4), or null. */
export const replayOff = () => featureOff('webcamReplay', t('Webcam replays are switched off for now'));

let app = null;                          // main.js's app: settings, setSetting, persist
const S = () => app?.settings || {};
const quality = () => QUALITY[S().webcamQuality] || QUALITY.sd;
let timer = null;
let enabled = false;
let perm = 'unknown';                    // the camera permission: granted | denied | prompt | unknown
let grantedHere = false;                 // a getUserMedia succeeded on this page
let asked = false;                       // the "allow the camera?" toast has had its one go
let micPerm = 'unknown';                 // the microphone permission, as perm
let micGranted = false;                  // a mic getUserMedia succeeded on this page
let stackmatMic = () => null;            // main.js: null unless the Stackmat is the input, else its track's { deviceId, groupId }
const warned = new Set();                // problems already reported this page load

let camP = null;                         // Promise<Cam> while the camera is opening or open
let cam = null;                          // the open camera
let idleTimer = 0;
let previewing = 0;                      // previews on screen: the camera stays on for aiming
const keepOn = () => !!S().webcamKeepOn;
const watchers = new Set();              // the settings preview, told about every change

let rec = null;                          // the attempt being filmed
const ids = new Set();                   // solve ids with a clip, so menus can ask synchronously
const saving = new Map();                // solve id -> its save, for a replay opened before it lands
const unsaved = new Map();               // usable Blobs retained until their final commit succeeds
const captures = new Map();              // accepted recordings, for explicit discard/delete
let saveError = null;
let active = 0;                          // recorders running, for the top bar's red dot
const listeners = new Set();

/* main.js listens: the top-bar button's state, the Replay pill and the
   times list's play buttons all follow what happens here. */
export function onReplayChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(what) {
  for (const fn of listeners) { try { fn(what); } catch (err) { console.warn('[replay] listener', err); } }
}
export const replayStatus = () => ({ enabled, live: !!cam, recording: active > 0 });
export const replaySaveStatus = () => ({ pending: saving.size, unsaved: unsaved.size, error: saveError?.message || '' });

/* ---------------- storage ---------------- */

async function putClip(meta, blob, { recover = false } = {}) {
  // Detach ordinary-sized clips from IDB-backed source Blob references before
  // writing another database. Larger clips keep their independently durable
  // journal until the destination has committed as well.
  if (blob.size <= 64 * 1024 * 1024) {
    let deadline;
    try {
      const data = await Promise.race([blob.arrayBuffer(), new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new DOMException('Recording bytes could not be read; recovery copy retained', 'TimeoutError')), 15000);
      })]);
      blob = new Blob([data], { type: blob.type });
    } finally { clearTimeout(deadline); }
  }
  return replayStore.run('readwrite', async tr => {
    if (recover) {
      const [existing, video] = await Promise.all([wrap(tr.objectStore('meta').get(meta.id)), wrap(tr.objectStore('video').get(meta.id))]);
      if (existing && video) return false;
    }
    tr.objectStore('meta').put(meta);
    tr.objectStore('video').put(blob, meta.id);
    return true;
  });
}

const allClipMeta = () => replayStore.run('readonly', tr => wrap(tr.objectStore('meta').getAll()), ['meta']);
export const listReplays = async () => (await allClipMeta()).sort((a, b) => b.at - a.at);

/** Rebuild the menu index without treating a failed read as an empty library. */
export async function refreshReplays() {
  const keys = await replayStore.run('readonly', tr => wrap(tr.objectStore('meta').getAllKeys()), ['meta']);
  ids.clear();
  keys.forEach(id => ids.add(id));
  for (const id of saving.keys()) ids.add(id);
  for (const id of unsaved.keys()) ids.add(id);
  emit({ type: 'saved' });
  return keys.length;
}

export const keepCount = () => [50, 200, 1000].includes(+S().webcamKeep) ? +S().webcamKeep : KEEP_DEFAULT;

/* Oldest unpinned first, until there are no more than keepCount() of them and
   the whole lot (pinned ones included, plus `room` for one about to be written)
   fits the budget. The newest clip is never the one to go. */
async function prune(room = 0) {
  let limit = keepCount() * quality().clip;
  try {
    const est = await navigator.storage?.estimate?.();
    if (est?.quota) limit = Math.min(limit, est.quota * 0.5);
  } catch { /* no estimate: the count and the per-clip budget still hold */ }
  const gone = await replayStore.run('readwrite', async tr => {
    const all = (await wrap(tr.objectStore('meta').getAll())).sort((a, b) => b.at - a.at);
    let bytes = room + all.reduce((n, m) => n + (m.bytes || 0), 0);
    const loose = all.filter(m => !m.pinned);
    let count = loose.length;
    const removed = [];
    for (let i = loose.length - 1; i >= 1 && (count > keepCount() || bytes > limit); i--) {
      const m = loose[i];
      tr.objectStore('meta').delete(m.id);
      tr.objectStore('video').delete(m.id);
      removed.push(m.id);
      count--;
      bytes -= m.bytes || 0;
    }
    return removed;
  });
  gone.forEach(id => ids.delete(id));
  if (gone.length) emit({ type: 'removed', ids: gone });
}

/** One field or two on a clip's metadata, if the clip is still there. */
async function patchMeta(id, patch) {
  return replayStore.run('readwrite', async tr => {
    const m = await wrap(tr.objectStore('meta').get(id));
    if (m) tr.objectStore('meta').put({ ...m, ...patch });
    return !!m;
  });
}

/** Pinned clips are never pruned. A PB single's is pinned when it is saved. */
export async function setPinned(id, pinned) {
  await patchMeta(id, { pinned: !!pinned });
  emit({ type: 'pinned', id, pinned: !!pinned });
  if (!pinned) prune().catch(() => {});
}

export async function deleteClip(id) {
  const capture = captures.get(id);
  if (capture) await discardCapture(capture);
  unsaved.delete(id);
  for (const entry of await replayJournal.list()) if (entry.meta?.id === id) await replayJournal.remove(entry.id);
  await replayStore.run('readwrite', tr => {
    tr.objectStore('meta').delete(id);
    tr.objectStore('video').delete(id);
  });
  ids.delete(id);
  emit({ type: 'removed', ids: [id] });
}

export async function loadClip(id) {
  if (unsaved.has(id)) return unsaved.get(id);
  await saving.get(id);
  if (unsaved.has(id)) return unsaved.get(id);
  const [meta, blob] = await replayStore.run('readonly', tr => Promise.all([
    wrap(tr.objectStore('meta').get(id)), wrap(tr.objectStore('video').get(id)),
  ]));
  return meta && blob ? { meta, blob } : null;
}

/** A clip's metadata alone (no video read), or null. */
export async function clipMeta(id) {
  if (unsaved.has(id)) return unsaved.get(id).meta;
  await saving.get(id);
  if (unsaved.has(id)) return unsaved.get(id).meta;
  return (await replayStore.run('readonly', tr => wrap(tr.objectStore('meta').get(id)), ['meta'])) || null;
}

export async function replayUsage() {
  const all = await allClipMeta();
  return {
    count: all.length,
    pinned: all.filter(m => m.pinned).length,
    bytes: all.reduce((n, m) => n + (m.bytes || 0), 0),
  };
}

export async function clearReplays() {
  pauseFinish();
  dropFinish();
  finishQueue.length = 0;
  await Promise.all([...captures.values()].map(discardCapture));
  await replayJournal.clear();
  unsaved.clear();
  await replayStore.run('readwrite', tr => {
    tr.objectStore('meta').clear();
    tr.objectStore('video').clear();
  });
  const gone = [...ids];
  ids.clear();
  emit({ type: 'removed', ids: gone });
}

/** A read-only scan. A failed store is reported separately from an empty one. */
export async function scanReplayRecovery() {
  const [journal, legacy] = await Promise.allSettled([replayJournal.list(), inspectLegacyChunks()]);
  const byKey = new Map();
  if (journal.status === 'fulfilled') for (const row of journal.value) if (row.chunks) {
    byKey.set(row.id, { ...row, complete: !!(row.finished && row.expectedChunks === row.chunks),
      active: !row.finished && Date.now() - row.updatedAt < MAX_MS + 60000 });
  }
  for (const row of unsaved.values()) byKey.set(row.key, { id: row.key, at: row.meta.at, meta: row.meta,
    bytes: row.blob.size, complete: true, memory: true, playable: true });
  const recordings = [...byKey.values(), ...(legacy.status === 'fulfilled' ? legacy.value : [])].sort((a, b) => b.at - a.at);
  return { recordings, errors: [journal, legacy].filter(r => r.status === 'rejected').map(r => r.reason?.message || 'Storage unavailable') };
}

export async function readRecoveryRecording(candidate) {
  if (candidate.legacy) return candidate;
  const memory = [...unsaved.values()].find(row => row.key === candidate.id);
  return memory ? { ...memory, complete: true, playable: true } : replayJournal.read(candidate.id);
}

export async function recoverRecording(candidate) {
  const got = await readRecoveryRecording(candidate);
  if (!got?.complete || !got.meta?.id || got.meta.partial) throw new Error(t('Only surviving footage is available. Download it as a partial recording.'));
  const meta = { ...got.meta, bytes: got.blob.size, mime: got.blob.type || got.meta.mime };
  await commitJournaledReplay({ journal: replayJournal, id: candidate.id, meta, blob: got.blob,
    write: (meta, blob) => putClip(meta, blob, { recover: true }) });
  unsaved.delete(got.meta.id); captures.delete(got.meta.id); saveError = null; ids.add(got.meta.id);
  emit({ type: 'saved', id: got.meta.id });
  return got.meta.id;
}

/* ---------------- converting for smooth seeking ---------------- */

const finishQueue = [];                  // clip ids still in the recorder's own format
let finishing = null;                    // { id, job, pause } for the clip being re-encoded (maybe paused)
let finishBusy = false;                  // a runFinish() is under way
let finishTimer = 0;
let finishHolds = 0;                     // exports under way: the encoder is theirs
let mediaP = null;
const media = () => (mediaP ??= import('./replay-media.js').catch((err) => { mediaP = null; throw err; }));
const timerBusy = () => !!timer && timer.state !== 'idle' && timer.state !== 'cooldown';

function queueFinish(id, front = true) {
  if (finishQueue.includes(id)) return;
  if (front) finishQueue.unshift(id); else finishQueue.push(id);
  scheduleFinish();
}

function scheduleFinish(delay = 1500) {
  clearTimeout(finishTimer);
  if (finishQueue.length) finishTimer = setTimeout(runFinish, delay);
}

/** An attempt is starting: give it the CPU. A re-encode under way pauses, to be picked up later. */
function pauseFinish() {
  clearTimeout(finishTimer);
  finishing?.pause?.abort();
}

/**
 * A video is being made from a clip: the re-encode waits, so the two are not
 * fighting over the encoder (Firefox's can fail under that). Returns the
 * function that lets it carry on.
 */
export function holdFinish() {
  finishHolds++;
  pauseFinish();
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    finishHolds--;
    scheduleFinish();
  };
}

function dropFinish() {
  finishing?.job?.cancel();
  finishing = null;
}

async function runFinish() {
  if (finishBusy || !finishQueue.length) return;
  if (rec || timerBusy() || document.hidden || finishHolds) return scheduleFinish(4000);
  const id = finishQueue[0];
  finishBusy = true;
  const unqueue = () => { const i = finishQueue.indexOf(id); if (i >= 0) finishQueue.splice(i, 1); };
  const done = () => { unqueue(); finishing = null; };
  try {
    if (finishing?.id !== id) {
      dropFinish();
      const got = await loadClip(id);
      if (!got || got.meta.conv) { done(); return; }
      // A Full HD clip is encoded again at the recorder's own rate: left to
      // itself Mediabunny picks about 7.3 Mbps there, a third bigger than the
      // recording for no difference you can see (33.98 against 33.91 dB, a
      // 15 s clip 13.2 MB against 9.1). Others get what they always have.
      // Already seekable (Chrome): keep the recording, just note its frame times.
      const frames = await (await media()).seeksWell(got.blob).catch(() => null);
      if (frames) {
        await patchMeta(id, { conv: 'keys', frames });
        done();
        emit({ type: 'converted', id });
        return;
      }
      const fhd = isFullHd(got.meta.w || 0, got.meta.h || 0);
      const job = await (await media()).prepareFinish(got.blob, undefined, fhd ? QUALITY.fhd.bps : undefined);
      if (!job) { await patchMeta(id, { conv: 'skip' }); done(); return; }   // nothing here can encode it: the original stays
      finishing = { id, job };
    }
    const pause = finishing.pause = new AbortController();
    if (!(await finishing.job.run(pause.signal))) return;              // paused for an attempt: resumes from here
    const out = await finishing.job.result();
    await replayStore.run('readwrite', async tr => {
      const m = await wrap(tr.objectStore('meta').get(id));
      if (m) {
        tr.objectStore('meta').put({ ...m, conv: 1, mime: out.blob.type, bytes: out.blob.size, frames: out.frames });
        tr.objectStore('video').put(out.blob, id);
      }
    });
    done();
    emit({ type: 'converted', id });
  } catch (err) {
    console.warn('[replay] could not convert', err);
    dropFinish();
    unqueue();
    patchMeta(id, { conv: 'failed' }).catch(() => {});
  } finally {
    finishBusy = false;
    // Off the queue, however it ended: anything waiting on it (clipReady) can go on.
    if (!finishQueue.includes(id) && finishing?.id !== id) emit({ type: 'finished', id });
    scheduleFinish();
  }
}

/**
 * Resolves once a clip is saved and, if it was waiting to be converted, done
 * converting (or `ms` later): for a copy made from it, so the two encodes
 * never run at once. Resolves whether or not there turns out to be a clip.
 */
export async function clipReady(id, ms = 90_000) {
  // Sharing/export needs the filmed Blob, not acknowledgement from a separate
  // final database. The independent journal and memory fallback protect it.
  if (captures.has(id)) await captures.get(id).done;
  if (!unsaved.has(id)) await saving.get(id);
  const pending = () => finishQueue.includes(id) || finishing?.id === id;
  if (!pending()) return;
  await new Promise((resolve) => {
    let off = () => {};
    const done = () => { clearTimeout(timer); off(); resolve(); };
    const timer = setTimeout(done, ms);
    off = onReplayChange(() => { if (!pending()) done(); });
    if (!pending()) done();
  });
}

/* ---------------- the camera ---------------- */

const stopStream = (s) => s?.getTracks().forEach(tr => tr.stop());
/* The camera and its mic, lights and all. A mic still opening is stopped when it lands (adoptMic). */
const stopCam = (c) => { c.dead = true; stopStream(c.stream); stopStream(c.mic?.stream); c.mic = null; };
const camKey = () => `${S().webcamDevice || ''}|${S().webcamQuality || 'sd'}`;
const notify = (err = null) => { for (const fn of watchers) fn(cam, err); emit({ type: 'state' }); };

/** Every video input, labelled once permission has been given. */
export async function listCameras() {
  try {
    return (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
  } catch { return []; }
}

/* Android names them "camera2 1, facing front". */
export function cameraName(label, i = 0) {
  if (!label) return t('Camera {n}', { n: i + 1 });
  if (/facing front/i.test(label)) return t('Front camera');
  if (/facing back/i.test(label)) return t('Back camera') + (/^camera2 0\b/.test(label) ? '' : ` (${label.split(',')[0]})`);
  return label;
}

/* ---------------- the microphone ---------------- */

const soundOn = () => !!S().webcamSound;
const PSEUDO = new Set(['default', 'communications']);   // Chrome's stand-ins for the system's choice
const denied = (err) => err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError';

/** main.js: where the Stackmat is listening, while it is the input. */
export function setStackmatMic(fn) { stackmatMic = fn; }
/** The Stackmat's input ({ deviceId, groupId }) while it is the one timing, else null — for any other mic to keep off. */
export const stackmatInput = () => stackmatMic();

/* What the open mic was chosen against: when any of it changes, it is chosen again. */
const micKey = () => {
  const sm = stackmatMic();
  return `${soundOn() ? 1 : 0}|${S().webcamMic || ''}|${sm ? sm.deviceId || '?' : '-'}`;
};

/** Every audio input, labelled once permission has been given (Chrome's stand-ins left out). */
export async function listMics() {
  try {
    return (await navigator.mediaDevices.enumerateDevices())
      .filter(d => d.kind === 'audioinput' && d.deviceId && !PSEUDO.has(d.deviceId));
  } catch { return []; }
}

/**
 * Which mic to record from: { deviceId, label } ('' for the system default),
 * or { none: 'stackmat' } when every mic left is the Stackmat's. `sm` is the
 * Stackmat's track ({ deviceId, groupId }; deviceId '' while it opens, when
 * the default is taken to be its), null when the Stackmat is not the input.
 */
export function chooseMic(devs, { want = '', wantLabel = '', camGroup = '', sm = null } = {}) {
  const mics = devs.filter(d => d.kind === 'audioinput' && d.deviceId);
  const real = mics.filter(d => !PSEUDO.has(d.deviceId));
  // The system default: Chrome lists it as 'default' (with the real device's groupId), Firefox lists it first.
  const def = mics.find(d => d.deviceId === 'default') || real[0] || null;
  const smDev = sm && (sm.deviceId ? mics.find(d => d.deviceId === sm.deviceId) : def);
  const smGroup = sm ? sm.groupId || smDev?.groupId || '' : '';
  const taken = (d) => !!sm && (d === smDev || d.deviceId === sm.deviceId || (!!smGroup && d.groupId === smGroup));
  const pick = (d) => ({ deviceId: d.deviceId, label: d.label });
  if (want) {
    const d = real.find(x => x.deviceId === want) || (wantLabel ? real.find(x => x.label === wantLabel) : null);
    if (d && !taken(d)) return pick(d);
  }
  const free = real.filter(d => !taken(d));
  const own = camGroup ? free.find(d => d.groupId === camGroup) : null;
  if (own) return pick(own);
  if (!sm) return { deviceId: '', label: def?.label || '' };
  if (def && !taken(def)) return { deviceId: '', label: def.label };
  return free[0] ? pick(free[0]) : { none: 'stackmat' };
}

/* Resolves, never rejects: { stream, track, label } or { off: why }.
   `prompt`: this is a click, so the browser may ask. Otherwise a mic this page
   has not been given is left alone, as the camera is, rather than putting a
   prompt over a held spacebar. */
async function openMic(camGroup, prompt = false) {
  if (!soundOn()) return { off: 'setting' };
  if (!prompt && !micGranted && micPerm !== 'granted' && micPerm !== 'unknown') return { off: micPerm === 'denied' ? 'denied' : 'perm' };
  const devs = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  const pick = chooseMic(devs, { want: S().webcamMic || '', wantLabel: S().webcamMicLabel || '', camGroup, sm: stackmatMic() });
  if (pick.none) return { off: pick.none };
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { ...RAW, ...(pick.deviceId ? { deviceId: { exact: pick.deviceId } } : {}) },
    });
  } catch (err) {
    return { off: denied(err) ? 'denied' : 'failed', err };
  }
  micGranted = true;
  const track = stream.getAudioTracks()[0];
  const st = track?.getSettings?.() || {};
  // Whatever was asked for, never the input the Stackmat is reading.
  const sm = stackmatMic();
  if (!track || (sm && st.deviceId && (st.deviceId === sm.deviceId || (sm.groupId && st.groupId === sm.groupId)))) {
    stopStream(stream);
    return { off: track ? 'stackmat' : 'failed' };
  }
  return { stream, track, label: track.label || pick.label || t('Microphone') };
}

/* Once per page load, and short: the clip is still filmed, only silent. */
function micFailed(err) {
  console.warn('[replay] microphone', err);
  if (warned.has('mic')) return;
  warned.add('mic');
  toast(t('No microphone, filming without sound'), { kind: 'bad' });
}

/* A mic being opened for camera `c`, adopted when it lands; dropped if the
   camera went, or another mic was asked for, in the meantime. */
function adoptMic(c, p) {
  c.mic = null;
  c.micOff = '';
  c.micKey = micKey();
  const w = c.micWait = p.then((m) => {
    if (c.micWait !== w || c.dead) { stopStream(m.stream); return; }
    c.mic = m.stream ? m : null;
    c.micOff = m.off || '';
    if (m.stream) m.track.onended = () => { if (c.mic === m) { c.mic = null; c.micOff = 'lost'; notify(); } };
    if (m.off === 'denied' || m.off === 'failed') micFailed(m.err);
    if (cam === c) notify();
  });
  return w;
}

/* Choose and open the mic again on an open camera: the setting, the mic or the Stackmat changed. */
function setMic(c, prompt = false) {
  stopStream(c.mic?.stream);
  adoptMic(c, openMic(c.group, prompt));
  notify();
}

/**
 * The "Record sound" toggle: a click, so the mic may be asked for here.
 * Resolves whether it can go on; a refusal explains itself.
 */
export async function enableSound() {
  if (micGranted || micPerm === 'granted') return true;
  try {
    stopStream(await navigator.mediaDevices.getUserMedia({ audio: RAW }));
    micGranted = true;
    return true;
  } catch (err) {
    toast(denied(err) ? t('Microphone permission denied, replays stay silent') : t('Could not open a microphone'), { kind: 'bad' });
    return false;
  }
}

/** One line for under the preview: what the clips will hear. */
function soundLine(c) {
  if (!soundOn()) return t('Sound off');
  if (!c) return t('Sound on, with the camera');
  if (c.mic) return t('Sound: {name}', { name: c.mic.label });
  switch (c.micOff) {
    case '': return t('Sound: starting the microphone…');
    case 'stackmat': return t('Sound off: the only mic is in use by the Stackmat');
    case 'denied': return t('Sound off: the microphone is blocked for this site');
    case 'perm': return [t('Sound off until the microphone is allowed'), ' ', el('button', {
      class: 'ghost-btn sm', text: t('Allow'),
      onclick: () => enableSound().then((ok) => { if (ok && cam) setMic(cam, true); }),
    })];
    case 'lost': return t('Sound off: the microphone was disconnected');
    default: return t('Sound off: the microphone could not be opened');
  }
}

async function openCamera(key) {
  const q = quality();
  // Ideals only, never min or exact: a camera that cannot give the size gives
  // its best rather than failing. Full HD leaves the frame rate out. With an
  // ideal of 30 there, a webcam that films 1080p only at 5 to 15 fps is
  // handed over as 720p at 30, quietly; without it, it comes back as Full HD
  // at its real rate (the browsers lean to 30 among sizes that fit), and the
  // preview says how slow that is.
  const video = { width: { ideal: q.width }, height: { ideal: q.height },
    ...(q === QUALITY.fhd ? {} : { frameRate: { ideal: 30 } }) };
  const gum = (extra) => navigator.mediaDevices.getUserMedia({ video: { ...video, ...extra }, audio: false });
  const want = S().webcamDevice || '';
  // The mic opens alongside the camera, not after it: the clip cannot start
  // until both are up. The camera's own mic shares its groupId: the picked
  // camera's, or else the first listed, the one the browser opens by default.
  const vids = await listCameras();
  const group = (vids.find(d => d.deviceId === want) || (!want ? vids[0] : null))?.groupId || '';
  const micP = openMic(group);
  try {
    const c = await openVideo(key, gum, want);
    c.group = c.group || group;
    adoptMic(c, micP);
    return c;
  } catch (err) {
    micP.then(m => stopStream(m.stream));
    throw err;
  }
}

/* Whether a camera can film Full HD: true, false, or null for not known yet.
   The largest size it reports (getCapabilities: Chromium browsers, Safari,
   and current Firefox, 157 at least), else, when Full HD was asked for, the
   size it sent.
   Remembered per camera as picked in Settings, so the Quality row knows
   before the camera is open again. */
const fullHdKnown = new Map();
function canFullHd(c, track) {
  let caps = {};
  try { caps = track.getCapabilities?.() || {}; } catch { /* not this browser */ }
  c.maxW = caps.width?.max || 0;
  c.maxH = caps.height?.max || 0;
  const id = S().webcamDevice || '';
  if (c.maxW && c.maxH) c.fhd = isFullHd(c.maxW, c.maxH);
  else if (quality() === QUALITY.fhd && c.w && c.h) c.fhd = isFullHd(c.w, c.h);
  else c.fhd = c.missing ? null : fullHdKnown.get(id) ?? null;
  if (c.fhd !== null && !c.missing) fullHdKnown.set(id, c.fhd);
}

/** For the Quality row: can the picked camera film Full HD (null: not known). */
export function fullHdSupport() {
  if (cam && !cam.missing) return cam.fhd;
  return fullHdKnown.get(S().webcamDevice || '') ?? null;
}

/* The line under the preview, when Full HD is picked and is not what the
   camera is giving: too slow, or smaller. */
function fullHdLine(c) {
  if (quality() !== QUALITY.fhd || !c.w || !c.h) return '';
  if (isFullHd(c.w, c.h)) {
    return c.fps && c.fps < LOW_FPS ? t('Full HD runs at {n} fps on this camera. HD is smoother', { n: Math.round(c.fps) }) : '';
  }
  if (c.fhd) return t('This camera sent {size} instead of Full HD', { size: `${c.w}×${c.h}` });
  const most = c.maxW && c.maxH ? `${c.maxW}×${c.maxH}` : `${c.w}×${c.h}`;
  return t('This camera tops out at {size}', { size: most });
}

async function openVideo(key, gum, want) {
  let stream = null, missing = false;
  if (want) {
    try { stream = await gum({ deviceId: { exact: want } }); }
    catch (err) {
      if (err?.name !== 'OverconstrainedError' && err?.name !== 'NotFoundError') throw err;
      // Ids are not forever (Safari mints new ones, clearing site data resets
      // them); the same name is the same camera.
      const same = (await listCameras()).find(d => d.label && d.label === S().webcamLabel && d.deviceId !== want);
      if (same) {
        try {
          stream = await gum({ deviceId: { exact: same.deviceId } });
          S().webcamDevice = same.deviceId;
          app?.persist?.();
          key = camKey();
        } catch { /* fall back to the default below */ }
      }
      missing = !stream;
    }
  }
  stream ??= await gum({});
  const track = stream.getVideoTracks()[0];
  const st = track.getSettings?.() || {};
  const c = {
    stream, track, key, missing,
    label: track.label || t('Camera'),
    deviceId: st.deviceId || '',
    w: st.width || 0, h: st.height || 0, fps: st.frameRate || 30,
    lat: 0,
    group: st.groupId || '',
  };
  canFullHd(c, track);
  // The handler property, not addEventListener: Firefox delivered an 'ended'
  // to one and not the other in testing. begin() also checks readyState, for
  // a browser that says nothing at all.
  track.onended = () => lost(c);
  return c;
}

/** The shared camera. Rejects with AbortError when it was let go while opening. */
function camera() {
  if (camP) return camP;
  const key = camKey();
  const p = camP = openCamera(key).then((c) => {
    if (camP !== p || !enabled) {
      stopCam(c);
      throw new DOMException('Camera released while opening', 'AbortError');
    }
    cam = c;
    grantedHere = true;
    measureLatency(c);
    if (c.missing && !warned.has(`missing:${S().webcamDevice}`)) {
      warned.add(`missing:${S().webcamDevice}`);
      toast(t('{name} isn’t connected, filming with {other}', {
        name: S().webcamLabel ? cameraName(S().webcamLabel) : t('Your camera'), other: cameraName(c.label),
      }), { kind: 'bad', long: true });
    }
    armIdle();
    notify();
    // Up in a tab that is out of sight: off again, unless an attempt is waiting for it.
    if (document.hidden) setTimeout(rest);
    return c;
  }, (err) => {
    if (camP === p) camP = null;
    notify(err);
    throw err;
  });
  p.key = key;
  return p;
}

/* Stopping every track is what turns the camera light off. A request still in
   flight is stopped the moment it lands (see camera()). */
function release() {
  clearTimeout(idleTimer);
  const c = cam;
  cam = null;
  camP = null;
  if (c) stopCam(c);
  notify();
}

/* Unplugged, or the phone acting as a webcam went to sleep. */
function lost(c) {
  if (cam !== c) return;
  release();
  if (enabled) toast(t('Camera disconnected: {name}', { name: cameraName(c.label) }), { kind: 'bad', long: true });
}

/* Nothing being filmed and nothing previewing: the camera goes (unless it is
   to be kept on), and comes back on the next press. A hidden tab always lets
   it go. Called when a clip's recorder stops, when an attempt is thrown away,
   when a preview leaves the screen, and when the tab is hidden. */
function rest() {
  if (!cam && !camP) return;
  if (rec || active > 0) return;
  if (!document.hidden && (previewing > 0 || keepOn())) return armIdle();
  release();
}

function armIdle() {
  clearTimeout(idleTimer);
  // A one-off grant may prompt again when the camera is reopened: keep it instead.
  if (perm === 'granted') idleTimer = setTimeout(() => { if (!rec && !active) release(); }, IDLE_MS);
}

/* How far behind real time the camera's frames are. Chrome says, per frame;
   elsewhere this stays 0 and Sync covers it. Measured once per opening, on a
   two-pixel video that is gone again within a second. */
function measureLatency(c) {
  if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) return;
  const v = el('video', {
    'aria-hidden': 'true', playsinline: true,
    style: { position: 'fixed', left: '0', top: '0', width: '2px', height: '2px', opacity: '0.01', pointerEvents: 'none' },
  });
  v.muted = true;
  v.srcObject = c.stream;
  const got = [];
  let over = false;
  const done = () => {
    if (over) return;
    over = true;
    v.srcObject = null;
    v.remove();
    if (got.length < 5) return;
    got.sort((a, b) => a - b);
    const mid = got[got.length >> 1];
    if (mid >= 0 && mid <= 300) c.lat = mid;
  };
  const step = (now, md) => {
    if (!(md.captureTime > 0)) return done();          // not this browser
    got.push((md.presentationTime || now) - md.captureTime);
    if (got.length < 15 && !over) v.requestVideoFrameCallback(step); else done();
  };
  v.requestVideoFrameCallback(step);
  document.body.append(v);
  v.play().catch(() => {});
  setTimeout(done, 2500);              // a hidden tab presents no frames at all
}

function explain(err) {
  switch (err?.name) {
    case 'NotAllowedError': case 'PermissionDeniedError':
      return perm === 'denied'
        ? t('The camera is blocked for this site. Allow it from the address bar to use webcam replay')
        : t('Camera permission denied, webcam replay is off');
    case 'NotFoundError': case 'OverconstrainedError': case 'DevicesNotFoundError':
      return t('No camera found');
    case 'NotReadableError': case 'TrackStartError':
      return t('The camera is busy. Close any other app using it and try again');
    case 'SecurityError':
      return t('The camera only works on a secure (https) page');
    default:
      return t('Could not open the camera: {err}', { err: err?.message || err?.name || '?' });
  }
}

/* Once per kind of failure per page load: a dead camera should be obvious,
   not a toast after every solve. */
function failed(err) {
  if (err?.name === 'AbortError') return;
  console.warn('[replay] camera', err);
  const key = err?.name || 'other';
  if (warned.has(key)) return;
  warned.add(key);
  toast(explain(err), { kind: 'bad', long: true });
}

/* Asking costs a prompt the browser draws over the page, so it is offered as
   a question rather than sprung on whoever just pressed the spacebar. */
async function askOnce() {
  if (asked || !enabled) return;
  asked = true;
  const yes = await confirmToast(t('Webcam replay needs your camera'), t('Allow'), { timeout: 12000, cancelLabel: t('not now') });
  if (yes && enabled) camera().catch(failed);
}

/** Open the camera ahead of time, where that is wanted (kept on between
    solves, or a preview on screen) and can happen without a surprise prompt. */
function warm() {
  if (!enabled || camP || document.hidden) return;
  if (perm === 'denied') return blocked();
  if (!keepOn() && previewing === 0) return;        // it comes up on the next press instead
  if (perm === 'granted' || grantedHere || perm === 'unknown') camera().catch(failed);
  else if (perm === 'prompt') askOnce();
  else if (perm === 'denied') blocked();
}

function blocked() {
  if (!enabled) return;
  toast(t('The camera is blocked for this site, so webcam replay is off'), { kind: 'bad', long: true });
  app?.setSetting('webcamReplay', false);
}

/* ---------------- filming an attempt ---------------- */

const stopRecorder = (r) => { if (r.mr && r.mr.state !== 'inactive') r.mr.stop(); };

function begin() {
  if (rec || !enabled || (app?.competitionRecordingMode && app.competitionRecordingMode !== 'per-solve')) return;
  pauseFinish();
  if (cam && cam.track.readyState === 'ended') lost(cam);
  const r = rec = { mr: null, t0: 0, insp: null, start: null, stop: null, res: null, cam: null, over: false, dropped: false };
  r.done = new Promise(res => { r.resolve = res; });
  clearTimeout(idleTimer);
  let c = camP;
  if (!c) {
    // Mid-press is the one moment a permission prompt must not appear: only a
    // camera this page has already been given is opened here.
    if (perm !== 'granted' && perm !== 'unknown' && !grantedHere) { r.resolve(null); askOnce(); return; }
    c = camera();
  }
  c.then(async (cm) => {
    // A mic chosen against an old setting, or before the Stackmat started: choose again.
    if (cm.micKey !== micKey()) setMic(cm);
    await cm.micWait;
    if (r.over) return r.resolve(null);     // over, or thrown away, before the camera was up
    startRecorder(r, cm);
  }).catch((err) => { r.resolve(null); failed(err); });
}

/* The size asked for is only an ideal: a webcam that tops out at 720p sends
   720p with Full HD picked. That picture is recorded at HD's rate (or
   Standard's), not at Full HD's for a picture less than half the size.
   Standard and HD keep their own rates whatever arrives, as they always have. */
function bitrate(c) {
  const q = quality();
  if (q !== QUALITY.fhd || !c.w || !c.h || isFullHd(c.w, c.h)) return q.bps;
  return Math.max(c.w, c.h) > QUALITY.sd.width ? QUALITY.hd.bps : QUALITY.sd.bps;
}

function startRecorder(r, c) {
  const make = (audio) => new MediaRecorder(audio ? new MediaStream([c.track, audio]) : c.stream, {
    mimeType: audio ? MIME_AV : MIME, videoBitsPerSecond: bitrate(c),
    ...(audio ? { audioBitsPerSecond: MIC_BPS } : {}),
    // A keyframe every half second makes seeking cheap. Chrome honours it;
    // others ignore it, and the clip is converted after the solve instead.
    videoKeyFrameIntervalDuration: 500,
  });
  let mr, audio = c.mic?.track.readyState === 'live' ? c.mic.track : null;
  try { mr = make(audio); }
  catch (err) {
    if (!audio) { r.resolve(null); return failed(err); }
    // A recorder that will not take the sound still films the picture.
    console.warn('[replay] recorder refused the sound', err);
    audio = null;
    try { mr = make(null); } catch (err2) { r.resolve(null); return failed(err2); }
  }
  r.sound = !!audio;
  r.mic = audio ? c.mic.label : '';
  /* Each chunk goes to IndexedDB as it arrives, one write after another so
     they land in order and never hold up the timer. A chunk stays in `held`
     only until its write lands, or for good if the write fails (storage
     full), so nothing is lost either way. */
  const key = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, at = Date.now();
  r.journalKey = key;
  const held = [];
  let count = 0, chain = Promise.resolve();
  const chunkFailure = err => {
    if (!r.chunkFailed) {
      console.warn('[replay] recording retained in memory', err);
      toast(t('Recording storage failed. Keep this tab open and use Recover recordings to download a copy.'), { kind: 'bad', hold: true });
    }
    r.chunkFailed = true; saveError = err; emit({ type: 'storage' });
  };
  r.describe = meta => {
    r.replayMeta = meta;
    chain = chain.then(() => replayJournal.describe(key, at, { meta })).catch(chunkFailure);
  };
  r.discard = async () => {
    r.dropped = true; stopRecorder(r); await chain; await replayJournal.remove(key);
  };
  mr.ondataavailable = (e) => {
    if (!e.data?.size) return;
    const i = count++;
    held[i] = e.data;
    if (r.dropped) return;
    chain = chain.then(async () => {
      if (r.chunkFailed || r.dropped) return;
      await replayJournal.append(key, i, at, e.data); held[i] = null;
    }).catch(chunkFailure);
  };
  // On disk, a clip is put back together from Blobs that point at it, so
  // even a long one is never read into memory to be saved.
  const assemble = async () => {
    await chain;
    if (r.dropped || !count) return null;
    await replayJournal.describe(key, at, { finished: true, expectedChunks: count,
      ...(r.replayMeta ? { meta: { ...r.replayMeta, ...(r.interrupted ? { partial: true } : {}) } } : {}) }).catch(chunkFailure);
    // Read persisted pieces without deleting their rows. The independent copy
    // remains available across reloads until putClip actually commits.
    const stored = held.some((b, i) => i < count && !b) ? await replayJournal.read(key) : null;
    if (held.some((b, i) => i < count && !b) && stored?.complete) {
      // Failed chunks, if any, are kept in held and must be merged below.
      if (!held.some(Boolean)) return stored.blob;
    }
    const persisted = held.some((b, i) => i < count && !b)
      ? await replayJournal.parts(key) : new Map();
    const parts = [];
    for (let i = 0; i < count; i++) {
      const b = held[i] || persisted.get(i);
      if (!b) throw new Error(`chunk ${i} of ${count} missing`);
      parts.push(b);
    }
    return new Blob(parts, { type: mr.mimeType || MIME });
  };
  mr.onstop = () => {
    r.finished = true;
    if (!r.over) r.interrupted = true;
    clearTimeout(r.cap);
    active = Math.max(0, active - 1);
    emit({ type: 'state' });
    assemble().then(r.resolve, (err) => {
      saveError = err;
      console.warn('[replay] could not put the clip together', err);
      toast(t('Recording could not be assembled. Keep this tab open and use Recover recordings.'), { kind: 'bad', hold: true });
      emit({ type: 'storage' });
      r.resolve(null);
    });
    rest();                                 // the clip is filmed: the camera can go
  };
  mr.onerror = e => {
    r.interrupted = true;
    saveError = e.error || new Error('Recording interrupted');
    console.warn('[replay] recorder', e.error || e);
    toast(t('Recording interrupted. Use Recover recordings to keep any surviving footage.'), { kind: 'bad', hold: true });
    emit({ type: 'storage' });
  };
  r.cam = c;
  // Video time 0, on the timer's clock. See the header for why this and not 'start'.
  r.t0 = performance.now() - c.lat - 500 / c.fps;
  try { mr.start(2000); } catch (err) { r.resolve(null); return failed(err); }
  r.mr = mr;
  active++;
  emit({ type: 'state' });
  r.cap = setTimeout(() => stopRecorder(r), MAX_MS);
}

function drop() {
  const r = rec;
  if (!r) return;
  rec = null;
  r.over = r.dropped = true;
  stopRecorder(r);
  r.resolve(null);
  r.discard?.().catch(err => console.warn('[replay] discarded recording cleanup', err));
  if (!r.mr) rest();                        // no recorder to stop, so nothing else will
}

function watchTimer(tm) {
  timer = tm;
  tm.addEventListener('state', ({ detail: { state } }) => {
    if (!enabled) return;
    if (state === 'idle') {
      // Released a hold without starting, or reset: nothing to keep.
      drop();
      armIdle();
      syncReplay();                     // a camera picked mid-attempt switches now
      scheduleFinish();
    } else if (state !== 'cooldown') {
      // The press, not the start: a solve without inspection is filmed from the
      // hold, so the clip opens on the hands still on the timer.
      begin();
    }
  });
  tm.addEventListener('inspectstart', () => { if (rec) rec.insp = tm.inspectStart; });
  tm.addEventListener('start', () => { if (rec) rec.start = tm.solveStart; });
  tm.addEventListener('cancel', drop);
}

/**
 * The attempt that just stopped, for main.js to give to its solve. Called
 * first thing in onSolveFinished, inside the timer's 'stop' event. Null when
 * nothing is being filmed.
 */
export function takeClip(res) {
  const r = rec;
  if (!r || !timer) return null;
  rec = null;
  r.over = true;
  // The camera never came up in time (a permission prompt still open, say):
  // nothing was filmed, and nothing must wait on a recorder that never ran.
  if (!r.mr) { r.resolve(null); return null; }
  r.res = res;
  r.start ??= timer.solveStart;
  r.stop = r.start + res.timeMs;
  setTimeout(() => stopRecorder(r), TAIL_MS);
  return { keep: (solve, opts) => keep(r, solve, opts), discard: () => discardCapture(r) };
}

async function discardCapture(r) {
  r.dropped = true;
  await r.discard?.();
  if (r.solveId) { unsaved.delete(r.solveId); captures.delete(r.solveId); }
}

/** `pb`: this solve is a new best single, so its clip is pinned. */
function keep(r, solve, { pb = false } = {}) {
  r.pb = pb;
  r.solveId = solve.id;
  captures.set(solve.id, r);
  r.describe?.(recordingMeta(r, solve));
  ids.add(solve.id);
  const p = r.done.then(async (blob) => {
    if (!blob) {
      ids.delete(solve.id);
      if (!r.dropped) throw new Error('Recording produced no complete video; check Recover recordings');
      return;
    }
    await save(r, solve, blob);
  }).catch((err) => {
    if (!unsaved.has(solve.id)) ids.delete(solve.id);
    saveError = err;
    console.warn('[replay] could not save', err);
    toast(t('Replay not saved. Keep this tab open and use Recover recordings to save a copy.'), { kind: 'bad', hold: true });
    emit({ type: 'storage' });
  }).finally(() => {
    saving.delete(solve.id);
    if (!unsaved.has(solve.id)) captures.delete(solve.id);
    // Clear an optimistic play button only when no playable recording remains.
    if (!ids.has(solve.id)) emit({ type: 'removed', ids: [solve.id] });
    emit({ type: 'storage' });
  });
  saving.set(solve.id, p);
  emit({ type: 'storage' });
}

function recordingMeta(r, solve, blob) {
  return {
    id: solve.id, at: solve.createdAt || Date.now(), bytes: blob?.size || 0, mime: blob?.type || r.mr?.mimeType || MIME,
    // Milliseconds of video time. The clock in the player is drawn from these.
    insp: r.insp == null ? null : r.insp - r.t0,
    start: r.start - r.t0,
    stop: r.stop - r.t0,
    timeMs: r.res.timeMs,
    splits: r.res.splits || [],
    cam: r.cam.label, w: r.cam.w, h: r.cam.h, fps: r.cam.fps, lat: r.cam.lat,
    sound: !!r.sound, mic: r.mic || '',
    pinned: !!r.pb, pb: !!r.pb, ...(r.interrupted ? { partial: true } : {}),
  };
}

async function save(r, solve, blob) {
  if (r.dropped) return;
  const meta = recordingMeta(r, solve, blob);
  unsaved.set(solve.id, { meta, blob, key: r.journalKey });
  // Re-assert final metadata even if its earlier write failed. Failure keeps
  // both the Blob in memory and whatever journal chunks already committed.
  await replayJournal.describe(r.journalKey, meta.at, { meta }).catch(err => console.warn('[replay] recovery metadata', err));
  try {
    await commitJournaledReplay({ journal: replayJournal, id: r.journalKey, meta, blob,
      write: (m, b) => r.dropped ? Promise.reject(new DOMException('Recording discarded', 'AbortError')) : putClip(m, b) });
  } catch (err) {
    if (err?.name !== 'QuotaExceededError') throw err;
    await prune(blob.size * 2);
    await commitJournaledReplay({ journal: replayJournal, id: r.journalKey, meta, blob,
      write: (m, b) => r.dropped ? Promise.reject(new DOMException('Recording discarded', 'AbortError')) : putClip(m, b) });
  }
  unsaved.delete(solve.id); saveError = null;
  if (r.dropped) return;
  ids.add(solve.id);
  emit({ type: 'saved', id: solve.id });
  // Maintenance cannot turn an acknowledged save into an apparent failure.
  prune().catch(err => console.warn('[replay] cleanup failed; saved clip retained', err));
}

/* ---------------- switching it on and off ---------------- */

/**
 * The settings toggle. Asks for the camera (it is a click, so a prompt is
 * fine) and resolves whether it is now on; failures explain themselves.
 */
export async function enableReplay() {
  if (replayOff()) {
    toast(replayOff(), { kind: 'bad', long: true });
    return false;
  }
  if (!replaySupported()) {
    toast(t('This browser cannot record video'), { kind: 'bad', long: true });
    return false;
  }
  enabled = true;                         // camera() throws away a stream that lands while off
  try {
    await camera();
    return true;
  } catch (err) {
    enabled = !!S().webcamReplay;
    if (!enabled) release();
    if (err?.name !== 'AbortError') toast(explain(err), { kind: 'bad', long: true });
    return false;
  }
}

/** Ask again from a click: the preview's "Allow camera" button. */
export function requestCamera() {
  return camera().catch((err) => { if (err?.name !== 'AbortError') toast(explain(err), { kind: 'bad', long: true }); });
}

/** main.js, from applyAll: the settings may have changed under us (toggle, camera, quality, reset). */
export function syncReplay() {
  if (!app) return;
  const on = !!S().webcamReplay && replaySupported() && !replayOff();
  if (!on) {
    if (enabled) { enabled = false; drop(); release(); }
    return;
  }
  const was = enabled;
  enabled = true;
  // Sound turned on or off, another mic picked, the Stackmat started or stopped.
  if (cam && !rec && cam.micKey !== micKey()) setMic(cam);
  const open = cam?.key ?? camP?.key;
  if (open && open !== camKey() && !rec) {
    // A different camera or quality. This is a click in Settings, so asking is fine.
    release();
    camera().catch(failed);
  } else if (!was || keepOn() !== lastKeep) {
    if (keepOn()) warm(); else rest();
  }
  lastKeep = keepOn();
}
let lastKeep = false;

/** main.js, once at boot. */
export function initReplay(appRef, tm) {
  app = appRef;
  watchTimer(tm);
  addEventListener('beforeunload', event => {
    if (!saving.size && !unsaved.size && !active) return;
    event.preventDefault(); event.returnValue = '';
  });
  // Loading never prunes missing solves or unfinished recordings. Background
  // conversion is paused: preserve the recorder's original until this fix has
  // proved stable across browsers. Export conversion remains available.
  refreshReplays().catch(err => {
    console.warn('[replay] could not read saved replays', err);
    toast(t('Replay storage is unavailable. Keep this tab open and use Recover recordings.'), { kind: 'bad', hold: true });
  });

  const ready = navigator.permissions?.query({ name: 'camera' }).then((st) => {
    perm = st.state;
    st.addEventListener('change', () => {
      perm = st.state;
      if (perm === 'denied') { release(); blocked(); } else if (perm === 'granted') warm();
    });
  }).catch(() => {}) || Promise.resolve();
  ready.then(syncReplay);
  /* Switched off or on from the admin console, or this account's roles read:
     an attempt being filmed keeps its clip, and the next one goes by it. */
  const resync = () => { if (!rec) syncReplay(); };
  addEventListener('tdt-config', resync);
  addEventListener('tdt-roles', resync);
  navigator.permissions?.query({ name: 'microphone' }).then((st) => {
    micPerm = st.state;
    st.addEventListener('change', () => { micPerm = st.state; });
  }).catch(() => {});

  // Another tab, another window, the phone locked: the camera goes now (or,
  // mid-attempt, as soon as the clip is done), and comes back when needed.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) rest();
    else warm();
  });
  // Kept on between solves and back after the idle let-go: the first sign of
  // life brings the camera up, usually well before the next press.
  let nudged = 0;
  const nudge = () => {
    if (!enabled || camP || performance.now() - nudged < 1000) return;
    nudged = performance.now();
    if (perm === 'granted') warm();
  };
  for (const type of ['pointermove', 'pointerdown', 'keydown']) addEventListener(type, nudge, { passive: true, capture: true });

  // A camera plugged in or out (a phone connecting as a webcam): the settings
  // list redraws, and a stand-in goes back to the camera that was picked.
  navigator.mediaDevices?.addEventListener?.('devicechange', async () => {
    if (cam && cam.track.readyState === 'ended') lost(cam);
    // A mic plugged in while filming without one: choose again.
    if (cam && !rec && soundOn() && !cam.mic && cam.micOff) setMic(cam);
    notify();
    if (!enabled || !cam?.missing || rec || !S().webcamDevice) return;
    const back = (await listCameras()).some(d => d.deviceId === S().webcamDevice || (d.label && d.label === S().webcamLabel));
    if (back && cam?.missing && !rec) { release(); camera().catch(failed); }
  });
}

/* ---------------- the settings preview ---------------- */

/**
 * Keep `video` showing the live camera and `status` saying what it is, for as
 * long as both are in the page. While `area` (the whole block of webcam
 * controls) is on screen the camera is held on, so picking a camera or a
 * quality shows it straight away; off screen (drawer shut or scrolled past)
 * the picture is detached and the camera can go.
 */
export function attachPreview(video, status, onAllow, area = video, sound = null) {
  let visible = false, placed = false;
  const paint = (c, err) => {
    // Built before it is put in the page; gone for good once the drawer redraws.
    if (video.isConnected) placed = true;
    else if (placed) { watchers.delete(paint); io.disconnect(); video.srcObject = null; show(false); return; }
    const want = visible && c ? c.stream : null;
    if (video.srcObject !== want) { video.srcObject = want; if (want) video.play().catch(() => {}); }
    sound?.replaceChildren(...[soundLine(c)].flat());
    status.replaceChildren();
    if (c) {
      const size = c.w && c.h ? ` · ${c.w}×${c.h}` : '';
      status.append(`${cameraName(c.label)}${size} · ${Math.round(c.fps)} fps`);
      const fhd = fullHdLine(c);
      if (fhd) status.append(el('span', { class: 'rp-preview-warn', text: fhd }));
    } else if (camP) {
      status.append(t('Starting the camera…'));
    } else if (err && err.name !== 'AbortError') {
      status.append(explain(err));
    } else {
      status.append(t('Camera off'), ' ');
      status.append(el('button', { class: 'ghost-btn sm', text: t('Turn it on'), onclick: () => onAllow?.() }));
    }
  };
  // On screen, it holds the camera on for aiming; off screen (drawer shut,
  // panel closed) it lets go, and the camera goes if nothing else needs it.
  const show = (on) => {
    if (on === visible) return;
    visible = on;
    previewing += on ? 1 : -1;
    if (on) warm(); else rest();
  };
  const io = new IntersectionObserver(([e]) => { show(e.isIntersecting); paint(cam); });
  io.observe(area);
  video.muted = true;
  watchers.add(paint);
  paint(cam);
}

/** For the camera list: called again whenever a device comes or goes. */
export function onCamerasChanged(fn) {
  const w = () => { if (!fn()) watchers.delete(w); };
  watchers.add(w);
}

/* ---------------- playback ---------------- */

export const hasReplay = (id) => ids.has(id);
export const replayOpen = () => !!document.querySelector('dialog.replay-dlg[open]');
export const replayEnabled = () => enabled;
export const replaySettings = () => S();
export const setReplaySetting = (k, v) => app?.setSetting(k, v);

/** Play a solve's clip, in replay-player.js (loaded the first time). */
export async function openReplay(solve) {
  try {
    const m = await import('./replay-player.js');
    await m.openPlayer(solve);
  } catch (err) {
    console.warn('[replay] player', err);
    toast(t('Could not open the replay'), { kind: 'bad' });
  }
}

export function forgetReplay(id) { ids.delete(id); emit({ type: 'removed', ids: [id] }); }

/**
 * What the clock under the picture reads at `x`, milliseconds on the clip's
 * own timeline (video time, less the camera's clock delay). Shared by the
 * player and the exported videos, so the two can never disagree.
 */
export function clockAt(m, x, { timeMs, pen = 'none', prec = 2 }) {
  if (x >= m.stop) {
    return { kind: 'done', phase: t('stopped'), text: fmt(timeMs, { showMs: prec === 3 }),
      pen: pen === '+2' ? '+2' : pen === 'DNF' ? 'DNF' : '' };
  }
  if (x >= m.start) {
    const into = x - m.start;
    const splits = m.splits || [];
    const n = splits.filter(v => v <= into).length;
    return { kind: 'run', phase: splits.length ? t('phase {n}', { n: n + 1 }) : t('solving'), text: fmtLive(into, prec), pen: '' };
  }
  if (m.insp != null && x >= m.insp) {
    const e = x - m.insp;
    return { kind: e > 15000 ? 'late' : 'insp', phase: t('inspection'),
      text: e > 17000 ? 'DNF' : e > 15000 ? '+2' : String(Math.ceil((15000 - e) / 1000)), pen: '' };
  }
  return { kind: 'pre', phase: t('ready'), text: fmtLive(0, prec), pen: '' };
}

export { TAIL_MS };


// A continuous Competition capture owns the same camera as ordinary replay.
// Holding active prevents preview/idle code from releasing it between attempts.
export async function acquireSetCamera() {
  if (!(await enableReplay())) throw new Error(t('Camera unavailable. You can start without replay.'));
  const c = await camera();
  await c.micWait;
  clearTimeout(idleTimer);
  const resumeFinish = holdFinish();
  active++;
  emit({ type: 'state' });
  const audio = c.mic?.track?.readyState === 'live' ? c.mic.track : null;
  let released = false;
  return {
    stream: new MediaStream([c.track, ...(audio ? [audio] : [])]),
    mime: audio ? MIME_AV : MIME, bps: bitrate(c),
    w: c.w, h: c.h, fps: c.fps, sound: !!audio,
    release() {
      if (released) return; released = true;
      active = Math.max(0, active - 1); resumeFinish(); emit({ type: 'state' }); rest();
    },
  };
}
