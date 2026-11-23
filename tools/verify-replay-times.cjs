const assert = require('node:assert/strict');
const { chromium } = require('@playwright/test');
const base = process.argv[2] || 'http://127.0.0.1:5186';

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
  try {
    const context = await browser.newContext({
      serviceWorkers: 'block', permissions: ['camera', 'microphone'],
      viewport: { width: 1440, height: 1000 },
    });
    await context.route('**/announcements.json*', route => route.fulfill({ body: 'null' }));
    await context.route('**/config.json*', route => route.fulfill({ body: 'null' }));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.tagdatimer?.scramble?.scramble, null, { timeout: 60000 });
    await page.evaluate(async () => {
      document.querySelectorAll('.an-dlg[open]').forEach(dialog => dialog.dispatchEvent(new Event('cancel', { cancelable: true })));
      for (const [key, value] of Object.entries({
        inspection: false, holdTime: 0, confirmShortSolves: false, soundOnPB: false,
        motion: 'full', reduceEffects: false, webcamKeepOn: true,
      })) tagdatimer.setSetting(key, value);
      const { Solves } = await import('/js/db.js');
      tagdatimer.solves = Array.from({ length: 90 }, (_, index) => ({
        id: `replay-times-${index}`, sessionId: tagdatimer.session.id,
        timeMs: 10000 + index, penalty: 'none', createdAt: Date.now() + index,
        event: '333', scramble: tagdatimer.scramble.scramble,
      }));
      await Solves.putMany(tagdatimer.solves);
      tagdatimer.renderAll();
      const replay = await import('/js/replay.js');
      window.replayEvents = [];
      replay.onReplayChange(event => replayEvents.push(event));
      if (!(await replay.enableReplay())) throw new Error('Fake camera did not open');
      tagdatimer.setSetting('webcamReplay', true);
      window.snapshotTimes = () => {
        const list = document.querySelector('#hist-list');
        list.scrollTop = 40;
        const focus = list.querySelector('.avg.open');
        focus?.focus({ preventScroll: true });
        window.timesSnapshot = {
          rows: [...list.querySelectorAll('.solve-chip')],
          headings: [...document.querySelector('.hist-cols').children],
          scroll: list.scrollTop, focus: document.activeElement,
          heights: [...list.querySelectorAll('.solve-chip')].map(node => node.offsetHeight),
        };
      };
      window.checkTimesSnapshot = () => {
        const list = document.querySelector('#hist-list');
        const rows = [...list.querySelectorAll('.solve-chip')];
        const headings = [...document.querySelector('.hist-cols').children];
        return {
          rowsPreserved: rows.length === timesSnapshot.rows.length && rows.every((row, index) => row === timesSnapshot.rows[index]),
          headingsPreserved: headings.length === timesSnapshot.headings.length && headings.every((node, index) => node === timesSnapshot.headings[index]),
          scrollPreserved: list.scrollTop === timesSnapshot.scroll,
          focusPreserved: document.activeElement === timesSnapshot.focus,
          heightsPreserved: rows.length === timesSnapshot.heights.length && rows.every((node, index) => node.offsetHeight === timesSnapshot.heights[index]),
        };
      };
    });
    await page.locator('.hist-cols [data-sort="time"]').click();
    await page.waitForTimeout(450);

    const recordSolve = async (label, { failSave = false } = {}) => {
      if (failSave) await page.evaluate(async () => {
        const { replayStore } = await import('/js/replay-store.js');
        window.originalReplayRun = replayStore.run;
        replayStore.run = (mode, ...args) => mode === 'readwrite'
          ? Promise.reject(new Error('Simulated replay save failure'))
          : originalReplayRun(mode, ...args);
      });
      const count = await page.evaluate(() => tagdatimer.solves.length);
      await page.evaluate(() => document.activeElement?.blur());
      await page.keyboard.press('Space');
      await page.waitForFunction(async () => (await import('/js/replay.js')).replayStatus().recording, null, { timeout: 10000 }).catch(async error => {
        console.error(await page.evaluate(async () => ({
          replay: (await import('/js/replay.js')).replayStatus(),
          body: document.body.className, input: tagdatimer.settings.inputMode,
          dialogs: [...document.querySelectorAll('dialog[open]')].map(node => node.outerHTML.slice(0, 400)),
        })));
        throw error;
      });
      await page.waitForTimeout(250);
      await page.keyboard.press('Space');
      await page.waitForFunction(n => tagdatimer.solves.length === n &&
        [...document.querySelectorAll('#hist-list .idx')].some(node => node.textContent === String(n)), count + 1);
      const id = await page.evaluate(() => {
        const id = tagdatimer.solves.at(-1).id;
        if (replayEvents.some(event => event.type === 'saved' && event.id === id)) throw new Error('Replay saved before snapshot');
        snapshotTimes();
        return id;
      });
      await page.waitForFunction(async ({ id, failSave }) => {
        if (failSave) {
          const status = (await import('/js/replay.js')).replaySaveStatus();
          return status.pending === 0 && status.unsaved === 1;
        }
        return replayEvents.some(event => event.type === 'saved' && event.id === id);
      }, { id, failSave });
      if (failSave) await page.evaluate(async () => {
        (await import('/js/replay-store.js')).replayStore.run = originalReplayRun;
      });
      assert.deepEqual(await page.evaluate(() => checkTimesSnapshot()), {
        rowsPreserved: true, headingsPreserved: true, scrollPreserved: true, focusPreserved: true, heightsPreserved: true,
      }, `${label}: finishing a replay must preserve the displayed list`);
      // Failed final writes retain a playable copy for recovery on current main.
      assert.equal(await page.locator('#hist-list .chip-replay').count(), 1);
      console.log(`PASS: ${label} preserves rows, headings, scroll, focus and row heights`);
      return id;
    };

    const firstId = await recordSolve('sorted times');
    await page.evaluate(async id => {
      snapshotTimes();
      await (await import('/js/replay.js')).deleteClip(id);
    }, firstId);
    assert.deepEqual(await page.evaluate(() => checkTimesSnapshot()), {
      rowsPreserved: true, headingsPreserved: true, scrollPreserved: true, focusPreserved: true, heightsPreserved: true,
    });
    assert.equal(await page.locator('#hist-list .chip-replay').count(), 0);

    // A store refresh can discover clips for existing rows, including at startup.
    await page.evaluate(async () => {
      const { replayStore } = await import('/js/replay-store.js');
      const id = tagdatimer.solves[0].id;
      await replayStore.run('readwrite', transaction => {
        transaction.objectStore('meta').put({ id, at: Date.now(), timeMs: 100, bytes: 3, conv: 1 });
        transaction.objectStore('video').put(new Blob(['abc'], { type: 'video/webm' }), id);
      });
      snapshotTimes();
      await (await import('/js/replay.js')).refreshReplays();
    });
    assert.deepEqual(await page.evaluate(() => checkTimesSnapshot()), {
      rowsPreserved: true, headingsPreserved: true, scrollPreserved: true, focusPreserved: true, heightsPreserved: true,
    });
    assert.equal(await page.locator('#hist-list .chip-replay').count(), 1);
    await page.evaluate(async () => (await import('/js/replay.js')).clearReplays());
    console.log('PASS: replay deletion, discovery and clear update buttons without refreshing the sorted list');

    await page.locator('.hist-cols [data-sort="time"]').click();
    const ordinaryId = await recordSolve('solve-order camera save');
    await page.evaluate(async id => (await import('/js/replay.js')).deleteClip(id), ordinaryId);
    const failedId = await recordSolve('recoverable camera save failure', { failSave: true });
    await page.evaluate(async id => {
      const replay = await import('/js/replay.js');
      const clip = await replay.loadClip(id);
      if (!clip?.blob.size) throw new Error('Failed final save lost the recoverable recording');
      await replay.deleteClip(id);
    }, failedId);

    // Exercise grouped history alongside ordinary practice solves.
    await page.evaluate(() => {
      const members = tagdatimer.solves.slice(-5);
      for (const [index, solve] of members.entries()) {
        solve.competitionSetId = 'replay-times-set'; solve.competitionAttempt = index + 1;
      }
      tagdatimer.competitionSets.set('replay-times-set', {
        id: 'replay-times-set', sessionId: tagdatimer.session.id,
        status: 'complete', size: 5, sequence: 1, solveIds: members.map(solve => solve.id),
      });
      tagdatimer.renderAll();
    });
    await recordSolve('grouped camera save');
    await page.locator('#hist-list .chip-replay').click();
    await page.waitForFunction(() => document.querySelector('.replay-dlg[open] video')?.readyState >= 1);
    await page.evaluate(() => document.querySelector('.replay-dlg').close());
    console.log('PASS: replay button still opens a playable recording');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
