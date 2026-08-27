/* ===========================================================
   Tagda Timer — hand-built SVG charts
   No chart library: full control over theming and animation.
   =========================================================== */

import { eff, DNF, rollingSeries } from './stats.js';
import { fmt, dayKey } from './util.js';

const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) n.setAttribute(k, v);
  return n;
};

const path = (pts) => pts.length ? 'M' + pts.map(p => `${p[0].toFixed(2)} ${p[1].toFixed(2)}`).join(' L ') : '';

/** Length of the polyline `path()` draws through these points. */
function polylineLength(pts) {
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  }
  return len;
}

/* ---------------------------------------------------------
   Sparkline in the stats panel
   --------------------------------------------------------- */
export function renderMiniTrend(svg, solves) {
  svg.innerHTML = '';
  const W = 300, H = 84, pad = 4;
  const pts = solves.map(eff).filter(v => v !== DNF);
  if (pts.length < 2) {
    svg.append(svgEl('text', { x: W / 2, y: H / 2 + 3, 'text-anchor': 'middle', class: 'axis-txt' }));
    svg.lastChild.textContent = 'need 2+ solves';
    return;
  }
  const recent = solves.slice(-60);
  const vals = recent.map(eff);
  const finite = vals.filter(v => v !== DNF);
  const min = Math.min(...finite), max = Math.max(...finite);
  const span = (max - min) || 1;
  const x = i => pad + (i / Math.max(1, recent.length - 1)) * (W - pad * 2);
  const y = v => H - pad - ((v - min) / span) * (H - pad * 2);

  const defs = svgEl('defs');
  const grad = svgEl('linearGradient', { id: 'sparkGrad', x1: '0', y1: '0', x2: '0', y2: '1' });
  grad.append(svgEl('stop', { offset: '0%',   'stop-color': 'var(--accent)', 'stop-opacity': '.34' }));
  grad.append(svgEl('stop', { offset: '100%', 'stop-color': 'var(--accent)', 'stop-opacity': '0' }));
  defs.append(grad); svg.append(defs);

  const line = [];
  vals.forEach((v, i) => { if (v !== DNF) line.push([x(i), y(v)]); });

  const area = svgEl('path', {
    class: 'spark-area',
    d: `${path(line)} L ${x(recent.length - 1)} ${H - pad} L ${x(0)} ${H - pad} Z`,
  });
  svg.append(area);

  const p = svgEl('path', { class: 'spark-line', d: path(line) });
  svg.append(p);
  // `path()` only ever emits straight segments, so summing them is exactly what
  // getTotalLength() would return — without flushing layout for the whole page.
  // That flush is charged for every row in the times strip, and the strip now
  // runs back to the first solve of the session, so it was costing half a
  // second per render on a long one.
  const len = polylineLength(line);
  if (len) {
    p.style.strokeDasharray = len; p.style.strokeDashoffset = len;
    p.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }],
      { duration: 700, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'forwards' });
  }

  // rolling ao5 overlay
  if (recent.length >= 5) {
    const ao = rollingSeries(recent, 5);
    const aoPts = [];
    ao.forEach((v, i) => { if (v !== null) aoPts.push([x(i), y(v)]); });
    if (aoPts.length > 1) svg.append(svgEl('path', { class: 'spark-ao', d: path(aoPts) }));
  }

  // PB line
  const pb = Math.min(...finite);
  svg.append(svgEl('line', { class: 'spark-pb', x1: pad, x2: W - pad, y1: y(pb), y2: y(pb) }));

  const lastIdx = vals.length - 1;
  if (vals[lastIdx] !== DNF) {
    svg.append(svgEl('circle', { class: 'spark-dot', cx: x(lastIdx), cy: y(vals[lastIdx]), r: 2.6 }));
  }
}

/* ---------------------------------------------------------
   Full trend chart (stats drawer) with hover scrub
   --------------------------------------------------------- */
