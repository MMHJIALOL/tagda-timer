const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const path = require('node:path');
const os = require('node:os');
const base = process.argv[2] || 'http://127.0.0.1:5186';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 2406, height: 1341 }, serviceWorkers: 'block' });
    for (const name of ['announcements', 'config']) await context.route(`**/${name}.json*`, r => r.fulfill({ body: 'null' }));
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const ready = async () => {
      await page.waitForFunction(() => window.tagdatimer?.scramble?.scramble && tagdatimer.layoutStatsReady);
      await page.evaluate(async () => {
        document.querySelectorAll('.an-dlg[open]').forEach(d => d.dispatchEvent(new Event('cancel', { cancelable: true })));
        await document.fonts.ready;
      });
      await settle();
    };
    const snapshot = () => page.evaluate(() => Object.fromEntries(
      ['#timer-core', '#time-main', '#scramble-zone', '#scramble-text', '#panel-times', '#panel-stats', '#panel-cube',
        '#timer-ao5', '#timer-ao12', '#timer-bpa-value', '#timer-wpa-value'].map(selector => {
        const node = document.querySelector(selector), r = node.getBoundingClientRect(), css = getComputedStyle(node);
        return [selector, { x: r.x, y: r.y, w: r.width, h: r.height, font: parseFloat(css.fontSize) }];
      })));
    const edit = async () => {
      await page.evaluate(() => tagdatimer.layoutEditor.start());
      await page.waitForFunction(() => tagdatimer.layoutEditor.editing); await settle();
    };
    const done = async () => {
      await page.getByRole('button', { name: 'Done', exact: true }).click();
      await page.waitForFunction(() => !tagdatimer.layoutEditor.editing); await settle();
    };
    const undo = async () => { await page.getByRole('button', { name: 'Undo', exact: true }).click(); await settle(); };
    const currentBox = id => page.evaluate(id => ({ ...tagdatimer.settings.widgetLayouts.desktop[id] }), id);
    const compareAppearance = (before, after, label) => {
      for (const selector of ['#timer-core', '#scramble-zone', '#panel-times', '#panel-stats', '#panel-cube']) {
        for (const axis of ['x', 'y', 'w', 'h']) assert.ok(Math.abs(before[selector][axis] - after[selector][axis]) <= 12,
          `${label}: ${selector} ${axis} changed from ${before[selector][axis]} to ${after[selector][axis]}`);
      }
      for (const selector of ['#time-main', '#scramble-text']) assert.ok(Math.abs(before[selector].font - after[selector].font) < 1,
        `${label}: ${selector} font changed from ${before[selector].font} to ${after[selector].font}`);
    };
    const addSolves = async count => {
      await page.evaluate(async count => {
        const { Solves } = await import('/js/db.js');
        await Solves.putMany(Array.from({ length: count }, (_, i) => ({
          id: `preservation-${i}`, sessionId: tagdatimer.session.id, event: '333', mode: 'wca',
          timeMs: 10000 + i * 100, penalty: 'none', scramble: 'R U', createdAt: 1700000000000 + i,
        })));
        await tagdatimer.reload();
      }, count);
      await settle();
    };
    const assertAverages = async ids => {
      const positions = await snapshot(), timer = positions['#timer-core'];
      for (const id of ids) {
        const selector = { ao5: '#timer-ao5', ao12: '#timer-ao12', bpa: '#timer-bpa-value', wpa: '#timer-wpa-value' }[id];
        const r = positions[selector];
        assert.ok(r.w > 0 && r.h > 0, `${id} is visible`);
        assert.ok(Math.abs(r.x + r.w / 2 - timer.x - timer.w / 2) < 220, `${id} stays together below the timer`);
        assert.ok(r.y >= timer.y + timer.h - 8 && r.y + r.h < timer.y + timer.h + 160, `${id} stays below the timer and on screen`);
        const shell = page.locator(`[data-widget="${id}"]`);
        assert.equal(await shell.isVisible(), true);
        assert.ok(!/—/.test(await page.locator(`${selector} i`).textContent()), `${id} contains the actual average`);
      }
      return positions;
    };
    await page.goto(base); await ready();
    await page.evaluate(() => {
      tagdatimer.setSetting('motion', 'off'); tagdatimer.setSetting('inspection', false);
      tagdatimer.setSetting('confirmShortSolves', false); tagdatimer.setSetting('soundOnPB', false);
    });
    await settle();
    const natural = await snapshot();
    await page.screenshot({ path: path.join(os.tmpdir(), 'tagda-preservation-before.png') });
    await edit(); compareAppearance(natural, await snapshot(), 'Opening the editor at the supplied screenshot resolution');
    await page.screenshot({ path: path.join(os.tmpdir(), 'tagda-preservation-editing.png') });
    await page.locator('#layout-viewport').evaluate(node => { node.scrollTop = 250; });
    await done();
    assert.equal(await page.locator('#layout-viewport').evaluate(node => node.scrollTop), 0);
    compareAppearance(natural, await snapshot(), 'Done after scrolling');
    console.log('PASS: 2406 × 1341 preserves timer/scramble text, panel geometry, and position after editing scroll');

    // Start empty, then let averages become available while the custom layout is already active.
    for (const [count, ids] of [[4, ['bpa', 'wpa']], [6, ['ao5', 'bpa', 'wpa']], [12, ['ao5', 'ao12', 'bpa', 'wpa']]]) {
      await addSolves(count); await assertAverages(ids);
      compareAppearance(natural, await snapshot(), `${count} solves`);
      if (count === 6) {
        await edit();
        await page.screenshot({ path: path.join(os.tmpdir(), 'tagda-layout-fixed-six-solves.png') });
        await done();
      }
    }
    const generated = await currentBox('ao5');
    const beforeReload = await page.evaluate(() => structuredClone(tagdatimer.settings.widgetLayouts));
    await page.reload(); await ready();
    await page.waitForFunction(() => tagdatimer.layoutEditor.active);
    await assertAverages(['ao5', 'ao12', 'bpa', 'wpa']);
    assert.deepEqual(await currentBox('ao5'), generated);
    assert.deepEqual(await page.evaluate(() => tagdatimer.settings.widgetLayouts), beforeReload);
    console.log('PASS: BPA/WPA, ao5 and ao12 become visible in order, stay grouped, and retain their layout after reload');

    await page.evaluate(async () => {
      const { Solves } = await import('/js/db.js');
      await Solves.putMany(tagdatimer.solves.map((solve, i) => ({ ...solve, timeMs: 600000 + i * 100 })));
      await tagdatimer.reload();
    });
    await settle(); await assertAverages(['ao5', 'ao12', 'bpa', 'wpa']);
    const averagesFit = await page.evaluate(() => ['ao5', 'ao12', 'bpa', 'wpa'].every(id => {
      const shell = document.querySelector(`[data-widget="${id}"]`).getBoundingClientRect();
      const value = document.querySelector(`[data-widget="${id}"] i`).getBoundingClientRect();
      return value.left >= shell.left - 1 && value.right <= shell.right + 1 && value.top >= shell.top - 1 && value.bottom <= shell.bottom + 1;
    }));
    assert.equal(averagesFit, true, 'longer average values expand automatic widgets instead of being clipped');
    console.log('PASS: average widgets adapt to longer results without clipping their values');

    // Grab ordinary border points, including places far from the visible midpoint grip.
    await edit();
    const timer = page.locator('[data-widget="timer"]');
    const points = {
      n: [[.25, 0], [.5, 0], [.75, 0]], e: [[1, .25], [1, .5], [1, .75]],
      s: [[.25, 1], [.5, 1], [.75, 1]], w: [[0, .25], [0, .5], [0, .75]],
      nw: [[0, 0]], ne: [[1, 0]], se: [[1, 1]], sw: [[0, 1]],
    };
    for (const [direction, samples] of Object.entries(points)) for (const [px, py] of samples) {
      const before = await currentBox('timer'), r = await timer.boundingBox();
      const step = await page.locator('#layout-canvas').evaluate(node => parseFloat(node.style.getPropertyValue('--layout-column')));
      const x = r.x + (px === 0 ? 2 : px === 1 ? r.width - 2 : r.width * px);
      const y = r.y + (py === 0 ? 2 : py === 1 ? r.height - 2 : r.height * py);
      const dx = direction.includes('w') ? step : direction.includes('e') ? -step : 0;
      const dy = direction.includes('n') ? 8 : direction.includes('s') ? -8 : 0;
      await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + dx, y + dy, { steps: 4 }); await page.mouse.up();
      assert.deepEqual(await currentBox('timer'), { x: before.x + (direction.includes('w') ? 1 : 0),
        y: before.y + (direction.includes('n') ? 1 : 0), w: before.w - (/[ew]/.test(direction) ? 1 : 0),
        h: before.h - (/[ns]/.test(direction) ? 1 : 0) }, `${direction} at ${px},${py} resizes rather than moves`);
      await undo();
    }
    console.log('PASS: every border works at 25%, 50%, and 75%, and all four corners resize from the grabbed edge');
    const beforeResize = await page.evaluate(() => structuredClone(tagdatimer.settings.widgetLayouts));
    const corner = await timer.locator('.layout-resize-se').boundingBox();
    const timerFont = (await snapshot())['#time-main'].font;
    await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2); await page.mouse.down();
    await page.mouse.move(corner.x + corner.width / 2 - 24, corner.y + corner.height / 2 - 24, { steps: 4 }); await page.mouse.up();
    const resizedBox = await currentBox('timer'), resizedFont = (await snapshot())['#time-main'].font;
    assert.ok(resizedFont < timerFont, 'an explicit resize scales the timer from its captured size');
    await done();
    await page.reload(); await ready(); await page.waitForFunction(() => tagdatimer.layoutEditor.active);
    assert.deepEqual(await currentBox('timer'), resizedBox);
    assert.ok(Math.abs((await snapshot())['#time-main'].font - resizedFont) < .1, 'the deliberately resized timer keeps the same text size after reload');
    await page.evaluate(saved => tagdatimer.setSetting('widgetLayouts', saved), beforeResize);
    await settle();
    console.log('PASS: deliberate timer scaling and its original size reference persist across reload');

    // These are the precise dimensions that the old editor used to save on opening.
    await page.evaluate(() => {
      tagdatimer.setSetting('widgetLayouts', null);
      tagdatimer.setSetting('interactiveResizing', false);
    });
    await settle(); const legacyNatural = await snapshot();
    await page.evaluate(() => tagdatimer.setSetting('widgetLayouts', { desktop: {
      scramble: { x: 6, y: 0, w: 12, h: 5 }, timer: { x: 6, y: 20, w: 12, h: 8 },
      times: { x: 0, y: 0, w: 5, h: 39 }, spotify: { x: 0, y: 39, w: 5, h: 9 },
      stats: { x: 19, y: 0, w: 5, h: 11 }, cube: { x: 19, y: 39, w: 5, h: 9 },
      ao5: { x: 6, y: 28, w: 6, h: 3 }, ao12: { x: 12, y: 28, w: 6, h: 3 },
      bpa: { x: 6, y: 31, w: 6, h: 2 }, wpa: { x: 12, y: 31, w: 6, h: 2 },
    } }));
    await settle(); compareAppearance(legacyNatural, await snapshot(), 'Recovery from the old generated layout');
    console.log('PASS: the untouched old generated layout recovers current appearance without restoring its shrunken timer or shifted rails');

    for (const appearance of [
      { timerFont: 'Inter', timerSize: 160, scrambleSize: 180, sidebarWidth: 420, cubeSize: 200 },
      { timerFont: 'Chivo Mono', timerSize: 70, scrambleSize: 80, sidebarWidth: 220, cubeSize: 75 },
    ]) {
      await page.evaluate(async appearance => {
        tagdatimer.setSetting('widgetLayouts', null); tagdatimer.setSetting('interactiveResizing', false);
        for (const [key, value] of Object.entries(appearance)) tagdatimer.setSetting(key, value);
        await document.fonts.ready;
      }, appearance);
      await page.waitForTimeout(400); const before = await snapshot();
      await edit(); compareAppearance(before, await snapshot(), `Font and size ${JSON.stringify(appearance)}`);
      await done(); compareAppearance(before, await snapshot(), 'Locking the chosen appearance');
    }
    console.log('PASS: large/small text, proportional/monospace timer fonts, scramble sizes and sidebar widths survive entering and leaving editing');
    await page.screenshot({ path: path.join(os.tmpdir(), 'tagda-preservation-verified.png') });
    assert.deepEqual(errors, []);
    await context.close();

    // A returning visitor must get the corrected modules when the HTML version changes.
    const cachedContext = await browser.newContext({ viewport: { width: 2406, height: 1341 }, serviceWorkers: 'allow' });
    const cached = await cachedContext.newPage();
    const cachedErrors = []; cached.on('pageerror', error => cachedErrors.push(error.message));
    await cached.goto(base);
    await cached.waitForFunction(() => window.tagdatimer?.scramble?.scramble && navigator.serviceWorker.controller);
    await cached.evaluate(async () => {
      const cache = await caches.open('tagda-v9');
      const current = await (await fetch('/index.html', { cache: 'no-store' })).text();
      const old = current.replaceAll('?v=176', '?v=175');
      await cache.put('/', new Response(old, { headers: { 'Content-Type': 'text/html' } }));
      await cache.put('/index.html', new Response(old, { headers: { 'Content-Type': 'text/html' } }));
      await cache.put('/js/interactive-layout.js', new Response('throw new Error("Stale layout module was loaded");',
        { headers: { 'Content-Type': 'text/javascript' } }));
    });
    await cached.reload();
    await cached.waitForFunction(() => window.tagdatimer?.scramble?.scramble && tagdatimer.layoutStatsReady);
    await cached.evaluate(() => {
      document.querySelectorAll('.an-dlg[open]').forEach(d => d.dispatchEvent(new Event('cancel', { cancelable: true })));
      tagdatimer.layoutEditor.start();
    });
    await cached.waitForFunction(() => tagdatimer.layoutEditor.editing);
    assert.equal(await cached.locator('[data-widget="timer"] .layout-resize').count(), 8);
    assert.deepEqual(cachedErrors, []);
    await cachedContext.close();
    console.log('PASS: a returning service-worker-controlled browser replaces the stale editor after the release version changes');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
