import { connectGanCube, cubeTimestampLinearFit } from '../../js/gan-protocol.js';
import { SOLVED, applyTurn, validFacelets } from './cube-state.mjs';
import { GyroDiagnostics, GYRO_TEST_MS, GYRO_HOLD_START_MS, relativeQuaternion, orientationMatrix } from './gyro-test.mjs';

const $ = id => document.getElementById(id);
const COLORS = { U: '#f4f3e9', R: '#ef6554', F: '#83c975', D: '#f2d86d', L: '#edaa5f', B: '#6c9de2' };
const MAX_EVENTS = 6000;
const reportId = /^\/smart-cube\/report\/([a-f0-9]{32})$/.exec(location.pathname)?.[1];
let report = freshReport();
let connection = null;
let subscription = null;
let connecting = false;
let currentFacelets = null;
let lastSerial = null;
let gaps = 0;
let timerState = 'Idle';
let activeSolve = null;
let cloudSession = null;
let creatingSession = null;
let uploading = null;
let revision = 0;
let savedRevision = -1;
let lastGyroAt = -Infinity;
let lastGyroListAt = -Infinity;
let gyro = new GyroDiagnostics();
let gyroRenderPending = false;
let renderPending = false;
let captureStopped = false;
let lastDeviceMac = null;
let resetInProgress = false;

function freshReport() {
  return {
    schemaVersion: 1, source: 'tagda-smart-cube-test', libraryVersion: '3.0.2', testBuild: 'carry4-state-sync-1',
    startedAt: Date.now(), model: '', notes: '', hardware: {}, deviceName: '',
    browser: { userAgent: navigator.userAgent, language: navigator.language, secureContext: isSecureContext },
    capture: { gyroSampleIntervalMs: 200, gyroTestSampleIntervalMs: 20, gyroTestDurationMs: GYRO_TEST_MS, maxEvents: MAX_EVENTS, bluetoothAddressIncluded: false },
    gyro: { schemaVersion: 1, tests: [] },
    events: [], solves: [],
  };
}

function notice(message) {
  $('notice').textContent = message;
  $('notice').hidden = !message;
}

function setCloud(message, label = 'Pending', bad = false) {
  $('cloud-status').textContent = message;
  $('cloud-badge').textContent = label;
  $('cloud-badge').className = bad ? 'badge bad' : 'badge';
}

function addEvent(event, updateUI = true) {
  if (captureStopped) return;
  report.events.push({ ...event, receivedAt: Date.now(), receivedMonotonic: performance.now() });
  revision++;
  if (updateUI) scheduleRender();
  if (report.events.length >= MAX_EVENTS) {
    captureStopped = true;
    report.events.push({ type: 'CAPTURE_STOPPED', reason: 'event-limit', receivedAt: Date.now(), receivedMonotonic: performance.now() });
    interruptSolve('Capture limit reached');
    finishGyroTest('Capture limit reached');
    notice('This test reached its capture limit. Save or download the report, then choose New test to continue.');
    void disconnect();
  }
}

function scheduleRender() {
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => { renderPending = false; render(); });
}

function drawNet(facelets) {
  const stickers = $('cube-net').querySelectorAll('.sticker');
  stickers.forEach((sticker, i) => { sticker.style.backgroundColor = facelets ? COLORS[facelets[i]] : '#414936'; });
  $('cube-state').textContent = !facelets ? 'Waiting for cube state' : facelets === SOLVED ? 'Solved · state tracked' : 'Scrambled · state tracked';
}

function buildNet() {
  for (const face of 'URFDLB') {
    const element = document.createElement('div');
    element.className = `face face-${face.toLowerCase()}`;
    element.setAttribute('aria-label', `${face} face`);
    for (let i = 0; i < 9; i++) {
      const sticker = document.createElement('span');
      sticker.className = 'sticker';
      element.append(sticker);
    }
    $('cube-net').append(element);
  }
}

