/* ===========================================================
   Tagda Timer — settings model + live theme application

   The whole look is CSS custom properties, so applying a theme is
   just writing variables on <html>. Nothing re-renders.
   =========================================================== */

import { KV, Assets } from './db.js';
import { applyContrast, hexLuma } from './contrast.js';

export const PRESETS = {
  nebula:    { name: 'Nebula',    dots: ['#7c5cff', '#35e6c5', '#12102a'] },
  carbon:    { name: 'Carbon',    dots: ['#ffffff', '#7c7c7c', '#0d0d0d'] },
  vaporwave: { name: 'Vaporwave', dots: ['#ff5ed2', '#4de8ff', '#3d0a5c'] },
  ice:       { name: 'Ice',       dots: ['#4cc9ff', '#a0f0ff', '#0a2036'] },
  terminal:  { name: 'Terminal',  dots: ['#39ff6a', '#b9ffc4', '#031a05'] },
  speedcube: { name: 'Speedcube', dots: ['#ff5800', '#00a651', '#141414'] },
  paper:     { name: 'Paper',     dots: ['#1b1a17', '#c2410c', '#e6e2d9'] },
};

export const TIMER_FONTS = {
  'JetBrains Mono': "'JetBrains Mono', ui-monospace, monospace",
  'Chivo Mono':     "'Chivo Mono', ui-monospace, monospace",
  'Space Grotesk':  "'Space Grotesk', system-ui, sans-serif",
  'Inter':          "'Inter', system-ui, sans-serif",
  'System':         "system-ui, -apple-system, sans-serif",
};

/** The reel pinned in the About panel until someone pastes another one. */
export const FEATURED_REEL = 'https://www.instagram.com/reel/DZzyIGcBQjD/';

/**
 * Bumped whenever a default changes in a way that must reach people who
 * already have settings saved. `saveSettings` writes the whole object, so an
 * existing profile carries the OLD default forever and simply editing
 * DEFAULTS would never reach anyone who has used the app before.
 */
const SETTINGS_VERSION = 5;

const MIGRATIONS = {
  // v2 — the pace ghost is now opt-in rather than on by default.
  2: (s) => { s.paceGhost = false; },
  // v3 — voice callouts removed; anyone on them lands on the tone.
  3: (s) => { if (s.callouts === 'voice') s.callouts = 'beep'; },
  // v4 — the spacebar starts the solve on the press. Anyone still carrying the
  // old 300 ms arming hold is moved across; a hold they chose themselves is
  // left alone.
  4: (s) => {
    if (s.holdTime === 300 || s.holdTime === undefined) s.holdTime = 0;
    if (!s.featuredReel) s.featuredReel = FEATURED_REEL;
  },
  // v5 — album theming arrives switched off. Nothing polls, nothing tints,
  // until a client ID is entered and Connect is pressed.
  5: (s) => {
    s.spotifyClientId ??= '';
    s.spotifyTint ??= 'accent';
    s.spotifyNowPlaying ??= false;
    s.showSpotifyPanel ??= true;
  },
};

