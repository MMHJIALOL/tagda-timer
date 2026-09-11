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

   What was left after that was not the confetti's own cost at all. It runs on
   the one frame where the page is at its busiest: the times list has just been
   re-rendered, a shockwave is scaling across the whole viewport, and the
   background shader is still painting every pixel behind it. So the loop now
   also (a) throttles that shader while it runs, (b) clears only the rectangle
   it drew into rather than the whole canvas, (c) keeps the backing store inside
   a pixel budget instead of trusting devicePixelRatio on a 4K screen, and
   (d) moves the flakes by elapsed time rather than by frame — a dropped frame
   used to slow the confetti down, which is exactly what "it lags" looks like.
   --------------------------------------------------------- */
let confettiRunning = false;

/* Told about the celebration so the things underneath it can get out of the
   way — main.js turns the background shader down while this is true. */
function celebrating(on) {
  document.body.classList.toggle('celebrating', on);
  window.dispatchEvent(new CustomEvent('tt-celebrate', { detail: { on } }));
}

export function confetti(colors, { count = 130, power = 1 } = {}) {
  const cv = $('#confetti');
  if (!cv || confettiRunning) return;
  /* A hidden tab does not run requestAnimationFrame, so a celebration started
     there would never draw a frame and never finish — leaving the page in its
     celebrating state, with the background shader turned down, for as long as
     the tab stayed open. There is also nobody looking at it. */
  if (document.hidden) return;
  // `desynchronized` lets the compositor skip a round trip on canvases nothing
  // reads back — which this never does.
  const ctx = cv.getContext('2d', { alpha: true, desynchronized: true });
  if (!ctx) return;

  /* Flakes are 5px and moving fast. Rendering them at two device pixels each
     doubles the fill cost for detail nobody can see mid-flight — and on a 4K
     screen even 1.5x is an eight-megapixel surface to clear and fill every
     frame, which is where the stutter came from. Capped by total pixels, so a
     laptop keeps its crisp flakes and a big display stops paying for them. */
  const w = innerWidth, h = innerHeight;
  const PIXEL_BUDGET = 2.6e6;
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5,
                       Math.sqrt(PIXEL_BUDGET / Math.max(1, w * h)));
  const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
  // Resizing a canvas reallocates its backing store; same size, same buffer.
  if (cv.width !== bw || cv.height !== bh) { cv.width = bw; cv.height = bh; }
  cv.classList.add('on');
  cv.style.opacity = '1';
  celebrating(true);
  confettiRunning = true;

  // Fewer flakes where there are fewer cores to draw them with. The celebration
  // reads the same; a phone just stops dropping frames during it.
  if ((navigator.hardwareConcurrency || 8) <= 4) count = Math.round(count * 0.6);

  // Grouped by colour up front, so the loop sets fillStyle once per colour per
  // frame rather than once per flake.
  const groups = colors.map(c => ({ c, parts: [] }));
  let maxR = 0;
  for (let i = 0; i < count; i++) {
    const pw = 5 + Math.random() * 7;
    const ph = 3 + Math.random() * 6;
    maxR = Math.max(maxR, Math.hypot(pw, ph) / 2);
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

  let over = false;
  const finish = () => {
    if (over) return;
    over = true;
    clearTimeout(watchdog);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    cv.classList.remove('on');
    cv.style.opacity = '';
    celebrating(false);
    confettiRunning = false;
  };

  /* The rectangle the last frame painted into, in CSS pixels. Clearing that
     instead of the whole viewport is most of a full-screen clear saved on every
     frame — the flakes only ever occupy a band of it. */
  let dirty = null;

  let elapsed = 0;
  let life = 1;
  let last = performance.now();
  const step = (now) => {
    /* Time, not frames. Everything below is in 60ths of a second so the
       constants are the ones that were tuned, and a long frame is clamped
       rather than teleporting every flake off screen. */
    const dt = Math.min(2.5, (now - last) / 16.667);
    last = now;
    elapsed += dt;

    // Work in CSS pixels; the transform carries the device scale.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (dirty) ctx.clearRect(dirty[0], dirty[1], dirty[2] - dirty[0], dirty[3] - dirty[1]);
    else ctx.clearRect(0, 0, w, h);

    let alive = 0;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const g of groups) {
      if (!g.parts.length) continue;
      ctx.fillStyle = g.c;
      let keep = 0;
      for (let i = 0; i < g.parts.length; i++) {
        const p = g.parts[i];
        p.vy += 0.42 * dt;
        p.vx *= Math.pow(0.992, dt);
        p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
        if (p.y > h + 60) continue;               // gone; drop it from the array
        g.parts[keep++] = p;
        if (p.x < x0) x0 = p.x;
        if (p.y < y0) y0 = p.y;
        if (p.x > x1) x1 = p.x;
        if (p.y > y1) y1 = p.y;
        // One transform call replaces save + translate + rotate + restore.
        const cos = Math.cos(p.rot), sin = Math.sin(p.rot);
        ctx.setTransform(cos * dpr, sin * dpr, -sin * dpr, cos * dpr, p.x * dpr, p.y * dpr);
        ctx.fillRect(-p.hw, -p.hh, p.w, p.h);
      }
      // Dead flakes stop costing anything from the next frame onwards.
      g.parts.length = keep;
      alive += keep;
    }

    /* Padded by the widest a flake can reach from its centre, and by one frame
       of the fastest fall, so nothing is ever left painted outside the box the
       next frame clears. */
    dirty = alive
      ? [Math.max(0, x0 - maxR - 4), Math.max(0, y0 - maxR - 4),
         Math.min(w, x1 + maxR + 4), Math.min(h, y1 + maxR + 40)]
      : null;

    // Every flake used to fade on its own clock, but they all started fading on
    // the same frame — so it is the same picture for one composited opacity on
    // the canvas instead of a globalAlpha write per flake.
    if (elapsed > 55) {
      life -= 0.016 * dt;
      cv.style.opacity = String(Math.max(0, life));
    }

    if (over) return;
    if (alive > 0 && life > 0 && elapsed < 260) requestAnimationFrame(step);
    else finish();
  };
  /* Switching tabs mid-flight stops the frames from coming, and the celebration
     has to end anyway — a second past the longest it can run. */
  const watchdog = setTimeout(finish, 5500);
  requestAnimationFrame(step);
}

