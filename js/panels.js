/* ===========================================================
   Tagda Timer — drawer contents
   Appearance · Settings · Statistics · All solves · Shortcuts · Cases
   Every control writes straight into app.settings and applies live.
   =========================================================== */

import { $, el, fmt, fmtDate, download } from './util.js';
import { PRESETS, TIMER_FONTS, exportTheme, importTheme } from './theme.js';
import { SHADER_NAMES } from './bg.js';
import { summarize, byCase, eff, DNF, bestAvg, currentAvg, trimmedIndices, bestSingle } from './stats.js';
import { renderTrend, renderHistogram, renderHeatmap, renderCaseBars } from './charts.js';
import { MODES, EVENTS } from './events.js';
import { setFor } from './scramble.js';
import { toast, confirmToast } from './toast.js';
import { exportAll, importAll, Assets, Solves } from './db.js';

/* ---------------- drawer shell ---------------- */

let current = null;

export function openDrawer(title, buildFn, { wide = false } = {}) {
  const drawer = $('#drawer'), scrim = $('#scrim'), body = $('#drawer-body');
  $('#drawer-title').textContent = title;
  drawer.classList.toggle('wide', wide);
  body.innerHTML = '';
  buildFn(body);
  drawer.hidden = false; scrim.hidden = false;
  current = title;
  body.scrollTop = 0;
}

export function closeDrawer() {
  const drawer = $('#drawer');
  // Same reason as the palette: a focused control inside a hidden drawer
  // would swallow every keyboard shortcut.
  if (drawer.contains(document.activeElement)) document.activeElement.blur();
  drawer.hidden = true;
  $('#scrim').hidden = true;
  current = null;
}

export const drawerOpen = () => current !== null;
export const drawerName = () => current;

/* ---------------- small builders ---------------- */

const group = (title, ...kids) => el('div', { class: 'group' }, el('h3', { text: title }), ...kids);

function row(label, control, sub) {
  const lbl = el('div', { class: 'lbl' }, el('span', { text: label }), sub ? el('span', { class: 'sub', text: sub }) : null);
  return el('div', { class: 'row' }, lbl, control);
}

function toggle(value, onChange) {
  const input = el('input', { type: 'checkbox' });
  input.checked = !!value;
  input.addEventListener('change', () => onChange(input.checked));
  return el('label', { class: 'switch' }, input, el('span', { class: 'track' }), el('span', { class: 'thumb' }));
}

