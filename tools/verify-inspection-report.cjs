// Regression checks for inspection persistence. Uses disposable browser profiles.
// Run with a local serve.py URL and Playwright available via TAGDA_PLAYWRIGHT_PATH.
const assert = require('node:assert/strict');
const { chromium, firefox } = require(process.env.TAGDA_PLAYWRIGHT_PATH || 'playwright');
const base = process.argv[2] || 'http://localhost:5184';

async function test(name, engine) {
  const browser = await engine.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  // Keep public announcements out of the timing tests. No real account is used.
  await context.route('**/announcements.json*', r => r.fulfill({ contentType: 'application/json', body: 'null' }));
  await context.route('**/config.json*', r => r.fulfill({ contentType: 'application/json', body: 'null' }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const boot = async p => {
    await p.waitForFunction(() => window.tagdatimer?.scramble?.scramble, null, { timeout: 60000 });
    await p.evaluate(async () => {
      const A = await import('/js/announce.js'), C = await import('/js/config.js');
      localStorage.setItem('tdt-ann', JSON.stringify(Object.fromEntries(
        Object.entries(A.allAnnouncements(C.storedAnnouncements(), C.getConfig))
          .map(([id, a]) => [id, { v: a.version, answer: 'dismissed', shows: 100 }]))));
      document.querySelectorAll('.an-dlg[open]').forEach(d => d.dispatchEvent(new Event('cancel', { cancelable: true })));
    });
  };
  const state = p => p.evaluate(() => ({ inspection: tagdatimer.settings.inspection,
    inspecting: document.body.classList.contains('inspecting'), timing: document.body.classList.contains('timing') }));
  const save = (p, value, key = 'inspection') => p.evaluate(async ({ value, key }) => {
    const { onWrite } = await import('/js/db.js');
    await new Promise(resolve => {
      const off = onWrite('kv', ({ key: k, value: v }) => {
        if (k === 'settings' && v[key] === value) { off(); resolve(); }
      });
      tagdatimer.setSetting(key, value);
    });
  }, { value, key });
  try {
    await page.goto(base); await boot(page);
    await page.addLocatorHandler(page.locator('.an-dlg[open]'), () => page.evaluate(() =>
      document.querySelectorAll('.an-dlg[open]').forEach(d => d.dispatchEvent(new Event('cancel', { cancelable: true })))));
    await page.evaluate(() => {
      tagdatimer.setSetting('bgMode', 'solid'); tagdatimer.setSetting('confirmShortSolves', false);
      document.querySelector('#btn-settings').click();
    });
    const sw = page.locator('.row').filter({ has: page.locator('.lbl > span', { hasText: /^WCA inspection$/ }) })
      .locator('label.switch');
    await sw.click();
    assert.equal((await state(page)).inspection, false);
    await page.evaluate(async () => (await import('/js/panels.js')).closeDrawer());
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Space');
      assert.deepEqual(await state(page), { inspection: false, inspecting: false, timing: true });
      await page.waitForTimeout(60); await page.keyboard.press('Space');
      assert.equal((await state(page)).inspection, false);
    }
    console.log(name, 'PASS settings switch + 10 keyboard start/stop cycles');
    // Exercise settings changes with the flat preview; the vendored 3D scene
    // can throw while its old puzzle is being replaced during rapid switches.
    await save(page, '2D', 'cubeView');
    for (const event of ['222', '333bf', '333', '444bf', '333']) {
      await page.evaluate(event => tagdatimer.setEvent(event), event);
      await page.evaluate(() => tagdatimer.nextScramble({ clear: true }));
      assert.equal((await state(page)).inspection, false);
    }
    for (const mode of ['oll', 'wca']) {
      await page.evaluate(mode => tagdatimer.setMode(mode), mode);
      assert.equal((await state(page)).inspection, false);
    }
    const old = await page.evaluate(() => tagdatimer.session.id);
    await page.evaluate(() => tagdatimer.newSession()); await page.evaluate(id => tagdatimer.switchSession(id), old);
    await page.evaluate(() => { dispatchEvent(new Event('blur')); dispatchEvent(new Event('focus')); });
    await save(page, 'carbon', 'theme'); await page.reload(); await boot(page);
    assert.equal((await state(page)).inspection, false);
    console.log(name, 'PASS event/mode/session changes + focus + unrelated setting + reload');

    await save(page, true);
    const tab2 = await context.newPage(); await tab2.goto(base); await boot(tab2);
    assert.equal((await state(tab2)).inspection, true);
    await save(page, false); assert.equal((await state(tab2)).inspection, true);
    await save(tab2, 'ice', 'theme');
    assert.equal((await state(tab2)).inspection, false);
    await page.reload(); await boot(page);
    assert.equal((await state(page)).inspection, false);
    assert.equal(await page.evaluate(() => tagdatimer.settings.theme), 'ice');
    // A deliberate choice in that older tab can still enable inspection.
    await save(tab2, true); await page.reload(); await boot(page);
    assert.equal((await state(page)).inspection, true);
    await tab2.close();
    console.log(name, 'PASS stale-tab theme save preserves inspection; deliberate enable still works');

    for (let i = 0; i < 5; i++) {
      await save(page, true);
      await Promise.all([page.waitForEvent('load'), page.evaluate(() => {
        tagdatimer.setSetting('inspection', false); location.reload();
      })]); await boot(page);
      assert.equal((await state(page)).inspection, false);
      assert.equal(await page.evaluate(async () => (await (await import('/js/db.js')).KV.get('settings')).inspection), false);
    }
    console.log(name, 'PASS immediate reload 5/5');

    await save(page, true);
    await page.evaluate(async () => {
      const original = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function(value, ...args) {
        const request = original.call(this, value, ...args);
        if (this.name === 'kv' && args[0] === 'settings' && value.inspection === false)
          request.addEventListener('success', () => this.transaction.abort());
        return request;
      };
      try { await tagdatimer.setSetting('inspection', false); }
      finally { IDBObjectStore.prototype.put = original; }
    });
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('tagda:inspectionPending')).inspection), false);
    await page.reload(); await boot(page);
    assert.equal((await state(page)).inspection, false);
    assert.equal(await page.evaluate(() => localStorage.getItem('tagda:inspectionPending')), null);
    console.log(name, 'PASS interrupted database commit recovers inspection on reload');

    await page.evaluate(async () => {
      const { KV } = await import('/js/db.js'); const { mergeSettings } = await import('/js/sync.js');
      // Older clients have no revision; both an unversioned and older remote choice must be ignored.
      await KV.update('settings', local => mergeSettings(local, { inspection: true, theme: 'vaporwave' }));
      await KV.update('settings', local => mergeSettings(local, { inspection: true,
        inspectionUpdatedAt: local.inspectionUpdatedAt - 1 }));
    });
    assert.equal((await state(page)).inspection, false);
    await page.keyboard.press('Space'); assert.equal((await state(page)).timing, true);
    await page.keyboard.press('Space');
    await page.evaluate(async () => {
      const { KV } = await import('/js/db.js'); const { mergeSettings } = await import('/js/sync.js');
      await KV.update('settings', local => mergeSettings(local, { inspection: true,
        inspectionUpdatedAt: local.inspectionUpdatedAt + 60000 }));
    });
    assert.equal((await state(page)).inspection, true);
    await page.keyboard.press('Space'); assert.equal((await state(page)).inspecting, true);
    await page.keyboard.press('Escape');
    console.log(name, 'PASS stale remote settings ignored; newer remote inspection applied');

    await page.evaluate(async () => {
      await Promise.all([tagdatimer.setSetting('inspection', true), tagdatimer.setSetting('inspection', false),
        tagdatimer.setSetting('inspection', true), tagdatimer.setSetting('inspection', false)]);
    });
    await page.reload(); await boot(page); assert.equal((await state(page)).inspection, false);
    await page.keyboard.press('i'); assert.equal((await state(page)).inspection, true);
    await save(page, false);
    await save(page, 'obsolete', '_inspectionTestObsolete');
    await page.evaluate(() => tagdatimer.resetSettings());
    await page.waitForFunction(async () => (await (await import('/js/db.js')).KV.get('settings')).inspection === true);
    await page.reload(); await boot(page); assert.equal((await state(page)).inspection, true);
    assert.equal(await page.evaluate(() => '_inspectionTestObsolete' in tagdatimer.settings), false);
    console.log(name, 'PASS rapid toggles + I shortcut + intentional defaults reset');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
}
(async () => {
  for (const [name, engine] of [['Chromium', chromium], ['Firefox', firefox]]) {
    if (!process.env.TAGDA_QA_BROWSER || name === process.env.TAGDA_QA_BROWSER) await test(name, engine);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
