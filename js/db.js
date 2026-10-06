import { t } from './i18n.js';
/* ===========================================================
   Tagda Timer — IndexedDB layer (no dependencies)
   Stores: solves, sessions, kv (settings), assets (bg blobs),
           letterPairs (the blindfolded pair dictionary),
           gear + gearLog (the cubes you own and what you did to them)
   =========================================================== */

const DB_NAME = 'tagdatimer';
const DB_VER  = 4;
let _db = null;

// Health follows transaction completion, never an IDBRequest's success event.
const completions = new WeakMap();
const localListeners = new Set();
const localErrors = new Map();
const storageFailures = new WeakSet();
let localPending = 0, lastWrite = null;
const RECOVERY_KEY = 'tagda:unsaved';
const recovery = new Map();
try {
  lastWrite = Number(localStorage.getItem('tagda:lastLocalWrite')) || null;
  for (const entry of JSON.parse(localStorage.getItem(RECOVERY_KEY) || '[]')) {
    if (['solves', 'sessions'].includes(entry.store) && entry.id) recovery.set(`${entry.store}:${entry.id}`, entry);
  }
} catch { /* Storage may be unavailable; the page still retains unsaved rows. */ }

export function getLocalStatus() {
  return Object.freeze({
    state: localErrors.size || recovery.size ? 'error' : localPending ? 'saving' : lastWrite ? 'saved' : 'unknown',
    lastWrite, pending: localPending, unsaved: recovery.size,
    quotaError: [...localErrors.values()].some(e => e?.name === 'QuotaExceededError'),
  });
}
export function onLocalStatus(fn) {
  localListeners.add(fn); fn(getLocalStatus());
  return () => localListeners.delete(fn);
}
function notifyLocal() { for (const fn of localListeners) { try { fn(getLocalStatus()); } catch (e) { console.warn('[db] health listener', e); } } }
function saveRecovery() {
  try {
    if (recovery.size) localStorage.setItem(RECOVERY_KEY, JSON.stringify([...recovery.values()]));
    else localStorage.removeItem(RECOVERY_KEY);
  } catch { /* beforeunload warns if this emergency journal cannot be saved. */ }
  notifyLocal();
}
function overlay(store, rows) {
  const byId = new Map(rows.map(r => [r.id, r]));
  for (const r of recovery.values()) if (r.store === store) {
    if (r.value === null) byId.delete(r.id); else byId.set(r.id, r.value);
  }
  return [...byId.values()];
}
export function exportRecovery() {
  // Without the complete set snapshot, competition copies must be ordinary
  // practice records with new IDs so recovery cannot corrupt set membership.
  const solves = overlay('solves', []).map(solve => {
    if (!solve.competitionSetId) return solve;
    const copy = { ...solve, id: `recovered-${solve.id}`, recoverySourceId: solve.id };
    delete copy.competitionSetId; delete copy.competitionAttempt; delete copy.competitionTiming;
    return copy;
  });
  const sessions = new Map(overlay('sessions', []).map(s => [s.id, s]));
  // A recovery-only export must remain importable even if the database can't
  // be read. Otherwise its solves would reference a missing session.
  for (const solve of solves) if (!sessions.has(solve.sessionId)) {
    sessions.set(solve.sessionId, { id: solve.sessionId, name: t('Recovered session'),
      event: solve.event || '333', createdAt: solve.createdAt || Date.now() });
  }
  return { app: 'tagdatimer', version: 1, exportedAt: Date.now(),
    sessions: [...sessions.values()], solves,
    recoveryOnly: true };
}
export const hasUnsavedLocalChange = (store, id) => recovery.has(`${store}:${id}`);
export async function retryLocalWrites() {
  for (const r of [...recovery.values()]) {
    const store = r.store === 'solves' ? Solves : Sessions;
    await (r.value === null ? store.del(r.id) : store.put(r.value));
  }
}
if (typeof window !== 'undefined') window.addEventListener('beforeunload', e => {
  if (!recovery.size && !localErrors.size) return;
  e.preventDefault(); e.returnValue = '';
});



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
      // v4 — fixed competition sets, with immutable ordered solve membership.
      if (!db.objectStoreNames.contains('competitionSets')) {
        const c = db.createObjectStore('competitionSets', { keyPath: 'id' });
        c.createIndex('bySession', 'sessionId');
        c.createIndex('byStatus', 'status');
      }
      const solves = req.transaction.objectStore('solves');
      if (!solves.indexNames.contains('byCompetition')) solves.createIndex('byCompetition', 'competitionSetId');
      void e;
    };
    req.onblocked = () => reject(new Error(t('Close older Tagda Timer tabs, then reload to upgrade the local database.')));
    req.onsuccess = () => {
      const connection = req.result; _db = connection;
      connection.onversionchange = () => { connection.close(); if (_db === connection) _db = null; };
      resolve(connection);
    };
    req.onerror = () => reject(req.error);
  });
}

