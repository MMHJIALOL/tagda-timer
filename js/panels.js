/* ===========================================================
   Tagda Timer — drawer contents
   Appearance · Settings · Statistics · All solves · Shortcuts · Cases
   Every control writes straight into app.settings and applies live.
   =========================================================== */

import { $, el, fmt, fmtDate, download, parseScrambleList } from './util.js';
import { PRESETS, TIMER_FONTS, exportTheme, importTheme } from './theme.js';
import { SHADER_NAMES } from './bg.js';
import { summarize, byCase, eff, DNF, bestAvg, statWindow, bldSummary } from './stats.js';
import { renderTrend, renderHistogram, renderHeatmap, renderCaseBars } from './charts.js';
import { MODES, EVENTS, EVENT_ORDER, virtualSize } from './events.js';
import { setFor } from './scramble.js';
import { toast, confirmToast } from './toast.js';
import { exportAll, Assets, Solves, LetterPairs } from './db.js';
import { Gear, GearLog, LOG_KINDS, newGear, newLogEntry, gearLabel,
         loadSeeds, filterByCube, markersFor, activeGearId, setActiveGearId } from './gear.js';
import { buildAccountRow } from './sync-ui.js';
import { DEFAULT_SPEFFZ_MAP, DEFAULT_BLD, CORNER_STICKER_KEYS, EDGE_STICKER_KEYS,
         frontsFor, faceLabel, pieceAtFacelet, faceletsOfPiece,
         pieceName, samePiece, diagnose } from './bldtrace.js';
import { FACES } from './cube3.js';

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
        row('Yellow on top', toggle(S.yellowTop, v => set('yellowTop', v)),
          'trainer cases drawn with the white cross underneath, the way you are holding it — WCA scrambles stay white on top'),
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
        el('div', { class: 'hint-note', html:
          'Drag the times list, the statistics panel, the now-playing card and the play bar ' +
          'by the grip on their top edge. The <b>left rail</b>, the <b>right rail</b> and the ' +
          '<b>bar across the bottom</b> light up while you are dragging — drop on one and the ' +
          'panel clicks into it. Drop it anywhere else and it stays exactly where you let go. ' +
          'On a phone the panels keep their fixed layout, because there is nowhere to put them.' }),
        el('div', { class: 'row' },
          el('div', { class: 'lbl' }, el('span', { text: 'Panel layout' }),
            el('span', { class: 'sub', text: 'put every panel back in its original rail' })),
          el('button', { class: 'ghost-btn', text: 'reset', onclick: () => app.resetTiles?.() })),
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

const NEWLINE = String.fromCharCode(10);

const fmtStat = (v) => (v === null || v === undefined) ? '—' : v === DNF ? 'DNF' : fmt(v);

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
    const w = statWindow(app.solves, kind);

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
          el('button', {
            class: 'btn primary', text: 'share card',
            title: 'A picture of this average — times and scrambles',
            onclick: () => app.shareAverageCard(kind),
          }),
          copyBtn('copy all', statText(w), 'ghost-btn'),
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
   SPOTIFY
   Its own section rather than a row buried in Appearance: it owns an account
   link, a live connection and a now-playing readout, none of which are
   "appearance" in the sense the rest of that panel means.
   ========================================================= */
export function buildSpotify(app) {
  return (body) => {
    const set = (k, v) => app.setSetting(k, v);

    const render = () => {
      body.innerHTML = '';
      const st = app.spotifyState();
      const connected = st.connected;

      /* ---- the whole feature, in one button ----
         Everything a normal person needs is here. There is no client ID to
         find, no dashboard to visit and no setup to read: the app is already
         registered, and its identifier is public by design. */
      body.append(
        group('Spotify',
          el('div', { class: `spot-hero ${connected && !st.denied ? 'on' : ''}` },
            el('div', { class: 'spot-hero-dot' }),
            el('div', {},
              el('div', { class: 'spot-hero-title', text:
                st.denied ? 'Linked, but blocked'
                : connected ? 'Connected' : 'Not connected' }),
              /* Nothing here when denied: an invitation to "link an account"
                 is nonsense to someone who just did, and the warning below
                 carries the whole message. */
              st.denied ? null
                : el('div', { class: 'spot-hero-sub', text: connected
                    ? (st.artworkReadable === false
                        ? 'Artwork colours are blocked by Spotify’s CDN, so the cover is used as a background instead.'
                        : st.artworkMono
                          ? 'This cover is black and white, so the timer is too — there is no hue in it to borrow.'
                          : 'The timer takes its colours from whatever you are playing.')
                    : 'Link an account and the timer takes its colours from the album art of whatever you are playing.' }),
              !connected
                ? el('div', { class: 'spot-hero-sub', text:
                    `Worth knowing first: Spotify only lets ${st.devModeLimit} people use this `
                    + 'connection, and they have to be added by hand by whoever runs this site. '
                    + 'If you are not one of them, Connect will appear to work and then show '
                    + 'nothing — set up your own connection below instead.' })
                : null,
              connected && !st.canControl
                ? el('div', { class: 'spot-hero-warn', text:
                    'Reconnect to enable the play, next and previous buttons — this link '
                    + 'was made before they existed.' })
                : null,
              connected && st.blocked
                ? el('div', { class: 'spot-hero-warn', text: st.blocked })
                : null,
              /* The refusal that used to be invisible. Spotify hands out a
                 perfectly good token to someone who is not on the app's list
                 and only then refuses every request, so this is the only
                 place a visitor can find out what went wrong. */
              st.denied
                ? el('div', { class: 'spot-hero-warn', text:
                    'Spotify accepted the login but will not share what you are playing, '
                    + 'because this account is not on this app’s guest list. That list is '
                    + `capped at ${st.devModeLimit} people and only the site’s owner can add you. `
                    + 'To use it anyway, set up your own connection below — you will need '
                    + 'Spotify Premium for that.' })
                : null),
            connected
              ? el('button', { class: 'btn danger', text: 'Disconnect',
                  onclick: async () => { await app.disconnectSpotify(); render(); } })
              : el('button', { class: 'btn primary', text: 'Connect Spotify',
                  onclick: () => app.connectSpotify() }),
          ),
          st.problem ? el('div', { class: 'hint-note warn-note', text:
            st.problem.reason
            + (st.problem.openInstead
                ? ` Open the timer at ${st.problem.openInstead} instead — that is a different origin, so it keeps its own solves.`
                : '') }) : null,
          el('div', { class: 'hint-note', text:
            'Only "read what you are currently playing" and playback control are '
            + 'requested — it cannot read your library or change anything about the '
            + 'account. Revoke it any time at spotify.com/account/apps.' }),
        ),
      );

      /* ---- what it drives ---- */
      if (connected && !st.denied) {
        body.append(group('What the album drives',
          row('Tint', chips([
            { value: 'accent', label: 'Colours' },
            { value: 'background', label: 'Artwork' },
            { value: 'both', label: 'Both' },
          ], app.settings.spotifyTint, v => set('spotifyTint', v))),
          row('Now playing panel', toggle(app.settings.showSpotifyPanel,
            v => { set('showSpotifyPanel', v); app.syncSpotifyPanel?.(); }),
            'the cover, track and controls in the sidebar'),
          row('Track under the scramble', toggle(app.settings.spotifyNowPlaying,
            v => set('spotifyNowPlaying', v)), 'a single line, off by default'),
          el('div', { class: 'hint-note', text:
            'Colours are never written into your saved theme, and never change '
            + 'mid-solve — a new track waits for the timer to go idle. The status '
            + 'colours for inspection are never touched at all.' }),
        ));
      }

      /* ---- the escape hatch, folded away ----
         The built-in app is capped at 5 listed users by Spotify, and there is
         no way to raise that. Anyone past the cap can point the timer at an app
         of their own instead — which since the cap dropped to 5 is most
         visitors, so it is no longer a corner case. It stays folded because the
         Premium requirement makes it a dead end for a lot of people, and the
         hero above now says so before anyone opens it. */
      const adv = el('details', { class: 'adv' },
        el('summary', { text: 'Set up your own connection' }),
        el('div', { class: 'adv-body' },
          el('div', { class: 'hint-note', text:
            `Spotify only allows ${st.devModeLimit} people to use this site’s connection, and `
            + 'there is no way to raise that — Spotify stopped granting bigger limits to '
            + 'projects like this one. Everyone else has to make their own connection. It is '
            + 'free, takes about five minutes, and only has to be done once.' }),
          st.ownerNeedsPremium
            ? el('div', { class: 'hint-note warn-note', text:
                'You need Spotify Premium for this. Anyone can create the connection, but '
                + 'since early 2026 Spotify refuses to share your music with a connection '
                + 'whose owner is not a Premium subscriber — and doing this makes you the '
                + 'owner. On a free account the steps below will all appear to work, and '
                + 'then nothing will play through. Ask the site’s owner to add you to the '
                + 'guest list instead.' })
            : null,
          el('div', { class: 'setup-steps' },
            step(1, 'Create an app',
              'Go to developer.spotify.com/dashboard, sign in, and press Create app. '
              + 'Give it any name you like and tick "Web API".'),
            step(2, 'Add the redirect address',
              'In the app’s settings, paste the address below into "Redirect URIs" and save. '
              + 'It has to match exactly, character for character.'),
            step(3, 'Add yourself as a user',
              'Open the User Management tab and add your own name and Spotify email. '
              + 'This is easy to miss, and without it Spotify refuses everything — even '
              + 'though the connection is yours.'),
            step(4, 'Copy the Client ID',
              'It is on the app’s settings page. Paste it in the box below. Ignore the '
              + 'client secret — this site never uses one and never asks for one.'),
          ),
          row('Redirect URI', el('div', { class: 'copy-field' },
            el('code', { text: st.redirectUri }),
            el('button', { class: 'ghost-btn sm', text: 'copy',
              onclick: () => app.copyToast(st.redirectUri, 'Redirect URI') }))),
          ownAppRow(app, st, render),
        ));
      if (st.usingOwnApp) adv.open = true;
      body.append(adv);
    };

    render();
    // A redirect can complete while this panel is open.
    app.spotifyChanged = render;
  };
}

