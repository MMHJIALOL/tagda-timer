/* ===========================================================
   Tagda Timer — toasts (with optional undo action)
   =========================================================== */

import { $, el } from './util.js';

export function toast(message, { action, onAction, timeout = 4200, kind = '' } = {}) {
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
  timer = setTimeout(close, timeout);
  return close;
}

/** Small inline confirm rendered as a toast — avoids blocking dialogs. */
export function confirmToast(message, confirmLabel = 'Confirm') {
  return new Promise((resolve) => {
    const host = $('#toasts');
    const node = el('div', { class: 'toast bad' }, el('span', { text: message }));
    const done = (v) => { node.classList.add('out'); setTimeout(() => node.remove(), 220); resolve(v); };
    node.append(
      el('button', { class: 't-act', text: confirmLabel, onclick: () => done(true) }),
      el('button', { class: 't-act', style: { color: 'var(--text-faint)' }, text: 'cancel', onclick: () => done(false) }),
    );
    host.append(node);
    setTimeout(() => { if (node.isConnected) done(false); }, 9000);
  });
}
