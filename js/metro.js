/* ===========================================================
   Tagda Timer — the floating metronome window

   It builds its own DOM and mounts on <body>, because it belongs on more than
   one page: the timer, and the algorithm library, which is where you actually
   sit and drill a case to a beat. Markup in one page's HTML would have meant
   the same widget maintained twice.

   One audio clock, two reasons to be ticking — this window's Start/Stop, and
   the timer page's solve-time click (Timer › Metronome). Both route through
   sync(), or closing a solve would silence a window left running.
   =========================================================== */

import { el } from './util.js';
import { metronome } from './fx.js';
import { makeDraggable } from './drag.js';

const BEATS = 4;
const MIN_BPM = 30, MAX_BPM = 240;
const clampBpm = (n) => Math.max(MIN_BPM, Math.min(MAX_BPM, Math.round(n || 0)));

let running = false;     // the window's Start/Stop — runtime only, never persisted
let external = 0;        // the timer's solve-time click: its bpm, or 0 when silent
let beatTo = null;       // the mounted window's beat meter, when there is one
let S = null;

function sync() {
  const bpm = running ? clampBpm(S?.metronomeBpm) : external;
  metronome(running || external ? bpm : 0, running ? beatTo : null);
}

/**
 * The timer's own click, which is a second switch on the same audio clock.
 * Pass the bpm while a solve is running with the setting on, 0 otherwise.
 */
export function metroExternal(bpm) { external = bpm || 0; sync(); }

/**
 * Build the window and attach it to the page.
 *
 * @param {object} settings   the live settings object (metroOpen/metroPos/metronomeBpm)
 * @param {() => void} save   persist that object
 * @returns {{apply: () => void}}  re-read the settings onto the window
 */
export function mountMetro(settings, save) {
  S = settings;
  if (document.getElementById('metro')) return { apply: () => {} };

  const dots = Array.from({ length: BEATS }, () => el('i'));
  const read = el('b', { text: String(clampBpm(S.metronomeBpm)) });
  const range = el('input', {
    id: 'metro-range', type: 'range', min: MIN_BPM, max: MAX_BPM, step: 1,
    'aria-label': 'Beats per minute',
  });
  const play = el('button', { id: 'metro-play', class: 'ghost-btn', type: 'button', text: 'Start' });
  const close = el('button', {
    id: 'metro-close', type: 'button', title: 'Close the metronome',
    'aria-label': 'Close the metronome', html: '&times;',
  });

  const box = el('div', { id: 'metro', hidden: true },
    el('div', { id: 'metro-grip', title: 'Drag to move the metronome' },
      el('span', { class: 'metro-grip-ico', html:
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 9h10M7 15h10"/></svg>' }),
      el('span', { text: 'Metronome' }),
      close),
    el('div', { id: 'metro-beats', 'aria-hidden': 'true' }, dots),
    el('div', { id: 'metro-bpm' },
      el('button', { id: 'metro-slower', type: 'button', title: 'Slower', 'aria-label': 'Slower', html: '&minus;' }),
      el('span', { id: 'metro-read' }, read, el('small', { text: 'bpm' })),
      el('button', { id: 'metro-faster', type: 'button', title: 'Faster', 'aria-label': 'Faster', text: '+' })),
    range,
    play,
  );
  document.body.append(box);

  beatTo = (beat) => {
    const i = beat % BEATS;
    dots.forEach((d, n) => d.classList.toggle('on', n === i));
    // Restart the pulse on the dot that just landed, and clear it off the
    // others so the class does not pile up across a long session.
    dots.forEach(d => d.classList.remove('hit'));
    void dots[i].offsetWidth;
    dots[i].classList.add('hit');
  };

  const drag = makeDraggable(box, {
    handle: '#metro-grip',
    get: () => S.metroPos,
    set: (pos) => { S.metroPos = pos; save(); },
  });

  const showBpm = () => {
    const bpm = clampBpm(S.metronomeBpm);
    read.textContent = bpm;
    range.value = bpm;
  };

  const setBpm = (n) => {
    S.metronomeBpm = clampBpm(n);
    save();
    showBpm();
    sync();                     // a live tempo change, not a restart-on-next-start
  };

  const setRunning = (on) => {
    running = on;
    play.textContent = on ? 'Stop' : 'Start';
    box.classList.toggle('ticking', on);
    if (!on) dots.forEach(d => d.classList.remove('on', 'hit'));
    sync();
  };

  /* The switch in Settings, a restore-defaults, and the window's own close
     button all land here. Closing it has to stop the sound as well — a ticking
     widget you cannot see is the worst version of this feature. */
  const apply = () => {
    box.hidden = !S.metroOpen;
    showBpm();
    if (box.hidden) { if (running) setRunning(false); return; }
    drag.apply();
  };

  play.addEventListener('click', () => setRunning(!running));
  close.addEventListener('click', () => { S.metroOpen = false; save(); apply(); });
  box.querySelector('#metro-slower').addEventListener('click', () => setBpm(S.metronomeBpm - 5));
  box.querySelector('#metro-faster').addEventListener('click', () => setBpm(S.metronomeBpm + 5));
  range.addEventListener('input', () => setBpm(+range.value));

  apply();
  return { apply };
}
