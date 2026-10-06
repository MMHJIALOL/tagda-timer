// Browser checks use real IndexedDB transactions and only temporary records.
export async function runDataHealthChecks(check) {
  const DB = await import('./db.js');
  const Health = await import('./data-health.js');
  const Sync = await import('./sync.js');
  const id = `health-test-${crypto.randomUUID()}`;
  const solve = { id, sessionId: id, timeMs: 12345, penalty: 'none', createdAt: Date.now() };
  const originalPut = IDBObjectStore.prototype.put;
  let writes = 0;
  const off = DB.onWrite('solves', s => { if (s.id === id) writes++; });
  try {
    IDBObjectStore.prototype.put = function (value, ...args) {
      const req = originalPut.call(this, value, ...args);
      if (this.name === 'solves' && value.id === id) {
        // The request succeeds, but the transaction then aborts. This is the
        // false-success path the old request-only persistence promise missed.
        req.addEventListener('success', () => this.transaction.abort());
      }
      return req;
    };
    let rejected = false;
    try { await DB.Solves.put(solve); } catch { rejected = true; }
    check('local write rejects after request success but transaction abort', rejected);
    check('aborted transaction never emits a cloud write hook', writes === 0);
    check('failed solve remains visible for recovery', (await DB.Solves.bySession(id)).some(s => s.id === id));
    check('failed solve is included in full export', (await DB.exportAll()).solves.some(s => s.id === id));
    check('local health reports the failed transaction', DB.getLocalStatus().state === 'error');
    check('emergency journal retains the failed solve across refresh', JSON.parse(localStorage.getItem('tagda:unsaved')).some(r => r.id === id));
    check('recovery-only export includes the unsaved solve’s session', DB.exportRecovery().sessions.some(s => s.id === solve.sessionId));
    IDBObjectStore.prototype.put = originalPut;
    await DB.retryLocalWrites();
    check('local retry commits the retained solve', (await DB.wrap((await DB.tx('solves')).get(id)))?.id === id);
    check('local retry clears the recovery warning', DB.getLocalStatus().state === 'saved' && DB.getLocalStatus().unsaved === 0);
    check('cloud hook runs only for the committed retry', writes === 1);
    IDBObjectStore.prototype.put = function (value, ...args) {
      if (this.name === 'kv' && args[0] === '_deleted') throw new DOMException('Simulated quota', 'QuotaExceededError');
      return originalPut.call(this, value, ...args);
    };
    let deletionFailed = false;
    try { await DB.Solves.del(id); } catch { deletionFailed = true; }
    check('failed tombstone write retains the deletion for retry', deletionFailed && DB.getLocalStatus().unsaved > 0);
    IDBObjectStore.prototype.put = originalPut;
    await DB.retryLocalWrites();
    check('delete retry persists a previously failed tombstone', !!(await DB.KV.get('_deleted'))?.solves?.[id]);
    check('retried deletion stays out of exported solves', !(await DB.exportAll()).solves.some(s => s.id === id));
  } finally {
    IDBObjectStore.prototype.put = originalPut; off();
    await DB.Solves.del(id);
  }

  const unsupported = await Health.storageSnapshot({});
  const set = { id: `${id}-set`, sessionId: id, event: '333', size: 5, status: 'active', solveIds: [], createdAt: Date.now(), currentScramble: { scramble: 'R U' } };
  const attempt = { ...solve, id: `${id}-attempt`, event: '333', mode: 'wca', scramble: 'R U' };
  await DB.CompetitionSets.create(set);
  try {
    await DB.CompetitionSets.record(set.id, attempt, 1);
    let blocked = false;
    try { await DB.Solves.put({ ...attempt, timeMs: 1 }); } catch { blocked = true; }
    check('Competition validation rejection never becomes an unsaved edit', blocked && !DB.hasUnsavedLocalChange('solves', attempt.id) && (await DB.Solves.get(attempt.id)).timeMs === solve.timeMs);
    IDBObjectStore.prototype.put = function (value, ...args) {
      if (this.name === 'solves' && value.id === attempt.id) throw new DOMException('Simulated quota', 'QuotaExceededError');
      return originalPut.call(this, value, ...args);
    };
    try { await DB.Solves.put({ ...attempt, penalty: '+2' }); } catch {}
    const full = await DB.exportAll(), recovery = DB.exportRecovery();
    check('full backup retains Competition membership with unsaved penalty edits', full.competitionSets.some(s => s.id === set.id) && full.solves.find(s => s.id === attempt.id)?.penalty === '+2');
    check('standalone Competition recovery is importable as a separate practice copy', recovery.solves.some(s => s.recoverySourceId === attempt.id && s.id !== attempt.id && !s.competitionSetId));
    IDBObjectStore.prototype.put = originalPut;
    await DB.retryLocalWrites();
    check('Competition penalty retry commits without altering membership', (await DB.Solves.get(attempt.id)).penalty === '+2' && (await DB.CompetitionSets.get(set.id)).solveIds[0] === attempt.id);
    IDBObjectStore.prototype.put = function (value, ...args) {
      if (this.name === 'solves' && value.id === attempt.id) throw new DOMException('Simulated quota', 'QuotaExceededError');
      return originalPut.call(this, value, ...args);
    };
    try { await DB.Solves.put({ ...attempt, penalty: 'DNF' }); } catch {}
  } finally {
    IDBObjectStore.prototype.put = originalPut;
    await DB.CompetitionSets.delete(set.id);
  }
  check('deleting a whole Competition average also clears its unsaved edits', !DB.hasUnsavedLocalChange('solves', attempt.id) && !(await DB.exportAll()).solves.some(s => s.id === attempt.id));
  check('unsupported storage APIs return unavailable', unsupported.estimate === null && unsupported.persistent === null);
  const throws = await Health.storageSnapshot({ estimate() { throw Error('Unavailable'); }, persisted() { return Promise.reject(Error('Unavailable')); } });
  check('throwing and rejected storage APIs degrade gracefully', throws.estimate === null && throws.persistent === null);
  check('signed out has no cloud attention signal or timestamp', Sync.getSyncStatus().state === 'signed-out' && !Sync.getSyncStatus().needsAttention && Sync.getSyncStatus().lastSync === null);
  check('export health metadata is never synced', !Sync.isSyncedKv('_dataHealth.export'));

  const host = document.getElementById('toasts') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'toasts' }));
  const fakeStorage = new Map();
  const storage = { async set(key, value) { fakeStorage.set(key, value); } };
  let downloads = 0;
  await Health.prepareBackup({ build: async () => ({ solves: [solve], sessions: [] }),
    startDownload: () => { downloads++; }, storage });
  const prepared = fakeStorage.get('_dataHealth.export');
  check('successful export starts download and records prepared timestamp/count', downloads === 1 && prepared?.at > 0 && prepared.solveCount === 1);
  await Health.prepareBackup({ build: async () => { throw Error('Failed export'); }, startDownload: () => { downloads++; }, storage });
  check('failed export keeps the previous prepared timestamp', fakeStorage.get('_dataHealth.export') === prepared && downloads === 1);
  await Health.prepareBackup({ build: async () => ({ solves: [solve] }), startDownload: () => { throw Error('Failed download preparation'); }, storage });
  check('failed download preparation does not update export metadata', fakeStorage.get('_dataHealth.export') === prepared);
  const full = await DB.exportAll();
  check('full JSON backup excludes local health metadata', !('_dataHealth.export' in full) && !JSON.stringify(full).includes('_syncAck:'));
  if (!host.childElementCount) host.remove();
}
