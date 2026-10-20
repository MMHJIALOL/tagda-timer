/* ===========================================================
   Tagda Timer — an IndexedDB that only lives in memory

   For a browser that refuses this site IndexedDB altogether: Chrome and
   Edge with cookies and site data blocked (a common policy on work and
   school laptops), Firefox with every cookie blocked, Safari's "Block All
   Cookies". db.js used to fail to open there, and the timer never started.
   It falls back to this instead (only then: it is loaded on demand), so the
   timer works for as long as the tab is open, and says on screen that
   nothing is being kept (memoryOnly() in db.js).

   Only what db.js and gear.js ask of IndexedDB is here: object stores with a
   key path or out-of-line keys, plain and unique indexes, get / getAll /
   getAllKeys / count / put / add / delete / clear, value and key cursors
   with continue(), key ranges (the browser's own IDBKeyRange, read by its
   bounds), and transactions that commit once they run out of work and roll
   back on abort. Transactions run one at a time, oldest first: stricter
   than the real thing, never wrong for code written against it. Values go
   in and come out as structured clones, as they do on disk.
   =========================================================== */

const fail = (name, message) => new DOMException(message, name);

/* ---------------- keys ---------------- */

/** IndexedDB's key order: numbers, then dates, strings, binary, arrays. -1: not a key. */
function kind(k) {
  if (typeof k === 'number') return Number.isNaN(k) ? -1 : 1;
  if (k instanceof Date) return Number.isNaN(k.getTime()) ? -1 : 2;
  if (typeof k === 'string') return 3;
  if (k instanceof ArrayBuffer || ArrayBuffer.isView(k)) return 4;
  if (Array.isArray(k)) return k.every(x => kind(x) > 0) ? 5 : -1;
  return -1;
}
const validKey = (k) => kind(k) > 0;
const bytes = (k) => k instanceof ArrayBuffer ? new Uint8Array(k) : new Uint8Array(k.buffer, k.byteOffset, k.byteLength);

export function cmp(a, b) {
  const ka = kind(a), kb = kind(b);
  if (ka < 0 || kb < 0) throw fail('DataError', 'The parameter is not a valid key.');
  if (ka !== kb) return ka < kb ? -1 : 1;
  if (ka === 2) { a = a.getTime(); b = b.getTime(); }
  if (ka === 4 || ka === 5) {
    const x = ka === 4 ? bytes(a) : a, y = ka === 4 ? bytes(b) : b;
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
      const c = ka === 4 ? (x[i] < y[i] ? -1 : x[i] > y[i] ? 1 : 0) : cmp(x[i], y[i]);
      if (c) return c;
    }
    return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

const isRange = (q) => !!q && typeof q === 'object' && 'lowerOpen' in q && 'upperOpen' in q;
function inRange(key, q) {
  if (q === undefined || q === null) return true;
  if (!isRange(q)) return cmp(key, q) === 0;
  if (q.lower !== undefined) { const c = cmp(key, q.lower); if (c < 0 || (c === 0 && q.lowerOpen)) return false; }
  if (q.upper !== undefined) { const c = cmp(key, q.upper); if (c > 0 || (c === 0 && q.upperOpen)) return false; }
  return true;
}
function checkQuery(q) {
  if (q !== undefined && q !== null && !isRange(q) && !validKey(q)) throw fail('DataError', 'The parameter is not a valid key.');
}

/** The value at a key path ('a.b', '' for the value itself, or an array of paths). */
function at(value, path) {
  if (Array.isArray(path)) return path.map(p => at(value, p));
  let v = value;
  for (const part of path ? path.split('.') : []) {
    if (v === null || v === undefined) return undefined;
    v = v[part];
  }
  return v;
}
const copy = (v) => structuredClone(v);

/** Binary search for `key` in records sorted by key: { at, found }. */
function find(records, key) {
  let lo = 0, hi = records.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1, c = cmp(records[mid].key, key);
    if (c === 0) return { at: mid, found: true };
    if (c < 0) lo = mid + 1; else hi = mid;
  }
  return { at: lo, found: false };
}

/* ---------------- events ---------------- */

