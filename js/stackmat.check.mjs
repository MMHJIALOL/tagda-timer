// Self-check for StackmatDecoder: node js/stackmat.check.mjs
// Synthesizes 1200-baud serial audio the way a sound card delivers it
// (faint, AC-coupled, either polarity) and asserts packets decode.
globalThis.localStorage ??= { getItem: () => null, setItem() {} };
globalThis.navigator ??= { language: 'en' };
const { StackmatDecoder } = await import('./stackmat.js');
import assert from 'node:assert';

const RATE = 48000, SPB = RATE / 1200;
function packet(status, digits) {
  const sum = [...digits].reduce((s, d) => s + +d, 0);
  return [status, ...digits].map(c => c.charCodeAt(0)).concat(64 + sum, 13, 10);
}
function audio(bytes, amp, sign, fc) {
  const bits = [];
  for (let r = 0; r < 12; r++) {            // ~1 s of repeated packets
    for (let i = 0; i < 20; i++) bits.push(1); // idle gap
    for (const b of bytes) { bits.push(0); for (let k = 0; k < 8; k++) bits.push((b >> k) & 1); bits.push(1); }
  }
  const out = new Float32Array(Math.ceil(bits.length * SPB));
  let hp = 0, last = 0;                     // one-pole high-pass: sound-card AC coupling
  const a = 1 / (1 + 2 * Math.PI * fc / RATE);
  for (let i = 0; i < out.length; i++) {
    const x = (bits[Math.floor(i / SPB)] ? 1 : -1) * amp * sign;
    hp = a * (hp + x - last); last = x;
    out[i] = hp + (Math.random() - 0.5) * amp * 0.1;
  }
  return out;
}
function decode(bytes, amp, sign, fc) {
  const got = [];
  const d = new StackmatDecoder(RATE, p => got.push(p));
  const s = audio(bytes, amp, sign, fc);
  for (let i = 0; i < 4; i++) for (let j = 0; j < s.length; j += 128) d.push(s.subarray(j, j + 128));
  return got;
}
for (const sign of [1, -1]) for (const amp of [0.5, 0.003]) for (const fc of [2, 5, 20, 50, 100]) {
  const tag = `amp=${amp} sign=${sign} highpass=${fc}Hz`;
  const six = decode(packet('S', '012345'), amp, sign, fc);
  assert(six.length && six.at(-1).timeMs === 12345, `6-digit ${tag}`);
  const five = decode(packet(' ', '10734'), amp, sign, fc);
  assert(five.length && five.at(-1).timeMs === 67340, `5-digit ${tag}`);
}
console.log('stackmat decoder ok');
