// Run against a local static server. Uses an isolated browser profile and a
// simulated Firebase SDK; it never signs into or changes a real account.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
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
export const onValue = (target, fn) => { cloud.listeners ||= {}; cloud.listeners[target.path] = fn; queueMicrotask(() => fn(snapshot(null))); return () => { delete cloud.listeners[target.path]; }; };
`;
await context.route('https://www.gstatic.com/firebasejs/**', async route => {
  const url = route.request().url();
  const body = url.endsWith('firebase-app.js') ? appSdk : url.endsWith('firebase-auth.js') ? authSdk : dbSdk;
  await route.fulfill({ contentType: 'application/javascript', body });
});
try {
  await page.goto(base);
  await page.waitForFunction(() => window.tagdatimer?.scramble?.scramble);
  await page.evaluate(async () => (await import('/js/sync.js')).initSync());
  await page.evaluate(async () => (await import('/js/sync-auth.js')).signIn());
  await page.waitForFunction(() => !!window.__cloud?.listeners?.['users/health-test-user/settings']);
  await page.waitForFunction(async () => (await import('/js/sync.js')).getSyncStatus().state === 'up-to-date');
  await page.evaluate(async () => tagdatimer.setSetting('inspection', false));
  await page.waitForFunction(async () => (await import('/js/sync.js')).getSyncStatus().state === 'up-to-date');
  const local = await page.evaluate(() => ({ event: tagdatimer.settings.event,
    inspectionUpdatedAt: tagdatimer.settings.inspectionUpdatedAt }));
  await page.evaluate(() => {
    __cloud.sends.length = 0;
    __cloud.listeners['users/health-test-user/settings']({ exists: () => true,
      val: () => ({ inspection: true, theme: 'vaporwave', event: '222' }) });
  });
  await page.waitForFunction(() => tagdatimer.settings.theme === 'vaporwave');
  assert.equal(await page.evaluate(() => tagdatimer.settings.inspection), false);
  assert.equal(await page.evaluate(() => tagdatimer.settings.event), local.event);
  await page.waitForFunction(() => __cloud.sends.some(s => s.path === '' &&
    s.value['users/health-test-user/settings/inspection'] === false));
  await page.waitForFunction(async () => (await import('/js/sync.js')).getSyncStatus().state === 'up-to-date');
  const sends = await page.evaluate(() => __cloud.sends);
  assert.equal(sends.length, 1);
  assert.deepEqual(Object.keys(sends[0].value).sort(), [
    'users/health-test-user/settings/inspection', 'users/health-test-user/settings/inspectionUpdatedAt']);
  assert.equal(sends[0].value['users/health-test-user/settings/inspectionUpdatedAt'], local.inspectionUpdatedAt);
  console.log('PASS real sync listener rejects stale inspection and queues only its two-field correction');
  await page.evaluate(revision => {
    __cloud.sends.length = 0;
    __cloud.listeners['users/health-test-user/settings']({ exists: () => true,
      val: () => ({ inspection: true, inspectionUpdatedAt: revision + 1, theme: 'ice', event: '222' }) });
  }, local.inspectionUpdatedAt);
  await page.waitForFunction(() => tagdatimer.settings.theme === 'ice');
  assert.equal(await page.evaluate(() => tagdatimer.settings.inspection), true);
  assert.equal(await page.evaluate(() => tagdatimer.settings.event), local.event);
  await page.waitForTimeout(500);
  assert.deepEqual(await page.evaluate(() => __cloud.sends), []);
  await page.keyboard.press('Space');
  assert.equal(await page.evaluate(() => document.body.classList.contains('inspecting')), true);
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, []);
  console.log('PASS newer remote inspection reaches the timer without an upload loop');
} finally { await browser.close(); }
