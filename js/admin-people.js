import { t } from './i18n.js';
/* ===========================================================
   Tagda Timer — the admin console's People: lookup, one person, support,
   and deletion requests (js/admin.js; ADMIN.md §17)

     Lookup     seen/: everybody signed in who has opened the timer since
                this version, by name or uid. On rules from before seen/,
                the names the console can already read (today's boards and
                chats, bans, testers).
     A person   everything about one uid the console may read, in one place,
                with what can be done about it. Never users/<uid>: admins
                cannot read anybody's synced data.
     Support    support/: what people sent from Data Health, with the
                snapshot they saw before sending; Reply, Delete.
     Requests   deletion/: Delete now removes their synced data, their
                directory entry, health reports, support tickets and the
                week's messages, in one update.
   =========================================================== */

import { el } from './util.js';
import { toast } from './toast.js';
import { logged } from './moderation.js';
import { dayKeyFromServerMs } from './dayid.js';
import { eventOf } from './events.js';
import { setOf } from './config.js';
import { SOTD_EVENTS } from './config-table.js';
import { addTester, removeTester, banActive } from './admins.js';

const DAY_MS = 86_400_000;
const WEEK = 7;
const KEEP_DAYS = 14;
const SHOWN = 60;
const UID_RE = /^[A-Za-z0-9]{1,128}$/;

/**
 * @param ctx  { S, scheduleRender, raw, ago, who, openSheet, closeSheet, askBan, askUnban, gate, cfg, moderation, rooms, health }
 */