export function renderTrend(host, solves, onHover) {
  host.innerHTML = '';
  const W = 660, H = 210, L = 46, R = 10, T = 12, B = 22;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}` });
  if (solves.length < 2) { host.append(hint('Not enough solves yet')); return; }

  const vals = solves.map(eff);
  const finite = vals.filter(v => v !== DNF);
  const min = Math.min(...finite), max = Math.max(...finite);
  const pad = (max - min) * 0.12 || 500;
  const lo = Math.max(0, min - pad), hi = max + pad;
  const x = i => L + (i / Math.max(1, solves.length - 1)) * (W - L - R);
  const y = v => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);

  // y grid
  for (let i = 0; i <= 3; i++) {
    const v = lo + (hi - lo) * (i / 3);
    const yy = y(v);
    svg.append(svgEl('line', { class: 'axis-line', x1: L, x2: W - R, y1: yy, y2: yy, opacity: .45 }));
    const t = svgEl('text', { class: 'axis-txt', x: L - 6, y: yy + 3, 'text-anchor': 'end' });
    t.textContent = fmt(v); svg.append(t);
  }

  const defs = svgEl('defs');
  const g = svgEl('linearGradient', { id: 'trendGrad', x1: '0', y1: '0', x2: '0', y2: '1' });
  g.append(svgEl('stop', { offset: '0%', 'stop-color': 'var(--accent)', 'stop-opacity': '.3' }));
  g.append(svgEl('stop', { offset: '100%', 'stop-color': 'var(--accent)', 'stop-opacity': '0' }));
  defs.append(g); svg.append(defs);

  const line = [];
  vals.forEach((v, i) => { if (v !== DNF) line.push([x(i), y(v)]); });
  svg.append(svgEl('path', { d: `${path(line)} L ${x(solves.length - 1)} ${H - B} L ${x(0)} ${H - B} Z`, fill: 'url(#trendGrad)' }));
  svg.append(svgEl('path', { class: 'spark-line', d: path(line), 'stroke-width': 1.8 }));

  for (const [n, cls] of [[5, 'spark-ao'], [12, 'spark-ao']]) {
    if (solves.length < n) continue;
    const ser = rollingSeries(solves, n);
    const pts = [];
    ser.forEach((v, i) => { if (v !== null) pts.push([x(i), y(v)]); });
    if (pts.length > 1) svg.append(svgEl('path', {
      class: cls, d: path(pts),
      stroke: n === 5 ? 'var(--accent-2)' : 'var(--warn)',
      'stroke-dasharray': n === 5 ? '4 3' : '1 4', opacity: .9,
    }));
  }

  const pb = Math.min(...finite);
  svg.append(svgEl('line', { class: 'spark-pb', x1: L, x2: W - R, y1: y(pb), y2: y(pb) }));

  // DNF markers
  vals.forEach((v, i) => {
    if (v === DNF) svg.append(svgEl('line', { x1: x(i), x2: x(i), y1: T, y2: H - B, stroke: 'var(--danger)', 'stroke-width': 1, opacity: .35 }));
  });

  // hover
  const cursor = svgEl('line', { x1: 0, x2: 0, y1: T, y2: H - B, stroke: 'var(--text-faint)', 'stroke-width': 1, opacity: 0 });
  const dot = svgEl('circle', { r: 3.5, fill: 'var(--accent)', opacity: 0 });
  svg.append(cursor, dot);
  const hit = svgEl('rect', { x: L, y: T, width: W - L - R, height: H - T - B, fill: 'transparent' });
  svg.append(hit);
  hit.addEventListener('mousemove', (e) => {
    const box = svg.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    const i = Math.round(((px - L) / (W - L - R)) * (solves.length - 1));
    const idx = Math.max(0, Math.min(solves.length - 1, i));
    cursor.setAttribute('x1', x(idx)); cursor.setAttribute('x2', x(idx)); cursor.setAttribute('opacity', .6);
    if (vals[idx] !== DNF) { dot.setAttribute('cx', x(idx)); dot.setAttribute('cy', y(vals[idx])); dot.setAttribute('opacity', 1); }
    else dot.setAttribute('opacity', 0);
    onHover?.(solves[idx], idx);
  });
  hit.addEventListener('mouseleave', () => {
    cursor.setAttribute('opacity', 0); dot.setAttribute('opacity', 0); onHover?.(null);
  });

  host.append(svg);
}

/* ---------------------------------------------------------
   Distribution histogram
   --------------------------------------------------------- */
export function renderHistogram(host, solves) {
  host.innerHTML = '';
  const vals = solves.map(eff).filter(v => v !== DNF);
  if (vals.length < 4) { host.append(hint('Not enough solves yet')); return; }
  const W = 660, H = 150, L = 8, R = 8, T = 8, B = 20;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}` });
  const min = Math.min(...vals), max = Math.max(...vals);
  const bins = Math.min(22, Math.max(6, Math.round(Math.sqrt(vals.length))));
  const span = (max - min) || 1;
  const counts = new Array(bins).fill(0);
  for (const v of vals) counts[Math.min(bins - 1, Math.floor(((v - min) / span) * bins))]++;
  const peak = Math.max(...counts);
  const bw = (W - L - R) / bins;

  counts.forEach((c, i) => {
    const h = (c / peak) * (H - T - B);
    const rect = svgEl('rect', {
      class: 'bar', x: L + i * bw + 1.2, y: H - B - h,
      width: bw - 2.4, height: h, rx: 3,
    });
    rect.style.transformOrigin = `0 ${H - B}px`;
    rect.animate([{ transform: 'scaleY(0)' }, { transform: 'scaleY(1)' }],
      { duration: 520, delay: i * 18, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'backwards' });
    const title = svgEl('title'); title.textContent = `${c} solve${c === 1 ? '' : 's'}`;
    rect.append(title);
    svg.append(rect);
  });

  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const mx = L + ((mean - min) / span) * (W - L - R);
  svg.append(svgEl('line', { x1: mx, x2: mx, y1: T, y2: H - B, stroke: 'var(--accent-2)', 'stroke-width': 1.4, 'stroke-dasharray': '3 3' }));

  for (const [v, anchor] of [[min, 'start'], [max, 'end']]) {
    const t = svgEl('text', { class: 'axis-txt', x: v === min ? L : W - R, y: H - 5, 'text-anchor': anchor });
    t.textContent = fmt(v); svg.append(t);
  }
  host.append(svg);
}

