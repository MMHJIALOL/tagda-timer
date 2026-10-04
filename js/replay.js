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
   or 1000) are kept, within about CLIP_BYTES each and never more than half of
   what the browser lets this site store. A PB single's clip is pinned and
   never pruned, and so is any clip pinned by hand in the player.

   Recorders put a keyframe in only every six or seven seconds, so every seek
   decoded up to 200 frames and stepping back and forth glitched. Chrome takes
   a keyframe interval; Firefox ignores it. So once a clip is saved, and only
   while the timer is idle, it is converted (replay-media.js, Mediabunny) to a
   WebM with a keyframe every half second and a seek index, its frame times
   read back out of the result. Starting an attempt cancels a conversion in
   flight; it starts over when you are idle.

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
import { tx, wrap } from './db.js';
import { toast, confirmToast } from './toast.js';

const KEEP_DEFAULT = 200;
const CLIP_BYTES = 12 * 1024 * 1024;     // room budgeted per kept clip: a long HD solve, comfortably
const TAIL_MS = 1000;                    // keep filming this long after the stop
const MAX_MS = 10 * 60 * 1000;           // a clip stops growing here (multi-blind)
const IDLE_MS = 10 * 60 * 1000;          // kept on between solves: let go after this long without one
const QUALITY = {
  sd: { width: 640, height: 480, bps: 1_000_000 },
  hd: { width: 1280, height: 720, bps: 2_500_000 },
};

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

let app = null;                          // main.js's app: settings, setSetting, persist
const S = () => app?.settings || {};
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
let active = 0;                          // recorders running, for the top bar's red dot
const listeners = new Set();

/* main.js listens: the top-bar button's state, the Replay pill and the
   times list's play buttons all follow what happens here. */
export function onReplayChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(what) {
  for (const fn of listeners) { try { fn(what); } catch (err) { console.warn('[replay] listener', err); } }
}
export const replayStatus = () => ({ enabled, live: !!cam, recording: active > 0 });

/* ---------------- storage ---------------- */

let dbP = null;
function rdb() {
  return dbP ??= new Promise((resolve, reject) => {
    const q = indexedDB.open('tagdatimer-replays', 1);
    q.onupgradeneeded = () => {
      // Metadata apart from the video, so counting and pruning never touch a blob.
      q.result.createObjectStore('meta', { keyPath: 'id' });
      q.result.createObjectStore('video');
    };
    q.onsuccess = () => {
      const db = q.result;
      // A later version of this file must never be kept waiting by this tab.
      db.onversionchange = () => { db.close(); dbP = null; };
      resolve(db);
    };
    q.onerror = () => { dbP = null; reject(q.error); };
  });
}

async function txn(mode = 'readonly') {
  return (await rdb()).transaction(['meta', 'video'], mode);
}

const settled = (tr) => new Promise((res, rej) => {
  tr.oncomplete = () => res();
  tr.onerror = () => rej(tr.error);
  tr.onabort = () => rej(tr.error || new DOMException('Transaction aborted', 'AbortError'));
});

async function putClip(meta, blob) {
  const tr = await txn('readwrite');
  tr.objectStore('meta').put(meta);
  tr.objectStore('video').put(blob, meta.id);
  await settled(tr);
}

export const keepCount = () => [50, 200, 1000].includes(+S().webcamKeep) ? +S().webcamKeep : KEEP_DEFAULT;

/* Oldest unpinned first, until there are no more than keepCount() of them and
   the whole lot (pinned ones included, plus `room` for one about to be written)
   fits the budget. The newest clip is never the one to go. */
