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

/**
 * A key for a chart that draws more than one thing.
 *
 * Not optional decoration: the trend plots the solve line, a rolling ao5, a
 * rolling ao12 and the PB, and told apart only by colour and dash pattern that
 * is four unlabelled squiggles. Anything with two or more series says which is
 * which, in text, in the ink colours rather than the series colours.
 */
function legend(items) {
  const row = document.createElement('div');
  row.className = 'chart-legend';
  for (const it of items) {
    const key = document.createElement('span');
    key.className = 'lg-item';
    const swatch = document.createElement('span');
    swatch.className = 'lg-swatch';
    swatch.style.setProperty('--lg-color', it.color);
    if (it.dash) swatch.dataset.dash = it.dash;
    key.append(swatch, document.createTextNode(it.label));
    row.append(key);
  }
  return row;
}

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
  const keys = [{ color: 'var(--accent)', label: 'solve' }];
  if (solves.length >= 5)  keys.push({ color: 'var(--accent-2)', label: 'ao5', dash: 'dashed' });
  if (solves.length >= 12) keys.push({ color: 'var(--warn)', label: 'ao12', dash: 'dotted' });
  keys.push({ color: 'var(--gold)', label: 'PB', dash: 'dotted' });
  if (vals.includes(DNF)) keys.push({ color: 'var(--danger)', label: 'DNF' });
  host.append(legend(keys));
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
  svg.append(svgEl('line', {
    x1: mx, x2: mx, y1: T, y2: H - B,
    stroke: 'var(--accent-2)', 'stroke-width': 1.4, 'stroke-dasharray': '3 3',
  }));

  for (const [v, anchor] of [[min, 'start'], [max, 'end']]) {
    const t = svgEl('text', { class: 'axis-txt', x: v === min ? L : W - R, y: H - 5, 'text-anchor': anchor });
    t.textContent = fmt(v); svg.append(t);
  }
  host.append(svg);
  // The tallest bar is the only number worth stating outright; the rest are
  // read by comparison, and a label on every bar is noise.
  host.append(legend([
    { color: 'var(--accent)', label: `${bins} bins · busiest ${peak} solve${peak === 1 ? '' : 's'}` },
    { color: 'var(--accent-2)', label: `mean ${fmt(mean)}`, dash: 'dashed' },
  ]));
}

/* ---------------------------------------------------------
   Practice heatmap - a year of days, laid out by month

   Reads like LeetCode's: weeks are columns, weekdays are rows, and a busier
   day is a stronger cell. Month names run along the top with a hairline where
   each new month opens, so the year is scannable month by month rather than as
   one undifferentiated wall of squares.
   --------------------------------------------------------- */

const DAY_MS = 86400000;
const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
/** Whole days between two local midnights, immune to the DST hour. */
const daysBetween = (a, b) => Math.round((b - a) / DAY_MS);

/**
 * Five levels, cut at quartiles of the days that actually have solves.
 *
 * Neither a fixed nor a log scale survives real data here: a session log runs
 * from one solve to a few hundred on a big day, and any absolute scale pins
 * almost every ordinary day into the same faint step - which is how "darker
 * means more" stops meaning anything. Quartiles of the non-empty days spend
 * all four levels on the range that actually exists.
 */
function levelScale(counts) {
  const nz = [...counts.values()].filter(c => c > 0).sort((a, b) => a - b);
  if (!nz.length) return () => 0;
  const q = (f) => nz[Math.min(nz.length - 1, Math.floor(f * nz.length))];
  const t1 = q(0.25), t2 = q(0.5), t3 = q(0.75);
  return (c) => c === 0 ? 0 : c <= t1 ? 1 : c <= t2 ? 2 : c <= t3 ? 3 : 4;
}

/* Level 0 is a recessive tint of the text colour, so an empty day still reads
   as a cell rather than a hole. Levels 1-4 are one hue at rising strength,
   which is what a magnitude scale has to be - a second hue at the top end
   would make it a category scale and stop it reading as an ordering. */
const LEVEL_FILL    = ['var(--text)', 'var(--accent)', 'var(--accent)', 'var(--accent)', 'var(--accent)'];
const LEVEL_OPACITY = [0.07, 0.3, 0.52, 0.76, 1];

