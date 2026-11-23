import { createReplayStore, replayRequest as request } from './replay-store.js';

// A separate database prevents a stalled final replay transaction from also
// blocking its recovery copy. Older app tabs cannot prune this new journal.
export function createReplayJournal({ storage = createReplayStore({ name: 'tagdatimer-replay-journal' }) } = {}) {
  const range = id => IDBKeyRange.bound([id, 0], [id, Infinity]);
  return {
    async append(id, index, at, blob) {
      return storage.run('readwrite', async tr => {
        const meta = tr.objectStore('meta'), video = tr.objectStore('video');
        const [old, previous] = await Promise.all([request(meta.get(id)), request(video.get([id, index]))]);
        meta.put({ ...old, id, at: old?.at ?? at, mime: old?.mime || blob.type,
          bytes: (old?.bytes || 0) + blob.size - (previous?.size || 0),
          chunks: Math.max(old?.chunks || 0, index + 1), updatedAt: Date.now() });
        video.put(blob, [id, index]);
      });
    },
    async describe(id, at, patch) {
      return storage.run('readwrite', async tr => {
        const meta = tr.objectStore('meta'), old = await request(meta.get(id));
        meta.put({ ...old, id, at: old?.at ?? at, ...patch, updatedAt: Date.now() });
      });
    },
    async list() {
      return storage.run('readonly', tr => request(tr.objectStore('meta').getAll()), ['meta']);
    },
    async parts(id) {
      return storage.run('readonly', async tr => {
        const video = tr.objectStore('video');
        const [keys, blobs] = await Promise.all([request(video.getAllKeys(range(id))), request(video.getAll(range(id)))]);
        return new Map(keys.map((key, i) => [key[1], blobs[i]]));
      }, ['video']);
    },
    async read(id) {
      return storage.run('readonly', async tr => {
        const [meta, keys, blobs] = await Promise.all([request(tr.objectStore('meta').get(id)),
          request(tr.objectStore('video').getAllKeys(range(id))), request(tr.objectStore('video').getAll(range(id)))]);
        if (!meta || !blobs.length) return null;
        const contiguous = keys.every((key, index) => key[1] === index);
        return { ...meta, complete: !!(meta.finished && contiguous && meta.expectedChunks === blobs.length),
          playable: contiguous, blob: new Blob(blobs, { type: meta.mime || blobs[0]?.type || 'video/webm' }) };
      });
    },
    async remove(id) {
      return storage.run('readwrite', tr => {
        tr.objectStore('meta').delete(id); tr.objectStore('video').delete(range(id));
      });
    },
    async clear() {
      return storage.run('readwrite', tr => { tr.objectStore('meta').clear(); tr.objectStore('video').clear(); });
    },
  };
}

// Called only after the final store's transaction has committed. Cleanup failure
// leaves a harmless extra recovery copy, never a falsely failed final save.
export async function commitJournaledReplay({ journal, id, meta, blob, write }) {
  await write(meta, blob);
  try { await journal.remove(id); } catch (error) { console.warn('[replay] recovery copy retained', error); }
}

export const replayJournal = createReplayJournal();

/** Read-only inspection of chunks left by versions before the journal existed.
    Their solve association and final chunk count were never saved. */
export async function inspectLegacyChunks(idb = globalThis.indexedDB, timeoutMs = 15000) {
  if (!idb.databases) return [];
  if (!(await idb.databases()).some(db => db.name === 'tagdatimer-replay-chunks')) return [];
  return new Promise((resolve, reject) => {
    let db, tr, ended = false;
    const finish = (error, rows) => {
      if (ended) return; ended = true; clearTimeout(deadline);
      if (error) { try { tr?.abort(); } catch {} reject(error); } else resolve(rows);
      db?.close();
    };
    const deadline = setTimeout(() => finish(new DOMException('Legacy recording storage did not respond', 'TimeoutError')), timeoutMs);
    const req = idb.open('tagdatimer-replay-chunks');
    req.onerror = () => finish(req.error);
    req.onblocked = () => finish(new Error('Recording storage is busy'));
    req.onsuccess = () => {
      db = req.result;
      if (ended) { db.close(); return; }
      try {
        tr = db.transaction('chunks');
        const store = tr.objectStore('chunks');
        Promise.all([request(store.getAllKeys()), request(store.getAll())]).then(([keys, values]) => {
          const groups = new Map();
          keys.forEach((key, i) => {
            if (!Array.isArray(key) || !values[i]?.blob?.size) return;
            const group = groups.get(key[0]) || { id: key[0], at: values[i].at, legacy: true, parts: [] };
            group.parts.push({ index: key[1], blob: values[i].blob }); groups.set(key[0], group);
          });
          finish(null, [...groups.values()].map(group => {
            group.parts.sort((a, b) => a.index - b.index);
            return { id: group.id, at: group.at, legacy: true, complete: false,
              playable: group.parts.every((part, i) => part.index === i),
              blob: new Blob(group.parts.map(part => part.blob), { type: group.parts[0].blob.type || 'video/webm' }) };
          }));
        }, error => finish(error));
      } catch (error) { finish(error); }
    };
  });
}