function render() {
  $('connection').textContent = connecting ? 'Connecting…' : connection ? 'Connected' : 'Disconnected';
  $('connection').className = connection ? 'badge on' : 'badge';
  $('connect').textContent = connection ? 'Disconnect cube' : connecting ? 'Connecting…' : 'Connect cube ↗';
  $('connect').disabled = connecting || resetInProgress || captureStopped || !navigator.bluetooth || !isSecureContext;
  $('new-test').disabled = connecting || resetInProgress;
  $('arm').disabled = !connection || !currentFacelets || currentFacelets === SOLVED || !!activeSolve || captureStopped;
  $('refresh').disabled = !connection || connecting;
  $('cancel').disabled = !activeSolve;
  $('timer-status').textContent = timerState;
  $('device').textContent = [report.model, report.hardware.hardwareName || report.deviceName].filter(Boolean).join(' · ') || '—';
  $('firmware').textContent = report.hardware.softwareVersion || '—';
  $('battery').textContent = report.batteryLevel == null ? '—' : `${report.batteryLevel}%`;
  $('gaps').textContent = gaps;
  $('event-count').textContent = report.events.length;
  const moves = activeSolve?.moves.length ?? report.solves.at(-1)?.moves.length ?? 0;
  const lastSolve = report.solves.at(-1);
  $('move-count').textContent = moves;
  $('tps').textContent = lastSolve?.durationMs > 0 && lastSolve.status === 'complete' && !activeSolve ? (lastSolve.moves.length / (lastSolve.durationMs / 1000)).toFixed(2) : '—';
  drawNet(currentFacelets);
  $('events').replaceChildren();
  for (const event of report.events.slice(-80).reverse()) {
    const row = document.createElement('div');
    row.className = 'event-row';
    const time = document.createElement('time');
    time.textContent = new Date(event.receivedAt).toLocaleTimeString([], { hour12: false });
    const type = document.createElement('b');
    type.textContent = event.type;
    const detail = document.createElement('span');
    detail.textContent = event.move || event.reason || event.message || event.hardwareName || (event.type === 'BATTERY' ? `${event.batteryLevel}%` : event.type === 'FACELETS' ? (event.facelets === SOLVED ? 'Solved state' : 'Cube state received') : event.type === 'GYRO' ? 'Orientation sample' : 'Captured');
    row.append(time, type, detail);
    $('events').append(row);
  }
  $('solve-list').replaceChildren();
  if (!report.solves.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'Your test solves will appear here.';
    $('solve-list').append(empty);
  }
  report.solves.slice(-12).reverse().forEach((solve, index) => {
    const row = document.createElement('div');
    row.className = 'solve-row';
    const label = document.createElement('strong');
    label.textContent = `#${report.solves.length - index}  ${solve.status === 'complete' ? formatTime(solve.durationMs) : 'Interrupted'}`;
    const details = document.createElement('span');
    details.textContent = solve.status === 'complete' ? `${solve.moves.length} turns · ${solve.timingMethod}` : solve.reason;
    row.append(label, details);
    $('solve-list').append(row);
  });
  renderGyro();
}

function gyroText(id, text) {
  if ($(id).textContent !== text) $(id).textContent = text;
}

function scheduleGyroRender() {
  if (gyroRenderPending) return;
  gyroRenderPending = true;
  requestAnimationFrame(() => { gyroRenderPending = false; renderGyro(); });
}

function gyroResultText(result) {
  const labels = { 'motion-observed':'Rotation observed on all three axes', 'limited-motion':'More rotation needed to observe all three axes', 'no-data':'No valid gyro data received', 'check-data':'Sensor data needs review', interrupted:'Test interrupted' };
  const hold = result.holdAssessment === 'steady' ? `Steady hold · ${result.holdMaxDeviationDegrees}° maximum deviation`
    : result.holdAssessment === 'movement-observed' ? `Movement during hold · ${result.holdMaxDeviationDegrees}° maximum deviation`
    : 'Not enough hold-still samples';
  return `${labels[result.outcome] || 'Test recorded'}. ${result.validSamples} valid samples; ${result.storedSamples} stored. ${hold}.${result.outcome === 'interrupted' ? ` ${result.reason}.` : ''}`;
}