/* Exported so a store can live in its own module without opening a second
   connection to the same database — gear.js owns the gear stores, this file
   still owns the schema, because the version number is one number. */
export function tx(store, mode = 'readonly', { health = true } = {}) {
  const tracked = mode === 'readwrite' && health;
  if (tracked) { localPending++; notifyLocal(); }
  return openDB().then(db => {
    const transaction = db.transaction(store, mode);
    const done = new Promise((resolve, reject) => {
      transaction.addEventListener('complete', () => {
        if (tracked) {
          localPending--; lastWrite = Date.now();
          if (![...recovery.values()].some(r => r.store === store)) localErrors.delete(store);
          try { localStorage.setItem('tagda:lastLocalWrite', String(lastWrite)); } catch {}
          notifyLocal();
        }
        resolve();
      });
      transaction.addEventListener('abort', () => {
        const error = transaction.error || new Error('Local transaction aborted');
        storageFailures.add(error);
        if (tracked) { localPending--; localErrors.set(store, error); notifyLocal(); }
        reject(error);
      });
    });
    done.catch(() => {}); // Some callers don't wrap a request (e.g. a clear).
    completions.set(transaction, done);
    return transaction.objectStore(store);
  }).catch(error => {
    storageFailures.add(error);
    if (tracked) { localPending--; localErrors.set(store, error); notifyLocal(); }
    throw error;
  });
}

export const wrap = (req) => new Promise((res, rej) => {
  req.onsuccess = () => {
    const transaction = req.transaction || req.source?.transaction || req.source?.objectStore?.transaction;
    const done = transaction?.mode === 'readwrite' ? completions.get(transaction) : null;
    if (done) done.then(() => res(req.result), rej); else res(req.result);
  };
  req.onerror = () => rej(req.error);
});

/* ---------------- write hooks ----------------
   Nothing in this file knows about the network — sync.js is the only
   subscriber, and it reaches in through this tiny pub-sub instead of db.js
   importing Firebase. Fired after the local write has already succeeded, so
   a hook throwing or a slow cloud push can never affect what IndexedDB has. */
const hooks = { solves: [], solvesBatch: [], sessions: [], solvesDel: [], sessionsDel: [], kv: [], rec: [], recDel: [], competition: [] };

export function onWrite(store, fn) {
  hooks[store].push(fn);
  return () => { hooks[store] = hooks[store].filter(f => f !== fn); };
}

/* Exported for the stores that live in their own module (gear.js): 'rec' is
   { store, rec } after a put, 'recDel' is { store, ids } after a delete. */
