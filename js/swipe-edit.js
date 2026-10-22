import { t } from './i18n.js';
/* ===========================================================
   Tagda Timer — swipe to edit the last time (phones)

   csTimer's gesture: right after a solve, drag the time up for +2, down for
   DNF, left to delete it and right to clear its penalty. Only on the phone,
   only on the band the digits and the averages under them sit in, and only
   while the timer is idle with a solve on it. main.js decides all of that
   (`eligible`) and makes the edit (`act`), through the same functions the
   pills under the digits use.

   The hard part is that this band is also the button that starts the timer.
   A press on it is held back for up to HOLD_MS. If the finger travels SLOP_PX
   in that time it is a swipe, and the timer never hears about the press.
   Otherwise the press goes to the timer with its own timestamp (`handoff`),
   so inspection and the hold are counted from when the finger landed, and
   from then on it is exactly the press it always was. A tap that lifts inside
   the window is replayed as a press and its release (`tap`).
   =========================================================== */

import { el } from './util.js';

const HOLD_MS = 120;     // how long a press on the band is held back
const SLOP_PX = 12;      // travel inside that window that makes it a swipe
const LOCK_PX = 56;      // travel along one axis that picks a direction...
const AXIS = 1.5;        // ...as long as it is this many times the other axis
const DAMP = 0.35;       // the digits follow the finger this much...
const MAX_SHIFT = 40;    // ...and never further than this

/* The four edits. `label` and `arrow` sit round the digits; `say` is the line
   under the averages once a direction is picked, given the solve's penalty
   now (+2 and DNF toggle, as the pills do). */
const DIRS = {
  up: { arrow: '↑', label: '+2', tone: 'warn',
    say: p => (p === '+2' ? t('Let go to remove the +2') : t('Let go to add +2')) },
  down: { arrow: '↓', label: 'DNF', tone: 'danger',
    say: p => (p === 'DNF' ? t('Let go to remove the DNF') : t('Let go to make it a DNF')) },
  left: { arrow: '←', label: t('Delete'), tone: 'danger', say: () => t('Let go to delete') },
  right: { arrow: '→', label: t('OK'), tone: 'accent-2',
    say: p => (p === 'none' ? t('No penalty to clear') : t('Let go to clear the penalty')) },
};

/* The band: the digits and the averages under them, the whole width of the
   screen, with a little room above and below. Never a control in it (the
   pills under the averages are their own buttons). */
const BAND_SLACK = 24;
function inBand(e) {
  const zone = e.target?.closest?.('#timer-zone');
  if (!zone || e.target.closest('button, a, input, select, textarea, label, [role="button"], [contenteditable]')) return false;
  const d = document.getElementById('timer-display')?.getBoundingClientRect();
  if (!d?.height) return false;
  const avgs = document.getElementById('timer-avgs');
  const a = avgs && !avgs.hidden ? avgs.getBoundingClientRect() : null;
  const bottom = Math.max(d.bottom, a?.height ? a.bottom : 0);
  return e.clientY >= d.top - BAND_SLACK && e.clientY <= bottom + BAND_SLACK;
}

/**
 * Wire the gesture. Everything about the app comes in through `opts`:
 *   eligible(e)   may this press be a swipe at all? (where it lands is checked here)
 *   penalty()     the shown solve's penalty: 'none' | '+2' | 'DNF'
 *   act(dir)      make the edit: 'up' | 'down' | 'left' | 'right'
 *   handoff(at)   give the timer the press that landed at `at`
 *   tap(at, upAt) give the timer a press and its release
 * Returns press(e, timerWants) for main.js's pointerdown to ask first, and
 * cancel() for anything that has to drop a press on the floor (a blur).
 */
