/* ===========================================================
   Tagda Timer — effects: confetti, shockwave, screen flash, audio
   =========================================================== */

import { $, el } from './util.js';

/* ---------------- screen flash ---------------- */
export function flash(color = '#ffffff') {
  const f = $('#flash');
  if (!f) return;
  f.style.setProperty('--flash-color', color);
  f.classList.remove('pulse');
  void f.offsetWidth;
  f.classList.add('pulse');
}

/* ---------------- PB shockwave ---------------- */
export function shockwave(color) {
  const ring = el('div', { class: 'shockwave' });
  if (color) ring.style.borderColor = color;
  document.body.append(ring);
  setTimeout(() => ring.remove(), 950);
}

/* ---------------- confetti ---------------- */
let confettiRunning = false;

export function confetti(colors, { count = 130, power = 1 } = {}) {
  const cv = $('#confetti');
  if (!cv || confettiRunning) return;
  const ctx = cv.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  cv.width = innerWidth * dpr; cv.height = innerHeight * dpr;
  ctx.scale(dpr, dpr);
  cv.classList.add('on');
  confettiRunning = true;

  const parts = Array.from({ length: count }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * 220,
    y: innerHeight / 2 + (Math.random() - 0.5) * 90,
    vx: (Math.random() - 0.5) * 17 * power,
    vy: (Math.random() * -13 - 4) * power,
    w: 5 + Math.random() * 7,
    h: 3 + Math.random() * 6,
    rot: Math.random() * Math.PI * 2,
    vr: (Math.random() - 0.5) * 0.34,
    c: colors[Math.floor(Math.random() * colors.length)],
    life: 1,
  }));

  let frames = 0;
  const step = () => {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    let alive = 0;
    for (const p of parts) {
      p.vy += 0.42;
      p.vx *= 0.992;
      p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      if (frames > 55) p.life -= 0.016;
      if (p.life <= 0 || p.y > innerHeight + 60) continue;
      alive++;
      ctx.save();
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    frames++;
    if (alive > 0 && frames < 260) requestAnimationFrame(step);
    else {
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      cv.classList.remove('on');
      confettiRunning = false;
    }
  };
  requestAnimationFrame(step);
}

/* ---------------- audio ---------------- */
let audioCtx = null;
function ac() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

export function beep(freq = 880, ms = 130, type = 'sine', gain = 0.16) {
  try {
    const c = ac();
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type; osc.frequency.value = freq;
    g.gain.setValueAtTime(0, c.currentTime);
    g.gain.linearRampToValueAtTime(gain, c.currentTime + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + ms / 1000);
    osc.connect(g); g.connect(c.destination);
    osc.start(); osc.stop(c.currentTime + ms / 1000 + 0.02);
  } catch { /* audio unavailable */ }
}

/** Rising three-note chime for a personal best. */
export function chime() {
  [523.25, 659.25, 783.99, 1046.5].forEach((f, i) =>
    setTimeout(() => beep(f, 260, 'triangle', 0.13), i * 85));
}

/**
 * Inspection callout at 8 and 12 seconds.
 *
 * Speech synthesis used to be an option here and is gone for good: the first
 * `speechSynthesis.speak()` of a session can block the main thread for hundreds
 * of milliseconds while the platform spins up a voice, which is a stutter
 * landing squarely in the middle of inspection. A tone costs nothing.
 */
export function callout(seconds, mode) {
  if (mode === 'off') return;
  if (seconds === 8) beep(660, 110, 'square', 0.13);
  else { beep(880, 90, 'square', 0.14); setTimeout(() => beep(880, 90, 'square', 0.14), 130); }
}