export function emit(store, record) {
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
let _tombRevision = 0, _tombSavedRevision = 0;

function loadTombstones() {
  if (_tomb) return Promise.resolve(_tomb);
  if (!_tombPromise) _tombPromise = (async () => {
    const raw = (await wrap((await tx('kv')).get(TOMBSTONE_KEY))) || {};
    _tomb = { ...raw, solves: raw.solves || {}, sessions: raw.sessions || {} };
    return _tomb;
  })().catch(error => { _tombPromise = null; throw error; });
  return _tombPromise;
}

/* Written straight through the store rather than via KV.set: this is
   bookkeeping, not a settings key, and it has no business waking the kv
   write hook. Concurrent callers all mutate the one in-memory object
   synchronously before awaiting, so the last write out carries every
   change rather than clobbering a sibling's. */
async function saveTombstones() {
  const store = await tx('kv', 'readwrite', { health: false });
  const revision = _tombRevision;
  await wrap(store.put(_tomb, TOMBSTONE_KEY));
  _tombSavedRevision = Math.max(_tombSavedRevision, revision);
}

export const Tombstones = {
  async refresh() { _tomb = null; _tombPromise = null; return loadTombstones(); },
  async all() { return loadTombstones(); },
  async has(store, id) { return recovery.get(`${store}:${id}`)?.value === null || !!(await loadTombstones())[store]?.[id]; },

  async record(store, ids) {
    const t = await loadTombstones();
    t[store] ||= {};
    const now = Date.now();
    let changed = false;
    for (const id of ids) if (!t[store][id]) { t[store][id] = now; changed = true; }
    if (changed) _tombRevision++;
    if (_tombRevision !== _tombSavedRevision) await saveTombstones();
  },

  /* A row written back is a row that is wanted again — undo, a re-import, a
     restore. Clearing the note here is what keeps Ctrl+Z working across the
     cloud instead of racing the delete it is undoing. */
  async clear(store, ids) {
    const t = await loadTombstones();
    let changed = false;
    for (const id of ids) if (t[store]?.[id]) { delete t[store][id]; changed = true; }
    if (changed) _tombRevision++;
    if (_tombRevision !== _tombSavedRevision) await saveTombstones();
  },

  /* Notes old enough that every device has long since seen the removal are
     just dead weight in the kv blob. A device that has been offline longer
     than this comes back and re-uploads — the same thing that would happen
     if it had never synced at all. */
  async prune(now = Date.now()) {
    const t = await loadTombstones();
    let changed = false;
    for (const store of Object.keys(t)) {
      for (const [id, at] of Object.entries(t[store])) {
        if (now - at > TOMBSTONE_TTL_MS) { delete t[store][id]; changed = true; }
      }
    }
    if (changed) _tombRevision++;
    if (_tombRevision !== _tombSavedRevision) await saveTombstones();
  },
};

/* ---------------- solves ---------------- */
export const Solves = {
  async put(solve)      {
    const r = await atomic(['solves', 'competitionSets'], async tr => {
      const os = tr.objectStore('solves'), previous = await wrap(os.get(solve.id));
      if (previous?.competitionSetId && (solve.competitionSetId !== previous.competitionSetId || solve.competitionAttempt !== previous.competitionAttempt || solve.timeMs !== previous.timeMs || solve.scramble !== previous.scramble)) {
        throw new Error(t('Competition attempt membership and raw time cannot be changed'));
      }
      if (solve.competitionSetId) {
        const c = await wrap(tr.objectStore('competitionSets').get(solve.competitionSetId));
        if (!c || c.solveIds[solve.competitionAttempt-1] !== solve.id) throw new Error(t('This Competition average was deleted or is still syncing'));
      }
      return wrap(os.put(solve));
    });
    await Tombstones.clear('solves', [solve.id]);
    emit('solves', solve);
    return r;
  },
  async putMany(list)   {
    await atomic(['solves'], async tr => {
      const store = tr.objectStore('solves');
      const current = await Promise.all(list.map(s=>wrap(store.get(s.id))));
      for (let i=0;i<list.length;i++) {
        const s=list[i],prev=current[i];
        if (prev?.competitionSetId && (s.competitionSetId!==prev.competitionSetId || s.competitionAttempt!==prev.competitionAttempt || s.timeMs!==prev.timeMs || s.scramble!==prev.scramble)) throw new Error(t('Competition attempt membership and raw time cannot be changed'));
        store.put(s);
      }
    });
    await Tombstones.clear('solves', list.map(s => s.id));
    // One batch event, not one per solve — a 1000-solve csTimer import
    // firing 1000 individual cloud writes would be needless amplification
    // (and, offline, 1000 concurrent queue appends racing each other).
    emit('solvesBatch', list);
  },
  async get(id)         { return wrap((await tx('solves')).get(id)); },
  async count()         { return wrap((await tx('solves')).count()); },
  async del(id)         {
    return this.delMany([id]);
  },
  async delMany(ids)    {
    if (!ids.length) return;
    await atomic(['solves'], async tr => {
      const store = tr.objectStore('solves');
      const rows = await Promise.all(ids.map(id => wrap(store.get(id))));
      if (rows.some(s => s?.competitionSetId)) throw new Error(t('Competition attempts belong to a set. Delete the entire average.'));
      ids.forEach(id => store.delete(id));
    });
    await Tombstones.record('solves', ids);
    emit('solvesDel', ids);
  },
  /** Chronological (oldest first) list for a session. */
  async bySession(sessionId) {
    const store = await tx('solves');
    const list = await wrap(store.index('bySession').getAll(sessionId));
    return overlay('solves', list).filter(s => s.sessionId === sessionId).sort((a, b) => a.createdAt - b.createdAt);
  },
  async all() {
    const list = await wrap((await tx('solves')).getAll());
    return overlay('solves', list).sort((a, b) => a.createdAt - b.createdAt);
  },
  async clearSession(sessionId) {
    for (const set of (await CompetitionSets.all()).filter(s => s.sessionId === sessionId)) await CompetitionSets.delete(set.id);
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
    if ((await CompetitionSets.all()).some(c=>c.sessionId===id)) throw new Error(t('Clear the session’s whole Competition sets before deleting it'));
    const r = await wrap((await tx('sessions', 'readwrite')).delete(id));
    await Tombstones.record('sessions', [id]);
    emit('sessionsDel', [id]);
    return r;
  },
  async all()   {
    const list = await wrap((await tx('sessions')).getAll());
    return overlay('sessions', list).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.createdAt - b.createdAt);
  },
};