/** The client-ID override, plus the way back to the built-in app. */
function ownAppRow(app, st, render) {
  const input = el('input', {
    class: 'inp', type: 'text', placeholder: 'client ID (leave blank to use the built-in app)',
    value: app.settings.spotifyClientId || '', style: { flex: '1' },
  });
  input.addEventListener('change', async () => {
    const next = input.value.trim();
    if (next === (app.settings.spotifyClientId || '')) return;
    // Tokens belong to the app that issued them, so switching apps has to drop
    // them or the next call authenticates as the wrong application.
    await app.disconnectSpotify();
    app.setSetting('spotifyClientId', next);
    render();
  });
  return row('Client ID', input, st.usingOwnApp ? 'using your own app' : 'using the built-in app');
}

/** One numbered step in the setup list. */
function step(n, title, detail) {
  return el('div', { class: 'setup-step' },
    el('span', { class: 'ss-n', text: String(n) }),
    el('div', {},
      el('div', { class: 'ss-t', text: title }),
      el('div', { class: 'ss-d', text: detail })));
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

      group('Timing input',
        row('Where times come from', chips([
          { value: 'timer', label: 'Keyboard' },
          { value: 'manual', label: 'Type them' },
          { value: 'stackmat', label: 'Stackmat (aux)' },
          { value: 'virtual', label: 'Virtual cube' },
        ], S.inputMode || 'timer', (v) => {
          set('inputMode', v);
          // The note under this row is different for every mode, so redraw.
          openDrawer('Settings', buildSettings(app));
        }),
          'the spacebar, a time you type in, a Stackmat, or a cube you turn with the keyboard'),
        S.inputMode === 'virtual'
          ? el('div', { class: 'hint-note', html:
              'Turn the cube with csTimer&rsquo;s keys: <b>I K</b> R, <b>D E</b> L, <b>J F</b> U, ' +
              '<b>S L</b> D, <b>H G</b> F, <b>W O</b> B, <b>U M</b> r, <b>V R</b> l, <b>5 X</b> M, ' +
              '<b>T B</b> x, <b>; A</b> y, <b>P Q</b> z (full list under <b>?</b>). The first turn starts ' +
              'the clock and a solved cube stops it; <b>Space</b> starts inspection, <b>Esc</b> resets. ' +
              'While it is on, those letters are turns, not shortcuts &mdash; the rest are in ' +
              '<b>Ctrl+K</b>. For 2x2 to 7x7 only' +
              (virtualSize(S.event) ? '' : ' &mdash; this event stays on the spacebar') +
              ', and its solves go in a &ldquo;Virtual&rdquo; session per event so they never mix ' +
              'with your real averages.' })
          : null,
        S.inputMode === 'manual'
          ? el('div', { class: 'hint-note', html:
              'Type the time under the clock and press <b>Enter</b>. It understands ' +
              '<b>12.34</b>, <b>1:05.67</b>, bare digits (<b>1234</b> is 12.34), ' +
              '<b>12.34+2</b> for a plus two, and <b>DNF</b>. Each entry records against the ' +
              'scramble on screen and moves you to the next one.' })
          : null,
        S.inputMode === 'stackmat'
          ? el('div', { class: 'hint-note', html:
              'Run a 3.5&nbsp;mm cable from the timer&rsquo;s data port to this machine&rsquo;s ' +
              '<b>microphone</b> input and allow the microphone when asked. The bar under the ' +
              'clock says whether packets are actually arriving — if it stays on ' +
              '&ldquo;no signal&rdquo;, raise the input level in your sound settings and check ' +
              'the cable is in the mic socket, not line-out.' })
          : null,
        el('div', { class: 'hint-note', html:
            '<b>Bluetooth smart timers are not supported.</b> Every model (GAN, QiYi, MoYu) ' +
            'speaks its own encrypted protocol, and shipping an implementation that has never ' +
            'been near the hardware would just be a button that fails silently. The aux route ' +
            'above works with any Stackmat, which is what the Bluetooth timers emulate anyway.' }),
      ),

      group('Timer',
        row('Hold time', chips([
          { value: 0, label: 'Instant' },
          { value: 300, label: '300 ms' },
          { value: 500, label: '500 ms' },
        ], S.holdTime, v => set('holdTime', +v)), 'instant starts on the press; the others arm first and start on release'),
        row('Decimals', chips([{ value: 2, label: '0.00' }, { value: 3, label: '0.000' }], S.precision, v => set('precision', +v))),
        row('Hide time while solving', toggle(S.hideWhileRunning, v => set('hideWhileRunning', v)), 'stops you watching the clock'),
        row('Focus mode', toggle(S.focusMode, v => set('focusMode', v)), 'everything but the digits fades out'),
        row('Pace ghost', toggle(S.paceGhost, v => set('paceGhost', v)), 'live bar racing your best'),
        row('Pace reference', chips([{ value: 'pb', label: 'PB single' }, { value: 'ao5', label: 'Current ao5' }], S.paceRef, v => set('paceRef', v))),
        row('Start with the mouse', toggle(S.mouseTimer, v => set('mouseTimer', v)), 'click the screen to start and stop — touch always works'),
        row('Confirm misfires', toggle(S.confirmShortSolves, v => set('confirmShortSolves', v)), 'ask before recording a sub-0.5s solve'),
        row('Sound on PB', toggle(S.soundOnPB, v => set('soundOnPB', v))),
        row('Metronome', toggle(S.metronome, v => set('metronome', v)),
          'a click on the beat while the timer runs — one move per beat to practise a smooth cross and F2L'),
        row('Metronome speed', slider(S.metronomeBpm, 30, 240, 5, v => set('metronomeBpm', v), v => v + ' bpm')),
        row('Metronome window', toggle(S.metroOpen, v => set('metroOpen', v)),
          'a floating beat meter with its own start/stop and bpm — it keeps ticking with the timer idle, for drilling an algorithm to a beat. Drag it anywhere; same speed as the setting above.'),
        row('Multiphase splits', chips([
          { value: 0, label: 'Off' },
          { value: 2, label: '2' },
          { value: 3, label: '3' },
          { value: 4, label: '4' },
          { value: 5, label: '5' },
        ], S.multiphase || 0, v => set('multiphase', +v)),
          'press the split key mid-solve to close a phase instead of stopping — cross/F2L/OLL/PLL, whatever you use it for. Off on blind events, which already split memo/exec.'),
      ),

      group('Learn mode',
        el('div', { class: 'hint-note', html:
            'On top of any trainer mode: a case you have never seen arrives with its ' +
            'algorithm, after that you are asked to recall it, and how the solve went ' +
            'decides when it comes back. Turn it on with <b>L</b>, or from the case picker.' }),
        row('New cases per sitting', slider(S.learnNewPerSession, 1, 15, 1, v => set('learnNewPerSession', v)),
          'how many cases you have never seen may be introduced before you switch it off and on again'),
        row('Counts as slow', slider(S.learnSlowFactor, 1.1, 3, .1, v => set('learnSlowFactor', v), v => v.toFixed(1) + '×'),
          'a solve this much slower than your own average on the case holds it back instead of advancing it'),
      ),

      group('Multi-blind',
        row('Cubes per attempt', slider(S.multiCount, 2, 20, 1, v => set('multiCount', v))),
      ),

      group('Blindsolving',
        el('div', { class: 'row' },
          el('div', { class: 'lbl' },
            el('span', { text: 'Buffers, orientation, letters' }),
            el('span', { class: 'sub', text: 'and the memo/execution split' })),
          el('button', {
            class: 'ghost-btn', text: 'open',
            onclick: () => openDrawer('Blindsolving', buildBlindsolving(app)),
          })),
        el('div', { class: 'row' },
          el('div', { class: 'lbl' },
            el('span', { text: 'Letter pairs' }),
            el('span', { class: 'sub', text: 'words, images and your own algs' })),
          el('button', {
            class: 'ghost-btn', text: 'open',
            onclick: () => openDrawer('Letter pairs', buildLetterPairs(app), { wide: true }),
          })),
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
          // One picker for both formats. csTimer writes JSON into a .txt, so an
          // extension filter is exactly the wrong thing to trust — the importer
          // reads the file and decides what it is.
          const f = el('input', {
            type: 'file',
            accept: '.json,.txt,text/plain,application/json',
            style: { display: 'none' },
          });
          const status = el('div', { class: 'sub', text: 'Tagda backup (.json) or csTimer export (.txt)' });
          const btn = el('button', { class: 'ghost-btn', text: 'choose file', onclick: () => f.click() });

          f.addEventListener('change', async () => {
            const file = f.files?.[0];
            if (!file) return;
            btn.disabled = true;
            status.textContent = `reading ${file.name}…`;
            try {
              const res = await app.importFile(file, {
                onProgress: (n, name) => { status.textContent = `${n} solves… (${name})`; },
              });
              status.textContent = res.kind === 'cstimer'
                ? `${res.solves} solves in ${res.sessions} sessions from csTimer`
                : `${res.solves} solves restored`;
              toast(res.kind === 'cstimer'
                ? `Imported ${res.solves} solves across ${res.sessions} csTimer sessions`
                : `Restored ${res.solves} solves`, { kind: 'good' });
            } catch (e) {
              status.textContent = 'nothing imported';
              toast(`Could not import that file: ${e.message}`, { kind: 'bad' });
            } finally {
              btn.disabled = false;
              f.value = '';
            }
          });

          return el('div', { class: 'row' },
            el('div', { class: 'lbl' }, el('span', { text: 'Import solves' }), status),
            el('span', {}, btn, f));
        })(),
        el('div', { class: 'hint-note', html:
          'Importing from <b>csTimer</b>: open csTimer, then <b>Export &rarr; Export to file</b>. ' +
          'It saves a <b>.txt</b> — hand that file straight to the picker above. ' +
          'Every session comes across with its own name, its times, its scrambles, ' +
          'its comments and its penalties, and the event is read from the session&rsquo;s ' +
          'scramble type where csTimer recorded one. Nothing already here is touched.' }),
        el('div', { class: 'row' },
          el('div', { class: 'lbl' }, el('span', { text: 'Session as CSV' })),
          el('button', {
            class: 'ghost-btn', text: 'export',
            onclick: () => app.exportSessionCSV(),
          })),
      ),

      group('Account', buildAccountRow(),
        el('div', { class: 'hint-note', html:
            'Signing in follows your solves, sessions, settings and learn-mode progress to ' +
            'any other device you sign into. Nothing about this is required — everything ' +
            'above works the same with no account at all, and signing out never touches ' +
            'what is already on this device.' }),
      ),

      group('Start over',
        el('div', { class: 'row' },
          el('div', { class: 'lbl' },
            el('span', { text: 'Restore defaults' }),
            el('span', { class: 'sub', text: 'every setting back to the day you arrived' })),
          el('button', {
            class: 'ghost-btn danger', text: 'reset',
            onclick: async () => {
              if (!await confirmToast('Put every setting back to its default?', 'reset')) return;
              app.resetSettings();
              closeDrawer();
            },
          })),
        el('div', { class: 'hint-note', html:
          'Resets the appearance, the background, the timer behaviour and where every panel ' +
          'sits. <b>Your solves are not touched</b> — neither are your sessions, the event ' +
          'you are on, the cases you have picked, or your Spotify client ID.' }),
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
/* =========================================================
   GEAR — the cubes you own, and what you did to them
   ========================================================= */

/* A real <select> rather than an input with a <datalist> behind it.
   The datalist version needed two clicks — one to focus the field, another
   before the browser would show the list — and it only committed what you
   picked once the field lost focus. A select opens on the first click and
   fires on the choice itself.

   The seeds are still only a shortcut: the last entry opens a text box, so
   an unlisted brand, a cube that shipped last week, or a lube somebody mixed
   themselves is typed in and kept exactly as typed. */
const CUSTOM = '__custom__';

function picker(value, groups, placeholder, onChange) {
  const known = groups.some(g => g.values.includes(value));
  const sel = el('select', { class: 'inp' }, el('option', { value: '', text: placeholder }));
  for (const g of groups) {
    const parent = g.label ? el('optgroup', { label: g.label }) : sel;
    for (const v of g.values) parent.append(el('option', { value: v }, v));
    if (g.label) sel.append(parent);
  }
  sel.append(el('option', { value: CUSTOM, text: 'something else — type it' }));
  sel.value = value ? (known ? value : CUSTOM) : '';

  const free = el('input', {
    class: 'inp', placeholder: 'type it', value: known ? '' : (value || ''),
    hidden: known || !value,
  });

  sel.addEventListener('change', () => {
    const custom = sel.value === CUSTOM;
    free.hidden = !custom;
    if (custom) { free.focus(); onChange(free.value.trim()); }
    else onChange(sel.value);
  });
  // `input`, not `change`: what you typed is the value the moment you type it,
  // so saving without leaving the field cannot lose it.
  free.addEventListener('input', () => onChange(free.value.trim()));

  return el('div', { class: 'picker' }, sel, free);
}

/* Models are grouped by brand — 77 of them in one flat list is a scroll,
   grouped it is the brand you already picked. */
const groupBy = (rows, key, val) => {
  const out = new Map();
  for (const r of rows) {
    if (!r[key] || !r[val]) continue;
    if (!out.has(r[key])) out.set(r[key], new Set());
    out.get(r[key]).add(r[val]);
  }
  return [...out].map(([label, values]) => ({ label, values: [...values] }));
};
const flat = (rows, key) => [{ label: '', values: [...new Set(rows.map(r => r[key]).filter(Boolean))] }];

/** The add/edit form. `draft` is mutated in place and written on save. */
function gearForm(draft, seeds, saveLabel, after) {
  const set = (k, v) => { draft[k] = v; };
  return group(saveLabel,
    row('Your name for it', el('input', {
      class: 'inp', value: draft.name, placeholder: 'main 3x3',
      oninput: (e) => set('name', e.target.value.trim()),
    }), 'optional — the brand and model are used if you leave it empty'),
    row('Brand', picker(draft.brand, flat(seeds.cubes, 'brand'), 'pick a brand', v => set('brand', v)),
      'not listed? pick “something else” and type it'),
    row('Model', picker(draft.model, groupBy(seeds.cubes, 'brand', 'model'), 'pick a model', v => set('model', v))),
    row('Event', select(EVENT_ORDER.map(id => ({ value: id, label: EVENTS[id].name })), draft.event, v => set('event', v))),
    row('Tension', el('input', {
      class: 'inp', value: draft.tension, placeholder: '4 out, 3 compression',
      oninput: (e) => set('tension', e.target.value.trim()),
    })),
    row('Lube brand', picker(draft.lubeBrand, flat(seeds.lubes, 'brand'), 'pick a brand', v => set('lubeBrand', v))),
    row('Lube', picker(draft.lube, groupBy(seeds.lubes, 'brand', 'name'), 'pick a lube', v => set('lube', v))),
    row('Notes', el('input', {
      class: 'inp', value: draft.notes, placeholder: 'anything worth remembering',
      oninput: (e) => set('notes', e.target.value.trim()),
    })),
    el('div', { class: 'row' }, el('div', { class: 'lbl' }), el('button', {
      class: 'ghost-btn', text: saveLabel.toLowerCase(),
      onclick: async () => { await Gear.put(draft); toast('Saved', { kind: 'good' }); after(draft); },
    })),
  );
}

export function buildGear(app) {
  return async (body) => {
    const redraw = () => openDrawer('Gear', buildGear(app), { wide: true });

    const seeds = await loadSeeds();
    let owned = [];
    try { owned = await Gear.all(); }
    catch (err) {
      console.warn('[gear] collection unavailable', err);
      body.append(el('div', { class: 'hint-note', text:
        'Your gear could not be read from this browser’s storage.' }));
      return;
    }
    const activeId = app.gear?.activeId ?? null;

    body.append(el('div', { class: 'hint-note', html:
      'The cube you mark <b>active</b> is tagged onto every solve you record from then on. ' +
      'Past solves are left alone — they were done on whatever they were done on, and ' +
      'back-filling them would invent the answer the statistics are supposed to give you. ' +
      'Once you own a cube, the trend chart in <b>Statistics</b> can be filtered to it, with a ' +
      'dashed line wherever you logged a change.' }));

    /* The log for one cube, redrawn on its own so adding an entry does not
       tear down and rebuild every card in the drawer. */
    async function renderLog(g, host) {
      host.innerHTML = '';
      let log = [];
      try { log = await GearLog.byGear(g.id); }
      catch (err) { console.warn('[gear] log unavailable', err); return; }

      const kind = select(Object.entries(LOG_KINDS).map(([value, label]) => ({ value, label })), 'lubed', () => {});
      const text = el('input', { class: 'inp', placeholder: 'what changed (optional)' });
      host.append(el('div', { class: 'row gear-log-add' }, kind, text, el('button', {
        class: 'ghost-btn', text: 'log it',
        onclick: async () => {
          await GearLog.put(newLogEntry(g.id, { kind: kind.value, text: text.value.trim() }));
          text.value = '';
          renderLog(g, host);
        },
      })));

      for (const e of log) {
        host.append(el('div', { class: 'row gear-log-row' },
          el('div', { class: 'lbl' },
            el('span', { text: `${LOG_KINDS[e.kind] || e.kind}${e.text ? ' — ' + e.text : ''}` }),
            el('span', { class: 'sub', text: fmtDate(e.at) })),
          el('button', {
            class: 'chip', text: 'remove',
            onclick: async () => { await GearLog.del(e.id); renderLog(g, host); },
          })));
      }
    }

    function editCube(g) {
      openDrawer(`Gear — ${gearLabel(g)}`, (b) => {
        b.append(
          el('div', { class: 'row' }, el('div', { class: 'lbl' }),
            el('button', { class: 'ghost-btn', text: 'back to gear', onclick: redraw })),
          // Renaming the cube you are on has to move the topbar label with it.
          gearForm({ ...g }, seeds, 'Save changes', (saved) => {
            if (app.gear?.activeId === saved.id) app.setGearLabel?.(gearLabel(saved));
            redraw();
          }),
        );
      }, { wide: true });
    }

    const cards = el('div', { class: 'gear-list' });
    if (!owned.length) cards.append(el('div', { class: 'sub', text: 'No cubes yet. Add one below.' }));

    for (const g of owned) {
      const isActive = g.id === activeId;
      const bits = [
        EVENTS[g.event]?.short || g.event,
        [g.brand, g.model].filter(Boolean).join(' '),
        g.tension ? `tension ${g.tension}` : '',
        [g.lubeBrand, g.lube].filter(Boolean).join(' '),
      ].filter(Boolean).join(' · ');

      const logHost = el('div', { class: 'gear-log' });
      cards.append(el('div', { class: 'group gear-card' },
        el('div', { class: 'row' },
          el('div', { class: 'lbl' },
            el('span', { text: gearLabel(g) + (isActive ? '  ·  active' : '') }),
            el('span', { class: 'sub', text: bits })),
          el('div', { class: 'chips' },
            el('button', {
              class: `chip ${isActive ? 'on' : ''}`,
              text: isActive ? 'active' : 'make active',
              onclick: async () => {
                const next = isActive ? null : g.id;
                await setActiveGearId(next);
                app.gear = { ...(app.gear || {}), activeId: next };
                app.setGearLabel?.(next ? gearLabel(g) : null);
                toast(next ? `Solves are now tagged ${gearLabel(g)}` : 'Solves are no longer tagged',
                  { kind: 'good' });
                redraw();
              },
            }),
            el('button', { class: 'chip', text: 'edit', onclick: () => editCube(g) }),
            el('button', {
              class: 'chip', text: 'delete',
              onclick: async () => {
                if (!await confirmToast(`Delete ${gearLabel(g)} and its log?`, 'delete')) return;
                await Gear.del(g.id);
                if (app.gear?.activeId === g.id) { app.gear.activeId = null; app.setGearLabel?.(null); }
                /* The solves keep their cubeId. They really were done on it,
                   and a filter that quietly forgets that is worse than one
                   that offers a cube you no longer own. */
                toast('Cube deleted — the solves it recorded are untouched');
                redraw();
              },
            }),
          )),
        g.notes ? el('div', { class: 'sub', text: g.notes }) : null,
        logHost));
      renderLog(g, logHost);
    }

    body.append(group('Your cubes', cards));
    body.append(gearForm(newGear({}), seeds, 'Add a cube', redraw));
  };
}

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
    /* The cube filter starts as "all cubes" and stays that way if you own
       none — the row appears only once there is something to choose between,
       so a session that has never touched the gear log looks exactly as it
       did before. */
    const cubePick = el('select', { class: 'inp' }, el('option', { value: '', text: 'all cubes' }));
    const cubeRow = el('div', { class: 'chart-filter', hidden: true },
      el('span', { class: 'bs-sub', text: 'Cube' }), cubePick);

    const drawTrend = (list, markers) => {
      renderTrend(trendHost, list, (s, i) => {
        hoverInfo.textContent = s ? `#${i + 1}  ${eff(s) === DNF ? 'DNF' : fmt(eff(s))}  ·  ${s.scramble.slice(0, 60)}` : '';
      }, { markers });
    };

    body.append(el('div', { class: 'chart-card' },
      el('h4', { text: 'Trend — solves, ao5, ao12, PB' }), cubeRow, trendHost, hoverInfo));
    drawTrend(solves, []);

    (async () => {
      let owned = [];
      try { owned = await Gear.all(); } catch (err) { console.warn('[gear] chart filter unavailable', err); return; }
      if (!owned.length) return;
      for (const g of owned) cubePick.append(el('option', { value: g.id, text: gearLabel(g) }));
      cubeRow.hidden = false;
      cubePick.addEventListener('change', async () => {
        const id = cubePick.value;
        const list = filterByCube(solves, id);
        /* Only the selected cube's events are drawn. Every cube's log on one
           line would be a picket fence you cannot read a change out of. */
        let markers = [];
        if (id) {
          try {
            const log = await GearLog.byGear(id);
            markers = markersFor(list, log).map(m => ({ ...m, label: LOG_KINDS[m.kind] || m.kind }));
          } catch (err) { console.warn('[gear] log unavailable', err); }
        }
        hoverInfo.textContent = '';
        drawTrend(list, markers);
      });
    })();

    const histHost = el('div');
    body.append(el('div', { class: 'chart-card' }, el('h4', { text: 'Distribution' }), histHost));
    renderHistogram(histHost, solves);

    /* The heatmap reads the whole store rather than this session, so it is the
       one chart that can go stale while the panel is open: deleting solves
       elsewhere in the drawer left the old grid on screen. Re-read on demand,
       and hang the reloader off the host so anything that changes solves can
       call it. */
    const heatHost = el('div', { class: 'heat-host' });
    body.append(el('div', { class: 'chart-card' },
      el('h4', { text: 'Practice heatmap — all events, last 12 months' }), heatHost));
    const drawHeat = () => app.allSolves().then(all => renderHeatmap(heatHost, all));
    heatHost.refresh = drawHeat;
    drawHeat();

    const bs = bldSummary(solves);
    if (bs) {
      const pct = (v) => Math.round(v * 100);
      /* The headline share is worked out from the very means printed beside
         it, not from bs.ratio: a mean of per-solve shares is the better
         statistic but it does not divide the two figures on screen, and a
         "memo 4.10 · exec 4.19 · 59% memo" card reads as a bug. bs.ratio
         still drives the drift and the trend, where the direction is the
         point and one long solve should not own the answer. */
      const share = bs.memo / Math.max(1, bs.memo + bs.exec);
      const drift = bs.drift === null ? null : pct(bs.drift);
      /* A bar rather than a chart: it is one number, and the only comparison
         that matters is memo against exec inside the same solve. */
      const bar = el('div', { class: 'me-bar' },
        el('span', { class: 'me-memo', style: { width: pct(share) + '%' } }),
        el('span', { class: 'me-exec', style: { width: (100 - pct(share)) + '%' } }));

      const trend = el('div', { class: 'me-trend' });
      for (const r of bs.ratios.slice(-40)) {
        trend.append(el('i', { style: { height: Math.max(4, Math.round(r * 100)) + '%' } }));
      }

      const verdict = drift === null
        ? 'Not enough blind solves yet to say which way it is drifting.'
        : Math.abs(drift) < 3
          ? 'Your split is holding steady across the session.'
          : drift > 0
            ? 'Your memo is taking proportionally longer than it was earlier in the session — ' +
              (bs.count >= 6 ? 'up ' + drift + ' points over the last ' + bs.window + ' solves.' : '')
            : 'Execution is taking proportionally longer than it was earlier — ' +
              'down ' + Math.abs(drift) + ' points over the last ' + bs.window + ' solves, so ' +
              'your turning rather than your memo is the slower half tonight.';

      body.append(el('div', { class: 'chart-card' },
        el('h4', { text: 'Memo and execution — ' + bs.count + ' blind solves' }),
        el('div', { class: 'big-stats' },
          cell('memo', fmt(bs.memo), pct(share) + '% of the solve'),
          cell('exec', fmt(bs.exec), (100 - pct(share)) + '% of the solve'),
          cell('split', pct(share) + '/' + (100 - pct(share)),
            drift === null ? 'no trend yet' : (drift > 0 ? '+' : '') + drift + ' pts recently')),
        bar,
        el('div', { class: 'bs-sub', text: 'memo share, one bar per solve (last 40)' }),
        trend,
        el('div', { class: 'hint-note', text: verdict + ' Elite blind solvers often sit near 30/70, ' +
          'but that is a reference point, not a target — the number worth watching is your own drift.' })));
    }

    if (cases.length) {
      const caseHost = el('div');
      body.append(el('div', { class: 'chart-card' },
        el('h4', { text: 'Slowest cases in this session' }), caseHost));
      renderCaseBars(caseHost, cases);
    }
  };
}