function renderGyro() {
  const now = performance.now(), active = gyro.active;
  const summary = reportId && report.gyro?.summary ? report.gyro.summary : gyro.summary();
  const status = reportId ? (summary.validSamples ? 'Recorded gyro' : 'No gyro recorded')
    : !connection ? 'Connect a cube' : gyro.latest && now-gyro.lastAt <= 1500 ? 'Receiving'
    : gyro.supported === false && !gyro.latest ? 'Not supported' : 'Waiting for movement';
  gyroText('gyro-status', status);
  $('gyro-status').className = gyro.latest ? 'badge on' : 'badge';
  gyroText('gyro-samples', String(summary.validSamples));
  gyroText('gyro-invalid', String(summary.invalidSamples));
  const rate = !reportId && (!connection || gyro.lastAt == null || now-gyro.lastAt > 1500) ? null : summary.recentRateHz;
  gyroText('gyro-rate', !Number.isFinite(rate) ? '—' : `${rate.toFixed(1)} Hz`);
  $('start-gyro').disabled = !connection || connecting || resetInProgress || captureStopped || (gyro.supported === false && !gyro.latest);
  gyroText('start-gyro', active ? 'Stop test' : 'Start 12-second test');
  $('center-gyro').disabled = !gyro.latest || !!reportId;
  $('gyro-progress').hidden = !active;
  $('gyro-progress').value = active ? Math.min(GYRO_TEST_MS, now-active.startedMonotonic) : 0;
  let instruction = 'Connect a cube, then rotate it in your hands without turning any faces. Cubes with a gyroscope will move the preview.';
  if (reportId) instruction = 'Recorded orientation from this test. The preview shows the last saved sample relative to the first.';
  else if (active) {
    const elapsed = now-active.startedMonotonic;
    instruction = elapsed < GYRO_HOLD_START_MS
      ? `Rotate the whole cube around all three axes, without turning faces. ${Math.ceil((GYRO_HOLD_START_MS-elapsed)/1000)}s until hold still.`
      : `Hold the cube still. ${Math.max(0,Math.ceil((GYRO_TEST_MS-elapsed)/1000))}s remaining.`;
  } else if (connection && gyro.supported === false && !gyro.latest) instruction = 'This cube reports that it has no gyroscope. Face-turn tracking still works.';
  else if (connection) instruction = 'Rotate the whole cube to check the preview. Start the 12-second test: rotate for 8 seconds, then hold still for 4 seconds.';
  gyroText('gyro-help', instruction);
  const result = report.gyro?.tests?.at(-1);
  if (result) gyroText('gyro-result', gyroResultText(result));
  else if (reportId) gyroText('gyro-result', `${report.events.filter(event => event.type === 'GYRO').length} orientation samples stored. No dedicated gyro test was recorded.`);
  else gyroText('gyro-result', 'The test checks rotation on three axes, then asks you to hold still. Results and orientation samples are included in your report.');
  const q = gyro.latest;
  if (q) {
    const relative = relativeQuaternion(gyro.reference, q);
    $('gyro-cube').style.transform = `rotateX(-20deg) rotateY(-30deg) matrix3d(${orientationMatrix(relative).join(',')})`;
    gyroText('gyro-quaternion', `Normalized quaternion · w ${q.w.toFixed(4)} · x ${q.x.toFixed(4)} · y ${q.y.toFixed(4)} · z ${q.z.toFixed(4)}`);
  } else {
    $('gyro-cube').style.transform = '';
    gyroText('gyro-quaternion', 'Waiting for an orientation sample.');
  }
}

function finishGyroTest(reason = 'complete') {
  const result = gyro.finish(reason, performance.now(), Date.now());
  if (!result) return;
  report.gyro.tests.push(result);
  revision++;
  addEvent({ type:'GYRO_TEST_FINISHED', outcome:result.outcome, reason });
  scheduleRender();
  void upload();
}

function checkGyroDeadline() {
  if (gyro.active && performance.now()-gyro.active.startedMonotonic >= GYRO_TEST_MS) finishGyroTest();
}

function formatTime(ms) { return (Math.max(0, ms) / 1000).toFixed(3); }

function animateTimer() {
  if (activeSolve?.startedMonotonic != null) {
    $('timer').textContent = formatTime(performance.now() - activeSolve.startedMonotonic);
    requestAnimationFrame(animateTimer);
  }
}