function select(options, value, onChange) {
  const s = el('select', { class: 'inp' });
  for (const o of options) {
    const opt = el('option', { value: o.value ?? o }, o.label ?? o);
    if ((o.value ?? o) === value) opt.selected = true;
    s.append(opt);
  }
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

function slider(value, min, max, step, onChange, fmtVal = v => v) {
  const out = el('span', { class: 'range-val', text: fmtVal(value) });
  const r = el('input', { type: 'range', min, max, step, value });
  r.addEventListener('input', () => { out.textContent = fmtVal(+r.value); onChange(+r.value); });
  return el('div', { class: 'range-row' }, r, out);
}

function chips(options, value, onChange) {
  const wrap = el('div', { class: 'chips' });
  for (const o of options) {
    const v = o.value ?? o;
    const c = el('button', { class: `chip ${v === value ? 'on' : ''}`, text: o.label ?? o });
    c.addEventListener('click', () => {
      [...wrap.children].forEach(x => x.classList.remove('on'));
      c.classList.add('on');
      onChange(v);
    });
    wrap.append(c);
  }
  return wrap;
}

/* =========================================================
   APPEARANCE
   ========================================================= */
export function buildAppearance(app) {
  return (body) => {
    const S = app.settings;
    const set = (k, v) => app.setSetting(k, v);

    /* themes */
    const grid = el('div', { class: 'theme-grid' });
    for (const [id, p] of Object.entries(PRESETS)) {
      const card = el('div', {
        class: `theme-card ${S.theme === id ? 'on' : ''}`,
        style: { background: `linear-gradient(145deg, ${p.dots[2]}, ${p.dots[2]})` },
      },
        el('div', { class: 'tc-dots' }, ...p.dots.slice(0, 2).map(c => el('i', { style: { background: c } }))),
        el('div', { class: 'tc-name', text: p.name }),
      );
      card.addEventListener('click', () => {
        [...grid.children].forEach(c => c.classList.remove('on'));
        card.classList.add('on');
        set('accent', ''); set('accent2', '');
        set('theme', id);
      });
      grid.append(card);
    }

    /* custom colours */
    const colorItem = (label, key, fallback) => {
      const inp = el('input', { class: 'inp', type: 'color', value: S[key] || fallback });
      inp.addEventListener('input', () => set(key, inp.value));
      return el('div', { class: 'color-item' }, inp, el('span', { text: label }));
    };

    /* background */
    const bgExtra = el('div', { class: 'group' });
    const renderBgExtra = () => {
      bgExtra.innerHTML = '';
      const m = app.settings.bgMode;
      if (m === 'shader') {
        bgExtra.append(
          row('Shader', select(SHADER_NAMES.map(n => ({ value: n, label: n })), S.bgShader, v => set('bgShader', v))),
          row('Speed', slider(S.bgSpeed, 0, 3, .05, v => set('bgSpeed', v), v => v.toFixed(2) + '×')),
          row('Brightness', slider(S.bgAmount, 0, 2, .05, v => set('bgAmount', v), v => v.toFixed(2))),
        );
      } else if (m === 'gradient') {
        const inp = el('input', { class: 'inp', type: 'text', value: S.bgGradient, style: { flex: '1' } });
        inp.addEventListener('change', () => set('bgGradient', inp.value));
        bgExtra.append(el('div', { class: 'row stack' },
          el('div', { class: 'lbl' }, el('span', { text: 'CSS gradient' })), inp));
        bgExtra.append(el('div', { class: 'chips' },
          ...[
            'linear-gradient(135deg, #2b1055, #7597de)',
            'linear-gradient(160deg, #0f0c29, #302b63, #24243e)',
            'linear-gradient(135deg, #ff0844, #ffb199)',
            'linear-gradient(135deg, #00c6ff, #0072ff)',
            'radial-gradient(circle at 30% 20%, #4a00e0, #08001f)',
          ].map(g => {
            const c = el('button', { class: 'chip', style: { background: g, color: '#fff', minWidth: '44px' }, text: ' ' });
            c.addEventListener('click', () => { set('bgGradient', g); inp.value = g; });
            return c;
          })));
      } else if (m === 'solid') {
        const inp = el('input', { class: 'inp', type: 'color', value: S.bgSolid });
        inp.addEventListener('input', () => set('bgSolid', inp.value));
        bgExtra.append(row('Colour', inp));
      } else if (m === 'image' || m === 'video') {
        const file = el('input', { class: 'inp', type: 'file', accept: m === 'image' ? 'image/*' : 'video/*' });
        file.addEventListener('change', async () => {
          const f = file.files[0];
          if (!f) return;
          if (f.size > 60 * 1024 * 1024) { toast('File is over 60 MB — pick something smaller', { kind: 'bad' }); return; }
          await Assets.put(m === 'image' ? 'bg-image' : 'bg-video', f);
          app.refreshBackground();
          toast(`${m === 'image' ? 'Image' : 'Video'} set as background`, { kind: 'good' });
        });
        bgExtra.append(
          el('div', { class: 'row stack' },
            el('div', { class: 'lbl' },
              el('span', { text: m === 'image' ? 'Background image' : 'Background video' }),
              el('span', { class: 'sub', text: 'stored locally in your browser — never uploaded' })),
            file),
          el('div', { class: 'row' },
            el('div', { class: 'lbl' }, el('span', { text: 'Remove' })),
            el('button', {
              class: 'ghost-btn danger', text: 'clear',
              onclick: async () => {
                await Assets.del(m === 'image' ? 'bg-image' : 'bg-video');
                app.refreshBackground(); toast('Background cleared');
              },
            })),
        );
      }
    };
    renderBgExtra();

    body.append(
      group('Theme', grid,
        el('div', { class: 'color-grid' },
          colorItem('accent', 'accent', '#7c5cff'),
          colorItem('secondary', 'accent2', '#35e6c5')),
      ),

      group('Background',
        row('Source', chips([
          { value: 'shader', label: 'Animated' },
          { value: 'gradient', label: 'Gradient' },
          { value: 'image', label: 'Image' },
          { value: 'video', label: 'Video' },
          { value: 'solid', label: 'Solid' },
        ], S.bgMode, v => { set('bgMode', v); renderBgExtra(); })),
        bgExtra,
        row('Auto contrast', toggle(S.autoContrast, v => { set('autoContrast', v); app.refreshBackground(); }),
          'switch to dark text when the background is bright'),
        row('Dim', slider(S.bgDim, 0, 1, .01, v => set('bgDim', v), v => Math.round(v * 100) + '%')),
        row('Blur', slider(S.bgBlur, 0, 40, 1, v => set('bgBlur', v), v => v + 'px')),
        row('Saturation', slider(S.bgSat, 0, 2, .05, v => set('bgSat', v), v => v.toFixed(2))),
      ),

      group('Timer',
        row('Font', select(Object.keys(TIMER_FONTS).map(n => ({ value: n, label: n })), S.timerFont, v => set('timerFont', v))),
        row('Weight', slider(S.timerWeight, 300, 800, 100, v => set('timerWeight', v))),
        row('Size', slider(S.timerSize, 50, 160, 5, v => set('timerSize', v), v => v + '%')),
        row('Glow', slider(S.timerGlow, 0, 60, 1, v => set('timerGlow', v), v => v + 'px')),
      ),

      group('Sizes',
        row('Scramble', slider(S.scrambleSize, 60, 220, 5, v => set('scrambleSize', v), v => v + '%')),
        row('Scramble preview', slider(S.cubeSize, 50, 260, 5, v => set('cubeSize', v), v => v + '%'),
          'the cube in the corner — drag it anywhere'),
        row('Sidebar width', slider(S.sidebarWidth, 170, 420, 2, v => set('sidebarWidth', v), v => v + 'px')),
        row('Stats text', slider(S.sidebarText, 70, 160, 5, v => set('sidebarText', v), v => v + '%')),
        row('Solve list', slider(S.timesSize, 70, 160, 5, v => set('timesSize', v), v => v + '%')),
        el('div', { class: 'row' },
          el('div', { class: 'lbl' },
            el('span', { text: 'Preview position' }),
            el('span', { class: 'sub', text: 'drag the grip to move it, drag the cube to spin it' })),
          el('div', { style: { display: 'flex', gap: '6px' } },
            el('button', { class: 'ghost-btn', text: 'position', onclick: () => app.resetCubePosition?.() }),
            el('button', { class: 'ghost-btn', text: 'angle', onclick: () => app.resetCubeOrbit?.() }))),
      ),

      group('Layout',
        row('Panel style', chips([
          { value: 'widget', label: 'Widget' },
          { value: 'flat', label: 'Flat' },
        ], S.panelStyle, v => set('panelStyle', v)), 'cards with a background, or bare content'),
        row('Statistics panel', toggle(S.showStats, v => set('showStats', v))),
        row('Scramble preview', toggle(S.showCube, v => set('showCube', v))),
        row('Times strip', toggle(S.showHistory, v => set('showHistory', v))),
        row('Hint facelets', toggle(S.hintFacelets, v => set('hintFacelets', v)), 'ghost stickers on hidden faces'),
        row('Density', chips([
          { value: 'compact', label: 'Compact' },
          { value: 'comfortable', label: 'Comfortable' },
          { value: 'spacious', label: 'Spacious' },
        ], S.density, v => set('density', v))),
        row('Motion', chips([
          { value: 'full', label: 'Full' },
          { value: 'reduced', label: 'Reduced' },
          { value: 'off', label: 'Off' },
        ], S.motion, v => set('motion', v))),
      ),

      group('Share',
        el('div', { class: 'row' },
          el('div', { class: 'lbl' }, el('span', { text: 'Theme file' }), el('span', { class: 'sub', text: 'send your look to a friend' })),
          el('div', { style: { display: 'flex', gap: '6px' } },
            el('button', {
              class: 'ghost-btn', text: 'export',
              onclick: () => download('tagdatimer-theme.json', JSON.stringify(exportTheme(app.settings), null, 2)),
            }),
            (() => {
              const f = el('input', { type: 'file', accept: '.json', style: { display: 'none' } });
              f.addEventListener('change', async () => {
                try {
                  const data = JSON.parse(await f.files[0].text());
                  importTheme(app.settings, data);
                  app.applyAll(); app.persist();
                  closeDrawer(); toast('Theme applied', { kind: 'good' });
                } catch (e) { toast(e.message, { kind: 'bad' }); }
              });
              const b = el('button', { class: 'ghost-btn', text: 'import', onclick: () => f.click() });
              return el('span', {}, b, f);
            })(),
          )),
      ),
    );
  };
}


/* =========================================================
   STAT DETAIL — what actually went into that number

   Clicking best / ao5 / ao12 / ao50 / ao100 / mean opens this: every solve
   that counts towards it, with its scramble, and a copy button that produces
   the plain-text block people paste into Discord.
   ========================================================= */

const STAT_LABELS = {
  best: 'Best single', mean: 'Session mean',
  ao5: 'Average of 5', ao12: 'Average of 12',
  ao50: 'Average of 50', ao100: 'Average of 100',
};

const NEWLINE = String.fromCharCode(10);

const fmtStat = (v) => (v === null || v === undefined) ? '—' : v === DNF ? 'DNF' : fmt(v);

/** The solves behind one statistic, plus which of them the average throws away. */
function statWindow(app, kind) {
  const solves = app.solves;
  const base = { label: STAT_LABELS[kind] || kind, value: null, list: [], trimmed: new Set(), start: 0 };

  if (kind === 'best') {
    const v = bestSingle(solves);
    const i = solves.findIndex(x => eff(x) === v);
    return { ...base, value: v, list: i === -1 ? [] : [solves[i]], start: i === -1 ? 0 : i };
  }
  if (kind === 'mean') {
    return { ...base, value: summarize(solves).mean, list: solves, start: 0 };
  }

  const n = Number(kind.slice(2));
  if (!n || solves.length < n) return { ...base, label: `Average of ${n || '?'}` };
  const start = solves.length - n;
  const t = trimmedIndices(solves, n);
  return {
    ...base,
    value: currentAvg(solves, n),
    list: solves.slice(start),
    trimmed: new Set([...t.best, ...t.worst]),
    start,
  };
}

/** One solve's time, in parentheses when the average does not count it. */
function timeCell(solve, trimmed) {
  const v = eff(solve);
  const txt = v === DNF ? 'DNF' : fmt(v) + (solve.penalty === '+2' ? '+' : '');
  return trimmed ? `(${txt})` : txt;
}

/** The shareable block. Deliberately plain text — it has to survive a paste. */
function statText(w) {
  const lines = [`${w.label}: ${fmtStat(w.value)}`, '', 'Time List:'];
  w.list.forEach((s, i) => {
    const scramble = (s.scramble || '').replace(/\s+/g, ' ').trim();
    lines.push(`${i + 1}. ${timeCell(s, w.trimmed.has(w.start + i))}   ${scramble}`);
  });
  lines.push('', 'Generated by Tagda Timer');
  return lines.join(NEWLINE);
}

export function buildStatDetail(app, kind) {
  return (body) => {
    const w = statWindow(app, kind);

    if (!w.list.length) {
      body.append(el('div', { class: 'hint-note', text:
        `Not enough solves yet for ${w.label.toLowerCase()}. Keep going — it will fill in.` }));
      return;
    }

    const copyBtn = (label, text, kindClass = 'ghost-btn') => el('button', {
      class: kindClass, text: label,
      onclick: () => app.copyToast(text, label.replace(/^copy /, '').replace(/^\w/, c => c.toUpperCase())),
    });

    body.append(
      el('div', { class: 'stat-detail-head' },
        el('div', {},
          el('div', { class: 'sd-label', text: w.label }),
          el('div', { class: 'sd-value', text: fmtStat(w.value) })),
        el('div', { class: 'sd-actions' },
          copyBtn('copy all', statText(w), 'btn primary'),
          copyBtn('times only', w.list.map((s, i) => timeCell(s, w.trimmed.has(w.start + i))).join(', ')),
          copyBtn('scrambles only', w.list.map(s => (s.scramble || '').replace(/\s+/g, ' ').trim()).join(NEWLINE)),
        )),
      w.trimmed.size
        ? el('div', { class: 'hint-note', text:
            'Times in brackets are trimmed — the fastest and slowest of the set, which the average does not count.' })
        : null,
    );

    const list = el('div', { class: 'sd-list' });
    w.list.forEach((s, i) => {
      const gi = w.start + i;
      const trimmed = w.trimmed.has(gi);
      const scramble = (s.scramble || '').replace(/\s+/g, ' ').trim();
      const rowEl = el('div', { class: `sd-row ${trimmed ? 'trimmed' : ''} ${s.penalty === 'DNF' ? 'dnf' : ''}` },
        el('span', { class: 'sd-i', text: String(i + 1) }),
        el('span', { class: 'sd-t', text: timeCell(s, trimmed) }),
        el('div', { class: 'sd-body' },
          el('div', { class: 'sd-scramble', text: scramble || '(no scramble recorded)' }),
          el('div', { class: 'sd-meta', text: [
            `solve #${gi + 1}`,
            fmtDate(s.createdAt),
            s.caseName || '',
            s.comment || '',
          ].filter(Boolean).join(' · ') })),
        el('button', {
          class: 'ghost-btn sm', text: 'copy',
          title: 'Copy this scramble',
          onclick: () => app.copyToast(scramble, 'Scramble'),
        }),
      );
      list.append(rowEl);
    });
    body.append(list);
  };
}

/* =========================================================
   SETTINGS
   ========================================================= */
export function buildSettings(app) {
  return (body) => {
    const S = app.settings;
    const set = (k, v) => app.setSetting(k, v);

    body.append(
      group('Inspection',
        row('WCA inspection', toggle(S.inspection, v => set('inspection', v)), '15s, +2 after 15, DNF after 17'),
        row('Callouts', chips([
          { value: 'beep', label: 'Beep' },
          { value: 'off', label: 'Off' },
        ], S.callouts, v => set('callouts', v)), 'a tone at 8 and 12 seconds'),
      ),

      group('Timer',
        row('Hold time', chips([
          { value: 0, label: 'Instant' },
          { value: 300, label: '300 ms' },
          { value: 500, label: '500 ms' },
        ], S.holdTime, v => set('holdTime', +v)), 'how long to hold before it goes green'),
        row('Decimals', chips([{ value: 2, label: '0.00' }, { value: 3, label: '0.000' }], S.precision, v => set('precision', +v))),
        row('Hide time while solving', toggle(S.hideWhileRunning, v => set('hideWhileRunning', v)), 'stops you watching the clock'),
        row('Focus mode', toggle(S.focusMode, v => set('focusMode', v)), 'everything but the digits fades out'),
        row('Pace ghost', toggle(S.paceGhost, v => set('paceGhost', v)), 'live bar racing your best'),
        row('Pace reference', chips([{ value: 'pb', label: 'PB single' }, { value: 'ao5', label: 'Current ao5' }], S.paceRef, v => set('paceRef', v))),
        row('Start with the mouse', toggle(S.mouseTimer, v => set('mouseTimer', v)), 'click the screen to start and stop — touch always works'),
        row('Confirm misfires', toggle(S.confirmShortSolves, v => set('confirmShortSolves', v)), 'ask before recording a sub-0.5s solve'),
        row('Sound on PB', toggle(S.soundOnPB, v => set('soundOnPB', v))),
      ),

      group('Multi-blind',
        row('Cubes per attempt', slider(S.multiCount, 2, 20, 1, v => set('multiCount', v))),
      ),

      group('Data',
        el('div', { class: 'row' },
          el('div', { class: 'lbl' }, el('span', { text: 'Backup' }), el('span', { class: 'sub', text: 'every session and solve as JSON' })),
          el('button', {
            class: 'ghost-btn', text: 'export',
            onclick: async () => {
              download(`tagdatimer-backup-${new Date().toISOString().slice(0, 10)}.json`,
                JSON.stringify(await exportAll(), null, 2));
              toast('Backup downloaded', { kind: 'good' });
            },
          })),
        (() => {
          const f = el('input', { type: 'file', accept: '.json', style: { display: 'none' } });
          f.addEventListener('change', async () => {
            try {
              const n = await importAll(JSON.parse(await f.files[0].text()));
              await app.reload(); toast(`Imported ${n} solves`, { kind: 'good' });
            } catch (e) { toast(e.message, { kind: 'bad' }); }
          });
          return el('div', { class: 'row' },
            el('div', { class: 'lbl' }, el('span', { text: 'Restore' }), el('span', { class: 'sub', text: 'merge a Tagda Timer backup' })),
            el('span', {}, el('button', { class: 'ghost-btn', text: 'import', onclick: () => f.click() }), f));
        })(),
        (() => {
          const f = el('input', { type: 'file', accept: '.json,.txt', style: { display: 'none' } });
          f.addEventListener('change', async () => {
            try {
              const n = await app.importCsTimer(JSON.parse(await f.files[0].text()));
              toast(`Imported ${n} solves from csTimer`, { kind: 'good' });
            } catch (e) { toast('Could not read that csTimer export: ' + e.message, { kind: 'bad' }); }
          });
          return el('div', { class: 'row' },
            el('div', { class: 'lbl' }, el('span', { text: 'Import from csTimer' }), el('span', { class: 'sub', text: 'bring your whole history across' })),
            el('span', {}, el('button', { class: 'ghost-btn', text: 'choose file', onclick: () => f.click() }), f));
        })(),
        el('div', { class: 'row' },
          el('div', { class: 'lbl' }, el('span', { text: 'Session as CSV' })),
          el('button', {
            class: 'ghost-btn', text: 'export',
            onclick: () => app.exportSessionCSV(),
          })),
      ),

      group('About',
        el('div', { class: 'hint-note', html:
          'Tagda Timer generates official WCA scrambles with <b>cubing.js</b>, the same random-state ' +
          'solvers the WCA scrambler uses. Everything you time is stored locally in your browser — ' +
          'no account, no server.' }),
        el('div', { class: 'row' },
          el('div', { class: 'lbl' }, el('span', { text: 'Built by' })),
          el('a', { class: 'ghost-btn', href: 'https://instagram.com/cubingngagng', target: '_blank', rel: 'noopener', text: '@cubingngagng' })),
      ),
    );
  };
}

/* =========================================================
   STATISTICS
   ========================================================= */
export function buildStats(app) {
  return (body) => {
    const solves = app.solves;
    const st = summarize(solves);
    const cases = byCase(solves);

    const cell = (k, v, sub) => el('div', { class: 'bs' },
      el('span', { class: 'bs-k', text: k }),
      el('span', { class: 'bs-v', text: v }),
      sub ? el('span', { class: 'bs-sub', text: sub }) : null);

    const f = v => v === null ? '—' : v === DNF ? 'DNF' : fmt(v);

    body.append(
      group('Session',
        el('div', { class: 'big-stats' },
          cell('solves', String(st.count), `${st.dnfCount} DNF · ${st.plus2Count} +2`),
          cell('best', f(st.best)),
          cell('worst', f(st.worst)),
          cell('mean', f(st.mean)),
          cell('median', f(st.median)),
          cell('std dev', f(st.stdev)),
          cell('mo3', f(st.mo3)),
          cell('ao5', f(st.ao5), st.bestAo5 ? 'best ' + f(st.bestAo5) : ''),
          cell('ao12', f(st.ao12), st.bestAo12 ? 'best ' + f(st.bestAo12) : ''),
          cell('ao50', f(st.ao50)),
          cell('ao100', f(st.ao100)),
          cell('ao1000', f(solves.length >= 1000 ? bestAvg(solves, 1000).value : null)),
        )),
    );

    const hoverInfo = el('div', { class: 'bs-sub', style: { minHeight: '1.2em' } });
    const trendHost = el('div');
    body.append(el('div', { class: 'chart-card' },
      el('h4', { text: 'Trend — solves, ao5, ao12, PB' }), trendHost, hoverInfo));
    renderTrend(trendHost, solves, (s, i) => {
      hoverInfo.textContent = s ? `#${i + 1}  ${eff(s) === DNF ? 'DNF' : fmt(eff(s))}  ·  ${s.scramble.slice(0, 60)}` : '';
    });

    const histHost = el('div');
    body.append(el('div', { class: 'chart-card' }, el('h4', { text: 'Distribution' }), histHost));
    renderHistogram(histHost, solves);

    const heatHost = el('div');
    body.append(el('div', { class: 'chart-card' }, el('h4', { text: 'Practice heatmap — all events' }), heatHost));
    app.allSolves().then(all => renderHeatmap(heatHost, all));

    if (cases.length) {
      const caseHost = el('div');
      body.append(el('div', { class: 'chart-card' },
        el('h4', { text: 'Slowest cases in this session' }), caseHost));
      renderCaseBars(caseHost, cases);
    }
  };
}

/* =========================================================
   ALL SOLVES
   ========================================================= */
export function buildHistory(app) {
  return (body) => {
    const solves = [...app.solves].reverse();
    if (!solves.length) { body.append(el('div', { class: 'hint-note', text: 'No solves in this session yet.' })); return; }
    const best = Math.min(...app.solves.map(eff).filter(v => v !== DNF));
    const table = el('div', { class: 'solve-table' });

    solves.forEach((s, i) => {
      const v = eff(s);
      const cls = [s.penalty === 'DNF' ? 'dnf' : '', s.penalty === '+2' ? 'plus2' : '', v === best ? 'pb' : ''].join(' ');
      const r = el('div', { class: `st-row ${cls}` },
        el('span', { class: 'st-i', text: String(solves.length - i) }),
        el('span', { class: 'st-t', text: v === DNF ? 'DNF' : fmt(v) + (s.penalty === '+2' ? '+' : '') }),
        el('span', { class: 'st-s', text: s.scramble.replace(/\n/g, ' | ') }),
        el('span', { class: 'st-d', text: fmtDate(s.createdAt) }),
      );
      r.addEventListener('click', (e) => app.solveMenu(s, e.currentTarget));
      table.append(r);
    });

    body.append(
      el('div', { class: 'row' },
        el('div', { class: 'lbl' }, el('span', { text: `${solves.length} solves` }),
          el('span', { class: 'sub', text: 'click a row for penalties, comment, delete' })),
        el('button', { class: 'ghost-btn', text: 'copy all', onclick: () => app.copyToast(
          app.solves.map((s, i) => `${i + 1}. ${eff(s) === DNF ? 'DNF' : fmt(eff(s))}   ${(s.scramble || '').replace(/\s+/g, ' ')}`).join(NEWLINE),
          'Session') }),
      ),
      table,
    );
  };
}

/* =========================================================
   CASE PICKER (trainer modes)
   ========================================================= */
export function buildCases(app) {
  return (body) => {
    const modeId = app.settings.mode;
    const set = setFor(modeId);
    if (!set) { body.append(el('div', { class: 'hint-note', text: 'This mode has no case list.' })); return; }

    const allowed = new Set(app.settings.allowedCases[modeId] || set.map(c => c.id));
    const stats = new Map(byCase(app.solves).map(r => [r.caseId, r]));
    const grid = el('div', { class: 'case-grid' });

    const paint = () => {
      grid.innerHTML = '';
      for (const c of set) {
        const s = stats.get(c.id);
        const cell = el('div', { class: `case-cell ${allowed.has(c.id) ? 'on' : ''}` },
          el('span', { class: 'cc-name', text: c.name }),
          el('span', { class: 'cc-stat', text: s && s.avg !== null ? fmt(s.avg) : '—' }),
        );
        cell.title = c.label ? `${c.name} — ${c.label}` : c.name;
        cell.addEventListener('click', () => {
          if (allowed.has(c.id)) allowed.delete(c.id); else allowed.add(c.id);
          if (!allowed.size) allowed.add(c.id);
          cell.classList.toggle('on', allowed.has(c.id));
          commit();
        });
        grid.append(cell);
      }
    };
    const commit = () => {
      app.settings.allowedCases[modeId] = [...allowed];
      app.persist();
      app.refreshQueue();
    };

    const bulk = (fn) => () => { fn(); paint(); commit(); };

    body.append(
      el('div', { class: 'hint-note', text:
        `${MODES[modeId].name} — pick which cases you want to drill. Times shown are your session average for that case.` }),
      el('div', { class: 'chips' },
        el('button', { class: 'chip', text: 'all', onclick: bulk(() => set.forEach(c => allowed.add(c.id))) }),
        el('button', { class: 'chip', text: 'none', onclick: bulk(() => { set.forEach(c => allowed.delete(c.id)); allowed.add(set[0].id); }) }),
        el('button', { class: 'chip', text: 'invert', onclick: bulk(() => {
          const inv = set.filter(c => !allowed.has(c.id)).map(c => c.id);
          allowed.clear(); (inv.length ? inv : [set[0].id]).forEach(id => allowed.add(id));
        }) }),
        el('button', { class: 'chip', text: 'my worst 8', onclick: bulk(() => {
          const ranked = byCase(app.solves).filter(r => r.avg !== null).sort((a, b) => b.avg - a.avg).slice(0, 8);
          if (!ranked.length) { toast('Do some solves first so I know what your worst cases are'); return; }
          allowed.clear(); ranked.forEach(r => allowed.add(r.caseId));
        }) }),
      ),
      grid,
    );
    paint();
  };
}

/* =========================================================
   SHORTCUTS
   ========================================================= */
export const SHORTCUTS = [
  ['Timer', [
    ['hold Space', 'start / stop the timer'],
    ['Esc', 'cancel inspection'],
  ]],
  ['Last solve', [
    ['Delete', 'delete last solve'],
    ['Ctrl + Z', 'undo the delete'],
    ['2', 'toggle +2'],
    ['D', 'toggle DNF'],
    ['0', 'clear penalty'],
    ['C', 'add a comment'],
    ['R', 'solve its scramble again'],
  ]],
  ['Scramble', [
    ['N', 'new scramble'],
    ['Ctrl + C', 'copy scramble'],
    ['←  →', 'previous / next scramble'],
  ]],
  ['Go to', [
    ['E', 'event picker'],
    ['M', 'mode + trainer picker'],
    ['S', 'sessions'],
    ['A', 'statistics'],
    ['H', 'all solves'],
    ['T', 'appearance'],
    [',', 'settings'],
    ['K', 'case picker'],
    ['Ctrl + K  or  /', 'command palette'],
    ['?', 'this list'],
    ['B', 'about'],
  ]],
  ['View', [
    ['Z', 'zen mode'],
    ['F', 'fullscreen'],
    ['V', '3D / 2D preview'],
    ['I', 'toggle inspection'],
  ]],
  ['Careful', [
    ['Ctrl + Shift + Del', 'clear the whole session'],
  ]],
];

export function buildShortcuts() {
  return (body) => {
    const list = el('div', { class: 'kbd-list' });
    for (const [title, rows] of SHORTCUTS) {
      const col = el('div', { class: 'kbd-col' }, el('h3', { text: title, style: { fontSize: '.64rem', letterSpacing: '.18em', textTransform: 'uppercase', color: 'var(--text-faint)' } }));
      for (const [keys, desc] of rows) {
        col.append(el('div', { class: 'kbd-row' },
          el('span', { text: desc }),
          el('span', { class: 'keys' }, ...keys.split(/\s{2,}|\s\+\s/).map(k => el('kbd', { text: k })))));
      }
      list.append(col);
    }
    body.append(
      el('div', { class: 'hint-note', text: 'Shortcuts are ignored while you are typing in a text field.' }),
      list,
    );
  };
}


/* =========================================================
   ABOUT
   ========================================================= */

const IG_HANDLE = 'cubingngagng';
const IG_PROFILE = `https://instagram.com/${IG_HANDLE}`;
const IG_REELS = `https://instagram.com/${IG_HANDLE}/reels/`;

export function buildAbout(app) {
  return (body) => {
    const S = app.settings;

    const link = (label, href, sub) => el('a', {
      class: 'about-link', href, target: '_blank', rel: 'noopener noreferrer',
    },
      el('span', {}, el('b', { text: label }), sub ? el('span', { class: 'sub', text: sub }) : null),
      el('svg', { viewBox: '0 0 24 24', class: 'about-arrow' }),
    );
    // el() cannot build namespaced SVG children, so the glyph goes in as markup.
    const arrow = (a) => { a.querySelector('.about-arrow').innerHTML = '<path d="M7 17L17 7M9 7h8v8"/>'; return a; };

    /* The featured reel. Instagram has no public endpoint that hands over a
       creator's newest post without an app token and review, so nothing here
       can genuinely poll for it. What IS always current is the reels tab, and
       a pasted link stays under your control. */
    const reelInput = el('input', {
      class: 'inp', type: 'url', placeholder: 'https://instagram.com/reel/…',
      value: S.featuredReel || '', style: { flex: '1', minWidth: '0' },
    });
    const reelCard = el('div', { class: 'reel-card' });
    const renderReel = () => {
      reelCard.innerHTML = '';
      const url = app.settings.featuredReel;
      if (!url) {
        reelCard.append(el('div', { class: 'reel-empty', text:
          'No reel pinned yet — paste one below, or use the button above for whatever is newest.' }));
        return;
      }
      reelCard.append(arrow(link('Featured reel', url, url.replace(/^https?:\/\//, '').slice(0, 46))));
    };
    renderReel();

    body.append(
      group('Ishaan',
        el('div', { class: 'about-hero' },
          el('div', { class: 'about-avatar', text: 'I' }),
          el('div', {},
            el('div', { class: 'about-name', text: 'Ishaan' }),
            el('div', { class: 'about-handle', text: '@' + IG_HANDLE }))),
        el('div', { class: 'about-bio', text:
          'Speedcuber, and the person who built this timer. I post solves, reconstructions and ' +
          'cubing bits on Instagram — come say hello. Tagda Timer is the timer I wanted for my own ' +
          'practice: WCA-legal random-state scrambles, everything stored on your own machine, no ' +
          'account and no server.' }),
      ),

      group('Find me',
        arrow(link('Instagram', IG_PROFILE, '@' + IG_HANDLE)),
        arrow(link('Latest reels', IG_REELS, 'always opens on the newest one')),
      ),

      group('Featured reel',
        reelCard,
        el('div', { class: 'row stack' },
          el('div', { class: 'lbl' },
            el('span', { text: 'Pin a reel' }),
            el('span', { class: 'sub', text:
              'Instagram has no public feed to read without an app token, so this is set by hand.' })),
          el('div', { style: { display: 'flex', gap: '6px' } },
            reelInput,
            el('button', {
              class: 'btn primary', text: 'save',
              onclick: () => {
                const v = reelInput.value.trim();
                if (v && !/^https?:\/\/(www\.)?instagram\.com\//i.test(v)) {
                  toast('That is not an instagram.com link', { kind: 'bad' });
                  return;
                }
                app.setSetting('featuredReel', v);
                renderReel();
                toast(v ? 'Reel pinned' : 'Reel cleared', { kind: 'good' });
              },
            }))),
      ),
    );
  };
}

/* =========================================================
   SESSION MANAGER
   ========================================================= */
export function buildSessions(app) {
  return (body) => {
    const list = el('div', { class: 'solve-table' });
    for (const s of app.sessions) {
      const count = app.sessionCounts.get(s.id) || 0;
      const r = el('div', { class: `st-row ${s.id === app.settings.sessionId ? 'pb' : ''}`, style: { gridTemplateColumns: '1fr auto auto' } },
        el('span', { class: 'st-t', style: { fontFamily: 'var(--font-ui)', fontWeight: '600' }, text: s.name }),
        el('span', { class: 'st-d', text: `${EVENTS[s.event]?.short || s.event} · ${count} solves` }),
        el('span', { style: { display: 'flex', gap: '4px' } },
          el('button', {
            class: 'ghost-btn sm', text: 'rename',
            onclick: (e) => {
              e.stopPropagation();
              const name = prompt('Session name', s.name);
              if (name) { s.name = name; app.saveSession(s); openDrawer('Sessions', buildSessions(app)); }
            },
          }),
          el('button', {
            class: 'ghost-btn sm danger', text: 'delete',
            onclick: async (e) => {
              e.stopPropagation();
              if (app.sessions.length < 2) { toast('Keep at least one session', { kind: 'bad' }); return; }
              if (!await confirmToast(`Delete "${s.name}" and its ${count} solves?`, 'delete')) return;
              await app.deleteSession(s.id);
              openDrawer('Sessions', buildSessions(app));
            },
          }),
        ),
      );
      r.addEventListener('click', () => { app.switchSession(s.id); closeDrawer(); });
      list.append(r);
    }
    body.append(
      el('button', { class: 'btn primary full', text: '+ New session', onclick: () => { app.newSession(); closeDrawer(); } }),
      list,
    );
  };
}

export { toast, Solves };