/* =========================================================
   BLINDSOLVING

   Buffers, orientation and the letter scheme. Reached from the gear on the
   breakdown panel as well as from Settings, because hunting through a
   general settings drawer mid-session is exactly what this is meant to
   replace.
   ========================================================= */

/* Every sticker of a piece type, as face-first names — a buffer is a sticker.
   These are the scheme's own keys rather than names spun out of CORNER_NAMES:
   a corner sticker has two spellings ("UFR" and "URF" are one sticker), and
   the letter map is keyed by only one of them, so generating the other set
   left half the corner list lettered "?" and the saved buffer unselectable. */
const CORNER_STICKERS = CORNER_STICKER_KEYS;
const EDGE_STICKERS   = EDGE_STICKER_KEYS;

export function buildBlindsolving(app) {
  return (body) => {
    const bld = () => app.settings.bld;
    /* One object, written whole. The tracer reads several of these keys
       together, so half-applied changes are not a state worth having. */
    const set = (patch) => {
      app.setSetting('bld', { ...bld(), ...patch });
      app.bldChanged?.();
    };
    const redraw = () => openDrawer('Blindsolving', buildBlindsolving(app));

    const lettersOf = () => ({ ...DEFAULT_SPEFFZ_MAP, ...(bld().letters || {}) });

    /* A buffer is picked as a sticker, because which sticker it is decides
       the orientation of every shot — but nobody thinks of theirs as "UR",
       they think of it as "B". So the list says both, in letter order. */
    const bufferOptions = (stickers) => {
      const letters = lettersOf();
      return stickers
        .map(v => ({ value: v, label: `${letters[v] || '?'} · ${v}`, key: letters[v] || 'ZZ' }))
        .sort((a, b) => a.key.localeCompare(b.key) || a.value.localeCompare(b.value));
    };

    /* The scheme editor. Corners and edges each carry their own A-X, so
       duplicates are only duplicates within one of the two halves. */
    const schemeGrid = (keys, title) => {
      const wrap = el('div', { class: 'scheme-grid' });
      const inputs = new Map();
      const validate = () => {
        const seen = new Map();
        for (const [k, inp] of inputs) {
          const v = inp.value.trim().toUpperCase();
          if (!v) continue;
          seen.set(v, (seen.get(v) || 0) + 1);
          void k;
        }
        for (const [, inp] of inputs) {
          const v = inp.value.trim().toUpperCase();
          inp.closest('.scheme-cell').classList.toggle('dupe', !!v && seen.get(v) > 1);
        }
      };
      for (const k of keys) {
        const inp = el('input', { class: 'inp scheme-inp', maxlength: 1, value: lettersOf()[k] || '' });
        inp.addEventListener('input', () => {
          inp.value = inp.value.replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 1);
          validate();
          if (!inp.value) return;
          // Any edit at all means the scheme is the solver's own now — the
          // same rule the theme editor uses for "custom".
          set({ scheme: 'custom', letters: { ...lettersOf(), [k]: inp.value } });
        });
        inputs.set(k, inp);
        wrap.append(el('label', { class: 'scheme-cell' }, el('span', { text: k }), inp));
      }
      validate();
      return el('div', { class: 'scheme-block' }, el('h4', { text: title }), wrap);
    };

    const up = bld().orientation?.up || 'U';
    const front = bld().orientation?.front || 'F';

    body.append(
      el('div', { class: 'hint-note', html:
        'These are the letters and buffers <b>you</b> learned. Nothing below is baked into the ' +
        'tracer — change a buffer and every breakdown from the next scramble on is re-read against it.' }),

      group('Buffers',
        row('Edge buffer', select(bufferOptions(EDGE_STICKERS), bld().edgeBuffer,
          v => set({ edgeBuffer: v })), 'the sticker you shoot from, not just the piece'),
        row('Corner buffer', select(bufferOptions(CORNER_STICKERS), bld().cornerBuffer,
          v => set({ cornerBuffer: v }))),
      ),

      group('Orientation',
        row('Up face', select(FACES.map(f => ({ value: f, label: faceLabel(f) })), up, (v) => {
          const fronts = frontsFor(v);
          set({ orientation: { up: v, front: fronts.includes(front) ? front : fronts[0] } });
          redraw();
        }), 'which face was up when you assigned the letters'),
        row('Front face', select(frontsFor(up).map(f => ({ value: f, label: faceLabel(f) })), front,
          v => set({ orientation: { up, front: v } }))),
        row('Turn it back before memo', toggle(bld().reorient !== false, v => set({ reorient: v })),
          'on: the faces above always mean the same colours. off: you memo the cube exactly as the '
          + 'scramble hands it to you, wide moves and all'),
        el('div', { class: 'hint-note', text:
          'The default is the WCA one — white on top, green on front. A WCA blind scramble ends in '
          + 'wide moves, so the cube arrives turned; leave the switch on and the tracer turns it back '
          + 'the way you do, rather than renaming every letter.' }),
      ),

      group('Letter scheme',
        row('Scheme', el('div', { class: 'lbl' },
          el('span', { text: bld().scheme === 'custom' ? 'Custom' : 'Speffz' })),
          'editing any cell below makes it custom'),
        el('div', { class: 'row' },
          el('div', { class: 'lbl' },
            el('span', { text: 'Reset' }),
            el('span', { class: 'sub', text: 'back to standard Speffz' })),
          el('button', {
            class: 'ghost-btn', text: 'reset to Speffz',
            onclick: () => {
              set({ scheme: 'speffz', letters: { ...DEFAULT_SPEFFZ_MAP } });
              redraw();
              toast('Letters back to Speffz', { kind: 'good' });
            },
          })),
        schemeGrid(CORNER_STICKER_KEYS, 'Corners'),
        schemeGrid(EDGE_STICKER_KEYS, 'Edges'),
      ),

      group('Breakdown',
        row('Show breakdown by default', toggle(bld().showBreakdownByDefault, v => set({ showBreakdownByDefault: v })),
          'off means the panel starts collapsed every session'),
        row('Memo / execution split', toggle(bld().memoExecSplit, v => set({ memoExecSplit: v })),
          'the first press mid-solve ends the memo instead of the solve'),
      ),

      group('Letter pairs',
        el('div', { class: 'row' },
          el('div', { class: 'lbl' },
            el('span', { text: 'Pair dictionary' }),
            el('span', { class: 'sub', text: 'the words, images and algs behind your letters' })),
          el('button', {
            class: 'ghost-btn', text: 'open',
            onclick: () => openDrawer('Letter pairs', buildLetterPairs(app), { wide: true }),
          })),
      ),

      el('div', { class: 'hint-note', html:
        '<b>Commutators are yours, not the app’s.</b> An &ldquo;optimal&rdquo; comm for a pair depends on ' +
        'your buffer, your scheme and your fingers, so nothing here invents one. Save your own against ' +
        'a pair in the dictionary and it shows up whenever that pair does.' }),
    );
  };
}