function interruptSolve(reason) {
  if (!activeSolve) return;
  report.solves.push({ ...activeSolve, status: 'interrupted', reason, endedAt: Date.now() });
  activeSolve = null;
  timerState = 'Interrupted';
  revision++;
  scheduleRender();
}

function finishSolve() {
  const moves = activeSolve.moves;
  let durationMs = performance.now() - activeSolve.startedMonotonic;
  let timingMethod = 'host clock';
  if (moves.length >= 2 && moves.every(move => Number.isFinite(move.cubeTimestamp))) {
    const fitted = cubeTimestampLinearFit(moves.map(move => ({ ...move })));
    const fittedDuration = fitted.at(-1).cubeTimestamp;
    if (Number.isFinite(fittedDuration) && fittedDuration > 0) {
      durationMs = fittedDuration;
      timingMethod = 'cube clock fit';
    }
  }
  const solve = { ...activeSolve, endedAt: Date.now(), endedSerial: lastSerial, status: 'complete', durationMs, timingMethod };
  report.solves.push(solve);
  activeSolve = null;
  timerState = 'Solved';
  $('timer').textContent = formatTime(durationMs);
  addEvent({ type: 'SOLVE_FINISHED', durationMs, timingMethod });
  void upload();
}

async function requestState() {
  if (!connection) return;
  try { await connection.sendCubeCommand({ type: 'REQUEST_FACELETS' }); }
  catch (error) { addEvent({ type: 'ERROR', message: error.message }); notice('Could not read cube state. Try reconnecting.'); }
}

function onCubeEvent(event) {
  if (captureStopped) return;
  if (event.type === 'STATE_UNCERTAIN') {
    addEvent(JSON.parse(JSON.stringify(event)));
    interruptSolve(event.reason || 'Cube state mismatch');
    const last = report.solves.at(-1);
    if (last?.status === 'complete' && last.endedSerial === event.serial) {
      last.status = 'interrupted'; last.reason = event.reason || 'Cube state mismatch';
      timerState = 'Interrupted';
    }
    currentFacelets = null; lastSerial = null;
    notice('Cube state could not be confirmed. Make one slow turn and undo it, then check the sticker colours before testing again.');
    void requestState(); scheduleRender(); return;
  }
  if (event.type === 'GYRO') {
    checkGyroDeadline();
    const now = performance.now();
    gyro.sample(event, now);
    scheduleGyroRender();
    const interval = gyro.active ? 20 : 200;
    if (now - lastGyroAt < interval) return;
    lastGyroAt = now;
    const updateList = now-lastGyroListAt >= 200;
    if (updateList) lastGyroListAt = now;
    if (gyro.active) gyro.active.storedSamples++;
    addEvent(JSON.parse(JSON.stringify(event)), updateList);
    return;
  }
  // Copy every enumerable field now. JSON exports never depend on console previews.
  addEvent(JSON.parse(JSON.stringify(event)));
  if (captureStopped) return;
  if (event.type === 'HARDWARE') {
    report.hardware = { ...event };
    if (typeof event.gyroSupported === 'boolean') gyro.supported = event.gyroSupported;
  }
  if (event.type === 'BATTERY') report.batteryLevel = event.batteryLevel;
  if (event.type === 'MOVE') {
    const difference = lastSerial == null ? 1 : (event.serial - lastSerial + 256) % 256;
    if (difference === 0) {
      addEvent({ type: 'DUPLICATE_MOVE', serial: event.serial });
      return;
    }
    if (difference !== 1) {
      gaps++;
      interruptSolve('Move sequence gap');
      currentFacelets = null;
      addEvent({ type: 'SEQUENCE_GAP', previousSerial: lastSerial, serial: event.serial });
      notice('A move sequence gap was detected. This solve is interrupted while the cube state is refreshed.');
      lastSerial = event.serial;
      void requestState();
      return;
    }
    lastSerial = event.serial;
    if (!currentFacelets) return;
    try { currentFacelets = applyTurn(currentFacelets, event.move); }
    catch {
      interruptSolve('Unsupported turn');
      currentFacelets = null;
      void requestState();
      return;
    }
    if (activeSolve) {
      if (timerState === 'Armed') {
        activeSolve.startedMonotonic = performance.now();
        activeSolve.startedAt = Date.now();
        timerState = 'Running';
        requestAnimationFrame(animateTimer);
      }
      activeSolve.moves.push({ ...event });
      if (currentFacelets === SOLVED) finishSolve();
    }
  }
  if (event.type === 'FACELETS') {
    if (!validFacelets(event.facelets)) {
      addEvent({ type: 'ERROR', message: 'Invalid facelets received' });
      interruptSolve('Invalid cube state');
      currentFacelets = null;
      return;
    }
    if (currentFacelets && lastSerial === event.serial && currentFacelets !== event.facelets) {
      addEvent({ type: 'STATE_MISMATCH', expected: currentFacelets, actual: event.facelets });
      interruptSolve('Cube state mismatch');
      const lastSolve = report.solves.at(-1);
      if (lastSolve?.endedSerial === event.serial && lastSolve.status === 'complete') {
        lastSolve.status = 'interrupted';
        lastSolve.reason = 'Cube state mismatch';
      }
      notice('The reported cube state differed from the tracked turns. Check the colours before arming another solve.');
    }
    // Older snapshots may arrive after newer moves. Keep the newer tracked state.
    const age = lastSerial == null ? 0 : (lastSerial - event.serial + 256) % 256;
    if (!currentFacelets || age === 0 || age > 128) {
      if (currentFacelets && age > 128) interruptSolve('Cube state arrived ahead of tracked moves');
      currentFacelets = event.facelets;
      lastSerial = event.serial;
    }
  }
  if (event.type === 'DISCONNECT') {
    finishGyroTest('Cube disconnected');
    connection = null;
    subscription?.unsubscribe();
    subscription = null;
    currentFacelets = null;
    lastSerial = null;
    interruptSolve('Cube disconnected');
    void upload();
  }
  scheduleRender();
}

