// Disposable browser contexts; never reads or modifies a saved browser profile.
// Start serve.py, then run with Playwright installed (or TAGDA_PLAYWRIGHT_PATH).
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium, firefox } = require(process.env.TAGDA_PLAYWRIGHT_PATH || 'playwright');
const url = process.argv[2] || 'http://localhost:5184';
const out = process.env.TAGDA_QA_OUTPUT || path.resolve('competition-qa');

async function boot(page) {
  await page.goto(url);
  await page.waitForFunction(() => window.tagdatimer?.scramble?.scramble, { timeout: 60000 });
}
async function start(page, size = 5, recording = 'none') {
  await page.evaluate(n => tagdatimer.openCompetition(n), size);
  await page.locator('#competition-size').fill(String(size));
  await page.locator('#competition-recording').selectOption(recording);
  await page.getByRole('button', { name: `Start Ao${size}`, exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('dialog.competition-dialog'), { timeout: 45000 });
}
async function solves(page, n) {
  for (let i = 0; i < n; i++) await page.evaluate(i => tagdatimer.recordSolve({ timeMs: 10000 + i * 1000 }), i);
}
async function test(engine, name) {
  const browser = await engine.launch({ headless: true,
    ...(name === 'Chrome' ? { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] }
      : { firefoxUserPrefs: { 'media.navigator.streams.fake': true, 'media.navigator.permission.disabled': true } }) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', err => errors.push(err.message));
  try {
    await boot(page); await start(page); await solves(page, 2);
    const before = await page.evaluate(async () => (await (await import('/js/db.js')).CompetitionSets.all())[0]);
    const scramble = await page.evaluate(() => tagdatimer.scramble.scramble);
    await page.reload(); await page.waitForFunction(() => window.tagdatimer?.scramble?.scramble);
    const restored = await page.evaluate(async () => (await (await import('/js/db.js')).CompetitionSets.all())[0]);
    assert.deepEqual(restored.solveIds, before.solveIds);
    assert.equal(await page.evaluate(() => tagdatimer.scramble.scramble), scramble);
    assert.match(await page.locator('#competition-strip').innerText(), /attempt 3\/5/);
    const guards = await page.evaluate(async () => {
      const { Solves } = await import('/js/db.js');
      const s = tagdatimer.solves[0]; let one = false, batch = false;
      try { await Solves.del(s.id); } catch { one = true; }
      try { await Solves.delMany([s.id]); } catch { batch = true; }
      tagdatimer.solveMenu(s, document.querySelector('#btn-session'));
      return { one, batch, deleteMenu: document.body.textContent.includes('Delete solve') };
    });
    assert(guards.one && guards.batch); assert(!guards.deleteMenu);
    await page.keyboard.press('Escape'); await page.keyboard.press('Delete');
    assert.equal(await page.evaluate(() => tagdatimer.solves.length), 2);
    await solves(page, 3); await page.waitForSelector('.competition-dialog');
    await page.locator('.competition-attempts select').first().selectOption('+2');
    await page.waitForFunction(() => document.querySelector('.competition-attempts strong')?.textContent.includes('+2'));
    const score = await page.evaluate(async () => {
      const { CompetitionSets } = await import('/js/db.js');
      const { competitionResult } = await import('/js/competition-stats.js');
      const { averageOf, eff } = await import('/js/stats.js');
      const c = (await CompetitionSets.all())[0], ss = await CompetitionSets.members(c);
      return { actual: competitionResult(c, ss).value, expected: averageOf(ss.map(eff)), raw: ss[0].timeMs };
    });
    assert.equal(score.actual, score.expected); assert.equal(score.raw, 10000);
    await page.getByRole('button', { name: 'Share score sheet', exact: true }).click();
    await page.waitForSelector('.sh-canvas');
    await page.locator('.sh-canvas').screenshot({ path: path.join(out, `${name}-Ao5-card.png`) });
    await page.evaluate(async () => (await import('/js/sharedlg.js')).closeShare());
    const dataTests = await page.evaluate(async () => {
      const { CompetitionSets, Solves, exportAll, importAll, Tombstones } = await import('/js/db.js');
      const c = (await CompetitionSets.all())[0], ss = await CompetitionSets.members(c);
      const backup = await exportAll(); await importAll(backup); await importAll(backup);
      const duplicate = (await CompetitionSets.all()).length === 1 && (await CompetitionSets.get(c.id)).solveIds.length === 5;
      await Solves.put({ id: 'qa-ordinary', sessionId: c.sessionId, event: c.event, mode: 'wca', timeMs: 5555, penalty: 'none', createdAt: Date.now() });
      await CompetitionSets.delete(c.id);
      return { duplicate, removed: !(await CompetitionSets.get(c.id)) && !(await Solves.get(ss[0].id)),
        ordinary: !!await Solves.get('qa-ordinary'), tombstone: await Tombstones.has('competitionSets', c.id) };
    });
    assert(Object.values(dataTests).every(Boolean));
    await page.evaluate(async () => { await tagdatimer.reloadCompetitionSolves(); await tagdatimer.competitionRefresh(); });
    await start(page, 12); await solves(page, 12); await page.waitForSelector('.competition-dialog');
    await page.getByRole('button', { name: 'Share score sheet', exact: true }).click(); await page.waitForSelector('.sh-canvas');
    await page.locator('.sh-canvas').screenshot({ path: path.join(out, `${name}-Ao12-card.png`) });
    await page.evaluate(async () => (await import('/js/sharedlg.js')).closeShare());
    await page.setViewportSize({ width: 375, height: 812 }); await page.evaluate(() => tagdatimer.openCompetition());
    await page.screenshot({ path: path.join(out, `${name}-mobile-setup.png`) });
    const bounds = await page.locator('.competition-dialog').boundingBox(); assert(bounds.x >= 0 && bounds.x + bounds.width <= 376);
    await page.locator('#competition-size').fill('5.5'); assert.match(await page.locator('.competition-error').innerText(), /whole number/);
    await page.evaluate(async () => (await import('/js/competition.js')).closeCompetition());
    await page.setViewportSize({ width: 1440, height: 1000 });
    await start(page, 5, 'whole-set');
    const recorded = await page.evaluate(async () => (await (await import('/js/db.js')).CompetitionSets.all()).find(c => c.status === 'active'));
    assert.equal(recorded.replayStatus, 'recording');
    await page.waitForTimeout(2300); await solves(page, 2); await page.waitForTimeout(2300); await solves(page, 3);
    await page.waitForSelector('.competition-dialog');
    const media = await page.evaluate(async id => {
      const { loadSetReplay } = await import('/js/competition-replay.js'); const r = await loadSetReplay(id);
      const c = await (await import('/js/db.js')).CompetitionSets.get(id);
      return { bytes: r.blob.size, duration: r.meta.durationMs, status: r.meta.status, attempts: c.solveIds.length };
    }, recorded.id);
    assert.equal(media.status, 'ready'); assert(media.bytes > 0 && media.duration > 4000 && media.attempts === 5);
    const exported = await page.evaluate(async id => {
      const { CompetitionSets } = await import('/js/db.js'); const { exportSetReplay } = await import('/js/competition-replay.js');
      const c = await CompetitionSets.get(id), ss = await CompetitionSets.members(c);
      const r = await exportSetReplay(c, ss); return { size: r.blob.size, mime: r.mime };
    }, recorded.id);
    assert(exported.size > 4096); assert.match(exported.mime, /video/);
    await page.evaluate(async () => (await import('/js/competition.js')).closeCompetition());
    await start(page, 5, 'whole-set'); await page.waitForTimeout(2300); await solves(page, 1);
    await page.reload(); await page.waitForFunction(() => window.tagdatimer?.scramble?.scramble);
    const interrupted = await page.evaluate(async () => {
      const c = (await (await import('/js/db.js')).CompetitionSets.all()).find(c => c.status === 'active');
      return { status: c.replayStatus, count: c.solveIds.length };
    });
    assert.equal(interrupted.status, 'interrupted'); assert.equal(interrupted.count, 1);
    console.log(name, JSON.stringify({ ui: 'pass', data: dataTests, media, exported, reload: interrupted, errors }));
    assert.equal(errors.length, 0);
  } finally { await browser.close(); }
}
(async () => {
  await fs.mkdir(out, { recursive: true });
  for (const [engine, name] of [[chromium, 'Chrome'], [firefox, 'Firefox']]) await test(engine, name);
})().catch(e => { console.error(e); process.exitCode = 1; });
