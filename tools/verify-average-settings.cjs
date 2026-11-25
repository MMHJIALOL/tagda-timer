// Uses a disposable browser profile. Start serve.py first, then npm run test:averages.
const assert = require('node:assert/strict');
const { chromium } = require('@playwright/test');
const path = require('node:path');
const os = require('node:os');
const base = process.argv[2] || 'http://localhost:5173';

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== new URL(base).origin) return route.abort();
      if (/\/(announcements|config)\.json$/.test(url.pathname))
        return route.fulfill({ contentType: 'application/json', body: 'null' });
      return route.continue();
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const boot = async () => {
      await page.waitForFunction(() => window.tagdatimer?.scramble?.scramble, null, { timeout: 45000 });
      await page.evaluate(async () => {
        document.querySelectorAll('.an-dlg[open]').forEach(d => d.dispatchEvent(new Event('cancel', { cancelable: true })));
        for (const [key, value] of Object.entries({ motion: 'off', soundOnPB: false, bgMode: 'solid' }))
          await tagdatimer.setSetting(key, value);
      });
    };
    await page.goto(base); await boot();
    await page.evaluate(() => tagdatimer.expandStats());
    const edit = async (host, from, value, key = 'Enter', best = false) => {
      const label = best ? `Change the best ao${from}` : `Change the ao${from} column`;
      await host.getByRole('button', { name: label, exact: true }).click();
      const input = host.getByRole('spinbutton', { name: 'Average of how many solves' });
      await input.fill(String(value));
      await input.press(key);
    };
    await edit(page.locator('.hist-cols'), 12, 10);
    assert.deepEqual(await page.evaluate(() => tagdatimer.settings.histAvgCols), [5, 10]);

    const cases = [
      { name: 'ao10 and ao12 improve', values: [9000,5000,25000,12000,19000,22000,22000,17000,10000,22000,17000,17000,13000,8000,23000,6000,17000], message: 'Best ao10, ao12 of the session!' },
      { name: 'only ao10 improves', values: [23000,19000,18000,8000,16000,20000,22000,12000,20000,15000,11000,14000,22000,16000,16000,16000,10000], message: 'Best ao10 of the session!' },
    ];
    for (const item of cases) {
      const result = await page.evaluate(async ({ name, values }) => {
        const { bestAvg } = await import('/js/stats.js');
        tagdatimer.solves = values.slice(0, -1).map((timeMs, i) => ({
          id: `fixture-${name}-${i}`, sessionId: tagdatimer.session.id, timeMs,
          penalty: 'none', event: '333', mode: 'wca', scramble: 'R U', createdAt: Date.now() + i,
        }));
        tagdatimer.session.goal = null;
        const before = bestAvg(tagdatimer.solves, 10).value;
        document.getElementById('toasts').replaceChildren();
        await tagdatimer.recordSolve({ timeMs: values.at(-1) });
        return { before, after: bestAvg(tagdatimer.solves, 10).value,
          message: document.querySelector('#toasts .toast.good > span')?.textContent,
          ticker: document.querySelector('.pb-marquee')?.textContent };
      }, item);
      assert.ok(result.after < result.before);
      assert.equal(result.message, item.message);
      assert.match(result.ticker, /best ao10/);
      console.log('PASS:', item.name, '->', result.message);
    }

    const side = page.locator('#panel-stats');
    assert.equal(await side.locator('.avg-edit:visible').count(), 0);
    assert.equal(await side.locator('#stats-edit-toggle').isVisible(), true);
    await side.locator('#stats-toggle').click();
    assert.equal(await side.getAttribute('data-collapsed'), 'true');
    await side.locator('#stats-edit-toggle').click();
    assert.equal(await side.getAttribute('data-collapsed'), 'false');
    assert.equal(await side.locator('#stats-edit-toggle').getAttribute('aria-pressed'), 'true');
    assert.equal(await side.locator('.avg-edit:visible').count(), 8);
    await edit(side, 12, 8);
    assert.deepEqual(await page.evaluate(() => tagdatimer.settings.statsAvgCols), [5, 8, 50, 100, 1000]);
    await edit(side.locator('#bests-grid'), 8, 7, 'Enter', true);
    assert.equal(await side.locator('[data-k="ao7"]').count(), 1);
    assert.equal(await side.locator('[data-b="ao7"]').count(), 1);
    assert.equal(await page.locator('#drawer').isHidden(), true);
    await edit(side.locator('#bests-grid'), 7, 8, 'Enter', true);
    assert.deepEqual(await page.evaluate(() => tagdatimer.settings.statsAvgCols), [5, 8, 50, 100, 1000]);
    await side.locator('#stats-edit-toggle').click();
    assert.equal(await side.locator('#stats-edit-toggle').getAttribute('aria-pressed'), 'false');
    assert.equal(await side.locator('.avg-edit:visible').count(), 0);
    const sideValues = await page.evaluate(async () => {
      const { currentAvg, bestAvg } = await import('/js/stats.js');
      const { fmtResult } = await import('/js/util.js');
      return { current: fmtResult(currentAvg(tagdatimer.solves, 8), false), best: fmtResult(bestAvg(tagdatimer.solves, 8).value, false) };
    });
    assert.equal(await side.locator('[data-k="ao8"] .stat-v').textContent(), sideValues.current);
    assert.equal(await side.locator('[data-b="ao8"] b').textContent(), sideValues.best);
    assert.equal(await page.locator('#peek-ao12').evaluate(n => n.parentElement.querySelector('b').textContent), 'ao8');
    assert.equal(await page.locator('#drawer').isHidden(), true);
    await side.locator('[data-k="ao8"] .stat-v').click();
    await page.waitForFunction(() => !document.querySelector('#drawer').hidden);
    assert.equal(await page.locator('#drawer-title').textContent(), 'ao8');
    await page.evaluate(async () => (await import('/js/panels.js')).closeDrawer());
    await side.locator('[data-b="ao8"]').click();
    await page.waitForFunction(() => !document.querySelector('#drawer').hidden);
    assert.equal(await page.locator('#drawer-title').textContent(), 'best-ao8');
    await page.evaluate(async () => (await import('/js/panels.js')).closeDrawer());
    console.log('PASS: corner pencil toggles all eight editors; editing best averages updates current/best/peek values and detail links');

    await page.locator('#btn-stats').click();
    const drawer = page.locator('#drawer-body');
    assert.equal(await drawer.locator('.avg-edit:visible').count(), 0);
    await drawer.getByRole('button', { name: 'Edit averages', exact: true }).click();
    assert.equal(await drawer.locator('.avg-edit:visible').count(), 5);
    await edit(drawer, 8, 9);
    assert.equal(await side.locator('[data-k="ao9"]').count(), 1);
    assert.equal(await drawer.locator('[data-avg-size="9"]').count(), 1);
    await edit(drawer, 9, 7, 'Escape');
    for (const invalid of [5, '', 2, 1001, '9.5']) await edit(drawer, 9, invalid);
    assert.deepEqual(await page.evaluate(() => tagdatimer.settings.statsAvgCols), [5, 9, 50, 100, 1000]);
    await page.evaluate(() => { tagdatimer.copyToast = text => { window.copiedStats = text; }; });
    await drawer.getByRole('button', { name: 'Copy selected stats', exact: true }).click();
    const copied = await page.evaluate(() => window.copiedStats);
    assert.match(copied, /avg of 9\n/);
    assert.doesNotMatch(copied, /avg of 12\n/);
    // Drawer-only fifth slot is editable too; keep it out of the four sidebar slots.
    await edit(drawer, 1000, 25);
    assert.deepEqual(await page.evaluate(() => tagdatimer.settings.statsAvgCols), [5, 9, 50, 100, 25]);
    await drawer.getByRole('button', { name: 'Change the ao9 column', exact: true }).click();
    await drawer.getByRole('spinbutton').fill('11');
    await drawer.getByRole('button', { name: 'Finish editing averages', exact: true }).click();
    assert.equal(await drawer.locator('.avg-edit:visible').count(), 0);
    assert.equal(await drawer.locator('input.col-num').count(), 0);
    assert.equal(await drawer.locator('[data-avg-size="11"]').count(), 1);
    await drawer.getByRole('button', { name: 'Edit averages', exact: true }).click();
    await edit(drawer, 11, 9);
    console.log('PASS: Statistics editors, validation, Escape and custom-average export');

    const notificationChecks = await page.evaluate(async () => {
      const { bestAvg } = await import('/js/stats.js');
      const { recordAverages } = await import('/js/average-settings.js');
      let seed = 71;
      const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2**32; };
      let values;
      for (let i = 0; i < 10000; i++) {
        const candidate = Array.from({ length: 17 }, () => 5000 + 1000 * Math.floor(random() * 21));
        const list = candidate.map(timeMs => ({ timeMs, penalty: 'none' }));
        if (bestAvg(list, 9).value < bestAvg(list.slice(0, -1), 9).value) { values = candidate; break; }
      }
      if (!values) throw new Error('Could not find ao9 fixture');
      tagdatimer.solves = values.slice(0, -1).map((timeMs, i) => ({ id: `stats-only-${i}`, sessionId: tagdatimer.session.id, timeMs, penalty: 'none', createdAt: Date.now()+i }));
      document.getElementById('toasts').replaceChildren();
      await tagdatimer.recordSolve({ timeMs: values.at(-1) });
      const message = document.querySelector('#toasts .toast.good > span')?.textContent;
      // An unchanged record or DNF must not celebrate again.
      document.getElementById('toasts').replaceChildren();
      await tagdatimer.recordSolve({ timeMs: 100000, penalty: 'DNF' });
      const dnfToasts = document.querySelectorAll('#toasts .toast.good').length;
      return { message, dnfToasts,
        sizes: recordAverages({ histAvgCols: [10], statsAvgCols: [7,9,50,100,25] }) };
    });
    assert.match(notificationChecks.message, /ao9/);
    assert.equal(notificationChecks.dnfToasts, 0);
    assert.deepEqual(notificationChecks.sizes, [5,7,9,10,12,25,50,100]);
    console.log('PASS: records selected only in Stats notify; ao5/ao12 always included; DNF does not notify');

    await page.reload(); await boot();
    assert.deepEqual(await page.evaluate(() => tagdatimer.settings.histAvgCols), [5,10]);
    assert.deepEqual(await page.evaluate(() => tagdatimer.settings.statsAvgCols), [5,9,50,100,25]);
    await page.evaluate(() => tagdatimer.expandStats());
    assert.equal(await side.locator('.avg-edit:visible').count(), 0);
    const desktopScreenshot = path.join(os.tmpdir(), 'tagda-averages-desktop.png');
    await page.screenshot({ path: desktopScreenshot });
    console.log('Desktop screenshot:', desktopScreenshot);
    await side.locator('#stats-edit-toggle').click();
    const editScreenshot = path.join(os.tmpdir(), 'tagda-averages-editing.png');
    await page.screenshot({ path: editScreenshot });
    console.log('Edit mode screenshot:', editScreenshot);
    // Leaving edit mode also commits a number still being typed.
    await side.getByRole('button', { name: 'Change the best ao9', exact: true }).click();
    await side.getByRole('spinbutton').fill('11');
    await side.locator('#stats-edit-toggle').click();
    assert.equal(await side.locator('.avg-edit:visible').count(), 0);
    assert.equal(await side.locator('input.col-num').count(), 0);
    assert.equal(await side.locator('[data-k="ao11"]').count(), 1);
    assert.equal(await side.locator('[data-b="ao11"]').count(), 1);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => document.querySelector('#btn-stats').click());
    assert.equal(await drawer.locator('.avg-edit:visible').count(), 0);
    await drawer.getByRole('button', { name: 'Edit averages', exact: true }).click();
    await edit(drawer, 11, 10);
    assert.deepEqual(await page.evaluate(() => tagdatimer.settings.statsAvgCols), [5,10,50,100,25]);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const mobileScreenshot = path.join(os.tmpdir(), 'tagda-averages-mobile.png');
    await page.screenshot({ path: mobileScreenshot });
    console.log('Mobile screenshot:', mobileScreenshot);
    assert.deepEqual(errors, []);
    console.log('PASS: saved settings survive reload; mobile drawer editing and no page overflow; no browser errors');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
