const assert = require('node:assert/strict');
const { chromium } = require(process.env.TAGDA_PLAYWRIGHT_PATH || '@playwright/test');
const base = process.argv[2] || 'http://127.0.0.1:5186';
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) throw new Error('Local QA only');

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 1000 } });
    await context.route('**/announcements.json*', route => route.fulfill({ body: 'null' }));
    await context.route('**/config.json*', route => route.fulfill({ body: 'null' }));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    await page.waitForFunction(() => window.tagdatimer?.scramble?.scramble, null, { timeout: 60000 });
    await page.evaluate(async () => {
      document.querySelectorAll('.an-dlg[open]').forEach(dialog => dialog.dispatchEvent(new Event('cancel', { cancelable: true })));
      for (const [key, value] of Object.entries({ inspection: false, holdTime: 300, confirmShortSolves: false, soundOnPB: false, motion: 'full', reduceEffects: false })) tagdatimer.setSetting(key, value);
      const { Solves } = await import('/js/db.js');
      tagdatimer.solves = [11060, 9670, 12840].map((timeMs, index) => ({
        id: `motion-fixture-${index}`, sessionId: tagdatimer.session.id,
        timeMs, penalty: 'none', createdAt: Date.now() + index,
        event: '333', scramble: tagdatimer.scramble.scramble,
      }));
      await Solves.putMany(tagdatimer.solves);
      tagdatimer.redrawCompetition();
      const node = document.querySelector('#timer-display');
      const animate = node.animate.bind(node);
      window.motionCalls = [];
      node.animate = (frames, options) => { motionCalls.push({ frames, options }); return animate(frames, options); };
    });
    assert.equal(await page.evaluate(() => tagdatimer.settings.solveAnimationSpeed), 1.75);
    const settled = () => page.waitForFunction(() => !document.querySelector('#timer-display').getAnimations().some(a => a.playState === 'running' || a.playState === 'finished'));
    const pressPenalty = async (key, penalty) => {
      await page.keyboard.press(key);
      await page.waitForFunction(value => tagdatimer.solves.at(-1)?.penalty === value && motionCalls.length > 0, penalty);
      await page.waitForTimeout(360);
      await settled();
    };
    await pressPenalty('2', '+2');
    assert.equal(await page.locator('#time-main').textContent(), '14.84');
    let calls = await page.evaluate(() => motionCalls.splice(0));
    assert.match(calls[0].frames[1].transform, /translateX\(145px\)/);
    assert.ok(Math.abs(calls[0].options.duration - 560 / 1.75 * .44) < .01);
    await pressPenalty('d', 'DNF');
    assert.equal(await page.locator('#time-main').textContent(), 'DNF');
    calls = await page.evaluate(() => motionCalls.splice(0));
    assert.match(calls[0].frames[1].transform, /translateX\(-145px\)/);
    await pressPenalty('d', 'none');
    assert.equal(await page.locator('#time-main').textContent(), '12.84');
    await page.evaluate(() => motionCalls.length = 0);
    await page.keyboard.press('Delete');
    await page.waitForFunction(() => tagdatimer.solves.length === 2 && motionCalls.length > 0);
    await page.waitForTimeout(360);
    await settled();
    assert.equal(await page.locator('#time-main').textContent(), '9.67');
    calls = await page.evaluate(() => motionCalls.splice(0));
    assert.match(calls[0].frames[1].transform, /translateY\(90px\)/);
    await page.keyboard.press('Control+z');
    await page.waitForFunction(() => tagdatimer.solves.length === 3);
    assert.equal(await page.locator('#time-main').textContent(), '12.84');
    console.log('PASS: real shortcuts, slide directions, 1.75x duration, penalty toggles, delete and undo');

    // Starting an attempt during the outgoing motion must release the clock.
    await page.keyboard.press('2');
    await page.waitForFunction(() => document.querySelector('#timer-display').getAnimations().length > 0);
    await page.keyboard.down('Space');
    assert.equal(await page.locator('#timer-display').evaluate(node => node.getAnimations().filter(animation => !(animation instanceof CSSTransition)).length), 0);
    await page.keyboard.up('Space');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(450);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(() => motionCalls.length = 0);
    await page.keyboard.press('0');
    await page.waitForFunction(() => tagdatimer.solves.at(-1).penalty === 'none' && document.querySelector('#time-penalty').textContent === '');
    assert.equal(await page.evaluate(() => motionCalls.length), 0);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.evaluate(() => tagdatimer.setSetting('motion', 'off'));
    await page.keyboard.press('d');
    await page.waitForFunction(() => document.querySelector('#time-main').textContent === 'DNF');
    assert.equal(await page.evaluate(() => motionCalls.length), 0);
    console.log('PASS: new attempt cancels motion; system reduced motion and Motion Off apply edits immediately');

    await page.locator('#btn-settings').click();
    const speedRow = page.locator('.row[data-search-label="Solve animation speed"]');
    await speedRow.waitFor();
    const slider = speedRow.locator('input');
    assert.equal(await slider.getAttribute('min'), '1');
    assert.equal(await slider.getAttribute('max'), '3');
    assert.equal(await slider.inputValue(), '1.75');
    await slider.fill('3');
    await slider.dispatchEvent('input');
    await page.waitForFunction(() => tagdatimer.settings.solveAnimationSpeed === 3);
    await page.evaluate(() => tagdatimer.persist({ immediate: true }));
    await page.reload();
    await page.waitForFunction(() => window.tagdatimer?.scramble?.scramble);
    assert.equal(await page.evaluate(() => tagdatimer.settings.solveAnimationSpeed), 3);
    assert.deepEqual(errors, []);
    console.log('PASS: Timer settings range 1–3x and persisted speed survives reload; no browser errors');

    const mobileContext = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await mobileContext.route('**/announcements.json*', route => route.fulfill({ body: 'null' }));
    await mobileContext.route('**/config.json*', route => route.fulfill({ body: 'null' }));
    const mobile = await mobileContext.newPage();
    mobile.on('pageerror', error => errors.push(error.message));
    await mobile.goto(base);
    await mobile.waitForFunction(() => window.tagdatimer?.scramble?.scramble);
    await mobile.evaluate(async () => {
      document.querySelectorAll('.an-dlg[open]').forEach(dialog => dialog.dispatchEvent(new Event('cancel', { cancelable: true })));
      for (const [key, value] of Object.entries({ inspection: false, swipeEdit: true, motion: 'full', reduceEffects: false })) tagdatimer.setSetting(key, value);
      const { Solves } = await import('/js/db.js');
      tagdatimer.solves = [9670, 12840].map((timeMs, i) => ({ id: `mobile-motion-${i}`, sessionId: tagdatimer.session.id, event: '333', timeMs, penalty: 'none', createdAt: Date.now() + i }));
      await Solves.putMany(tagdatimer.solves);
      tagdatimer.redrawCompetition();
      window.desktopMotionCount = 0;
      const node = document.querySelector('#timer-display'), animate = node.animate.bind(node);
      node.animate = (frames, options) => { if (frames.some(frame => frame.transform)) desktopMotionCount++; return animate(frames, options); };
    });
    const swipe = async (dx, dy) => {
      // Dispatch a complete touch gesture in one task, avoiding CDP latency
      // eating the 120 ms gesture handoff window on slower test machines.
      await mobile.evaluate(([dx, dy]) => {
        const target = document.querySelector('#time-main'), rect = target.getBoundingClientRect();
        const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
        for (const [type, mx, my] of [['pointerdown', 0, 0], ['pointermove', dx, dy], ['pointerup', dx, dy]]) {
          target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 77, isPrimary: true, clientX: x + mx, clientY: y + my, buttons: type === 'pointerup' ? 0 : 1 }));
        }
      }, [dx, dy]);
      await mobile.waitForTimeout(300);
    };
    await swipe(0, -100);
    assert.equal(await mobile.evaluate(() => tagdatimer.solves.at(-1).penalty), '+2');
    await swipe(0, 100);
    assert.equal(await mobile.evaluate(() => tagdatimer.solves.at(-1).penalty), 'DNF');
    await swipe(100, 0);
    assert.equal(await mobile.evaluate(() => tagdatimer.solves.at(-1).penalty), 'none');
    await swipe(-100, 0);
    assert.equal(await mobile.evaluate(() => tagdatimer.solves.length), 1);
    assert.equal(await mobile.evaluate(() => desktopMotionCount), 0);
    assert.equal(await mobile.locator('#timer-display').getAttribute('class'), 'state-idle');
    assert.deepEqual(errors, []);
    console.log('PASS: phone swipe +2, DNF, clear and delete stay idle and retain their existing gesture motion');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
