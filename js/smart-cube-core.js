// Original evidence is never passed to a mutating clock fitter or renderer.
import { SOLVED as CUBE_SOLVED, facelets, fromFacelets, applyAlg, analyse } from './cube3.js';
import { normalizeQuaternion, MAX_ORIENTATION_SAMPLES } from './smart-cube-gyro.js';
export const SCHEMA = 1;
export const SOLVED = facelets(CUBE_SOLVED).join('');
export const MAX_MOVES = 4000;
export const MAX_RAW = 5000;
export const MAX_BYTES = 1800000;
// Some GAN firmware delivers a state notification before the matching turns.
// The i carry E hardware trace includes a 1.59 s delay. Keep the turn stream
// canonical while allowing a bounded window for that history to arrive.
export const SNAPSHOT_WAIT_MS = 2000;
export function ganCubeInfo(hardware = {}, deviceName = '') {
  const hardwareName = hardware?.hardwareName || '';
  const name = /^GANicE2(?:_|$)/i.test(hardwareName || deviceName) ? 'GAN i carry E'
    : /^GANi30Mc(?:_|$)/i.test(hardwareName || deviceName) ? 'GAN356 i3'
    : hardwareName || deviceName || 'GAN';
  return { name, hardwareName, firmware: hardware?.softwareVersion || null,
    gyroSupported: typeof hardware?.gyroSupported === 'boolean' ? hardware.gyroSupported : null };
}
export const turnState = (f, move) => {
  if (!/^[URFDLB][2']?$/.test(move)) throw new Error('Unsupported turn');
  return facelets(applyAlg(fromFacelets(f), move).state).join('');
};
export const scrambleState = alg => facelets(applyAlg(CUBE_SOLVED, alg).state).join('');
const finite = v => typeof v === 'number' && Number.isFinite(v);
const ordered = values => values.every((v, i) => finite(v) && (!i || v >= values[i - 1]));
export const qtm = moves => moves.reduce((n, m) => n + (m.move.endsWith('2') ? 2 : 1), 0);

export function timeline(raw, fit) {
  if (!raw.length) return { moves: [], measuredDurationMs: 0, timingMethod: 'unavailable', timingQuality: 'unavailable' };
  const device = raw.map(m => m.cubeTimestamp), host = raw.map(m => m.localTimestamp);
  let times, timingMethod = 'receive-clock', timingQuality = 'estimated';
  // Recovered timestamps are deliberately NOT interpolated by the library.
  if (fit && raw.length >= 3 && ordered(device) && ordered(host) && device.at(-1) > device[0]) {
    const dx = device.map(v => v - device[0]), dy = host.map(v => v - host[0]);
    const mx = dx.reduce((a,b)=>a+b,0)/dx.length, my = dy.reduce((a,b)=>a+b,0)/dy.length;
    const slope = dx.reduce((a,x,i)=>a+(x-mx)*(dy[i]-my),0)/dx.reduce((a,x)=>a+(x-mx)**2,0);
    if (slope >= 0.9 && slope <= 1.1) {
      try {
        const candidate = fit(raw.map(m => ({ ...m }))).map(m => m.cubeTimestamp);
        if (ordered(candidate) && candidate[0] === 0 && candidate.at(-1) > 0) {
          times = candidate; timingMethod = 'cube-clock-fit'; timingQuality = 'measured';
        }
      } catch { /* Validated host fallback below. */ }
    }
  }
  if (!times) {
    const local = ordered(host) && raw.every(m => !m.recovered) ? host : raw.map(m => m.receivedMonotonic);
    if (!ordered(local)) throw new Error('No monotonic move timeline');
    times = local.map(v => v - local[0]);
    timingMethod = local === host ? 'host-clock' : 'receive-clock';
  }
  return { moves: raw.map((m, i) => ({ ...m, index: i, timeMs: times[i], estimated: timingQuality !== 'measured' })),
    measuredDurationMs: times.at(-1), timingMethod, timingQuality };
}

export function validateCapture(c) {
  if (!c || c.schemaVersion !== SCHEMA || c.id !== c.solveId || !Array.isArray(c.moves) || c.moves.length > MAX_MOVES || (c.rawEvents?.length || 0) > MAX_RAW || JSON.stringify(c).length > MAX_BYTES) throw new Error('Unsupported or oversized smart cube capture');
  fromFacelets(c.initialFacelets);
  if (!ordered(c.moves.map(m => m.timeMs)) || (c.moves.length && c.moves[0].timeMs !== 0) || !finite(c.measuredDurationMs) || c.measuredDurationMs < 0 || Math.abs((c.moves.at(-1)?.timeMs || 0) - c.measuredDurationMs) > 1) throw new Error('Invalid move timeline');
  let state = c.initialFacelets;
  c.moves.forEach((m, i) => { state = turnState(state, m.move); if (state === SOLVED && i < c.moves.length - 1) throw new Error('Capture continues after solved'); });
  if (c.completeness === 'complete' && (!c.moves.length || state !== SOLVED || c.scrambleVerified !== true)) throw new Error('Incomplete solution');
  if(c.orientation && (!Array.isArray(c.orientation.samples)||c.orientation.samples.length>MAX_ORIENTATION_SAMPLES
    ||!normalizeQuaternion(c.orientation.reference)||!ordered(c.orientation.samples.map(s=>s.timeMs))
    ||c.orientation.samples.some(s=>s.timeMs<0||s.timeMs>c.measuredDurationMs||!normalizeQuaternion(s.quaternion)))) throw new Error('Invalid orientation recording');
  return c;
}

// Append-only annotations merge by ID. Profile corrections use the later edit;
// the evidence must agree byte-for-byte before metadata can ever be merged.
export function mergeCaptureEdits(local, remote) {
  validateCapture(local); validateCapture(remote);
  for (const key of ['id','initialFacelets','moves','rawEvents','orientation','measuredDurationMs','timingConvention']) {
    if (JSON.stringify(local[key]) !== JSON.stringify(remote[key])) throw new Error('Smart cube evidence conflict; export both captures for review');
  }
  const winner = (local.updatedAt || 0) >= (remote.updatedAt || 0) ? local : remote;
  const annotations = [...new Map([...(remote.annotations || []),...(local.annotations || [])].map(a=>[a.id || `${a.startIndex}:${a.endIndex}:${a.label}`,a])).values()];
  return { ...remote, completeness:local.completeness === 'complete' && remote.completeness === 'complete' ? 'complete' : 'interrupted', qualityIssues:[...new Set([...(remote.qualityIssues||[]),...(local.qualityIssues||[])])], postSolveEvidence:[...(remote.postSolveEvidence||[]),...(local.postSolveEvidence||[])], analysisConfig:winner.analysisConfig, annotations, revision:Math.max(local.revision || 0,remote.revision || 0)+1, updatedAt:Math.max(local.updatedAt || 0,remote.updatedAt || 0) };
}

export function checkpoints(c, stride = 24) {
  const result = [{ index: -1, facelets: c.initialFacelets }];
  let state = c.initialFacelets;
  c.moves.forEach((m, index) => { state = turnState(state, m.move); if ((index + 1) % stride === 0) result.push({ index, facelets: state }); });
  return result;
}
export function seekState(c, index, points = checkpoints(c)) {
  const point = points.findLast(p => p.index <= index) || points[0];
  let state = point.facelets;
  for (let i = point.index + 1; i <= Math.min(index, c.moves.length - 1); i++) state = turnState(state, c.moves[i].move);
  return state;
}
export function rangeStats(c, a, b) {
  const slice = c.moves.slice(a, b + 1), startMs = slice[0]?.timeMs || 0, endMs = slice.at(-1)?.timeMs || 0;
  const count = qtm(slice), spanMs = endMs - startMs;
  return { startMs, endMs, qtm: count, spanMs, entryGapMs: startMs - (c.moves[a - 1]?.timeMs || 0), tps: spanMs > 0 ? count * 1000 / spanMs : null };
}
export function tpsWindows(c, widthMs = 1000, stepMs = 100) {
  const out = []; let first = 0, end = 0;
  for (let at = 0; at <= c.measuredDurationMs; at += stepMs) {
    while (end < c.moves.length && c.moves[end].timeMs <= at) end++;
    while (first < end && c.moves[first].timeMs <= at - widthMs) first++;
    out.push({ atMs: at, tps: qtm(c.moves.slice(first, end)) * 1000 / widthMs });
  }
  return out;
}

// A predicate must hold at the boundary and EVERY later state, avoiding fleeting
// crosses/pairs/orientation. This may conservatively assign an unknown solve.
export function phases(c, face = 'D') {
  if (c.analysisConfig?.profile !== 'cfop' || c.completeness !== 'complete') return [];
  let state = fromFacelets(c.initialFacelets);
  const states = [analyse(state, face)];
  for (const m of c.moves) { state = applyAlg(state, m.move).state; states.push(analyse(state, face)); }
  let previous = 0, previousTime = 0;
  const landmarks = c.analysisConfig?.lastLayerLandmarks || {}, manual = c.analysisConfig?.phaseBoundaries || {};
  return [['Cross','cross'],['F2L','f2l'],['OLL','oll'],['PLL','solved']].map(([name, predicate]) => {
    const anchor = name === 'F2L' ? landmarks.OLL?.startIndex : name === 'OLL' ? landmarks.PLL?.startIndex : null;
    const nextAnchor = name === 'Cross' ? (landmarks.OLL?.startIndex ?? landmarks.PLL?.startIndex) : name === 'F2L' ? landmarks.PLL?.startIndex : null;
    let boundary = nextAnchor ?? states.length - 1;
    while (boundary > previous && states[boundary - 1][predicate]) boundary--;
    if (Number.isInteger(anchor)) boundary = anchor;
    if (Number.isInteger(manual[name])) boundary = manual[name];
    boundary = Math.max(previous,Math.min(c.moves.length,boundary));
    const endMs = c.moves[boundary - 1]?.timeMs || 0;
    const meaningful = name === 'PLL' || Number.isInteger(manual[name]) || Number.isInteger(anchor) || boundary < states.length - 1 || previous === boundary;
    const row = { name: meaningful ? name : `Unknown (${name})`, inferredPhase:name, startIndex: previous, endIndex: boundary - 1, startMs: previousTime, endMs, durationMs: endMs - previousTime, qtm: qtm(c.moves.slice(previous, boundary)), confidence: Number.isInteger(manual[name]) ? (c.analysisConfig.boundarySource==='scripted-demo'?'scripted-example':'user-corrected') : Number.isInteger(anchor) ? 'exact-algorithm-landmark' : meaningful ? 'stable-state' : 'unknown' };
    previous = boundary; previousTime = endMs; return row;
  });
}

export class SmartStream {
  constructor({ epoch, onMove = () => {}, onState = () => {}, onIssue = () => {} }) {
    Object.assign(this, { epoch, onMove, onState, onIssue }); this.state = null; this.serial = null; this.history = new Map(); this.moveHistory = new Map(); this.positions = new Map(); this.position = 0; this.raw = [];
    this.pendingSnapshots = new Map();
  }
  get synchronized() { return !!this.state && this.pendingSnapshots.size === 0; }
  issue(reason, evidence = this.lastEvent) { this.onIssue(reason, evidence); }
  reset() {
    this.state = null; this.serial = null;
    this.history.clear(); this.moveHistory.clear(); this.positions.clear(); this.pendingSnapshots.clear();
  }
  remember(serial, state) {
    this.history.set(serial, state); this.positions.set(serial, this.position);
    if (this.history.size > 96) this.history.delete(this.history.keys().next().value);
    if (this.positions.size > 96) this.positions.delete(this.positions.keys().next().value);
  }
  adoptSnapshot(raw) {
    this.state = raw.facelets; this.serial = raw.serial;
    this.history.clear(); this.moveHistory.clear(); this.positions.clear(); this.pendingSnapshots.clear();
    this.remember(raw.serial, raw.facelets);
    this.onState(this.state);
  }
  flushPending(now = performance.now()) {
    if (!this.pendingSnapshots.size) return;
    if (![...this.pendingSnapshots.values()].some(p => now >= p.deadline)) return;
    // A refresh restores the present state, never the missing moves of a solve.
    const latest = [...this.pendingSnapshots.values()].reduce((a,b) =>
      ((b.raw.serial - this.serial + 256) % 256) > ((a.raw.serial - this.serial + 256) % 256) ? b : a).raw;
    this.issue('Snapshot includes unknown turns', latest);
    this.adoptSnapshot(latest);
  }
  ingest(event, receivedMonotonic = performance.now()) {
    this.flushPending(receivedMonotonic);
    const raw = Object.freeze({ ...structuredClone(event), epoch: this.epoch, receivedMonotonic, receivedAt: Date.now(), recovered: event.type === 'MOVE' && (!finite(event.localTimestamp) || !finite(event.cubeTimestamp)) });
    this.lastEvent = raw;
    if (this.raw.length === MAX_RAW) this.raw.shift();
    if (event.type !== 'GYRO') this.raw.push(raw);
    if (event.type === 'MOVE') {
      if (!Number.isInteger(event.serial) || event.serial < 0 || event.serial > 255) { this.state = null; this.pendingSnapshots.clear(); this.issue('Invalid move sequence'); return; }
      const diff = this.serial == null ? 1 : (event.serial - this.serial + 256) % 256;
      const prior = this.moveHistory.get(event.serial);
      if (diff === 0 && (!prior || (prior.move === event.move && prior.cubeTimestamp === event.cubeTimestamp && prior.localTimestamp === event.localTimestamp))) return;
      if (diff > 128 && prior && finite(event.cubeTimestamp) && finite(prior.cubeTimestamp) && event.cubeTimestamp <= prior.cubeTimestamp) return;
      if (diff !== 1) { this.state = null; this.serial = event.serial; this.pendingSnapshots.clear(); this.issue('Missing or out-of-order turns'); return; }
      this.serial = event.serial;
      if (!this.state) return; // never invent an initial solved state
      const before = this.state;
      try { this.state = turnState(before, event.move); }
      catch { this.state = null; this.pendingSnapshots.clear(); this.issue('Unsupported turn'); return; }
      this.position++; this.remember(event.serial, this.state); this.moveHistory.set(event.serial,raw);
      if (this.moveHistory.size > 96) this.moveHistory.delete(this.moveHistory.keys().next().value);
      const pending = this.pendingSnapshots.get(event.serial);
      this.pendingSnapshots.delete(event.serial);
      if (pending && pending.raw.facelets !== this.state) {
        this.issue('Cube state mismatch', pending.raw);
        this.adoptSnapshot(pending.raw);
        return raw;
      }
      this.onMove(Object.freeze({...raw,position:this.position}), before, this.state); this.onState(this.state);
    } else if (event.type === 'FACELETS') {
      if (!Number.isInteger(event.serial) || event.serial < 0 || event.serial > 255) { this.state = null; this.pendingSnapshots.clear(); this.issue('Invalid snapshot sequence'); return; }
      try { fromFacelets(event.facelets); } catch { this.issue('Invalid cube state'); return; }
      const diff = this.serial == null ? 0 : (event.serial - this.serial + 256) % 256;
      if (this.state && diff > 128) {
        if (this.history.has(event.serial) && this.history.get(event.serial) !== event.facelets) this.issue('Older cube snapshot disagrees');
        return;
      }
      if (this.state && diff > 0) {
        // Repeated snapshots must not extend the deadline indefinitely.
        const previous = this.pendingSnapshots.get(event.serial);
        if (previous && previous.raw.facelets !== raw.facelets) this.issue('Cube state mismatch', raw);
        this.pendingSnapshots.set(event.serial, { raw, deadline: previous?.deadline ?? receivedMonotonic + SNAPSHOT_WAIT_MS });
        if (this.pendingSnapshots.size > 16) this.flushPending(Infinity);
        else this.onState(this.state);
        return raw;
      }
      if (this.state && this.state !== event.facelets) this.issue('Cube state mismatch');
      if (!this.state || this.state !== event.facelets) this.adoptSnapshot(raw);
      else { this.remember(event.serial, this.state); this.onState(this.state); }
    }
    return raw;
  }
}