/* =========================================================
   LETTER PAIRS
   ========================================================= */
export function buildLetterPairs(app, focus = '') {
  return (body) => {
    const list = el('div', { class: 'lp-list' });
    const editor = el('div', { class: 'lp-editor' });
    let all = [];

    const openEditor = (rec) => {
      editor.textContent = '';
      const r = { pair: '', word: '', imageUrl: null, alg: '', notes: '', ...(rec || {}) };
      const pairInp = el('input', { class: 'inp', maxlength: 2, value: r.pair, placeholder: 'BK' });
      const wordInp = el('input', { class: 'inp', value: r.word || '', placeholder: 'Book' });
      const algInp  = el('input', { class: 'inp', value: r.alg || '', placeholder: "R U' R' ..." });
      const noteInp = el('input', { class: 'inp', value: r.notes || '', placeholder: 'anything worth remembering' });
      const preview = el('div', { class: 'lp-img' });
      const paint = () => {
        preview.textContent = '';
        if (r.imageUrl) preview.append(el('img', { src: r.imageUrl, alt: r.word || r.pair }));
      };
      paint();

      const file = el('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
      file.addEventListener('change', () => {
        const f = file.files?.[0];
        if (!f) return;
        // Kept on the record as a data URI: the dictionary has to survive a
        // reload and an export, and a blob URL survives neither.
        if (f.size > 512 * 1024) { toast('Keep memo images under 512 KB'); return; }
        const fr = new FileReader();
        fr.onload = () => { r.imageUrl = String(fr.result); paint(); };
        fr.readAsDataURL(f);
      });

      const save = async () => {
        const pair = pairInp.value.trim().toUpperCase();
        if (pair.length !== 2 || !/^[A-Z]{2}$/.test(pair)) { toast('A pair is exactly two letters'); return; }
        await LetterPairs.put({
          pair, word: wordInp.value.trim(), imageUrl: r.imageUrl,
          alg: algInp.value.trim(), notes: noteInp.value.trim(),
        });
        toast('Saved ' + pair, { kind: 'good' });
        editor.textContent = '';
        await refresh();
      };

      editor.append(group(r.pair ? 'Edit ' + r.pair : 'New pair',
        row('Pair', pairInp),
        row('Word', wordInp),
        row('Algorithm', algInp, 'your own commutator for this pair'),
        row('Notes', noteInp),
        el('div', { class: 'row' },
          el('div', { class: 'lbl' }, el('span', { text: 'Image' }), el('span', { class: 'sub', text: 'optional, under 512 KB' })),
          el('div', { class: 'lp-imgrow' },
            el('button', { class: 'ghost-btn', text: 'choose', onclick: () => file.click() }),
            r.imageUrl ? el('button', { class: 'ghost-btn', text: 'remove', onclick: () => { r.imageUrl = null; paint(); } }) : null,
            file)),
        preview,
        el('div', { class: 'row' },
          el('div', { class: 'lbl' }, el('span', { text: '' })),
          el('div', { class: 'lp-actions' },
            el('button', { class: 'ghost-btn', text: 'save', onclick: save }),
            el('button', { class: 'ghost-btn', text: 'cancel', onclick: () => { editor.textContent = ''; } }),
            r.pair ? el('button', {
              class: 'ghost-btn danger', text: 'delete',
              onclick: async () => {
                if (!await confirmToast('Delete ' + r.pair + '?', 'delete')) return;
                await LetterPairs.del(r.pair);
                editor.textContent = '';
                await refresh();
              },
            }) : null)),
      ));
      editor.scrollIntoView?.({ block: 'nearest' });
    };

    const search = el('input', { class: 'inp', placeholder: 'search a pair, a word, an alg' });
    const paintList = () => {
      const q = search.value.trim().toLowerCase();
      const rows = all.filter(r => !q || r.pair.toLowerCase().includes(q)
        || (r.word || '').toLowerCase().includes(q) || (r.alg || '').toLowerCase().includes(q));
      list.textContent = '';
      if (!rows.length) {
        list.append(el('div', { class: 'hint-note', text: all.length
          ? 'Nothing matches that.'
          : 'No pairs saved yet. Add one here, or click any pair in the breakdown panel.' }));
        return;
      }
      for (const r of rows) {
        list.append(el('button', { class: 'lp-row', onclick: () => openEditor(r) },
          el('b', { text: r.pair }),
          el('span', { class: 'lp-word', text: r.word || '—' }),
          r.alg ? el('span', { class: 'lp-alg', text: r.alg }) : null,
          r.imageUrl ? el('span', { class: 'lp-dot', title: 'has an image' }) : null));
      }
    };

    const refresh = async () => { all = await LetterPairs.all(); paintList(); };
    search.addEventListener('input', paintList);

    body.append(
      group('Your pairs',
        row('Search', search),
        el('div', { class: 'row' },
          el('div', { class: 'lbl' }, el('span', { text: 'Add' }), el('span', { class: 'sub', text: 'two letters and whatever you see' })),
          el('button', { class: 'ghost-btn', text: 'new pair', onclick: () => openEditor(null) })),
        list),
      editor,
      group('Import / export',
        el('div', { class: 'row' },
          el('div', { class: 'lbl' },
            el('span', { text: 'Export' }),
            el('span', { class: 'sub', text: 'every pair as JSON' })),
          el('button', {
            class: 'ghost-btn', text: 'export',
            onclick: async () => {
              download('tagdatimer-letterpairs.json', JSON.stringify(await LetterPairs.all(), null, 2));
              toast('Pairs downloaded', { kind: 'good' });
            },
          })),
        (() => {
          const f = el('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' } });
          f.addEventListener('change', async () => {
            const file0 = f.files?.[0];
            if (!file0) return;
            try {
              const data = JSON.parse(await file0.text());
              const rows = (Array.isArray(data) ? data : data.letterPairs || [])
                .filter(r => r && /^[A-Za-z]{2}$/.test(String(r.pair || '')))
                .map(r => ({ ...r, pair: String(r.pair).toUpperCase() }));
              if (!rows.length) throw new Error('no pairs in that file');
              await LetterPairs.putMany(rows);
              await refresh();
              toast('Imported ' + rows.length + ' pairs', { kind: 'good' });
            } catch (err) {
              toast('Could not read that file: ' + err.message);
            } finally { f.value = ''; }
          });
          return el('div', { class: 'row' },
            el('div', { class: 'lbl' },
              el('span', { text: 'Import' }),
              el('span', { class: 'sub', text: 'a sheet you already built elsewhere' })),
            el('div', {}, el('button', { class: 'ghost-btn', text: 'import', onclick: () => f.click() }), f));
        })(),
      ),
    );

    refresh().then(() => {
      if (focus) openEditor(all.find(r => r.pair === focus) || { pair: focus });
    });
  };
}

