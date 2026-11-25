const assert = require('node:assert/strict');
const { chromium, firefox } = require(process.env.TAGDA_PLAYWRIGHT_PATH || '@playwright/test');
const base = process.argv[2] || 'http://localhost:5186';
const engine = process.argv[3] === 'firefox' ? firefox : chromium;

(async () => {
  const browser = await engine.launch({ headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/announcements.json*', r => r.fulfill({ body: 'null' }));
    await context.route('**/config.json*', r => r.fulfill({ body: 'null' }));
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(base);
    await page.waitForFunction(() => window.tagdatimer?.scramble?.scramble, null, { timeout: 60000 });
    await page.evaluate(async () => {
      document.querySelectorAll('.an-dlg[open]').forEach(d => d.dispatchEvent(new Event('cancel', { cancelable: true })));
      for (const [k, v] of Object.entries({ inspection: false, holdTime: 0, confirmShortSolves: false, soundOnPB: false })) tagdatimer.setSetting(k, v);
      tagdatimer.setSetting('motion', 'full');
      // Record even effects that finish before the browser assertion runs.
      window.scrambleEffects = [];
      const animate = Element.prototype.animate;
      Element.prototype.animate = function(frames, options) {
        if (this.closest('#scramble-text')) scrambleEffects.push(frames);
        return animate.call(this, frames, options);
      };
    });
    const client = engine === chromium ? await context.newCDPSession(page) : null;
    await client?.send('Emulation.setCPUThrottlingRate', { rate: 6 });
    for (let i = 0; i < 5; i++) {
      const solvedScramble = await page.evaluate(() => tagdatimer.scramble.scramble);
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
      assert.equal(await page.evaluate(() => tagdatimer.solves.at(-1).scramble), solvedScramble);
      await page.waitForTimeout(100);
      assert.equal(await page.locator('#time-main').textContent(), stopped);
    }
    console.log(`PASS (${engine.name()}): 5 keyboard cycles${client ? ' at 6x CPU slowdown' : ''}; result freezes on keydown and held keys never restart`);
    await client?.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await page.waitForFunction(() => scrambleEffects.length > 0);
    const reveal = await page.evaluate(() => {
      const panel = getComputedStyle(document.querySelector('#scramble-zone'));
      return {
        obscuresMoves: scrambleEffects.some(frames => frames.some(frame =>
          (frame.opacity !== undefined && Number(frame.opacity) < 1) ||
          (frame.filter && frame.filter !== 'none'))),
        durations: panel.transitionDuration.split(',').map(value => parseFloat(value) * 1000),
        delays: panel.transitionDelay.split(',').map(value => parseFloat(value)),
        textMatches: document.querySelector('#scramble-text').textContent === tagdatimer.scramble.scramble,
      };
    });
    assert.equal(reveal.obscuresMoves, false, 'ready scrambles must not wait behind a blur or opacity stagger');
    assert.ok(reveal.durations.every(ms => ms <= 160), 'panels must return within 160ms');
    assert.ok(reveal.delays.every(delay => delay === 0), 'panel return must start immediately');
    assert.equal(reveal.textMatches, true);
    console.log('PASS: next scramble stays readable throughout its motion, panels return without delay, and solves retain the correct scramble');
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

    await page.evaluate(async () => {
      const { Timer } = await import('/js/timer.js');
      const emit = Timer.prototype.emit;
      window.timerPerf = { stopped: [], current: null, busy: true };
      Timer.prototype.emit = function(type, detail) {
        if (type === 'start') timerPerf.current = { live: 0 };
        if (type === 'tick' && timerPerf.current) timerPerf.current.live = Math.max(timerPerf.current.live, detail.elapsed);
        if (type === 'stop' && timerPerf.current) {
          timerPerf.stopped.push({ ...timerPerf.current, recorded: detail.timeMs });
          timerPerf.current = null;
        }
        return emit.call(this, type, detail);
      };
      // Run before the timer's frame callback, like a slow background draw.
      const busyFrame = () => {
        if (!timerPerf.busy) return;
        const until = performance.now() + 35;
        while (performance.now() < until) {}
        requestAnimationFrame(busyFrame);
      };
      requestAnimationFrame(busyFrame);
    });
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Space');
      await page.waitForTimeout(100 + i * 3);
      await page.keyboard.press('Space');
      await page.waitForFunction(n => tagdatimer.solves.length === n, 7 + i);
    }
    const samples = await page.evaluate(() => { timerPerf.busy = false; return timerPerf.stopped; });
    assert.equal(samples.length, 10);
    for (const sample of samples) {
      assert.ok(Math.floor(sample.live / 10) <= Math.floor(sample.recorded / 10),
        `live display overshot: ${JSON.stringify(sample)}`);
    }
    console.log('PASS: 10 real keyboard solves with 35ms rendering stalls; live digits never exceed the final time');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
