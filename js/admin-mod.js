import { t } from './i18n.js';
/* ===========================================================
   Tagda Timer — the admin console's Moderate tab (js/admin.js)

   Four views over the same few listeners, all on the admin page's one
   connection, started the first time the tab is opened:

     Reports   reports/, grouped by the item reported, with Dismiss, Delete, Ban;
               Open or Closed (dismissed or acted on, kept 30 days, Reopen)
     SOTD      times held under their floor, re-timing, the featured replay,
               past days (js/admin-sotd.js)
     Chats     today's room for every Scramble of the Day event, and every race
               room made in the last day, newest message first
     Suspect   today's Scramble of the Day times and race times flagged ⚑
     Replays   today's shared replays, with Watch and Remove

   An admin reads all of it without having solved anything (the rules, since
   this tab). What each button writes is in ADMIN.md §6, and each goes in the
   moderation log (§19) in the same update; the rules have the final say on
   all of it.
   =========================================================== */

import { el, fmt } from './util.js';
import { toast } from './toast.js';
import { EVENT_ORDER, eventOf, dailyEligible } from './events.js';
import { dayKeyFromServerMs } from './dayid.js';
import { removalUpdate, logged } from './moderation.js';

const DAY_MS = 86_400_000;
const CHAT_SHOWN = 25;       // newest messages kept live per room
const MERGED_SHOWN = 120;    // the Chats view, all rooms together
const ROOM_WINDOW_MS = DAY_MS;
const REPORTS_SHOWN = 500;            // the newest reports, open and closed, kept live
const CLOSED_KEPT_MS = 30 * DAY_MS;   // a closed report is swept after this

/**
 * @param ctx  { S, scheduleRender, raw, ago, who, openSheet, closeSheet, askBan, gate }
 *             from admin.js: its state (S.sdk, S.user) and its helpers.
 */