// Keep failed solve/session mutations available to the list and full export.
// The emergency journal survives refresh when localStorage is still writable.
const mutationVersions = new Map();
for (const [name, api] of [['solves', Solves], ['sessions', Sessions]]) {
  for (const method of ['put', 'putMany', 'del', 'delMany']) {
    if (!api[method]) continue;
    const original = api[method];
    api[method] = async function (arg) {
      const values = method.endsWith('Many') ? arg : [arg];
      const entries = values.map(value => {
        const id = method.startsWith('put') ? value.id : value;
        const key = `${name}:${id}`;
        const version = (mutationVersions.get(key) || 0) + 1;
        mutationVersions.set(key, version);
        return { key, version, entry: { store: name, id, value: method.startsWith('put') ? structuredClone(value) : null } };
      });
      try {
        const result = await original.call(this, arg);
        for (const { key, version } of entries) if (mutationVersions.get(key) === version) recovery.delete(key);
        if (![...recovery.values()].some(r => r.store === name)) localErrors.delete(name);
        if (entries.length) saveRecovery();
        return result;
      } catch (error) {
        if (!storageFailures.has(error) && !(error instanceof DOMException)) throw error;
        localErrors.set(name, error);
        for (const { key, version, entry } of entries) if (mutationVersions.get(key) === version) recovery.set(key, entry);
        saveRecovery();
        throw error;
      }
    };
  }
  const originalGet = api.get;
  api.get = async id => recovery.has(`${name}:${id}`) ? recovery.get(`${name}:${id}`).value : originalGet.call(api, id);
}

