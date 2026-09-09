/* ===========================================================
   Tagda Timer — IndexedDB layer (no dependencies)
   Stores: solves, sessions, kv (settings), assets (bg blobs),
           letterPairs (the blindfolded pair dictionary),
           gear + gearLog (the cubes you own and what you did to them)
   =========================================================== */

const DB_NAME = 'tagdatimer';
const DB_VER  = 3;
let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains('solves')) {
        const s = db.createObjectStore('solves', { keyPath: 'id' });
        s.createIndex('bySession', 'sessionId');
        s.createIndex('byCreated', 'createdAt');
        s.createIndex('byCase', 'caseId');
      }
      if (!db.objectStoreNames.contains('sessions')) {
        db.createObjectStore('sessions', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('kv')) {
        db.createObjectStore('kv');
      }
      if (!db.objectStoreNames.contains('assets')) {
        db.createObjectStore('assets');
      }
      // v2 — the 3BLD letter-pair dictionary. Keyed by the pair itself
      // ("BK"), so writing a memo twice updates it instead of duplicating.
      if (!db.objectStoreNames.contains('letterPairs')) {
        db.createObjectStore('letterPairs', { keyPath: 'pair' });
      }
      // v3 — the gear log. Two stores rather than an array on each cube: the
      // log is append-mostly and read on its own by the chart, so growing it
      // must not mean rewriting the cube record every time.
      if (!db.objectStoreNames.contains('gear')) {
        db.createObjectStore('gear', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('gearLog')) {
        const g = db.createObjectStore('gearLog', { keyPath: 'id' });
        g.createIndex('byGear', 'gearId');
      }
      void e;
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

/* Exported so a store can live in its own module without opening a second
   connection to the same database — gear.js owns the gear stores, this file
   still owns the schema, because the version number is one number. */
export function tx(store, mode = 'readonly') {
  return openDB().then(db => db.transaction(store, mode).objectStore(store));
}

export const wrap = (req) => new Promise((res, rej) => {
  req.onsuccess = () => res(req.result);
  req.onerror = () => rej(req.error);
});

/* ---------------- write hooks ----------------
   Nothing in this file knows about the network — sync.js is the only
   subscriber, and it reaches in through this tiny pub-sub instead of db.js
   importing Firebase. Fired after the local write has already succeeded, so
   a hook throwing or a slow cloud push can never affect what IndexedDB has. */
const hooks = { solves: [], solvesBatch: [], sessions: [], solvesDel: [], sessionsDel: [], kv: [] };

export function onWrite(store, fn) {
  hooks[store].push(fn);
  return () => { hooks[store] = hooks[store].filter(f => f !== fn); };
}

function emit(store, record) {
  for (const fn of hooks[store]) {
    try { fn(record); } catch (err) { console.warn('[db] write hook failed', err); }
  }
}

/* ---------------- tombstones ----------------
   A deleted row leaves a note behind saying it was deleted on purpose.

   Without one, a delete is indistinguishable from never having had the row:
   it empties the local record and nothing else, so the cloud copy outlives
   it and the next listener attach — which every page reload performs —
   streams the solve straight back down into IndexedDB. The note is what
   lets sync.js tell "this device has never seen that" apart from "this
   device threw that away".

   Kept here rather than in sync.js because a delete has to be remembered
   whether or not sync is running: signed out, offline, or before auth has
   resolved, the note is still the thing that stops the row coming back on
   the next sign-in.

   Deliberately local and never uploaded. It guards THIS browser's copy;
   other devices learn of the delete from the cloud row actually being
   removed, so there is no second tree to keep — and no new rules to
   publish by hand for one to be writable. */
const TOMBSTONE_KEY = '_deleted';
const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/* Read once and held in memory so the guard on the receiving end of a sync
   is a map lookup, not an IndexedDB round-trip per incoming record — the
   first attach after a sign-in replays the entire history at once. */
let _tomb = null;
let _tombPromise = null;

function loadTombstones() {
  if (_tomb) return Promise.resolve(_tomb);
  if (!_tombPromise) _tombPromise = (async () => {
    const raw = (await wrap((await tx('kv')).get(TOMBSTONE_KEY))) || {};
    _tomb = { solves: raw.solves || {}, sessions: raw.sessions || {} };
    return _tomb;
  })();
  return _tombPromise;
}

/* Written straight through the store rather than via KV.set: this is
   bookkeeping, not a settings key, and it has no business waking the kv
   write hook. Concurrent callers all mutate the one in-memory object
   synchronously before awaiting, so the last write out carries every
   change rather than clobbering a sibling's. */
function saveTombstones() {
  return tx('kv', 'readwrite').then(store => wrap(store.put(_tomb, TOMBSTONE_KEY)));
}

export const Tombstones = {
  async all() { return loadTombstones(); },
  async has(store, id) { return !!(await loadTombstones())[store][id]; },

  async record(store, ids) {
    const t = await loadTombstones();
    const now = Date.now();
    let changed = false;
    for (const id of ids) if (!t[store][id]) { t[store][id] = now; changed = true; }
    if (changed) await saveTombstones();
  },

  /* A row written back is a row that is wanted again — undo, a re-import, a
     restore. Clearing the note here is what keeps Ctrl+Z working across the
     cloud instead of racing the delete it is undoing. */
  async clear(store, ids) {
    const t = await loadTombstones();
    let changed = false;
    for (const id of ids) if (t[store][id]) { delete t[store][id]; changed = true; }
    if (changed) await saveTombstones();
  },

  /* Notes old enough that every device has long since seen the removal are
     just dead weight in the kv blob. A device that has been offline longer
     than this comes back and re-uploads — the same thing that would happen
     if it had never synced at all. */
  async prune(now = Date.now()) {
    const t = await loadTombstones();
    let changed = false;
    for (const store of ['solves', 'sessions']) {
      for (const [id, at] of Object.entries(t[store])) {
        if (now - at > TOMBSTONE_TTL_MS) { delete t[store][id]; changed = true; }
      }
    }
    if (changed) await saveTombstones();
  },
};

/* ---------------- solves ---------------- */
export const Solves = {
  async put(solve)      {
    const r = await wrap((await tx('solves', 'readwrite')).put(solve));
    await Tombstones.clear('solves', [solve.id]);
    emit('solves', solve);
    return r;
  },
  async putMany(list)   {
    const store = await tx('solves', 'readwrite');
    await Promise.all(list.map(s => wrap(store.put(s))));
    await Tombstones.clear('solves', list.map(s => s.id));
    // One batch event, not one per solve — a 1000-solve csTimer import
    // firing 1000 individual cloud writes would be needless amplification
    // (and, offline, 1000 concurrent queue appends racing each other).
    emit('solvesBatch', list);
  },
  async get(id)         { return wrap((await tx('solves')).get(id)); },
  async del(id)         {
    const r = await wrap((await tx('solves', 'readwrite')).delete(id));
    await Tombstones.record('solves', [id]);
    emit('solvesDel', [id]);
    return r;
  },
  async delMany(ids)    {
    if (!ids.length) return;
    const store = await tx('solves', 'readwrite');
    await Promise.all(ids.map(id => wrap(store.delete(id))));
    await Tombstones.record('solves', ids);
    // One event for the batch, mirroring putMany: clearing a 500-solve
    // session is a single multi-path delete upstream, not 500 of them.
    emit('solvesDel', ids);
  },
  /** Chronological (oldest first) list for a session. */
  async bySession(sessionId) {
    const store = await tx('solves');
    const list = await wrap(store.index('bySession').getAll(sessionId));
    return list.sort((a, b) => a.createdAt - b.createdAt);
  },
  async all() {
    const list = await wrap((await tx('solves')).getAll());
    return list.sort((a, b) => a.createdAt - b.createdAt);
  },
  async clearSession(sessionId) {
    const list = await this.bySession(sessionId);
    await this.delMany(list.map(s => s.id));
    return list;
  },
};

/* ---------------- sessions ---------------- */
export const Sessions = {
  async put(s)  {
    const r = await wrap((await tx('sessions', 'readwrite')).put(s));
    await Tombstones.clear('sessions', [s.id]);
    emit('sessions', s);
    return r;
  },
  async get(id) { return wrap((await tx('sessions')).get(id)); },
  async del(id) {
    const r = await wrap((await tx('sessions', 'readwrite')).delete(id));
    await Tombstones.record('sessions', [id]);
    emit('sessionsDel', [id]);
    return r;
  },
  async all()   {
    const list = await wrap((await tx('sessions')).getAll());
    return list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.createdAt - b.createdAt);
  },
};

/* ---------------- settings kv ---------------- */
export const KV = {
  async get(key, fallback = null) {
    const v = await wrap((await tx('kv')).get(key));
    return v === undefined ? fallback : v;
  },
  async set(key, value) { const r = await wrap((await tx('kv', 'readwrite')).put(value, key)); emit('kv', { key, value }); return r; },
  async del(key)        { return wrap((await tx('kv', 'readwrite')).delete(key)); },
  /**
   * Every entry whose key starts with `prefix`, as a Map, in one transaction.
   *
   * For a namespace stored one key per item — the alg library keeps a row per
   * case — asking for them individually is a transaction each, on the boot
   * path, for data that is a few hundred bytes in total.
   */
  async prefixed(prefix) {
    const store = await tx('kv');
    const range = IDBKeyRange.bound(prefix, prefix + '￿');
    const [keys, values] = await Promise.all([
      wrap(store.getAllKeys(range)),
      wrap(store.getAll(range)),
    ]);
    return new Map(keys.map((k, i) => [k, values[i]]));
  },
};

/* ---------------- assets (background image/video blobs) ---------------- */
export const Assets = {
  async put(key, blob) { return wrap((await tx('assets', 'readwrite')).put(blob, key)); },
  async get(key)       { return wrap((await tx('assets')).get(key)); },
  async del(key)       { return wrap((await tx('assets', 'readwrite')).delete(key)); },
};

/* ---------------- letter pairs (3BLD) ---------------- */
export const LetterPairs = {
  async put(rec)  { return wrap((await tx('letterPairs', 'readwrite')).put({ ...rec, updatedAt: Date.now() })); },
  async get(pair) { return wrap((await tx('letterPairs')).get(pair)); },
  async del(pair) { return wrap((await tx('letterPairs', 'readwrite')).delete(pair)); },
  async all()     {
    const list = await wrap((await tx('letterPairs')).getAll());
    return list.sort((a, b) => a.pair.localeCompare(b.pair));
  },
  async putMany(list) {
    const store = await tx('letterPairs', 'readwrite');
    await Promise.all(list.map(r => wrap(store.put({ ...r, updatedAt: r.updatedAt || Date.now() }))));
  },
  async clear()   { return wrap((await tx('letterPairs', 'readwrite')).clear()); },
};

/* ---------------- backup ---------------- */
export async function exportAll() {
  return {
    app: 'tagdatimer',
    version: 1,
    exportedAt: Date.now(),
    sessions: await Sessions.all(),
    solves: await Solves.all(),
    settings: await KV.get('settings', {}),
    letterPairs: await LetterPairs.all(),
    /* The gear log rides along, read straight from the stores rather than
       through gear.js — that module imports this one, and a backup must not
       depend on the direction of that arrow. A solve carries a `cubeId`, so
       leaving the cubes out would restore solves pointing at nothing. */
    gear: await wrap((await tx('gear')).getAll()),
    gearLog: await wrap((await tx('gearLog')).getAll()),
    gearActive: await KV.get('gear.active', null),
    // What you have learned is not a setting and not a solve, and losing it to
    // a restore would quietly reset every case you had worked up to known.
    learn: await KV.get('learn', {}),
  };
}

export async function importAll(data, { merge = true } = {}) {
  if (!data || !Array.isArray(data.solves)) throw new Error('Not a Tagda Timer backup');
  if (!merge) {
    const db = await openDB();
    await Promise.all(['solves', 'sessions'].map(name =>
      wrap(db.transaction(name, 'readwrite').objectStore(name).clear())));
  }
  for (const s of (data.sessions || [])) await Sessions.put(s);
  await Solves.putMany(data.solves);
  // Backups written before the dictionary existed simply have no key here.
  if (Array.isArray(data.letterPairs) && data.letterPairs.length) {
    await LetterPairs.putMany(data.letterPairs);
  }
  /* Gear is merged in by id, never cleared: a restore that wiped the cubes
     you own would orphan every `cubeId` on the solves already here. Backups
     written before the gear log existed have no key at all. */
  for (const [name, rows] of [['gear', data.gear], ['gearLog', data.gearLog]]) {
    if (!Array.isArray(rows) || !rows.length) continue;
    const store = await tx(name, 'readwrite');
    await Promise.all(rows.map(r => wrap(store.put(r))));
  }
  /* Only if this browser has not already chosen one — the cube on your desk
     is a fact about here and now, not about the machine the backup came from. */
  if (data.gearActive && !(await KV.get('gear.active', null))) {
    await KV.set('gear.active', data.gearActive);
  }
  /* Merged rather than replaced: restoring an old backup onto a machine you
     have been learning on should not throw away the newer schedule. Where both
     sides know a case, the one further along wins. */
  if (data.learn && typeof data.learn === 'object') {
    const mine = (await KV.get('learn', {})) || {};
    for (const [k, v] of Object.entries(data.learn)) {
      const cur = mine[k];
      if (!cur || (v && (v.box ?? 0) > (cur.box ?? 0))) mine[k] = v;
    }
    await KV.set('learn', mine);
  }
  return data.solves.length;
}