export function createPeople(ctx) {
  const { S, raw, ago } = ctx;
  const P = {
    started: false, unsubs: [],
    seen: null, seenRefused: false, seenBusy: false,
    support: null, supportRefused: false,
    deletion: null, deletionRefused: false,
    query: '',
    person: new Map(),     // uid -> { sotd, ann, msgs, msgsBusy }
  };
  const sdk = () => S.sdk;
  const ref = (path) => sdk().ref(sdk().db, path);
  const root = () => sdk().ref(sdk().db);
  const now = () => Date.now() + (ctx.moderation.offset() || 0);
  const today = () => Number(dayKeyFromServerMs(now()));
  const days = (n) => Array.from({ length: n }, (_, i) => today() - i * DAY_MS);
  const sotdEvents = () => setOf(ctx.cfg('sotd', 'events')).filter(e => SOTD_EVENTS.includes(e));
  const evName = (e) => eventOf(e)?.short || e;
  const TS = () => sdk().serverTimestamp();

  /* ---------------- reading ---------------- */

  function start() {
    if (P.started || !S.sdk) return;
    P.started = true;
    const { onValue, query, orderByKey, limitToLast } = sdk();
    P.unsubs.push(
      onValue(query(ref('support'), orderByKey(), limitToLast(100)), (s) => {
        const list = [];
        s.forEach((c) => { list.push({ id: c.key, ...c.val() }); });
        P.support = list.reverse();
        P.supportRefused = false;
        ctx.scheduleRender();
      }, () => { P.supportRefused = true; P.support = []; ctx.scheduleRender(); }),
      onValue(ref('deletion'), (s) => { P.deletion = s.val() || {}; P.deletionRefused = false; ctx.scheduleRender(); },
        () => { P.deletionRefused = true; P.deletion = {}; ctx.scheduleRender(); }),
    );
    loadSeen();
  }

  function stop() {
    for (const off of P.unsubs.splice(0)) off();
    Object.assign(P, { started: false, seen: null, support: null, deletion: null, person: new Map() });
  }

  async function loadSeen(force = false) {
    if (P.seenBusy || (!force && P.seen)) return;
    P.seenBusy = true;
    try {
      P.seen = (await sdk().get(ref('seen'))).val() || {};
      P.seenRefused = false;
    } catch {
      P.seen = {};
      P.seenRefused = true;
    }
    P.seenBusy = false;
    ctx.scheduleRender();
  }

  /** Everybody the console knows by name: seen/, then today's boards and chats, bans, testers. */
  function directory() {
    const by = new Map();
    for (const [uid, s] of Object.entries(P.seen || {})) by.set(uid, { uid, name: s?.name || '', lastAt: s?.lastAt || 0, seen: true });
    const add = (uid, name) => { if (uid && !by.has(uid)) by.set(uid, { uid, name: name || '', lastAt: 0, seen: false }); };
    for (const p of ctx.moderation.people()) add(p.uid, p.name);
    for (const [uid, b] of Object.entries(S.bans || {})) add(uid, b?.name);
    for (const [uid, x] of Object.entries(S.testers || {})) add(uid, x?.name);
    return [...by.values()];
  }
  const nameOf = (uid) => P.seen?.[uid]?.name || directory().find(p => p.uid === uid)?.name || '';

  /* ---------------- one person ---------------- */

  function personData(uid) {
    if (!P.person.has(uid)) {
      const d = { sotd: null, ann: null, msgs: null, msgsBusy: false, mod: null };
      P.person.set(uid, d);
      // What admins have done about them (modLog/, indexed on uid; ADMIN.md §19).
      const { query, orderByChild, equalTo } = sdk();
      sdk().get(query(ref('modLog'), orderByChild('uid'), equalTo(uid))).then((s) => {
        const out = [];
        s.forEach((c) => { out.push({ id: c.key, ...c.val() }); });
        d.mod = out.sort((a, b) => (b.at || 0) - (a.at || 0));
        ctx.scheduleRender();
      }, () => { d.mod = false; ctx.scheduleRender(); });
      // Their Scramble of the Day results this week: one small read per day and event.
      Promise.all(days(WEEK).flatMap(day => sotdEvents().map(ev =>
        sdk().get(ref(`daily/${day}/${ev}/results/${uid}`)).then(s => (s.exists() ? { day, ev, row: s.val() } : null), () => null))))
        .then((list) => { d.sotd = list.filter(Boolean).sort((a, b) => b.day - a.day); ctx.scheduleRender(); });
      sdk().get(ref('annStats')).then((s) => {
        const out = [];
        for (const [id, vers] of Object.entries(s.val() || {})) for (const [v, uids] of Object.entries(vers || {})) if (uids?.[uid] != null) out.push({ id, v, state: uids[uid] });
        d.ann = out;
        ctx.scheduleRender();
      }, () => { d.ann = []; ctx.scheduleRender(); });
    }
    return P.person.get(uid);
  }

  /** Their messages this week: every event's day room (by the index on uid) and every race room's chat. */
  async function findMessages(uid) {
    const d = personData(uid);
    if (d.msgsBusy) return;
    d.msgsBusy = true;
    ctx.scheduleRender();
    const { get, query, orderByChild, equalTo } = sdk();
    const out = [];
    await Promise.all(days(WEEK).flatMap(day => sotdEvents().map(async (ev) => {
      try {
        const s = await get(query(ref(`daily/${day}/${ev}/chat/m`), orderByChild('uid'), equalTo(uid)));
        s.forEach((c) => { out.push({ path: `daily/${day}/${ev}/chat/m/${c.key}`, text: c.val()?.text || '', at: c.val()?.at || 0, where: `${evName(ev)} · ${t('Scramble of the Day')}` }); });
      } catch { /* a day the rules will not show */ }
    })));
    // Each room's chat read again now: the week's rooms are a copy from when History was opened, and a
    // message gone since would make the rules refuse a delete of everything at once.
    await Promise.all((ctx.rooms.roomsOf(uid) || []).map(async ([id]) => {
      try {
        const chat = (await get(ref(`rooms/${id}/chat`))).val() || {};
        for (const [mid, m] of Object.entries(chat)) {
          if (m?.uid === uid) out.push({ path: `rooms/${id}/chat/${mid}`, text: m.text || '', at: m.at || 0, where: t('Race {room}', { room: id }) });
        }
      } catch { /* a room gone since */ }
    }));
    d.msgs = out.sort((a, b) => b.at - a.at);
    d.msgsBusy = false;
    ctx.scheduleRender();
  }

  /** One update at the root; with `entry`, logged in the same update (ADMIN.md §19). */
  async function write(updates, done, entry = null) {
    try {
      if (entry) await logged(sdk(), updates, entry);
      else await sdk().update(root(), updates);
      ctx.closeSheet();
      if (done) toast(done, { kind: 'good' });
      return true;
    } catch (err) {
      console.warn('[admin] people write refused', err?.code || err);
      toast(t('The database refused that'), { kind: 'bad', hold: true });
      return false;
    }
  }

  function confirm(title, lines, label, run, danger = false) {
    ctx.openSheet(
      el('h2', { class: 'ac-h2', text: title }),
      ...lines.map(l => (typeof l === 'string' ? el('p', { class: 'ac-sub', text: l }) : l)),
      el('div', { class: 'ac-sheet-actions' },
        el('button', { class: 'ac-btn', text: 'Back', onclick: ctx.closeSheet }),
        el('button', { class: `ac-btn primary${danger ? ' danger' : ''}`, text: label, onclick: run })));
  }

  const block = (title, ...kids) => el('section', { class: 'ac-block' }, el('h2', { class: 'ac-h2', text: title }), ...kids);
  const loading = () => el('p', { class: 'ac-note ac-small', text: 'Loading…' });
  const none = (text) => el('p', { class: 'ac-note ac-small', text });
  const copy = (uid) => el('button', { class: 'ac-link ac-uid', text: uid, title: t('Copy'), onclick: () => navigator.clipboard?.writeText(uid).then(() => toast(t('Copied'))) });
  const timeText = (r) => ctx.rooms.timeText(r);

  function viewPerson(uid) {
    start();
    const d = personData(uid);
    const seen = P.seen?.[uid];
    const name = nameOf(uid) || t('Somebody');
    const ban = S.bans?.[uid];
    const tester = S.testers?.[uid];
    const banned = banActive(ban);

    const head = [
      el('a', { class: 'ac-back', href: '#people/lookup', text: t('‹ Lookup') }),
      el('div', { class: 'ac-person-head' },
        seen?.pfp ? el('img', { class: 'ac-face ac-face-big', src: seen.pfp, alt: '', referrerpolicy: 'no-referrer', width: 48, height: 48 }) : null,
        el('div', {},
          el('h1', { class: 'ac-h1', text: name }),
          copy(uid))),
      seen ? raw('p', { class: 'ac-sub' }, t('First seen {first} · last seen {last} · v{v} · {lang}', { first: ago(seen.firstAt), last: ago(seen.lastAt), v: seen.ver ?? '?', lang: seen.lang || '?' }))
        : el('p', { class: 'ac-sub', text: P.seenRefused ? 'The directory needs this version’s firebase.rules.json published.' : 'Not in the directory: not signed in since this version, or reports switched off on their device.' }),
      el('div', { class: 'ac-entry-actions ac-start' },
        banned ? el('button', { class: 'ac-btn small', text: t('Unban'), onclick: () => ctx.askUnban(uid, ban) })
          : el('button', { class: 'ac-btn small danger', text: t('Ban'), onclick: () => ctx.askBan({ uid, name: nameOf(uid) }) }),
        tester ? el('button', { class: 'ac-btn small', text: t('Not a tester'), onclick: () => removeTester(sdk(), uid).then(() => toast(t('Removed from testers')), () => toast(t('The database refused that'), { kind: 'bad' })) })
          : el('button', { class: 'ac-btn small', text: t('Make tester'), onclick: () => addTester(sdk(), { uid, name: nameOf(uid) }).then(() => toast(t('Added to testers'), { kind: 'good' }), () => toast(t('The database refused that'), { kind: 'bad' })) })),
    ];

    const status = block(t('Standing'),
      el('ul', { class: 'ac-facts-list' },
        el('li', { text: banned ? t('Banned {until}: {reason}', { until: ban.until ? t('until {when}', { when: new Date(ban.until).toLocaleString() }) : t('for good'), reason: ban.reason || '—' }) : t('Not banned') }),
        el('li', { text: tester ? t('Tester since {when}', { when: ago(tester.at) }) : t('Not a tester') }),
        el('li', { text: (() => { ctx.rooms.loadRelay(); const n = ctx.rooms.relayOf(uid); return n == null ? t('Relay logins today: …') : t('Relay logins today: {n}', { n }); })() })));

    // Reports: filed by them, and about things of theirs (a time or replay path carries the uid).
    const reports = ctx.moderation.reportsList() || [];
    const by = reports.filter(r => r.by === uid);
    const about = reports.filter(r => String(r.path || '').includes(`/${uid}`));
    const reportsBlock = block(t('Reports'),
      raw('p', { class: 'ac-sub' }, t('{by} filed by them · {about} about their times or replays', { by: by.length, about: about.length })),
      (() => {
        const q = ctx.moderation.reporterRecord?.(uid);
        return q ? raw('p', { class: 'ac-entry-meta' }, t('As a reporter: {a} of {n} acted on, {d} dismissed', { a: q.actioned, n: q.n, d: q.dismissed })) : null;
      })(),
      [...by, ...about].length ? el('ol', { class: 'ac-log ac-tight' }, ...[...by, ...about].slice(0, 20).map(r => el('li', { class: 'ac-entry' },
        el('div', { class: 'ac-entry-main' },
          raw('b', {}, r.by === uid ? t('Filed by them') : t('About them')),
          raw('span', { class: 'ac-reason' }, r.text || r.path),
          raw('span', { class: 'ac-entry-meta' }, ago(r.at)))))) : null,
      el('a', { class: 'ac-link', href: '#mod/reports', text: t('All reports ›') }));

    const sotd = block(t('Scramble of the Day, the last 7 days'),
      !d.sotd ? loading() : !d.sotd.length ? none(t('No results this week.'))
        : el('ol', { class: 'ac-log ac-tight' }, ...d.sotd.map(({ day, ev, row }) => {
          const isToday = day === today();
          return el('li', { class: 'ac-entry' },
            el('div', { class: 'ac-entry-main' },
              el('span', { class: 'ac-chat-head' }, raw('b', {}, evName(ev)), raw('span', { class: 'ac-time' }, timeText(row))),
              raw('span', { class: 'ac-entry-meta' }, [isToday ? t('today') : ago(day + DAY_MS / 2), row.backup ? t('backup') : null, row.suspect ? '⚑' : null, row.replay ? t('replay shared') : null].filter(Boolean).join(' · '))),
            isToday ? el('div', { class: 'ac-entry-actions' }, el('button', { class: 'ac-btn small', text: t('Remove time'), onclick: () => confirm(
              t('Remove {name}’s {event} time today?', { name, event: evName(ev) }),
              [t('They get the backup scramble as a final attempt (or, if this was the backup, that is their day). Its replay goes too.')],
              t('Remove time'), async () => {
                if (await ctx.moderation.takeDown('result', `daily/${day}/${ev}/results/${uid}`, row)) {
                  ctx.closeSheet();
                  P.person.delete(uid);
                  toast(t('Removed'), { kind: 'good' });
                }
              }) })) : null);
        })));

    const roomsList = ctx.rooms.roomsOf(uid);
    const races = block(t('Race rooms and 1v1s, the last 7 days'),
      !roomsList ? loading() : !roomsList.length ? none(t('No race rooms this week.'))
        : el('div', { class: 'ac-list' }, ...roomsList.slice(0, 20).map(([id, room]) => el('a', { class: 'ac-card', href: `#mod/room/${id}` },
          el('div', { class: 'ac-card-main' },
            raw('b', {}, room?.meta?.kind === 'duel' ? t('1v1 · {id}', { id }) : t('Room {id}', { id })),
            raw('span', { class: 'ac-card-sub' }, ago(room?.meta?.createdAt))),
          raw('span', { class: 'ac-chev', 'aria-hidden': 'true' }, '›')))));

    const msgs = block(t('Messages, the last 7 days'),
      !d.msgs ? el('button', { class: 'ac-btn small', text: d.msgsBusy ? t('Looking…') : t('Find their messages'), disabled: d.msgsBusy, onclick: () => findMessages(uid) })
        : !d.msgs.length ? none(t('No messages this week.'))
          : el('div', { class: 'ac-stack' },
            el('button', { class: 'ac-btn small danger', text: t('Delete all {n}…', { n: d.msgs.length }), onclick: () => confirm(
              t('Delete all {n} of {name}’s messages this week?', { n: d.msgs.length, name }),
              [t('Every one of them, in every day’s room and every race room, in one go.')],
              t('Delete all'), async () => {
                if (await write(Object.fromEntries(d.msgs.map(m => [m.path, null])), t('Deleted'),
                  { action: 'deleteMessages', path: `people/${uid}`, uid, note: t('{n} messages', { n: d.msgs.length }),
                    before: d.msgs.map(m => ({ path: m.path, text: m.text, at: m.at })) })) d.msgs = [];
              }, true) }),
            el('ol', { class: 'ac-log ac-tight' }, ...d.msgs.slice(0, SHOWN).map(m => el('li', { class: 'ac-entry' },
              el('div', { class: 'ac-entry-main' },
                raw('span', { class: 'ac-reason' }, m.text),
                raw('span', { class: 'ac-entry-meta' }, `${m.where} · ${ago(m.at)}`)))))));

    const beats = ctx.health.beatsOf(uid);
    const errors = ctx.health.errorsOf(uid);
    const last = beats?.[0]?.[1];
    const healthBlock = block(t('Health'),
      !beats ? loading() : !last ? none(t('No heartbeat in the last 14 days.'))
        : raw('p', { class: 'ac-sub' }, t('Last heartbeat {when}: v{v} · {ua} · {os} · {q} changes waiting{stuck}', {
          when: ago(last.at), v: last.ver, ua: last.ua || '?', os: last.os || '?', q: last.q || 0,
          stuck: (last.qOldestMin || 0) > 60 ? ` · ${t('stuck {n} min', { n: last.qOldestMin })}` : '' })),
      errors?.length ? el('ol', { class: 'ac-log ac-tight' }, ...errors.slice(0, 10).map(e => el('li', { class: 'ac-entry' },
        el('div', { class: 'ac-entry-main' }, raw('b', { class: 'ac-err-msg' }, e.msg || ''), raw('span', { class: 'ac-entry-meta' }, `${e.where || ''} · ${ago(e.day + DAY_MS / 2)}`))))) : null);

    const ann = block(t('Announcements'),
      !d.ann ? loading() : !d.ann.length ? none(t('None shown to them on a signed-in device.'))
        : el('div', { class: 'ac-chips' }, ...d.ann.map(a => raw('span', { class: 'ac-chip' }, `${a.id} v${a.v}: ${a.state}`))));

    const tickets = (P.support || []).filter(x => x.uid === uid);
    const sup = tickets.length ? block(t('Support requests'), el('div', { class: 'ac-list' }, ...tickets.map(x => el('a', { class: 'ac-card', href: '#people/support' },
      el('div', { class: 'ac-card-main' }, raw('b', {}, x.note || ''), raw('span', { class: 'ac-card-sub' }, ago(x.at))),
      el('span', { class: `ac-pill${x.reply ? '' : ' warn'}`, text: x.reply ? t('replied') : t('waiting') }))))) : null;

    const modBlock = block(t('Moderation'),
      d.mod === null ? loading() : d.mod === false ? none(t('The moderation log needs this version’s firebase.rules.json published.'))
        : !d.mod.length ? none(t('Nothing done about them.'))
          : el('ol', { class: 'ac-log ac-tight' }, ...d.mod.slice(0, 20).map(e => el('li', { class: 'ac-entry' },
            el('div', { class: 'ac-entry-main' },
              raw('b', {}, ctx.modLabel?.(e.action) || e.action),
              e.note ? raw('span', { class: 'ac-reason' }, e.note) : null,
              raw('span', { class: 'ac-entry-meta' }, `${ago(e.at)} · ${ctx.who(e.by)}`))))),
      el('a', { class: 'ac-link', href: '#log/mod', text: t('The moderation log ›') }));

    return [...head, status, sup, sotd, races, msgs, healthBlock, reportsBlock, modBlock, ann];
  }

  /* ---------------- lookup ---------------- */

  function viewLookup() {
    start();
    const input = el('input', { class: 'ac-inp', type: 'search', value: P.query, autocomplete: 'off', placeholder: t('A name, or the start of a uid'), 'aria-label': t('Find somebody') });
    // The results are repainted in place as somebody types: a full redraw waits for the box to lose
    // focus, and that would replace the very result being tapped.
    const results = el('div');
    const paint = () => results.replaceChildren(resultsList(P.query));
    input.addEventListener('input', () => { P.query = input.value; paint(); });
    paint();
    return [
      el('p', { class: 'ac-sub', text: P.seenRefused
        ? 'The directory needs this version’s firebase.rules.json published. Until then, these are the names on today’s boards and chats, bans and testers.'
        : t('{n} people in the directory: everybody signed in who has opened the timer since this version, with the name and picture they show on the boards.', { n: Object.keys(P.seen || {}).length }) }),
      el('div', { class: 'ac-text' }, input),
      results,
    ];
  }

  function resultsList(query) {
    const q = query.trim().toLowerCase();
    const all = directory();
    const hits = (q ? all.filter(p => p.name.toLowerCase().includes(q) || p.uid.toLowerCase().startsWith(q)) : all)
      .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0)).slice(0, SHOWN);
    return !P.seen ? loading() : !hits.length ? none(q ? t('Nobody by that.') : t('Nobody yet.'))
        : el('div', { class: 'ac-list' }, ...hits.map(p => el('a', { class: 'ac-card', href: `#people/u/${p.uid}` },
          el('div', { class: 'ac-card-main' },
            raw('b', {}, p.name || t('(no name)')),
            raw('span', { class: 'ac-card-sub ac-uid' }, p.uid)),
          el('div', { class: 'ac-card-side' },
            banActive(S.bans?.[p.uid]) ? el('span', { class: 'ac-pill warn', text: t('banned') }) : null,
            S.testers?.[p.uid] ? el('span', { class: 'ac-pill', text: t('tester') }) : null,
            p.lastAt ? raw('span', { class: 'ac-pill' }, ago(p.lastAt)) : null,
            raw('span', { class: 'ac-chev', 'aria-hidden': 'true' }, '›')))));
  }

  /* ---------------- support ---------------- */

  function viewSupport() {
    start();
    if (P.supportRefused) return [ctx.gate('Publish the rules first', 'Support requests need the firebase.rules.json from this version of the page.')];
    if (!P.support) return [loading()];
    if (!P.support.length) return [none(t('No support requests. People send them from Data Health in the timer.'))];
    return [el('ol', { class: 'ac-log' }, ...P.support.map((x) => {
      const reply = el('textarea', { class: 'ac-inp', rows: 3, maxlength: 1000, placeholder: t('Your reply: they see it in Data Health and their account menu') });
      const c = x.counts || {};
      const oldest = Object.values(x.queue || {}).reduce((m, q) => Math.max(m, q?.ageMin || 0), 0);
      return el('li', { class: `ac-entry ac-ticket${x.reply ? ' ac-ended' : ''}` },
        el('div', { class: 'ac-entry-main' },
          el('span', { class: 'ac-chat-head' },
            el('a', { class: 'ac-link', href: `#people/u/${x.uid}`, text: nameOf(x.uid) || x.uid }),
            raw('span', { class: 'ac-entry-meta' }, ago(x.at))),
          raw('span', { class: 'ac-reason' }, x.note || ''),
          raw('span', { class: 'ac-entry-meta' }, `v${x.ver ?? '?'} · ${x.ua || '?'} · ${x.os || '?'} · ${t('sync {cloud}, {n} waiting', { cloud: x.health?.cloud || '?', n: Object.keys(x.queue || {}).length })}${oldest ? ` · ${t('oldest {n} min', { n: oldest })}` : ''}`),
          raw('span', { class: 'ac-entry-meta' }, t('{solves} solves · {sessions} sessions · {sets} Competition sets ({gone} discarded)', { solves: c.solves ?? '?', sessions: c.sessions ?? '?', sets: c.competitionSets ?? '?', gone: c.discardedSets ?? '?' })),
          el('details', {}, el('summary', { text: t('Everything they sent') }), raw('pre', { class: 'ac-json' }, JSON.stringify({ queue: x.queue, competition: x.competition, health: x.health }, null, 2))),
          x.reply ? raw('p', { class: 'ac-reply' }, t('You replied {when}{seen}: {text}', { when: ago(x.reply.at), seen: x.replySeen ? ` (${t('read {when}', { when: ago(x.replySeen) })})` : '', text: x.reply.text })) : null),
        el('div', { class: 'ac-entry-actions ac-col' },
          x.reply ? null : reply,
          el('div', { class: 'ac-entry-actions' },
            x.reply ? null : el('button', { class: 'ac-btn small primary', text: t('Send reply'), onclick: () => {
              const text = reply.value.trim();
              if (!text) return;
              write({ [`support/${x.id}/reply`]: { text: text.slice(0, 1000), by: S.user.uid, at: TS() } }, t('Replied'));
            } }),
            el('button', { class: 'ac-btn small', text: t('Delete'), onclick: () => confirm(t('Delete this request?'), [], t('Delete'), () => write({ [`support/${x.id}`]: null }, t('Deleted'))) }))));
    }))];
  }

  /* ---------------- deletion requests ---------------- */

  async function carryOut(uid) {
    const updates = { [`users/${uid}`]: null, [`seen/${uid}`]: null };
    for (const d of days(KEEP_DAYS)) updates[`health/${d}/${uid}`] = null;
    for (const e of ctx.health.errorsOf(uid) || []) updates[e.path] = null;
    for (const x of P.support || []) if (x.uid === uid) updates[`support/${x.id}`] = null;
    await findMessages(uid);
    for (const m of personData(uid).msgs || []) updates[m.path] = null;
    updates[`deletion/${uid}/doneAt`] = TS();
    updates[`deletion/${uid}/doneBy`] = S.user.uid;
    return write(updates, t('Deleted'), { action: 'deleteAccount', path: `users/${uid}`, uid, note: t('Their deletion request') });
  }

  function viewRequests() {
    start();
    if (P.deletionRefused) return [ctx.gate('Publish the rules first', 'Deletion requests need the firebase.rules.json from this version of the page.')];
    if (!P.deletion) return [loading()];
    const list = Object.entries(P.deletion).sort((a, b) => (b[1]?.at || 0) - (a[1]?.at || 0));
    return [
      el('p', { class: 'ac-sub', text: 'People ask from Data Health in the timer, which signs that device out so it keeps its own copy. Delete now removes their synced solves, sessions and settings (users/), their directory entry, 14 days of health reports and error entries, their support requests, and their messages from the last week. Board results stay: they are the day’s public record.' }),
      list.length ? el('ol', { class: 'ac-log' }, ...list.map(([uid, r]) => el('li', { class: `ac-entry${r.doneAt ? ' ac-ended' : ''}` },
        el('div', { class: 'ac-entry-main' },
          el('a', { class: 'ac-link', href: `#people/u/${uid}`, text: r.name || nameOf(uid) || uid }),
          raw('span', { class: 'ac-uid' }, uid),
          raw('span', { class: 'ac-entry-meta' }, r.doneAt ? t('asked {asked} · done {done} by {who}', { asked: ago(r.at), done: ago(r.doneAt), who: ctx.who(r.doneBy) }) : t('asked {asked}', { asked: ago(r.at) }))),
        r.doneAt ? null : el('div', { class: 'ac-entry-actions' }, el('button', { class: 'ac-btn small danger', text: t('Delete now…'), onclick: () => confirm(
          t('Delete everything of {name}’s?', { name: r.name || uid }),
          [t('Their synced data goes for good, here and on any device still signed in to the account when it next syncs. This cannot be undone.')],
          t('Delete now'), () => carryOut(uid), true) })))))
        : none(t('No requests.')),
    ];
  }

  /** The counts for the People tab's sub-tabs. */
  function counts() {
    return {
      support: (P.support || []).filter(x => !x.reply).length,
      requests: Object.values(P.deletion || {}).filter(r => !r?.doneAt).length,
    };
  }

  return { start, stop, viewLookup, viewPerson, viewSupport, viewRequests, counts, nameOf };
}
