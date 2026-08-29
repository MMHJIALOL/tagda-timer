/* ===========================================================
   Tagda Timer — shareable solve cards

   Draws a solve (or an average) onto a canvas as a poster you can drop
   straight into a story or a group chat: the time, the scramble, and —
   for a single solve — the cube exactly as the scramble leaves it.

   Everything is painted here rather than screenshotted, because the
   on-page preview lives in a closed shadow root and the rest of the UI
   is full of translucency that reads as mud once it is a flat PNG.
   =========================================================== */

import { fmt, fmtDate } from './util.js';
import { eff, DNF } from './stats.js';
import { faceletsFor, drawNet, cubeSizeFor } from './cubenet.js';
import { themeColors } from './theme.js';
import { eventOf, modeOf } from './events.js';

export const SITE = 'tagdatimer.vercel.app';
export const SITE_URL = 'https://tagdatimer.vercel.app/';
export const INSTA = '@cubingngagng';
export const INSTA_URL = 'https://instagram.com/cubingngagng';

const W = 1080;
const MONO = "'JetBrains Mono', ui-monospace, monospace";
const SANS = "'Inter', system-ui, sans-serif";

/* ---------------------------------------------------------
   Small canvas helpers
   --------------------------------------------------------- */

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const hex = (c, a) => {
  const m = /^#?([0-9a-f]{6})$/i.exec((c || '').trim());
  if (!m) return `rgba(255,255,255,${a})`;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
};

/** Word-wrap `text` to `max` px, returning the lines. */
function wrap(ctx, text, max) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > max && line) { lines.push(line); line = w; }
    else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

/** Shrink the font until `text` fits on one line of `max` px. */
function fitOneLine(ctx, text, max, family, weight, start, min = 10) {
  let size = start;
  for (;;) {
    ctx.font = `${weight} ${size}px ${family}`;
    const w = ctx.measureText(text).width;
    if (w <= max || size <= min) return size;
    size = Math.max(min, Math.floor(size * Math.min(0.94, max / w)));
  }
}

/**
 * Fit text on one line, but stop shrinking at `floor` and clip instead.
 * A megaminx scramble squeezed to 9px is not "smaller", it is gone.
 */
function fitOrClip(ctx, text, max, family, weight, start, floor) {
  const size = fitOneLine(ctx, text, max, family, weight, start, floor);
  ctx.font = `${weight} ${size}px ${family}`;
  if (ctx.measureText(text).width <= max) return { text, size };
  let out = text;
  while (out.length > 4 && ctx.measureText(`${out}…`).width > max) {
    out = out.slice(0, Math.max(4, Math.floor(out.length * 0.92)));
  }
  return { text: `${out}…`, size };
}

/* ---------------------------------------------------------
   Shared furniture
   --------------------------------------------------------- */

function paintBackground(ctx, h, c) {
  const g = ctx.createLinearGradient(0, 0, W, h);
  g.addColorStop(0, c.bg2 || '#12102a');
  g.addColorStop(1, c.bg || '#07070c');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, h);

  // Two soft accent blooms, so the poster is not a flat rectangle.
  for (const [cx, cy, r, col, a] of [
    [W * 0.12, h * 0.08, W * 0.62, c.accent, 0.34],
    [W * 0.95, h * 0.86, W * 0.70, c.accent2, 0.24],
  ]) {
    const rg = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    rg.addColorStop(0, hex(col, a));
    rg.addColorStop(1, hex(col, 0));
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, W, h);
  }

  // Hairline frame — reads as a card rather than a screenshot.
  ctx.strokeStyle = hex(c.text, 0.10);
  ctx.lineWidth = 2;
  rr(ctx, 22, 22, W - 44, h - 44, 40);
  ctx.stroke();
}

function paintHeader(ctx, c, logo, kicker) {
  const y = 92;
  const x = logo ? 154 : 74;
  if (logo) ctx.drawImage(logo, 74, y - 34, 64, 64);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.font = `800 34px ${SANS}`;
  ctx.fillStyle = c.text;
  ctx.fillText('TAGDA', x, y);
  ctx.fillStyle = c.accent2;
  ctx.fillText(' TIMER', x + ctx.measureText('TAGDA ').width, y);

  ctx.textAlign = 'right';
  ctx.fillStyle = hex(c.text, 0.62);
  ctx.font = `600 26px ${SANS}`;
  ctx.fillText(kicker, W - 74, y);
  ctx.textAlign = 'left';
}

