import { t } from './i18n.js';
/* ===========================================================
   Tagda Timer — the admin console's People › Feedback (js/admin.js; ADMIN.md §21)

   feedback/<id> = { at, text, rating?, ver, ua, page, uid?, name?, read?, star?, reply?, replySeen? }

   What people sent from the timer's About (js/send-feedback.js), newest
   first: All, Unread, Starred. Mark read, star, reply (when they left their
   account with it: the reply reaches their account menu, as support replies
   do), delete. The People tab's badge counts the unread.
   =========================================================== */

import { el } from './util.js';
import { toast } from './toast.js';

const SHOWN = 300;

/**
 * @param ctx  { S, scheduleRender, raw, ago, who, openSheet, closeSheet, gate }
 */
export function createFeedback(ctx) {
  const { S, raw, ago } = ctx;
  const F = { off: null, list: [], loaded: false, refused: false, filter: 'all' };
  const sdk = () => S.sdk;
  const ref = (path) => sdk().ref(sdk().db, path);

  function start() {
    if (F.off || !S.sdk) return;
    const { onValue, query, orderByKey, limitToLast } = sdk();
    F.off = onValue(query(ref('feedback'), orderByKey(), limitToLast(SHOWN)), (s) => {
      const list = [];
      s.forEach((c) => { list.push({ id: c.key, ...c.val() }); });
      // Newest first, by when it was sent rather than by key.
      F.list = list.sort((a, b) => (b.at || 0) - (a.at || 0));
      F.loaded = true;
      F.refused = false;
      ctx.scheduleRender();
    }, () => { F.loaded = true; F.refused = true; ctx.scheduleRender(); });
  }

  function stop() {
    F.off?.();
    Object.assign(F, { off: null, list: [], loaded: false, refused: false });
  }

  /** For the People tab's badge and the sub-tab. */
  const counts = () => ({ unread: F.list.filter(f => !f.read).length });

  async function write(updates, done) {
    try {
      await sdk().update(sdk().ref(sdk().db), updates);
      if (done) toast(done, { kind: 'good' });
      return true;
    } catch (err) {
      console.warn('[admin] feedback write refused', err?.code || err);
      toast(t('The database refused that'), { kind: 'bad', hold: true });
      return false;
    }
  }

  const TS = () => sdk().serverTimestamp();
  const markRead = (f, on) => write({ [`feedback/${f.id}/read`]: on ? TS() : null });
  const star = (f) => write({ [`feedback/${f.id}/star`]: f.star ? null : true });

  function askReply(f) {
    const box = el('textarea', { class: 'ac-inp', rows: 5, maxlength: 1000, placeholder: t('Your reply') });
    const go = el('button', { class: 'ac-btn primary', text: t('Send reply'), disabled: true });
    box.addEventListener('input', () => { go.disabled = !box.value.trim(); });
    go.addEventListener('click', async () => {
      go.disabled = true;
      if (await write({ [`feedback/${f.id}/reply`]: { text: box.value.trim().slice(0, 1000), by: S.user.uid, at: TS() }, [`feedback/${f.id}/read`]: TS() },
        t('Replied: it shows in their account menu'))) ctx.closeSheet();
      else go.disabled = false;
    });
    ctx.openSheet(
      el('h2', { class: 'ac-h2', text: t('Reply to {name}', { name: f.name || t('them') }) }),
      raw('p', { class: 'ac-reason' }, f.text || ''),
      el('div', { class: 'ac-text' }, box),
      el('p', { class: 'ac-sub', text: 'They see it under Reply from support in the timer’s account menu, the next time it opens.' }),
      el('div', { class: 'ac-sheet-actions' }, el('button', { class: 'ac-btn', text: 'Back', onclick: ctx.closeSheet }), go));
    box.focus();
  }

  function askDelete(f) {
    ctx.openSheet(
      el('h2', { class: 'ac-h2', text: t('Delete this feedback?') }),
      raw('p', { class: 'ac-reason' }, f.text || ''),
      el('div', { class: 'ac-sheet-actions' },
        el('button', { class: 'ac-btn', text: 'Back', onclick: ctx.closeSheet }),
        el('button', { class: 'ac-btn primary danger', text: t('Delete'), onclick: async () => {
          if (await write({ [`feedback/${f.id}`]: null }, t('Deleted'))) ctx.closeSheet();
        } })));
  }

  function row(f) {
    const stars = f.rating ? '★'.repeat(f.rating) + '☆'.repeat(5 - f.rating) : '';
    return el('li', { class: `ac-entry${f.read ? ' ac-ended' : ''}` },
      el('div', { class: 'ac-entry-main' },
        el('span', { class: 'ac-chat-head' },
          f.uid ? el('a', { class: 'ac-link', href: `#people/u/${f.uid}`, text: f.name || f.uid.slice(0, 10) }) : raw('b', {}, t('No account')),
          stars ? raw('span', { class: 'ac-stars', title: t('{n} of 5', { n: f.rating }) }, stars) : null,
          f.star ? raw('span', { class: 'ac-pill' }, '★') : null,
          !f.read ? raw('span', { class: 'ac-pill warn' }, t('new')) : null),
        raw('span', { class: 'ac-reason ac-pre' }, f.text || ''),
        f.reply ? raw('span', { class: 'ac-reply' }, f.reply.text || '') : null,
        raw('span', { class: 'ac-entry-meta', title: f.at ? new Date(f.at).toLocaleString() : '' }, [
          ago(f.at), f.ver ? t('version {v}', { v: f.ver }) : null, f.ua || null,
          f.reply ? (f.replySeen ? t('reply read {when}', { when: ago(f.replySeen) }) : t('replied {when}', { when: ago(f.reply.at) })) : null,
        ].filter(Boolean).join(' · '))),
      el('div', { class: 'ac-entry-actions' },
        el('button', { class: 'ac-btn small', text: f.read ? t('Unread') : t('Read'), onclick: () => markRead(f, !f.read) }),
        el('button', { class: 'ac-btn small', text: f.star ? t('Unstar') : t('Star'), onclick: () => star(f) }),
        f.uid ? el('button', { class: 'ac-btn small primary', text: f.reply ? t('Reply again') : t('Reply'), onclick: () => askReply(f) }) : null,
        el('button', { class: 'ac-btn small danger', text: t('Delete'), onclick: () => askDelete(f) })));
  }

  function view() {
    start();
    if (F.refused) return [ctx.gate('Publish the rules first', 'Feedback needs the firebase.rules.json from this version of the page.')];
    if (!F.loaded) return [el('p', { class: 'ac-note', text: 'Loading…' })];
    const by = { all: F.list, unread: F.list.filter(f => !f.read), starred: F.list.filter(f => f.star) };
    const list = by[F.filter] || F.list;
    const chips = el('div', { class: 'ac-chips' }, ...[['all', t('All · {n}', { n: by.all.length })], ['unread', t('Unread · {n}', { n: by.unread.length })], ['starred', t('Starred · {n}', { n: by.starred.length })]]
      .map(([k, label]) => el('button', { class: `ac-chip${F.filter === k ? ' on' : ''}`, type: 'button', onclick: () => { F.filter = k; ctx.scheduleRender(); } }, raw('span', {}, label))));
    const mode = ctx.cfg('feedback', 'mode');
    return [
      el('p', { class: 'ac-sub', text: mode === 'form'
        ? 'Feedback goes to the Google Form for now (Settings › Feedback form › Where feedback goes). Switch it to Inbox or Both and the timer’s About offers Send feedback, which lands here.'
        : 'Sent from the timer’s About by signed-in people, one an hour each. With an account, a reply reaches them in the timer.' }),
      chips,
      list.length ? el('ol', { class: 'ac-log' }, ...list.map(row)) : el('p', { class: 'ac-note', text: 'Nothing here.' }),
    ];
  }

  return { start, stop, view, counts };
}