class Target extends EventTarget {
  fire(type, { cancelable = false, extra = null } = {}) {
    const ev = new Event(type, { cancelable });
    if (extra) Object.assign(ev, extra);
    this.dispatchEvent(ev);
    return ev;
  }
}
/** onsuccess = fn and friends, as listeners, so e.target is the request as it is in a browser. */
function handlers(cls, types) {
  for (const type of types) {
    const slot = Symbol(type);
    Object.defineProperty(cls.prototype, `on${type}`, {
      get() { return this[slot]?.fn ?? null; },
      set(fn) {
        if (this[slot]) this.removeEventListener(type, this[slot].listener);
        this[slot] = null;
        if (typeof fn !== 'function') return;
        const listener = (e) => fn.call(this, e);
        this[slot] = { fn, listener };
        this.addEventListener(type, listener);
      },
    });
  }
}

class Names {
  constructor(list) { this._list = [...list].sort(); }
  get length() { return this._list.length; }
  item(i) { return this._list[i] ?? null; }
  contains(name) { return this._list.includes(name); }
  [Symbol.iterator]() { return this._list[Symbol.iterator](); }
}

/* ---------------- scheduling ----------------
   One request per task, like the real thing, so the microtasks that follow
   a success (an await on it) can still add to the same transaction. A
   MessageChannel rather than setTimeout: no 4 ms clamp on a long cursor. */

const jobs = [];
const port = typeof MessageChannel === 'function' ? new MessageChannel() : null;
if (port) port.port1.onmessage = () => jobs.shift()?.();
const later = (fn) => { if (port) { jobs.push(fn); port.port2.postMessage(0); } else setTimeout(fn, 0); };

const running = [];   // transactions, oldest first; running[0] is the one at work
function enqueue(txn) {
  running.push(txn);
  if (running.length === 1) later(step);
}
function step() {
  const txn = running[0];
  if (!txn) return;
  if (txn.state === 'active') {
    const job = txn._jobs.shift();
    if (job) { txn._idle = false; txn._run(job); later(step); return; }
    // Out of work: one more turn for whatever was awaiting the last result, then commit.
    if (!txn._idle) { txn._idle = true; later(step); return; }
    txn._commit();
  }
  running.shift();
  if (running.length) later(step);
}

/* ---------------- requests and transactions ---------------- */

class Request extends Target {
  constructor(source, transaction) {
    super();
    this.source = source;
    this.transaction = transaction;
    this.readyState = 'pending';
    this.result = undefined;
    this.error = null;
  }
}
handlers(Request, ['success', 'error', 'upgradeneeded', 'blocked']);

class Transaction extends Target {
  constructor(db, names, mode) {
    super();
    this.db = db;
    this.mode = mode;
    this.error = null;
    this.state = 'active';
    this._names = names;
    this._jobs = [];
    this._idle = false;
    this._undo = mode === 'readonly' ? null : new Map();   // store -> its records before this transaction
  }

  get objectStoreNames() { return new Names(this.mode === 'versionchange' ? this.db._data.stores.keys() : this._names); }

  objectStore(name) {
    if (this.state !== 'active') throw fail('InvalidStateError', 'The transaction has finished.');
    const data = this.db._data.stores.get(name);
    if (!data || (this.mode !== 'versionchange' && !this._names.includes(name))) {
      throw fail('NotFoundError', `No object store named ${name} in this transaction.`);
    }
    return new ObjectStore(this, data);
  }

  abort() {
    if (this.state !== 'active') throw fail('InvalidStateError', 'The transaction has finished.');
    this._abort(null);
  }

  commit() { this._idle = true; }

  /** A request whose `run` is done in its turn; `again` reuses a cursor's request. */
  _request(source, run, again = null) {
    if (this.state !== 'active') throw fail('TransactionInactiveError', 'The transaction has finished.');
    const req = again || new Request(source, this);
    req.readyState = 'pending';
    this._idle = false;
    this._jobs.push({ req, run });
    return req;
  }

  _run({ req, run }) {
    let result, error = null;
    try { result = run(); } catch (e) { error = e; }
    req.readyState = 'done';
    if (!error) { req.result = result; req.fire('success'); return; }
    req.error = error;
    req.result = undefined;
    // As in a browser: an error nobody handles (preventDefault) aborts the transaction.
    if (!req.fire('error', { cancelable: true }).defaultPrevented) {
      this.fire('error');
      this._abort(error);
    }
  }