function paintFooter(ctx, h, c) {
  const y = h - 78;
  ctx.strokeStyle = hex(c.text, 0.10);
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(74, y - 46); ctx.lineTo(W - 74, y - 46); ctx.stroke();

  ctx.textBaseline = 'middle';
  ctx.font = `700 26px ${SANS}`;
  ctx.textAlign = 'left';
  ctx.fillStyle = hex(c.text, 0.78);
  ctx.fillText(SITE, 74, y);

  ctx.textAlign = 'right';
  ctx.fillStyle = c.accent2;
  ctx.fillText(INSTA, W - 74, y);
  ctx.textAlign = 'left';
}

/** Big label + huge number: the block the whole card is built around. */
function paintHero(ctx, c, y, label, value, sub) {
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillStyle = c.accent2;
  ctx.font = `700 30px ${SANS}`;
  ctx.letterSpacing = '6px';
  ctx.fillText(String(label).toUpperCase(), 74, y);
  ctx.letterSpacing = '0px';

  const size = fitOneLine(ctx, value, W - 148, MONO, 800, 190, 70);
  ctx.fillStyle = c.text;
  ctx.font = `800 ${size}px ${MONO}`;
  const heroY = y + 40 + size * 0.78;
  ctx.fillText(value, 74, heroY);

  let out = heroY + 20;
  if (sub) {
    ctx.fillStyle = hex(c.text, 0.55);
    ctx.font = `500 27px ${SANS}`;
    out += 26;
    ctx.fillText(sub, 74, out);
  }
  return out;
}

/** Boxed scramble block. Returns the y it ends at. */
function paintScramble(ctx, c, y, scramble, { title = 'SCRAMBLE', maxLines = 4, x = 74, width = W - 148, size: start = 30 } = {}) {
  const pad = 34;
  const boxW = width;
  let size = start;
  ctx.font = `500 ${size}px ${MONO}`;
  let lines = wrap(ctx, scramble, boxW - pad * 2);
  while (lines.length > maxLines && size > 16) {
    size -= 2;
    ctx.font = `500 ${size}px ${MONO}`;
    lines = wrap(ctx, scramble, boxW - pad * 2);
  }
  const lh = size * 1.45;
  const boxH = pad * 2 + 34 + lines.length * lh;

  ctx.fillStyle = hex(c.text, 0.055);
  rr(ctx, x, y, boxW, boxH, 26);
  ctx.fill();
  ctx.strokeStyle = hex(c.text, 0.09);
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.textBaseline = 'top';
  ctx.fillStyle = hex(c.text, 0.42);
  ctx.font = `700 20px ${SANS}`;
  ctx.letterSpacing = '4px';
  ctx.fillText(title, x + pad, y + pad);
  ctx.letterSpacing = '0px';

  ctx.fillStyle = c.text;
  ctx.font = `500 ${size}px ${MONO}`;
  lines.forEach((ln, i) => ctx.fillText(ln, x + pad, y + pad + 34 + i * lh));
  ctx.textBaseline = 'alphabetic';
  return y + boxH;
}

let _logo;
async function logoImage() {
  if (_logo !== undefined) return _logo;
  _logo = await new Promise((res) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => res(null);
    img.src = new URL('../assets/logo-192.png', import.meta.url).href;
  });
  return _logo;
}

/** Canvas text silently falls back to a system face unless the webfonts are in. */
async function fontsReady() {
  try { await document.fonts?.ready; } catch { /* not fatal, just less pretty */ }
}

/* ---------------------------------------------------------
   Card 1 — one solve: time, scramble, and the cube it makes
   --------------------------------------------------------- */

export async function drawSolveCard(solve, { index = null } = {}) {
  await fontsReady();
  const c = themeColors();
  const logo = await logoImage();
  const H = 1350;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');

  const ev = eventOf(solve.event);
  const mode = modeOf(solve.mode);
  paintBackground(ctx, H, c);
  paintHeader(ctx, c, logo, index ? `SOLVE #${index}` : ev.short);

  const value = eff(solve) === DNF ? 'DNF' : fmt(eff(solve));
  const bits = [ev.name];
  if (mode && mode.kind !== 'wca') bits.push(mode.name);
  bits.push(fmtDate(solve.createdAt));
  if (solve.penalty === '+2') bits.push('+2 penalty');

  let y = paintHero(ctx, c, 250, solve.caseName || 'single', value, bits.join('  ·  '));

  const n = cubeSizeFor(solve.event);
  const netH = n ? 300 : 0;
  y = paintScramble(ctx, c, y + 46, (solve.scramble || '—').replace(/\n/g, ' '), { maxLines: n ? 3 : 9 });

  if (n) {
    const top = y + 44;
    drawNet(ctx, faceletsFor(solve.scramble, n), n, 74, top, W - 148, netH);
    y = top + netH;
  }

  if (solve.comment) {
    ctx.fillStyle = hex(c.text, 0.5);
    ctx.font = `italic 500 26px ${SANS}`;
    wrap(ctx, `"${solve.comment}"`, W - 148).slice(0, 2)
      .forEach((ln, i) => ctx.fillText(ln, 74, y + 56 + i * 34));
  }

  paintFooter(ctx, H, c);
  return cv;
}

