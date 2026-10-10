/* Durable outbound operations: entries stay in IndexedDB through acknowledgement.
   Kept independent of Firebase and the DOM so failure paths can be tested. */
/* `paused`: the admin console's read-only switch (app.readOnly). Nothing is
   sent while it holds, nothing is dropped: the queue keeps every entry, in
   order, and sends them once it is lifted (connectivityChanged). */
export function createSyncQueue({ storage, online = () => navigator.onLine !== false, paused = () => false, changed = () => {}, withAccountLock = (uid, run) => run() }) {
  let entries = null, lock = Promise.resolve(), active = null, ready = false;
  let running = null, inFlight = null, error = null, lastSync = null, acknowledged = false;
  let problem = null;
  let revision = 0, acknowledgedRevision = 0, slow = false;
  // For the admin console's Health tab (js/health.js): writes dropped as permanent, and the last error's code.
  let dropped = 0, lastErr = null;
  const adding = new Map();
  const accountRuns = new Map();
  const unpersisted = new Map(), removedIds = new Set();
  const serial = fn => {
    const run = lock.then(fn, fn);
    lock = run.catch(() => {});
    return run;
  };
  const owner = entry => {
    const paths = entry.kind === 'update' ? Object.keys(entry.updates || {}) : [entry.path];
    const uid = paths[0]?.split('/')[1];
    return uid && paths.every(p => p.startsWith(`users/${uid}/`)) ? uid : null;
  };
  const mine = () => (entries || []).filter(e => owner(e) === active?.uid);
  const waiting = () => [...adding.values()].filter(e => owner(e) === active?.uid);
  const snapshot = () => {
    const pending = active ? mine().length + waiting().length : 0;
    const sending = !!active && inFlight?.session.uid === active.uid;
    let state = 'signed-out';
    if (active) {
      state = problem ? 'error' : pending && paused() ? 'paused' : error ? (error === 'upload' ? 'retrying' : 'error')
        : pending && !online() ? 'pending-offline'
        : sending ? (slow ? 'retrying' : 'syncing')
        : !ready || entries === null ? 'starting'
        : pending ? 'syncing'
        : acknowledged && acknowledgedRevision >= revision ? 'up-to-date' : 'unknown';
    }
    return Object.freeze({ state, pending, inFlight: sending, retrying: !!running && sending,
      lastSync: active ? lastSync : null, revision, acknowledgedRevision,
      error: active ? problem || error : null,
      needsAttention: !!active && (pending > 0 || ['retrying', 'error'].includes(state)) });
  };
  const notify = () => changed(snapshot());
  async function load() {
    if (entries === null) {
      const normalize = list => list.filter(e => owner(e)).map(e => ({ ...e, id: e.id || crypto.randomUUID() }));
      entries = storage.updateQueue ? await storage.updateQueue(normalize)
        : normalize((await storage.get('_syncQueue', [])) || []);
    }
  }
  async function persist() {
    if (storage.updateQueue) {
      const additions = [...unpersisted.values()], removals = [...removedIds];
      entries = await storage.updateQueue(current => {
        const next = current.filter(e => !removals.includes(e.id));
        for (const entry of additions) if (!next.some(e => e.id === entry.id)) next.push(entry);
        return next;
      });
      for (const entry of additions) unpersisted.delete(entry.id);
      for (const id of removals) removedIds.delete(id);
    } else {
      await storage.set('_syncQueue', entries);
      unpersisted.clear(); removedIds.clear();
    }
  }
  async function activate(uid, send) {
    const session = { uid, send };
    active = uid ? session : null; ready = false; error = null; problem = null; lastSync = null;
    acknowledged = false; revision = 0; acknowledgedRevision = 0; slow = false;
    notify();
    if (!uid) return;
    try {
      await serial(load);
      const ack = await storage.get(`_syncAck:${uid}`, null);
      if (active !== session) return;
      lastSync = ack?.at || null;
      // Restored entries are pending regardless of an older acknowledgement.
      revision = mine().length + waiting().length;
      notify();
    } catch (e) {
      if (active === session) { error = 'storage'; notify(); }
      throw e;
    }
  }
  async function enqueue(entry) {
    const uid = owner(entry);
    if (!uid) return;
    // When it was queued, so a queue that stops moving can say how long it has been stuck.
    entry = { ...entry, at: Date.now() };
    const id = crypto.randomUUID();
    adding.set(id, entry);
    if (uid === active?.uid) { revision++; notify(); }
    try {
      await serial(async () => {
        await load();
        entries.push({ ...entry, id });
        unpersisted.set(id, { ...entry, id });
        adding.delete(id);
        notify();
        await persist();
      });
    } catch (e) {
      // Keep the in-memory operation, too. Retry must persist before sending.
      if (uid === active?.uid) { error = 'storage'; notify(); }
      console.warn('[sync] queue storage unavailable', e);
      return;
    }
    if (ready && uid === active?.uid) void flush();
  }
  function flush() {
    if (running?.session === active) return running.promise;
    if (!active || !online() || paused()) { notify(); return Promise.resolve(false); }
    const session = active;
    const previousRun = accountRuns.get(session.uid);
    const task = { session, promise: null };
    running = task;
    accountRuns.set(session.uid, task);
    task.promise = Promise.resolve().then(() => withAccountLock(session.uid, async () => {
      try {
        // Switching away and back cannot start a second upload for the same
        // account while its earlier operation still awaits acknowledgement.
        if (previousRun) await previousRun.promise;
        if (active !== session) return false;
        await serial(async () => {
          await load();
          for (const [id, entry] of adding) {
            if (!entries.some(e => e.id === id)) entries.push({ ...entry, id });
            unpersisted.set(id, { ...entry, id });
            adding.delete(id);
          }
          await persist();
        });
        if (active !== session) return false;
        error = null;
        while (active === session && online() && !paused()) {
          const entry = mine()[0];
          if (!entry) break;
          inFlight = { session, id: entry.id }; slow = false; notify();
          const timer = setTimeout(() => { if (inFlight?.id === entry.id && active === session) { slow = true; notify(); } }, 20000);
          let refused = false;
          try { await session.send(entry); }
          catch (e) {
            // A write the database refuses before sending fails the same way on
            // every retry, and in a FIFO queue it would hold back everything
            // behind it. Drop it; the change is still saved on this device.
            if (!e?.permanent || active !== session) {
              if (active === session) {
                lastErr = String(e?.code || e?.name || 'upload').slice(0, 40);
                error = /permission|auth|token|credential/i.test(e?.code || '') ? 'permission' : 'upload';
                console.warn('[sync] upload failed', e?.code || e);
              }
              return false;
            }
            refused = true;
            dropped++;
            lastErr = String(e?.code || e?.name || 'refused').slice(0, 40);
            console.warn('[sync] dropped a change the database cannot store', entry.path || Object.keys(entry.updates || {})[0], e);
          } finally { clearTimeout(timer); }
          // Remove only this acknowledged operation, including during account switches.
          // If bookkeeping fails, put it back: retrying an idempotent operation is safe.
          await serial(async () => {
            const index = entries.findIndex(e => e.id === entry.id);
            if (index < 0) return;
            const removed = entries.splice(index, 1)[0];
            removedIds.add(entry.id);
            try { await persist(); }
            catch (e) {
              removedIds.delete(entry.id);
              if (removed) entries.splice(index, 0, removed);
              throw e;
            }
          });
          if (refused) {
            if (active?.uid === session.uid) acknowledgedRevision++;
            if (inFlight?.session === session) inFlight = null;
            notify();
            continue;
          }
          const at = Date.now();
          await storage.set(`_syncAck:${session.uid}`, { at });
          if (active?.uid === session.uid) {
            lastSync = at; acknowledged = true;
            acknowledgedRevision++;
            if (inFlight?.session === session) inFlight = null;
            slow = false; notify();
          }
        }
        return active === session && mine().length === 0 && waiting().length === 0;
      } catch (e) {
        if (active === session) { error = 'storage'; console.warn('[sync] queue bookkeeping failed', e); }
        return false;
      } finally {
        if (running === task) running = null;
        if (accountRuns.get(session.uid) === task) accountRuns.delete(session.uid);
        if (inFlight?.session === session) inFlight = null;
        if (active === session) { slow = false; notify(); }
      }
    })).catch(e => {
      if (running === task) running = null;
      if (accountRuns.get(session.uid) === task) accountRuns.delete(session.uid);
      if (active === session) { error = 'storage'; notify(); }
      console.warn('[sync] account queue lock unavailable', e);
      return false;
    });
    return task.promise;
  }
  return {
    snapshot, activate, enqueue, flush,
    ready() { ready = true; notify(); return flush(); },
    problem(reason = 'start') { if (active) { problem = reason; notify(); } },
    connectivityChanged() { notify(); if (online() && ready) void flush(); },
    /** For the Health tab: what is waiting, since when, and what went wrong. Counts are since the page loaded. */
    health() {
      const list = [...mine(), ...waiting()];
      const oldest = list.reduce((m, e) => (typeof e.at === 'number' && e.at < m ? e.at : m), Infinity);
      return { pending: list.length, oldestAt: Number.isFinite(oldest) ? oldest : null, dropped, lastErr };
    },
    // Receiving a stale cloud echo must not overwrite a queued local edit/delete.
    protects(path) { return [...mine(), ...waiting()].some(e => e.kind === 'update' ? path in e.updates : e.path === path); },
  };
}
