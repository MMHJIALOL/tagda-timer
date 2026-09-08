/* ===========================================================
   Tagda Timer — Scramble of the Day: the window and the two boards

   Two things live here, and they are together because the second is drawn
   inside the first as well as inside the settings drawer.

   ---------------------------------------------------------
   1. The window
   ---------------------------------------------------------

   Pressing "Scramble of the Day" does not open a panel. It puts the app
   into a state — `body.sotd` — where everything that is not today's
   scramble and the timer is gone: topbar, both sidebars, the dock, the
   floating tiles. What is left is the scramble, the clock, and a slim bar
   saying which day it is and how long is left of it.

   It is built by SUBTRACTION rather than as a modal with its own timer, and
   that is the load-bearing decision in this file. A self-contained window
   would have needed its own copy of inspection, +2/DNF judging, the hold
   time, stackmat input and the minimum-solve prompt — five things that were
   already right in js/timer.js and main.js and would immediately have begun
   drifting from them. Worse, a solve done in that window would not have
   been a solve: it would not have landed in your session, your averages or
   your history, and "my daily attempt is missing from my stats" is a much
   worse bug than any amount of chrome on screen.

   So the window is a layout, and the solve underneath it is an ordinary
   solve that happens to be of today's scramble. Everything the daily
   challenge already did — arming the attempt, the server-timed window, the
   write-once result — is untouched by it.

   ---------------------------------------------------------
   2. The boards
   ---------------------------------------------------------

   Two of them, and they answer different questions on purpose:

     - the TIME board: who solved today's scramble fastest. Gated — you see
       nobody's time until you have submitted your own, which is a database
       rule and not a promise this file makes.
     - the COUNT board: who did the most solves today, of anything. Public,
       ungated, and honest about being unverifiable (see DAILY.md §5).

   Both render through the same row builder, so a name and a face look the
   same whichever board you found them on.
   =========================================================== */

import { el, fmt } from './util.js';
import { signIn } from './sync-auth.js';
import { toast } from './toast.js';
import { formatCountdown, safePhotoUrl } from './daily-net.js';
// Policy lives with the controller — see the comment on it there.
import { SHOW_COUNT_BOARD } from './daily.js';

/* ---------------------------------------------------------
   A face, or the next best thing
   --------------------------------------------------------- */

/**
 * The avatar for a board row.
 *
 * Three tiers, because two of them are common: the Google account picture,
 * an initial on a tinted disc when there is no picture, and the same disc
 * blank if there is not even a usable name. The initial tier matters more
 * than it looks — a board of twelve identical grey circles is worse at the
 * one job an avatar has, which is letting you find your own row without
 * reading it.
 *
 * `referrerpolicy` is not decoration: Google's avatar CDN serves 403 for
 * requests carrying a referrer it does not know, which on a self-hosted
 * copy of this app means every face silently failing to load.
 *
 * The URL is re-checked here even though the rules already refuse a bad one,
 * because this is the last point before a stranger's string becomes a fetch
 * from the viewer's browser — and it is the only check that also covers rows
 * written before that rule existed. See safePhotoUrl.
 */
export function avatar(name, photo) {
  const initial = (String(name || '').trim()[0] || '').toUpperCase();
  const src = safePhotoUrl(photo);
  if (src) {
    const img = el('img', {
      class: 'db-face', src, alt: '', loading: 'lazy',
      decoding: 'async', referrerpolicy: 'no-referrer',
    });
    // A broken image is a torn box with an alt cross in it. Fall back to the
    // initial instead, which is what this row would have had anyway.
    img.addEventListener('error', () => img.replaceWith(avatar(name, null)), { once: true });
    return img;
  }
  return el('span', { class: 'db-face db-face-letter', text: initial || '·', 'aria-hidden': 'true' });
}

/* ---------------------------------------------------------
   The time board — who solved today's scramble fastest
   --------------------------------------------------------- */

/**
 * @param rows      what daily.js's ranked() returned
 * @param revealed  whether this viewer has earned the right to see times
 */