  /** Before the first write to a store, remember it, so an abort can put it back. */
  _touch(data) {
    if (this._undo && !this._undo.has(data)) this._undo.set(data, data.records.map(r => ({ ...r })));
  }

  _commit() {
    if (this.state !== 'active') return;
    this.state = 'finished';
    this._undo = null;
    this.fire('complete');
  }

  _abort(error) {
    if (this.state !== 'active') return;
    this.state = 'finished';
    this.error = error;
    for (const [data, records] of this._undo || []) data.records = records;
    this._undo = null;
    for (const { req } of this._jobs.splice(0)) {
      req.readyState = 'done';
      req.error = fail('AbortError', 'The transaction was aborted.');
      req.fire('error', { cancelable: true });
    }
    later(() => this.fire('abort'));
  }
}
handlers(Transaction, ['complete', 'abort', 'error']);

/* ---------------- stores, indexes, cursors ---------------- */

/** Shared by stores and indexes: their entries as { key, primaryKey, value }, in key order. */
function readers(proto) {
  Object.assign(proto, {
    get(query) {
      checkQuery(query);
      return this._req(() => { const e = this._entries(query)[0]; return e ? copy(e.value) : undefined; });
    },
    getKey(query) {
      checkQuery(query);
      return this._req(() => this._entries(query)[0]?.primaryKey);
    },
    getAll(query, count) {
      checkQuery(query);
      return this._req(() => this._entries(query).slice(0, count || undefined).map(e => copy(e.value)));
    },
    getAllKeys(query, count) {
      checkQuery(query);
      return this._req(() => this._entries(query).slice(0, count || undefined).map(e => copy(e.primaryKey)));
    },
    count(query) {
      checkQuery(query);
      return this._req(() => this._entries(query).length);
    },
    openCursor(query, direction = 'next') { return this._cursor(query, direction, true); },
    openKeyCursor(query, direction = 'next') { return this._cursor(query, direction, false); },
    _req(run, again) { return this._store.transaction._request(this, run, again); },
    _cursor(query, direction, withValue) {
      checkQuery(query);
      if (!['next', 'nextunique', 'prev', 'prevunique'].includes(direction)) throw new TypeError(`Bad cursor direction ${direction}`);
      let list = null;
      const req = this._req(() => {
        list = this._entries(query);
        if (direction.endsWith('unique')) list = list.filter((e, i) => i === 0 || cmp(e.key, list[i - 1].key) !== 0);
        if (direction.startsWith('prev')) list.reverse();
        return list.length ? new Cursor(this, req, list, 0, direction, withValue) : null;
      });
      return req;
    },
  });
}

class ObjectStore {
  constructor(transaction, data) { this.transaction = transaction; this._data = data; }
  get _store() { return this; }
  get name() { return this._data.name; }
  get keyPath() { return this._data.keyPath; }
  get autoIncrement() { return this._data.autoIncrement; }
  get indexNames() { return new Names(this._data.indexes.keys()); }

  index(name) {
    const ix = this._data.indexes.get(name);
    if (!ix) throw fail('NotFoundError', `No index named ${name}.`);
    return new Index(this, ix);
  }
  createIndex(name, keyPath, { unique = false, multiEntry = false } = {}) {
    if (this.transaction.mode !== 'versionchange') throw fail('InvalidStateError', 'Indexes are made in an upgrade.');
    if (this._data.indexes.has(name)) throw fail('ConstraintError', `An index named ${name} already exists.`);
    const ix = { name, keyPath, unique, multiEntry };
    this._data.indexes.set(name, ix);
    return new Index(this, ix);
  }
  deleteIndex(name) {
    if (this.transaction.mode !== 'versionchange') throw fail('InvalidStateError', 'Indexes are removed in an upgrade.');
    this._data.indexes.delete(name);
  }

  put(value, key) { return this._write(value, key, false); }
  add(value, key) { return this._write(value, key, true); }
  delete(query) {
    this._writable();
    checkQuery(query);
    return this._req(() => {
      const d = this._data;
      this.transaction._touch(d);
      d.records = d.records.filter(r => !inRange(r.key, query));
    });
  }
  clear() {
    this._writable();
    return this._req(() => { this.transaction._touch(this._data); this._data.records = []; });
  }

