// Disposable profiles only. Start serve.py, then run with a localhost URL.
const assert = require('node:assert/strict');
const { chromium, firefox } = require('@playwright/test');
const base = process.argv[2] || 'http://localhost:5187';

async function check(name, engine, launch = {}) {
  const browser = await engine.launch({ headless: true, ...launch });
  try {
    const page = await browser.newPage({ serviceWorkers: 'block' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== new URL(base).origin) return route.abort();
      if (url.pathname === '/replay-storage-qa') return route.fulfill({ contentType: 'text/html', body: `<!doctype html>
        <link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/components.css">
        <div id="controls"></div><div id="toasts"></div><div id="scrim" hidden></div>
        <aside id="drawer" hidden><h2 id="drawer-title"></h2><div id="drawer-body"></div></aside>` });
      return route.continue();
    });
    await page.goto(`${base}/replay-storage-qa`);
    await page.evaluate(async () => {
      const { replayStore } = await import('/js/replay-store.js');
      await replayStore.run('readwrite', tr => {
        for (const [id, at, timeMs] of [['old', 1, 10672], ['other', 2, 12000], ['orphan', 3, 14000]]) {
          tr.objectStore('meta').put({ id, at, timeMs, bytes: 3, conv: 1 });
          tr.objectStore('video').put(new Blob(['abc'], { type: 'video/webm' }), id);
        }
      });
      window.cameraRequests = 0;
      navigator.mediaDevices.getUserMedia = async () => { cameraRequests++; throw new Error('Camera must stay off'); };
      window.qaApp = { settings: { webcamReplay: false },
        sessions: [{ id: 'a', name: 'Current session' }, { id: 'b', name: 'Other session' }],
        solves: [{ id: 'old', sessionId: 'a', timeMs: 10672, penalty: 'none' }],
        allSolves: async () => [...qaApp.solves, { id: 'other', sessionId: 'b', timeMs: 12000, penalty: '+2' }],
      };
      const panels = await import('/js/panels.js');
      document.querySelector('#controls').append(panels.webcamControls(qaApp));
    });
    await page.getByRole('button', { name: 'Browse saved replays', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '3 saved replays on this device' }).waitFor();
    const rows = page.locator('#drawer-body [role="listitem"]');
    assert.equal(await rows.count(), 3);
    assert.match(await rows.nth(0).innerText(), /14\.00[\s\S]*Solve details unavailable/);
    assert.match(await rows.nth(1).innerText(), /14\.00[\s\S]*Other session/);
    assert.match(await rows.nth(2).innerText(), /10\.67[\s\S]*Current session/);
    assert.equal(await page.evaluate(() => cameraRequests), 0);
    assert.equal(await page.locator('video').count(), 0);
    // A failed retry must retain the rows and must never claim the library is empty.
    await page.evaluate(async () => {
      const { replayStore } = await import('/js/replay-store.js');
      window.originalReplayRun = replayStore.run;
      replayStore.run = async () => { throw new Error('Simulated storage failure'); };
    });
    await page.locator('#drawer-body').getByRole('button', { name: 'Retry loading' }).click();
    await page.locator('#drawer-body [role="status"]').filter({ hasText: 'Saved replay storage is unavailable' }).waitFor();
    assert.equal(await rows.count(), 3);
    await page.evaluate(async () => { (await import('/js/replay-store.js')).replayStore.run = originalReplayRun; });
    await page.locator('#drawer-body').getByRole('button', { name: 'Retry loading' }).click();
    await page.locator('#drawer-body [role="status"]').filter({ hasText: '3 saved replays' }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.getByRole('button', { name: 'Watch replay', exact: true }).count(), 3);
    await page.evaluate(async () => {
      const { replayJournal } = await import('/js/replay-journal.js');
      await replayJournal.append('pending', 0, 10, new Blob(['recovered bytes'], { type: 'video/webm' }));
      await replayJournal.describe('pending', 10, { finished: true, expectedChunks: 1,
        meta: { id: 'recovered', timeMs: 15000, at: 10, start: 0, stop: 15000, bytes: 0, mime: 'video/webm' } });
      await replayJournal.append('partial', 0, 11, new Blob(['partial bytes'], { type: 'video/webm' }));
      await replayJournal.describe('partial', 11, { finished: true, expectedChunks: 2 });
    });
    await page.getByRole('button', { name: 'Back to Camera settings' }).click();
    await page.evaluate(async () => {
      const { replayStore } = await import('/js/replay-store.js');
      window.originalReplayRun = replayStore.run;
      replayStore.run = (mode, ...args) => mode === 'readonly' ? new Promise(() => {}) : originalReplayRun(mode, ...args);
    });
    await page.locator('#drawer-body').getByRole('button', { name: 'Recover recordings', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '2 recordings found' }).waitFor();
    await page.evaluate(async () => { (await import('/js/replay-store.js')).replayStore.run = originalReplayRun; });
    assert.equal(await page.getByRole('button', { name: 'Recover replay', exact: true }).count(), 1);
    const fragments = page.locator('[aria-label="Recoverable recordings"] [role="listitem"]').filter({ hasText: 'Partial recording' });
    const download = page.waitForEvent('download');
    await fragments.getByRole('button', { name: 'Download footage' }).click();
    assert.match((await download).suggestedFilename(), /-partial\.webm$/);
    assert.equal(await page.evaluate(async () => (await (await import('/js/replay-journal.js')).replayJournal.list()).length), 2);
    await page.getByRole('button', { name: 'Recover replay', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '4 saved replays' }).waitFor();
    assert.equal(await page.evaluate(async () => (await (await import('/js/replay-journal.js')).replayJournal.list()).length), 1);
    require('node:fs').mkdirSync('audit-qa', { recursive: true });
    await page.screenshot({ path: `audit-qa/${name.toLowerCase()}-replay-recovery-mobile.png` });
    assert.deepEqual(errors, []);
    console.log(`${name}: PASS recording off, older sessions, orphan footage, failed read, retry, mobile, recovery button, partial download retained, no camera requests`);
  } finally { await browser.close(); }
}

(async () => {
  await check('Chromium', chromium);
  await check('Firefox', firefox, process.env.TAGDA_FIREFOX_PATH ? { executablePath: process.env.TAGDA_FIREFOX_PATH } : {});
})().catch(error => { console.error(error); process.exitCode = 1; });