/* =========================================================
   DNF POST-MORTEM

   Click the pieces that were still wrong when the blindfold came off, and
   the memo that was stored with the solve says which target they were.
   ========================================================= */
export function buildPostMortem(app, solve) {
  return (body) => {
    const bld = solve.bld;
    if (!bld?.edges) {
      body.append(el('div', { class: 'hint-note', text: 'No breakdown was stored with this solve.' }));
      return;
    }

    const wrong = (bld.dnfPieces || []).map(p => ({ ...p }));
    const canvas = el('canvas', { class: 'pm-net' });
    const out = el('div', { class: 'pm-out' });
    const summary = el('div', { class: 'pm-picked' });

    const targets = (g, label) => el('div', { class: 'pm-memo' },
      el('span', { class: 'pm-memo-k', text: label }),
      el('span', { class: 'pm-memo-v', text: g.letters.length ? g.letters.join(' ') : 'nothing' }));

    let layout = null;
    let net = null;

    const paint = async () => {
      const mod = await import('./cubenet.js');
      const dpr = Math.min(2, devicePixelRatio || 1);
      const w = canvas.clientWidth || 420;
      const h = Math.round(w * 3 / 4);
      canvas.width = w * dpr; canvas.height = h * dpr;
      canvas.style.height = h + 'px';
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      // The solved cube, deliberately: you are pointing at where pieces
      // ended up, not re-reading the scramble.
      net = net || mod.faceletsFor('', 3);
      layout = mod.drawNet(ctx, net, 3, 0, 0, w, h);
      if (!layout) return;

      // Outline every sticker of a piece that has been marked.
      ctx.lineWidth = Math.max(2, layout.cell * 0.14);
      ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--danger').trim() || '#ff4d6d';
      for (const p of wrong) {
        for (const [face, r, c] of faceletsOfPiece(p)) {
          const [cx, cy] = layout.place[face];
          ctx.strokeRect(layout.ox + (cx + c) * layout.cell + layout.gap / 2,
                         layout.oy + (cy + r) * layout.cell + layout.gap / 2,
                         layout.cell - layout.gap, layout.cell - layout.gap);
        }
      }
      summary.textContent = wrong.length
        ? 'Marked: ' + wrong.map(pieceName).join(', ')
        : 'Click the pieces that were still wrong.';
    };

    canvas.addEventListener('click', (e) => {
      if (!layout) return;
      const r = canvas.getBoundingClientRect();
      import('./cubenet.js').then((mod) => {
        const hit = mod.netHit(layout, 3, e.clientX - r.left, e.clientY - r.top);
        if (!hit) return;
        const piece = pieceAtFacelet(hit.face, hit.r, hit.c);
        if (!piece) return;                       // a centre never moves
        const at = wrong.findIndex(w => samePiece(w, piece));
        if (at >= 0) wrong.splice(at, 1);
        else if (wrong.length >= 6) { toast('Six pieces is already more than a failure shape'); return; }
        else wrong.push({ type: piece.type, slot: piece.slot });
        out.textContent = '';
        paint();
      });
    });

    const run = async () => {
      const lines = diagnose(bld, wrong);
      out.textContent = '';
      if (!lines) {
        out.append(el('div', { class: 'hint-note', text: 'Mark at least one piece first.' }));
        return;
      }
      for (const line of lines) out.append(el('div', { class: 'pm-line', text: line }));
      solve.bld.dnfPieces = wrong.map(w => ({ ...w }));
      solve.bld.dnfDiagnosis = lines;
      await Solves.put(solve);
    };

    body.append(
      el('div', { class: 'hint-note', html:
        'The net below is a <b>solved</b> cube. Click the two or three pieces that were still wrong when ' +
        'the blindfold came off, then ask for a read on it. This matches the pieces against the memo that ' +
        'was stored with the solve — it is pattern-matching against known failure shapes, not a guess.' }),
      group('What was left',
        canvas,
        summary,
        el('div', { class: 'row' },
          el('div', { class: 'lbl' }, el('span', { text: 'Diagnosis' })),
          el('div', { class: 'lp-actions' },
            el('button', { class: 'ghost-btn', text: 'diagnose', onclick: run }),
            el('button', {
              class: 'ghost-btn', text: 'clear',
              onclick: () => { wrong.length = 0; out.textContent = ''; paint(); },
            }))),
        out),
      group('The memo this solve stored',
        targets(bld.edges, 'edges'),
        targets(bld.corners, 'corners'),
        bld.parity ? el('div', { class: 'hint-note', text: 'This scramble had parity.' }) : null,
        Number.isFinite(bld.memoMs)
          ? el('div', { class: 'hint-note', text: 'memo ' + fmt(bld.memoMs) + '  ·  exec ' + fmt(bld.execMs) })
          : null),
    );

    /* The net is drawn into a bitmap sized from the element, so it has to be
       redrawn whenever that size changes — a drawer opened before the layout
       had settled, or a window resized afterwards, would otherwise leave a
       blank canvas with no way back. */
    if (typeof ResizeObserver === 'function') {
      let last = 0;
      new ResizeObserver(() => {
        const w = Math.round(canvas.clientWidth);
        if (w && w !== last) { last = w; paint(); }
      }).observe(canvas);
    }
    requestAnimationFrame(() => { paint(); });
    if (bld.dnfDiagnosis?.length) for (const line of bld.dnfDiagnosis) out.append(el('div', { class: 'pm-line', text: line }));
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
   YOUR OWN SCRAMBLES
   =========================================================
   Paste a list, get them back one at a time in the order you pasted.
   The list itself lives in IndexedDB, not in settings — ten thousand
   lines has no business in an object that is rewritten on every slider
   drag — so this panel only ever holds the text being edited.
   ========================================================= */
export function buildCustomScrambles(app) {
  return (body) => {
    const c = app.custom;
    const remaining = Math.max(0, c.list.length - c.pos);

    const ta = el('textarea', {
      class: 'inp scramble-box',
      rows: 12,
      spellcheck: 'false',
      placeholder: [
        'One scramble per line — paste as many as you like.',
        '',
        "R U R' U' F' U F",
        "D2 L2 F2 U' B2 U ...",
        '',
        'Any "1)" or "1." numbering is stripped for you.',
      ].join('\n'),
    });

    const count = el('div', { class: 'sub', text: 'nothing pasted yet' });
    const recount = () => {
      const n = parseScrambleList(ta.value).length;
      count.textContent = n ? `${n} scramble${n === 1 ? '' : 's'} ready to load` : 'nothing pasted yet';
    };
    ta.addEventListener('input', recount);

    const file = el('input', { type: 'file', accept: '.txt,text/plain', style: { display: 'none' } });
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      if (!f) return;
      ta.value = await f.text();
      recount();
      file.value = '';
    });

    const load = (append) => () => {
      if (!ta.value.trim()) { toast('Paste some scrambles first'); return; }
      app.setCustomScrambles(ta.value, { append });
    };

    body.append(
      group('Load a list',
        el('div', { class: 'hint-note', html:
          'While a list is loaded the generator steps aside completely: every ' +
          '<b>next</b> hands you the following line, in order, and each solve is ' +
          'recorded against the scramble it was actually done on. When the list ' +
          'runs out the timer goes back to generating its own.' }),
        ta,
        el('div', { class: 'row' },
          el('div', { class: 'lbl' }, el('span', { text: 'Ready' }), count),
          el('span', {},
            el('button', { class: 'ghost-btn', text: 'from a file', onclick: () => file.click() }),
            file)),
        el('div', { class: 'sd-actions' },
          el('button', { class: 'btn primary', text: 'use these scrambles', onclick: load(false) }),
          el('button', { class: 'ghost-btn', text: 'add to the current list', onclick: load(true) }),
        ),
      ),

      c.list.length
        ? group('Currently loaded',
            el('div', { class: 'row' },
              el('div', { class: 'lbl' },
                el('span', { text: `${c.list.length} scrambles` }),
                el('span', { class: 'sub', text: remaining
                  ? `on number ${Math.min(c.pos + 1, c.list.length)} — ${remaining} still to come`
                  : 'all of them used' })),
              el('span', {},
                el('button', { class: 'ghost-btn', text: 'start over', onclick: () => { app.restartCustomScrambles(); closeDrawer(); } }),
                el('button', { class: 'ghost-btn danger', text: 'discard', onclick: () => { app.clearCustomScrambles(); closeDrawer(); } }))),
            // A preview, capped: showing ten thousand rows would lock the drawer
            // for as long as it took to build them.
            el('div', { class: 'cs-preview' },
              ...c.list.slice(0, 60).map((line, i) => el('div', {
                class: `cs-line ${i < c.pos ? 'done' : ''} ${i === c.pos ? 'now' : ''}`,
              },
                el('span', { class: 'cs-i', text: String(i + 1) }),
                el('span', { class: 'cs-s', text: line }))),
              c.list.length > 60
                ? el('div', { class: 'cs-line more', text: `…and ${c.list.length - 60} more` })
                : null,
            ))
        : null,
    );

    recount();
  };
}