export const DEFAULTS = {
  // behaviour
  inspection: true,
  holdTime: 0,                  // 0 = the press starts the solve, no arming hold
  callouts: 'beep',             // beep | off
  precision: 2,
  hideWhileRunning: false,
  focusMode: true,
  paceGhost: false,           // opt-in — see SETTINGS_VERSION below
  paceRef: 'pb',                // pb | ao5
  confirmShortSolves: true,
  soundOnPB: true,
  mouseTimer: false,            // click-to-time; off so a stray click cannot start a solve
  inputMode: 'timer',           // timer = spacebar/touch | manual = typed | stackmat = aux jack

  // appearance
  theme: 'nebula',
  density: 'comfortable',
  motion: 'full',               // full | reduced | off
  accent: '',                   // '' = use preset
  accent2: '',
  timerFont: 'JetBrains Mono',
  timerWeight: 700,
  timerSize: 100,               // % of the fluid default
  timerGlow: 0,

  // background
  bgMode: 'shader',             // shader | image | video | gradient | solid
  bgShader: 'aurora',
  bgSpeed: 1,
  bgAmount: 1,
  bgBlur: 0,
  bgDim: 0.35,
  bgSat: 1,
  bgGradient: 'linear-gradient(135deg, #2b1055, #7597de)',
  bgSolid: '#07070c',

  // layout
  panelStyle: 'widget',         // widget = frosted card | flat = no card at all
  scrambleSize: 100,            // % of the responsive default
  cubeSize: 120,
  sidebarWidth: 236,            // px
  sidebarText: 100,             // % — stats + panel labels
  timesSize: 100,               // % — the solve list
  cubePos: null,                // {x,y} once the preview has been dragged
  cubeOrbit: null,              // {latitude,longitude,distance} once it has been spun
  mascotOpen: false,            // the brand cube, loose on the page
  mascotPos: null,
  mascotSize: 200,
  showStats: true,
  statsCollapsed: true,
  showCube: true,
  showHistory: true,
  cubeView: '3D',
  hintFacelets: true,
  autoContrast: true,           // flip to dark text when the background is bright

  // album theming (see SPOTIFY.md)
  spotifyClientId: '',          // yours, from developer.spotify.com/dashboard
  spotifyTint: 'accent',        // accent | background | both
  spotifyNowPlaying: false,     // print the track under the scramble
  showSpotifyPanel: true,       // the now-playing card in the sidebar
  featuredReel: FEATURED_REEL,  // an Instagram reel URL pinned in the About panel

  // session
  event: '333',
  mode: 'wca',
  sessionId: null,
  multiCount: 3,
  allowedCases: {},             // { modeId: [caseId, ...] }
  settingsVersion: SETTINGS_VERSION,
};

export async function loadSettings() {
  const saved = await KV.get('settings', {});
  const s = { ...DEFAULTS, ...saved };
  const from = Number(saved.settingsVersion) || 0;
  if (from < SETTINGS_VERSION) {
    for (let v = from + 1; v <= SETTINGS_VERSION; v++) MIGRATIONS[v]?.(s);
    s.settingsVersion = SETTINGS_VERSION;
    KV.set('settings', s);
  }
  return s;
}

let saveTimer = null;
export function saveSettings(s) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => KV.set('settings', s), 220);
}

/* ---------------------------------------------------------
   Apply
   --------------------------------------------------------- */

