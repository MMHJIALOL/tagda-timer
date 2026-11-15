// Real workbench controls and vendored renderer, with a deliberately slow
// first 3D load. Run against a local server: node tools/verify-cube-playback.cjs.
const assert = require('node:assert/strict');
const { chromium, webkit, devices } = require('@playwright/test');
const base = process.env.TAGDA_QA_URL || 'http://127.0.0.1:5186';
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) throw new Error('Local QA only');
const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="stylesheet" href="/css/fonts.css"><link rel="stylesheet" href="/css/tokens.css">
  <link rel="stylesheet" href="/css/base.css"><link rel="stylesheet" href="/css/components.css"><body>`;

async function fixture(browser, options = {}) {
  const context = await browser.newContext({ ...options, serviceWorkers: 'block' });
  // The fixture mounts the actual panels without booting other cube previews,
  // so the first renderer import really is cold. No hosted service is used.
  await context.route(/https:\/\//, r => r.abort());
  await context.route('**/cube-playback-fixture.html', r => r.fulfill({ contentType: 'text/html', body: html }));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await context.route('**/twisty-dynamic-3d-*.js', async r => { await gate; await r.continue(); });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${base}/cube-playback-fixture.html`);
  return { context, page, release, errors };
}

async function open(page, panel, moves = '') {
  await page.evaluate(async ({ panel, moves }) => {
    if (panel === 'recon') await (await import('/js/recon.js')).openRecon({ scramble: 'R U', moves });
    else await (await import('/js/xplus1.js')).openXp1({ scramble: 'R U' });
  }, { panel, moves });
  await page.waitForSelector(`#${panel} twisty-player`);
  await page.evaluate(panel => {
    const p = document.querySelector(`#${panel} twisty-player`);
    p.setAttribute('tempo-scale', '1');
    window.playCalls = 0;
    const play = p.play.bind(p);
    p.play = () => { ++window.playCalls; play(); };
  }, panel);
}

async function requestPreview(page, panel, phone) {
  if (panel === 'recon') {
    if (phone) {
      await page.locator('.rc-sug-main').first().tap();
      const play = page.getByRole('button', { name: 'Play on cube', exact: true });
      await play.tap();
      await play.tap(); // A second request supersedes the one still loading.
    } else {
      await page.locator('.rc-sug').first().hover();
      await page.waitForTimeout(200);
    }
  } else {
    if (phone) await page.locator('.xp-ph-skip').tap();
    else await page.getByRole('button', { name: 'show me  (Enter)', exact: true }).click();
    const rows = page.locator(phone ? '.xp-ph-line' : '.xp-sug');
    await rows.first().waitFor();
    if (phone) await rows.first().tap();
    else await rows.first().click();
  }
}

async function timeline(page, panel) {
  return page.evaluate(async panel => {
    const p = document.querySelector(`#${panel} twisty-player`);
    return { ...(await p.experimentalModel.detailedTimelineInfo.get()),
      playing: (await p.experimentalModel.playingInfo.get()).playing, calls: window.playCalls };
  }, panel);
}

async function movingFrames(page, panel) {
  await page.waitForFunction(async panel => {
    const p = document.querySelector(`#${panel} twisty-player`);
    const t = await p.experimentalModel.detailedTimelineInfo.get();
    return t.timestamp > 50 && t.timestamp < t.timeRange.end && (await p.experimentalModel.playingInfo.get()).playing;
  }, panel);
  const mid = await page.locator(`#${panel} twisty-player`).screenshot();
  await page.waitForFunction(async panel => {
    const m = document.querySelector(`#${panel} twisty-player`).experimentalModel;
    return (await m.detailedTimelineInfo.get()).atEnd && !(await m.playingInfo.get()).playing;
  }, panel);
  const end = await page.locator(`#${panel} twisty-player`).screenshot();
  assert(!mid.equals(end), 'the visible cube must change while its timeline plays');
}