/* =========================================================
   CASE PICKER (trainer modes)
   ========================================================= */
/** Where learn mode has got to in the current set, in one line. */
function learnSummary(app) {
  if (!app.learn?.enabled) return '';
  const s = app.learn.stats();
  return `${s.due} due · ${s.new} unseen · ${s.mature} known of ${s.total}`;
}

export function buildCases(app) {
  return (body) => {
    const modeId = app.settings.mode;
    const set = setFor(modeId);
    if (!set) { body.append(el('div', { class: 'hint-note', text: 'This mode has no case list.' })); return; }

    const allowed = new Set(app.settings.allowedCases[modeId] || set.map(c => c.id));
    const learnLine = el('span', { class: 'sub', text: learnSummary(app) });
    const stats = new Map(byCase(app.solves).map(r => [r.caseId, r]));
    const grid = el('div', { class: 'case-grid' });

    /* ZBLL is 472 cases and F2L is taught in six groups, so a flat grid is the
       wrong shape for either. Where the set says what group a case is in, the
       row of chips narrows the grid down to one of them — and everything below
       it, the all/none/invert buttons included, then works on just what you can
       see, which is how you say "only the T set" in two clicks. */
    const groups = [...new Set(set.map(c => c.group).filter(Boolean))];
    const grouped = groups.length > 1;
    let only = '';                                   // '' = every group
    const shown = () => (only ? set.filter(c => c.group === only) : set);
    const count = el('span', { class: 'sub' });

    const paint = () => {
      grid.innerHTML = '';
      const list = shown();
      count.textContent = `${list.filter(c => allowed.has(c.id)).length} of ${list.length} on`;
      for (const c of list) {
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
          count.textContent = `${shown().filter(x => allowed.has(x.id)).length} of ${shown().length} on`;
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

    const groupChips = !grouped ? null : el('div', { class: 'chips' },
      ...[['', 'all groups'], ...groups.map(g => [g, labelOf(set, g)])].map(([g, text]) =>
        el('button', {
          class: `chip ${only === g ? 'on' : ''}`,
          text: `${text}${g ? ` · ${set.filter(c => c.group === g).length}` : ''}`,
          onclick: (e) => {
            only = g;
            for (const b of e.currentTarget.parentElement.children) b.classList.remove('on');
            e.currentTarget.classList.add('on');
            paint();
          },
        })),
    );

    body.append(
      el('div', { class: 'hint-note', text:
        `${MODES[modeId].name} — pick which cases you want to drill. Times shown are your session average for that case.` }),
      /* Learn mode works on exactly the cases switched on below, so the switch
         for it belongs here rather than three panels away. */
      el('div', { class: 'chips' },
        el('button', {
          class: `chip ${app.learn?.enabled ? 'on' : ''}`,
          text: app.learn?.enabled ? 'learn mode is on' : 'learn these cases',
          title: 'Show the algorithm for a case you have not seen, and bring back the ones you fumble  (L)',
          onclick: (e) => {
            if (!app.learn) return;
            app.learn.setEnabled(!app.learn.enabled);
            e.currentTarget.classList.toggle('on', app.learn.enabled);
            e.currentTarget.textContent = app.learn.enabled ? 'learn mode is on' : 'learn these cases';
            learnLine.textContent = learnSummary(app);
          },
        }),
        learnLine),
      groupChips,
      el('div', { class: 'chips' },
        el('button', { class: 'chip', text: 'all', onclick: bulk(() => shown().forEach(c => allowed.add(c.id))) }),
        el('button', { class: 'chip', text: 'none', onclick: bulk(() => { shown().forEach(c => allowed.delete(c.id)); if (!allowed.size) allowed.add(shown()[0].id); }) }),
        el('button', { class: 'chip', text: 'invert', onclick: bulk(() => {
          for (const c of shown()) { if (allowed.has(c.id)) allowed.delete(c.id); else allowed.add(c.id); }
          if (!allowed.size) allowed.add(shown()[0].id);
        }) }),
        el('button', { class: 'chip', text: 'my worst 8', onclick: bulk(() => {
          const ranked = byCase(app.solves).filter(r => r.avg !== null).sort((a, b) => b.avg - a.avg).slice(0, 8);
          if (!ranked.length) { toast('Do some solves first so I know what your worst cases are'); return; }
          allowed.clear(); ranked.forEach(r => allowed.add(r.caseId));
        }) }),
        count,
      ),
      grid,
    );
    paint();
  };
}

/** What a group calls itself, taken from any case that is in it. */
const labelOf = (set, group) => set.find(c => c.group === group)?.label || group;

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
    ['X', 'enter your own scrambles'],
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
    ['L', 'learn mode on / off'],
    ['G', 'show the alg (counts as not knowing it)'],
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
  // Only while Settings > Timing input is "Virtual cube"; these letters then
  // turn the cube instead of doing what the lists above say.
  ['Virtual cube', [
    ['I  K', "R  /  R'"], ['D  E', "L  /  L'"], ['J  F', "U  /  U'"], ['S  L', "D  /  D'"],
    ['H  G', "F  /  F'"], ['W  O', "B  /  B'"], ['U  M', "r  /  r'"], ['V  R', "l  /  l'"],
    [',  C', "u  /  u'"], ['Z  /', "d  /  d'"], ['5  6  X  .', "M  /  M'"],
    ['T  Y  B  N', "x  /  x'"], [';  A', "y  /  y'"], ['P  Q', "z  /  z'"],
    ['Space', 'inspection'], ['Esc', 'reset the cube'],
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
const GH_HANDLE = 'MMHJIALOL';
const GH_PROFILE = `https://github.com/${GH_HANDLE}`;
const AVATAR = 'assets/ishaan.jpg';

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
          el('img', { class: 'about-avatar', src: AVATAR, alt: 'Ishaan', width: 52, height: 52, loading: 'lazy', decoding: 'async' }),
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
        arrow(link('GitHub', GH_PROFILE, '@' + GH_HANDLE)),
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

/* =========================================================
   RACE

   The lobby: who you are, which room, and the two facts about race mode that
   are worth knowing before you join rather than after.
   ========================================================= */
export function buildRace(app) {
  return (body) => {
    const S = app.settings;
    const set = (k, v) => app.setSetting(k, v);

    const render = async () => {
      const race = await app.raceModule();
      const { randomCode, normaliseCode, raceable } = race;
      const ctl = race.getRace(app);
      const inRoom = ctl.inRoom;
      const cloud = race.cloudAvailable();
      const ok = raceable(S.event);

      /* Sign in and pull the SDK down now rather than when Join is pressed.
         Everything in this drawer is a second or two of reading, and that is
         exactly the handshake that used to happen after the click — which is
         why creating a room felt like nothing had happened. */
      if (!inRoom && ok) ctl.warm();

      body.innerHTML = '';

      /* ---- where you are ---- */
      body.append(group('Race',
        el('div', { class: `race-hero ${inRoom ? 'on' : ''}` },
          el('div', { class: 'race-hero-dot' }),
          el('div', {},
            el('div', { class: 'race-hero-title', text: inRoom ? `Room ${ctl.snap.roomId}` : 'Not in a room' }),
            el('div', { class: 'race-hero-sub', text: inRoom
              ? 'Everyone here races the same scramble. Nobody’s time appears until you have finished it too.'
              : 'Same scramble for everyone in the room. You see their times only once you have solved it yourself — and they see yours on the same terms.' }),
            !cloud ? el('div', { class: 'race-hero-warn', text:
              'No Firebase project is configured on this deployment, so rooms are local: '
              + 'other tabs of this browser can join, but nobody on another machine can. '
              + 'See RACE.md to turn on real rooms.' }) : null,
            !ok ? el('div', { class: 'race-hero-warn', text:
              `${EVENTS[S.event]?.name || S.event} cannot be raced — it does not end in one time to compare. `
              + 'Switch to a normal speed event first.' }) : null,
          ),
          inRoom
            ? el('button', { class: 'btn danger', text: 'Leave',
                onclick: async () => { await ctl.leave(); render(); } })
            : null,
        ),
      ));

      /* ---- identity ---- */
      const nameInput = el('input', {
        class: 'inp', type: 'text', maxlength: 18, placeholder: ctl.nickname(),
        value: S.raceName || '',
      });
      nameInput.addEventListener('change', () => set('raceName', nameInput.value.trim().slice(0, 18)));
      body.append(group('You',
        row('Display name', nameInput, 'what the room calls you, on the leaderboard and everywhere else — ' +
          'editable here or from the account icon in the top bar, and synced along with everything else once signed in'),
      ));

      /* ---- joining ---- */
      if (!inRoom) {
        const code = el('input', {
          class: 'inp', type: 'text', maxlength: 12, placeholder: 'room code',
          value: S.raceLastRoom || '', spellcheck: 'false', autocapitalize: 'characters',
        });
        code.addEventListener('input', () => { code.value = normaliseCode(code.value); });

        const go = async (id) => {
          if (!ok) { toast('This event cannot be raced', { kind: 'bad' }); return; }
          try {
            await ctl.join(id);
            toast(`Joined ${id}`, { kind: 'good' });
            render();
          } catch (err) {
            /* The toast has to stay short; the real cause (permission_denied,
               unauthorized-domain, a dropped socket) only exists here. */
            console.error('[race] join failed:', err);
            const why = err?.message === 'room-full' ? `That room is full (${race.ROOM_MAX} max)`
              : err?.message === 'bad-code' ? 'A room code is at least 3 characters'
              : err?.message === 'no-config' ? 'Real rooms are not configured — see RACE.md'
              : 'Could not join that room';
            toast(why, { kind: 'bad' });
          }
        };

        body.append(group('Join a room',
          row('Room code', code),
          el('div', { class: 'btn-row' },
            el('button', { class: 'btn primary', text: 'Join', onclick: () => go(normaliseCode(code.value)) }),
            el('button', { class: 'btn', text: 'Create a room', onclick: () => go(randomCode()) }),
          ),
          el('div', { class: 'hint-note', text:
            'A room code is all anybody needs to get in — there is no sign-in and no account. '
            + 'Anyone with the code can join, so treat it like the door key it is.' }),
        ));
      } else {
        const link = `${location.origin}${location.pathname}?race=${ctl.snap.roomId}`;
        body.append(group('Invite',
          row('Room code', el('div', { class: 'race-code-big', text: ctl.snap.roomId })),
          el('div', { class: 'btn-row' },
            el('button', { class: 'btn primary', text: 'Copy invite link',
              onclick: () => app.copyToast(link, 'Invite link') }),
            el('button', { class: 'btn', text: 'Copy code',
              onclick: () => app.copyToast(ctl.snap.roomId, 'Room code') }),
          ),
          el('div', { class: 'hint-note', text: ctl.kind === 'local'
            ? 'This is a local room. The link only works in another tab of this same browser.'
            : 'Opening that link joins this room straight away.' }),
        ));
      }

      /* ---- how it behaves ---- */
      body.append(group('While racing',
        row('Give each room its own session',
          toggle(S.raceOwnSession, v => set('raceOwnSession', v)),
          'keeps your practice averages clean — race times are still saved, in a session named after the room'),
        cloud ? row('Connection', chips([
          { value: 'auto', label: 'Auto' },
          { value: 'firebase', label: 'Online' },
          { value: 'local', label: 'This browser' },
        ], S.racePrefer, v => set('racePrefer', v)),
          '“This browser” races other tabs on this machine — useful for testing') : null,
        el('div', { class: 'hint-note', text:
          'Race mode never asks for a camera or a microphone. What it does check: the time you '
          + 'submit is bound to the exact scramble it was solved on, it can only be written once, '
          + 'and it is compared against the window the server itself timed it in.' }),
      ));
    };

    render();
  };
}

/* ---------------- Scramble of the Day: the leaderboards ----------------

   The window (js/dailyui.js) is where you SOLVE today's scramble. This panel
   is where you read the boards afterwards without one — switch events, look
   at yesterday's rank, check the count board on a phone. Both draw through
   the same board builders, so nothing here can drift from what the window
   shows. */

/** Cleared at the top of every buildDaily() call — see buildAccountRow's identical reasoning. */
let _dailyUnsub = null;
let _dailyTick = 0;

const DAILY_PANEL = 'Scramble of the Day';

export function buildDaily(app) {
  return (body) => {
    if (_dailyUnsub) { _dailyUnsub(); _dailyUnsub = null; }
    clearInterval(_dailyTick);

    let ctl = null, ui = null;
    /* The day picker's own state, built on the first render — it is the same
       object the window uses, so the two cannot drift. See dayHistory. */
    let history = null;

    const onChange = () => { if (drawerName() === DAILY_PANEL) render(); };

    const render = async () => {
      const mod = await app.dailyModule();
      ui ??= await import('./dailyui.js');
      const { dailyEligible, formatCountdown } = mod;
      if (!ctl) {
        ctl = mod.getDaily(app);
        // Subscribed once per drawer-open, not once per render() call —
        // render() itself is called from inside this same handler.
        ctl.addEventListener('change', onChange);
        _dailyUnsub = () => ctl.removeEventListener('change', onChange);
      }
      history ??= ui.dayHistory(ctl, render);
      const cloud = mod.cloudAvailable();
      if (cloud) ctl.connect().catch(() => {});

      body.innerHTML = '';
      clearInterval(_dailyTick);

      if (!cloud) {
        body.append(group(DAILY_PANEL,
          el('div', { class: 'race-hero-warn', text:
            'No Firebase project is configured on this deployment, so there is no shared board to '
            + 'read or write. See RACE.md — the Scramble of the Day rides on the same project Race mode does.' }),
        ));
        return;
      }

      const snap = ctl.snap;
      const options = EVENT_ORDER.filter(dailyEligible).map(id => ({ value: id, label: EVENTS[id]?.short || id }));

      /* ---- today, and the way into the window ---- */
      const countdown = el('b', { text: '—' });
      body.append(group('Today',
        el('div', { class: 'race-hero', style: { alignItems: 'baseline' } },
          el('div', {},
            el('div', { class: 'race-hero-title', text: snap?.dayId || '—' }),
            el('div', { class: 'race-hero-sub' }, 'resets in ', countdown),
          ),
        ),
        el('div', { class: 'race-hero-sub', text:
          'Same scramble as everyone else, once a day. One official attempt, like a competition single — '
          + 'nobody’s time is visible to you until you have submitted your own.' }),
        ctl.submittedToday
          ? el('div', { class: 'hint-note', text: 'You have already submitted today’s attempt for this event.' })
          : el('button', {
              class: 'btn primary full', text: 'Open the Scramble of the Day',
              onclick: async () => {
                /* The window solves in the timer's event (see Daily#engage), so
                   opening it on the event picked here means moving the timer
                   there too — otherwise the window would follow the timer
                   straight back to whatever it was on. */
                if (app.settings.event !== ctl.eventId) await app.setEvent(ctl.eventId);
                closeDrawer(); $('#btn-daily').click();
              },
            }),
        row('Event', select(options, ctl.eventId, (v) => { ctl.setEvent(v); render(); })),
      ));

      const tick = () => {
        if (drawerName() !== DAILY_PANEL) { clearInterval(_dailyTick); return; }
        const s = ctl.snap;
        if (!s?.nextResetMs || !ctl.net) return;
        ctl.checkRollover();
        countdown.textContent = formatCountdown(s.nextResetMs - ctl.net.serverNow());
      };
      tick();
      _dailyTick = setInterval(tick, 1000);

      /* ---- board one: the times for the chosen event, on the chosen day ----

         Today is the live board — `ctl.ranked()` off the running listeners,
         reveal gate and all. A past day is a one-shot read that never touches
         them, so the countdown above, the rollover check and an armed attempt
         all stay pointed at today no matter how far back this has been
         walked. Both halves are the window's, drawn through dayHistory. */
      const today = snap?.dayId || null;
      const past = history.day;

      if (!past) {
        const doneCount = ctl.submittedCount();
        body.append(group('Today’s times', history.nav(today),
          el('div', { class: 'race-hero-sub', text:
            `${doneCount} ${doneCount === 1 ? 'person has' : 'people have'} done today’s scramble.` }),
          ui.timeBoard(ctl.ranked(), ctl.revealed),
        ));
      } else {
        // The picker below carries the date, so the group title does not repeat it.
        body.append(group('Times', history.nav(today), history.view(ctl.eventId)));
      }

      /* ---- board two: who solved the most, of anything ----
         Behind mod.SHOW_COUNT_BOARD, which is currently false — see the comment
         on it in js/daily.js. Left wired up rather than deleted so turning the
         feature back on is one boolean, not an archaeology exercise. */
      if (mod.SHOW_COUNT_BOARD) {
        const mine = ctl.myCount();
        body.append(group('Most solves today',
          el('div', { class: 'race-hero-sub', text:
            'Every solve you record today, whatever the event — not just this one. '
            + 'Resets with the board above, at midnight IST.' }),
          ui.countBoard(ctl.countBoard()),
          snap?.signedIn
            ? el('div', { class: 'hint-note', text: `You have done ${mine} ${mine === 1 ? 'solve' : 'solves'} today.` })
            : el('div', { class: 'hint-note', text:
                'Sign in with the account icon in the top bar to appear on either board.' }),
        ));
      }
    };

    render();
  };
}

export { toast, Solves };
