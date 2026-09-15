/* ===========================================================
   Tagda Timer — toasts (with optional undo action)
   =========================================================== */

import { $, el } from './util.js';

/**
 * Two lifetimes, and nothing else. A toast is confirming something you just did
 * and already know about, so it has no business sitting over the timer.
 *
 * Deliberately named rather than numeric: call sites each picking their own
 * "but this one is important" duration is how the whole set drifted out to five
 * and six seconds, so there is no way to ask for a number from outside. Anything
 * that genuinely needs an answer is a confirmToast below, and anything undoable
 * stays undoable with Ctrl+Z long after the toast has gone.
 */
const SHORT_MS = 1000;
const LONG_MS = 1500;      // { long: true } — a moment more
const HOLD_MS = 5000;      // { hold: true } — a new best single or average, and nothing else

export function toast(message, { action, onAction, kind = '', long = false, hold = false } = {}) {
  const host = $('#toasts');
  const node = el('div', { class: `toast ${kind}` }, el('span', { text: message }));

  let timer;
  const close = () => {
    clearTimeout(timer);
    node.classList.add('out');
    setTimeout(() => node.remove(), 240);
  };

  if (action) {
    node.append(el('button', {
      class: 't-act',
      text: action,
      onclick: () => { onAction?.(); close(); },
    }));
  }

  host.append(node);
  timer = setTimeout(close, hold ? HOLD_MS : long ? LONG_MS : SHORT_MS);
  return close;
}

/**
 * Small inline confirm rendered as a toast — avoids blocking dialogs.
 *
 * Unlike a toast this one is a question, so it waits: `timeout` is how long
 * before it gives up and answers "no" for you. A snap decision you have already
 * made in your hands (that was a misfire) wants a short one; anything
 * destructive wants long enough to actually read.
 *
 * The returned promise carries `dismiss()`, which answers "no" early — for when
 * whatever the question was about has already moved on.
 */
export function confirmToast(message, confirmLabel = 'Confirm', { timeout = 9000 } = {}) {
  let dismiss;
  const answer = new Promise((resolve) => {
    const host = $('#toasts');
    const node = el('div', { class: 'toast bad' }, el('span', { text: message }));
    const done = (v) => {
      if (!node.isConnected || node.classList.contains('out')) return;
      node.classList.add('out'); setTimeout(() => node.remove(), 220); resolve(v);
    };
    dismiss = () => done(false);
    node.append(
      el('button', { class: 't-act', text: confirmLabel, onclick: () => done(true) }),
      el('button', { class: 't-act', style: { color: 'var(--text-faint)' }, text: 'cancel', onclick: () => done(false) }),
    );
    host.append(node);
    setTimeout(() => done(false), timeout);
  });
  answer.dismiss = dismiss;
  return answer;
}
