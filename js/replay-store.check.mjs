import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IDBFactory, IDBKeyRange, forceCloseDatabase } from 'fake-indexeddb';
import { JSDOM } from 'jsdom';
import { createReplayStore, replayRequest, replayStore } from './replay-store.js';

const read = (store, id = 'clip') => store.run('readonly', async tr => ({
  meta: await replayRequest(tr.objectStore('meta').get(id)),
  blob: await replayRequest(tr.objectStore('video').get(id)),
}));
const seed = store => store.run('readwrite', tr => {
  tr.objectStore('meta').put({ id: 'clip', at: 1, bytes: 3, conv: 1 });
  tr.objectStore('video').put(new Blob(['abc'], { type: 'video/webm' }), 'clip');
});

test('existing schema opens without migration and reads both metadata and video', async () => {
  const idb = new IDBFactory(), first = createReplayStore({ idb });
  await seed(first);
  const store = createReplayStore({ idb });
  const got = await read(store);
  assert.equal(got.meta.bytes, 3);
  assert.equal(await got.blob.text(), 'abc');
  assert.deepEqual(await idb.databases(), [{ name: 'tagdatimer-replays', version: 1 }]);
});

test('request success followed by transaction abort never reports a saved clip', async () => {
  const store = createReplayStore({ idb: new IDBFactory() });
  await assert.rejects(store.run('readwrite', async tr => {
    await replayRequest(tr.objectStore('meta').put({ id: 'clip' }));
    tr.objectStore('video').put(new Blob(['abc']), 'clip');
    tr.abort();
  }), { name: 'AbortError' });
  assert.deepEqual(await read(store), { meta: undefined, blob: undefined });
});

test('a callback failure aborts partial writes and preserves previously saved footage', async () => {
  const store = createReplayStore({ idb: new IDBFactory() });
  await seed(store);
  await assert.rejects(store.run('readwrite', async tr => {
    await replayRequest(tr.objectStore('meta').delete('clip'));
    throw new Error('cleanup failed');
  }), /cleanup failed/);
  assert.equal((await read(store)).meta.id, 'clip');
  assert.equal(await (await read(store)).blob.text(), 'abc');
});

test('a stalled open times out; late success closes; retry reads the original data', async () => {
  const real = new IDBFactory();
  await seed(createReplayStore({ idb: real }));
  const stuck = {};
  let opens = 0, closed = false;
  const store = createReplayStore({ timeoutMs: 30, idb: {
    open(...args) { return ++opens === 1 ? stuck : real.open(...args); },
  } });
  await assert.rejects(read(store), { name: 'TimeoutError' });
  stuck.result = { close: () => { closed = true; } };
  stuck.onsuccess();
  assert.equal(closed, true);
  assert.equal((await read(store)).meta.id, 'clip');
  assert.equal(opens, 2);
});

test('a blocked open rejects promptly and does not cache a failed request', async () => {
  const real = new IDBFactory();
  let opens = 0;
  const store = createReplayStore({ idb: {
    open(...args) {
      if (++opens > 1) return real.open(...args);
      const req = {}; queueMicrotask(() => req.onblocked()); return req;
    },
  } });
  await assert.rejects(read(store), /Close older/);
  await seed(store);
  assert.equal((await read(store)).meta.id, 'clip');
});

test('a stalled transaction rejects even if its requests never finish, then reconnects', async () => {
  const real = new IDBFactory();
  await seed(createReplayStore({ idb: real }));
  let opens = 0, aborted = false, closed = false;
  const tr = new EventTarget();
  tr.objectStore = () => ({ get: () => ({}) });
  tr.abort = () => { aborted = true; };
  const db = { transaction: () => tr, close: () => { closed = true; } };
  const store = createReplayStore({ timeoutMs: 30, idb: {
    open(...args) {
      if (++opens > 1) return real.open(...args);
      const req = { result: db }; queueMicrotask(() => req.onsuccess()); return req;
    },
  } });
  await assert.rejects(read(store), { name: 'TimeoutError' });
  assert.equal(aborted, true); assert.equal(closed, true);
  assert.equal((await read(store)).meta.id, 'clip');
});

test('an unexpectedly closed connection is reopened on the next operation', async () => {
  const real = new IDBFactory();
  let db, opens = 0;
  const store = createReplayStore({ idb: {
    open(...args) {
      opens++;
      const req = real.open(...args);
      req.addEventListener('success', () => { db = req.result; });
      return req;
    },
  } });
  await seed(store); forceCloseDatabase(db);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await read(store)).meta.id, 'clip');
  assert.equal(opens, 2);
});

test('boot retains footage without local solves; failed reads and playback retain its index', async t => {
  globalThis.indexedDB = new IDBFactory();
  globalThis.IDBKeyRange = IDBKeyRange;
  await seed(replayStore);
  const oldDocument = globalThis.document, oldNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const oldAddEventListener = globalThis.addEventListener;
  globalThis.document = new JSDOM('<!doctype html><div id="toasts"></div>').window.document;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
  globalThis.addEventListener = () => {};
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const replay = await import('./replay.js');
  try {
    const indexed = new Promise(resolve => {
      const off = replay.onReplayChange(e => { if (e.type === 'saved') { off(); resolve(); } });
    });
    replay.initReplay({ settings: {} }, Object.assign(new EventTarget(), { state: 'idle' }));
    await indexed;
    t.mock.timers.tick(8000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(replay.hasReplay('clip'), true);
    assert.equal((await replay.loadClip('clip')).meta.id, 'clip');
    assert.deepEqual((await indexedDB.databases()).map(d => d.name), ['tagdatimer-replays']);
    const run = replayStore.run;
    replayStore.run = async () => { throw new Error('read unavailable'); };
    try {
      await assert.rejects(replay.refreshReplays(), /read unavailable/);
      const player = await import('./replay-player.js');
      await assert.rejects(player.openPlayer('clip'), /read unavailable/);
      assert.equal(replay.hasReplay('clip'), true);
    } finally { replayStore.run = run; }
    assert.equal(await replay.refreshReplays(), 1);
    assert.equal(replay.hasReplay('clip'), true);
    const { replayJournal } = await import('./replay-journal.js');
    await replayJournal.append('duplicate', 0, 1, new Blob(['replacement']));
    await replayJournal.describe('duplicate', 1, { finished: true, expectedChunks: 1,
      meta: { id: 'clip', timeMs: 1, at: 1, bytes: 11 } });
    await replay.recoverRecording({ id: 'duplicate' });
    assert.equal(await (await replay.loadClip('clip')).blob.text(), 'abc', 'Recovery must not overwrite a surviving original');
    await replayJournal.append('partial', 0, 1, new Blob(['part']));
    await replayJournal.describe('partial', 1, { finished: true, expectedChunks: 1,
      meta: { id: 'partial', partial: true } });
    await assert.rejects(replay.recoverRecording({ id: 'partial' }), /partial recording/);
    assert.equal((await replayJournal.read('partial')).blob.size, 4, 'Partial footage remains available for download');
  } finally {
    t.mock.timers.reset();
    globalThis.document = oldDocument;
    Object.defineProperty(globalThis, 'navigator', oldNavigator);
    globalThis.addEventListener = oldAddEventListener;
  }
});