/* ---------------------------------------------------------
   GitHub-style solve heatmap (last ~26 weeks)
   --------------------------------------------------------- */
export function renderHeatmap(host, solves) {
  host.innerHTML = '';
  const WEEKS = 26, CELL = 11, GAP = 3;
  const counts = new Map();
  for (const s of solves) counts.set(dayKey(s.createdAt), (counts.get(dayKey(s.createdAt)) || 0) + 1);
  const max = Math.max(1, ...counts.values());

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - (WEEKS * 7 - 1) - today.getDay());

  const W = WEEKS * (CELL + GAP), H = 7 * (CELL + GAP) + 14;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}` });
  let streak = 0, cur = 0;

  for (let w = 0; w < WEEKS; w++) {
    for (let d = 0; d < 7; d++) {
      const day = new Date(start);
      day.setDate(start.getDate() + w * 7 + d);
      if (day > today) continue;
      const k = dayKey(day.getTime());
      const c = counts.get(k) || 0;
      if (c > 0) { cur++; streak = Math.max(streak, cur); } else cur = 0;
      const alpha = c === 0 ? 0.05 : 0.22 + 0.78 * Math.min(1, Math.log(1 + c) / Math.log(1 + max));
      const cell = svgEl('rect', {
        class: 'hm-cell', x: w * (CELL + GAP), y: d * (CELL + GAP),
        width: CELL, height: CELL,
        fill: c === 0 ? 'var(--text)' : 'var(--accent)',
        'fill-opacity': alpha,
      });
      const t = svgEl('title');
      t.textContent = `${k}: ${c} solve${c === 1 ? '' : 's'}`;
      cell.append(t);
      svg.append(cell);
    }
  }
  const lbl = svgEl('text', { class: 'axis-txt', x: 0, y: H - 2 });
  lbl.textContent = `${counts.size} active days · longest streak ${streak}`;
  svg.append(lbl);
  host.append(svg);
}

/* ---------------------------------------------------------
   Per-case bars (trainer modes)
   --------------------------------------------------------- */
export function renderCaseBars(host, rows) {
  host.innerHTML = '';
  const valid = rows.filter(r => r.avg !== null).sort((a, b) => b.avg - a.avg);
  if (!valid.length) { host.append(hint('No trainer solves in this session yet')); return; }
  const show = valid.slice(0, 16);
  const max = show[0].avg;
  const RH = 22, W = 660, H = show.length * RH + 6;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}` });
  show.forEach((r, i) => {
    const w = (r.avg / max) * (W - 150);
    const y = i * RH;
    const bar = svgEl('rect', {
      x: 62, y: y + 4, width: Math.max(2, w), height: RH - 9, rx: 4,
      fill: i === 0 ? 'var(--danger)' : i < 3 ? 'var(--warn)' : 'var(--accent)', 'fill-opacity': .78,
    });
    bar.animate([{ width: 0 }, { width: Math.max(2, w) }],
      { duration: 560, delay: i * 26, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'backwards' });
    const name = svgEl('text', { class: 'axis-txt', x: 0, y: y + RH / 2 + 3, fill: 'var(--text-dim)' });
    name.textContent = r.name.length > 12 ? r.name.slice(0, 12) + '…' : r.name;
    const val = svgEl('text', { class: 'axis-txt', x: 68 + Math.max(2, w), y: y + RH / 2 + 3 });
    val.textContent = `${fmt(r.avg)}  (${r.count})`;
    svg.append(bar, name, val);
  });
  host.append(svg);
}

function hint(text) {
  const d = document.createElement('div');
  d.className = 'hint-note';
  d.textContent = text;
  return d;
}
