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

/* ---------------- confetti ----------------
   Every flake used to cost a save/translate/rotate/restore, a fillStyle write
   and a globalAlpha write, every frame — six context state changes per flake,
   a thousand of them a frame, on top of a full-resolution canvas. The physics
   is identical; only the drawing has been rewritten.
   --------------------------------------------------------- */
let confettiRunning = false;

export function confetti(colors, { count = 130, power = 1 } = {}) {
  const cv = $('#confetti');
  if (!cv || confettiRunning) return;
  const ctx = cv.getContext('2d');
  if (!ctx) return;

  // Flakes are 5px and moving fast. Rendering them at two device pixels each
  // doubles the fill cost for detail nobody can see mid-flight.
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  const w = innerWidth, h = innerHeight;
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  cv.classList.add('on');
  cv.style.opacity = '1';
  // Toasts sit above this canvas and blur what is behind them, so while the
  // confetti is moving their backdrop has to be re-blurred every single frame.
  document.body.classList.add('celebrating');
  confettiRunning = true;

  // Grouped by colour up front, so the loop sets fillStyle once per colour per
  // frame rather than once per flake.
  const groups = colors.map(c => ({ c, parts: [] }));
  for (let i = 0; i < count; i++) {
    const pw = 5 + Math.random() * 7;
    const ph = 3 + Math.random() * 6;
    groups[i % groups.length].parts.push({
      x: w / 2 + (Math.random() - 0.5) * 220,
      y: h / 2 + (Math.random() - 0.5) * 90,
      vx: (Math.random() - 0.5) * 17 * power,
      vy: (Math.random() * -13 - 4) * power,
      w: pw, h: ph, hw: pw / 2, hh: ph / 2,
      rot: Math.random() * Math.PI * 2,
      vr: (Math.random() - 0.5) * 0.34,
    });
  }

  const finish = () => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    cv.classList.remove('on');
    cv.style.opacity = '';
    document.body.classList.remove('celebrating');
    confettiRunning = false;
  };

  let frames = 0;
  let life = 1;
  const step = () => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);

    let alive = 0;
    for (const g of groups) {
      if (!g.parts.length) continue;
      ctx.fillStyle = g.c;
      let keep = 0;
      for (let i = 0; i < g.parts.length; i++) {
        const p = g.parts[i];
        p.vy += 0.42;
        p.vx *= 0.992;
        p.x += p.vx; p.y += p.vy; p.rot += p.vr;
        if (p.y > h + 60) continue;               // gone; drop it from the array
        g.parts[keep++] = p;
        // One transform call replaces save + translate + rotate + restore.
        const cos = Math.cos(p.rot), sin = Math.sin(p.rot);
        ctx.setTransform(cos * dpr, sin * dpr, -sin * dpr, cos * dpr, p.x * dpr, p.y * dpr);
        ctx.fillRect(-p.hw, -p.hh, p.w, p.h);
      }
      // Dead flakes stop costing anything from the next frame onwards.
      g.parts.length = keep;
      alive += keep;
    }

    frames++;
    // Every flake used to fade on its own clock, but they all started fading on
    // the same frame — so it is the same picture for one composited opacity on
    // the canvas instead of a globalAlpha write per flake.
    if (frames > 55) {
      life -= 0.016;
      cv.style.opacity = String(Math.max(0, life));
    }

    if (alive > 0 && life > 0 && frames < 260) requestAnimationFrame(step);
    else finish();
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