export function timeBoard(rows, revealed) {
  if (!revealed) {
    return el('div', { class: 'db-locked' },
      el('div', { class: 'db-locked-icon', text: '🔒' }),
      el('div', { class: 'db-locked-text', text:
        'Submit today’s attempt to unlock the board. Nobody’s time is visible to '
        + 'you until you have sent your own — that is a database rule, not a setting.' }),
    );
  }
  if (!rows.length) return el('div', { class: 'db-empty', text: 'Nobody has posted a time yet today.' });

  const board = el('div', { class: 'db-board' }, rows.slice(0, 50).map((r, i) => timeRow(r, i)));

  /* Somebody in 63rd place still wants to know they are in 63rd place, and
     the board is capped at 50 so the drawer does not become a scroll. */
  const mine = rows.findIndex(r => r.isMe);
  if (mine >= 50) {
    return el('div', { class: 'db-stack' }, board,
      el('div', { class: 'db-yours' },
        el('div', { class: 'db-yours-label', text: 'Your rank' }), timeRow(rows[mine], mine)));
  }
  return board;
}

function timeRow(r, i) {
  const res = r.result || {};
  const shown = res.penalty === 'DNF' ? 'DNF' : fmt(res.timeMs) + (res.penalty === '+2' ? '+' : '');
  return el('div', { class: 'db-row', dataset: { me: String(r.isMe), rank: String(i + 1) } },
    el('span', { class: 'db-rank', text: String(i + 1) }),
    avatar(res.name, res.photo),
    el('span', { class: 'db-name', text: res.name || 'Cuber' }),
    (res.suspect || r.clockOff)
      ? el('span', { class: 'db-flag', text: '⚑', title: r.clockOff
          ? 'The submitted time is shorter than the window the server timed it in'
          : 'Far faster than this player’s own recent average' })
      : null,
    el('span', { class: 'db-time', text: shown }),
  );
}

/* ---------------------------------------------------------
   The count board — who did the most solves today
   --------------------------------------------------------- */

export function countBoard(rows) {
  if (!rows.length) {
    return el('div', { class: 'db-empty', text: 'No solves counted yet today. Yours would be the first.' });
  }
  return el('div', { class: 'db-board' }, rows.slice(0, 50).map((r, i) =>
    el('div', { class: 'db-row', dataset: { me: String(r.isMe), rank: String(i + 1) } },
      el('span', { class: 'db-rank', text: String(i + 1) }),
      avatar(r.name, r.photo),
      el('span', { class: 'db-name', text: r.name }),
      el('span', { class: 'db-time', text: String(r.n) }),
      el('span', { class: 'db-unit', text: r.n === 1 ? 'solve' : 'solves' }),
    )));
}

/* ---------------------------------------------------------
   Signing in, asked for where it is needed
   --------------------------------------------------------- */

/**
 * The window's own sign-in call to action.
 *
 * Pointing at the account icon in a top bar this window has deliberately
 * hidden was not a real instruction — it named a control that was not on
 * screen. The button that fixes the problem belongs next to the sentence
 * describing it, and it runs the same `signIn('google')` the settings panel
 * does; there is no second identity here.
 */
function signInPrompt() {
  return el('div', { class: 'sotd-signin' },
    el('div', { class: 'sotd-signin-text', text:
      'Anyone can watch today’s board, but a time on it needs a name attached.' }),
    el('button', {
      class: 'btn primary full', text: 'Sign in with Google to take part',
      onclick: async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        try { await signIn('google'); }
        catch (err) {
          // A popup you closed yourself is a decision, not a failure.
          if (err?.code !== 'auth/popup-closed-by-user') {
            console.warn('[daily] sign-in failed', err);
            toast('Could not sign in — check your connection and try again', { kind: 'bad' });
          }
          btn.disabled = false;
        }
      },
    }),
  );
}

/* ===========================================================
   The window
   =========================================================== */

/** What the bar says about where you are in the day's one attempt. */
const STATE_TEXT = {
  'signed-out': 'sign in to take part',
  waiting: 'waiting for today’s scramble',
  ready: 'this is today’s scramble — one attempt',
  done: 'attempt submitted',
};

/** The live window, or null. At most one is ever open. */
let open = null;

export function sotdOpen() { return !!open; }

/**
 * Enter the Scramble of the Day window.
 *
 * The bar and the board card are static markup in index.html, shown only by
 * the `sotd` class on <body> — not elements this function creates. That is
 * deliberate: the window is a LAYOUT, and a layout that only exists once
 * some JavaScript has run is one that can be half-applied. With the markup
 * already there, `body.sotd` is the entire state, which is also what makes
 * the window checkable from the outside without driving the whole feature.
 *
 * `ctl` is daily.js's controller; `onExit` runs after the window is gone, so
 * main.js decides what leaving means for an armed attempt without this file
 * having an opinion about it. `solving` answers "is the timer mid-solve right
 * now" — asked rather than inspected, because the timer is main.js's private
 * state and reaching into it from here would be reading a variable that is
 * not on `app` at all.
 */