export function createModeration(ctx) {
  const { S, raw, ago, who } = ctx;
  const M = {
    started: false,
    offset: 0,
    dayKey: null,
    reports: [], reportsLoaded: false,
    sotdChat: {},          // event -> [{ id, ...msg }]
    results: {},           // event -> { uid: row }
    rooms: {}, roomsLoaded: false, roomsAt: 0,
    roomChat: {},          // room id -> [{ id, ...msg }]
    items: new Map(),      // path -> the reported item, read once
    dayUnsubs: [], roomUnsubs: new Map(), unsubs: [],
  };
  const events = () => EVENT_ORDER.filter(dailyEligible);
  const evName = (e) => eventOf(e).short || e;
  const sdk = () => S.sdk;
  const ref = (path) => sdk().ref(sdk().db, path);

  /* ---------------- listening ---------------- */

  function start() {
    if (M.started || !S.sdk) return;
    M.started = true;
    const { onValue, query, orderByKey, limitToLast } = sdk();
    M.unsubs.push(
      onValue(ref('.info/serverTimeOffset'), (s) => {
        M.offset = s.val() || 0;
        watchDay();
      }, () => {}),
      onValue(query(ref('reports'), orderByKey(), limitToLast(REPORTS_SHOWN)), (s) => {
        const list = [];
        s.forEach((c) => { list.push({ id: c.key, ...c.val() }); });
        M.reports = list.reverse();
        if (!M.reportsLoaded) sweepClosed();
        M.reportsLoaded = true;
        ctx.scheduleRender();
      }, (err) => { console.warn('[admin] reports refused', err?.code || err); M.reportsRefused = true; M.reportsLoaded = true; ctx.scheduleRender(); }),
    );
    refreshRooms();
    // The day turns over at 00:00 IST: the views follow it.
    M.tick = setInterval(watchDay, 60_000);
  }

  function stop() {
    for (const off of M.unsubs.splice(0)) off();
    for (const off of M.dayUnsubs.splice(0)) off();
    for (const off of M.roomUnsubs.values()) off();
    M.roomUnsubs.clear();
    clearInterval(M.tick);
    Object.assign(M, { started: false, dayKey: null, reports: [], reportsLoaded: false, sotdChat: {}, results: {},
      rooms: {}, roomsLoaded: false, roomChat: {}, items: new Map() });
  }

  /** Point the per-event listeners at today (by the server's clock). */
  function watchDay() {
    const key = dayKeyFromServerMs(Date.now() + M.offset);
    if (key === M.dayKey) return;
    for (const off of M.dayUnsubs.splice(0)) off();
    M.dayKey = key;
    M.sotdChat = {};
    M.results = {};
    const { onValue, query, limitToLast } = sdk();
    for (const e of events()) {
      const base = `daily/${key}/${e}`;
      M.dayUnsubs.push(
        onValue(ref(`${base}/results`), (s) => { M.results[e] = s.val() || {}; ctx.scheduleRender(); }, () => {}),
        onValue(query(ref(`${base}/chat/m`), limitToLast(CHAT_SHOWN)), (s) => {
          const list = [];
          s.forEach((c) => { list.push({ id: c.key, ...c.val() }); });
          M.sotdChat[e] = list;
          ctx.scheduleRender();
        }, () => {}),
      );
    }
    ctx.scheduleRender();
  }

  /**
   * The race rooms made in the last day, read once (rooms are many, and
   * never cleared out), by meta/createdAt, which the rules index. Rooms with
   * somebody still in them get their chat watched live.
   */
  async function refreshRooms() {
    const { get, query, orderByChild, startAt, onValue, limitToLast } = sdk();
    try {
      const snap = await get(query(ref('rooms'), orderByChild('meta/createdAt'), startAt(Date.now() + M.offset - ROOM_WINDOW_MS)));
      M.rooms = snap.val() || {};
      M.roomsRefused = false;
    } catch (err) {
      console.warn('[admin] rooms refused', err?.code || err);
      M.rooms = {};
      M.roomsRefused = true;
    }
    M.roomsLoaded = true;
    M.roomsAt = Date.now();
    for (const [id, room] of Object.entries(M.rooms)) {
      if (M.roomUnsubs.has(id) || !room?.players) continue;
      M.roomUnsubs.set(id, onValue(query(ref(`rooms/${id}/chat`), limitToLast(CHAT_SHOWN)), (s) => {
        const list = [];
        s.forEach((c) => { list.push({ id: c.key, ...c.val() }); });
        M.roomChat[id] = list;
        ctx.scheduleRender();
      }, () => {}));
    }
    ctx.scheduleRender();
  }

  /** A reported item, read once and kept (it may be gone: null). */
  function item(path) {
    if (M.items.has(path)) return M.items.get(path);
    M.items.set(path, undefined);
    sdk().get(ref(path)).then((s) => { M.items.set(path, s.val()); ctx.scheduleRender(); },
      () => { M.items.set(path, null); ctx.scheduleRender(); });
    return undefined;
  }

  /* ---------------- what each thing is ---------------- */

  const timeText = (r) => {
    if (!r) return '';
    if (r.penalty === 'DNF') return 'DNF';
    const plus = r.penalty === '+2';
    return fmt((r.timeMs || 0) + (plus ? 2000 : 0)) + (plus ? '+' : '');
  };

  /** { kind, path, where, author: { uid, name }, text } for a reported path. */
  function describe(kind, path) {
    const seg = String(path).split('/');
    if (kind === 'raceChat') {
      const m = item(path);
      return { where: t('Race chat · {room}', { room: seg[1] }), author: m ? { uid: m.uid, name: m.name } : null, text: m?.text, gone: m === null };
    }
    if (kind === 'chat') {
      const m = item(path);
      return { where: t('Chat · {event}', { event: evName(seg[2]) }), author: m ? { uid: m.uid, name: m.name } : null, text: m?.text, gone: m === null };
    }
    const row = item(path);
    const where = kind === 'replay' ? t('Shared replay · {event}', { event: evName(seg[2]) }) : t('Time · {event}', { event: evName(seg[2]) });
    return { where, author: { uid: seg[4], name: row?.name }, text: row ? timeText(row) : '', gone: row === null || (kind === 'replay' && row && row.replay !== true), row };
  }

  /* ---------------- taking things down ---------------- */

  async function worker(method, path) {
    const token = await S.user.getIdToken();
    return fetch(path, { method, headers: { Authorization: `Bearer ${token}` } });
  }

  /** Take a reported or listed thing down, logged (ADMIN.md §19). Resolves whether it went. */
  async function takeDown(kind, path, row = null) {
    const S2 = sdk();
    const seg = String(path).split('/');
    try {
      if (kind === 'chat' || kind === 'raceChat') {
        const m = row || M.items.get(path) || null;
        await logged(S2, { [path]: null }, { action: 'deleteMessage', path, uid: m?.uid || '',
          before: m ? { uid: m.uid || '', name: m.name || '', text: m.text || '', at: m.at || 0 } : null });
      } else if (kind === 'replay') {
        const r = await worker('DELETE', `/replay/${seg[1]}/${seg[2]}/${seg[4]}`);
        if (!r.ok) throw new Error(`worker ${r.status}`);
        await logged(S2, { [`${path}/replay`]: null }, { action: 'removeReplay', path, uid: seg[4] });
      } else if (kind === 'result') {
        const cur = row || (await S2.get(ref(path))).val();
        const base = `daily/${seg[1]}/${seg[2]}`;
        const up = Object.fromEntries(Object.entries(removalUpdate(seg[4], cur?.backup === true, S2.serverTimestamp())).map(([k, v]) => [`${base}/${k}`, v]));
        await logged(S2, up, { action: 'removeTime', path, uid: seg[4], before: cur || null });
        // Its clip goes too: nobody can reach it without the row, and deletes are free.
        if (cur?.replay === true) worker('DELETE', `/replay/${seg[1]}/${seg[2]}/${seg[4]}`).catch(() => {});
      } else if (kind === 'raceResult') {
        await logged(S2, { [path]: null }, { action: 'removeRaceTime', path, uid: seg[5] || '', before: row || null });
      }
      return true;
    } catch (err) {
      console.warn('[admin] take down refused', err?.code || err);
      toast(t('The database refused that'), { kind: 'bad', hold: true });
      return false;
    }
  }

  /**
   * Every open report about `path` is closed: 'dismissed' (nothing wrong) or
   * 'actioned' (taken down), with who and when (reports/<id>/status, ADMIN.md
   * §6), and logged. Closed reports stay 30 days for Reopen and for each
   * reporter's record. On rules from before triage they are deleted, as they
   * always were.
   */
  async function resolve(path, s = 'dismissed') {
    const ids = M.reports.filter(r => r.path === path && !r.status).map(r => r.id);
    if (!ids.length) return;
    const st = { s, by: S.user.uid, at: sdk().serverTimestamp() };
    try {
      await logged(sdk(), Object.fromEntries(ids.map(id => [`reports/${id}/status`, st])),
        { action: s === 'actioned' ? 'actioned' : 'dismiss', path, note: ids.length > 1 ? t('{n} reports', { n: ids.length }) : '' });
    } catch {
      await sdk().update(sdk().ref(sdk().db), Object.fromEntries(ids.map(id => [`reports/${id}`, null]))).catch((err) => {
        console.warn('[admin] dismiss refused', err?.code || err);
        toast(t('The database refused that'), { kind: 'bad', hold: true });
      });
    }
  }

  /** Open the closed reports about `path` again. */
  async function reopen(path) {
    const ids = M.reports.filter(r => r.path === path && r.status).map(r => r.id);
    if (!ids.length) return;
    try {
      await logged(sdk(), Object.fromEntries(ids.map(id => [`reports/${id}/status`, null])), { action: 'reopenReport', path });
      toast(t('Reopened'));
    } catch (err) {
      console.warn('[admin] reopen refused', err?.code || err);
      toast(t('The database refused that'), { kind: 'bad', hold: true });
    }
  }

  /** Closed reports older than 30 days go, once a session: housekeeping, not logged. */
  function sweepClosed() {
    const cut = Date.now() + M.offset - CLOSED_KEPT_MS;
    const old = M.reports.filter(r => r.status?.at && r.status.at < cut).map(r => r.id);
    if (old.length) sdk().update(sdk().ref(sdk().db), Object.fromEntries(old.map(id => [`reports/${id}`, null]))).catch(() => {});
  }

  /** Per reporter: how many of their reports were acted on, dismissed, or are still open. */
  function reporters() {
    const by = new Map();
    for (const r of M.reports) {
      if (!r.by) continue;
      const q = by.get(r.by) || { n: 0, actioned: 0, dismissed: 0 };
      q.n++;
      if (r.status?.s === 'actioned') q.actioned++;
      else if (r.status?.s === 'dismissed') q.dismissed++;
      by.set(r.by, q);
    }
    return by;
  }

  const deleteLabel = (kind) => ({
    chat: t('Delete message'), raceChat: t('Delete message'), replay: t('Remove replay'),
    result: t('Remove time'), raceResult: t('Remove time'),
  })[kind];

  /** Confirm, take down, and (`ban`) ban the author too; resolves the reports about it either way. */
  function askDelete({ kind, path, row, author, where, text, reason }) {
    const go = (andBan) => async () => {
      if (!(await takeDown(kind, path, row))) return;
      await resolve(path, 'actioned');
      ctx.closeSheet();
      toast(t('Done. Taken down.'), { kind: 'good' });
      if (andBan && author?.uid) ctx.askBan({ uid: author.uid, name: author.name || '', reason });
    };
    ctx.openSheet(
      el('h2', { class: 'ac-h2', text: deleteLabel(kind) + '?' }),
      el('ul', { class: 'ac-diffs' }, el('li', { class: 'ac-diff' },
        raw('b', {}, where),
        text ? raw('span', { class: 'ac-reason' }, text) : null,
        author ? raw('span', { class: 'ac-entry-meta' }, `${author.name || 'Cuber'} · ${author.uid || ''}`) : null)),
      kind === 'result' ? el('p', { class: 'ac-sub', text: 'Today, they get the backup scramble as a final attempt (or, if this was the backup, that is their day). Its replay goes too.' }) : null,
      kind === 'raceResult' ? el('p', { class: 'ac-sub', text: 'The time leaves that round’s board. They could submit for the round again; race rooms are not a competition.' }) : null,
      el('div', { class: 'ac-sheet-actions ac-wrap' },
        el('button', { class: 'ac-btn', text: 'Back', onclick: ctx.closeSheet }),
        author?.uid ? el('button', { class: 'ac-btn', text: t('…and ban'), onclick: go(true) }) : null,
        el('button', { class: 'ac-btn primary', text: deleteLabel(kind), onclick: go(false) })));
  }

  /* ---------------- views ---------------- */

  const SUBS = () => [['reports', t('Reports')], ['sotd', t('SOTD')], ['chats', t('Chats')], ['suspect', t('Suspect')], ['replays', t('Replays')], ['rooms', t('Rooms')]];

  /** Report groups: one per item, newest report first. The open ones, or (`closed`) the closed ones. */
  function groups(closed = false) {
    const by = new Map();
    for (const r of M.reports) {
      if (!!r.status !== closed) continue;
      if (!by.has(r.path)) by.set(r.path, { kind: r.kind, path: r.path, reports: [] });
      by.get(r.path).reports.push(r);
    }
    return [...by.values()];
  }

  function suspects() {
    const out = [];
    for (const [e, rows] of Object.entries(M.results)) {
      for (const [uid, r] of Object.entries(rows || {})) {
        if (r?.suspect) out.push({ kind: 'result', path: `daily/${M.dayKey}/${e}/results/${uid}`, row: r, uid, name: r.name, where: evName(e), at: r.submittedAt || 0 });
      }
    }
    for (const [id, room] of Object.entries(M.rooms)) {
      for (const [n, round] of Object.entries(room?.rounds || {})) {
        for (const [uid, r] of Object.entries(round?.results || {})) {
          // Struck from the room's inspector already: dealt with.
          if (!r?.suspect || room.mod?.struck?.[n]?.[uid]) continue;
          out.push({ kind: 'raceResult', path: `rooms/${id}/rounds/${n}/results/${uid}`, row: r, uid,
            name: room.players?.[uid]?.name || t('a racer'), where: t('Race {room} · round {n}', { room: id, n }), at: r.submittedAt || 0 });
        }
      }
    }
    return out.sort((a, b) => b.at - a.at);
  }

  function replays() {
    const out = [];
    for (const [e, rows] of Object.entries(M.results)) {
      for (const [uid, r] of Object.entries(rows || {})) {
        if (r?.replay === true) out.push({ e, uid, row: r, at: r.submittedAt || 0 });
      }
    }
    return out.sort((a, b) => b.at - a.at);
  }

  function messages() {
    const out = [];
    for (const [e, list] of Object.entries(M.sotdChat)) {
      for (const m of list) out.push({ kind: 'chat', path: `daily/${M.dayKey}/${e}/chat/m/${m.id}`, m, where: evName(e) });
    }
    for (const [id, list] of Object.entries(M.roomChat)) {
      for (const m of list) out.push({ kind: 'raceChat', path: `rooms/${id}/chat/${m.id}`, m, where: t('Race {room}', { room: id }) });
    }
    return out.sort((a, b) => (b.m.at || 0) - (a.m.at || 0)).slice(0, MERGED_SHOWN);
  }

  /** Counts for the tab bar and the sub-tabs. */
  function counts() {
    return { reports: groups().length, sotd: ctx.sotd().count(), suspect: suspects().length, replays: replays().length };
  }

  function view(sub, id = null) {
    start();
    const c = counts();
    // Rooms, a room and the week's history are one sub-tab (js/admin-rooms.js).
    const on = ['room', 'history'].includes(sub) ? 'rooms' : sub;
    const nav = el('nav', { class: 'ac-subtabs', 'aria-label': t('Moderation') },
      ...SUBS().map(([key, label]) => raw('a', {
        class: `ac-subtab${on === key ? ' on' : ''}`, href: `#mod/${key}`, 'aria-current': on === key ? 'page' : null,
      }, c[key] ? `${label} · ${c[key]}` : label)));
    const head = [el('h1', { class: 'ac-h1', text: 'Moderate' }), nav];
    // Six across a phone run off its edge: the one you are on is kept in view.
    requestAnimationFrame(() => {
      const cur = nav.querySelector('.ac-subtab.on');
      const over = cur && nav.isConnected ? cur.getBoundingClientRect().right - nav.getBoundingClientRect().right : 0;
      if (over > 0) nav.scrollLeft += over + 12;
    });
    if (sub === 'rooms') return [...head, ...ctx.rooms().viewRooms()];
    if (sub === 'history') return [...head, ...ctx.rooms().viewHistory()];
    if (sub === 'room' && id) return [...head, ...ctx.rooms().viewRoom(id)];
    if (sub === 'sotd') return [...head, ...ctx.sotd().view()];
    if (sub === 'chats') return [...head, viewChats()];
    if (sub === 'suspect') return [...head, viewSuspect()];
    if (sub === 'replays') return [...head, viewReplays()];
    return [...head, viewReports()];
  }

  const actions = (...btns) => el('div', { class: 'ac-entry-actions' }, ...btns);
  const small = (text, onclick, cls = '') => el('button', { class: `ac-btn small ${cls}`, text, onclick });

  /** Who reported it, each with their record: "3 of 5 acted on, 1 dismissed". */
  function reportedBy(g, rec) {
    const ids = [...new Set(g.reports.map(r => r.by).filter(Boolean))];
    return ids.slice(0, 3).map((uid) => {
      const q = rec.get(uid) || { n: 0, actioned: 0, dismissed: 0 };
      return el('span', { class: 'ac-reporter' },
        el('a', { class: 'ac-link', href: `#people/u/${uid}`, text: ctx.nameOf?.(uid) || uid.slice(0, 8) }),
        raw('span', { class: 'ac-entry-meta' }, ' ' + t('{a} of {n} acted on, {d} dismissed', { a: q.actioned, n: q.n, d: q.dismissed })),
        // Somebody whose reports keep being dismissed: ban them from reporting, and nothing else (ADMIN.md §5).
        q.dismissed >= 3 && !q.actioned ? el('button', { class: 'ac-btn small', text: t('Stop their reports…'),
          onclick: () => ctx.askBan({ uid, name: ctx.nameOf?.(uid) || '', reason: t('Reports that keep being dismissed'), scope: ['reports'] }) }) : null);
    });
  }

  function viewReports() {
    if (M.reportsRefused) return ctx.gate('Publish the rules first', 'Reports need the firebase.rules.json from this version of the page.');
    if (!M.reportsLoaded) return el('p', { class: 'ac-note', text: 'Loading…' });
    const closed = M.reportsClosed === true;
    const gs = groups(closed);
    const rec = reporters();
    const pick = el('div', { class: 'ac-chips' },
      el('button', { class: `ac-chip${closed ? '' : ' on'}`, type: 'button', onclick: () => { M.reportsClosed = false; ctx.scheduleRender(); } },
        raw('span', {}, t('Open · {n}', { n: groups(false).length }))),
      el('button', { class: `ac-chip${closed ? ' on' : ''}`, type: 'button', onclick: () => { M.reportsClosed = true; ctx.scheduleRender(); } },
        raw('span', {}, t('Closed · {n}', { n: groups(true).length }))));
    if (!gs.length) {
      return el('div', {}, pick, el('p', { class: 'ac-note', text: closed
        ? 'Nothing closed in the last 30 days.'
        : 'No open reports. People report a chat message or a shared replay from the ⚑ beside it.' }));
    }
    return el('div', {}, pick, el('ol', { class: 'ac-log' }, ...gs.map((g) => {
      const d = describe(g.kind, g.path);
      const newest = g.reports[0];
      const reason = g.kind === 'chat' || g.kind === 'raceChat'
        ? `${d.where}: "${String(d.text || newest.text || '').slice(0, 120)}"` : `${d.where} ${d.text || ''}`.trim();
      const st = newest.status;
      const how = !st ? '' : ' · ' + (st.s === 'actioned'
        ? t('acted on {when} by {who}', { when: ago(st.at), who: who(st.by) })
        : t('dismissed {when} by {who}', { when: ago(st.at), who: who(st.by) }));
      return el('li', { class: `ac-entry ac-report${d.gone || closed ? ' ac-ended' : ''}` },
        el('div', { class: 'ac-entry-main' },
          raw('b', {}, d.where),
          raw('span', { class: 'ac-reason' }, d.gone ? t('(already gone) {text}', { text: newest.text || '' }) : (d.text || newest.text || '…')),
          d.author ? raw('span', { class: 'ac-uid' }, `${d.author.name || 'Cuber'} · ${d.author.uid || ''}`) : null,
          raw('span', { class: 'ac-entry-meta', title: newest.at ? new Date(newest.at).toLocaleString() : '' },
            (g.reports.length > 1 ? t('{n} reports', { n: g.reports.length }) : t('1 report')) + ' · ' + t('latest {when}', { when: ago(newest.at) }) + how),
          el('div', { class: 'ac-reporters' }, ...reportedBy(g, rec))),
        closed ? actions(small(t('Reopen'), () => reopen(g.path))) : actions(
          small(t('Dismiss'), () => resolve(g.path).then(() => toast(t('Dismissed')))),
          d.gone ? null : small(deleteLabel(g.kind), () => askDelete({ kind: g.kind, path: g.path, row: d.row, author: d.author, where: d.where, text: d.text, reason })),
          d.author?.uid ? small(t('Ban'), () => ctx.askBan({ uid: d.author.uid, name: d.author.name || '', reason, then: () => resolve(g.path, 'actioned') }), 'danger') : null));
    })));
  }

  function viewChats() {
    const list = messages();
    const foot = el('p', { class: 'ac-note ac-small' },
      raw('span', {}, t('Today’s Scramble of the Day rooms, and race rooms made in the last day ({n} open).', { n: Object.keys(M.roomChat).length })),
      ' ',
      el('button', { class: 'ac-link', text: 'Look again for race rooms', onclick: () => refreshRooms() }));
    if (M.roomsRefused) foot.append(raw('span', { class: 'ac-err' }, ' ' + t('Race rooms need the newer rules published.')));
    if (!list.length) return el('div', {}, el('p', { class: 'ac-note', text: M.dayKey ? 'Nothing said today yet.' : 'Loading…' }), foot);
    return el('div', {}, el('ol', { class: 'ac-log' }, ...list.map(({ kind, path, m, where }) => {
      const author = { uid: m.uid, name: m.name };
      const reason = `${kind === 'raceChat' ? 'Race chat' : 'Chat'} message (${where}): "${String(m.text || '').slice(0, 120)}"`;
      return el('li', { class: 'ac-entry' },
        el('div', { class: 'ac-entry-main' },
          el('span', { class: 'ac-chat-head' }, raw('b', {}, m.name || 'Cuber'), raw('span', { class: 'ac-pill' }, where)),
          raw('span', { class: 'ac-reason' }, m.text || ''),
          raw('span', { class: 'ac-entry-meta', title: m.at ? new Date(m.at).toLocaleString() : '' }, `${ago(m.at)} · ${m.uid || ''}`)),
        actions(
          small(t('Delete'), () => askDelete({ kind, path, row: m, author, where, text: m.text, reason })),
          small(t('Ban'), () => ctx.askBan({ uid: m.uid, name: m.name || '', reason }), 'danger')));
    })), foot);
  }

  function viewSuspect() {
    const list = suspects();
    const note = el('p', { class: 'ac-note ac-small', text: 'Times flagged ⚑ when they were sent: far under that person’s own average. A personal best looks exactly like this, so look before you remove. Race rooms from the last day.' });
    if (!list.length) return el('div', {}, el('p', { class: 'ac-note', text: M.dayKey ? 'Nothing flagged today.' : 'Loading…' }), note);
    return el('div', {}, el('ol', { class: 'ac-log' }, ...list.map((x) => {
      const reason = `${x.kind === 'raceResult' ? 'Race' : 'Scramble of the Day'} time ${timeText(x.row)} (${x.where})`;
      const author = { uid: x.uid, name: x.name };
      return el('li', { class: 'ac-entry' },
        el('div', { class: 'ac-entry-main' },
          el('span', { class: 'ac-chat-head' }, raw('b', {}, x.name || 'Cuber'), raw('span', { class: 'ac-pill' }, x.where)),
          raw('span', { class: 'ac-time' }, timeText(x.row) + (x.row.backup ? ` · ${t('backup')}` : '')),
          raw('span', { class: 'ac-entry-meta' }, `${ago(x.at)} · ${x.uid}`)),
        actions(
          small(t('Remove time'), () => askDelete({ kind: x.kind, path: x.path, row: x.row, author, where: x.where, text: timeText(x.row), reason })),
          small(t('Ban'), () => ctx.askBan({ uid: x.uid, name: x.name || '', reason }), 'danger')));
    })), note);
  }

  function viewReplays() {
    const list = replays();
    if (!list.length) return el('p', { class: 'ac-note', text: M.dayKey ? 'No replays shared today yet.' : 'Loading…' });
    return el('ol', { class: 'ac-log' }, ...list.map(({ e, uid, row }) => {
      const path = `daily/${M.dayKey}/${e}/results/${uid}`;
      const where = evName(e);
      const author = { uid, name: row.name };
      const reason = `Shared replay (${where})`;
      return el('li', { class: 'ac-entry' },
        el('div', { class: 'ac-entry-main' },
          el('span', { class: 'ac-chat-head' }, raw('b', {}, row.name || 'Cuber'), raw('span', { class: 'ac-pill' }, where)),
          raw('span', { class: 'ac-time' }, timeText(row)),
          raw('span', { class: 'ac-entry-meta' }, `${ago(row.submittedAt)} · ${uid}`)),
        actions(
          small(t('Watch'), () => watch(e, uid, row)),
          small(t('Remove'), () => askDelete({ kind: 'replay', path, row, author, where, text: timeText(row), reason })),
          small(t('Ban'), () => ctx.askBan({ uid, name: row.name || '', reason }), 'danger')));
    }));
  }

  /** A shared clip, fetched through the Worker like anybody's, in a plain player. */
  async function watch(e, uid, row) {
    const box = el('div', { class: 'ac-video' }, el('p', { class: 'ac-note', text: 'Loading…' }));
    ctx.openSheet(
      el('h2', { class: 'ac-h2', text: t('{name} · {event} · {time}', { name: row.name || 'Cuber', event: evName(e), time: timeText(row) }) }),
      box,
      el('div', { class: 'ac-sheet-actions' }, el('button', { class: 'ac-btn', text: 'Close', onclick: ctx.closeSheet })));
    try {
      const r = await worker('GET', `/replay/${M.dayKey}/${e}/${uid}`);
      if (!r.ok) throw new Error(String(r.status));
      const url = URL.createObjectURL(await r.blob());
      const v = el('video', { controls: true, playsinline: true, src: url });
      v.addEventListener('emptied', () => URL.revokeObjectURL(url), { once: true });
      box.replaceChildren(v);
    } catch (err) {
      box.replaceChildren(el('p', { class: 'ac-err', text: t('Couldn’t load the replay ({why})', { why: err?.message || err }) }));
    }
  }

  /** What the Today tab counts from (js/admin-live.js): these listeners' copy, never a read of its own. */
  function snapshot() {
    return { dayKey: M.dayKey, results: M.results, rooms: M.rooms, roomsLoaded: M.roomsLoaded, roomsRefused: !!M.roomsRefused, reports: groups().length, reportsRefused: !!M.reportsRefused };
  }

  /** Everybody on today's boards and in today's rooms, for the People tab's tester picker: [{ uid, name }]. */
  function people() {
    const by = new Map();
    for (const rows of Object.values(M.results)) for (const [uid, r] of Object.entries(rows || {})) if (!by.has(uid)) by.set(uid, r?.name || '');
    for (const list of Object.values(M.sotdChat)) for (const m of list) if (m?.uid && !by.has(m.uid)) by.set(m.uid, m.name || '');
    return [...by].map(([uid, name]) => ({ uid, name }));
  }

  /** Every open report, newest first (the person page filters it). */
  const reportsList = () => M.reports;

  /** One reporter's record, for the person page: { n, actioned, dismissed } or null. */
  const reporterRecord = (uid) => reporters().get(uid) || null;

  return { view, start, stop, counts, snapshot, people, refreshRooms, reportsList, reporterRecord, takeDown, resolve, offset: () => M.offset };
}
