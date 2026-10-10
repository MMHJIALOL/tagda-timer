import { t } from './i18n.js';
/* ===========================================================
   Tagda Timer — the admin console's moderation log (js/admin.js; ADMIN.md §19)

   modLog/<id> = { by, at, action, path, uid?, before?, note?, undo? }, one
   entry per moderation action, written in the same update as the action
   (js/moderation.js logged()): by this page, and by an admin's buttons in
   the timer. The Log tab shows it beside the settings log, newest first,
   with Undo where an action can be undone:

     ban / unban              unban / ban again as it was (not one that has ended)
     kick / let back          let back in / remove again
     strike / count again     count again / strike again
     close / reopen           reopen / close; Close all: reopen every one
     keep                     take the keep back (the time is marked again)
     re-time                  the penalty it had before
     feature / unfeature      the featured replay as it was
     dismiss / acted on       reopen the reports

   A removed time, a deleted message, room or account, and a removed replay
   cannot be undone: the person got the backup, and the rules let nobody
   post in somebody else's name. Their entry keeps what it was (`before`).
   An undo is an action of its own, logged with `undo` pointing back.
   =========================================================== */

import { el } from './util.js';
import { toast } from './toast.js';
import { logged } from './moderation.js';
import { banAccount, unbanAccount } from './admins.js';

const SHOWN = 300;

/**
 * @param ctx  { S, scheduleRender, raw, ago, who, openSheet, closeSheet, gate, nameOf }
 */
