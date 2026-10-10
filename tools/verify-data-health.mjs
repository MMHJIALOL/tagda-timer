// Run against a local static server. Uses an isolated browser profile and a
// simulated Firebase SDK; it never signs into or changes a real account.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.TAGDA_RUNTIME_MODULES
  ? join(process.env.TAGDA_RUNTIME_MODULES, 'playwright') : 'playwright');
const base = process.env.TAGDA_TEST_URL || 'http://127.0.0.1:5177';
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ acceptDownloads: true, serviceWorkers: 'block' });
await context.addInitScript(() => {
  localStorage.setItem('tdt-ann', JSON.stringify({
    feedback: { v: 1, answer: 'dismissed', shows: 1 },
    'webcam-replay': { v: 1, answer: 'dismissed', shows: 1 },
  }));
});
await context.route('**/announcements.json*', route => route.fulfill({ contentType: 'application/json', body: 'null' }));
await context.route('**/config.json*', route => route.fulfill({ contentType: 'application/json', body: 'null' }));
const errors = [];
const page = await context.newPage();
page.on('pageerror', e => errors.push(e.message));
const appSdk = `export const initializeApp = () => ({}); export const getApp = () => ({});`;
const authSdk = `
const auth = { currentUser: null };
export const getAuth = () => auth;
export const browserLocalPersistence = {};
export const setPersistence = async () => {};
export function onAuthStateChanged(a, fn) { window.__changeAuth = u => { a.currentUser = u; fn(u); }; queueMicrotask(() => fn(a.currentUser)); }
export class GoogleAuthProvider {}
export const signInWithPopup = async () => { const user = { uid: 'health-test-user', email: 'health@example.test', displayName: 'Health tester' }; window.__changeAuth(user); return { user }; };
export const signOut = async () => window.__changeAuth(null);
export const getRedirectResult = async () => null;
`;
const dbSdk = `
window.__cloud = { data: {}, sends: [], gate: false, fail: false, waiting: [] };
const cloud = window.__cloud;
export const getDatabase = () => ({});
export const ref = (db, path = '') => ({ path });
const snapshot = value => ({ exists: () => value != null, val: () => value });
export const get = async target => snapshot(cloud.data[target.path] || null);
const send = async (path, value) => {
  cloud.sends.push({ path, value });
  if (cloud.fail) throw { code: 'network/unavailable' };
  if (cloud.gate) await new Promise(resolve => cloud.waiting.push(resolve));
  cloud.data[path] = value;
};
export const set = (target, value) => send(target.path, value);
export const remove = target => send(target.path, null);
export const update = (target, values) => send(target.path, values);
export const onChildAdded = () => () => {};
export const onChildChanged = () => () => {};
export const onChildRemoved = () => () => {};
export const onValue = (target, fn) => { queueMicrotask(() => fn(snapshot(null))); return () => {}; };
`;
await context.route('https://www.gstatic.com/firebasejs/**', async route => {
  const url = route.request().url();
  const body = url.endsWith('firebase-app.js') ? appSdk : url.endsWith('firebase-auth.js') ? authSdk : dbSdk;
  await route.fulfill({ contentType: 'application/javascript', body });
});
try {
  await page.goto(base);
  await page.waitForFunction(() => window.tagdatimer?.settings && window.tagdatimer?.session);
  await page.locator('#btn-settings').click();
  await page.getByRole('button', { name: 'View details', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.getElementById('drawer-title').textContent === 'Data Health');
  assert.equal(await page.locator('.account-status-dot').count(), 0);
  assert.match(await page.locator('#drawer-body').innerText(), /Cloud sync off/);
  await page.waitForFunction(() => !document.querySelector('#drawer-body').innerText.includes('Checking browser storage'));
  assert.match(await page.locator('#drawer-body').innerText(), /browser allowance|estimate unavailable/);
  await page.screenshot({ path: join(tmpdir(), 'tagda-data-health-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.querySelector('#drawer-body').scrollWidth <= document.querySelector('#drawer-body').clientWidth), true);
  await page.screenshot({ path: join(tmpdir(), 'tagda-data-health-mobile.png') });
  await page.setViewportSize({ width: 1280, height: 800 });
  for (let i = 0; i < 8; i++) {
    await page.locator('#drawer-close').click();
    await page.locator('#btn-settings').click();
    await page.getByRole('button', { name: 'View details', exact: true }).click();
  }
  await page.locator('#drawer-close').click();
  // Wire the real account UI; the provider itself is the isolated mock above.
  await page.locator('#btn-account').hover();
  await page.waitForFunction(() => !!window.__changeAuth);
  await page.locator('#btn-account').click();
  await page.waitForFunction(() => window.__cloud && window.tagdatimer);
  await page.waitForFunction(async () => (await import('/js/sync.js')).getSyncStatus().state === 'up-to-date');
  await page.evaluate(async () => {
    window.__statusTrace = [];
    (await import('/js/sync.js')).onSyncStatus(s => window.__statusTrace.push({ state: s.state, pending: s.pending, inFlight: s.inFlight }));
  });
  await page.evaluate(() => { window.__cloud.gate = true; });
  await page.evaluate(async () => {
    const { Solves } = await import('/js/db.js');
    const solve = { id: 'health-ui-solve', sessionId: window.tagdatimer.session.id, timeMs: 9999, penalty: 'none', createdAt: Date.now() };
    await Solves.put(solve);
  });
  await page.waitForFunction(async () => {
    const status = (await import('/js/sync.js')).getSyncStatus();
    return status.inFlight && status.state === 'syncing'
      && document.getElementById('btn-account').getAttribute('aria-label').includes('change');
  });
  assert.equal(await page.locator('.account-status-dot').count(), 1);
  assert.match(await page.locator('#btn-account').getAttribute('aria-label'), /change/);
  await page.locator('#btn-account').click();
  await page.getByRole('button', { name: 'View Data Health', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('drawer-title').textContent === 'Data Health');
  assert.equal(await page.getByRole('button', { name: 'Retry now', exact: true }).isDisabled(), true);
  assert.match(await page.locator('#drawer-body').innerText(), /Syncing [1-9]\d* changes?/);
  await page.evaluate(() => { window.__cloud.gate = false; window.__cloud.waiting.splice(0).forEach(fn => fn()); });
  await page.waitForFunction(async () => (await import('/js/sync.js')).getSyncStatus().state === 'up-to-date' && !document.querySelector('.account-status-dot'));
  await page.evaluate(async () => {
    window.__cloud.fail = true;
    const { Solves } = await import('/js/db.js');
    const s = await Solves.get('health-ui-solve'); s.penalty = '+2'; await Solves.put(s);
  });
  await page.waitForFunction(async () => (await import('/js/sync.js')).getSyncStatus().state === 'retrying');
  assert.equal(await page.getByRole('button', { name: 'Retry now', exact: true }).isEnabled(), true);
  await page.evaluate(() => { window.__cloud.fail = false; });
  await page.getByRole('button', { name: 'Retry now', exact: true }).click();
  await page.waitForFunction(async () => (await import('/js/sync.js')).getSyncStatus().state === 'up-to-date');
  await page.evaluate(() => window.__changeAuth(null));
  await page.waitForFunction(() => !document.querySelector('.account-status-dot'));
  assert.match(await page.locator('#drawer-body').innerText(), /Cloud sync off/);
  assert.doesNotMatch(await page.locator('#drawer-body').innerText(), /Last synced/);
  await page.locator('#drawer-close').click();
  await page.evaluate(() => {
    window.tagdatimer.setSetting('inputMode', 'manual');
    window.__originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, ...args) {
      if (this.name === 'solves') throw new DOMException('Simulated full storage', 'QuotaExceededError');
      return window.__originalPut.call(this, value, ...args);
    };
  });
  await page.locator('#manual-input').fill('12.34');
  await page.locator('#manual-add').click();
  await page.waitForFunction(() => window.tagdatimer.solves.some(s => s.timeMs === 12340));
  assert.equal(await page.locator('#local-save-warning').isVisible(), true);
  await page.evaluate(() => { IDBObjectStore.prototype.put = window.__originalPut; });
  await page.getByRole('button', { name: 'View Data Health', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#drawer').hidden && document.querySelector('#drawer-body').innerText.includes('Could not save on this device'));
  assert.match(await page.locator('#drawer-body').innerText(), /Could not save on this device/);
  assert.match(await page.locator('#drawer-body').innerText(), /Browser storage is full/);
  const failedId = await page.evaluate(() => window.tagdatimer.solves.find(s => s.timeMs === 12340).id);
  page.once('dialog', dialog => dialog.accept());
  await page.reload();
  await page.waitForFunction(id => window.tagdatimer?.solves.some(s => s.id === id), failedId);
  assert.equal(await page.locator('#local-save-warning').isVisible(), true);
  await page.getByRole('button', { name: 'View Data Health', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#drawer').hidden);
  await page.getByRole('button', { name: 'Retry local save', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#local-save-warning').hidden);
  assert.match(await page.locator('#drawer-body').innerText(), /Saved on this device/);
  console.log('Desktop/mobile UI, repeated drawer opens, account signal, acknowledgement, retry and sign-out passed.');
  console.log('Quota failure, uninterrupted manual timing, recovery after refresh and local retry passed.');
  await page.evaluate(() => localStorage.setItem('tdt-lang', 'es'));
  await page.reload();
  await page.waitForFunction(() => window.tagdatimer?.settings && window.tagdatimer?.session);
  await page.locator('#btn-settings').click();
  await page.getByRole('button', { name: 'Ver detalles', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('drawer-title').textContent === 'Estado de los datos');
  assert.match(await page.locator('#drawer-body').innerText(), /Guardado en este dispositivo/);
  assert.match(await page.locator('#drawer-body').innerText(), /Última exportación|exportación/);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#drawer').isVisible(), false);
  await page.evaluate(() => localStorage.setItem('tdt-lang', 'en'));
  console.log('Keyboard opening/closing and Spanish Data Health copy passed.');
  const probe = await context.newPage();
  await probe.route('**/__health-probe', route => route.fulfill({ contentType: 'text/html', body: '<body>Health probe</body>' }));
  await probe.route('https://www.gstatic.com/firebasejs/**', route => route.abort());
  await probe.goto(`${base}/__health-probe`);
  const authStates = await probe.evaluate(async () => {
    sessionStorage.setItem('tagda:auth:pendingRedirect', '1');
    const sync = await import('/js/sync.js');
    const before = sync.getSyncStatus().state;
    try { await sync.initSync(); } catch {}
    return { before, after: sync.getSyncStatus().state };
  });
  assert.deepEqual(authStates, { before: 'starting', after: 'unknown' });
  await probe.close();
  console.log('Unavailable account SDK reports unknown instead of cloud sync off.');
  // Run the existing browser suites, including real transaction failure checks.
  for (const file of ['test.html', 'sync-test.html']) {
    await page.goto(`${base}/${file}`);
    try {
      await page.waitForFunction(() => !document.querySelector('#summary').textContent.includes('running'), undefined, { timeout: 180000 });
    } catch (e) {
      console.log(`${file} stopped at:`, await page.locator('.run').last().innerText());
      console.log('Current failures:', await page.locator('.fail').allTextContents());
      console.log('Browser errors:', errors);
      throw e;
    }
    const summary = await page.locator('#summary').innerText();
    console.log(`${file}: ${summary}`);
    const failed = await page.locator('.fail').allTextContents();
    assert.equal(failed.length, 0, failed.join('\n'));
  }
  assert.deepEqual(errors, [], `Unhandled browser errors: ${errors.join('; ')}`);
  console.log(`Screenshots: ${join(tmpdir(), 'tagda-data-health-desktop.png')}, ${join(tmpdir(), 'tagda-data-health-mobile.png')}`);
} catch (error) {
  console.log('Drawer:', await page.locator('#drawer-title').textContent().catch(() => 'unavailable'));
  console.log('Browser errors:', errors);
  console.log('Sync status trace:', await page.evaluate(() => window.__statusTrace));
  throw error;
} finally { await browser.close(); }
