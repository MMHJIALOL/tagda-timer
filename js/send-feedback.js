import { t } from './i18n.js';
/* ===========================================================
   Tagda Timer — Send feedback, straight to the admins (ADMIN.md §21)

   feedback/<id> = { at, text, rating?, ver, ua, page, uid?, name? }
   feedbackLast/<uid> = at      one an hour per account (the rules)

   From About, when the admin console's feedback.mode is 'inbox' or 'both';
   'form' and 'both' keep the Google Form's link there too. Signed in with
   Google only (the rules want an account to hold to one an hour; a signed-out
   visitor gets the form, or is asked to sign in). "Let the admins reply"
   (on by default) keeps the account id with it, so People › Feedback can
   answer and the reply reaches the account menu (js/support.js); off, the
   message carries no account at all.
   =========================================================== */

import { el } from './util.js';
import { toast } from './toast.js';
import { APP_VERSION } from './version.js';
import { getConfig } from './config.js';

/** [{ id, at }] sent from this device with a reply allowed, newest first: js/support.js looks for replies. */
export const SENT_KEY = 'tdt-feedback';
const LAST_KEY = 'tdt-feedback-last';     // when this device last sent one: said before the rules refuse
const HOUR_MS = 3_600_000;
const MAX = 1000;

const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d; } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* this device forgets */ } };

const mode = () => getConfig('feedback', 'mode');
export const inboxOn = () => mode() === 'inbox' || mode() === 'both';
export const formOn = () => (mode() === 'form' || mode() === 'both') && !!getConfig('feedback', 'url');

/** The browser family, as the heartbeat says it (never the whole user agent). */
function family(ua = navigator.userAgent) {
  return /Firefox\//.test(ua) ? 'firefox' : /Edg\//.test(ua) ? 'edge' : /OPR\//.test(ua) ? 'opera'
    : /Chrome\//.test(ua) ? 'chrome' : /Safari\//.test(ua) ? 'safari' : 'other';
}

let host = null;
function close() { host?.close(); host?.remove(); host = null; }

/** About's Feedback group: Send feedback and/or the form, by feedback.mode. Null when neither. */
export function feedbackSection() {
  const kids = [];
  if (inboxOn()) kids.push(el('button', { class: 'btn primary', type: 'button', text: t('Send feedback…'), onclick: () => openFeedback() }));
  if (formOn()) kids.push(el('a', { class: 'btn', href: getConfig('feedback', 'url'), target: '_blank', rel: 'noopener noreferrer', text: t('Fill the form') }));
  if (!kids.length) return null;
  return el('div', { class: 'feedback-box' },
    el('p', { class: 'sub', text: inboxOn()
      ? t('What to build next, what broke, what you would change. It goes straight to the people who make the timer.')
      : t('Tell us what to build next and what bugs you hit.') }),
    el('div', { class: 'btn-row' }, ...kids));
}

/** The dialog: the message, a rating if they like, and whether a reply may come back. */
export async function openFeedback() {
  const auth = await import('./sync-auth.js');
  const user = auth.currentUser();
  const google = user && !user.isAnonymous && user.providerData?.some(p => p.providerId === 'google.com');
  close();
  if (!google) {
    host = el('dialog', { class: 'competition-dialog support-dialog', 'aria-label': t('Send feedback') },
      el('header', {}, el('h2', { text: t('Send feedback') }), el('button', { class: 'ghost-btn', text: t('Close'), onclick: close })),
      el('p', { text: t('Sign in with Google (the account button, top right) to send it from here: one account, one message an hour, and a reply can find you.') }),
      formOn() ? el('a', { class: 'btn', href: getConfig('feedback', 'url'), target: '_blank', rel: 'noopener noreferrer', text: t('Or fill the form, no sign-in') }) : null);
    host.addEventListener('cancel', close);
    document.body.append(host);
    host.showModal();
    return;
  }
  const text = el('textarea', { class: 'inp', rows: 6, maxlength: MAX, placeholder: t('What should we know?') });
  let rating = 0;
  const stars = el('div', { class: 'fb-stars', role: 'radiogroup', 'aria-label': t('How is it going? (optional)') },
    ...[1, 2, 3, 4, 5].map(n => el('button', { class: 'fb-star', type: 'button', role: 'radio', 'aria-checked': 'false', 'aria-label': String(n), text: '★',
      onclick: () => { rating = rating === n ? 0 : n; paint(); } })));
  const paint = () => stars.querySelectorAll('.fb-star').forEach((b, i) => { b.classList.toggle('on', i < rating); b.setAttribute('aria-checked', String(i + 1 === rating)); });
  const reply = el('input', { type: 'checkbox', checked: true });
  const count = el('span', { class: 'sub', text: `0 / ${MAX}` });
  const send = el('button', { class: 'btn primary', type: 'button', text: t('Send'), disabled: true });
  text.addEventListener('input', () => { count.textContent = `${text.value.length} / ${MAX}`; send.disabled = !text.value.trim(); });
  // The timer behind takes Space and letters as shortcuts.
  text.addEventListener('keydown', (e) => e.stopPropagation());
  send.addEventListener('click', async () => {
    const body = text.value.trim().slice(0, MAX);
    if (!body) return;
    const last = Number(read(LAST_KEY, 0)) || 0;
    if (Date.now() - last < HOUR_MS) {
      toast(t('One message an hour: try again after {time}', { time: new Date(last + HOUR_MS).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }), { kind: 'bad', long: true });
      return;
    }
    send.disabled = true;
    try {
      const sdk = await auth.getDatabaseHandle();
      const id = sdk.push(sdk.ref(sdk.db, 'feedback')).key;
      const rec = { at: sdk.serverTimestamp(), text: body, ver: APP_VERSION, ua: family(), page: 'about' };
      if (rating) rec.rating = rating;
      if (reply.checked) {
        rec.uid = user.uid;
        const name = String(user.displayName || '').trim().slice(0, 32);
        if (name) rec.name = name;
      }
      await sdk.update(sdk.ref(sdk.db), { [`feedback/${id}`]: rec, [`feedbackLast/${user.uid}`]: sdk.serverTimestamp() });
      write(LAST_KEY, Date.now());
      if (reply.checked) write(SENT_KEY, [{ id, at: Date.now() }, ...read(SENT_KEY, [])].slice(0, 20));
      close();
      toast(reply.checked ? t('Sent. A reply shows in your account menu.') : t('Sent, without your account. Thank you.'), { kind: 'good', long: true });
    } catch (err) {
      console.warn('[feedback] refused', err?.code || err);
      send.disabled = false;
      toast(/permission/i.test(String(err?.code || err?.message || err))
        ? t('Not open yet, or one already sent this hour. Try later, or use the form.')
        : t('Could not send that, check your connection'), { kind: 'bad', long: true });
    }
  });
  host = el('dialog', { class: 'competition-dialog support-dialog feedback-dialog', 'aria-label': t('Send feedback') },
    el('header', {}, el('h2', { text: t('Send feedback') }), el('button', { class: 'ghost-btn', text: t('Close'), onclick: close })),
    text, el('div', { class: 'fb-row' }, stars, count),
    el('label', { class: 'fb-check' }, reply, el('span', { text: t('Let the admins reply (it keeps your account with the message)') })),
    el('p', { class: 'sub', text: t('Sent with it: the app version and your browser family. Nothing else from this device.') }),
    el('div', { class: 'btn-row' }, send));
  host.addEventListener('cancel', close);
  document.body.append(host);
  host.showModal();
  text.focus();
}