async function prune(room = 0) {
  let limit = keepCount() * CLIP_BYTES;
  try {
    const est = await navigator.storage?.estimate?.();
    if (est?.quota) limit = Math.min(limit, est.quota * 0.5);
  } catch { /* no estimate: the count and the per-clip budget still hold */ }
  const tr = await txn('readwrite');
  const all = (await wrap(tr.objectStore('meta').getAll())).sort((a, b) => b.at - a.at);
  let bytes = room + all.reduce((n, m) => n + (m.bytes || 0), 0);
  const loose = all.filter(m => !m.pinned);
  let count = loose.length;
  const gone = [];
  for (let i = loose.length - 1; i >= 1 && (count > keepCount() || bytes > limit); i--) {
    const m = loose[i];
    tr.objectStore('meta').delete(m.id);
    tr.objectStore('video').delete(m.id);
    ids.delete(m.id);
    gone.push(m.id);
    count--;
    bytes -= m.bytes || 0;
  }
  await settled(tr);
  if (gone.length) emit({ type: 'removed', ids: gone });
}

/** One field or two on a clip's metadata, if the clip is still there. */
async function patchMeta(id, patch) {
  const tr = await txn('readwrite');
  const m = await wrap(tr.objectStore('meta').get(id));
  if (m) tr.objectStore('meta').put({ ...m, ...patch });
  await settled(tr);
  return !!m;
}

/** Pinned clips are never pruned. A PB single's is pinned when it is saved. */
export async function setPinned(id, pinned) {
  await patchMeta(id, { pinned: !!pinned });
  emit({ type: 'pinned', id, pinned: !!pinned });
  if (!pinned) prune().catch(() => {});
}

export async function deleteClip(id) {
  const tr = await txn('readwrite');
  tr.objectStore('meta').delete(id);
  tr.objectStore('video').delete(id);
  await settled(tr);
  ids.delete(id);
  emit({ type: 'removed', ids: [id] });
}

export async function loadClip(id) {
  await saving.get(id);
  const tr = await txn();
  const [meta, blob] = await Promise.all([
    wrap(tr.objectStore('meta').get(id)), wrap(tr.objectStore('video').get(id)),
  ]);
  return meta && blob ? { meta, blob } : null;
}

/** A clip's metadata alone (no video read), or null. */
export async function clipMeta(id) {
  await saving.get(id);
  return (await wrap((await txn()).objectStore('meta').get(id))) || null;
}

/** Clips whose solve has since been deleted. Run once at boot, so an undo in the same sitting still finds its clip. */
async function sweep() {
  const keys = [...ids].filter(id => !saving.has(id));
  if (!keys.length) return;
  const solves = await tx('solves');
  const counts = await Promise.all(keys.map(id => wrap(solves.count(id))));
  const gone = keys.filter((_, i) => !counts[i]);
  if (!gone.length) return;
  const tr = await txn('readwrite');
  for (const id of gone) { tr.objectStore('meta').delete(id); tr.objectStore('video').delete(id); ids.delete(id); }
  await settled(tr);
}

export async function replayUsage() {
  const all = await wrap((await txn()).objectStore('meta').getAll());
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
  const tr = await txn('readwrite');
  tr.objectStore('meta').clear();
  tr.objectStore('video').clear();
  await settled(tr);
  const gone = [...ids];
  ids.clear();
  emit({ type: 'removed', ids: gone });
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
      const job = await (await media()).prepareFinish(got.blob);
      if (!job) { await patchMeta(id, { conv: 'skip' }); done(); return; }   // nothing here can encode it: the original stays
      finishing = { id, job };
    }
    const pause = finishing.pause = new AbortController();
    if (!(await finishing.job.run(pause.signal))) return;              // paused for an attempt: resumes from here
    const out = await finishing.job.result();
    const tr = await txn('readwrite');
    const m = await wrap(tr.objectStore('meta').get(id));
    if (m) {
      tr.objectStore('meta').put({ ...m, conv: 1, mime: out.blob.type, bytes: out.blob.size, frames: out.frames });
      tr.objectStore('video').put(out.blob, id);
    }
    await settled(tr);
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
  await saving.get(id);
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
  const q = QUALITY[S().webcamQuality] || QUALITY.sd;
  const video = { width: { ideal: q.width }, height: { ideal: q.height }, frameRate: { ideal: 30 } };
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
  if (perm === 'granted') idleTimer = setTimeout(() => { if (!rec) release(); }, IDLE_MS);
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
  if (rec || !enabled) return;
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