  _writable() {
    if (this.transaction.mode === 'readonly') throw fail('ReadOnlyError', 'The transaction is read-only.');
  }
  /* Cloned and keyed now, as a browser does at the call: a caller that
     changes the object afterwards has not changed what was stored. */
  _write(value, key, noOverwrite) {
    this._writable();
    const d = this._data;
    const stored = copy(value);
    if (d.keyPath !== null && key !== undefined) throw fail('DataError', 'This store has a key path; no key may be given.');
    let k = d.keyPath !== null ? at(stored, d.keyPath) : key;
    if (k === undefined && d.autoIncrement) {
      k = d.next;
      if (d.keyPath !== null) stored[d.keyPath] = k;
    }
    if (!validKey(k)) throw fail('DataError', 'The record has no valid key.');
    k = copy(k);
    return this._req(() => {
      const spot = find(d.records, k);
      if (spot.found && noOverwrite) throw fail('ConstraintError', 'A record with that key already exists.');
      for (const ix of d.indexes.values()) {
        if (!ix.unique) continue;
        const want = at(stored, ix.keyPath);
        if (validKey(want) && d.records.some(r => cmp(r.key, k) !== 0 && validKey(at(r.value, ix.keyPath)) && cmp(at(r.value, ix.keyPath), want) === 0)) {
          throw fail('ConstraintError', `Another record already has that ${ix.name}.`);
        }
      }
      this.transaction._touch(d);
      if (spot.found) d.records[spot.at] = { key: k, value: stored };
      else d.records.splice(spot.at, 0, { key: k, value: stored });
      if (typeof k === 'number' && k >= d.next) d.next = Math.floor(k) + 1;
      return copy(k);
    });
  }
  _entries(query) {
    return this._data.records.filter(r => inRange(r.key, query)).map(r => ({ key: r.key, primaryKey: r.key, value: r.value }));
  }
}
readers(ObjectStore.prototype);

class Index {
  constructor(store, ix) { this.objectStore = store; this._ix = ix; }
  get _store() { return this.objectStore; }
  get name() { return this._ix.name; }
  get keyPath() { return this._ix.keyPath; }
  get unique() { return this._ix.unique; }
  get multiEntry() { return this._ix.multiEntry; }
  /* Records whose key path holds no valid key are not in the index at all,
     as in a browser: a solve with no caseId is simply not under byCase. */
  _entries(query) {
    const out = [];
    for (const r of this.objectStore._data.records) {
      const k = at(r.value, this._ix.keyPath);
      const keys = this._ix.multiEntry && Array.isArray(k) ? k.filter((x, i) => validKey(x) && k.findIndex(y => validKey(y) && cmp(x, y) === 0) === i) : [k];
      for (const key of keys) if (validKey(key) && inRange(key, query)) out.push({ key, primaryKey: r.key, value: r.value });
    }
    return out.sort((a, b) => cmp(a.key, b.key) || cmp(a.primaryKey, b.primaryKey));
  }
}
readers(Index.prototype);

/* Walks the list it was opened on. Writes made while it is open are not
   seen by it, which the app's cursors (counting and listing keys) never need. */
class Cursor {
  constructor(source, request, list, i, direction, withValue) {
    this.source = source;
    this.request = request;
    this.direction = direction;
    this._list = list;
    this._i = i;
    this._withValue = withValue;
    this._value = undefined;
  }
  get key() { return copy(this._list[this._i].key); }
  get primaryKey() { return copy(this._list[this._i].primaryKey); }
  get value() {
    if (!this._withValue) return undefined;
    if (this._value === undefined) this._value = copy(this._list[this._i].value);
    return this._value;
  }
  continue(key) {
    if (key !== undefined && !validKey(key)) throw fail('DataError', 'The parameter is not a valid key.');
    const back = this.direction.startsWith('prev');
    this._move((e) => key === undefined || (back ? cmp(e.key, key) <= 0 : cmp(e.key, key) >= 0), 1);
  }
  advance(n) {
    if (!(n > 0)) throw new TypeError('advance() needs a positive count');
    this._move(() => true, n);
  }
  update(value) {
    const store = this.source._store;
    return store.put(value, store.keyPath === null ? this._list[this._i].primaryKey : undefined);
  }
  delete() { return this.source._store.delete(this._list[this._i].primaryKey); }

