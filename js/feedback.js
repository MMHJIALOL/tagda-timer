import { t } from './i18n.js';
/* ===========================================================
   Tagda Timer — feedback form: one-time popup + dismissible pill

   A time-boxed ask. Both pieces vanish by themselves once END_AT passes, so
   there is nothing to remove afterwards except this file.

   The popup is shown once per browser (localStorage), never over a solve,
   never in a hidden tab — it waits for the tab to come back and for the timer
   to go idle. The pill on the main screen is the second chance: it stays until
   it is crossed out or the form is opened.

   Bump FORM_ID to run a new form; old "seen" flags then no longer match.
   =========================================================== */

import { el } from './util.js';

const FORM_ID = 'feedback-1';
const FORM_URL = 'https://docs.google.com/forms/d/e/1FAIpQLScQ9uZRzZke7bBtlw3lkCW41-UXi9cZ-DksEKKliibsM5UCPQ/viewform';
/* 24 h from deploy. ponytail: hardcoded; edit and redeploy to extend. */
const END_AT = Date.parse('2026-10-01T12:01:00Z');

const POPUP_KEY = `tagda.fb.popup.${FORM_ID}`;
const PILL_KEY = `tagda.fb.pill.${FORM_ID}`;
const get = (k) => { try { return localStorage.getItem(k) === '1'; } catch { return false; } };
const set = (k) => { try { localStorage.setItem(k, '1'); } catch { /* private mode: shows again next visit */ } };

let dlg = null;
let pill = null;

export const feedbackOpen = () => !!(dlg && dlg.open);

const live = () => Date.now() < END_AT;

function openForm() {
  window.open(FORM_URL, '_blank', 'noopener');
  set(POPUP_KEY); set(PILL_KEY);
  closeDlg(); removePill();
}

function closeDlg() {
  if (dlg) { dlg.close(); dlg.remove(); dlg = null; }
}

function removePill() {
  if (pill) { pill.remove(); pill = null; }
}

function showPopup() {
  set(POPUP_KEY);
  dlg = el('dialog', { class: 'fb-dlg', 'aria-labelledby': 'fb-title' },
    el('div', { class: 'fb-card' },
      el('h2', { id: 'fb-title', text: 'Help shape Tagda Timer' }),
      el('p', { text: 'Got 2 minutes? Tell us what to build next, what bugs you hit, and which timer you like best. It is anonymous and your name is optional.' }),
      el('div', { class: 'fb-actions' },
        el('button', { class: 'fb-primary', type: 'button', onclick: openForm, text: 'Fill the form' }),
        el('button', { class: 'fb-ghost', type: 'button', onclick: closeDlg, text: 'Maybe later' }),
      ),
      el('p', { class: 'fb-note', text: 'You will only see this once. The form stays on the main screen until you close it.' }),
    ));
  // Escape and backdrop clicks close it too; the pill stays as the reminder.
  dlg.addEventListener('close', () => { if (dlg) { dlg.remove(); dlg = null; } });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) closeDlg(); });
  document.body.append(dlg);
  dlg.showModal();
  dlg.querySelector('.fb-primary').focus();
}

function showPill() {
  const zone = document.getElementById('timer-zone');
  if (!zone || pill) return;
  pill = el('div', { class: 'fb-pill' },
    el('button', { class: 'fb-pill-go', type: 'button', onclick: openForm, text: 'Give feedback' }),
    el('button', {
      class: 'fb-pill-x', type: 'button', 'aria-label': 'Dismiss',
      onclick: () => { set(PILL_KEY); removePill(); },
    }, '✕'));
  zone.append(pill);
}

/** timer: the app's Timer. Popup waits for a visible tab and an idle timer. */
export function initFeedback(timer) {
  if (!live()) return;
  if (!get(PILL_KEY)) showPill();
  if (get(POPUP_KEY)) return;

  const idle = () => timer.state === 'idle' || timer.state === 'cooldown';
  const clear = () => !document.hidden && idle() && !document.querySelector('.sotd-intro, dialog[open]');
  let waiting = null;
  const tick = () => {
    clearTimeout(waiting);
    if (!live() || get(POPUP_KEY) || dlg || !clear()) return;
    waiting = setTimeout(() => { if (clear() && !dlg) showPopup(); }, 1500);
  };
  document.addEventListener('visibilitychange', tick);
  timer.addEventListener('state', tick);
  setTimeout(tick, 2500);
}

const css = document.createElement('style');
css.textContent = `
.fb-dlg{position:fixed;inset:0;margin:auto;width:max-content;height:max-content;border:0;padding:0;background:transparent;max-width:min(92vw,440px);color:var(--text)}
.fb-dlg::backdrop{background:rgba(0,0,0,.6);backdrop-filter:blur(3px)}
.fb-card{background:var(--panel,var(--surface));border:1px solid var(--border);border-radius:var(--radius,14px);padding:26px 26px 20px;box-shadow:0 20px 60px rgba(0,0,0,.5)}
.fb-card h2{margin:0 0 10px;font-size:20px}
.fb-card p{margin:0 0 18px;line-height:1.5;color:var(--text-dim)}
.fb-card .fb-note{margin:14px 0 0;font-size:12px;color:var(--text-faint)}
.fb-actions{display:flex;gap:10px;flex-wrap:wrap}
.fb-actions button{font:inherit;padding:10px 18px;border-radius:var(--radius-sm);cursor:pointer;border:1px solid var(--border);background:transparent;color:var(--text)}
.fb-actions .fb-primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
.fb-pill{position:absolute;top:12px;left:50%;transform:translateX(-50%);display:flex;align-items:center;border:1px solid var(--border);border-radius:999px;background:var(--surface);font-size:13px;z-index:5}
.fb-pill button{font:inherit;background:none;border:0;color:var(--text-dim);cursor:pointer;padding:6px 12px}
.fb-pill button:hover{color:var(--text)}
.fb-pill-x{padding-left:2px;border-left:0}
`;
document.head.append(css);
