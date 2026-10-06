import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSyncQueue } from './sync-queue.js';

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
function fixture() {
  const data = new Map();
  let offline = false, failStorage = false;
  const seen = [];
  const storage = {
    async get(key, fallback) { return structuredClone(data.has(key) ? data.get(key) : fallback); },
    async set(key, value) { if (failStorage) throw new Error('Simulated quota'); data.set(key, structuredClone(value)); },
  };
  const queue = createSyncQueue({ storage, online: () => !offline, changed: s => seen.push(s) });
  return { queue, data, storage, seen, offline: v => { offline = v; }, failStorage: v => { failStorage = v; } };
}
const entry = (id, value = 1, uid = 'a') => ({ kind: 'set', path: `users/${uid}/solves/${id}`, value });

test('in-flight work stays durable; no success until acknowledgement', async () => {
  const f = fixture(), ack = deferred();
  await f.queue.activate('a', () => ack.promise);
  await f.queue.enqueue(entry('one'));
  const flushing = f.queue.ready(); await settle();
  assert.equal(f.queue.snapshot().state, 'syncing');
  assert.equal(f.queue.snapshot().pending, 1);
  assert.equal(f.data.get('_syncQueue').length, 1);
  assert.equal(f.queue.snapshot().lastSync, null);
  assert.equal(f.seen.some(s => s.state === 'up-to-date'), false);
  ack.resolve(); await flushing;
  assert.equal(f.queue.snapshot().state, 'up-to-date');
  assert.equal(f.queue.snapshot().pending, 0);
  assert.ok(f.queue.snapshot().lastSync);
});

test('failed upload retains FIFO edit/delete order and retries after reload', async () => {
  const f = fixture(); f.offline(true);
  await f.queue.activate('a', async () => {});
  await Promise.all([f.queue.enqueue(entry('one')), f.queue.enqueue(entry('one', 2)),
    f.queue.enqueue({ kind: 'remove', path: 'users/a/solves/one' })]);
  await f.queue.ready();
  assert.equal(f.queue.snapshot().state, 'pending-offline');
  assert.equal(f.queue.snapshot().pending, 3);
  f.offline(false);
  let fail = true; const sent = [];
  const reloaded = createSyncQueue({ storage: f.storage, online: () => true });
  await reloaded.activate('a', async e => { if (fail) throw new Error('denied'); sent.push(e); });
  assert.equal(await reloaded.ready(), false);
  assert.equal(reloaded.snapshot().state, 'retrying');
  assert.equal(f.data.get('_syncQueue').length, 3);
  fail = false;
  assert.equal(await reloaded.flush(), true);
  assert.deepEqual(sent.map(e => [e.kind, e.value]), [['set', 1], ['set', 2], ['remove', undefined]]);
  assert.equal(reloaded.snapshot().state, 'up-to-date');
});

test('switching accounts isolates pending counts, sends, and timestamps', async () => {
  const f = fixture(), oldAck = deferred(), sent = [];
  await f.queue.activate('a', () => oldAck.promise);
  await f.queue.enqueue(entry('first'));
  await f.queue.enqueue(entry('second'));
  const oldFlush = f.queue.ready(); await settle();
  await f.queue.activate('b', async e => sent.push(e.path));
  assert.equal(f.queue.snapshot().pending, 0);
  assert.equal(f.queue.snapshot().lastSync, null);
  await f.queue.enqueue(entry('third', 3, 'b'));
  await f.queue.ready();
  assert.deepEqual(sent, ['users/b/solves/third']);
  const bTimestamp = f.queue.snapshot().lastSync;
  oldAck.resolve(); await oldFlush;
  assert.equal(f.queue.snapshot().lastSync, bTimestamp);
  assert.deepEqual(f.data.get('_syncQueue').map(e => e.path), ['users/a/solves/second']);
  await f.queue.activate(null);
  assert.equal(f.queue.snapshot().state, 'signed-out');
  assert.equal(f.queue.snapshot().lastSync, null);
});

test('concurrent edit during acknowledgement cannot flash up to date', async () => {
  const f = fixture(), first = deferred(), second = deferred(); let count = 0;
  await f.queue.activate('a', () => ++count === 1 ? first.promise : second.promise);
  await f.queue.enqueue(entry('one'));
  const flushing = f.queue.ready(); await settle();
  const before = f.seen.length;
  const adding = f.queue.enqueue(entry('two'));
  first.resolve(); await adding; await settle();
  assert.equal(f.queue.snapshot().pending, 1);
  assert.equal(f.seen.slice(before).some(s => s.state === 'up-to-date'), false);
  second.resolve(); await flushing;
  assert.equal(f.queue.snapshot().state, 'up-to-date');
});

test('queue storage failure retains the change and retry persists before send', async () => {
  const f = fixture(), sent = [];
  await f.queue.activate('a', async e => { assert.ok(f.data.get('_syncQueue').some(r => r.id === e.id)); sent.push(e); });
  f.failStorage(true);
  await f.queue.enqueue(entry('one'));
  await f.queue.ready();
  assert.equal(f.queue.snapshot().state, 'error');
  assert.equal(f.queue.snapshot().pending, 1);
  assert.equal(sent.length, 0);
  f.failStorage(false); await f.queue.flush();
  assert.equal(sent.length, 1);
  assert.equal(f.queue.snapshot().state, 'up-to-date');
});

