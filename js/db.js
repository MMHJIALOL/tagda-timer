/* ===========================================================
   Tagda Timer — IndexedDB layer (no dependencies)
   Stores: solves, sessions, kv (settings), assets (bg blobs)
   =========================================================== */

const DB_NAME = 'tagdatimer';
const DB_VER  = 1;
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
      void e;
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode = 'readonly') {
  return openDB().then(db => db.transaction(store, mode).objectStore(store));
}

const wrap = (req) => new Promise((res, rej) => {
  req.onsuccess = () => res(req.result);
  req.onerror = () => rej(req.error);
});

/* ---------------- solves ---------------- */
export const Solves = {
  async put(solve)      { return wrap((await tx('solves', 'readwrite')).put(solve)); },
  async putMany(list)   {
    const store = await tx('solves', 'readwrite');
    await Promise.all(list.map(s => wrap(store.put(s))));
  },
  async get(id)         { return wrap((await tx('solves')).get(id)); },
  async del(id)         { return wrap((await tx('solves', 'readwrite')).delete(id)); },
  async delMany(ids)    {
    const store = await tx('solves', 'readwrite');
    await Promise.all(ids.map(id => wrap(store.delete(id))));
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
  async put(s)  { return wrap((await tx('sessions', 'readwrite')).put(s)); },
  async get(id) { return wrap((await tx('sessions')).get(id)); },
  async del(id) { return wrap((await tx('sessions', 'readwrite')).delete(id)); },
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
  async set(key, value) { return wrap((await tx('kv', 'readwrite')).put(value, key)); },
  async del(key)        { return wrap((await tx('kv', 'readwrite')).delete(key)); },
};

/* ---------------- assets (background image/video blobs) ---------------- */
export const Assets = {
  async put(key, blob) { return wrap((await tx('assets', 'readwrite')).put(blob, key)); },
  async get(key)       { return wrap((await tx('assets')).get(key)); },
  async del(key)       { return wrap((await tx('assets', 'readwrite')).delete(key)); },
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
  return data.solves.length;
}