/* ---------------- audio ---------------- */
let audioCtx = null;
function ac() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function tone(c, freq, ms, type, gain, t, attack = 0.012) {
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type; osc.frequency.value = freq;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
  osc.connect(g); g.connect(c.destination);
  osc.start(t); osc.stop(t + ms / 1000 + 0.02);
}

export function beep(freq = 880, ms = 130, type = 'sine', gain = 0.16) {
  try { const c = ac(); tone(c, freq, ms, type, gain, c.currentTime); }
  catch { /* audio unavailable */ }
}

/**
 * Metronome click at `bpm`; 0 stops it.
 *
 * Clicks are booked on the audio clock a little ahead of time rather than fired
 * from setInterval, so a heavy frame (the 3D cube, a stats redraw) cannot push a
 * beat late — the interval only has to wake often enough to book the next one.
 */
let metro = null;
export function metronome(bpm) {
  clearInterval(metro); metro = null;
  if (!bpm) return;
  try {
    const c = ac();
    const gap = 60 / bpm;
    let next = c.currentTime;
    const book = () => {
      // A throttled background tab wakes late: skip the missed beats, never burst them.
      if (next < c.currentTime) next = c.currentTime;
      while (next < c.currentTime + 0.1) { tone(c, 1600, 35, 'square', 0.1, next, 0.003); next += gap; }
    };
    book();
    metro = setInterval(book, 25);
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
