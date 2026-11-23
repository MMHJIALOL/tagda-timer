/* Replay storage can stall in a browser without reporting an IndexedDB error.
   Bound each operation, close failed connections, and let the next read retry.
   Never replace or delete a database to recover from a failed read. */
export const replayRequest = req => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

export function createReplayStore({ idb, name = 'tagdatimer-replays', timeoutMs = 15000 } = {}) {
  let opening = null;
  const timeoutError = () => new DOMException('Replay storage did not respond. Keep this tab open and use Recover recordings to save a copy.', 'TimeoutError');

  function open() {
    if (opening) return opening;
    const pending = new Promise((resolve, reject) => {
      const req = (idb || globalThis.indexedDB).open(name, 1);
      let finished = false;
      const fail = error => {
        if (finished) return;
        finished = true;
        clearTimeout(deadline);
        reject(error);
      };
      const deadline = setTimeout(() => fail(timeoutError()), timeoutMs);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('video')) db.createObjectStore('video');
      };
      req.onblocked = () => fail(new Error('Close older Tagda Timer tabs, then retry loading replays.'));
      req.onerror = () => fail(req.error);
      req.onsuccess = () => {
        const db = req.result;
        // An open request cannot be cancelled. A late result must not keep an
        // abandoned connection alive or replace a newer retry's connection.
        if (finished) { db.close(); return; }
        finished = true;
        clearTimeout(deadline);
        db.onversionchange = () => { db.close(); if (opening === pending) opening = null; };
        db.onclose = () => { if (opening === pending) opening = null; };
        resolve(db);
      };
    });
    opening = pending;
    pending.catch(() => { if (opening === pending) opening = null; });
    return pending;
  }

  async function run(mode, work, stores = ['meta', 'video']) {
    const pending = open();
    const db = await pending;
    let tr;
    try { tr = db.transaction(stores, mode); }
    catch (error) { if (opening === pending) opening = null; db.close(); throw error; }
    let deadline;
    const done = new Promise((resolve, reject) => {
      tr.addEventListener('complete', resolve, { once: true });
      tr.addEventListener('abort', () => reject(tr.error || new DOMException('Replay transaction aborted', 'AbortError')), { once: true });
      tr.addEventListener('error', e => reject(e.target?.error || tr.error || new Error('Could not access replay storage')), { once: true });
      deadline = setTimeout(() => {
        reject(timeoutError());
        if (opening === pending) opening = null;
        try { tr.abort(); } catch {}
        db.close();
      }, timeoutMs);
    });
    try {
      // Request success is not a durable write. Wait for the commit too, and
      // keep the watchdog active while a request or its transaction stalls.
      const [value] = await Promise.all([Promise.resolve().then(() => work(tr)), done]);
      return value;
    } catch (error) {
      try { tr.abort(); } catch {}
      throw error;
    } finally { clearTimeout(deadline); }
  }

  return { run };
}

export const replayStore = createReplayStore();
