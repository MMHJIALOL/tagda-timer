const assert = require('node:assert/strict');
const { chromium } = require(process.env.TAGDA_PLAYWRIGHT_PATH || 'playwright');
const base = process.argv[2] || 'http://localhost:5186';

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(base);
    await page.waitForFunction(() => window.tagdatimer?.scramble?.scramble);
    await page.evaluate(async () => {
      document.querySelectorAll('.an-dlg[open]').forEach(d => d.dispatchEvent(new Event('cancel', { cancelable: true })));
      await document.fonts.ready;
      for (const [k, v] of Object.entries({ inspection: false, holdTime: 0, confirmShortSolves: false, soundOnPB: false })) await tagdatimer.setSetting(k, v);
    });
    const center = async () => {
      await page.waitForTimeout(250);
      const r = await page.locator('#timer-display').boundingBox();
      const { width, height } = page.viewportSize();
      assert.ok(Math.abs(r.x + r.width / 2 - width / 2) < 1, 'digits centered horizontally');
      assert.ok(Math.abs(r.y + r.height / 2 - height / 2) < 1, `digits centered vertically at ${width}x${height}`);
    };
    await center();
    await page.evaluate(async () => {
      for (let i = 0; i < 12; i++) await tagdatimer.recordSolve({ timeMs: 12000 + i * 317 });
      document.querySelector('#toasts').replaceChildren();
    });
    for (const [width, height] of [[390, 844], [360, 800], [375, 667], [320, 568], [430, 932]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => { document.querySelector('#app').scrollTop = 0; });
      await center();
      const layout = await page.evaluate(() => {
        const r = s => document.querySelector(s).getBoundingClientRect().toJSON();
        return { actions: r('#last-actions'), hint: r('#timer-hint'), recent: r('.ph-recent'), card: r('#scramble-zone'), tools: r('#scramble-tools'), net: r('.ph-net'), appWidth: document.querySelector('#app').scrollWidth };
      });
      assert.ok(layout.actions.height <= 45, 'action buttons fit one row');
      if (layout.hint.height) assert.ok(layout.actions.bottom <= layout.hint.top, 'actions do not overlap hint');
      assert.ok((layout.hint.height ? layout.hint.bottom : layout.actions.bottom) <= layout.recent.top, 'controls do not overlap recent solves');
      assert.ok(layout.tools.right <= layout.net.left, 'scramble buttons do not collide with preview');
      assert.ok(layout.appWidth <= width, 'no horizontal page overflow');
      await page.evaluate(() => { const a = document.querySelector('#app'); a.scrollTop = a.scrollHeight; });
      const actions = await page.locator('#last-actions').boundingBox();
      const dock = await page.locator('.ph-dock').boundingBox();
      assert.ok(actions.y >= 0 && actions.y + actions.height < dock.y, 'actions reachable above dock');
      console.log(`PASS ${width}x${height}: centered digits, no collisions, reachable controls`);
    }
    // A real touch drag on the averages scrolls, without starting an attempt.
    await page.setViewportSize({ width: 320, height: 568 });
    await page.evaluate(() => { document.querySelector('#app').scrollTop = 0; });
    await center();
    const client = await page.context().newCDPSession(page);
    const avg = await page.locator('#timer-avgs').boundingBox();
    const y = avg.y + 10;
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 160, y }] });
    for (let n = 1; n <= 8; n++) {
      await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 160, y: y - n * 16 }] });
      await page.waitForTimeout(25);
    }
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(250);
    assert.ok(await page.evaluate(() => document.querySelector('#app').scrollTop > 0), 'touch scrolling works');
    assert.equal(await page.evaluate(() => document.body.classList.contains('timing')), false);
    // Starting after scrolling still centers the running clock in the viewport.
    const digit = await page.locator('#timer-display').boundingBox();
    await page.touchscreen.tap(160, digit.y + digit.height / 2);
    await page.waitForFunction(() => document.body.classList.contains('timing'));
    await center();
    assert.equal(await page.locator('#last-actions').isVisible(), false, 'touch attempt hides solve controls');
    await page.touchscreen.tap(160, 284);
    await page.waitForFunction(() => !document.body.classList.contains('timing'));
    console.log('PASS touch scrolling and start/stop after scrolling');
    for (const tab of ['times', 'train', 'more', 'timer']) {
      await page.locator(`.ph-tab[data-tab="${tab}"]`).tap();
      assert.equal(await page.getAttribute('body', 'data-tab'), tab);
      if (tab !== 'timer') await page.locator(`#ph-${tab}`).waitFor({ state: 'visible' });
    }
    await page.locator('#ph-context').tap();
    await page.locator('.sheet:not(.closing)').waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    await page.locator('.sheet').waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => document.body.classList.contains('timing')), false);
    console.log('PASS phone tabs and event sheet');
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => document.body.classList.contains('ph')), false);
    assert.equal(await page.locator('#timer-core').evaluate(e => getComputedStyle(e).position), 'fixed');
    assert.deepEqual(errors, []);
    console.log('PASS desktop breakpoint and no JavaScript errors');

    // A phone-width in-app/desktop browser has a fine pointer. Its action row
    // must follow the same state visibility rules as a real touch phone.
    const fine = await browser.newPage({ viewport: { width: 386, height: 942 }, serviceWorkers: 'block' });
    fine.on('pageerror', e => errors.push(e.message));
    await fine.goto(base);
    await fine.waitForFunction(() => window.tagdatimer?.scramble?.scramble);
    await fine.evaluate(async () => {
      document.querySelectorAll('.an-dlg[open]').forEach(d => d.dispatchEvent(new Event('cancel', { cancelable: true })));
      for (const [k, v] of Object.entries({ inspection: false, holdTime: 0, confirmShortSolves: false, soundOnPB: false })) await tagdatimer.setSetting(k, v);
    });
    await fine.waitForTimeout(300);
    assert.equal(await fine.evaluate(() => matchMedia('(pointer: coarse)').matches), false);
    assert.equal(await fine.locator('#last-actions').isVisible(), false, 'no actions before first solve with a fine pointer');
    for (let i = 0; i < 2; i++) {
      await fine.keyboard.press('Space');
      await fine.waitForFunction(() => document.body.classList.contains('timing'));
      await fine.waitForTimeout(300);
      assert.equal(await fine.locator('#last-actions').isVisible(), false, 'fine pointer attempt hides solve controls');
      const r = await fine.locator('#timer-display').boundingBox();
      assert.ok(Math.abs(r.y + r.height / 2 - 471) < 1, 'fine pointer running digits stay centered');
      await fine.keyboard.press('Space');
      await fine.waitForFunction(n => window.tagdatimer.solves.length === n && !document.body.classList.contains('timing'), i + 1);
      await fine.waitForFunction(() => getComputedStyle(document.querySelector('#topbar')).opacity === '1');
      assert.equal(await fine.locator('#last-actions').isVisible(), true, 'finished solve restores actions');
      assert.equal(await fine.locator('#topbar').evaluate(e => getComputedStyle(e).opacity), '1', 'finished solve restores header');
      assert.equal(await fine.locator('.ph-dock').isVisible(), true, 'finished solve restores dock');
    }
    assert.deepEqual(errors, []);
    console.log('PASS phone-width fine pointer: no floating controls during solves; header, dock and actions return after stop');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
