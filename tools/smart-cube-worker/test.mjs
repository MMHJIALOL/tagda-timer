import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { handleApi, RETENTION_SECONDS, MAX_BYTES } from './api.mjs';
import { SOLVED, applyTurn } from './cube-state.mjs';
import { GyroDiagnostics, GYRO_TEST_MS, GYRO_HOLD_START_MS, normalizeQuaternion, relativeQuaternion, angularDistance, orientationMatrix } from './gyro-test.mjs';

const identity = {x:0,y:0,z:0,w:1};
const quarter = axis => ({...identity, [axis]:Math.SQRT1_2, w:Math.SQRT1_2});

test('gyro rotations preserve quaternion sign equivalence and map GAN axes into the preview', () => {
  assert.equal(normalizeQuaternion({x:0,y:0,z:0,w:0}), null);
  assert.equal(normalizeQuaternion({x:NaN,y:0,z:0,w:1}), null);
  const x = quarter('x'), opposite = Object.fromEntries(Object.entries(x).map(([key,value]) => [key,-value]));
  assert.ok(angularDistance(x, opposite) < 1e-5, 'q and -q are the same physical orientation');
  assert.ok(angularDistance(relativeQuaternion(x,x), identity) < 1e-5);
  const close = (actual, expected) => actual.forEach((value,i) => assert.ok(Math.abs(value-expected[i]) < 1e-9));
  close(orientationMatrix(identity), [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
  close(orientationMatrix(x).slice(8,11), [0,1,0]);
  close(orientationMatrix(quarter('y')).slice(4,7), [-1,0,0]);
  close(orientationMatrix(quarter('z')).slice(0,3), [0,0,-1]);
});

test('gyro diagnostics distinguish three-axis motion, stillness, invalid data, no data, and interruptions', () => {
  const gyro = new GyroDiagnostics();
  gyro.start(0,10000);
  gyro.sample({quaternion:identity},0);
  ['x','y','z'].forEach((axis,i) => gyro.sample({quaternion:quarter(axis)},1000*(i+1)));
  gyro.sample({quaternion:identity},8500);
  gyro.sample({quaternion:{x:0,y:0,z:0,w:-1}},11000);
  const complete = gyro.finish('complete',GYRO_TEST_MS,22000);
  assert.equal(complete.outcome,'motion-observed');
  assert.deepEqual(complete.axesObserved,['x','y','z']);
  assert.equal(complete.holdAssessment,'steady');
  assert.equal(complete.holdMaxDeviationDegrees,0);
  gyro.start(13000,23000);
  const noData = gyro.finish('complete',25000,35000);
  assert.equal(noData.outcome,'no-data');
  gyro.start(26000,36000);
  gyro.sample({quaternion:{x:0,y:0,z:0,w:0}},26000);
  gyro.sample({quaternion:identity},27000);
  assert.equal(gyro.finish('complete',38000,48000).outcome,'check-data');
  gyro.start(39000,49000);
  assert.equal(gyro.finish('Cube disconnected',40000,50000).outcome,'interrupted');
  assert.equal(gyro.finish('complete',41000,51000),null,'finishing is idempotent');
  gyro.resetConnection();
  assert.equal(gyro.latest,null);
  assert.equal(gyro.reference,null);
  assert.equal(gyro.rateHz,null);
});

function environment() {
  const records = new Map();
  const writes = [];
  return {
    UPLOAD_SECRET: 'test-secret-that-is-never-deployed',
    REPORTS: {
      async put(key, value, options) { records.set(key, JSON.parse(value)); writes.push({ key, options }); },
      async get(key) { return records.get(key) || null; },
    },
    records, writes,
  };
}
const ORIGIN = 'https://tagdatimer.me';
function request(path, method = 'GET', body, headers = {}) {
  return new Request(`${ORIGIN}/smart-cube/api/${path}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json', ...headers },
  });
}
function sampleReport() {
  return { schemaVersion: 1, source: 'tagda-smart-cube-test', model: 'Synthetic test', notes: '', events: [{ type: 'MOVE', move: "R'", receivedAt: Date.now(), cubeTimestamp: 100, localTimestamp: 200 }], solves: [] };
}

test('cube turns match the existing simulator across all turns and long sequences', async () => {
  let existing = await readFile(new URL('../../js/cubenet.js', import.meta.url), 'utf8');
  existing = existing.replace(/^import .*;\r?\n/gm, '');
  const { faceletsFor } = await import(`data:text/javascript;base64,${Buffer.from(`const netColors={}; const t=x=>x;\n${existing}`).toString('base64')}`);
  const moves = ['R', "U'", 'F2', 'L', 'D', "B'", 'R2', 'U', 'F', "L'", 'D2', 'B2'];
  let state = SOLVED;
  const alg = [];
  for (let i = 0; i < 120; i++) {
    const move = moves[(i * 7 + Math.floor(i / 12)) % moves.length];
    alg.push(move);
    state = applyTurn(state, move);
    const expected = faceletsFor(alg.join(' '));
    assert.equal(state, [...'URFDLB'].map(face => expected[face].flat().join('')).join(''));
  }
  for (const face of 'URFDLB') {
    assert.equal(applyTurn(applyTurn(state, face), `${face}'`), state);
    assert.equal(applyTurn(applyTurn(state, `${face}2`), `${face}2`), state);
  }
});

test('uploads preserve complete events and the fixed 7-day expiry across autosaves', async () => {
  const env = environment();
  const started = Math.floor(Date.now() / 1000) * 1000;
  const session = await (await handleApi(request('sessions', 'POST', {}), env, started)).json();
  assert.equal(RETENTION_SECONDS, 604800);
  assert.equal(session.expiresAt, started + 7 * 24 * 60 * 60 * 1000);
  const headers = { Authorization: `Bearer ${session.token}`, 'X-Report-Expires': String(session.expiresAt) };
  const body = sampleReport();
  let response = await handleApi(request(`reports/${session.id}`, 'PUT', body, headers), env, started);
  assert.equal(response.status, 200);
  body.events.push({ type: 'DISCONNECT', receivedAt: Date.now() });
  response = await handleApi(request(`reports/${session.id}`, 'PUT', body, headers), env, started + 6 * 24 * 60 * 60 * 1000);
  assert.equal(response.status, 200);
  assert.equal(env.writes[0].options.expiration, session.expiresAt / 1000);
  assert.equal(env.writes[1].options.expiration, session.expiresAt / 1000);
  const readResponse = await handleApi(request(`reports/${session.id}`), env, started + 6 * 24 * 60 * 60 * 1000);
  assert.equal(readResponse.status, 200, 'reports remain available beyond the old 24-hour limit');
  const read = await readResponse.json();
  assert.equal(read.report.events[0].move, "R'");
  assert.equal(read.report.events.length, 2);
  assert.equal(JSON.stringify(read).includes(session.token), false);
  assert.equal((await handleApi(request(`reports/${session.id}`), env, session.expiresAt)).status, 404);
  assert.equal((await handleApi(request(`reports/${session.id}`, 'PUT', body, headers), env, session.expiresAt - 59000)).status, 410);
});

test('rejects forged grants, cross-origin writes, oversized bodies, and invalid schemas', async () => {
  const env = environment();
  const session = await (await handleApi(request('sessions', 'POST', {}), env)).json();
  const headers = { Authorization: `Bearer ${session.token}`, 'X-Report-Expires': String(session.expiresAt) };
  const path = `reports/${session.id}`;
  assert.equal((await handleApi(request(path, 'PUT', sampleReport()), env)).status, 403);
  assert.equal((await handleApi(request(path, 'PUT', sampleReport(), { ...headers, 'X-Report-Expires': String(session.expiresAt + 1000) }), env)).status, 403);
  assert.equal((await handleApi(request('sessions', 'POST', {}, { Origin: 'https://other.example' }), env)).status, 403);
  assert.equal((await handleApi(request(path, 'PUT', { schemaVersion: 1 }, headers), env)).status, 400);
  assert.equal((await handleApi(request(path, 'PUT', { notes: 'x'.repeat(MAX_BYTES) }, headers), env)).status, 413);
  assert.equal(env.writes.length, 0);
});

test('normal dashboard flow connects, auto-uploads, times solves, interrupts gaps, and reconnects', async () => {
  // Reuse the main repo's existing DOM test dependency.
  const { JSDOM } = createRequire(new URL('../../package.json', import.meta.url))('jsdom');
  const html = await readFile(new URL('./public/index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: `${ORIGIN}/smart-cube`, runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const env = environment();
  const pending = [];
  let emit;
  let serial = 0;
  let physicalState = SOLVED;
  let clock = 100;
  const intervals = [];
  const fakeConnection = {
    deviceName: 'GAN-test', deviceMAC: '00:11:22:33:44:55',
    events$: { subscribe(observer) { emit = observer.next; return { unsubscribe() {} }; } },
    async sendCubeCommand(command) {
      if (command.type === 'REQUEST_FACELETS') emit({ type: 'FACELETS', serial, facelets: physicalState });
      if (command.type === 'REQUEST_HARDWARE') emit({ type: 'HARDWARE', hardwareName: 'GANi3x3s', softwareVersion: '7.76', gyroSupported:true });
      if (command.type === 'REQUEST_BATTERY') emit({ type: 'BATTERY', batteryLevel: 71 });
    },
    async disconnect() { emit({ type: 'DISCONNECT' }); },
  };
  window.__testDeps = { connectGanCube: async () => fakeConnection, cubeTimestampLinearFit: moves => moves.map((move, i) => ({ ...move, cubeTimestamp: i * 200 })), SOLVED, applyTurn, validFacelets: value => typeof value === 'string' && value.length === 54, GyroDiagnostics, GYRO_TEST_MS, GYRO_HOLD_START_MS, relativeQuaternion, orientationMatrix };
  Object.defineProperty(window.navigator, 'bluetooth', { value: {} });
  window.isSecureContext = true;
  window.fetch = (path, options) => {
    const promise = handleApi(new Request(new URL(path, ORIGIN), { ...options, headers: { ...options?.headers, Origin: ORIGIN } }), env);
    pending.push(promise);
    return promise;
  };
  window.AbortSignal = AbortSignal;
  Object.defineProperty(window.performance,'now',{value:()=>clock});
  window.setInterval = (callback,ms) => { intervals.push({callback,ms}); return intervals.length; };
  window.confirm = () => true;
  const source = (await readFile(new URL('./app.mjs', import.meta.url), 'utf8'))
    .replace(/^import .*;\r?\n/gm, '');
  window.eval(`const {connectGanCube,cubeTimestampLinearFit,SOLVED,applyTurn,validFacelets,GyroDiagnostics,GYRO_TEST_MS,GYRO_HOLD_START_MS,relativeQuaternion,orientationMatrix}=window.__testDeps;\n${source}`);
  const settle = async () => { for (let i = 0; i < 15; i++) { await Promise.all(pending.splice(0)); await new Promise(resolve => setTimeout(resolve, 5)); } };
  const click = id => window.document.getElementById(id).click();
  function turn(move, skip = false) {
    serial = (serial + (skip ? 2 : 1)) % 256;
    physicalState = applyTurn(physicalState, move);
    emit({ type: 'MOVE', serial, move, face: 'URFDLB'.indexOf(move[0]), direction: move.endsWith("'") ? 1 : 0, localTimestamp: 1000 + serial * 200, cubeTimestamp: serial * 200 });
  }
  try {
    click('connect');
    await settle();
    assert.equal(window.document.getElementById('connection').textContent, 'Connected');
    assert.equal(env.records.size, 1);
    const originalGyro = {type:'GYRO', timestamp:17, quaternion:{...identity}, velocity:{x:1,y:2,z:3}};
    emit(originalGyro);
    originalGyro.quaternion.w = 0;
    await settle();
    click('start-gyro');
    const testStart = clock;
    for (const [offset,q] of [[0,identity],[500,quarter('x')],[1000,identity],[1500,quarter('y')],[2000,identity],[2500,quarter('z')]]) {
      clock=testStart+offset;
      emit({type:'GYRO',timestamp:offset,quaternion:q,velocity:{x:1,y:2,z:3}});
    }
    for (let i=0;i<100;i++) {
      clock=testStart+3000+i*5;
      emit({type:'GYRO',timestamp:3000+i*5,quaternion:identity});
    }
    for (const offset of [8200,9000,10000,11500]) {
      clock=testStart+offset;
      emit({type:'GYRO',timestamp:offset,quaternion:identity});
    }
    clock=testStart+GYRO_TEST_MS;
    intervals.find(interval=>interval.ms===250).callback();
    await settle();
    click('upload');
    await settle();
    const gyroReport = [...env.records.values()][0].report;
    const gyroTest = gyroReport.gyro.tests[0];
    assert.equal(gyroTest.outcome,'motion-observed');
    assert.equal(gyroTest.holdAssessment,'steady');
    assert.equal(gyroTest.validSamples,110);
    assert.ok(gyroTest.storedSamples>=30 && gyroTest.storedSamples<50,'test records at 50 Hz while counting all received samples');
    assert.equal(gyroReport.events.find(event=>event.type==='GYRO').quaternion.w,1,'original sample is immutable');
    assert.deepEqual(gyroReport.events.find(event=>event.type==='GYRO').velocity,{x:1,y:2,z:3});
    assert.equal(gyroReport.capture.gyroTestSampleIntervalMs,20);
    assert.match(window.document.getElementById('gyro-result').textContent,/all three axes/);
    const savedQuaternion = {...gyroReport.gyro.summary.latestQuaternion};
    click('center-gyro');
    click('upload');
    await settle();
    assert.deepEqual([...env.records.values()][0].report.gyro.summary.latestQuaternion,savedQuaternion,'re-centering never changes sensor data');
    turn('R'); turn('U');
    await settle();
    click('arm');
    turn("U'"); turn("R'");
    await settle();
    let stored = [...env.records.values()][0];
    assert.equal(stored.report.solves[0].status, 'complete');
    assert.equal(stored.report.solves[0].moves.length, 2);
    assert.equal(stored.report.solves[0].durationMs, 200);
    assert.equal(stored.report.events.find(event => event.move === "R'").move, "R'");
    assert.equal(JSON.stringify(stored).includes(fakeConnection.deviceMAC), false);
    turn('R');
    await settle();
    click('arm');
    turn('U', true);
    await settle();
    click('upload');
    await settle();
    stored = [...env.records.values()][0];
    assert.equal(stored.report.solves[1].status, 'interrupted');
    assert.equal(stored.report.events.some(event => event.type === 'SEQUENCE_GAP'), true);
    click('start-gyro');
    click('connect');
    await settle();
    click('upload');
    await settle();
    assert.equal([...env.records.values()][0].report.gyro.tests.at(-1).outcome,'interrupted');
    click('connect');
    await settle();
    assert.equal(window.document.getElementById('connection').textContent, 'Connected');
    assert.equal(env.records.size, 1, 'reconnect keeps the same report and expiry');
    const expiry = env.writes[0].options.expiration;
    assert.ok(env.writes.every(write => write.options.expiration === expiry));
    emit({type:'HARDWARE',gyroSupported:false});
    await settle();
    assert.equal(window.document.getElementById('start-gyro').disabled,true);
    assert.equal(window.document.getElementById('gyro-status').textContent,'Not supported');
    const reportKey = [...env.records.keys()][0];
    const savedReport = env.records.get(reportKey);
    for (const legacy of [false,true]) {
      const fixture = structuredClone(savedReport);
      if (legacy) delete fixture.report.gyro;
      env.records.set(reportKey,fixture);
      const viewer = new JSDOM(html,{url:`${ORIGIN}/smart-cube/report/${fixture.id}`,runScripts:'outside-only',pretendToBeVisual:true});
      try {
        viewer.window.__testDeps=window.__testDeps;
        viewer.window.isSecureContext=true;
        viewer.window.fetch=path=>handleApi(new Request(new URL(path,ORIGIN)),env);
        viewer.window.AbortSignal=AbortSignal;
        viewer.window.eval(`const {connectGanCube,cubeTimestampLinearFit,SOLVED,applyTurn,validFacelets,GyroDiagnostics,GYRO_TEST_MS,GYRO_HOLD_START_MS,relativeQuaternion,orientationMatrix}=window.__testDeps;\n${source}`);
        for(let i=0;i<5;i++) await new Promise(resolve=>setTimeout(resolve,10));
        assert.equal(viewer.window.document.getElementById('gyro-status').textContent,'Recorded gyro');
        assert.equal(viewer.window.document.getElementById('gyro-controls').hidden,true);
        assert.match(viewer.window.document.getElementById('gyro-quaternion').textContent,/Normalized quaternion/);
        assert.match(viewer.window.document.getElementById('gyro-result').textContent,legacy ? /No dedicated gyro test/ : /Test interrupted/);
      } finally { viewer.window.close(); }
    }
    env.records.set(reportKey,savedReport);
  } finally { dom.window.close(); }
});
