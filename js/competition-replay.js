import { t } from './i18n.js';
import { acquireSetCamera, deleteClip, clipReady, holdFinish } from './replay.js';
import { KV } from './db.js';
import { competitionClockAt } from './competition-stats.js';

export const SET_REPLAY_LIMITS = { durationMs: 30 * 60 * 1000, bytes: 256 * 1024 * 1024, reserve: 32 * 1024 * 1024 };
let dbPromise;
function db() {
  return dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open('tagdatimer-competition-media', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('meta', { keyPath: 'id' });
      const chunks = req.result.createObjectStore('chunks', { keyPath: ['id', 'index'] });
      chunks.createIndex('bySet', 'id');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
}
const result = req => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
async function write(meta, chunk) {
  const tr = (await db()).transaction(['meta', 'chunks'], 'readwrite');
  const done = new Promise((res, rej) => { tr.oncomplete = res; tr.onabort = tr.onerror = () => rej(tr.error || new Error(t('Media write failed'))); });
  try {
    tr.objectStore('meta').put(meta);
    if (chunk) tr.objectStore('chunks').put(chunk);
    await done;
  } catch (err) { try { tr.abort(); } catch {} await done.catch(()=>{}); throw err; }
}
export async function setReplayMeta(id) { return result((await db()).transaction('meta').objectStore('meta').get(id)); }
export async function loadSetReplay(id) {
  const tr = (await db()).transaction(['meta','chunks']);
  const [meta, chunks] = await Promise.all([result(tr.objectStore('meta').get(id)), result(tr.objectStore('chunks').index('bySet').getAll(id))]);
  if (!meta || !chunks.length) return null;
  return { meta, blob: new Blob(chunks.sort((a,b) => a.index-b.index).map(c => c.blob), { type: meta.mime }) };
}
export async function deleteSetReplay(id) {
  const tr = (await db()).transaction(['meta','chunks'], 'readwrite');
  const done = new Promise((res,rej) => { tr.oncomplete=res; tr.onabort=tr.onerror=()=>rej(tr.error); });
  const os = tr.objectStore('chunks');
  const keys = await result(os.index('bySet').getAllKeys(id)); keys.forEach(k=>os.delete(k));
  tr.objectStore('meta').delete(id); await done;
}
export async function cleanupCompetitionMedia() {
  const entries = await KV.get('_competitionMediaCleanup', []);
  for (const entry of entries) {
    await deleteSetReplay(entry.id);
    for (const id of entry.solveIds) { await clipReady(id, 3000).catch(()=>{}); await deleteClip(id); }
  }
  // Avoid losing deletions appended while cleanup was in progress.
  const current = await KV.get('_competitionMediaCleanup', []);
  await KV.set('_competitionMediaCleanup', current.filter(e => !entries.some(x => x.id === e.id)));
}
export async function recordingBudget(size, bps = 5_000_000) {
  const estimated = Math.min(SET_REPLAY_LIMITS.bytes, size * 90 * bps / 8);
  const est = await navigator.storage?.estimate?.().catch(()=>null);
  const free = est?.quota ? Math.max(0, est.quota - (est.usage || 0) - SET_REPLAY_LIMITS.reserve) : Infinity;
  return { estimated, free, likelyFull: estimated > free };
}
let live = null;
export const setRecordingLive = id => live?.id === id;
export const mediaNow = id => live?.id === id ? performance.now() - live.t0 : null;
export async function startSetReplay(set, onStatus) {
  if (live) throw new Error(t('A continuous recorder is already running'));
  const budget = await recordingBudget(set.size);
  if (budget.free < 4 * 1024 * 1024) throw new Error(t('Not enough local storage to record. Start without replay.'));
  // One owner across tabs. A second tab must not mark live footage as a reload,
  // or take the camera while another recorder still holds the set.
  let unlock = () => {};
  if (navigator.locks) {
    let grant;
    const obtained = new Promise(resolve => { grant = resolve; });
    navigator.locks.request(`competition-camera:${set.id}`, { ifAvailable: true }, lock => {
      if (!lock) { grant(false); return; }
      return new Promise(resolve => { unlock = resolve; grant(true); });
    }).catch(() => grant(false));
    if (!await obtained) throw new Error(t('This set is being recorded in another tab'));
  }
  let camera;
  try { camera = await acquireSetCamera(); } catch (err) { unlock(); throw err; }
  let mr;
  try { mr = new MediaRecorder(camera.stream, { mimeType: camera.mime, videoBitsPerSecond: camera.bps, audioBitsPerSecond: 48000 }); }
  catch (err) { camera.release(); unlock(); throw err; }
  const r = live = { id: set.id, t0: performance.now(), camera, mr, chain: Promise.resolve(), index: 0, bytes: 0, state: 'recording', reason: '', lastChunk: performance.now() };
  const meta = { id: set.id, at: Date.now(), startedAt: Date.now(), durationMs: 0, bytes: 0, mime: mr.mimeType, w: camera.w, h: camera.h, fps: camera.fps, sound: camera.sound, status: 'recording' };
  const stop = (status, reason) => {
    if (r.state !== 'recording') return;
    r.state = status; r.reason = reason;
    if (mr.state !== 'inactive') mr.stop();
  };
  r.stop = stop;
  r.done = new Promise(resolve => { r.resolve = resolve; });
  mr.ondataavailable = e => {
    if (!e.data?.size) return;
    const index = r.index++, now = performance.now();
    if (now - r.lastChunk > 10000) stop('interrupted', t('Capture paused or the device slept'));
    r.lastChunk = now;
    r.bytes += e.data.size;
    r.chain = r.chain.then(async () => {
      const next = { ...meta, durationMs: now-r.t0, bytes: meta.bytes+e.data.size };
      if (next.bytes > Math.min(SET_REPLAY_LIMITS.bytes,budget.free)) { stop('interrupted', t('Recording size or storage limit reached')); return; }
      await write(next, { id: set.id, index, blob: e.data });
      Object.assign(meta,next);
      if (index % 8 === 0) {
        const est = await navigator.storage?.estimate?.().catch(()=>null);
        if (est?.quota && est.quota-est.usage < SET_REPLAY_LIMITS.reserve) stop('interrupted', t('Local storage is almost full'));
      }
    }).catch(err => { stop('interrupted', t('Could not save more footage')); r.state = 'interrupted'; r.reason = err.name === 'QuotaExceededError' ? t('Local storage is full') : t('Could not save more footage'); });
  };
  mr.onerror = () => stop('interrupted', t('Camera recording failed'));
  const ended = () => stop('interrupted', t('Camera disconnected'));
  camera.stream.getVideoTracks()[0].addEventListener('ended', ended);
  const hidden = () => { if (document.hidden) stop('interrupted', t('Tab hidden: footage ended; timing can continue without full replay')); };
  const pagehide = () => stop('interrupted', t('Page closed or reloaded'));
  document.addEventListener('visibilitychange', hidden); addEventListener('pagehide', pagehide);
  let wake = null;
  mr.onstop = async () => {
    if (r.state === 'recording') { r.state = 'interrupted'; r.reason = t('Camera or recording settings changed'); }
    clearTimeout(r.cap);
    document.removeEventListener('visibilitychange', hidden); removeEventListener('pagehide', pagehide);
    camera.stream.getVideoTracks()[0].removeEventListener('ended', ended);
    camera.release(); await wake?.release().catch(()=>{});
    await r.chain;
    meta.status = r.state; meta.reason = r.reason;
    try { await write({ ...meta }); } catch { meta.status = 'interrupted'; meta.reason = t('Could not finalize footage'); }
    if (live === r) live = null;
    unlock();
    try { await onStatus?.({ ...meta }); } catch(err) { console.warn('[competition] replay status could not be saved',err); } finally { r.resolve(meta); }
  };
  try {
    await write(meta);
    mr.start(2000);
    r.t0 = performance.now();
    r.cap = setTimeout(() => stop('interrupted', t('30 minute recording limit reached')), SET_REPLAY_LIMITS.durationMs);
    navigator.wakeLock?.request('screen').then(w => { if (live === r) wake = w; else w.release(); }).catch(()=>{});
  } catch (err) {
    document.removeEventListener('visibilitychange', hidden); removeEventListener('pagehide', pagehide);
    camera.stream.getVideoTracks()[0].removeEventListener('ended', ended);
    camera.release(); unlock(); live = null; throw err;
  }
  return meta;
}
export async function stopSetReplay(id, complete = true) {
  if (live?.id !== id) return setReplayMeta(id);
  const r = live; r.stop(complete ? 'ready' : 'interrupted', complete ? '' : t('Set ended before recording was complete')); return r.done;
}
export async function recoverSetReplay(id) {
  const meta = await setReplayMeta(id);
  const held = navigator.locks ? (await navigator.locks.query()).held.some(l => l.name === `competition-camera:${id}`) : false;
  if (meta?.status === 'recording' && !setRecordingLive(id) && !held) {
    meta.status = 'interrupted'; meta.reason = t('Recording was interrupted by a reload or closed page'); await write(meta);
  }
  return meta;
}
export async function exportSetReplay(set, solves, onProgress, signal, options = {}) {
  const replay = await loadSetReplay(set.id);
  if (!replay) throw new Error(t('Replay is stored on the original device or no footage survived'));
  const { exportVideo } = await import('./replay-media.js');
  const resume = holdFinish();
  try { return await exportVideo({ ...replay, ...options, competition: { set, solves }, onProgress, signal }); } finally { resume(); }
}
export { competitionClockAt };
