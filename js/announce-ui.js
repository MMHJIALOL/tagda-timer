import { t } from './i18n.js';
/* ===========================================================
   Tagda Timer — drawing an announcement (announce.js)

   One function for the three styles, used by the app (main.js) and by the
   admin page's preview, with the same stylesheet (css/announce.css): what
   the preview shows is what people get, in the timer's default theme.

   The title, text and button label are the admin's words, not the app's,
   so they are set as text and never run through t(): except the built-in
   ones, unedited, which are the app's own words and have their Spanish.
   =========================================================== */

import { el } from './util.js';

const raw = (tag, props, text) => { const n = el(tag, props); n.textContent = text; return n; };

/**
 * The element for announcement `a`, drawn as `as` ('popup' | 'card' | 'pill').
 *
 * @param on  { go(), close(), later() }: the button, the × or Not now, and a
 *            popup's Maybe later (which leaves its reminder pill). Each is
 *            optional; a preview passes none.
 * @param preview  drawn in place, not fixed to the screen, and never modal
 */
export function annNode(a, as, on = {}, { preview = false } = {}) {
  if (a.builtIn && !a.stored) {
    a = { ...a, title: t(a.title), text: t(a.text), button: a.button ? { ...a.button, label: t(a.button.label) } : null };
  }
  const go = a.button ? raw('button', { class: 'an-btn primary', type: 'button', onclick: () => on.go?.() }, a.button.label) : null;
  const ok = a.button ? null : el('button', { class: 'an-btn primary', type: 'button', text: t('Got it'), onclick: () => on.close?.() });
  const notNow = (label) => el('button', { class: 'an-btn ghost', type: 'button', text: label, onclick: () => on.close?.() });

  if (as === 'pill') {
    return el('div', { class: `an-pill${preview ? ' an-preview' : ''}`, role: 'status' },
      raw('button', { class: 'an-pill-go', type: 'button', onclick: () => (a.button ? on.go?.() : on.close?.()) },
        a.button?.label || a.title),
      el('button', { class: 'an-pill-x', type: 'button', 'aria-label': t('Dismiss'), onclick: () => on.close?.() }, '✕'));
  }

  if (as === 'popup') {
    const later = a.reminder
      ? el('button', { class: 'an-btn ghost', type: 'button', text: t('Maybe later'), onclick: () => on.later?.() })
      : notNow(t('Not now'));
    const card = el('div', { class: 'an-dlg-card' },
      raw('h2', { class: 'an-title' }, a.title),
      a.text ? raw('p', { class: 'an-text' }, a.text) : null,
      el('div', { class: 'an-actions' }, go || ok, a.button ? later : null),
      a.reminder ? el('p', { class: 'an-note', text: t('You will only see this once. A reminder stays on the main screen until you close it.') }) : null);
    if (preview) return el('div', { class: 'an-dlg an-preview' }, card);
    const dlg = el('dialog', { class: 'an-dlg' }, card);
    // Focus the card, not a button, so a stray Space or Enter from solving does not press one.
    card.tabIndex = -1;
    return dlg;
  }

  // 'card'
  return el('div', { class: `an-card${preview ? ' an-preview' : ''}`, role: 'status', 'aria-live': 'polite' },
    el('button', { class: 'an-x', type: 'button', 'aria-label': t('Not now'), title: t('Not now'), html: '&times;', onclick: () => on.close?.() }),
    raw('b', { class: 'an-title' }, a.title),
    a.text ? raw('span', { class: 'an-text' }, a.text) : null,
    el('div', { class: 'an-row' }, go || ok, a.button ? notNow(t('Not now')) : null));
}