export function wireSwipeEdit(opts) {
  let press = null;      // { x, y, at, id, wants, timer, swiping, dir }
  let ui = null;

  const still = () => document.documentElement.dataset.motion !== 'full'
    || matchMedia('(prefers-reduced-motion: reduce)').matches;

  function build() {
    const dir = (id) => el('span', { class: 'ph-sw-dir', dataset: { dir: id, tone: DIRS[id].tone } },
      el('b', { text: DIRS[id].arrow }), el('span', { text: DIRS[id].label }));
    ui = {
      root: el('div', { id: 'ph-swipe', class: 'ph-swipe', 'aria-hidden': 'true' },
        el('span', { class: 'ph-sw-ring' })),
      dirs: {},
      hint: el('p', { class: 'ph-sw-hint' }),
      sub: el('p', { class: 'ph-sw-sub', text: t('slide back to the middle to cancel') }),
    };
    for (const id of Object.keys(DIRS)) ui.root.append(ui.dirs[id] = dir(id));
    ui.root.append(ui.hint, ui.sub);
  }

  /* The labels go round where the digits are now, measured once per swipe:
     the clock's size and place depend on the time, the event and the screen.
     Above and below, they sit further out than the digits can travel, so the
     two never meet. Beside the digits there is only room for a short time; a
     time with a minute in it fills the width, and then ← and → drop to the
     row the DNF label is on, and the digits barely move sideways. */
  const GAP = MAX_SHIFT + 12;      // from the digits' resting edge to a label
  const SIDE = 60;                 // a side label and its margin to the screen edge
  let reach = { x: MAX_SHIFT, y: MAX_SHIFT };
  function place() {
    const zone = document.getElementById('timer-zone');
    if (!ui) build();
    if (ui.root.parentNode !== zone) zone.append(ui.root);
    const z = zone.getBoundingClientRect();
    const d = document.getElementById('timer-display').getBoundingClientRect();
    const avgs = document.getElementById('timer-avgs');
    const a = avgs && !avgs.hidden ? avgs.getBoundingClientRect() : null;
    const room = Math.min(d.left - z.left, z.right - d.right) - SIDE - 8;
    const low = room < 8;
    reach = { x: low ? 12 : Math.min(MAX_SHIFT, room), y: MAX_SHIFT };
    ui.root.classList.toggle('low', low);
    const labelH = ui.dirs.down.offsetHeight || 38;
    const below = Math.max(a?.height ? a.bottom : 0, d.bottom + GAP + labelH) - z.top + 14;
    const s = ui.root.style;
    s.setProperty('--sw-gap', `${GAP}px`);
    s.setProperty('--sw-cx', `${Math.round(d.left + d.width / 2 - z.left)}px`);
    s.setProperty('--sw-cy', `${Math.round(d.top + d.height / 2 - z.top)}px`);
    s.setProperty('--sw-top', `${Math.round(d.top - z.top)}px`);
    s.setProperty('--sw-bot', `${Math.round(d.bottom - z.top)}px`);
    s.setProperty('--sw-hint', `${Math.round(below)}px`);
    s.setProperty('--sw-ring', `${Math.round(Math.min(300, z.width - 48, d.height + 2 * (GAP + labelH)))}px`);
  }

  function show(dir) {
    for (const [id, node] of Object.entries(ui.dirs)) node.classList.toggle('on', id === dir);
    ui.hint.textContent = dir ? DIRS[dir].say(opts.penalty()) : t('Slide to a side to choose');
    ui.hint.dataset.tone = dir ? DIRS[dir].tone : '';
    ui.sub.hidden = !dir;
  }

  function startSwipe() {
    clearTimeout(press.timer);
    press.swiping = true;
    place();
    show(null);
    document.body.classList.add('swiping');
  }

  /** Which way a drag of (dx, dy) points, or null while it is not clear yet. */
  function aim(dx, dy) {
    const ax = Math.abs(dx), ay = Math.abs(dy);
    if (Math.max(ax, ay) < LOCK_PX) return null;
    if (ax >= AXIS * ay) return dx < 0 ? 'left' : 'right';
    if (ay >= AXIS * ax) return dy < 0 ? 'up' : 'down';
    return null;
  }

  function follow(dx, dy) {
    const digits = document.getElementById('timer-display');
    if (still()) { digits.style.translate = ''; return; }
    let x = dx * DAMP, y = dy * DAMP;
    const len = Math.hypot(x, y);
    if (len > MAX_SHIFT) { x *= MAX_SHIFT / len; y *= MAX_SHIFT / len; }
    x = Math.max(-reach.x, Math.min(reach.x, x));
    digits.style.translate = `${x.toFixed(1)}px ${y.toFixed(1)}px`;
  }

  /** Put the digits back where they live: a short spring, or at once. */
  function settle() {
    const digits = document.getElementById('timer-display');
    const from = digits.style.translate;
    digits.style.translate = '';
    document.body.classList.remove('swiping');
    if (from && !still() && digits.animate) {
      digits.animate([{ translate: from }, { translate: '0px 0px' }],
        { duration: 250, easing: 'cubic-bezier(.34, 1.56, .64, 1)' });
    }
  }

  function end() {
    if (!press) return;
    clearTimeout(press.timer);
    if (press.swiping) settle();
    press = null;
  }

  const onMove = (e) => {
    if (!press || e.pointerId !== press.id) return;
    const dx = e.clientX - press.x, dy = e.clientY - press.y;
    if (!press.swiping) {
      if (Math.hypot(dx, dy) > SLOP_PX) startSwipe();
      else return;
    }
    follow(dx, dy);
    const dir = aim(dx, dy);
    if (dir !== press.dir) {
      press.dir = dir;
      show(dir);
      if (dir) navigator.vibrate?.(10);
    }
  };

  const onUp = (e) => {
    if (!press || e.pointerId !== press.id) return;
    const p = press;
    end();
    if (p.swiping) { if (p.dir) opts.act(p.dir); return; }
    // Lifted before the window closed, without moving: an ordinary tap.
    if (p.wants) opts.tap(p.at, e.timeStamp);
  };

  const onCancel = (e) => { if (press && e.pointerId === press.id) end(); };

  addEventListener('pointermove', onMove);
  addEventListener('pointerup', onUp);
  addEventListener('pointercancel', onCancel);

  return {
    /** Is this press ours to hold back? `timerWants`: would the timer have taken it? */
    press(e, timerWants) {
      end();
      if (!opts.eligible(e) || !inBand(e)) return false;
      e.preventDefault();
      const p = press = { x: e.clientX, y: e.clientY, at: e.timeStamp, id: e.pointerId, wants: timerWants, swiping: false, dir: null };
      p.timer = setTimeout(() => {
        if (press !== p || p.swiping) return;
        press = null;
        if (p.wants) opts.handoff(p.at);
      }, HOLD_MS);
      return true;
    },
    cancel: end,
  };
}
