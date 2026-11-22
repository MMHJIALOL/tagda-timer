const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const path = require('node:path');
const os = require('node:os');
const base = process.argv[2] || 'http://127.0.0.1:5186';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
    await context.route('**/announcements.json*', r => r.fulfill({ body: 'null' }));
    await context.route('**/config.json*', r => r.fulfill({ body: 'null' }));
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    const ready = async () => {
      await page.waitForFunction(() => window.tagdatimer?.scramble?.scramble && tagdatimer.layoutEditor);
      await page.evaluate(() => document.querySelectorAll('.an-dlg[open]').forEach(d =>
        d.dispatchEvent(new Event('cancel', { cancelable: true }))));
    };
    const box = id => page.evaluate(id => ({ ...tagdatimer.settings.widgetLayouts[innerWidth <= 1100 ? 'tablet' : 'desktop'][id] }), id);
    const shell = id => page.locator(`.layout-widget[data-widget="${id}"]`);
    const grid = () => page.evaluate(() => {
      const g = tagdatimer.settings.widgetLayouts.grids[innerWidth <= 1100 ? 'tablet' : 'desktop'];
      return { ...g, step: (innerWidth - 16) / g.columns };
    });
    const edit = async () => {
      await page.evaluate(() => tagdatimer.layoutEditor.start());
      await page.waitForFunction(() => tagdatimer.layoutEditor.editing);
    };
    const done = async () => {
      await page.getByRole('button', { name: 'Done', exact: true }).click();
      await page.waitForFunction(() => !tagdatimer.layoutEditor.editing);
    };
    const undo = () => page.getByRole('button', { name: 'Undo', exact: true }).click();
    const drag = async (locator, dx, dy, release = true, position = [.5, .5]) => {
      await locator.scrollIntoViewIfNeeded();
      const r = await locator.boundingBox();
      const x = r.x + r.width * position[0], y = r.y + r.height * position[1];
      await page.mouse.move(x, y); await page.mouse.down();
      await page.mouse.move(x + dx, y + dy, { steps: 8 });
      if (release) await page.mouse.up();
    };
    const picker = page.getByRole('combobox', { name: 'Widget to resize' });
    const width = page.getByRole('spinbutton', { name: 'Widget width in columns' });
    const height = page.getByRole('spinbutton', { name: 'Widget height in rows' });
    const snapshot = () => page.evaluate(() => Object.fromEntries(
      ['#scramble-zone', '#timer-core', '#panel-times', '#panel-stats', '#panel-cube', '#time-main', '#scramble-text']
        .map(selector => { const n = document.querySelector(selector), r = n.getBoundingClientRect();
          return [selector, { x: r.x, y: r.y, w: r.width, h: r.height, font: parseFloat(getComputedStyle(n).fontSize) }]; })));
    await page.goto(base); await ready();
    assert.equal(await page.evaluate(() => tagdatimer.layoutEditor.active), false);
    await page.evaluate(async () => {
      const { Solves } = await import('/js/db.js');
      await Solves.putMany(Array.from({ length: 12 }, (_, i) => ({
        id: `layout-check-${i}`, sessionId: tagdatimer.session.id, event: '333', mode: 'wca',
        timeMs: 10000 + i * 100, penalty: 'none', scramble: 'R U', createdAt: Date.now() + i,
      })));
      await tagdatimer.reload();
      for (const [key, value] of Object.entries({ timerSize: 125, scrambleSize: 130, cubeSize: 145,
        sidebarWidth: 330, sidebarText: 115, timesSize: 110, inspection: false, confirmShortSolves: false,
        soundOnPB: false, tiles: { times: { dock: 'right' }, stats: { dock: 'left' } } })) {
        await tagdatimer.setSetting(key, value);
      }
      await document.fonts.ready;
    });
    await page.waitForTimeout(450);
    const baseline = await snapshot();
    const settings = await page.evaluate(() => structuredClone(tagdatimer.settings));
    await page.screenshot({ path: path.join(os.tmpdir(), 'tagda-layout-before.png') });

    // Open through the real appearance setting with a customized page already in place.
    await page.locator('#btn-theme').click();
    const row = page.locator('#drawer .row').filter({ has: page.getByText('Interactive resizing', { exact: true }) });
    await row.locator('label.switch').click();
    await page.waitForFunction(() => tagdatimer.layoutEditor.editing);
    assert.equal(await page.locator('#drawer').isVisible(), false);
    assert.equal(await page.locator('.layout-widget:not([hidden])').count(), 9);
    const captured = await snapshot();
    for (const selector of ['#scramble-zone', '#timer-core', '#panel-times', '#panel-stats', '#panel-cube']) {
      for (const axis of ['x', 'y', 'w', 'h']) assert.ok(Math.abs(captured[selector][axis] - baseline[selector][axis]) <= 12,
        `${selector} preserves ${axis}: ${JSON.stringify({ before: baseline[selector], after: captured[selector] })}`);
    }
    for (const selector of ['#time-main', '#scramble-text']) assert.ok(Math.abs(captured[selector].font - baseline[selector].font) < 1,
      `${selector} retains the chosen text size`);
    const currentSettings = await page.evaluate(() => tagdatimer.settings);
    for (const key of Object.keys(settings).filter(k => !['interactiveResizing', 'widgetLayouts'].includes(k))) {
      assert.deepEqual(currentSettings[key], settings[key], `opening the editor preserves ${key}`);
    }
    assert.equal(await picker.locator('option[value="spotify"]').count(), 0);
    console.log('PASS: editing starts from current sizes, text settings and swapped rails; hidden widgets stay hidden');

    await page.keyboard.press('Space'); await page.keyboard.press('d');
    assert.match(await page.locator('#timer-display').getAttribute('class'), /state-idle/);
    assert.equal(await page.evaluate(() => tagdatimer.solves.length), 12);
    const g = await grid(), initialTimer = await box('timer');
    await drag(shell('timer').locator('.layout-move'), 0, -2 * g.row);
    assert.equal((await box('timer')).y, initialTimer.y - 2);
    const placedTimer = await box('timer'), occupied = await box('times');
    await drag(shell('timer').locator('.layout-move'), (occupied.x - placedTimer.x) * g.step,
      (occupied.y - placedTimer.y) * g.row, false);
    assert.equal(await page.locator('.layout-preview.invalid').isVisible(), true);
    await page.mouse.up(); assert.deepEqual(await box('timer'), placedTimer);
    await drag(shell('timer').locator('.layout-move'), 0, g.row, false);
    await page.evaluate(() => window.dispatchEvent(new Event('blur'))); await page.mouse.up();
    assert.deepEqual(await box('timer'), placedTimer);
    console.log('PASS: moves snap; collisions and cancelled gestures keep the previous layout');

    for (const direction of ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']) {
      const before = await box('timer');
      const dx = direction.includes('w') ? g.step : direction.includes('e') ? -g.step : 0;
      const dy = direction.includes('n') ? g.row : direction.includes('s') ? -g.row : 0;
      await drag(shell('timer').locator(`.layout-resize-${direction}`), dx, dy);
      assert.deepEqual(await box('timer'), {
        x: before.x + (direction.includes('w') ? 1 : 0), y: before.y + (direction.includes('n') ? 1 : 0),
        w: before.w - (/[ew]/.test(direction) ? 1 : 0), h: before.h - (/[ns]/.test(direction) ? 1 : 0),
      }, `${direction} resizes from the correct edge`);
      await undo(); assert.deepEqual(await box('timer'), before);
    }
    // Move using the body near either side and the bottom, away from resize handles.
    for (const position of [[.1, .5], [.9, .5], [.5, .85]]) {
      await drag(shell('timer'), 0, -g.row, true, position);
      assert.equal((await box('timer')).y, placedTimer.y - 1);
      await undo();
    }
    for (const [direction, key, expected] of [['n', 'ArrowDown', { y: placedTimer.y + 1, h: placedTimer.h - 1 }],
      ['w', 'ArrowRight', { x: placedTimer.x + 1, w: placedTimer.w - 1 }]]) {
      await shell('timer').locator(`.layout-resize-${direction}`).focus(); await page.keyboard.press(key);
      assert.deepEqual(await box('timer'), { ...placedTimer, ...expected }); await undo();
    }
    console.log('PASS: all eight pointer handles and north/west keyboard handles anchor the opposite edge; dragging works across the widget');

    for (const id of ['timer', 'scramble', 'times', 'stats', 'cube', 'ao5', 'ao12', 'bpa', 'wpa']) {
      await picker.selectOption(id); const before = await box(id), minH = Number(await height.getAttribute('min'));
      if (before.h > minH) {
        await height.fill(String(before.h - 1)); await height.press('Enter');
        assert.equal((await box(id)).h, before.h - 1, `${id} resizes independently`); await undo();
      }
    }
    await picker.selectOption('timer');
    await width.fill('40.5'); await width.press('Enter');
    assert.deepEqual(await box('timer'), placedTimer);
    await page.screenshot({ path: path.join(os.tmpdir(), 'tagda-layout-editor.png') });
    await done();
    const desktop = await page.evaluate(async () => {
      await tagdatimer.persist({ immediate: true }); return structuredClone(tagdatimer.settings.widgetLayouts.desktop);
    });
    await page.reload(); await ready();
    assert.deepEqual(await page.evaluate(() => tagdatimer.settings.widgetLayouts.desktop), desktop);
    assert.equal(await page.evaluate(() => tagdatimer.layoutEditor.active && !tagdatimer.layoutEditor.editing), true);
    assert.notEqual(await page.locator('#live-ao5').textContent(), '—');
    const timerRect = await shell('timer').boundingBox();
    await page.keyboard.press('Space'); await page.waitForTimeout(600);
    assert.match(await page.locator('#timer-display').getAttribute('class'), /state-running/);
    assert.deepEqual(await shell('timer').boundingBox(), timerRect);
    await page.keyboard.press('Space'); await page.waitForFunction(() => tagdatimer.solves.length === 13);
    console.log('PASS: independent widget sizes persist after reload; averages and recording still work without moving the timer');

    // A narrow, short scramble must keep its text and controls reachable.
    await edit(); await picker.selectOption('scramble');
    const originalScramble = await box('scramble');
    await width.fill(await width.getAttribute('min')); await width.press('Enter');
    await height.fill(await height.getAttribute('min')); await height.press('Enter');
    await done();
    assert.equal(await page.locator('#scramble-text').isVisible(), true);
    await page.locator('#btn-custom-scramble').click();
    const input = page.locator('#drawer textarea.scramble-box');
    await input.fill("R U R' U'\nF R U R' U' F'");
    await page.getByRole('button', { name: 'use these scrambles', exact: true }).click();
    if (await page.locator('#drawer-close').isVisible()) await page.locator('#drawer-close').click();
    await page.waitForFunction(() => tagdatimer.scramble.scramble === "R U R' U'");
    await page.locator('#btn-next-scramble').click();
    await page.waitForFunction(() => tagdatimer.scramble.scramble === "F R U R' U' F'");
    await page.waitForTimeout(600); // Let the move-reveal animation finish before inspecting the visible notation.
    const scrambleVisibility = await page.evaluate(() => {
      const zone = document.querySelector('#scramble-zone').getBoundingClientRect();
      return ['#scramble-text', '#scramble-tools'].every(selector => {
        const r = document.querySelector(selector).getBoundingClientRect();
        return r.top >= zone.top && r.bottom <= zone.bottom && r.width > 100 && r.height >= 24;
      });
    });
    assert.equal(scrambleVisibility, true, 'notation and controls both stay inside the visible widget after replacing a scramble');
    await page.screenshot({ path: path.join(os.tmpdir(), 'tagda-layout-narrow-scramble.png') });
    await edit(); await picker.selectOption('scramble');
    await height.fill(String(originalScramble.h)); await height.press('Enter');
    await width.fill(String(originalScramble.w)); await width.press('Enter');
    await done();
    console.log('PASS: short/narrow scramble widgets expose the custom scramble input and next button; pasted scrambles work');

    await page.evaluate(() => tagdatimer.setSetting('inputMode', 'manual'));
    await page.locator('#manual-input').fill('1234');
    await page.locator('#manual-add').click();
    await page.waitForFunction(() => tagdatimer.solves.length === 14);
    await page.evaluate(() => tagdatimer.setSetting('inputMode', 'timer'));
    console.log('PASS: manual time entry remains visible and records a solve in a custom layout');

    await edit();
    const statsBefore = await box('stats');
    await page.evaluate(() => tagdatimer.setSetting('showStats', false));
    await page.waitForFunction(() => document.querySelector('[data-widget="stats"]').hidden);
    assert.equal(await picker.locator('option[value="stats"]').count(), 0);
    await page.evaluate(() => tagdatimer.setSetting('showStats', true));
    await page.waitForFunction(() => !document.querySelector('[data-widget="stats"]').hidden);
    assert.deepEqual(await box('stats'), statsBefore);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => !tagdatimer.layoutEditor.active);
    assert.equal(await page.locator('#timer-core #timer-ao5').count(), 1);
    assert.equal(await page.locator('#sidebar #panel-times').count(), 1);
    await page.keyboard.press('Space'); await page.waitForTimeout(550); await page.keyboard.press('Space');
    await page.waitForFunction(() => tagdatimer.solves.length === 15);
    await page.setViewportSize({ width: 1000, height: 850 });
    await page.waitForFunction(() => tagdatimer.layoutEditor.active && tagdatimer.settings.widgetLayouts.tablet);
    const toolbarRect = await page.locator('#layout-toolbar').boundingBox();
    assert.ok(toolbarRect.x >= 0 && toolbarRect.x + toolbarRect.width <= 1000);
    const tabletTimer = await shell('timer').boundingBox();
    assert.ok(tabletTimer.y + tabletTimer.height / 2 <= 850 * .7, 'a new tablet layout measures the settled timer position after leaving the phone');
    await page.screenshot({ path: path.join(os.tmpdir(), 'tagda-layout-tablet.png') });
    await done(); await page.setViewportSize({ width: 1440, height: 1000 });
    await page.waitForFunction(() => tagdatimer.settings.widgetLayouts.grids.desktop.columns === 178);
    assert.deepEqual(await box('timer'), desktop.timer);
    const canonical = await page.evaluate(() => structuredClone(tagdatimer.settings.widgetLayouts));
    const lockedRect = await shell('timer').boundingBox();
    for (const width of [1456, 1472, 1488, 1504, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }
    assert.deepEqual(await page.evaluate(() => tagdatimer.settings.widgetLayouts), canonical, 'window resizing never accumulates rounding in saved placements');
    assert.deepEqual(await shell('timer').boundingBox(), lockedRect);
    await page.screenshot({ path: path.join(os.tmpdir(), 'tagda-layout-locked.png') });
    console.log('PASS: hidden panels return to their saved placement; phone timing and separate tablet/desktop layouts work');

    await edit(); const custom = await box('timer');
    await page.getByRole('button', { name: 'Reset layout', exact: true }).click();
    await undo(); assert.deepEqual(await box('timer'), custom);
    await page.evaluate(() => tagdatimer.resetSettings());
    await page.waitForFunction(() => !tagdatimer.layoutEditor.active);
    assert.equal(await page.locator('#timer-core #timer-ao12').count(), 1);
    await edit();
    for (const id of ['virtual', 'smart']) {
      await page.evaluate(id => tagdatimer.setSetting('inputMode', id), id);
      await page.waitForFunction(id => !!document.querySelector(`.layout-widget[data-widget="${id}"]:not([hidden])`), id);
      await picker.selectOption(id);
      const h = Number(await height.inputValue()), min = Number(await height.getAttribute('min'));
      if (h > min) {
        await height.fill(String(h - 1));
        await page.evaluate(id => document.querySelector(id === 'virtual' ? '#vcube-wrap' : '#smart-cube-wrap').style.setProperty('--layout-test', '1'), id);
        await page.waitForTimeout(80);
        assert.equal(await height.inputValue(), String(h - 1), 'background widget updates preserve a pending dimension input');
        await height.press('Enter'); assert.equal((await box(id)).h, h - 1);
      }
    }
    await page.evaluate(() => {
      const panel = document.createElement('section'); panel.id = 'panel-race'; panel.className = 'panel';
      panel.dataset.tile = 'race'; panel.dataset.dock = 'right';
      panel.innerHTML = '<div class="panel-head">Race preview</div><p>Local layout test</p>';
      document.querySelector('#sidebar-right').append(panel);
      tagdatimer.setSetting('metroOpen', true); document.querySelector('#brand').click();
    });
    for (const id of ['race', 'metronome', 'mascot']) {
      await page.waitForFunction(id => !!document.querySelector(`.layout-widget[data-widget="${id}"]:not([hidden])`), id);
      await picker.selectOption(id); const h = Number(await height.inputValue());
      await height.fill(String(h - 1)); await height.press('Enter'); assert.equal((await box(id)).h, h - 1);
    }
    console.log('PASS: resets restore the page; virtual/smart cubes, race, metronome and mascot join the editor');

    await page.locator('#layout-viewport').evaluate(n => { n.scrollTop = 0; });
    const grip = shell('timer').locator('.layout-move');
    await grip.scrollIntoViewIfNeeded();
    const viewport = await page.locator('#layout-viewport').boundingBox(), gripRect = await grip.boundingBox();
    const beforeScroll = await box('timer');
    await drag(grip, 0, viewport.y + viewport.height - 3 - gripRect.y - gripRect.height / 2, false);
    const scrollBefore = await page.locator('#layout-viewport').evaluate(n => n.scrollTop);
    await page.waitForTimeout(160);
    assert.ok(await page.locator('#layout-viewport').evaluate(n => n.scrollTop) > scrollBefore);
    await page.evaluate(() => window.dispatchEvent(new Event('blur'))); await page.mouse.up();
    assert.deepEqual(await box('timer'), beforeScroll);

    await page.setViewportSize({ width: 861, height: 650 });
    await page.waitForFunction(() => tagdatimer.layoutEditor.editing
      && Math.abs(parseFloat(document.querySelector('#layout-canvas').style.getPropertyValue('--layout-column')) - 845 / 105) < .01);
    const boundaryToolbar = await page.locator('#layout-toolbar').boundingBox();
    assert.ok(boundaryToolbar.x >= 0 && boundaryToolbar.x + boundaryToolbar.width <= 862);
    const valid = await page.evaluate(async () => {
      const { overlaps } = await import('/js/layout-grid.js');
      const boxes = [...document.querySelectorAll('.layout-widget:not([hidden])')].map(n => n.getBoundingClientRect());
      return boxes.every((a, i) => boxes.slice(i + 1).every(b => !overlaps(
        { x: a.x, y: a.y, w: a.width, h: a.height }, { x: b.x, y: b.y, w: b.width, h: b.height })));
    });
    assert.equal(valid, true);
    console.log('PASS: edge dragging scrolls safely; the smallest window keeps controls reachable and widgets separated');

    const legacyContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
    await legacyContext.route('**/announcements.json*', r => r.fulfill({ body: 'null' }));
    await legacyContext.route('**/config.json*', r => r.fulfill({ body: 'null' }));
    const legacy = await legacyContext.newPage(); legacy.on('pageerror', e => errors.push(e.message));
    await legacy.goto(base); await legacy.waitForFunction(() => window.tagdatimer?.scramble?.scramble && tagdatimer.layoutEditor);
    await legacy.evaluate(() => tagdatimer.setSetting('widgetLayouts', { desktop: {
      timer: { x: 6, y: 13, w: 12, h: 8 }, scramble: { x: 6, y: 0, w: 12, h: 5 },
      times: { x: 0, y: 0, w: 5, h: 25 }, stats: { x: 19, y: 0, w: 5, h: 11 },
      cube: { x: 19, y: 25, w: 5, h: 9 },
    } }));
    assert.deepEqual(await legacy.evaluate(() => tagdatimer.settings.widgetLayouts.desktop.timer), { x: 45, y: 39, w: 89, h: 24 });
    assert.equal(await legacy.evaluate(() => tagdatimer.settings.widgetLayouts.grids.desktop.row), 8);
    await legacyContext.close();
    console.log('PASS: layouts saved with the previous grid migrate while retaining their proportions');

    const touchContext = await browser.newContext({ viewport: { width: 1000, height: 850 }, hasTouch: true, serviceWorkers: 'block' });
    await touchContext.route('**/announcements.json*', r => r.fulfill({ body: 'null' }));
    await touchContext.route('**/config.json*', r => r.fulfill({ body: 'null' }));
    const touch = await touchContext.newPage(); touch.on('pageerror', e => errors.push(e.message));
    await touch.goto(base); await touch.waitForFunction(() => window.tagdatimer?.scramble?.scramble && tagdatimer.layoutEditor);
    await touch.evaluate(() => {
      document.querySelectorAll('.an-dlg[open]').forEach(d => d.dispatchEvent(new Event('cancel', { cancelable: true })));
      for (const [k, v] of Object.entries({ inspection: false, holdTime: 0, confirmShortSolves: false, soundOnPB: false })) tagdatimer.setSetting(k, v);
      tagdatimer.layoutEditor.start();
    });
    await touch.locator('.layout-widget[data-widget="timer"]').tap();
    assert.equal(await touch.evaluate(() => tagdatimer.solves.length), 0);
    await touch.getByRole('button', { name: 'Done', exact: true }).tap();
    await touch.locator('#time-main').tap(); await touch.waitForTimeout(550);
    assert.match(await touch.locator('#timer-display').getAttribute('class'), /state-running/);
    await touch.locator('#time-main').tap(); await touch.waitForFunction(() => tagdatimer.solves.length === 1);
    await touchContext.close();
    assert.deepEqual(errors, []);
    console.log('PASS: tablet taps are safe while editing and record normally after Done; no browser runtime errors');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