// Bookkeeping is deliberately outside KV's write hook and normal health writes.
export const LocalMetadata = {
  get: (key, fallback = null) => KV.get(key, fallback),
  async set(key, value) {
    return wrap((await tx('kv', 'readwrite', { health: false })).put(value, key));
  },
  async updateQueue(change) {
    // One readwrite transaction also serializes queue mutations across tabs.
    const store = await tx('kv', 'readwrite', { health: false });
    return new Promise((resolve, reject) => {
      const request = store.get('_syncQueue');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        try {
          const entries = change(request.result || []);
          wrap(store.put(entries, '_syncQueue')).then(() => resolve(entries), reject);
        } catch (error) { reject(error); }
      };
    });
  },
};

/* ---------------- settings kv ---------------- */
export const KV = {
  async get(key, fallback = null) {
    const v = await wrap((await tx('kv')).get(key));
    return v === undefined ? fallback : v;
  },
  async set(key, value) { const r = await wrap((await tx('kv', 'readwrite')).put(value, key)); emit('kv', { key, value }); return r; },
  // Read and merge in one transaction, so two tabs cannot both read an old
  // settings snapshot and then overwrite one another's newer inspection choice.
  async update(key, update, fallback = {}) {
    const store = await tx('kv', 'readwrite');
    return new Promise((resolve, reject) => {
      const request = store.get(key);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        try {
          const value = update(request.result === undefined ? fallback : request.result);
          wrap(store.put(value, key)).then(() => {
            emit('kv', { key, value });
            resolve(value);
          }, reject);
        } catch (error) { store.transaction.abort(); reject(error); }
      };
    });
  },
  async del(key)        { const r = await wrap((await tx('kv', 'readwrite')).delete(key)); emit('kv', { key, value: null }); return r; },
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
/* Record stores other than solves/sessions share one pair of write hooks —
   sync.js mirrors each to users/<uid>/<store>, keyed by `idKey`. */
async function putRec(store, rec, idKey = 'id') {
  const r = await wrap((await tx(store, 'readwrite')).put(rec));
  await Tombstones.clear(store, [rec[idKey]]);
  emit('rec', { store, rec });
  return r;
}

async function delRecs(store, ids) {
  if (!ids.length) return;
  const os = await tx(store, 'readwrite');
  await Promise.all(ids.map(id => wrap(os.delete(id))));
  await Tombstones.record(store, ids);
  emit('recDel', { store, ids });
}

export { putRec, delRecs };

export const LetterPairs = {
  async put(rec)  { return putRec('letterPairs', { ...rec, updatedAt: Date.now() }, 'pair'); },
  async get(pair) { return wrap((await tx('letterPairs')).get(pair)); },
  async del(pair) { return delRecs('letterPairs', [pair]); },
  async all()     {
    const list = await wrap((await tx('letterPairs')).getAll());
    return list.sort((a, b) => a.pair.localeCompare(b.pair));
  },
  async putMany(list) {
    for (const r of list) await putRec('letterPairs', { ...r, updatedAt: r.updatedAt || Date.now() }, 'pair');
  },
  async clear()   { return delRecs('letterPairs', (await this.all()).map(r => r.pair)); },
};