  _move(ok, n) {
    this.source._req(() => {
      let i = this._i, left = n;
      while (++i < this._list.length) if (ok(this._list[i]) && --left === 0) break;
      if (i >= this._list.length) return null;
      this._i = i;
      this._value = undefined;
      return this;
    }, this.request);
  }
}

/* ---------------- databases ---------------- */

const databases = new Map();   // name -> { version, stores: Map(name -> store data) }

class Database extends Target {
  constructor(name, data) {
    super();
    this.name = name;
    this._data = data;
    this._upgrade = null;
    this._closed = false;
  }
  get version() { return this._data.version; }
  get objectStoreNames() { return new Names(this._data.stores.keys()); }

  createObjectStore(name, { keyPath = null, autoIncrement = false } = {}) {
    if (!this._upgrade) throw fail('InvalidStateError', 'Object stores are made in an upgrade.');
    if (this._data.stores.has(name)) throw fail('ConstraintError', `An object store named ${name} already exists.`);
    const data = { name, keyPath, autoIncrement, indexes: new Map(), records: [], next: 1 };
    this._data.stores.set(name, data);
    return new ObjectStore(this._upgrade, data);
  }
  deleteObjectStore(name) {
    if (!this._upgrade) throw fail('InvalidStateError', 'Object stores are removed in an upgrade.');
    this._data.stores.delete(name);
  }

  transaction(names, mode = 'readonly') {
    if (this._closed) throw fail('InvalidStateError', 'The database connection is closed.');
    const list = typeof names === 'string' ? [names] : [...names];
    if (!list.length) throw fail('InvalidAccessError', 'A transaction needs at least one object store.');
    for (const name of list) if (!this._data.stores.has(name)) throw fail('NotFoundError', `No object store named ${name}.`);
    if (mode !== 'readonly' && mode !== 'readwrite') throw new TypeError(`Bad transaction mode ${mode}`);
    const txn = new Transaction(this, [...new Set(list)], mode);
    enqueue(txn);
    return txn;
  }

  close() { this._closed = true; }
}
handlers(Database, ['versionchange', 'close', 'abort', 'error']);

export const memoryIndexedDB = {
  open(name, version) {
    if (version !== undefined && !(Number.isInteger(version) && version >= 1)) throw new TypeError('The version must be a whole number from 1 up.');
    const req = new Request(null, null);
    later(() => {
      const data = databases.get(String(name)) || { version: 0, stores: new Map() };
      const old = data.version, want = version ?? (old || 1);
      if (want < old) {
        req.readyState = 'done';
        req.error = fail('VersionError', `The requested version (${want}) is less than the existing version (${old}).`);
        req.fire('error');
        return;
      }
      databases.set(String(name), data);
      const db = new Database(String(name), data);
      if (want > old) {
        const upgrade = new Transaction(db, [], 'versionchange');
        db._upgrade = upgrade;
        data.version = want;
        req.result = db;
        req.transaction = upgrade;
        req.readyState = 'done';
        req.fire('upgradeneeded', { extra: { oldVersion: old, newVersion: want } });
        // Anything the upgrade asked of its stores runs now, before success.
        while (upgrade.state === 'active' && upgrade._jobs.length) upgrade._run(upgrade._jobs.shift());
        db._upgrade = null;
        req.transaction = null;
        if (upgrade.state !== 'active') {
          data.version = old;
          req.result = undefined;
          req.error = fail('AbortError', 'The upgrade was aborted.');
          req.fire('error');
          return;
        }
        upgrade._commit();
      }
      req.result = db;
      req.readyState = 'done';
      req.fire('success');
    });
    return req;
  },
  deleteDatabase(name) {
    const req = new Request(null, null);
    later(() => {
      databases.delete(String(name));
      req.readyState = 'done';
      req.fire('success');
    });
    return req;
  },
  cmp,
  async databases() { return [...databases].map(([name, d]) => ({ name, version: d.version })); },
};