const longDate = (d) => d.toLocaleDateString(undefined,
  { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

export function renderHeatmap(host, solves, { months = 12 } = {}) {
  host.innerHTML = '';

  const CELL = 11, GAP = 3, PITCH = CELL + GAP;
  const GUTTER = 26;   // weekday labels
  const HEAD = 16;     // month labels
  const FOOT = 30;     // legend + summary

  const today = startOfDay(new Date());
  /* The grid runs to the Saturday of the current week, so today always has a
     cell of its own. The old window ended on the *Sunday* of the current week,
     which silently hid everything solved since - up to six days of it, today's
     solves included. That is why a fresh session never lit anything up. */
  const end = addDays(today, 6 - today.getDay());
  const from = new Date(today);
  from.setMonth(from.getMonth() - months);
  from.setDate(from.getDate() + 1);
  const start = addDays(from, -from.getDay());          // back to that week's Sunday
  const weeks = Math.ceil((daysBetween(start, end) + 1) / 7);

  const counts = new Map();
  let total = 0;
  for (const s of solves) {
    const d = startOfDay(s.createdAt);
    if (d < start || d > end) continue;
    const k = dayKey(s.createdAt);
    counts.set(k, (counts.get(k) || 0) + 1);
    total++;
  }
  const levelOf = levelScale(counts);

  const W = GUTTER + weeks * PITCH, H = HEAD + 7 * PITCH + FOOT;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'heatmap' });

  /* ---- month labels, and the hairline that opens each month ----
     Work out where each month starts first, then label. Labelling inside the
     column loop cannot know how much room a month has, and the window always
     opens partway through one — so the leading month gets a column or two and
     its name lands on top of the next month's. Knowing each month's span lets
     the truncated one at the start go unlabelled, which is the one nobody
     needs, rather than dropping whichever name happened to come second. */
  const runs = [];
  let prevMonth = -1;
  for (let w = 0; w < weeks; w++) {
    /* Attribute a column to the month it mostly sits in, so a week straddling
       a boundary does not open the new month a week early. */
    const mid = addDays(start, w * 7 + 3);
    if (mid.getMonth() === prevMonth) continue;
    prevMonth = mid.getMonth();
    runs.push({ col: w, date: mid });
  }
  runs.forEach((run, i) => {
    const span = (i + 1 < runs.length ? runs[i + 1].col : weeks) - run.col;
    const x = GUTTER + run.col * PITCH;
    if (span >= 2) {
      const t = svgEl('text', { class: 'hm-month', x, y: HEAD - 5 });
      t.textContent = MONTH_NAMES[run.date.getMonth()]
        + (run.date.getMonth() === 0 ? ` ${String(run.date.getFullYear()).slice(2)}` : '');
      svg.append(t);
    }
    // The divider is one pixel wide and never collides, so every month keeps
    // its boundary even when there is no room for the word.
    if (i > 0) svg.append(svgEl('line', {
      class: 'hm-divider',
      x1: x - GAP / 2, x2: x - GAP / 2,
      y1: HEAD - 1, y2: HEAD + 7 * PITCH - GAP,
    }));
  });

  /* ---- weekday gutter ---- */
  for (const [row, label] of [[1, 'Mon'], [3, 'Wed'], [5, 'Fri']]) {
    const t = svgEl('text', {
      class: 'hm-day', x: GUTTER - 7, y: HEAD + row * PITCH + CELL - 1, 'text-anchor': 'end',
    });
    t.textContent = label;
    svg.append(t);
  }

  /* ---- cells ---- */
  let activeDays = 0, longest = 0, run = 0, runToday = 0, runYesterday = 0;
  for (let w = 0; w < weeks; w++) {
    for (let d = 0; d < 7; d++) {
      const day = addDays(start, w * 7 + d);
      if (day > today) continue;              // the rest of this week is not history yet
      const k = dayKey(day.getTime());
      const c = counts.get(k) || 0;
      if (c > 0) { activeDays++; run++; longest = Math.max(longest, run); } else run = 0;
      const back = daysBetween(day, today);
      if (back === 0) runToday = run;
      if (back === 1) runYesterday = run;

      const lv = levelOf(c);
      const cell = svgEl('rect', {
        class: 'hm-cell', 'data-level': lv,
        x: GUTTER + w * PITCH, y: HEAD + d * PITCH,
        width: CELL, height: CELL,
        fill: LEVEL_FILL[lv], 'fill-opacity': LEVEL_OPACITY[lv],
      });
      const t = svgEl('title');
      t.textContent = c
        ? `${c} solve${c === 1 ? '' : 's'} - ${longDate(day)}`
        : `No solves - ${longDate(day)}`;
      cell.append(t);
      svg.append(cell);
    }
  }
  /* A streak is still alive on a day you have not solved yet, so an empty
     today falls back to the run that ended yesterday rather than reading 0. */
  const current = runToday || runYesterday;

  /* ---- legend: a magnitude scale has to say which end is which ---- */
  const legY = HEAD + 7 * PITCH + 12;
  const legW = 5 * (CELL + 2);
  const legX = W - legW - 34;
  const less = svgEl('text', { class: 'hm-key', x: legX - 6, y: legY + CELL - 1, 'text-anchor': 'end' });
  less.textContent = 'Less';
  svg.append(less);
  for (let lv = 0; lv < 5; lv++) {
    svg.append(svgEl('rect', {
      class: 'hm-cell', 'data-level': lv,
      x: legX + lv * (CELL + 2), y: legY, width: CELL, height: CELL,
      fill: LEVEL_FILL[lv], 'fill-opacity': LEVEL_OPACITY[lv],
    }));
  }
  const more = svgEl('text', { class: 'hm-key', x: legX + legW + 2, y: legY + CELL - 1 });
  more.textContent = 'More';
  svg.append(more);

  /* ---- summary, counted over exactly the range that is drawn ---- */
  const sum = svgEl('text', { class: 'hm-key', x: GUTTER, y: legY + CELL - 1 });
  sum.textContent = `${total.toLocaleString()} solves \u00b7 ${activeDays} active day${activeDays === 1 ? '' : 's'}`
    + ` \u00b7 streak ${current}, best ${longest}`;
  svg.append(sum);

  host.append(svg);
  // Land on the present. A year of weeks overflows a narrow drawer, and the
  // half anyone wants to see first is the recent end.
  host.scrollLeft = host.scrollWidth;
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
