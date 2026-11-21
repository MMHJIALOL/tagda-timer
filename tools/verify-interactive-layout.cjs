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
    const box = id => page.evaluate(id => ({ ...tagdatimer.settings.widgetLayouts.desktop[id] }), id);
    const shell = id => page.locator(`.layout-widget[data-widget="${id}"]`);
    const step = () => page.evaluate(() => (innerWidth - 16) / 24);
    const edit = async () => {
      await page.evaluate(() => tagdatimer.layoutEditor.start());
      await page.waitForFunction(() => tagdatimer.layoutEditor.editing);
    };
    const drag = async (locator, dx, dy, release = true) => {
      const r = await locator.boundingBox();
      await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
      await page.mouse.down();
      await page.mouse.move(r.x + r.width / 2 + dx, r.y + r.height / 2 + dy, { steps: 8 });
      if (release) await page.mouse.up();
    };
    await page.goto(base); await ready();
    assert.equal(await page.evaluate(() => tagdatimer.layoutEditor.active), false);

    // Exercise the real settings entry point, rather than only its controller.
    await page.locator('#btn-theme').click();
    const row = page.locator('#drawer .row').filter({ has: page.getByText('Interactive resizing', { exact: true }) });
    await row.locator('label.switch').click();
    await page.waitForFunction(() => tagdatimer.layoutEditor.editing);
    assert.equal(await page.locator('#drawer').isVisible(), false);
    assert.equal(await page.locator('.layout-widget').count(), 10);
    console.log('PASS: settings toggle opens the editor, including four independent average widgets');

    await page.keyboard.press('Space');
    await page.keyboard.press('d');
    await page.waitForTimeout(100);
    assert.match(await page.locator('#timer-display').getAttribute('class'), /state-idle/);
    assert.equal(await page.evaluate(() => tagdatimer.solves.length), 0);

    const initialTimer = await box('timer');
    await drag(shell('timer').locator('.layout-move'), 0, -48);
    assert.equal((await box('timer')).y, initialTimer.y - 2);
    const placedTimer = await box('timer');
    await drag(shell('timer').locator('.layout-move'), -(await step()) * 5, 0, false);
    assert.equal(await page.locator('.layout-preview.invalid').isVisible(), true);
    await page.mouse.up();
    assert.deepEqual(await box('timer'), placedTimer);
    await drag(shell('timer').locator('.layout-move'), 0, 24, false);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.mouse.up();
    assert.deepEqual(await box('timer'), placedTimer);
    console.log('PASS: moves snap exactly; collisions and interrupted gestures preserve the last valid layout');

    await page.getByRole('combobox', { name: 'Widget to resize' }).selectOption('ao5');
    const width = page.getByRole('spinbutton', { name: 'Widget width in columns' });
    const height = page.getByRole('spinbutton', { name: 'Widget height in rows' });
    await width.fill('4'); await width.press('Enter');
    await height.fill('2'); await height.press('Enter');
    assert.equal((await box('ao5')).w, 4); assert.equal((await box('ao5')).h, 2);
    assert.deepEqual(await box('timer'), placedTimer);
    const aoBefore = await shell('ao5').boundingBox();
    await drag(shell('ao5').locator('.layout-resize-e'), await step(), 0);
    assert.equal((await box('ao5')).w, 5);
    const aoAfter = await shell('ao5').boundingBox();
    assert.ok(Math.abs(aoAfter.width - aoBefore.width - await step()) < 1);
    await drag(shell('ao5').locator('.layout-resize-s'), 0, 24);
    assert.equal((await box('ao5')).h, 3);
    await height.fill('8'); await height.press('Enter');
    assert.equal((await box('ao5')).h, 3, 'resize into BPA is rejected');
    await width.fill('4.5'); await width.press('Enter');
    assert.equal((await box('ao5')).w, 5, 'fractional grid units are rejected');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    assert.equal((await box('ao5')).h, 2);
    await shell('ao12').locator('.layout-move').focus();
    const ao12 = await box('ao12');
    await page.keyboard.press('Shift+ArrowDown');
    assert.equal((await box('ao12')).h, ao12.h, 'keyboard collisions are rejected too');
    await page.keyboard.press('Shift+ArrowUp');
    assert.equal((await box('ao12')).h, ao12.h - 1);
    console.log('PASS: average sizes are independent; pointer, numeric and keyboard edits share collision rules; undo works');

    // Every main widget can be resized independently, including a disconnected player.
    for (const id of ['timer', 'scramble', 'times', 'stats', 'spotify', 'cube', 'bpa', 'wpa']) {
      const before = await box(id);
      await page.getByRole('combobox', { name: 'Widget to resize' }).selectOption(id);
      const minH = Number(await height.getAttribute('min'));
      if (before.h > minH) {
        await height.fill(String(before.h - 1)); await height.press('Enter');
        assert.equal((await box(id)).h, before.h - 1, `${id} resizes`);
      }
    }
    await page.screenshot({ path: path.join(os.tmpdir(), 'tagda-layout-editor.png') });
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.waitForFunction(() => !tagdatimer.layoutEditor.editing);
    assert.equal(await page.evaluate(() => tagdatimer.layoutEditor.active), true);
    assert.equal(await shell('timer').locator('.layout-move').isVisible(), false);
    const desktop = await page.evaluate(async () => {
      await tagdatimer.persist({ immediate: true });
      return structuredClone(tagdatimer.settings.widgetLayouts.desktop);
    });
    await page.reload(); await ready();
    assert.deepEqual(await page.evaluate(() => tagdatimer.settings.widgetLayouts.desktop), desktop);
    assert.equal(await page.evaluate(() => tagdatimer.layoutEditor.active && !tagdatimer.layoutEditor.editing), true);
    console.log('PASS: every core widget resizes, Done locks the layout, and saved placements survive reload');

    // Populate real records so moved average nodes receive real renderStats updates.
    await page.evaluate(async () => {
      const { Solves } = await import('/js/db.js');
      await Solves.putMany(Array.from({ length: 12 }, (_, i) => ({
        id: `layout-check-${i}`, sessionId: tagdatimer.session.id, event: '333', mode: 'wca',
        timeMs: 10000 + i * 100, penalty: 'none', scramble: 'R U', createdAt: Date.now() + i,
      })));
      await tagdatimer.reload();
      await tagdatimer.setSetting('inspection', false);
      await tagdatimer.setSetting('confirmShortSolves', false);
      await tagdatimer.setSetting('soundOnPB', false);
    });
    await page.waitForFunction(() => !document.querySelector('[data-widget="ao12"]').hidden);
    assert.notEqual(await page.locator('#live-ao5').textContent(), '—');
    const timerRect = await shell('timer').boundingBox();
    await page.keyboard.press('Space'); await page.waitForTimeout(600);
    assert.match(await page.locator('#timer-display').getAttribute('class'), /state-running/);
    assert.deepEqual(await shell('timer').boundingBox(), timerRect, 'timer stays in place during a solve');
    await page.keyboard.press('Space');
    await page.waitForFunction(() => tagdatimer.solves.length === 13);
    console.log('PASS: moved averages update from real solves and the timer still records without shifting');

    await edit();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => !tagdatimer.layoutEditor.active);
    assert.equal(await page.locator('#layout-toolbar').isVisible(), false);
    assert.equal(await page.locator('#timer-core #timer-ao5').count(), 1);
    assert.equal(await page.locator('#sidebar #panel-times').count(), 1);
    await page.keyboard.press('Space'); await page.waitForTimeout(550);
    assert.match(await page.locator('#timer-display').getAttribute('class'), /state-running/);
    await page.keyboard.press('Space');
    await page.waitForFunction(() => tagdatimer.solves.length === 14);
    await page.setViewportSize({ width: 1000, height: 850 });
    await page.waitForFunction(() => tagdatimer.layoutEditor.active && tagdatimer.settings.widgetLayouts.tablet);
    const desktopAfter = await page.evaluate(() => tagdatimer.settings.widgetLayouts.desktop);
    assert.deepEqual(desktopAfter, desktop);
    const toolbarRect = await page.locator('#layout-toolbar').boundingBox();
    assert.ok(toolbarRect.x >= 0 && toolbarRect.x + toolbarRect.width <= 1000);
    await page.screenshot({ path: path.join(os.tmpdir(), 'tagda-layout-tablet.png') });
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.waitForFunction(() => document.querySelector('[data-widget="timer"]').offsetWidth > 600);
    assert.deepEqual(await box('timer'), desktop.timer);
    console.log('PASS: phone restores its own DOM and timing, tablet has a separate layout, desktop restores exactly');
    await page.screenshot({ path: path.join(os.tmpdir(), 'tagda-layout-locked.png') });

    await edit();
    const custom = await box('timer');
    await page.getByRole('button', { name: 'Reset layout', exact: true }).click();
    assert.notDeepEqual(await box('timer'), custom);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    assert.deepEqual(await box('timer'), custom);
    await page.evaluate(() => tagdatimer.resetSettings());
    await page.waitForFunction(() => !tagdatimer.layoutEditor.active);
    assert.equal(await page.locator('#timer-core #timer-ao12').count(), 1);
    assert.equal(await page.locator('#stage #panel-times').count(), 1);
    console.log('PASS: grid reset is undoable and Restore defaults restores the original page');

    await edit();
    for (const [input, id] of [['virtual', 'virtual'], ['smart', 'smart']]) {
      await page.evaluate(input => tagdatimer.setSetting('inputMode', input), input);
      await page.waitForFunction(id => !!tagdatimer.settings.widgetLayouts.desktop[id]
        || !!document.querySelector(`.layout-widget[data-widget="${id}"]`), id);
      await page.getByRole('combobox', { name: 'Widget to resize' }).selectOption(id);
      assert.equal(await shell(id).isVisible(), true);
      const h = Number(await height.inputValue());
      const min = Number(await height.getAttribute('min'));
      if (h > min) { await height.fill(String(h - 1)); await height.press('Enter'); }
      assert.ok(Number(await height.inputValue()) >= min);
    }
    await page.evaluate(() => {
      const panel = document.createElement('section'); panel.id = 'panel-race'; panel.className = 'panel';
      panel.dataset.tile = 'race'; panel.dataset.dock = 'right';
      panel.innerHTML = '<div class="panel-head">Race preview</div><p>Local layout test</p>';
      document.querySelector('#sidebar-right').append(panel);
    });
    await page.waitForFunction(() => !!document.querySelector('.layout-widget[data-widget="race"]'));
    await page.getByRole('combobox', { name: 'Widget to resize' }).selectOption('race');
    const raceHeight = Number(await height.inputValue());
    await height.fill(String(raceHeight - 1)); await height.press('Enter');
    assert.equal(Number(await height.inputValue()), raceHeight - 1);
    console.log('PASS: actual virtual/smart cube inputs and dynamically mounted race panels join the same resizable grid');

    await page.evaluate(() => {
      tagdatimer.setSetting('metroOpen', true);
      document.querySelector('#brand').click();
    });
    for (const id of ['metronome', 'mascot']) {
      await page.waitForFunction(id => !!document.querySelector(`.layout-widget[data-widget="${id}"]`), id);
      await page.getByRole('combobox', { name: 'Widget to resize' }).selectOption(id);
      const h = Number(await height.inputValue());
      await height.fill(String(h - 1)); await height.press('Enter');
      assert.equal(Number(await height.inputValue()), h - 1);
    }
    console.log('PASS: metronome and mascot use snapped resizing too');

    await page.getByRole('combobox', { name: 'Widget to resize' }).selectOption('timer');
    const beforeScroll = await box('timer');
    const viewport = await page.locator('#layout-viewport').boundingBox();
    const grip = shell('timer').locator('.layout-move');
    const gripRect = await grip.boundingBox();
    await drag(grip, 0, viewport.y + viewport.height - 3 - gripRect.y - gripRect.height / 2, false);
    const scrollBefore = await page.locator('#layout-viewport').evaluate(n => n.scrollTop);
    await page.waitForTimeout(160);
    assert.ok(await page.locator('#layout-viewport').evaluate(n => n.scrollTop) > scrollBefore);
    await page.evaluate(() => window.dispatchEvent(new Event('blur'))); await page.mouse.up();
    assert.deepEqual(await box('timer'), beforeScroll);
    console.log('PASS: dragging near the edge scrolls the canvas and cancelling keeps the saved layout');

    await page.setViewportSize({ width: 861, height: 650 });
    await page.waitForFunction(() => tagdatimer.layoutEditor.editing && !!tagdatimer.settings.widgetLayouts.tablet);
    const boundaryToolbar = await page.locator('#layout-toolbar').boundingBox();
    assert.ok(boundaryToolbar.x >= 0 && boundaryToolbar.x + boundaryToolbar.width <= 862);
    const valid = await page.evaluate(async () => {
      const { overlaps } = await import('/js/layout-grid.js');
      const boxes = [...document.querySelectorAll('.layout-widget:not([hidden])')].map(n => n.getBoundingClientRect());
      return boxes.every((a, i) => boxes.slice(i + 1).every(b => !overlaps(
        { x: a.x, y: a.y, w: a.width, h: a.height }, { x: b.x, y: b.y, w: b.width, h: b.height })));
    });
    assert.equal(valid, true);
    console.log('PASS: the smallest supported window keeps controls reachable and widgets separated');

    const touchContext = await browser.newContext({ viewport: { width: 1000, height: 850 }, hasTouch: true, serviceWorkers: 'block' });
    await touchContext.route('**/announcements.json*', r => r.fulfill({ body: 'null' }));
    await touchContext.route('**/config.json*', r => r.fulfill({ body: 'null' }));
    const touch = await touchContext.newPage();
    touch.on('pageerror', e => errors.push(e.message));
    await touch.goto(base);
    await touch.waitForFunction(() => window.tagdatimer?.scramble?.scramble && tagdatimer.layoutEditor);
    await touch.evaluate(() => {
      document.querySelectorAll('.an-dlg[open]').forEach(d => d.dispatchEvent(new Event('cancel', { cancelable: true })));
      for (const [k, v] of Object.entries({ inspection: false, holdTime: 0, confirmShortSolves: false, soundOnPB: false })) tagdatimer.setSetting(k, v);
      tagdatimer.layoutEditor.start();
    });
    await touch.locator('.layout-widget[data-widget="timer"]').tap();
    assert.equal(await touch.evaluate(() => tagdatimer.solves.length), 0);
    assert.match(await touch.locator('#timer-display').getAttribute('class'), /state-idle/);
    await touch.getByRole('button', { name: 'Done', exact: true }).tap();
    await touch.locator('#time-main').tap();
    await touch.waitForTimeout(550);
    assert.match(await touch.locator('#timer-display').getAttribute('class'), /state-running/);
    await touch.locator('#time-main').tap();
    await touch.waitForFunction(() => tagdatimer.solves.length === 1);
    await touchContext.close();
    console.log('PASS: tablet taps cannot start solves while editing, and start/stop normally once locked');
    assert.deepEqual(errors, []);
    console.log('PASS: no browser runtime errors');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