export function applyTheme(s) {
  const root = document.documentElement;
  root.dataset.theme = s.theme;
  root.dataset.density = s.density;
  root.dataset.motion = s.motion;

  const st = root.style;
  st.setProperty('--font-timer', TIMER_FONTS[s.timerFont] || TIMER_FONTS['JetBrains Mono']);
  st.setProperty('--timer-weight', s.timerWeight);
  st.setProperty('--timer-size', `clamp(3rem, ${(15 * s.timerSize / 100).toFixed(2)}vw, ${(11.5 * s.timerSize / 100).toFixed(2)}rem)`);
  st.setProperty('--timer-glow', `${s.timerGlow}px`);
  st.setProperty('--scramble-scale', (s.scrambleSize / 100).toFixed(3));
  st.setProperty('--cube-scale', (s.cubeSize / 100).toFixed(3));
  st.setProperty('--sidebar-w', `${s.sidebarWidth}px`);
  st.setProperty('--sidebar-text', (s.sidebarText / 100).toFixed(3));
  st.setProperty('--times-scale', (s.timesSize / 100).toFixed(3));
  root.dataset.panels = s.panelStyle;
  st.setProperty('--bg-blur', `${s.bgBlur}px`);
  st.setProperty('--bg-dim', s.bgDim);
  st.setProperty('--bg-sat', s.bgSat);

  if (s.accent)  st.setProperty('--accent', s.accent);  else st.removeProperty('--accent');
  if (s.accent2) st.setProperty('--accent-2', s.accent2); else st.removeProperty('--accent-2');

  // Anything printed *on* an accent — a primary button, a selection, the avatar
  // initial — used to be white no matter what, which is invisible on Carbon's
  // white accent and on any pale colour picked in the appearance editor.
  // Read the accent that actually resolved and pick the side that reads.
  st.removeProperty('--on-accent');
  const accent = getComputedStyle(root).getPropertyValue('--accent').trim();
  st.setProperty('--on-accent', (hexLuma(accent) ?? 0) > 0.6 ? '#0b0b12' : '#ffffff');

  document.body.classList.toggle('no-stats', !s.showStats);
  const stats = document.getElementById('panel-stats');
  const cube  = document.getElementById('panel-cube');
  const hist  = document.getElementById('panel-times');
  if (stats) stats.style.display = s.showStats ? '' : 'none';
  if (cube)  cube.style.display  = s.showCube ? '' : 'none';
  if (hist)  hist.style.display  = s.showHistory ? '' : 'none';

  // the sidebar only earns its column when something is in it
  const stage = document.getElementById('stage');
  const sidebar = document.getElementById('sidebar');
  if (sidebar) sidebar.style.display = (s.showStats || s.showHistory) ? '' : 'none';
  if (stage) {
    // Only state whether a sidebar exists. Writing grid-template-columns inline
    // here outranks the responsive media queries and broke the mobile layout.
    stage.dataset.sidebar = (s.showStats || s.showHistory) ? 'on' : 'off';
  }

  // The album tint is an override on top of whatever the theme just wrote, so
  // it has to go back on after every theme application or switching themes
  // (or any settings change at all) would silently drop it.
  paintAlbumTint(root);

  // Last line on purpose: everything above may have moved the palette, and the
  // accent overrides are written near the end of it.
  invalidateThemeColors();
}

/* ---------------------------------------------------------
   Album tint

   Deliberately *not* stored in settings. Writing it there would mean three
   minutes of listening permanently overwrites the accent the user picked,
   and disconnecting would strand them on the last album's colours. It lives
   here, on top of the theme, and vanishing is the whole recovery path.
   --------------------------------------------------------- */
let _albumTint = null;

function paintAlbumTint(root) {
  if (!_albumTint) return;
  const st = root.style;
  if (_albumTint.accent)  st.setProperty('--accent', _albumTint.accent);
  if (_albumTint.accent2) st.setProperty('--accent-2', _albumTint.accent2);
  if (_albumTint.bg2)     st.setProperty('--bg-2', _albumTint.bg2);
  // Type printed on the accent has to follow it, or a pale album colour gets
  // white text on it and disappears.
  const accent = getComputedStyle(root).getPropertyValue('--accent').trim();
  st.setProperty('--on-accent', (hexLuma(accent) ?? 0) > 0.6 ? '#0b0b12' : '#ffffff');
}

/**
 * Apply (or with null, clear) the album-derived colours.
 *
 * Only ever touches --accent, --accent-2 and --bg-2. The status colours
 * (--warn, --danger, --ok, --gold) are load-bearing for inspection feedback
 * and are never written from artwork — see SPOTIFY.md §5.1.
 */
export function setAlbumTint(colors, settings) {
  _albumTint = colors;
  const root = document.documentElement;
  if (!colors) {
    // Hand the theme back its own values rather than guessing them.
    root.style.removeProperty('--bg-2');
    if (settings?.accent)  root.style.setProperty('--accent', settings.accent);
    else root.style.removeProperty('--accent');
    if (settings?.accent2) root.style.setProperty('--accent-2', settings.accent2);
    else root.style.removeProperty('--accent-2');
    const accent = getComputedStyle(root).getPropertyValue('--accent').trim();
    root.style.setProperty('--on-accent', (hexLuma(accent) ?? 0) > 0.6 ? '#0b0b12' : '#ffffff');
  } else {
    paintAlbumTint(root);
  }
  invalidateThemeColors();
}

