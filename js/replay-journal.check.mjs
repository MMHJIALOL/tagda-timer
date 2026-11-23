import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { createReplayStore, replayRequest as request } from './replay-store.js';
import { createReplayJournal, commitJournaledReplay, inspectLegacyChunks } from './replay-journal.js';
globalThis.IDBKeyRange = IDBKeyRange;
function fixture() {
  const idb = new IDBFactory();
  const storage = createReplayStore({ idb, name: 'tagdatimer-replay-journal' });
  return { idb, storage, journal: createReplayJournal({ storage }) };
}
async function film(journal, id = 'recording') {
  await journal.append(id, 0, 1, new Blob(['first'], { type: 'video/webm' }));
  await journal.append(id, 1, 1, new Blob(['last'], { type: 'video/webm' }));
  await journal.describe(id, 1, { finished: true, expectedChunks: 2, meta: { id: 'solve', timeMs: 12345 } });
}

test('final save that stalls or fails retains the entire independent journal', async () => {
  const { journal, storage } = fixture(); await film(journal);
  const recording = await journal.read('recording');
  let acknowledge;
  const waiting = new Promise(resolve => { acknowledge = resolve; });
  const committing = commitJournaledReplay({ journal, id: 'recording', meta: recording.meta, blob: recording.blob, write: () => waiting });
  assert.equal(await (await journal.read('recording')).blob.text(), 'firstlast');
  acknowledge(); await committing;
  assert.deepEqual(await journal.list(), []);
  await film(journal);
  await assert.rejects(commitJournaledReplay({ journal, id: 'recording', meta: recording.meta, blob: recording.blob,
    write: async () => { throw new Error('final storage unavailable'); } }), /final storage unavailable/);
  // A new journal object models a reload: no in-memory Blob is needed.
  const reloaded = createReplayJournal({ storage });
  assert.equal((await reloaded.read('recording')).complete, true);
  assert.equal(await (await reloaded.read('recording')).blob.text(), 'firstlast');
});

test('metadata and chunk bytes survive reload; append retries do not double-count', async () => {
  const { journal, storage } = fixture(); await film(journal);
  await journal.append('recording', 1, 1, new Blob(['last'], { type: 'video/webm' }));
  const read = await createReplayJournal({ storage }).read('recording');
  assert.equal(read.bytes, 9); assert.equal(read.complete, true); assert.equal(read.meta.id, 'solve');
});

test('gaps, missing tails, and interrupted captures never become complete recordings', async () => {
  const { journal } = fixture();
  await journal.append('gapped', 0, 1, new Blob(['head']));
  await journal.append('gapped', 2, 1, new Blob(['tail']));
  await journal.describe('gapped', 1, { finished: true, expectedChunks: 3 });
  assert.equal((await journal.read('gapped')).complete, false);
  assert.equal((await journal.read('gapped')).playable, false);
  await journal.append('interrupted', 0, 1, new Blob(['head']));
  assert.equal((await journal.read('interrupted')).complete, false);
  await journal.describe('interrupted', 1, { finished: true, expectedChunks: 2 });
  assert.equal((await journal.read('interrupted')).complete, false);
});

test('journal cleanup failure cannot turn a committed final save into failure', async () => {
  let committed = false;
  await commitJournaledReplay({ journal: { remove: async () => { throw new Error('cleanup failure'); } }, id: 'r', meta: {}, blob: new Blob(['x']),
    write: async () => { committed = true; } });
  assert.equal(committed, true);
});

test('legacy inspection is read-only and labels old fragments as partial', async () => {
  const idb = new IDBFactory();
  assert.deepEqual(await inspectLegacyChunks(idb), []);
  assert.deepEqual(await idb.databases(), []);
  const db = await new Promise((resolve, reject) => {
    const q = idb.open('tagdatimer-replay-chunks', 1);
    q.onupgradeneeded = () => q.result.createObjectStore('chunks');
    q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error);
  });
  await new Promise((resolve, reject) => {
    const tr = db.transaction('chunks', 'readwrite');
    tr.objectStore('chunks').put({ at: 1, blob: new Blob(['old'], { type: 'video/webm' }) }, ['legacy', 0]);
    tr.oncomplete = resolve; tr.onabort = () => reject(tr.error);
  });
  const [found] = await inspectLegacyChunks(idb);
  assert.equal(found.legacy, true); assert.equal(found.complete, false);
  assert.equal(await found.blob.text(), 'old');
  assert.equal(await request(db.transaction('chunks').objectStore('chunks').count()), 1);
  db.close();
});
