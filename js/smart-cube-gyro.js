// Orientation is display evidence. It never changes facelets or solve timing.
export const MAX_ORIENTATION_SAMPLES = 1200;
export const ORIENTATION_INTERVAL_MS = 100;
export const IDENTITY_QUATERNION = Object.freeze({ x:0, y:0, z:0, w:1 });

export function normalizeQuaternion(q) {
  if (!q || !['x','y','z','w'].every(k=>Number.isFinite(q[k]))) return null;
  const length = Math.hypot(q.x,q.y,q.z,q.w);
  if (length < 1e-6) return null;
  return { x:q.x/length, y:q.y/length, z:q.z/length, w:q.w/length };
}
export function multiplyQuaternion(a,b) {
  return { x:a.w*b.x+a.x*b.w+a.y*b.z-a.z*b.y,
    y:a.w*b.y-a.x*b.z+a.y*b.w+a.z*b.x,
    z:a.w*b.z+a.x*b.y-a.y*b.x+a.z*b.w,
    w:a.w*b.w-a.x*b.x-a.y*b.y-a.z*b.z };
}
export function relativeQuaternion(reference,current) {
  return multiplyQuaternion({ x:-reference.x,y:-reference.y,z:-reference.z,w:reference.w },current);
}
// GAN: +X red, +Y blue, +Z white. Renderer: +X red, +Y white, +Z green.
export function rendererQuaternion(q) { return { x:q.x,y:q.z,z:-q.y,w:q.w }; }

export function orientationTimeline(orientation,moves,duration) {
  if (!orientation?.samples?.length || !moves.length) return undefined;
  const first=moves[0].receivedMonotonic, span=moves.at(-1).receivedMonotonic-first;
  return { ...orientation, timingQuality:'estimated', samples:orientation.samples.map(sample=>({ ...sample,
    timeMs:span>0?Math.max(0,Math.min(duration,(sample.receivedMonotonic-first)/span*duration)):0 })) };
}
export function orientationAt(orientation,timeMs) {
  const samples=orientation?.samples;
  if (!samples?.length) return null;
  let lo=0,hi=samples.length;
  while(lo<hi) { const mid=(lo+hi)>>>1; if(samples[mid].timeMs<=timeMs)lo=mid+1;else hi=mid; }
  const left=samples[Math.max(0,lo-1)],right=samples[lo];
  if(!right||right.timeMs===left.timeMs)return left.quaternion;
  const fraction=Math.max(0,Math.min(1,(timeMs-left.timeMs)/(right.timeMs-left.timeMs)));
  // Shortest-path normalized interpolation also handles equivalent q / -q.
  const sign=['x','y','z','w'].reduce((s,k)=>s+left.quaternion[k]*right.quaternion[k],0)<0?-1:1;
  return normalizeQuaternion(Object.fromEntries(['x','y','z','w'].map(k=>[k,left.quaternion[k]*(1-fraction)+right.quaternion[k]*fraction*sign])));
}
