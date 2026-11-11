// Run against a local static server. Uses an isolated browser profile and a
// simulated Firebase SDK; it never signs into or changes a real account.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.TAGDA_RUNTIME_MODULES
  ? join(process.env.TAGDA_RUNTIME_MODULES, 'playwright') : 'playwright');
const base = process.env.TAGDA_TEST_URL || 'http://127.0.0.1:5186';
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
  if(cloud.rejectCapture && path==='' && Object.keys(value||{}).some(p=>p.includes('/smartCubeCaptures/'))){cloud.rejectCapture=false;throw {code:'PERMISSION_DENIED'};}
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
  await page.waitForFunction(async () => (await import('/js/sync.js')).getSyncStatus().state === 'up-to-date');
  await page.evaluate(async () => {
    const db=await import('/js/db.js'), core=await import('/js/smart-cube-core.js');
    window.__capture={id:'sync-capture',solveId:'sync-capture',schemaVersion:1,revision:0,initialFacelets:core.scrambleState('R U F'),scrambleVerified:true,completeness:'complete',qualityIssues:[],annotations:[],analysisConfig:{profile:'unknown'},context:{sessionId:tagdatimer.session.id,scramble:'R U F'},connections:[{epoch:1}],...core.timeline(["F'","U'","R'"].map((move,i)=>({move,epoch:1,serial:i,cubeTimestamp:100+i*100,localTimestamp:200+i*100,receivedMonotonic:200+i*100})),null)};
    window.__solve={id:__capture.id,sessionId:tagdatimer.session.id,event:'333',mode:'wca',timeMs:200,createdAt:1,smartCube:{schemaVersion:1,captureId:__capture.id,completeness:'complete'}};
    __cloud.fail=true;await db.Solves.put(__solve,__capture);
  });
  await page.waitForFunction(async () => (await import('/js/sync.js')).getSyncStatus().pending > 0);
  const pending=await page.evaluate(async()=>({queue:await(await import('/js/db.js')).KV.get('_syncQueue'),capture:await(await import('/js/db.js')).SmartCaptures.get('sync-capture')}));
  assert.equal(pending.capture.ownerUid,'health-test-user');
  assert.ok(pending.queue.some(e=>e.updates?.['users/health-test-user/smartCubeCaptures/sync-capture']?.payload));
  await page.evaluate(async()=>{__cloud.fail=false;await(await import('/js/sync.js')).retrySync();});
  await page.waitForFunction(async () => (await import('/js/sync.js')).getSyncStatus().state === 'up-to-date');
  const atomic=await page.evaluate(()=>__cloud.sends.some(s=>s.value?.['users/health-test-user/solves/sync-capture']&&s.value?.['users/health-test-user/smartCubeCaptures/sync-capture']));assert.equal(atomic,true);
  const downloaded=await page.evaluate(async()=>{
    const db=await import('/js/db.js'),sync=await import('/js/sync.js');
    const path='users/health-test-user/smartCubeCaptures/sync-capture';
    __cloud.data[path]=__cloud.sends.findLast(s=>s.value?.[path]).value[path];
    await db.wrap((await db.tx('smartCubeCaptures','readwrite')).delete('sync-capture'));
    return (await sync.downloadSmartCapture('sync-capture')).moves.length;
  });assert.equal(downloaded,3);
  await page.evaluate(async()=>{
    const db=await import('/js/db.js'),capture=await db.SmartCaptures.get('sync-capture');
    const remote={...capture,revision:1,updatedAt:10,annotations:[{id:'remote',label:'remote',startIndex:0,endIndex:1}]};
    __cloud.data['users/health-test-user/smartCubeCaptures/sync-capture']={id:remote.id,revision:1,updatedAt:10,payload:JSON.stringify(remote)};
    __cloud.rejectCapture=true;
    await db.SmartCaptures.annotate('sync-capture',{annotations:[{id:'local',label:'local',startIndex:1,endIndex:2}]});
  });
  await page.waitForFunction(async()=>((await(await import('/js/db.js')).SmartCaptures.get('sync-capture')).annotations||[]).length===2);
  await page.waitForFunction(async () => (await import('/js/sync.js')).getSyncStatus().state === 'up-to-date');
  console.log('PASS: conflicting annotation revisions merge both annotations and preserve original evidence');
  await page.evaluate(async()=>{const auth=await import('/js/sync-auth.js');await auth.signOutUser();window.__changeAuth({uid:'other-account',email:'other@example.test'});});
  await page.waitForTimeout(1000);
  assert.equal(await page.evaluate(()=>__cloud.sends.some(s=>s.value?.['users/other-account/smartCubeCaptures/sync-capture'])),false);
  await page.evaluate(async()=>{const db=await import('/js/db.js');await db.Solves.del('sync-capture');});
  await page.waitForFunction(()=>__cloud.sends.some(s=>s.value?.['users/other-account/smartCubeDeleted/sync-capture']===true));
  const missing=await page.evaluate(async()=>await(await import('/js/sync.js')).downloadSmartCapture('sync-capture'));assert.equal(missing,null);
  assert.deepEqual(errors,[]);
  console.log('PASS: real sync entry points retain atomic offline capture uploads, claim account ownership, download pending details, isolate account switches and reject locally deleted details');
} finally { await browser.close(); }