async function connect() {
  if (connection) return disconnect();
  connecting = true;
  notice('');
  render();
  try {
    const next = await connectGanCube(async (device, fallback) => {
      let address = $('mac').value.trim();
      if (!address && fallback) address = prompt('Enter the cube Bluetooth address shown in CubeStation or Chrome Bluetooth Internals. It is used only in this tab.') || '';
      if (!address) return null;
      if (!/^([a-f0-9]{2}:){5}[a-f0-9]{2}$/i.test(address)) throw new Error('Use a Bluetooth address in AA:BB:CC:DD:EE:FF format.');
      $('mac').value = address;
      return address;
    }, { diagnostics: true });
    if (lastDeviceMac && lastDeviceMac !== next.deviceMAC) {
      await next.disconnect();
      throw new Error('A different cube was selected. Choose New test before connecting the second cube.');
    }
    lastDeviceMac = next.deviceMAC;
    connection = next;
    if (next.protocolPatch) notice('i Carry 4 test build: make one slow turn and undo it. Wait for the sticker net, then check that it matches your cube.');
    report.deviceName = next.deviceName;
    report.model = $('model').value.trim() || next.deviceName || 'GAN cube';
    gyro.resetConnection();
    lastGyroAt = -Infinity;
    lastGyroListAt = -Infinity;
    subscription = next.events$.subscribe({ next: onCubeEvent, error: error => {
      addEvent({ type: 'ERROR', message: error.message });
      interruptSolve('Cube event stream failed');
      finishGyroTest('Cube event stream failed');
      notice('The cube event stream failed. Disconnect and reconnect to continue.');
    } });
    lastSerial = null;
    currentFacelets = null;
    addEvent({ type: 'CONNECTED', deviceName: next.deviceName });
    for (const type of ['REQUEST_HARDWARE', 'REQUEST_FACELETS', 'REQUEST_BATTERY']) {
      try { await next.sendCubeCommand({ type }); }
      catch (error) { addEvent({ type: 'COMMAND_ERROR', command: type, message: error.message }); }
    }
    void upload();
  } catch (error) {
    addEvent({ type: 'ERROR', message: error.message });
    notice(error.message || 'Could not connect. Wake the cube with a turn and try again.');
    void upload();
  } finally {
    connecting = false;
    render();
  }
}