async function coldPlayback(browser, label, options, panel, phone) {
  const { context, page, release, errors } = await fixture(browser, options);
  try {
    await open(page, panel);
    await requestPreview(page, panel, phone);
    await page.waitForTimeout(1200);
    const waiting = await timeline(page, panel);
    assert.equal(waiting.timestamp, 0, 'do not consume the animation before the renderer loads');
    assert.equal(waiting.playing, false);
    assert.equal(waiting.calls, 0);
    release();
    await movingFrames(page, panel);
    assert.equal((await timeline(page, panel)).calls, 1, 'only the latest pending preview starts');

    if (panel === 'recon' && phone) {
      // Previewing must not commit the suggested moves.
      assert.equal(await page.locator('.rc-ph-step').count(), 0);
      await page.getByRole('button', { name: 'Play on cube', exact: true }).tap();
      await movingFrames(page, panel); // Repeating the same line restarts it.
      await page.getByRole('button', { name: /^Use (this|these)/ }).tap();
      await page.locator('.rc-ph-step').first().waitFor();
      await page.getByRole('button', { name: 'Replay the whole solve', exact: true }).tap();
      await movingFrames(page, panel);
      await page.getByRole('button', { name: 'Back to the scramble', exact: true }).tap();
      assert.equal((await timeline(page, panel)).timestamp, 0);
      await page.getByRole('button', { name: 'Jump to the end', exact: true }).tap();
      assert((await timeline(page, panel)).atEnd);
    }
    assert.deepEqual(errors, []);
    console.log(`PASS ${label}: ${panel}, cold loading, visible animation and latest request`);
  } finally { release(); await context.close(); }
}

async function cancelPending(browser, panel) {
  const { context, page, release, errors } = await fixture(browser, devices['iPhone 13']);
  try {
    await open(page, panel);
    await requestPreview(page, panel, true);
    await page.evaluate(async panel => {
      if (panel === 'recon') (await import('/js/recon.js')).closeRecon();
      else (await import('/js/xplus1.js')).closeXp1();
    }, panel);
    release();
    await page.evaluate(async panel => {
      await document.querySelector(`#${panel} twisty-player`).experimentalCurrentThreeJSPuzzleObject();
    }, panel);
    await page.waitForTimeout(150);
    assert.equal((await timeline(page, panel)).calls, 0, 'closing must cancel a waiting preview');
    assert.equal((await timeline(page, panel)).playing, false);
    await open(page, panel);
    await requestPreview(page, panel, true);
    await movingFrames(page, panel);
    assert.deepEqual(errors, []);
    console.log(`PASS ${panel}: closing cancels pending playback; reopening plays normally`);
  } finally { release(); await context.close(); }
}

async function flatPlayback(browser, label) {
  const { context, page, release, errors } = await fixture(browser, devices['iPhone 13']);
  release();
  try {
    await open(page, 'recon');
    await page.getByRole('button', { name: 'Flat net', exact: true }).tap();
    await requestPreview(page, 'recon', true);
    await movingFrames(page, 'recon');
    assert.deepEqual(errors, []);
    console.log(`PASS ${label}: 2D preview still plays`);
  } finally { await context.close(); }
}

(async () => {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch({ headless: true });
    try {
      for (const panel of ['recon', 'xp1']) {
        await coldPlayback(browser, `${engine.name()} phone`, devices['iPhone 13'], panel, true);
        await coldPlayback(browser, `${engine.name()} desktop`, { viewport: { width: 1280, height: 800 } }, panel, false);
        await cancelPending(browser, panel);
        if (engine === chromium) {
          await coldPlayback(browser, 'Android touch', devices['Pixel 7'], panel, true);
          await coldPlayback(browser, 'narrow phone', { ...devices['iPhone SE'], viewport: { width: 320, height: 568 } }, panel, true);
        }
      }
      await flatPlayback(browser, engine.name());
    } finally { await browser.close(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