test('online alone and an old timestamp do not prove acknowledgement', async () => {
  const f = fixture(); f.data.set('_syncAck:a', { at: 123 });
  await f.queue.activate('a', async () => {}); await f.queue.ready();
  assert.equal(f.queue.snapshot().state, 'unknown');
  assert.equal(f.queue.snapshot().lastSync, 123);
  f.queue.connectivityChanged(); await settle();
  assert.equal(f.queue.snapshot().state, 'unknown');
});

test('switching away and back waits for the old acknowledgement before newer edits', async () => {
  const f = fixture(), oldAck = deferred(), sent = [];
  await f.queue.activate('a', async e => { sent.push(e.value); await oldAck.promise; });
  await f.queue.enqueue(entry('one', 1));
  const oldFlush = f.queue.ready(); await settle();
  await f.queue.activate('b', async () => {});
  await f.queue.activate('a', async e => { sent.push(e.value); });
  await f.queue.enqueue(entry('one', 2));
  const newFlush = f.queue.ready(); await settle();
  assert.deepEqual(sent, [1]);
  assert.equal(f.queue.snapshot().inFlight, true);
  oldAck.resolve(); await oldFlush; await newFlush;
  assert.deepEqual(sent, [1, 2]);
  assert.equal(f.queue.snapshot().state, 'up-to-date');
  assert.equal(f.data.get('_syncQueue').length, 0);
});

test('listener permission failures remain visible after successful outbound writes', async () => {
  const f = fixture();
  await f.queue.activate('a', async () => {});
  await f.queue.enqueue(entry('one'));
  f.queue.problem('permission');
  await f.queue.ready();
  assert.equal(f.queue.snapshot().state, 'error');
  assert.equal(f.queue.snapshot().error, 'permission');
  assert.equal(f.queue.snapshot().needsAttention, true);
});

test('authentication failures require attention instead of claiming a normal retry', async () => {
  const f = fixture();
  await f.queue.activate('a', async () => { throw { code: 'PERMISSION_DENIED' }; });
  await f.queue.enqueue(entry('one')); await f.queue.ready();
  assert.equal(f.queue.snapshot().state, 'error');
  assert.equal(f.queue.snapshot().error, 'permission');
  assert.equal(f.queue.snapshot().pending, 1);
});

test('two queue instances retain both tabs’ changes and send in order', async () => {
  const f = fixture(), gate = deferred(), sent = [], locks = new Map();
  let storageLock = Promise.resolve();
  f.storage.updateQueue = change => {
    const run = storageLock.then(() => {
      const next = change(structuredClone(f.data.get('_syncQueue') || []));
      f.data.set('_syncQueue', structuredClone(next)); return structuredClone(next);
    });
    storageLock = run.catch(() => {}); return run;
  };
  const withAccountLock = (uid, run) => {
    const next = (locks.get(uid) || Promise.resolve()).then(run);
    locks.set(uid, next.catch(() => {})); return next;
  };
  const first = createSyncQueue({ storage: f.storage, online: () => true, withAccountLock });
  const second = createSyncQueue({ storage: f.storage, online: () => true, withAccountLock });
  const send = async e => { sent.push(e.value); if (e.value === 1) await gate.promise; };
  await first.activate('a', send); await second.activate('a', send);
  await first.enqueue(entry('one', 1)); const flushFirst = first.ready(); await settle();
  await second.enqueue(entry('one', 2)); const flushSecond = second.ready(); await settle();
  assert.equal(f.data.get('_syncQueue').length, 2);
  assert.deepEqual(sent, [1]);
  gate.resolve(); await flushFirst; await flushSecond;
  assert.deepEqual(sent, [1, 2]);
  assert.equal(f.data.get('_syncQueue').length, 0);
});

test('a denied account lock leaves the operation queued without an unhandled rejection', async () => {
  const f = fixture();
  const queue = createSyncQueue({ storage: f.storage, online: () => true,
    withAccountLock: () => { throw Error('Lock unavailable'); } });
  await queue.activate('a', async () => { throw Error('Must not send'); });
  await queue.enqueue(entry('one')); assert.equal(await queue.ready(), false);
  assert.equal(queue.snapshot().state, 'error');
  assert.equal(queue.snapshot().pending, 1);
});

test('a write the database refuses outright is dropped instead of blocking the rest', async () => {
  const f = fixture(), sent = [];
  await f.queue.activate('a', async e => {
    if (e.value === 'bad') throw Object.assign(new Error('set failed: invalid key'), { permanent: true });
    sent.push(e.value);
  });
  await f.queue.enqueue(entry('one', 'bad'));
  await f.queue.enqueue(entry('two', 2));
  await f.queue.enqueue(entry('three', 3));
  assert.equal(await f.queue.ready(), true);
  assert.deepEqual(sent, [2, 3]);
  assert.equal(f.data.get('_syncQueue').length, 0);
  assert.equal(f.queue.snapshot().state, 'up-to-date');
  assert.equal(f.queue.snapshot().needsAttention, false);
});