/* ---------------- backup ---------------- */
export async function exportAll() {
  // Solves and their set boundaries must come from the same snapshot, even
  // when another tab records an attempt while a backup is being downloaded.
  const snapshot = (await openDB()).transaction(['sessions','solves','competitionSets']);
  const [sessions, solves, sets] = await Promise.all(['sessions','solves','competitionSets'].map(name=>wrap(snapshot.objectStore(name).getAll())));
  return {
    app: 'tagdatimer',
    version: 2,
    exportedAt: Date.now(),
    sessions: overlay('sessions', sessions).sort((a,b)=>(a.order??0)-(b.order??0)||a.createdAt-b.createdAt),
    solves: overlay('solves', solves).sort((a,b)=>a.createdAt-b.createdAt),
    competitionSets: sets.map(normalizeCompetition).sort((a,b)=>b.createdAt-a.createdAt),
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
  if (!data || !Array.isArray(data.solves)) throw new Error(t('Not a Tagda Timer backup'));
  // Validate the complete backup before any destructive replacement or write.
  const incomingSets = Array.isArray(data.competitionSets) ? data.competitionSets.map(normalizeCompetition) : [];
  const known = new Map(incomingSets.map(c => [c.id,c]));
  const rows = new Map(data.solves.map(s => [s.id,s]));
  if (rows.size !== data.solves.length) throw new Error(t('Duplicate solve IDs in backup'));
  for (const c of incomingSets) for (let i=0;i<c.solveIds.length;i++) {
    const s=rows.get(c.solveIds[i]);
    if (!s || s.competitionSetId!==c.id || s.competitionAttempt!==i+1 || s.event!==c.event || s.sessionId!==c.sessionId || s.mode!=='wca') {
      throw new Error(t('Invalid Competition set membership'));
    }
  }
  for (const s of data.solves) {
    if (!s.competitionSetId) continue;
    const c=known.get(s.competitionSetId);
    if (!c || c.solveIds[s.competitionAttempt-1]!==s.id) throw new Error(t('Backup is missing a Competition set'));
  }
  const deleted = await KV.get('_competitionDeleted', {});
  // A merge of an old backup cannot revive an intentionally deleted set.
  const sets = incomingSets.filter(c => !deleted[c.id]);
  const solves = data.solves.filter(s => !s.competitionSetId || !deleted[s.competitionSetId]);
  /* A replace discards only the sets the backup does not bring back. Deleting
     one it restores would queue its videos for cleanup and push a 'discarded'
     record the rules never let it come back from. */
  if (!merge) for (const c of await CompetitionSets.all()) if (!known.has(c.id)) await CompetitionSets.delete(c.id);
  await atomic(['solves', 'competitionSets', 'sessions', 'kv'], async tr => {
    if (!merge) { tr.objectStore('solves').clear(); tr.objectStore('sessions').clear(); tr.objectStore('competitionSets').clear(); }
    for (const s of (data.sessions || [])) tr.objectStore('sessions').put(s);
    for (let i=0;i<sets.length;i++) {
      const c=sets[i], current=await wrap(tr.objectStore('competitionSets').get(c.id));
      if (current) {
        const common=Math.min(current.solveIds.length,c.solveIds.length);
        if (current.size!==c.size || current.event!==c.event || current.sessionId!==c.sessionId || current.solveIds.slice(0,common).some((id,j)=>id!==c.solveIds[j])) {
          throw new Error(t('Backup conflicts with existing Competition membership'));
        }
        if (current.solveIds.length>c.solveIds.length) sets[i]=current;
      }
      tr.objectStore('competitionSets').put(sets[i]);
    }
    for (let i=0;i<solves.length;i++) {
      const s=solves[i], current=await wrap(tr.objectStore('solves').get(s.id));
      if (current?.competitionSetId) {
        if (current.competitionSetId!==s.competitionSetId || current.competitionAttempt!==s.competitionAttempt || current.timeMs!==s.timeMs || current.scramble!==s.scramble) throw new Error(t('Backup conflicts with existing Competition membership'));
        if ((current.penaltyUpdatedAt||0)>(s.penaltyUpdatedAt||0)) solves[i]=current;
      }
      tr.objectStore('solves').put(solves[i]);
    }
    const pending=(await wrap(tr.objectStore('kv').get('_competitionDeleted'))) || {};
    sets.forEach(c=>delete pending[c.id]);tr.objectStore('kv').put(pending,'_competitionDeleted');
  });
  await Tombstones.clear('solves', solves.map(s => s.id));
  await Tombstones.clear('competitionSets', sets.map(c => c.id));
  for (const s of (data.sessions || [])) { await Tombstones.clear('sessions',[s.id]); emit('sessions',s); }
  /* Ordinary solves upload in their own batch, as before. Sharing one atomic
     update with Competition records would let unpublished rules refuse them all. */
  const ordinary = solves.filter(s => !s.competitionSetId);
  if (ordinary.length) emit('solvesBatch', ordinary);
  emit('competition', { sets, solves: solves.filter(s => s.competitionSetId) });
  // Backups written before the dictionary existed simply have no key here.
  if (Array.isArray(data.letterPairs) && data.letterPairs.length) {
    await LetterPairs.putMany(data.letterPairs);
  }
  /* Gear is merged in by id, never cleared: a restore that wiped the cubes
     you own would orphan every `cubeId` on the solves already here. Backups
     written before the gear log existed have no key at all. */
  for (const [name, rows] of [['gear', data.gear], ['gearLog', data.gearLog]]) {
    if (!Array.isArray(rows) || !rows.length) continue;
    for (const r of rows) await putRec(name, r);
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


/* Transactions resolve only after commit, not after the last request. Any
   guard failure aborts the entire operation, including writes already queued. */
async function atomic(stores, fn) {
  localPending++; notifyLocal();
  let tr, finished = false;
  const finish = error => {
    if (finished) return;
    finished = true; localPending--;
    if (error) {
      storageFailures.add(error);
      for (const store of stores) localErrors.set(store, error);
    }
    else {
      lastWrite = Date.now();
      for (const store of stores) if (![...recovery.values()].some(r => r.store === store)) localErrors.delete(store);
      try { localStorage.setItem('tagda:lastLocalWrite', String(lastWrite)); } catch {}
    }
    notifyLocal();
  };
  try { tr = (await openDB()).transaction(stores, 'readwrite'); }
  catch (error) { finish(error); throw error; }
  const done = new Promise((resolve, reject) => {
    tr.oncomplete = resolve;
    tr.onabort = tr.onerror = () => reject(tr.error || new DOMException('Transaction aborted', 'AbortError'));
  });
  done.catch(() => {});
  try { const value = await fn(tr); await done; finish(); return value; }
  catch (error) {
    try { tr.abort(); } catch {}
    await done.catch(() => {});
    // Validation errors abort intentionally; they are not a storage failure.
    if (error instanceof DOMException || tr.error) finish(error);
    else { finished = true; localPending--; notifyLocal(); }
    throw error;
  }
}

export function normalizeCompetition(c) {
  if (!c?.id || !c.sessionId || !c.event || !['active','complete','discarded'].includes(c.status) || !Number.isSafeInteger(c.size) || c.size < 5) throw new Error(t('Invalid Competition set size'));
  const solveIds = Array.isArray(c.solveIds) ? [...c.solveIds] : Object.values(c.solveIds || {});
  if (new Set(solveIds).size !== solveIds.length || solveIds.length > c.size || (c.status === 'complete' && solveIds.length !== c.size)) {
    throw new Error(t('Invalid Competition set membership'));
  }
  return { ...c, solveIds };
}

export const CompetitionSets = {
  async get(id) { const c = await wrap((await tx('competitionSets')).get(id)); return c ? normalizeCompetition(c) : null; },
  async all() { return (await wrap((await tx('competitionSets')).getAll())).map(normalizeCompetition).sort((a,b) => b.createdAt-a.createdAt); },
  async put(c) {
    c=normalizeCompetition(c);
    await atomic(['competitionSets'],async tr=>{
      const os=tr.objectStore('competitionSets'),prev=await wrap(os.get(c.id));
      if(prev?.solveIds.length && (prev.size!==c.size || prev.event!==c.event || prev.sessionId!==c.sessionId || JSON.stringify(prev.solveIds)!==JSON.stringify(c.solveIds))) throw new Error(t('Competition membership is immutable; discard and start a new set'));
      os.put(c);
    });
    await Tombstones.clear('competitionSets',[c.id]);emit('competition',{sets:[c]});
  },
  async create(c) {
    c = normalizeCompetition(c);
    await atomic(['competitionSets'], async tr => {
      const os = tr.objectStore('competitionSets');
      if ((await wrap(os.getAll())).some(s => s.status === 'active')) throw new Error(t('Resume or discard the unfinished set first'));
      os.add(c);
    });
    emit('competition', { sets: [c] });
    return c;
  },
  // Never write a stale in-memory set over membership another tab committed.
  async patch(id, patch, expectedAttempt = null) {
    delete patch.solveIds; delete patch.size; delete patch.event; delete patch.sessionId;
    const c = await atomic(['competitionSets'], async tr => {
      const os = tr.objectStore('competitionSets'), c = await wrap(os.get(id));
      if (!c) return null;
      if (patch.currentScramble && (c.status !== 'active' || (expectedAttempt !== null && c.solveIds.length+1 !== expectedAttempt))) return c;
      Object.assign(c, patch, { updatedAt: Date.now() }); os.put(c); return c;
    });
    if (c) emit('competition', { sets: [c] });
    return c;
  },
  async record(id, solve, expectedAttempt) {
    const c = await atomic(['competitionSets', 'solves'], async tr => {
      const os = tr.objectStore('competitionSets'), c = await wrap(os.get(id));
      if (!c || c.status !== 'active' || c.solveIds.length + 1 !== expectedAttempt) throw new Error(t('The set changed in another tab. Return to set before timing.'));
      if (!c.currentScramble?.scramble || solve.scramble !== c.currentScramble.scramble) throw new Error(t('The scramble changed in another tab. Return to set before timing.'));
      if (solve.event !== c.event || solve.sessionId !== c.sessionId || solve.mode !== 'wca') throw new Error(t('Return to the set event and Random state mode'));
      solve.competitionSetId = id; solve.competitionAttempt = expectedAttempt;
      c.solveIds.push(solve.id); c.currentScramble = null; c.updatedAt = Date.now();
      if (c.solveIds.length === c.size) { c.status = 'complete'; c.completedAt = Date.now(); }
      tr.objectStore('solves').add(solve); os.put(c); return c;
    });
    emit('competition', { sets: [c], solves: [solve] });
    return c;
  },
  async members(c) {
    const os = await tx('solves');
    return Promise.all(c.solveIds.map(id => wrap(os.get(id))));
  },
  async delete(id) {
    await loadTombstones();
    let tomb;
    const result = await atomic(['competitionSets', 'solves', 'kv'], async tr => {
      const c = await wrap(tr.objectStore('competitionSets').get(id));
      if (!c) return null;
      tomb = (await wrap(tr.objectStore('kv').get(TOMBSTONE_KEY))) || {};
      // Include tagged rows too: recovery from an incomplete older sync cannot
      // strand a member or accidentally delete an unrelated solve.
      const rows = await wrap(tr.objectStore('solves').index('byCompetition').getAll(id));
      const ids = [...new Set([...c.solveIds, ...rows.map(s => s.id)])];
      tomb.competitionSets ||= {}; tomb.competitionSets[id] = Date.now();
      tomb.solves ||= {}; ids.forEach(sid => { tomb.solves[sid] = Date.now(); tr.objectStore('solves').delete(sid); });
      tr.objectStore('competitionSets').delete(id);
      tr.objectStore('kv').put(tomb, TOMBSTONE_KEY);
      // Media is a separate local database. Persist cleanup in the same commit
      // as deletion; a reload retries it if media deletion was interrupted.
      const cleanup = (await wrap(tr.objectStore('kv').get('_competitionMediaCleanup'))) || [];
      cleanup.push({ id, solveIds: ids }); tr.objectStore('kv').put(cleanup, '_competitionMediaCleanup');
      const set = { ...c, status: 'discarded', replayStatus: 'none', deletedAt: Date.now(), updatedAt: Date.now() };
      const deleted = (await wrap(tr.objectStore('kv').get('_competitionDeleted'))) || {};
      deleted[id] = set; tr.objectStore('kv').put(deleted, '_competitionDeleted');
      return { id, ids, set };
    });
    if (result) {
      _tomb = tomb;
      for (const sid of result.ids) {
        const key = `solves:${sid}`;
        mutationVersions.set(key, (mutationVersions.get(key) || 0) + 1);
        recovery.delete(key);
      }
      if (![...recovery.values()].some(r => r.store === 'solves')) localErrors.delete('solves');
      saveRecovery();
      emit('competition', { deleted: result });
    }
    return result;
  },
};