export function openSotd(app, ctl, { onExit, solving = () => false } = {}) {
  if (open) return open;

  const bar = document.getElementById('sotd-bar');
  const board = document.getElementById('sotd-board');
  const dayNode = bar.querySelector('.sotd-day');
  const stateNode = bar.querySelector('.sotd-state');
  const countNode = bar.querySelector('.sotd-count');
  const exitBtn = document.getElementById('sotd-exit');

  /* The boards are ALWAYS on screen, which is a correction rather than a
     preference. Hiding the whole card until you had submitted meant a window
     whose entire subject is a leaderboard opened showing no leaderboard —
     and in the state where the time board is legitimately gated, that gate is
     the single most useful thing the window can say, because it explains why.
     The count board is public and needs no gate at all, so it was being
     withheld for no reason whatsoever. */
  const renderBoard = () => {
    board.innerHTML = '';
    board.hidden = false;
    board.append(el('div', { class: 'sotd-board-card' },
      el('h3', { text: 'Today’s times' }),
      timeBoard(ctl.ranked(), ctl.revealed),
      ctl.snap?.signedIn ? null : signInPrompt(),
      SHOW_COUNT_BOARD ? [
        el('h3', { class: 'sotd-h3-second' }, 'Most solves today',
          el('span', { class: 'sotd-h3-note', text: 'any event · resets at midnight IST' })),
        countBoard(ctl.countBoard()),
      ] : null,
    ));
  };

  const onChange = () => {
    dayNode.textContent = ctl.snap?.dayId || '—';
    /* What the window is currently doing, in the bar rather than in a toast:
       a toast about the state you are in disappears five seconds later and
       leaves you looking at a screen that no longer explains itself. */
    const st = ctl.status();
    stateNode.textContent = STATE_TEXT[st] || '';
    stateNode.dataset.state = st;
    renderBoard();
    placeBoard();
  };

  /**
   * Park the column under the scramble rather than beside it.
   *
   * Measured rather than guessed at with a magic `top`, because the scramble
   * is one line or two depending on the event and the reader's own size
   * setting, and a constant that clears it today stops clearing it the first
   * time somebody opens this on a 5x5. Left to the stylesheet below the
   * timer's breakpoint, where the board is a bottom sheet and has no business
   * being positioned from up here.
   */
  const placeBoard = () => {
    const root = document.documentElement;
    if (window.innerWidth < 861) { root.style.removeProperty('--sotd-board-top'); return; }
    const zone = document.getElementById('scramble-zone');
    if (!zone) return;
    root.style.setProperty('--sotd-board-top', `${Math.round(zone.getBoundingClientRect().bottom + 14)}px`);
  };

  const tick = () => {
    placeBoard();
    if (!ctl.snap?.nextResetMs || !ctl.net) { countNode.textContent = '—'; return; }
    ctl.checkRollover();
    countNode.textContent = formatCountdown(ctl.snap.nextResetMs - ctl.net.serverNow());
  };

  const close = () => {
    if (open !== state) return;
    open = null;
    document.body.classList.remove('sotd');
    board.hidden = true;
    board.innerHTML = '';
    clearInterval(state.timer);
    document.documentElement.style.removeProperty('--sotd-board-top');
    window.removeEventListener('resize', placeBoard);
    ctl.removeEventListener('change', onChange);
    document.removeEventListener('keydown', onKey, true);
    exitBtn.removeEventListener('click', close);
    onExit?.();
  };

  /* Esc leaves, captured before the app's own handlers see it: while this
     window is up it is the outermost thing on screen, and Esc on the
     outermost thing means "close this", not whatever it meant underneath.
     Not while the timer is mid-solve, though — Esc is how you abandon a
     solve, and that has to keep working from in here. */
  const onKey = (e) => {
    if (e.key !== 'Escape' || solving()) return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };

  const state = { close, timer: 0 };
  document.addEventListener('keydown', onKey, true);
  exitBtn.addEventListener('click', close);
  ctl.addEventListener('change', onChange);

  document.body.classList.add('sotd');
  window.addEventListener('resize', placeBoard);
  open = state;
  onChange();
  tick();
  state.timer = setInterval(tick, 1000);
  return state;
}

export function closeSotd() { open?.close(); }
