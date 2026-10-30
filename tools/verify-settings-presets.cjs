// Run against a local static server. Uses a fresh, signed-out browser context.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const base = process.env.TAGDA_QA_URL || 'http://127.0.0.1:5186';
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route(/https:\/\/.*(?:firebase|googleapis|gstatic)/, route => route.abort());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const ready = () => page.waitForFunction(() => window.tagdatimer?.scramble?.scramble, null, { timeout: 90000 });
    const open = async () => {
      await page.locator('#btn-settings').click();
      await page.locator('.settings-presets').waitFor();
    };
    const preset = () => page.locator('.settings-presets');
    await page.goto(base);
    await ready();
    await page.evaluate(async () => {
      tagdatimer.setSetting('bgMode', 'solid');
      tagdatimer.setSetting('theme', 'carbon');
      tagdatimer.setSetting('precision', 3);
      tagdatimer.setSetting('inspection', false);
      await tagdatimer.persist({ immediate: true });
    });
    const session = await page.evaluate(() => tagdatimer.settings.sessionId);
    await open();
    await preset().getByRole('textbox', { name: 'Preset name' }).fill('Practice');
    await preset().getByRole('button', { name: 'Save current settings', exact: true }).click();
    await preset().getByText('Preset saved.', { exact: true }).waitFor();
    await page.evaluate(() => tagdatimer.resetSettings());
    await page.reload();
    await ready();
    assert.equal(await page.evaluate(() => Object.values(tagdatimer.settings.settingsPresets)[0].name), 'Practice');
    await page.evaluate(async () => {
      tagdatimer.setSetting('theme', 'ice');
      tagdatimer.setSetting('precision', 1);
      tagdatimer.setSetting('inspection', true);
      await tagdatimer.persist({ immediate: true });
    });
    await open();
    await Promise.all([page.waitForEvent('load'),
      preset().getByRole('button', { name: 'Apply Practice', exact: true }).click()]);
    await ready();
    assert.deepEqual(await page.evaluate(() => ({ theme: tagdatimer.settings.theme,
      precision: tagdatimer.settings.precision, inspection: tagdatimer.settings.inspection,
      session: tagdatimer.settings.sessionId })), { theme: 'carbon', precision: 3, inspection: false, session });
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'carbon');
    console.log('PASS save, refresh, apply, reload, inspection and session preservation');
    await open();
    await page.evaluate(() => tagdatimer.setSetting('precision', 2));
    await preset().getByRole('button', { name: 'Update Practice', exact: true }).click();
    await preset().getByText('Preset updated.', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => Object.values(tagdatimer.settings.settingsPresets)[0].settings.precision), 2);
    await page.setViewportSize({ width: 390, height: 844 });
    await preset().scrollIntoViewIfNeeded();
    assert.ok(await preset().evaluate(node => node.scrollWidth <= node.clientWidth + 1), 'presets fit the phone drawer');
    await page.screenshot({ path: 'audit-qa/presets-phone.png' });
    await preset().getByRole('button', { name: 'Delete Practice', exact: true }).click();
    await preset().getByText('Preset deleted.', { exact: true }).waitFor();
    await page.reload();
    await ready();
    assert.deepEqual(await page.evaluate(() => tagdatimer.settings.settingsPresets), {});
    assert.deepEqual(errors, []);
    console.log('PASS update, mobile layout, delete persistence and no page errors');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
