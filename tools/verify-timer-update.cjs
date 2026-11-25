const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium, firefox } = require(process.env.TAGDA_PLAYWRIGHT_PATH || '@playwright/test');
const root = path.resolve(__dirname, '..');
const engine = process.argv[2] === 'firefox' ? firefox : chromium;

(async () => {
  const html = await fs.readFile(path.join(root, 'index.html'), 'utf8');
  const versionSource = await fs.readFile(path.join(root, 'js/version.js'), 'utf8');
  const version = Number(/APP_VERSION = (\d+)/.exec(versionSource)[1]);
  const versions = [...html.matchAll(/(?:src|href)="(?:js|css)\/[^\"]*\?v=(\d+)"/g)];
  assert.ok(versions.length > 0);
  assert.ok(versions.every(match => Number(match[1]) === version), 'all entry assets must use APP_VERSION');
  const previous = version - 1;
  const oldHtml = html.replaceAll(`?v=${version}`, `?v=${previous}`);
  let stage = 'old';
  const mime = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.wasm': 'application/wasm' };
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      const filename = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!filename.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
      let body = await fs.readFile(filename);
      if (pathname === '/' || pathname === '/index.html') body = stage === 'updated' ? html : oldHtml;
      if (pathname === '/js/version.js' && stage === 'old') body = versionSource.replace(`= ${version}`, `= ${previous}`);
      if (pathname === '/js/main.js') body = `window.timerDeployFixture = '${stage === 'old' ? 'old' : 'new'}';\n` + body;
      response.writeHead(200, { 'Content-Type': mime[path.extname(filename)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      response.end(body);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await engine.launch({ headless: true });
  try {
    // Service workers intentionally enabled: blocking them hid this regression.
    const context = await browser.newContext({ serviceWorkers: 'allow' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const loaded = async () => {
      await page.waitForFunction(() => window.tagdatimer?.scramble?.scramble, null, { timeout: 60000 });
      await page.evaluate(() => document.querySelectorAll('.an-dlg[open]').forEach(dialog =>
        dialog.dispatchEvent(new Event('cancel', { cancelable: true }))));
    };
    await page.goto(base);
    await loaded();
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => navigator.serviceWorker.controller);
    // Deterministically seed the returning visitor's cache, including the HTML
    // used by navigate() to decide whether to invalidate the old module graph.
    await page.evaluate(async previous => {
      const cache = await caches.open((await caches.keys()).find(name => name.startsWith('tagda-v')));
      for (const url of ['/', `/js/main.js?v=${previous}`, '/js/version.js']) {
        const response = await fetch(url);
        await cache.put(url, response);
      }
      await cache.put('/__sw-filled-at', new Response(String(Date.now())));
      const { Solves } = await import('/js/db.js');
      await Solves.put({ id: 'update-fixture', sessionId: tagdatimer.session.id, event: '333', mode: 'wca',
        scramble: tagdatimer.scramble.scramble, timeMs: 12345, penalty: 'none', createdAt: Date.now() });
    }, previous);
    stage = 'unversioned';
    await page.reload();
    await loaded();
    assert.equal(await page.evaluate(() => timerDeployFixture), 'old', 'JS-only deploy reproduces the stale-code bug');
    console.log('PASS: reproduced old code surviving a normal reload after a JS-only deploy');

    stage = 'updated';
    await page.reload();
    await loaded();
    assert.equal(await page.evaluate(() => timerDeployFixture), 'new');
    assert.equal(await page.evaluate(async () => (await import('/js/version.js')).APP_VERSION), version);
    assert.equal(await page.evaluate(() => tagdatimer.solves.some(solve => solve.id === 'update-fixture')), true);
    await page.evaluate(() => {
      for (const [key, value] of Object.entries({ inspection: false, holdTime: 0, confirmShortSolves: false, soundOnPB: false })) tagdatimer.setSetting(key, value);
    });
    const solved = await page.evaluate(() => tagdatimer.scramble.scramble);
    await page.keyboard.press('Space');
    await page.waitForFunction(() => document.body.classList.contains('timing'));
    await page.waitForTimeout(150);
    await page.keyboard.press('Space');
    await page.waitForFunction(scramble => tagdatimer.scramble.scramble !== scramble && tagdatimer.solves.length === 2, solved);
    const result = await page.evaluate(() => ({
      scramble: tagdatimer.solves.at(-1).scramble,
      children: document.querySelector('#scramble-text').children.length,
      delays: getComputedStyle(document.querySelector('#scramble-zone')).transitionDelay,
      durations: getComputedStyle(document.querySelector('#scramble-zone')).transitionDuration.split(',').map(value => parseFloat(value) * 1000),
    }));
    assert.equal(result.scramble, solved);
    assert.equal(result.children, 0, 'no staggered move reveal after the cached upgrade');
    assert.ok(result.durations.every(ms => ms <= 160));
    assert.ok(result.delays.split(',').every(value => parseFloat(value) === 0));
    console.log(`PASS (${engine.name()}): version bump replaces cached code, preserves solves, and restores instant scramble text`);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