/* ---------------------------------------------------------
   Card 3 — a reconstruction: the scramble, the cube it makes,
   and the solution written out phase by phase
   --------------------------------------------------------- */

export async function drawReconCard({ scramble = '', title = 'Reconstruction', steps = [], moves = 0 } = {}) {
  await fontsReady();
  const c = themeColors();
  const logo = await logoImage();

  const shown = steps.slice(0, 18);
  const spare = steps.length - shown.length;

  const paint = (ctx, H) => {
    paintBackground(ctx, H, c);
    paintHeader(ctx, c, logo, 'RECONSTRUCTION');

    /* The move count and the scramble share the top band. The count used to be
       190px tall on its own line, which pushed the scramble and the cube down
       the card and left a third of the width empty beside it. */
    const top = 214;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillStyle = c.accent2;
    ctx.font = `700 26px ${SANS}`;
    ctx.letterSpacing = '5px';
    ctx.fillText(String(title).toUpperCase(), 74, top + 26);
    ctx.letterSpacing = '0px';

    const numSize = 104;
    ctx.fillStyle = c.text;
    ctx.font = `800 ${numSize}px ${MONO}`;
    ctx.fillText(String(moves), 74, top + 26 + 44 + numSize * 0.76);
    ctx.fillStyle = hex(c.text, 0.55);
    ctx.font = `500 24px ${SANS}`;
    ctx.fillText(`${moves === 1 ? 'move' : 'moves'}  ·  ${steps.length} step${steps.length === 1 ? '' : 's'}`,
      74, top + 26 + 44 + numSize * 0.76 + 40);
    const leftBottom = top + 26 + 44 + numSize * 0.76 + 60;

    const scrX = 420;
    const scrBottom = paintScramble(ctx, c, top, (scramble || '—').replace(/\s+/g, ' '),
      { x: scrX, width: W - 74 - scrX, maxLines: 7, size: 25 });

    let y = Math.max(leftBottom, scrBottom);

    // The cube the scramble actually leaves you — the thing the solution
    // below is a solution to.
    const netH = 270;
    drawNet(ctx, faceletsFor(scramble, 3), 3, 74, y + 34, W - 148, netH);
    y = y + 34 + netH;

    /* One row per phase, and a row wraps rather than shrinking to nothing:
       all four pairs on one F2L line is thirty moves, and 12px type is not a
       smaller reconstruction, it is an unreadable one. */
    const pad = 34;
    const boxW = W - 148;
    const boxTop = y + 40;
    const labelW = 150;
    const algMax = boxW - pad * 2 - labelW;
    const algSize = shown.length > 8 ? 24 : 27;
    const lh = algSize * 1.42;

    ctx.font = `500 ${algSize}px ${MONO}`;
    const rows = shown.map(st => ({ ...st, lines: wrap(ctx, st.alg, algMax) }));
    const rowGap = 14;
    const rowsH = rows.reduce((n, r) => n + r.lines.length * lh + rowGap, 0);
    const boxH = pad * 2 + 40 + rowsH + (spare ? 40 : 0);

    ctx.fillStyle = hex(c.text, 0.055);
    rr(ctx, 74, boxTop, boxW, boxH, 26);
    ctx.fill();
    ctx.strokeStyle = hex(c.text, 0.09);
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.textBaseline = 'top';
    ctx.fillStyle = hex(c.text, 0.42);
    ctx.font = `700 20px ${SANS}`;
    ctx.letterSpacing = '4px';
    ctx.fillText('SOLUTION', 74 + pad, boxTop + pad);
    ctx.letterSpacing = '0px';

    let ry = boxTop + pad + 40;
    rows.forEach((r, i) => {
      ctx.fillStyle = c.accent2;
      ctx.font = `700 21px ${SANS}`;
      ctx.letterSpacing = '2px';
      ctx.fillText(String(r.phase || '').toUpperCase(), 74 + pad, ry + 4);
      ctx.letterSpacing = '0px';

      ctx.fillStyle = c.text;
      ctx.font = `500 ${algSize}px ${MONO}`;
      r.lines.forEach((ln, k) => ctx.fillText(ln, 74 + pad + labelW, ry + k * lh));

      ry += r.lines.length * lh + rowGap;
      /* A rule only where the heading changes. The four F2L lines are one
         thing with four goes at it, so they read as a block rather than as
         four unrelated rows. */
      if (i < rows.length - 1 && rows[i + 1].phase) {
        ctx.strokeStyle = hex(c.text, 0.07);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(74 + pad, ry - rowGap / 2);
        ctx.lineTo(74 + boxW - pad, ry - rowGap / 2);
        ctx.stroke();
      }
    });
    if (spare) {
      ctx.fillStyle = hex(c.text, 0.45);
      ctx.font = `500 22px ${SANS}`;
      ctx.fillText(`+ ${spare} more step${spare === 1 ? '' : 's'}`, 74 + pad, ry);
    }
    ctx.textBaseline = 'alphabetic';

    paintFooter(ctx, H, c);
    return boxTop + boxH;
  };

  /* A reconstruction is as long as it is, so the card is painted once on a
     scratch canvas to find out where it ends, then painted again at exactly
     that height. Guessing put the footer on top of the last row. */
  const scratch = document.createElement('canvas');
  scratch.width = W; scratch.height = 4200;
  const bottom = paint(scratch.getContext('2d'), 4200);

  const H = Math.max(1200, Math.round(bottom + 150));
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  paint(cv.getContext('2d'), H);
  return cv;
}