export function createModLog(ctx) {
  const { S, raw, ago } = ctx;
  const L = { started: false, off: null, list: [], loaded: false, refused: false };
  const sdk = () => S.sdk;
  const ref = (path) => sdk().ref(sdk().db, path);
  const TS = () => sdk().serverTimestamp();

  function start() {
    if (L.started || !S.sdk) return;
    L.started = true;
    const { onValue, query, orderByKey, limitToLast } = sdk();
    L.off = onValue(query(ref('modLog'), orderByKey(), limitToLast(SHOWN)), (s) => {
      const list = [];
      s.forEach((c) => { list.push({ id: c.key, ...c.val() }); });
      // By time, not key: an entry written from a device with a wrong clock still lands in its place.
      L.list = list.sort((a, b) => (b.at || 0) - (a.at || 0));
      L.loaded = true;
      L.refused = false;
      ctx.scheduleRender();
    }, () => { L.loaded = true; L.refused = true; ctx.scheduleRender(); });
  }

  function stop() {
    L.off?.();
    Object.assign(L, { started: false, off: null, list: [], loaded: false, refused: false });
  }

  /** What an action is called in the log and on the person page. */
  const label = (action) => ({
    ban: t('Banned'), unban: t('Unbanned'), removeTime: t('Removed a Scramble of the Day time'), removeRaceTime: t('Removed a race time'),
    deleteMessage: t('Deleted a message'), deleteMessages: t('Deleted their messages'), removeReplay: t('Removed a shared replay'),
    kick: t('Removed from a room'), letBack: t('Let back into a room'), strike: t('Struck a race time'), unstrike: t('Counted a race time again'),
    close: t('Closed a room'), reopen: t('Reopened a room'), closeAll: t('Closed every open room'), deleteRoom: t('Deleted a room'),
    keep: t('Kept a held time'), unkeep: t('Took a keep back'), retime: t('Re-timed'), feature: t('Featured a replay'),
    unfeature: t('Took the featured replay off'), dismiss: t('Dismissed reports'), actioned: t('Closed reports as acted on'),
    reopenReport: t('Reopened reports'), deleteAccount: t('Deleted an account’s cloud data'), sweep: t('Swept old data'),
  })[action] || action;

  /* ---------------- undo ---------------- */

  const seg = (path) => String(path || '').split('/');

  /** How to undo `e`: { what, run } where run() resolves whether it went, or null with why not. */
  function undoOf(e) {
    const p = seg(e.path);
    const b = e.before;
    const with_ = (updates, action, extra = {}) => () => logged(sdk(), updates, { action, path: e.path, uid: e.uid || '', undo: e.id, ...extra });
    switch (e.action) {
      case 'ban':
        return { what: t('Unban them'), run: () => unbanAccount(sdk(), e.uid, S.bans?.[e.uid] || null, e.id) };
      case 'unban': {
        if (!b) return { why: t('The log has no copy of that ban') };
        if (typeof b.until === 'number' && b.until <= Date.now()) return { why: t('That ban has ended since') };
        return { what: t('Ban them again, as before'), run: () => banAccount(sdk(), { uid: e.uid, name: b.name || '', reason: b.reason || '', until: b.until || null,
          scope: typeof b.scope === 'string' ? b.scope.split(',') : [], undo: e.id }) };
      }
      case 'kick': return { what: t('Let them back in'), run: with_({ [`rooms/${p[1]}/mod/kicked/${e.uid}`]: null }, 'letBack') };
      case 'letBack': return { what: t('Remove them again'), run: with_({ [`rooms/${p[1]}/mod/kicked/${e.uid}`]: TS(), [`rooms/${p[1]}/players/${e.uid}`]: null }, 'kick') };
      case 'strike': return { what: t('Count it again'), run: with_({ [`rooms/${p[1]}/mod/struck/${p[3]}/${p[5]}`]: null }, 'unstrike') };
      case 'unstrike': return { what: t('Strike it again'), run: with_({ [`rooms/${p[1]}/mod/struck/${p[3]}/${p[5]}`]: { at: TS(), by: S.user.uid } }, 'strike') };
      case 'close': return { what: t('Reopen it'), run: with_({ [`rooms/${p[1]}/mod/closed`]: null }, 'reopen') };
      case 'reopen': return { what: t('Close it again'), run: with_({ [`rooms/${p[1]}/mod/closed`]: { at: TS(), by: S.user.uid } }, 'close') };
      case 'closeAll':
        return Array.isArray(b) && b.length
          ? { what: t('Reopen all {n}', { n: b.length }), run: with_(Object.fromEntries(b.map(id => [`rooms/${id}/mod/closed`, null])), 'reopen', { note: b.join(', ') }) }
          : { why: t('The log has no list of those rooms') };
      case 'keep': return { what: t('Take the keep back'), run: with_({ [`${e.path}/review`]: null }, 'unkeep') };
      case 'retime':
        return /^(none|[+]2|DNF)$/.test(String(b))
          ? { what: t('Set it back to {p}', { p: b === 'none' ? t('no penalty') : b }), run: with_({ [`${e.path}/penalty`]: b }, 'retime', { before: e.note || null, note: b }) }
          : { why: t('The log has no copy of the penalty before') };
      case 'feature':
      case 'unfeature':
        return { what: b ? t('Put the replay it had back') : t('Take the featured replay off'),
          run: with_({ [e.path]: b && b.event && b.uid ? { event: b.event, uid: b.uid } : null }, b ? 'feature' : 'unfeature', { uid: b?.uid || '' }) };
      case 'dismiss':
      case 'actioned':
        return { what: t('Reopen the reports'), run: async () => {
          const s = await sdk().get(ref('reports'));
          const ids = Object.entries(s.val() || {}).filter(([, r]) => r?.path === e.path && r?.status).map(([id]) => id);
          if (!ids.length) throw Object.assign(new Error('none'), { why: t('Those reports are gone') });
          return logged(sdk(), Object.fromEntries(ids.map(id => [`reports/${id}/status`, null])), { action: 'reopenReport', path: e.path, undo: e.id });
        } };
      case 'removeTime': return { why: t('They were given the backup scramble: a removal is final') };
      case 'deleteMessage':
      case 'deleteMessages': return { why: t('Nobody can post in somebody else’s name, so a message cannot come back. What it said is kept here.') };
      default: return { why: t('This cannot be undone') };
    }
  }

  function askUndo(e) {
    const u = undoOf(e);
    if (!u?.run) return;
    const go = el('button', { class: 'ac-btn primary', text: u.what });
    go.addEventListener('click', async () => {
      go.disabled = true;
      try {
        await u.run();
        ctx.closeSheet();
        toast(t('Undone. That is in the log too.'), { kind: 'good' });
      } catch (err) {
        console.warn('[admin] undo refused', err?.code || err);
        toast(err?.why || t('The database refused that'), { kind: 'bad', hold: true });
        go.disabled = false;
      }
    });
    ctx.openSheet(
      el('h2', { class: 'ac-h2', text: t('Undo: {what}?', { what: label(e.action) }) }),
      el('p', { class: 'ac-sub', text: describe(e) }),
      el('div', { class: 'ac-sheet-actions' }, el('button', { class: 'ac-btn', text: 'Back', onclick: ctx.closeSheet }), go));
  }

  /* ---------------- the view ---------------- */

  /** What it was (and, `withWho`, who it was about): one line. */
  function describe(e, withWho = true) {
    const who = withWho && e.uid ? (ctx.nameOf?.(e.uid) || e.uid) : '';
    const b = e.before;
    const said = b && typeof b === 'object' && typeof b.text === 'string' ? `“${b.text}”` : '';
    // A re-time says from what to what; Close all, which rooms. The path is the row's tooltip.
    const what = e.action === 'retime' && typeof b === 'string' ? `${b === 'none' ? t('no penalty') : b} → ${e.note === 'none' ? t('no penalty') : e.note}`
      : e.action === 'closeAll' && Array.isArray(b) ? b.join(', ') : e.note;
    return [who, said, what].filter(Boolean).join(' · ');
  }

  function row(e, undoneBy) {
    const u = undoOf(e);
    return el('li', { class: 'ac-entry' },
      el('div', { class: 'ac-entry-main' },
        el('span', { class: 'ac-chat-head' },
          raw('b', {}, label(e.action)),
          e.uid ? el('a', { class: 'ac-link', href: `#people/u/${e.uid}`, text: ctx.nameOf?.(e.uid) || e.uid.slice(0, 10) }) : null),
        raw('span', { class: 'ac-reason', title: e.path || '' }, describe(e, false) || e.path || ''),
        raw('span', { class: 'ac-entry-meta', title: e.at ? new Date(e.at).toLocaleString() : '' }, [
          ctx.who(e.by), ago(e.at),
          e.undo ? t('an undo') : '',
          undoneBy ? t('undone {when} by {who}', { when: ago(undoneBy.at), who: ctx.who(undoneBy.by) }) : '',
        ].filter(Boolean).join(' · '))),
      u?.run && !undoneBy
        ? el('button', { class: 'ac-btn small', text: 'Undo', onclick: () => askUndo(e) })
        : el('button', { class: 'ac-btn small', text: 'Undo', disabled: true, title: undoneBy ? t('Undone already') : (u?.why || '') }));
  }

  function view() {
    start();
    if (L.refused) return [ctx.gate('Publish the rules first', 'The moderation log needs the firebase.rules.json from this version of the page. Until then, moderation works as before, unlogged.')];
    if (!L.loaded) return [el('p', { class: 'ac-note', text: 'Loading…' })];
    if (!L.list.length) return [el('p', { class: 'ac-note', text: 'Nothing done yet. Every ban, removal, deleted message and room action lands here, from this page and from the timer.' })];
    const undone = new Map();
    for (const e of L.list) if (e.undo && !undone.has(e.undo)) undone.set(e.undo, e);
    return [el('ol', { class: 'ac-log' }, ...L.list.map(e => row(e, undone.get(e.id))))];
  }

  return { start, stop, view, label };
}
