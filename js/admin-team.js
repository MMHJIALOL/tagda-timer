import { t } from './i18n.js';
/* ===========================================================
   Tagda Timer — the admin console's People › Team (js/admin.js; ADMIN.md §22)

     admins/<uid>     true, added by hand in the Firebase console (as ever)
     mods/<uid>       { at, by, name, can: 'chat,sotd,race,reports' }   admins write
     adminSeen/<uid>  { at, role, ver, ua }   the console writes it on every load

   Everybody who can open this page, and when each last did. A moderator sees
   only Moderate, and only the parts their `can` lists; the rules hold them to
   it (settings, announcements, bans, testers and people stay admins only).
   Adding, changing and removing a moderator is logged (modLog).
   =========================================================== */

import { el } from './util.js';
import { toast } from './toast.js';
import { logged } from './moderation.js';
import { MOD_SCOPES } from './admins.js';

const UID_RE = /^[A-Za-z0-9]{1,128}$/;

/**
 * @param ctx  { S, scheduleRender, raw, ago, openSheet, closeSheet, gate, nameOf }
 */
export function createTeam(ctx) {
  const { S, raw, ago } = ctx;
  const T = { offs: [], admins: null, mods: null, seen: null, refused: false };
  const sdk = () => S.sdk;
  const ref = (path) => sdk().ref(sdk().db, path);
  const SCOPE = () => ({ chat: t('Chats'), sotd: t('Scramble of the Day'), race: t('Race rooms and 1v1s'), reports: t('Reports') });

  function start() {
    if (T.offs.length || !S.sdk) return;
    const { onValue } = sdk();
    const on = (path, key) => onValue(ref(path), (s) => { T[key] = s.val() || {}; ctx.scheduleRender(); },
      () => { T[key] = {}; if (key === 'mods') T.refused = true; ctx.scheduleRender(); });
    T.offs.push(on('admins', 'admins'), on('mods', 'mods'), on('adminSeen', 'seen'));
  }

  function stop() {
    for (const off of T.offs.splice(0)) off();
    Object.assign(T, { admins: null, mods: null, seen: null, refused: false });
  }

  /** Ticks for a moderator's scopes. */
  function ticks(pre = []) {
    const boxes = MOD_SCOPES.map(s => el('input', { type: 'checkbox', value: s, checked: pre.includes(s) }));
    return { node: el('div', { class: 'ac-chips ac-picks' }, ...boxes.map((b, i) => el('label', { class: 'ac-chip' }, b, raw('span', {}, SCOPE()[MOD_SCOPES[i]])))),
      value: () => boxes.filter(b => b.checked).map(b => b.value) };
  }

  async function save(uid, name, can, before) {
    const rec = { at: sdk().serverTimestamp(), by: S.user.uid, can: can.join(',') };
    if (name) rec.name = name.slice(0, 32);
    try {
      await logged(sdk(), { [`mods/${uid}`]: rec }, { action: 'addMod', path: `mods/${uid}`, uid, note: rec.can, before: before || null });
      ctx.closeSheet();
      toast(t('{name} moderates: {what}', { name: name || uid, what: can.map(s => SCOPE()[s]).join(', ') }), { kind: 'good', long: true });
    } catch (err) {
      console.warn('[admin] moderator refused', err?.code || err);
      toast(t('Refused: moderators need this version’s firebase.rules.json published'), { kind: 'bad', hold: true });
    }
  }

  function askEdit(uid = '', m = null) {
    const id = el('input', { class: 'ac-inp', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', maxlength: 128, value: uid, disabled: !!uid });
    const name = el('input', { class: 'ac-inp', autocomplete: 'off', maxlength: 32, value: m?.name || ctx.nameOf?.(uid) || '' });
    const tk = ticks(String(m?.can || '').split(','));
    const go = el('button', { class: 'ac-btn primary', text: uid ? t('Save') : t('Make moderator') });
    go.addEventListener('click', () => {
      const who = (uid || id.value).trim();
      if (!UID_RE.test(who)) { toast(t('That is not an account id: letters and digits only'), { kind: 'bad' }); return; }
      if (T.admins?.[who] === true) { toast(t('An admin already has all of it'), { kind: 'bad' }); return; }
      const can = tk.value();
      if (!can.length) { toast(t('Tick at least one'), { kind: 'bad' }); return; }
      save(who, name.value.trim(), can, m);
    });
    const field = (label, input) => el('label', { class: 'ac-field' }, el('span', { class: 'ac-label', text: label }), input);
    ctx.openSheet(
      el('h2', { class: 'ac-h2', text: uid ? t('What {name} moderates', { name: m?.name || uid }) : t('A new moderator') }),
      field(t('Account id (uid)'), id),
      field(t('Name, for this list'), name),
      el('fieldset', { class: 'ac-field ac-scope' }, el('legend', { class: 'ac-label', text: t('Can moderate') }), tk.node),
      el('p', { class: 'ac-sub', text: 'They sign in to this page with that Google account and see only Moderate, and only these parts of it. Never settings, announcements, bans, testers or people: the rules hold them to it.' }),
      el('div', { class: 'ac-sheet-actions' }, el('button', { class: 'ac-btn', text: 'Back', onclick: ctx.closeSheet }), go));
  }

  function askRemove(uid, m) {
    ctx.openSheet(
      el('h2', { class: 'ac-h2', text: t('Stop {name} moderating?', { name: m?.name || uid }) }),
      el('p', { class: 'ac-sub', text: 'Their next action on the page is refused, and the page shows them the door when they next open it.' }),
      el('div', { class: 'ac-sheet-actions' },
        el('button', { class: 'ac-btn', text: 'Back', onclick: ctx.closeSheet }),
        el('button', { class: 'ac-btn primary danger', text: t('Remove'), onclick: async () => {
          try {
            await logged(sdk(), { [`mods/${uid}`]: null }, { action: 'removeMod', path: `mods/${uid}`, uid, before: m || null });
            ctx.closeSheet();
            toast(t('Removed'), { kind: 'good' });
          } catch (err) {
            console.warn('[admin] moderator removal refused', err?.code || err);
            toast(t('The database refused that'), { kind: 'bad', hold: true });
          }
        } })));
  }

  function row(uid, role, m) {
    const seen = T.seen?.[uid];
    const name = m?.name || ctx.nameOf?.(uid) || '';
    return el('li', { class: 'ac-entry' },
      el('div', { class: 'ac-entry-main' },
        el('span', { class: 'ac-chat-head' },
          el('a', { class: 'ac-link', href: `#people/u/${uid}`, text: name || uid.slice(0, 10) }),
          raw('span', { class: `ac-pill${role === 'admin' ? ' on' : ''}` }, role === 'admin' ? t('admin') : t('moderator')),
          uid === S.user?.uid ? raw('span', { class: 'ac-pill' }, t('you')) : null),
        role === 'mod' ? raw('span', { class: 'ac-reason' }, String(m?.can || '').split(',').map(s => SCOPE()[s] || s).join(' · ')) : null,
        raw('span', { class: 'ac-entry-meta' }, [
          seen ? t('last here {when}', { when: ago(seen.at) }) : t('not here since this page started keeping track'),
          seen?.ver ? t('version {v}', { v: seen.ver }) : null, seen?.ua || null,
          role === 'mod' && m?.by ? t('added by {who}', { who: ctx.who(m.by) }) : null,
        ].filter(Boolean).join(' · '))),
      role === 'mod' ? el('div', { class: 'ac-entry-actions' },
        el('button', { class: 'ac-btn small', text: t('Change'), onclick: () => askEdit(uid, m) }),
        el('button', { class: 'ac-btn small danger', text: t('Remove'), onclick: () => askRemove(uid, m) })) : null);
  }

  function view() {
    start();
    if (T.refused) return [ctx.gate('Publish the rules first', 'Moderators need the firebase.rules.json from this version of the page.')];
    if (!T.admins || !T.mods) return [el('p', { class: 'ac-note', text: 'Loading…' })];
    const admins = Object.entries(T.admins).filter(([, v]) => v === true).map(([uid]) => uid);
    const mods = Object.entries(T.mods);
    return [
      el('p', { class: 'ac-sub', text: 'Everybody who can open this page. Admins are added by hand under admins/ in the Firebase console and have all of it. A moderator has only the parts of Moderate ticked for them.' }),
      el('div', { class: 'ac-entry-actions ac-start' }, el('button', { class: 'ac-btn primary', text: t('Add a moderator…'), onclick: () => askEdit() })),
      el('h2', { class: 'ac-h2 ac-gap', text: t('Admins') }),
      el('ol', { class: 'ac-log ac-tight' }, ...admins.map(uid => row(uid, 'admin'))),
      el('h2', { class: 'ac-h2 ac-gap', text: t('Moderators') }),
      mods.length ? el('ol', { class: 'ac-log ac-tight' }, ...mods.map(([uid, m]) => row(uid, 'mod', m)))
        : el('p', { class: 'ac-note', text: 'Nobody yet.' }),
    ];
  }

  return { start, stop, view };
}
