/* ===========================================================
   Tagda Timer — settings model + live theme application

   The whole look is CSS custom properties, so applying a theme is
   just writing variables on <html>. Nothing re-renders.
   =========================================================== */

import { KV, Assets } from './db.js';
import { applyContrast } from './contrast.js';

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

/**
 * Bumped whenever a default changes in a way that must reach people who
 * already have settings saved. `saveSettings` writes the whole object, so an
 * existing profile carries the OLD default forever and simply editing
 * DEFAULTS would never reach anyone who has used the app before.
 */
const SETTINGS_VERSION = 3;

const MIGRATIONS = {
  // v2 — the pace ghost is now opt-in rather than on by default.
  2: (s) => { s.paceGhost = false; },
  // v3 — voice callouts removed; anyone on them lands on the tone.
  3: (s) => { if (s.callouts === 'voice') s.callouts = 'beep'; },
};

export const DEFAULTS = {
  // behaviour
  inspection: true,
  holdTime: 300,
  callouts: 'beep',             // beep | off
  precision: 2,
  hideWhileRunning: false,
  focusMode: true,
  paceGhost: false,           // opt-in — see SETTINGS_VERSION below
  paceRef: 'pb',                // pb | ao5
  confirmShortSolves: true,
  soundOnPB: true,
  mouseTimer: false,            // click-to-time; off so a stray click cannot start a solve

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
  featuredReel: '',             // an Instagram reel URL pinned in the About panel

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
}

/** Resolve the current accent colours for shaders / confetti. */
export function themeColors() {
  const cs = getComputedStyle(document.documentElement);
  const get = (n, fb) => (cs.getPropertyValue(n).trim() || fb);
  return {
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
}

/* ---------------------------------------------------------
   Background wiring
   --------------------------------------------------------- */

export async function applyBackground(bg, s) {
  // Re-sample before anything else: the palette this resolves may itself be
  // about to flip, and the shaders read their colours from it.
  await applyContrast(s);
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
