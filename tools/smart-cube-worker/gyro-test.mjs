export const GYRO_TEST_MS = 12000;
export const GYRO_HOLD_START_MS = 8000;

export function normalizeQuaternion(value) {
  if (!value || !['x', 'y', 'z', 'w'].every(key => Number.isFinite(value[key]))) return null;
  const norm = Math.hypot(value.x, value.y, value.z, value.w);
  if (norm < 1e-6) return null;
  return { x: value.x / norm, y: value.y / norm, z: value.z / norm, w: value.w / norm };
}

function multiply(a, b) {
  return {
    x: a.w*b.x + a.x*b.w + a.y*b.z - a.z*b.y,
    y: a.w*b.y - a.x*b.z + a.y*b.w + a.z*b.x,
    z: a.w*b.z + a.x*b.y - a.y*b.x + a.z*b.w,
    w: a.w*b.w - a.x*b.x - a.y*b.y - a.z*b.z,
  };
}

export function relativeQuaternion(reference, current) {
  return multiply({ x:-reference.x, y:-reference.y, z:-reference.z, w:reference.w }, current);
}

export function angularDistance(a, b) {
  const dot = Math.abs(a.x*b.x + a.y*b.y + a.z*b.z + a.w*b.w);
  return 2 * Math.acos(Math.min(1, dot)) * 180 / Math.PI;
}

// GAN's right-handed axes are +X red, +Y blue, +Z white. CSS uses
// +X right/red, +Y down/yellow, +Z front/green. Change basis with S R S^-1.
export function orientationMatrix(q) {
  const { x, y, z, w } = q;
  const r = [
    [1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w)],
    [2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w)],
    [2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y)],
  ];
  const axes = [0,2,1], signs = [1,-1,-1], matrix = [];
  for (let column=0; column<3; column++) {
    for (let row=0; row<3; row++) matrix.push(signs[row]*signs[column]*r[axes[row]][axes[column]]);
    matrix.push(0);
  }
  return [...matrix, 0,0,0,1];
}

const rounded = value => Math.round(value * 100) / 100;

export class GyroDiagnostics {
  constructor() {
    this.received = 0; this.valid = 0; this.invalid = 0; this.maxNormError = 0;
    this.active = null;
    this.resetConnection();
  }

  resetConnection() {
    this.supported = null; this.latest = null; this.reference = null;
    this.lastAt = null; this.recent = [];
  }

  sample(event, at) {
    this.received++;
    const q = normalizeQuaternion(event.quaternion);
    if (this.active) this.active.receivedSamples++;
    if (!q) {
      this.invalid++;
      if (this.active) this.active.invalidSamples++;
      return false;
    }
    const normError = Math.abs(Math.hypot(...['x','y','z','w'].map(key => event.quaternion[key])) - 1);
    this.maxNormError = Math.max(this.maxNormError, normError);
    this.valid++;
    this.latest = q;
    this.reference ||= q;
    this.lastAt = at;
    this.recent.push(at);
    this.recent = this.recent.filter(time => at-time <= 1000).slice(-500);
    const run = this.active;
    if (run) {
      run.validSamples++;
      run.maxGapMs = Math.max(run.maxGapMs, at - (run.lastSampleAt ?? run.startedMonotonic));
      run.lastSampleAt = at;
      run.maxNormError = Math.max(run.maxNormError, normError);
      run.reference ||= q;
      const relative = relativeQuaternion(run.reference, q);
      const length = Math.hypot(relative.x, relative.y, relative.z);
      const angle = 2 * Math.atan2(length, Math.abs(relative.w)) * 180 / Math.PI;
      for (const axis of ['x','y','z']) {
        const component = length > 1e-6 ? angle*Math.abs(relative[axis])/length : 0;
        run.axisMotionDegrees[axis] = Math.max(run.axisMotionDegrees[axis], component);
      }
      if (at-run.startedMonotonic >= GYRO_HOLD_START_MS) {
        run.holdReference ||= q;
        run.holdSamples++;
        run.holdMaxDeviationDegrees = Math.max(run.holdMaxDeviationDegrees, angularDistance(run.holdReference, q));
      }
    }
    return true;
  }

  get rateHz() {
    const span = this.recent.at(-1) - this.recent[0];
    return span > 0 ? (this.recent.length-1)*1000/span : null;
  }

  start(at, wallTime) {
    if (this.active) return;
    this.active = {
      startedAt:wallTime, startedMonotonic:at, reference:this.latest,
      receivedSamples:0, validSamples:0, invalidSamples:0, storedSamples:0,
      maxGapMs:0, maxNormError:0, lastSampleAt:null,
      axisMotionDegrees:{x:0,y:0,z:0}, holdSamples:0, holdReference:null,
      holdMaxDeviationDegrees:0,
    };
  }

  finish(reason, at, wallTime) {
    const run = this.active;
    if (!run) return null;
    this.active = null;
    const axesObserved = ['x','y','z'].filter(axis => run.axisMotionDegrees[axis] >= 20);
    const outcome = reason !== 'complete' ? 'interrupted' : !run.validSamples ? 'no-data'
      : run.invalidSamples || run.maxNormError > .1 ? 'check-data'
      : axesObserved.length === 3 ? 'motion-observed' : 'limited-motion';
    return {
      startedAt:run.startedAt, endedAt:wallTime, durationMs:rounded(at-run.startedMonotonic),
      outcome, reason, receivedSamples:run.receivedSamples, validSamples:run.validSamples,
      invalidSamples:run.invalidSamples, storedSamples:run.storedSamples,
      maxSampleGapMs:rounded(Math.max(run.maxGapMs, at-(run.lastSampleAt ?? run.startedMonotonic))),
      maxNormError:Math.round(run.maxNormError*1e6)/1e6, axesObserved,
      axisMotionDegrees:Object.fromEntries(Object.entries(run.axisMotionDegrees).map(([axis,value]) => [axis,rounded(value)])),
      holdSamples:run.holdSamples,
      holdMaxDeviationDegrees:run.holdSamples ? rounded(run.holdMaxDeviationDegrees) : null,
      holdAssessment:run.holdSamples < 2 ? 'insufficient-data' : run.holdMaxDeviationDegrees <= 3 ? 'steady' : 'movement-observed',
      referenceQuaternion:run.reference,
    };
  }

  summary() {
    return { schemaVersion:1, reportedSupported:this.supported, receivedSamples:this.received,
      validSamples:this.valid, invalidSamples:this.invalid, maxNormError:Math.round(this.maxNormError*1e6)/1e6,
      latestQuaternion:this.latest, recentRateHz:this.rateHz == null ? null : rounded(this.rateHz),
      coordinateSystem:'GAN right-handed: +X red, +Y blue, +Z white' };
  }
}
