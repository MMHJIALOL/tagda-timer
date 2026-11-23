// Generated recordings and disposable browser profiles only. Run against serve.py.
const assert = require('node:assert/strict');
const { chromium, firefox } = require('@playwright/test');
const base = process.argv[2] || 'http://localhost:5173';

async function check(name, engine, launch = {}) {
  const browser = await engine.launch({ headless: true, ...launch });
  try {
    const page = await browser.newPage({ serviceWorkers: 'block', viewport: { width: 1200, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== new URL(base).origin) return route.abort();
      if (url.pathname === '/replay-seeking-qa') return route.fulfill({ contentType: 'text/html', body: `<!doctype html>
        <link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/components.css">
        <link rel="stylesheet" href="/css/smart-cube.css"><div id="toasts"></div>` });
      return route.continue();
    });
    await page.goto(`${base}/replay-seeking-qa`);
    if (process.env.TAGDA_REPLAY_NO_RVFC) await page.evaluate(() => { delete HTMLVideoElement.prototype.requestVideoFrameCallback; });
    await page.evaluate(async () => {
      // Changing colour checks the decoded picture as well as currentTime.
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 240;
      const ctx = canvas.getContext('2d'), stream = canvas.captureStream(30);
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
      const chunks = [];
      recorder.ondataavailable = event => chunks.push(event.data);
      const done = new Promise(resolve => recorder.onstop = resolve);
      const started = performance.now();
      const draw = () => {
        const sec = (performance.now() - started) / 1000;
        ctx.fillStyle = `rgb(${Math.min(240, Math.floor(sec * 50))},50,100)`;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        if (sec < 4) requestAnimationFrame(draw); else recorder.stop();
      };
      recorder.start(); draw(); await done; stream.getTracks().forEach(track => track.stop());
      window.rawClip = new Blob(chunks, { type: recorder.mimeType });
      const { openPlayer, webmFrames } = await import('/js/replay-player.js');
      const { replayStore } = await import('/js/replay-store.js');
      window.openClip = async (blob, frames) => {
        window.frameTimes = frames || webmFrames(await blob.arrayBuffer());
        if (window.reference) { URL.revokeObjectURL(reference.src); reference.remove(); }
        window.reference = document.createElement('video');
        reference.muted = true; reference.preload = 'auto';
        reference.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none';
        document.body.append(reference);
        const loaded = new Promise(resolve => reference.addEventListener('loadeddata', resolve, { once: true }));
        reference.src = URL.createObjectURL(blob); await loaded;
        const meta = { id: 'seek-test', start: 0, stop: 3000, timeMs: 3000, at: Date.now(), fps: 30, mime: blob.type, frames };
        await replayStore.run('readwrite', tr => {
          tr.objectStore('meta').put(meta);
          tr.objectStore('video').put(blob, meta.id);
        });
        await openPlayer({ id: meta.id, timeMs: 3000, penalty: 'none' });
      };
      window.picture = async () => {
        const video = document.querySelector('.rp-video'), slider = document.querySelector('.rp-seek');
        // seeked can precede presentation of the decoded image by a paint.
        await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
        const c = document.createElement('canvas'); c.width = c.height = 1;
        const ctx = c.getContext('2d'); ctx.drawImage(video, 0, 0, 1, 1, 0, 0, 1, 1);
        const red = ctx.getImageData(0, 0, 1, 1).data[0];
        const landed = new Promise(resolve => reference.addEventListener('seeked', resolve, { once: true }));
        reference.currentTime = video.currentTime; await landed;
        await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
        ctx.drawImage(reference, 0, 0, 1, 1, 0, 0, 1, 1);
        const expectedRed = ctx.getImageData(0, 0, 1, 1).data[0];
        const frame = frameTimes.findLast(time => time <= video.currentTime + 1e-4) ?? 0;
        return { time: video.currentTime, max: +slider.max, value: +slider.value, frame, red, expectedRed, paused: video.paused };
      };
    });

    for (const converted of [false, true]) {
      await page.evaluate(async converted => {
        const out = converted ? await (await import('/js/replay-media.js')).finishClip(rawClip) : null;
        if (converted && !out) throw new Error('Test browser cannot prepare the seekable recording');
        await openClip(out?.blob || rawClip, out?.frames);
      }, converted);
      await page.waitForFunction(() => document.querySelector('.rp-video')?.readyState >= 2);
      await page.locator('.rp-video').evaluate(video => video.pause());
      const slider = page.getByRole('slider', { name: 'Position in the video' });
      const waitAt = fraction => page.waitForFunction(fraction => {
        const video = document.querySelector('.rp-video'), slider = document.querySelector('.rp-seek');
        const frame = frameTimes.findLast(time => time <= video.currentTime + 1e-4) ?? 0;
        return !video.seeking && Math.abs(video.currentTime - +slider.max * fraction) < .04 && Math.abs(+slider.value - frame) < .002;
      }, fraction);
      for (const fraction of [.7, .2, .85, .4, .999, 0]) {
        const box = await slider.boundingBox();
        await page.mouse.click(box.x + 7 + (box.width - 14) * fraction, box.y + box.height / 2);
        await waitAt(fraction);
        const image = await page.evaluate(() => picture());
        assert.equal(image.paused, true, 'A paused replay stays paused after a click');
        assert.ok(Math.abs(image.red - image.expectedRed) <= 2, `Decoded frame must match the selected time: ${JSON.stringify(image)}`);
      }
      // All requests arrive before the decoder can finish the first one.
      await slider.evaluate(slider => {
        for (const fraction of [.8, .1, .9, .25, .6]) {
          slider.value = String(+slider.max * fraction);
          slider.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });
      await waitAt(.6);
      await page.locator('.rp-video').evaluate(video => video.play());
      const box = await slider.boundingBox();
      await page.mouse.move(box.x + box.width * .6, box.y + box.height / 2);
      await page.mouse.down();
      assert.equal(await page.locator('.rp-video').evaluate(video => video.paused), true, 'Playback must pause while scrubbing');
      for (const fraction of [.8, .1, .9, .2, .7, .3]) await page.mouse.move(box.x + 7 + (box.width - 14) * fraction, box.y + box.height / 2);
      await page.mouse.move(box.x + 7 + (box.width - 14) * .3, box.y + 80);
      await page.mouse.up();
      await page.waitForFunction(() => {
        const video = document.querySelector('.rp-video'), slider = document.querySelector('.rp-seek');
        return !video.paused && !video.seeking && video.currentTime >= +slider.max * .3 - .04;
      });
      await page.locator('.rp-video').evaluate(video => video.pause());
      const afterDrag = await page.evaluate(() => picture());
      assert.ok(afterDrag.time < afterDrag.max * .3 + .4, 'Resume from the last requested position after releasing outside the bar');
      // Cancellation must also release the scrub lock.
      await page.locator('.rp-video').evaluate(video => video.play());
      await slider.evaluate(slider => {
        slider.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 42 }));
        slider.value = String(+slider.max * .5); slider.dispatchEvent(new Event('input', { bubbles: true }));
        window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 42 }));
      });
      await page.waitForFunction(() => {
        const video = document.querySelector('.rp-video'); return !video.paused && !video.seeking;
      });
      await page.locator('.rp-video').evaluate(video => video.pause());
      await page.getByRole('button', { name: 'Next frame  (→)', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('.rp-video').seeking);
      assert.equal(await page.locator('.rp-video').evaluate(video => video.paused), true);
      await page.evaluate(() => document.querySelector('.replay-dlg').close());
      console.log(`${name}: PASS ${converted ? 'converted' : 'raw'} camera clicks, decoded frames, queued seeks, drag/resume, outside release, pointer cancellation and frame stepping`);
    }

    // A real 3D turn must stop rotating when a new state is selected.
    const smart = engine === chromium ? await page.evaluate(async () => {
      const { SmartPreview, faceletsTransformation } = await import('/js/smart-cube-preview.js');
      const { SOLVED, turnState } = await import('/js/smart-cube-core.js');
      const host = document.createElement('div'); document.body.append(host);
      const preview = new SmartPreview(host); preview.set(SOLVED); await preview.ready;
      if (!preview.kpuzzle) { preview.dispose(); return { supported: false }; }
      await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
      const after = turnState(SOLVED, 'R');
      preview.turn('R', SOLVED, after); preview.set(after);
      await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
      const model = preview.view.player.experimentalModel;
      const during = await model.catchUpMove.get();
      preview.set(SOLVED, { instant: true });
      await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
      const afterSeek = await model.catchUpMove.get();
      const expected = preview.kpuzzle.defaultPattern().applyTransformation(faceletsTransformation(preview.kpuzzle, SOLVED));
      const actual = await model.currentPattern.get();
      const result = { supported: true, animated: !!during.move, stopped: afterSeek.move === null, correct: actual.isIdentical(expected) };
      preview.dispose(); return result;
    }) : { supported: false };
    if (smart.supported) {
      assert.deepEqual(smart, { supported: true, animated: true, stopped: true, correct: true });
      console.log(`${name}: PASS smart-cube seek clears active rotation and restores the selected cube state`);
    } else console.log(`${name}: camera checks completed; 3D rendering checked in Chromium`);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
}

(async () => {
  await check('Chromium', chromium, { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  if (process.env.TAGDA_FIREFOX_PATH) await check('Firefox', firefox, { executablePath: process.env.TAGDA_FIREFOX_PATH });
})().catch(error => { console.error(error); process.exitCode = 1; });