function startRecorder(r, c) {
  const make = (audio) => new MediaRecorder(audio ? new MediaStream([c.track, audio]) : c.stream, {
    mimeType: audio ? MIME_AV : MIME, videoBitsPerSecond: (QUALITY[S().webcamQuality] || QUALITY.sd).bps,
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
  const chunks = [];
  mr.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
  mr.onstop = () => {
    clearTimeout(r.cap);
    active = Math.max(0, active - 1);
    emit({ type: 'state' });
    r.resolve(r.dropped || !chunks.length ? null : new Blob(chunks, { type: mr.mimeType || MIME }));
    rest();                                 // the clip is filmed: the camera can go
  };
  mr.onerror = (e) => console.warn('[replay] recorder', e.error || e);
  r.cam = c;
  // Video time 0, on the timer's clock. See the header for why this and not 'start'.
  r.t0 = performance.now() - c.lat - 500 / c.fps;
  try { mr.start(); } catch (err) { r.resolve(null); return failed(err); }
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
  return { keep: (solve, opts) => keep(r, solve, opts) };
}

/** `pb`: this solve is a new best single, so its clip is pinned. */
function keep(r, solve, { pb = false } = {}) {
  r.pb = pb;
  ids.add(solve.id);
  const p = r.done.then(async (blob) => {
    if (!blob) { ids.delete(solve.id); return; }
    await save(r, solve, blob);
  }).catch((err) => {
    ids.delete(solve.id);
    console.warn('[replay] could not save', err);
    toast(t('Could not save the replay'), { kind: 'bad' });
  }).finally(() => saving.delete(solve.id));
  saving.set(solve.id, p);
}

async function save(r, solve, blob) {
  const meta = {
    id: solve.id, at: Date.now(), bytes: blob.size, mime: blob.type,
    // Milliseconds of video time. The clock in the player is drawn from these.
    insp: r.insp == null ? null : r.insp - r.t0,
    start: r.start - r.t0,
    stop: r.stop - r.t0,
    timeMs: r.res.timeMs,
    splits: r.res.splits || [],
    cam: r.cam.label, w: r.cam.w, h: r.cam.h, fps: r.cam.fps, lat: r.cam.lat,
    sound: !!r.sound, mic: r.mic || '',
    pinned: !!r.pb, pb: !!r.pb,
  };
  try {
    await putClip(meta, blob);
  } catch (err) {
    if (err?.name !== 'QuotaExceededError') throw err;
    await prune(blob.size * 2);
    await putClip(meta, blob);
  }
  emit({ type: 'saved', id: solve.id });
  await prune();
  queueFinish(solve.id);
}

/* ---------------- switching it on and off ---------------- */

/**
 * The settings toggle. Asks for the camera (it is a click, so a prompt is
 * fine) and resolves whether it is now on; failures explain themselves.
 */
export async function enableReplay() {
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
  const on = !!S().webcamReplay && replaySupported();
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
  rdb().then(db => wrap(db.transaction('meta').objectStore('meta').getAllKeys()))
    .then((keys) => {
      keys.forEach(k => ids.add(k));
      if (keys.length) emit({ type: 'saved' });
      // Off the boot path: it reads the solves store once per clip. Then any
      // clip a closed tab never got round to converting joins the queue.
      setTimeout(async () => {
        await sweep().catch(err => console.warn('[replay] sweep', err));
        const all = await txn().then(tr => wrap(tr.objectStore('meta').getAll())).catch(() => []);
        all.filter(m => !m.conv).sort((a, b) => b.at - a.at).forEach(m => queueFinish(m.id, false));
      }, 8000);
    })
    .catch(err => console.warn('[replay] could not open the replay store', err));

  const ready = navigator.permissions?.query({ name: 'camera' }).then((st) => {
    perm = st.state;
    st.addEventListener('change', () => {
      perm = st.state;
      if (perm === 'denied') { release(); blocked(); } else if (perm === 'granted') warm();
    });
  }).catch(() => {}) || Promise.resolve();
  ready.then(syncReplay);
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