async function disconnect() {
  const previous = connection;
  if (!previous) return;
  try { await previous.disconnect(); }
  catch (error) { addEvent({ type: 'ERROR', message: error.message }); }
  if (connection === previous) onCubeEvent({ type: 'DISCONNECT' });
  connection = null;
  subscription?.unsubscribe();
  subscription = null;
  currentFacelets = null;
  lastSerial = null;
  interruptSolve('Cube disconnected');
  scheduleRender();
}

async function api(path, options = {}) {
  const result = await fetch(`/smart-cube/api/${path}`, { ...options, signal: AbortSignal.timeout(20000) });
  const data = await result.json();
  if (!result.ok) throw new Error(data.error || 'Cloud request failed.');
  return data;
}

async function ensureSession() {
  if (cloudSession) return cloudSession;
  if (!creatingSession) {
    creatingSession = api('sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(session => { cloudSession = session; return session; })
      .finally(() => { creatingSession = null; });
  }
  return creatingSession;
}

function snapshot() {
  report.model = $('model').value.trim() || report.model || 'GAN cube';
  report.notes = $('notes').value;
  return JSON.stringify({ ...report, gyro:{ ...report.gyro, summary:gyro.summary(), activeTest:gyro.active ? { startedAt:gyro.active.startedAt, receivedSamples:gyro.active.receivedSamples, validSamples:gyro.active.validSamples, storedSamples:gyro.active.storedSamples } : null }, capturedAt: Date.now(), activeSolve: activeSolve ? { ...activeSolve } : null });
}

function showShare(session) {
  $('share-box').hidden = false;
  $('report-link').value = `${location.origin}/smart-cube/report/${session.id}`;
  $('expiry').textContent = `Automatically deleted ${new Date(session.expiresAt).toLocaleString()}. Autosaves keep this same expiry.`;
}

async function upload() {
  if (reportId || resetInProgress || (!report.events.length && !$('notes').value)) return;
  if (uploading) return uploading;
  uploading = (async () => {
    $('upload').disabled = true;
    setCloud('Saving the complete report to Cloudflare…', 'Saving');
    try {
      const session = await ensureSession();
      const savedVersion = revision;
      const body = snapshot();
      const saved = await api(`reports/${session.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.token}`, 'X-Report-Expires': String(session.expiresAt) },
        body,
      });
      savedRevision = savedVersion;
      showShare(session);
      setCloud(`Saved ${saved.eventCount} events at ${new Date(saved.savedAt).toLocaleTimeString()}. New events save every 30 seconds. Keep the tab open until your final save succeeds.`, 'Saved');
    } catch (error) {
      setCloud(`${error.message} You can download JSON now. Unsaved data stays in this open tab.`, 'Retry needed', true);
    } finally {
      $('upload').disabled = false;
    }
  })().finally(() => { uploading = null; });
  return uploading;
}