export const albumTint = () => _albumTint;

/* The palette is read from CSS on every inspection frame — the shader tint and
   the ring both want it — and getComputedStyle() there is a forced style
   recalc sixty-plus times a second for nine values that only ever change when
   the theme does. So resolve it once and hold it until something moves.

   Deliberately not a MutationObserver on <html>: the inspection heartbeat
   writes --breathe on that same element every frame, which would invalidate
   the cache on every frame and buy nothing. Both writers of the palette call
   invalidateThemeColors() directly instead. */
let _colors = null;

/** Drop the cached palette. Call after anything that rewrites theme CSS vars. */
export function invalidateThemeColors() { _colors = null; }

/** Resolve the current accent colours for shaders / confetti. */
export function themeColors() {
  if (_colors) return _colors;
  const cs = getComputedStyle(document.documentElement);
  const get = (n, fb) => (cs.getPropertyValue(n).trim() || fb);
  _colors = {
    bg:      get('--bg', '#07070c'),
    bg2:     get('--bg-2', '#12102a'),
    accent:  get('--accent', '#7c5cff'),
    accent2: get('--accent-2', '#35e6c5'),
    gold:    get('--gold', '#ffd166'),
    ok:      get('--ok', '#3ddc84'),
    danger:  get('--danger', '#ff4d6d'),
    warn:    get('--warn', '#ffb020'),
    text:    get('--text', '#fff'),
  };
  return _colors;
}

/* ---------------------------------------------------------
   Background wiring
   --------------------------------------------------------- */

export async function applyBackground(bg, s) {
  // Re-sample before anything else: the palette this resolves may itself be
  // about to flip, and the shaders read their colours from it.
  await applyContrast(s);
  // applyContrast stamps data-bg-luma on <html>, which the stylesheet answers
  // with a different palette — so the cached one is stale by definition here.
  invalidateThemeColors();
  const c = themeColors();
  bg.speed = s.bgSpeed;
  bg.amount = s.bgAmount;
  bg.setColors(c.bg2, c.accent, c.accent2);
  bg.setShader(s.bgShader);

  if (s.bgMode === 'shader') { bg.setMode('shader'); return; }

  bg.setMode('media');
  if (s.bgMode === 'gradient') bg.setMedia(s.bgGradient);
  else if (s.bgMode === 'solid') bg.setMedia(s.bgSolid);
  else if (s.bgMode === 'image') {
    const blob = await Assets.get('bg-image');
    if (blob) bg.setMedia(`url(${URL.createObjectURL(blob)}) center/cover no-repeat`);
    else bg.setMedia(s.bgGradient);
  } else if (s.bgMode === 'video') {
    const blob = await Assets.get('bg-video');
    if (blob) bg.setMedia('', URL.createObjectURL(blob));
    else bg.setMedia(s.bgGradient);
  }
}

/* ---------------------------------------------------------
   Theme export / import
   --------------------------------------------------------- */

const THEME_KEYS = [
  'theme','density','motion','accent','accent2','timerFont','timerWeight','timerSize','timerGlow',
  'bgMode','bgShader','bgSpeed','bgAmount','bgBlur','bgDim','bgSat','bgGradient','bgSolid',
  'showStats','showCube','showHistory','cubeView','hintFacelets','autoContrast',
  'panelStyle','scrambleSize','cubeSize','sidebarWidth','sidebarText','timesSize',
];

export function exportTheme(s) {
  const out = { app: 'tagdatimer-theme', v: 1 };
  for (const k of THEME_KEYS) out[k] = s[k];
  return out;
}

export function importTheme(s, data) {
  if (!data || data.app !== 'tagdatimer-theme') throw new Error('Not a Tagda Timer theme file');
  for (const k of THEME_KEYS) if (k in data) s[k] = data[k];
  return s;
}
