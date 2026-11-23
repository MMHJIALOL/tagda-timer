// Real MediaRecorder and IndexedDB in disposable profiles. No real camera,
// account, upload, or production data. Run against serve.py.
const assert = require('node:assert/strict');
const { chromium, firefox } = require('@playwright/test');
const base = process.argv[2] || 'http://localhost:5188';
async function check(name, engine, options) {
  const browser = await engine.launch({ headless: true, ...options });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block', ...(name === 'Chromium' ? { permissions: ['camera', 'microphone'] } : {}) });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', dialog => dialog.accept());
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== new URL(base).origin) return route.abort();
      if (url.pathname === '/durability-qa') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Replay durability test</title><div id="toasts"></div>' });
      return route.continue();
    });
    await page.goto(`${base}/durability-qa`);
    await page.evaluate(async () => {
      const R = window.R = await import('/js/replay.js');
      const { Timer } = await import('/js/timer.js');
      const { replayStore } = await import('/js/replay-store.js');
      const run = replayStore.run;
      replayStore.run = (mode, ...args) => mode === 'readwrite'
        ? new Promise((resolve, reject) => { window.rejectFinalWrite = reject; }) : run(mode, ...args);
      const app = { settings: { webcamReplay: true, webcamKeepOn: true, webcamSound: false, webcamQuality: 'sd' },
        setSetting(key, value) { this.settings[key] = value; } };
      const timer = window.qaTimer = new Timer({ inspection: false, holdTime: 0, minSolveMs: 0 });
      R.initReplay(app, timer);
      timer.addEventListener('stop', event => {
        const clip = R.takeClip(event.detail);
        if (!clip) throw new Error('No recording');
        clip.keep({ id: 'recent-solve', timeMs: event.detail.timeMs, createdAt: Date.now(), penalty: 'none' });
      });
      if (!await R.enableReplay()) throw new Error('Fake camera unavailable');
      timer.start();
    });
    await page.waitForFunction(() => R.replayStatus().recording);
    await page.waitForFunction(async () => (await (await import('/js/replay-journal.js')).replayJournal.list()).some(r => r.chunks >= 1));
    await page.evaluate(() => qaTimer.stop(3000));
    await page.waitForFunction(() => R.replaySaveStatus().unsaved === 1 && !!window.rejectFinalWrite);
    assert.equal(await page.evaluate(() => Promise.race([R.clipReady('recent-solve').then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 1000))])), true);
    await page.evaluate(() => rejectFinalWrite(new Error('Simulated final save failure')));
    await page.waitForFunction(() => R.replaySaveStatus().pending === 0);
    const before = await page.evaluate(async () => {
      const { replayJournal } = await import('/js/replay-journal.js');
      const [entry] = await replayJournal.list();
      const got = await replayJournal.read(entry.id);
      const fallback = await R.loadClip('recent-solve');
      return { complete: got.complete, bytes: got.blob.size, fallbackBytes: fallback.blob.size, key: entry.id };
    });
    assert.equal(before.complete, true); assert.ok(before.bytes > 1000); assert.equal(before.fallbackBytes, before.bytes);
    // This was the data-loss trigger: leaving after the final write failed.
    // The independent journal must survive without the old JavaScript heap.
    await page.reload();
    const after = await page.evaluate(async key => {
      const { replayJournal } = await import('/js/replay-journal.js');
      const R = await import('/js/replay.js');
      const got = await replayJournal.read(key);
      const original = { complete: got.complete, bytes: got.blob.size };
      await R.recoverRecording({ id: key });
      const saved = await R.loadClip('recent-solve');
      return { original, savedBytes: saved.blob.size, metadataBytes: saved.meta.bytes,
        remaining: (await replayJournal.list()).length, indexed: R.hasReplay('recent-solve') };
    }, before.key);
    assert.deepEqual(after.original, { complete: true, bytes: before.bytes });
    assert.equal(after.savedBytes, before.bytes); assert.equal(after.metadataBytes, before.bytes);
    assert.equal(after.remaining, 0); assert.equal(after.indexed, true);
    assert.deepEqual(errors, []);
    console.log(`${name}: PASS real recording -> failed final save -> usable sharing fallback -> reload -> recovery -> committed video -> journal cleanup`);
    await context.close();
  } finally { await browser.close(); }
}
(async () => {
  await check('Chromium', chromium, { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  await check('Firefox', firefox, { ...(process.env.TAGDA_FIREFOX_PATH ? { executablePath: process.env.TAGDA_FIREFOX_PATH } : {}),
    firefoxUserPrefs: { 'media.navigator.streams.fake': true, 'media.navigator.permission.disabled': true } });
})().catch(e => { console.error(e); process.exitCode = 1; });