function download() {
  const json = reportId ? JSON.stringify(report, null, 2) : snapshot();
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `tagda-smart-cube-${new Date(report.startedAt).toISOString().replaceAll(':', '-')}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function newTest() {
  if (revision > savedRevision && report.events.length) {
    await upload();
    if (revision > savedRevision && !confirm('Some events have not reached Cloudflare. Download JSON before continuing if you need to keep them. Start a new test and clear this tab?')) return;
  }
  resetInProgress = true;
  try {
    await disconnect();
    if (uploading) await uploading;
    // Include the disconnect event in the old report before dropping its upload grant.
    resetInProgress = false;
    if (report.events.length) await upload();
    resetInProgress = true;
    if (revision > savedRevision && report.events.length && !confirm('The final save failed. Start a new test and clear this tab anyway?')) return;
    report = freshReport();
    gyro = new GyroDiagnostics();
    activeSolve = null;
    cloudSession = null;
    currentFacelets = null;
    lastSerial = null;
    lastDeviceMac = null;
    lastGyroAt = -Infinity;
    lastGyroListAt = -Infinity;
    gaps = 0;
    revision = 0;
    savedRevision = -1;
    captureStopped = false;
    timerState = 'Idle';
    for (const id of ['model', 'mac', 'notes']) $(id).value = '';
    $('timer').textContent = '0.000';
    $('share-box').hidden = true;
    setCloud('Cloud saving starts when you connect.', 'Ready');
    notice('');
  } finally {
    resetInProgress = false;
    render();
  }
}

async function loadReport() {
  for (const id of ['capture-controls', 'solve-controls', 'test-steps', 'upload', 'refresh', 'gyro-controls']) $(id).hidden = true;
  $('notes').readOnly = true;
  document.querySelector('.intro h1').textContent = 'A record of every turn.';
  document.querySelector('.lede').textContent = 'A saved smart cube test report. Download it before the deletion date shown below.';
  try {
    const stored = await api(`reports/${reportId}`);
    report = stored.report;
    gyro = new GyroDiagnostics();
    if (typeof report.hardware?.gyroSupported === 'boolean') gyro.supported = report.hardware.gyroSupported;
    for (const event of report.events) {
      if (event.type === 'GYRO') gyro.sample(event, event.receivedMonotonic ?? event.receivedAt);
    }
    $('notes').value = report.notes;
    currentFacelets = report.events.filter(event => event.type === 'FACELETS').at(-1)?.facelets || null;
    gaps = report.events.filter(event => event.type === 'SEQUENCE_GAP').length;
    timerState = 'Report';
    const latest = report.solves.filter(solve => solve.status === 'complete').at(-1);
    if (latest) $('timer').textContent = formatTime(latest.durationMs);
    render();
    showShare(stored);
    setCloud(`Saved ${report.events.length} events. Report links can take up to a minute to reflect the latest upload.`, 'Cloud report');
  } catch (error) {
    setCloud(error.message, 'Unavailable', true);
    notice(error.message);
    $('download').disabled = true;
  }
}

buildNet();
if (reportId) {
  void loadReport();
} else {
  $('connect').addEventListener('click', connect);
  $('new-test').addEventListener('click', newTest);
  $('refresh').addEventListener('click', requestState);
  $('start-gyro').addEventListener('click', () => {
    if (gyro.active) return finishGyroTest('Stopped by tester');
    if (!connection || captureStopped) return;
    gyro.start(performance.now(), Date.now());
    lastGyroAt = -Infinity;
    addEvent({ type:'GYRO_TEST_STARTED', durationMs:GYRO_TEST_MS, sampleIntervalMs:20 });
    renderGyro();
    void upload();
  });
  $('center-gyro').addEventListener('click', () => {
    if (!gyro.latest) return;
    gyro.reference = gyro.latest;
    addEvent({ type:'GYRO_VIEW_CENTERED', quaternion:{...gyro.latest} });
    renderGyro();
  });
  $('arm').addEventListener('click', () => {
    if (!connection || !currentFacelets || currentFacelets === SOLVED || activeSolve) return;
    activeSolve = { armedAt: Date.now(), initialFacelets: currentFacelets, moves: [] };
    timerState = 'Armed';
    $('timer').textContent = '0.000';
    addEvent({ type: 'SOLVE_ARMED', facelets: currentFacelets });
  });
  $('cancel').addEventListener('click', () => {
    interruptSolve('Cancelled by tester');
    addEvent({ type: 'SOLVE_CANCELLED' });
  });
  for (const id of ['model', 'notes']) $(id).addEventListener('input', () => { revision++; });
  $('upload').addEventListener('click', upload);
  addEventListener('online', () => { if (revision > savedRevision) void upload(); });
  addEventListener('beforeunload', event => {
    if (report.events.length && revision > savedRevision) { event.preventDefault(); event.returnValue = ''; }
  });
  setInterval(() => { if (report.events.length && revision > savedRevision) void upload(); }, 30000);
  setInterval(() => { checkGyroDeadline(); renderGyro(); }, 250);
  render();
  if (!isSecureContext || !navigator.bluetooth) notice('This browser does not expose Bluetooth. Open this link in desktop Chrome or Edge, or Chrome on Android.');
}
$('download').addEventListener('click', download);
$('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('report-link').value); $('copy').textContent = 'Copied'; }
  catch { $('report-link').select(); notice('Select and copy the report link from the field.'); }
});
