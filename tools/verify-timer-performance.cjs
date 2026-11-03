const assert = require('node:assert/strict');
const { chromium } = require(process.env.TAGDA_PLAYWRIGHT_PATH || 'playwright');
const base = process.argv[2] || 'http://localhost:5186';

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/announcements.json*', r => r.fulfill({ body: 'null' }));
    await context.route('**/config.json*', r => r.fulfill({ body: 'null' }));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(base);
    await page.waitForFunction(() => window.tagdatimer?.scramble?.scramble, null, { timeout: 60000 });
    await page.evaluate(async () => {
      document.querySelectorAll('.an-dlg[open]').forEach(d => d.dispatchEvent(new Event('cancel', { cancelable: true })));
      for (const [k, v] of Object.entries({ inspection: false, holdTime: 0, confirmShortSolves: false, soundOnPB: false })) tagdatimer.setSetting(k, v);
    });
    const client = await context.newCDPSession(page);
    await client.send('Emulation.setCPUThrottlingRate', { rate: 6 });
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Space');
      await page.waitForFunction(() => document.body.classList.contains('timing'));
      await page.waitForTimeout(150);
      await page.keyboard.down('Space');
      const stopped = await page.locator('#time-main').textContent();
      assert.equal(await page.evaluate(() => document.body.classList.contains('timing')), false);
      await page.keyboard.down('Space'); // auto-repeat while still held
      await page.waitForTimeout(200);
      assert.equal(await page.locator('#time-main').textContent(), stopped);
      await page.keyboard.up('Space');
      await page.waitForFunction(n => tagdatimer.solves.length === n, i + 1);
      await page.waitForTimeout(100);
      assert.equal(await page.locator('#time-main').textContent(), stopped);
    }
    console.log('PASS: 5 keyboard cycles at 6x CPU slowdown; result freezes on keydown and held keys never restart');
    await client.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', repeat: true, bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', key: ' ', bubbles: true }));
    });
    assert.equal(await page.evaluate(() => document.body.classList.contains('timing')), false);
    await page.evaluate(async () => {
      const fx = await import('/js/fx.js'); fx.stopConfetti(); fx.confetti(['#fff']);
    });
    assert.equal(await page.evaluate(() => document.body.classList.contains('celebrating')), true);
    await page.keyboard.press('Space');
    assert.equal(await page.evaluate(() => document.body.classList.contains('celebrating')), false);
    await page.keyboard.press('Space');
    await page.waitForFunction(() => tagdatimer.solves.length === 6);
    console.log('PASS: orphan key repeat cannot start a solve; new attempt cancels confetti');
    const result = await page.evaluate(async () => {
      const { Timer } = await import('/js/timer.js');
      const timer = new Timer({ inspection: false });
      timer.down(100); timer.up(200);
      let recorded;
      timer.addEventListener('stop', e => recorded = e.detail.timeMs);
      // Handler delivery can be arbitrarily late; measurement uses event time.
      timer.down(1434);
      timer.up(1600);
      const fx = await import('/js/fx.js');
      const raf = window.requestAnimationFrame, caf = window.cancelAnimationFrame;
      let callback, cancelled = false;
      window.requestAnimationFrame = cb => { callback = cb; return 123; };
      window.cancelAnimationFrame = () => { cancelled = true; };
      try {
        fx.stopConfetti();
        fx.confetti(['#fff']);
        const active = document.body.classList.contains('celebrating');
        callback(performance.now() + 3000);
        const ended = !document.body.classList.contains('celebrating');
        fx.confetti(['#fff']);
        const stale = callback;
        fx.stopConfetti(); stale(performance.now() + 10);
        return { recorded, active, ended, cancelled, stopped: !document.body.classList.contains('celebrating') };
      } finally { fx.stopConfetti(); window.requestAnimationFrame = raf; window.cancelAnimationFrame = caf; }
    });
    assert.deepEqual(result, { recorded: 1234, active: true, ended: true, cancelled: true, stopped: true });
    console.log('PASS: delayed input timestamps, confetti wall-clock expiry, cancellation and stale-frame cleanup');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