/* ---------------------------------------------------------
   Card 2 — an average: the counting times and their scrambles
   --------------------------------------------------------- */

export async function drawAverageCard(solves, { label = 'average of 5', value = '—', trimmed = null } = {}) {
  await fontsReady();
  const c = themeColors();
  const logo = await logoImage();

  // Height follows the row count, so an ao12 is not an ao5 card with a hole in it.
  const rowH = solves.length > 8 ? 74 : 92;
  const H = Math.max(1080, 470 + solves.length * rowH + 190);
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');

  const ev = eventOf(solves[0]?.event);
  paintBackground(ctx, H, c);
  paintHeader(ctx, c, logo, ev.short);

  const y0 = paintHero(ctx, c, 250, label, value,
    `${solves.length} solves  ·  ${fmtDate(solves.at(-1).createdAt)}`);

  let y = y0 + 56;
  ctx.textBaseline = 'middle';
  const numW = 54;
  const timeW = 210;
  const scrX = 74 + numW + timeW;
  const scrMax = W - 74 - scrX - 22;

  solves.forEach((s, i) => {
    const cy = y + rowH / 2;
    const isTrim = !!trimmed?.has(i);
    const v = eff(s);
    const t = v === DNF ? 'DNF' : fmt(v) + (s.penalty === '+2' ? '+' : '');

    if (i % 2 === 0) {
      ctx.fillStyle = hex(c.text, 0.04);
      rr(ctx, 74, y, W - 148, rowH - 8, 18);
      ctx.fill();
    }

    ctx.textAlign = 'left';
    ctx.fillStyle = hex(c.text, 0.34);
    ctx.font = `600 24px ${MONO}`;
    ctx.fillText(String(i + 1).padStart(2, '0'), 74 + 22, cy);

    // Trimmed solves are parenthesised, exactly as results are written up —
    // the number is there, it just did not count.
    ctx.fillStyle = isTrim ? hex(c.text, 0.42) : c.text;
    ctx.font = `${isTrim ? 600 : 800} ${rowH > 80 ? 40 : 34}px ${MONO}`;
    ctx.fillText(isTrim ? `(${t})` : t, 74 + numW + 12, cy);

    const raw = (s.scramble || '—').replace(/\n/g, ' ');
    const fitted = fitOrClip(ctx, raw, scrMax, MONO, 500, rowH > 80 ? 22 : 19, 14);
    ctx.fillStyle = hex(c.text, 0.5);
    ctx.font = `500 ${fitted.size}px ${MONO}`;
    ctx.fillText(fitted.text, scrX, cy);

    y += rowH;
  });

  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  paintFooter(ctx, H, c);
  return cv;
}

/* ---------------------------------------------------------
   Export helpers
   --------------------------------------------------------- */

export function canvasBlob(canvas) {
  return new Promise((res) => canvas.toBlob(res, 'image/png'));
}

export function shareText(kind, value) {
  return `${kind} — ${value} on Tagda Timer`;
}

/** Social links that work from a plain <a>: no SDKs, no tracking. */
export function socialLinks(text) {
  const t = encodeURIComponent(`${text} ${SITE_URL}`);
  const u = encodeURIComponent(SITE_URL);
  return [
    { name: 'X', href: `https://twitter.com/intent/tweet?text=${t}` },
    { name: 'WhatsApp', href: `https://wa.me/?text=${t}` },
    { name: 'Telegram', href: `https://t.me/share/url?url=${u}&text=${encodeURIComponent(text)}` },
    { name: 'Reddit', href: `https://www.reddit.com/submit?url=${u}&title=${encodeURIComponent(text)}` },
  ];
}
