import { t } from './i18n.js';
/* ===========================================================
   Tagda Timer — the admin console's race rooms and random 1v1 (js/admin.js)

     Moderate › Rooms    the race rooms made in the last day (the Moderate
                         tab's read), each opening into the room inspector
     Moderate › History  the last seven days of rooms, read once on asking,
                         narrowed to one person by uid or name
     The inspector       a room live: its players and their heartbeats, every
                         round's times with when each came in and when its
                         penalty changed, flags, its chat; and the room
                         actions (close, remove a player, strike a time,
                         delete the room)
     1v1 lobby           the one waiting seat everybody queues through
                         (rooms/_1v1_333/meta/waiting), with Clear seat, and
                         the day's 1v1s; on Today and on Rooms
     1v1 relay           TURN credentials handed out today (turnDay/), on Today

   What each action writes is in ADMIN.md, "Race rooms and 1v1": the room's
   marks live in rooms/<id>/mod, which only an admin may write and which every
   racer in the room listens to. The rules refuse a closed room's writes and a
   removed player's, and race.js leaves when it sees either.
   =========================================================== */

import { el, fmt } from './util.js';
import { toast } from './toast.js';
import { dayKeyFromServerMs } from './dayid.js';
import { eventOf } from './events.js';
import { MATCH_LOBBY, FIREBASE_CONFIG } from './raceapp.js';
import { EMULATED } from './sync-auth.js';

const DAY_MS = 86_400_000;
const HISTORY_DAYS = 7;
/** turnDay/ days older than this are swept when the page opens. */
const TURN_KEEP_DAYS = 14;
/** A penalty lightened or cleared later than this after submitting is refused by the rules (#164). */
const PENALTY_WINDOW_MS = 15_000;
const ROUNDS_SHOWN = 40;
const CHAT_SHOWN = 30;

/**
 * @param ctx  { S, scheduleRender, raw, ago, who, openSheet, closeSheet, askBan, gate, cfg, moderation }
 */
export function createRooms(ctx) {
  const { S, raw, ago } = ctx;
  const R = {
    started: false, unsubs: [],
    seat: undefined, seatRefused: false,
    room: null,                         // { id, data, refused, unsub }
    history: null, historyBusy: false, historyRefused: false, filter: '',
    relay: null, relayAt: 0, relayBusy: false, relayRefused: false, swept: false,
  };
  const sdk = () => S.sdk;
  const ref = (path) => sdk().ref(sdk().db, path);
  const root = () => sdk().ref(sdk().db);
  const now = () => Date.now() + (ctx.moderation.offset() || 0);
  const today = () => Number(dayKeyFromServerMs(now()));
  const me = () => S.user?.uid;

  /* ---------------- listening ---------------- */

  function start() {
    if (R.started || !S.sdk) return;
    R.started = true;
    R.unsubs.push(sdk().onValue(ref(`rooms/${MATCH_LOBBY}/meta/waiting`), (s) => {
      R.seat = s.val();
      R.seatRefused = false;
      ctx.scheduleRender();
    }, () => { R.seatRefused = true; ctx.scheduleRender(); }));
  }

  function stop() {
    for (const off of R.unsubs.splice(0)) off();
    R.room?.unsub?.();
    Object.assign(R, { started: false, seat: undefined, room: null, history: null, relay: null, relayAt: 0, swept: false });
  }

  /** The inspector's room, listened to while it is open. */
  function watchRoom(id) {
    if (R.room?.id === id) return R.room;
    R.room?.unsub?.();
    const room = { id, data: undefined, refused: false };
    room.unsub = sdk().onValue(ref(`rooms/${id}`), (s) => {
      room.data = s.val();
      ctx.scheduleRender();
    }, () => { room.refused = true; ctx.scheduleRender(); });
    R.room = room;
    return room;
  }

  /** The last seven days of rooms, read once on asking (rooms are never cleared out). */
  async function loadHistory() {
    if (R.historyBusy) return;
    R.historyBusy = true;
    ctx.scheduleRender();
    const { get, query, orderByChild, startAt } = sdk();
    try {
      const snap = await get(query(ref('rooms'), orderByChild('meta/createdAt'), startAt(now() - HISTORY_DAYS * DAY_MS)));
      R.history = snap.val() || {};
      R.historyRefused = false;
    } catch (err) {
      console.warn('[admin] history refused', err?.code || err);
      R.historyRefused = true;
    }
    R.historyBusy = false;
    ctx.scheduleRender();
  }

  /* REST, as this admin: the database's own ?shallow, which the SDK cannot ask for. */
  async function rest(path, q = '') {
    const token = await S.user.getIdToken();
    const base = EMULATED ? 'http://127.0.0.1:9000' : FIREBASE_CONFIG.databaseURL;
    const ns = EMULATED ? '&ns=tagda-timer-default-rtdb' : '';
    return fetch(`${base}/${path}.json?auth=${encodeURIComponent(token)}${ns}${q}`, { cache: 'no-store' });
  }

  /** Today's relay credentials (turnDay/<today>), and once a page load, days past TURN_KEEP_DAYS swept. */
  async function loadRelay(force = false) {
    if (R.relayBusy || (!force && R.relayAt && Date.now() - R.relayAt < 60_000)) return;
    R.relayBusy = true;
    const day = today();
    try {
      const r = await rest(`turnDay/${day}`);
      if (r.status === 401) R.relayRefused = true;
      else if (r.ok) { R.relay = { day, counts: (await r.json()) || {} }; R.relayRefused = false; }
      if (!R.swept && r.ok) {
        R.swept = true;
        const all = await rest('turnDay', '&shallow=true');
        const keys = all.ok ? Object.keys((await all.json()) || {}) : [];
        const old = keys.filter(k => Number(k) < day - TURN_KEEP_DAYS * DAY_MS);
        if (old.length) {
          await sdk().update(root(), Object.fromEntries(old.map(k => [`turnDay/${k}`, null])))
            .catch(err => console.warn('[admin] turnDay sweep refused', err?.code || err));
        }
      }
    } catch { /* the last numbers stay */ }
    R.relayAt = Date.now();
    R.relayBusy = false;
    ctx.scheduleRender();
  }

  /* ---------------- what a room is ---------------- */

  const nameOf = (room, uid) => room?.players?.[uid]?.name
    || Object.values(room?.chat || {}).find(m => m?.uid === uid)?.name || t('a racer');
  const isDuel = (room) => room?.meta?.kind === 'duel';
  const roomTitle = (id, room) => (isDuel(room) ? t('1v1 · {id}', { id }) : t('Room {id}', { id }));
  const effOf = (r) => (!r || r.penalty === 'DNF' ? Infinity : (r.timeMs || 0) + (r.penalty === '+2' ? 2000 : 0));
  const timeText = (r) => (!r ? '—' : r.penalty === 'DNF' ? 'DNF' : fmt(effOf(r)) + (r.penalty === '+2' ? '+' : ''));
  const staleMs = () => ctx.cfg('race', 'hardTimeoutSec') * 1000;
  const struckOf = (room, n, uid) => room?.mod?.struck?.[n]?.[uid] || null;
  /* The rounds a room has reached, newest first. The next round's scramble is
     written while this one is still being read (race.js _preopenNextRound),
     so a round past meta/round with no time in it is not a round yet. */
  const roundNos = (room) => Object.keys(room?.rounds || {}).map(Number).filter(Number.isFinite)
    .filter(n => n <= (room?.meta?.round || 0) || Object.keys(room.rounds[n]?.results || {}).length)
    .sort((a, b) => b - a);

  /** The last thing that happened in a room: a heartbeat, a round opening, a time. */
  function lastSeen(room) {
    let at = room?.meta?.createdAt || 0;
    for (const p of Object.values(room?.players || {})) at = Math.max(at, p?.lastSeen || 0);
    for (const r of Object.values(room?.rounds || {})) {
      at = Math.max(at, r?.info?.startedAt || 0);
      for (const x of Object.values(r?.results || {})) at = Math.max(at, x?.submittedAt || 0);
    }
    return at;
  }

  /** Everyone who has been in a room, by uid: players now, and anybody with a time or a message. */
  function everyone(room) {
    const ids = new Set(Object.keys(room?.players || {}));
    for (const r of Object.values(room?.rounds || {})) for (const uid of Object.keys(r?.results || {})) ids.add(uid);
    for (const m of Object.values(room?.chat || {})) if (m?.uid) ids.add(m.uid);
    return ids;
  }

  /* ---------------- the actions ---------------- */

  const TS = () => sdk().serverTimestamp();
  /** One multi-path update at the root; a refusal says the rules are older than this page. */
  async function write(updates, done) {
    try {
      await sdk().update(root(), updates);
      ctx.closeSheet();
      if (done) toast(done, { kind: 'good' });
      return true;
    } catch (err) {
      console.warn('[admin] room action refused', err?.code || err);
      toast(t('Refused: room actions need this version’s firebase.rules.json published'), { kind: 'bad', hold: true });
      return false;
    }
  }

  function confirm(title, lines, label, run, { danger = false, extra = null } = {}) {
    ctx.openSheet(
      el('h2', { class: 'ac-h2', text: title }),
      ...lines.map(l => (typeof l === 'string' ? el('p', { class: 'ac-sub', text: l }) : l)),
      extra,
      el('div', { class: 'ac-sheet-actions' },
        el('button', { class: 'ac-btn', text: 'Back', onclick: ctx.closeSheet }),
        el('button', { class: `ac-btn primary${danger ? ' danger' : ''}`, text: label, onclick: run })));
  }

  const askClose = (id) => confirm(t('Close room {id}?', { id }),
    [t('Everybody in it is told a moderator closed it and leaves. Nobody can join it, post in it or send a time to it until it is reopened. Its rounds and chat stay for you to look at.')],
    t('Close room'), () => write({ [`rooms/${id}/mod/closed`]: { at: TS(), by: me() } }, t('Room closed')));
  const askReopen = (id) => confirm(t('Reopen room {id}?', { id }),
    [t('People can join it by its code again.')], t('Reopen'), () => write({ [`rooms/${id}/mod/closed`]: null }, t('Room reopened')));
  const askKick = (id, uid, name) => confirm(t('Remove {name} from room {id}?', { name, id }),
    [t('Their tab is told a moderator removed them, and leaves. They cannot come back into this room, post in it or send a time to it; other rooms are not affected. To keep them out of everything, ban them instead.')],
    t('Remove'), () => write({ [`rooms/${id}/mod/kicked/${uid}`]: TS(), [`rooms/${id}/players/${uid}`]: null }, t('Removed')));
  const askUnkick = (id, uid, name) => confirm(t('Let {name} back into room {id}?', { name, id }),
    [], t('Let back in'), () => write({ [`rooms/${id}/mod/kicked/${uid}`]: null }, t('They can join again')));

  function askStrike(id, n, uid, name, res) {
    const reason = el('input', { class: 'ac-inp', maxlength: 200, placeholder: t('Why (optional, kept with it)') });
    confirm(t('Strike {name}’s {time} in round {n}?', { name, time: timeText(res), n }),
      [t('It stops counting: out of the round, the standings and Race stats, on every screen in the room. They see it was removed by a moderator. The time itself stays in the database, so this can be undone.')],
      t('Strike'), () => write({
        [`rooms/${id}/mod/struck/${n}/${uid}`]: { at: TS(), by: me(), ...(reason.value.trim() ? { reason: reason.value.trim().slice(0, 200) } : {}) },
      }, t('Struck')), { extra: el('div', { class: 'ac-text' }, reason) });
  }
  const askUnstrike = (id, n, uid, name) => confirm(t('Count {name}’s time in round {n} again?', { name, n }),
    [], t('Count it again'), () => write({ [`rooms/${id}/mod/struck/${n}/${uid}`]: null }, t('Counted again')));

  function askDelete(id, room) {
    const box = el('input', { class: 'ac-inp', autocomplete: 'off', placeholder: id, 'aria-label': t('Room code') });
    const go = el('button', { class: 'ac-btn primary danger', text: t('Delete room'), disabled: true,
      onclick: async () => {
        try { await sdk().remove(ref(`rooms/${id}`)); }
        catch (err) {
          console.warn('[admin] delete room refused', err?.code || err);
          toast(t('Refused: room actions need this version’s firebase.rules.json published'), { kind: 'bad', hold: true });
          return;
        }
        ctx.closeSheet();
        toast(t('Room {id} deleted', { id }), { kind: 'good' });
        location.hash = '#mod/rooms';
      } });
    box.addEventListener('input', () => { go.disabled = box.value.trim() !== id; });
    ctx.openSheet(
      el('h2', { class: 'ac-h2', text: t('Delete room {id}?', { id }) }),
      el('p', { class: 'ac-sub', text: t('Everything in it goes for good: its rounds, times and chat. Anybody still in it is dropped. For test junk, or a room past saving; to stop a room, close it instead. Type its code to delete it.') }),
      raw('p', { class: 'ac-entry-meta' }, t('{n} rounds, {m} messages', { n: roundNos(room).length, m: Object.keys(room?.chat || {}).length })),
      el('div', { class: 'ac-text' }, box),
      el('div', { class: 'ac-sheet-actions' }, el('button', { class: 'ac-btn', text: 'Back', onclick: ctx.closeSheet }), go));
  }

  function askDeleteMessage(id, mid, m) {
    confirm(t('Delete this message?'), [raw('p', { class: 'ac-reason' }, `${m.name || 'Cuber'}: ${m.text || ''}`)],
      t('Delete message'), () => write({ [`rooms/${id}/chat/${mid}`]: null }, t('Deleted')));
  }

  /** Empty the waiting seat, but only if it still holds what this page showed: never a claim made since. */
  async function clearSeat(shown) {
    try {
      const res = await sdk().runTransaction(ref(`rooms/${MATCH_LOBBY}/meta/waiting`), (cur) => (
        cur && cur.uid === shown.uid && cur.code === shown.code && cur.at === shown.at ? null : undefined), { applyLocally: false });
      ctx.closeSheet();
      toast(res.committed ? t('Seat cleared') : t('The seat changed before it was cleared: look again'), { kind: res.committed ? 'good' : 'bad' });
    } catch (err) {
      console.warn('[admin] clear seat refused', err?.code || err);
      toast(t('The database refused that'), { kind: 'bad', hold: true });
    }
  }

  /* ---------------- the 1v1 lobby and the day's 1v1s ---------------- */

  const matchStaleMs = () => Math.max(ctx.cfg('duel', 'staleSec') * 1000, 2 * ctx.cfg('duel', 'refreshSec') * 1000 + 1000);

  /** The day's 1v1s, from the Moderate tab's read of the last day's rooms: how many, and how long one lasts. */
  function duelDay() {
    const rooms = ctx.moderation.snapshot().rooms || {};
    const day = today();
    const lens = [];
    let n = 0;
    for (const room of Object.values(rooms)) {
      if (!isDuel(room) || (room.meta?.createdAt || 0) < day) continue;
      n++;
      const len = lastSeen(room) - (room.meta?.createdAt || 0);
      if (len > 0) lens.push(len);
    }
    lens.sort((a, b) => a - b);
    const median = lens.length ? lens[Math.floor(lens.length / 2)] : null;
    return { n, median };
  }

  const minutes = (ms) => (ms < 60_000 ? t('{n} s', { n: Math.round(ms / 1000) }) : t('{n} min', { n: Math.round(ms / 60_000) }));

  function seatBlock() {
    start();
    const seat = R.seat;
    const at = seat?.at || 0;
    const age = at ? now() - at : 0;
    const stale = !!seat && !seat.takenBy && age > matchStaleMs();
    const d = duelDay();
    let line;
    if (R.seatRefused) line = el('p', { class: 'ac-err', text: t('The seat can’t be read with the rules published now.') });
    else if (seat === undefined) line = el('p', { class: 'ac-note ac-small', text: 'Loading…' });
    else if (!seat) line = el('p', { class: 'ac-sub', text: t('Empty: nobody is looking for an opponent right now.') });
    else {
      line = el('div', { class: `ac-entry${stale ? ' ac-late' : ''}` },
        el('div', { class: 'ac-entry-main' },
          raw('b', {}, seat.takenBy ? t('Matched: two people are joining room {code}', { code: seat.code }) : t('Somebody is waiting')),
          raw('span', { class: 'ac-uid' }, `${seat.uid || ''}${seat.takenBy ? ` + ${seat.takenBy}` : ''}`),
          raw('span', { class: 'ac-entry-meta' }, t('last stamped {when}', { when: ago(at) })
            + (stale ? ` · ${t('abandoned: past {n}', { n: minutes(matchStaleMs()) })}` : ''))),
        el('div', { class: 'ac-entry-actions' },
          el('button', { class: 'ac-btn small', text: t('Clear seat'), onclick: () => confirm(t('Clear the waiting seat?'),
            [t('Whoever is in it loses their place and their search carries on from scratch. Only clears it if it still holds what you see: a claim made since is left alone.')],
            t('Clear seat'), () => clearSeat(seat)) })));
    }
    return el('section', { class: 'ac-block' },
      el('h2', { class: 'ac-h2', text: t('1v1 lobby') }),
      line,
      el('div', { class: 'ac-stats' },
        stat(d.n, t('1v1s today')),
        stat(d.median == null ? '—' : minutes(d.median), t('a 1v1 lasts (median)'))));
  }

  const stat = (value, label) => el('div', { class: 'ac-stat' },
    raw('b', { class: 'ac-stat-n' }, String(value)),
    el('span', { class: 'ac-stat-label', text: label }));

  function relayBlock() {
    loadRelay();
    const head = el('h2', { class: 'ac-h2', text: t('1v1 relay') });
    if (R.relayRefused) {
      return el('section', { class: 'ac-block' }, head,
        el('p', { class: 'ac-sub', text: 'Counting relay credentials needs this version’s firebase.rules.json published.' }));
    }
    const counts = R.relay?.day === today() ? R.relay.counts : null;
    const list = Object.entries(counts || {}).filter(([, n]) => typeof n === 'number').sort((a, b) => b[1] - a[1]);
    const total = list.reduce((s, [, n]) => s + n, 0);
    const off = !ctx.cfg('duel', 'turnEnabled') || !ctx.cfg('duel', 'camEnabled');
    return el('section', { class: 'ac-block' }, head,
      el('div', { class: 'ac-stats' },
        stat(counts ? total : '…', t('credentials handed out today')),
        stat(counts ? list.length : '…', t('people'))),
      list.length ? el('ol', { class: 'ac-log ac-tight' }, ...list.slice(0, 5).map(([uid, n]) => el('li', { class: 'ac-entry' },
        el('div', { class: 'ac-entry-main' }, raw('span', { class: 'ac-uid' }, uid)), raw('b', { class: 'ac-time' }, String(n))))) : null,
      off ? el('span', { class: 'ac-pill warn', text: t('Switched off') }) : null,
      el('p', { class: 'ac-note ac-small', text: 'The app counts each time it asks the Worker for a relay login. Bytes relayed are only on Cloudflare’s dashboard: 1,000 GB a month free, then $0.05/GB.' }),
      el('a', { class: 'ac-link', href: 'https://dash.cloudflare.com/', target: '_blank', rel: 'noopener', text: 'Cloudflare › Realtime › TURN' }));
  }

  /* ---------------- the room list ---------------- */

  function roomRow(id, room) {
    const players = Object.values(room?.players || {});
    const here = players.filter(p => now() - (p?.lastSeen || 0) < staleMs()).length;
    const rounds = roundNos(room).filter(n => Object.keys(room.rounds[n]?.results || {}).length).length;
    const closed = !!room?.mod?.closed;
    return el('a', { class: `ac-card${closed ? ' ac-ended' : ''}`, href: `#mod/room/${id}` },
      el('div', { class: 'ac-card-main' },
        raw('b', {}, roomTitle(id, room)),
        raw('span', { class: 'ac-card-sub' }, t('made {when} · last seen {seen}', { when: ago(room?.meta?.createdAt), seen: ago(lastSeen(room)) }))),
      el('div', { class: 'ac-card-side' },
        closed ? el('span', { class: 'ac-pill warn', text: t('Closed') }) : null,
        el('span', { class: `ac-pill${here ? ' ac-live' : ''}`, text: here ? t('{n} here', { n: here }) : t('empty') }),
        el('span', { class: 'ac-pill', text: rounds === 1 ? t('1 round') : t('{n} rounds', { n: rounds }) }),
        raw('span', { class: 'ac-chev', 'aria-hidden': 'true' }, '›')));
  }

  const sortRooms = (rooms) => Object.entries(rooms || {}).filter(([id]) => id !== MATCH_LOBBY)
    .sort((a, b) => lastSeen(b[1]) - lastSeen(a[1]));

  function viewRooms() {
    const m = ctx.moderation.snapshot();
    const list = sortRooms(m.rooms);
    return [
      seatBlock(),
      el('section', { class: 'ac-block' },
        el('div', { class: 'ac-head-row' },
          el('h2', { class: 'ac-h2', text: t('Rooms made in the last day') }),
          el('button', { class: 'ac-btn small', type: 'button', text: 'Look again', onclick: () => ctx.moderation.refreshRooms() })),
        m.roomsRefused ? el('p', { class: 'ac-err', text: 'Race rooms need the newer rules published.' })
          : !m.roomsLoaded ? el('p', { class: 'ac-note', text: 'Loading…' })
            : !list.length ? el('p', { class: 'ac-note', text: 'No race rooms in the last day.' })
              : el('div', { class: 'ac-list' }, ...list.map(([id, room]) => roomRow(id, room))),
        el('a', { class: 'ac-btn small', href: '#mod/history', text: t('The last {n} days ›', { n: HISTORY_DAYS }) })),
    ];
  }

  function viewHistory() {
    if (!R.history && !R.historyBusy && !R.historyRefused) loadHistory();
    const q = R.filter.trim().toLowerCase();
    const input = el('input', { class: 'ac-inp', type: 'search', value: R.filter, autocomplete: 'off',
      placeholder: t('A uid, or part of a name'), 'aria-label': t('Filter by person') });
    input.addEventListener('input', () => { R.filter = input.value; ctx.scheduleRender(); });
    input.addEventListener('blur', () => ctx.scheduleRender());
    let body;
    if (R.historyRefused) body = el('p', { class: 'ac-err', text: 'Race rooms need the newer rules published.' });
    else if (!R.history) body = el('p', { class: 'ac-note', text: 'Loading…' });
    else {
      const list = sortRooms(R.history).filter(([, room]) => {
        if (!q) return true;
        for (const uid of everyone(room)) if (uid.toLowerCase() === q || nameOf(room, uid).toLowerCase().includes(q)) return true;
        return false;
      });
      body = list.length ? el('div', { class: 'ac-list' }, ...list.map(([id, room]) => roomRow(id, room)))
        : el('p', { class: 'ac-note', text: q ? t('Nobody by that in the last {n} days.', { n: HISTORY_DAYS }) : t('No race rooms in the last {n} days.', { n: HISTORY_DAYS }) });
    }
    return [
      el('a', { class: 'ac-back', href: '#mod/rooms', text: t('‹ Rooms') }),
      el('section', { class: 'ac-block' },
        el('div', { class: 'ac-head-row' },
          el('h2', { class: 'ac-h2', text: t('Rooms, the last {n} days', { n: HISTORY_DAYS }) }),
          el('button', { class: 'ac-btn small', type: 'button', text: 'Look again', onclick: () => loadHistory() })),
        el('p', { class: 'ac-sub', text: 'Every room made in the last week that is still in the database, newest first. A uid finds every room that person raced, posted or sat in.' }),
        el('div', { class: 'ac-text' }, input),
        body),
    ];
  }

  /* ---------------- the inspector ---------------- */

  /** One time, with everything a dispute needs: when it came in, its penalty and when that changed, its flags. */
  function resultRow(id, room, n, uid, res, median) {
    const name = nameOf(room, uid);
    const struck = struckOf(room, n, uid);
    const prog = room.rounds?.[n]?.progress?.[uid];
    const notes = [];
    if (res.submittedAt && room.rounds?.[n]?.info?.startedAt) {
      notes.push(t('in {s} s after the round opened', { s: Math.round((res.submittedAt - room.rounds[n].info.startedAt) / 1000) }));
    }
    if (prog?.startedAt && prog?.finishedAt) notes.push(t('the server saw {time}', { time: fmt(prog.finishedAt - prog.startedAt) }));
    const pen = res.penalty && res.penalty !== 'none' ? res.penalty : null;
    let penNote = null;
    if (res.penaltyAt && res.submittedAt) {
      const after = res.penaltyAt - res.submittedAt;
      const late = after > PENALTY_WINDOW_MS;
      penNote = raw('span', { class: `ac-entry-meta${late ? ' ac-flag' : ''}` },
        t('penalty {p} set {s} s after the time', { p: res.penalty || 'none', s: Math.round(after / 1000) })
        + (late ? ` · ${pen ? t('late, allowed: heavier') : t('late')}` : ''));
    } else if (pen) {
      penNote = raw('span', { class: 'ac-entry-meta' }, t('penalty {p} (with the time, or before penalty times were kept)', { p: pen }));
    }
    const low = median && Number.isFinite(effOf(res)) && effOf(res) < median * (ctx.cfg('race', 'suspectPct') / 100);
    const flags = [res.suspect ? t('⚑ under their own average') : null, low ? t('⚑ under {p}% of the room’s median', { p: ctx.cfg('race', 'suspectPct') }) : null].filter(Boolean);
    return el('li', { class: `ac-entry${struck ? ' ac-ended' : ''}${flags.length ? ' ac-late' : ''}` },
      el('div', { class: 'ac-entry-main' },
        el('span', { class: 'ac-chat-head' }, raw('b', {}, name), raw('span', { class: 'ac-time' }, timeText(res))),
        struck ? raw('span', { class: 'ac-flag' }, t('struck {when} by {who}', { when: ago(struck.at), who: ctx.who(struck.by) }) + (struck.reason ? ` · ${struck.reason}` : '')) : null,
        notes.length ? raw('span', { class: 'ac-entry-meta' }, notes.join(' · ')) : null,
        penNote,
        flags.length ? raw('span', { class: 'ac-flag' }, flags.join(' · ')) : null,
        raw('span', { class: 'ac-uid' }, uid)),
      el('div', { class: 'ac-entry-actions' },
        struck ? el('button', { class: 'ac-btn small', text: t('Count again'), onclick: () => askUnstrike(id, n, uid, name) })
          : el('button', { class: 'ac-btn small', text: t('Strike'), onclick: () => askStrike(id, n, uid, name, res) })));
  }

  function roundBlock(id, room, n) {
    const r = room.rounds[n] || {};
    const entries = Object.entries(r.results || {});
    const counted = entries.filter(([uid]) => !struckOf(room, n, uid)).map(([, x]) => effOf(x)).filter(Number.isFinite).sort((a, b) => a - b);
    // Only a room's worth of times has a median worth flagging against: two people are a 1v1, not a field.
    const mid = counted.length >> 1;
    const median = counted.length < 3 ? null : counted.length % 2 ? counted[mid] : (counted[mid - 1] + counted[mid]) / 2;
    const best = counted.length ? counted[0] : null;
    const winner = entries.find(([uid, x]) => !struckOf(room, n, uid) && effOf(x) === best);
    const done = Object.entries(r.progress || {}).filter(([, p]) => p?.status === 'done').map(([uid]) => uid);
    const noTime = done.filter(uid => !r.results?.[uid]);
    return el('li', { class: 'ac-round' },
      el('div', { class: 'ac-round-head' },
        raw('b', {}, t('Round {n}', { n })),
        winner ? raw('span', { class: 'ac-pill ac-live' }, t('won by {name}', { name: nameOf(room, winner[0]) })) : null,
        r.info?.startedAt ? raw('span', { class: 'ac-entry-meta' }, ago(r.info.startedAt)) : null),
      r.info?.scramble ? raw('span', { class: 'ac-scr' }, r.info.scramble) : null,
      entries.length ? el('ol', { class: 'ac-log ac-tight' }, ...entries
        .sort((a, b) => effOf(a[1]) - effOf(b[1]))
        .map(([uid, x]) => resultRow(id, room, n, uid, x, median))) : el('p', { class: 'ac-note ac-small', text: 'No times.' }),
      noTime.length ? raw('p', { class: 'ac-flag' }, t('Finished but no time arrived: {names}', { names: noTime.map(u => nameOf(room, u)).join(', ') })) : null);
  }

  function viewRoom(id) {
    start();
    const room = watchRoom(id);
    const back = el('a', { class: 'ac-back', href: '#mod/rooms', text: t('‹ Rooms') });
    if (room.refused) return [back, ctx.gate('Couldn’t read that room', 'Race rooms need the newer rules published.')];
    if (room.data === undefined) return [back, el('p', { class: 'ac-note', text: 'Loading…' })];
    if (room.data === null) return [back, el('h1', { class: 'ac-h1', text: t('Room {id}', { id }) }), el('p', { class: 'ac-note', text: 'This room is not in the database (deleted, or never made).' })];
    const d = room.data;
    const closed = d.mod?.closed;
    const kicked = d.mod?.kicked || {};
    const players = Object.entries(d.players || {}).sort((a, b) => (a[1]?.joinedAt || 0) - (b[1]?.joinedAt || 0));
    const nos = roundNos(d);
    const chat = Object.entries(d.chat || {}).sort((a, b) => (b[1]?.at || 0) - (a[1]?.at || 0)).slice(0, CHAT_SHOWN);

    const head = [
      back,
      el('h1', { class: 'ac-h1', text: roomTitle(id, d) }),
      raw('p', { class: 'ac-sub' }, t('{event} · made {when} · round {n}', { event: d.meta?.event ? eventOf(d.meta.event)?.short || d.meta.event : '—', when: ago(d.meta?.createdAt), n: d.meta?.round || 0 })
        + (closed ? ` · ${t('closed {when} by {who}', { when: ago(closed.at), who: ctx.who(closed.by) })}` : '')),
      el('div', { class: 'ac-entry-actions ac-start' },
        closed ? el('button', { class: 'ac-btn small', text: t('Reopen'), onclick: () => askReopen(id) })
          : el('button', { class: 'ac-btn small', text: t('Close room'), onclick: () => askClose(id) }),
        el('button', { class: 'ac-btn small danger', text: t('Delete room'), onclick: () => askDelete(id, d) })),
    ];

    const who = el('section', { class: 'ac-block' },
      el('h2', { class: 'ac-h2', text: t('Players') }),
      players.length ? el('ol', { class: 'ac-log ac-tight' }, ...players.map(([uid, p]) => {
        const silent = now() - (p?.lastSeen || 0);
        return el('li', { class: 'ac-entry' },
          el('div', { class: 'ac-entry-main' },
            el('span', { class: 'ac-chat-head' }, raw('b', {}, p?.name || 'Cuber'),
              el('span', { class: `ac-pill${silent < staleMs() ? ' ac-live' : ' warn'}`, text: silent < staleMs() ? t('connected') : t('gone quiet') })),
            raw('span', { class: 'ac-entry-meta' }, t('joined {when} · last heartbeat {seen}', { when: ago(p?.joinedAt), seen: ago(p?.lastSeen) })),
            el('button', { class: 'ac-link ac-uid', text: uid, title: t('Copy'), onclick: () => navigator.clipboard?.writeText(uid).then(() => toast(t('Copied'))) })),
          el('div', { class: 'ac-entry-actions' },
            el('button', { class: 'ac-btn small', text: t('Remove'), onclick: () => askKick(id, uid, p?.name || 'Cuber') }),
            el('button', { class: 'ac-btn small danger', text: t('Ban'), onclick: () => ctx.askBan({ uid, name: p?.name || '', reason: t('Race room {id}', { id }) }) })));
      })) : el('p', { class: 'ac-note', text: 'Nobody is in it.' }),
      Object.keys(kicked).length ? el('ol', { class: 'ac-log ac-tight' }, ...Object.entries(kicked).map(([uid, at]) => el('li', { class: 'ac-entry ac-ended' },
        el('div', { class: 'ac-entry-main' },
          raw('b', {}, nameOf(d, uid)),
          raw('span', { class: 'ac-entry-meta' }, t('removed {when}', { when: ago(at) })),
          raw('span', { class: 'ac-uid' }, uid)),
        el('div', { class: 'ac-entry-actions' }, el('button', { class: 'ac-btn small', text: t('Let back in'), onclick: () => askUnkick(id, uid, nameOf(d, uid)) }))))) : null);

    const rounds = el('section', { class: 'ac-block' },
      el('h2', { class: 'ac-h2', text: t('Rounds') }),
      el('p', { class: 'ac-sub', text: 'Newest first. Each time with when it came in, what the server timed, its penalty and when that changed (lighter is refused after 15 s, heavier is allowed any time), and its flags. A struck time counts for nothing on any screen in the room.' }),
      nos.length ? el('ol', { class: 'ac-log' }, ...nos.slice(0, ROUNDS_SHOWN).map(n => roundBlock(id, d, n)))
        : el('p', { class: 'ac-note', text: 'No rounds yet.' }),
      nos.length > ROUNDS_SHOWN ? el('p', { class: 'ac-note ac-small', text: t('{n} older rounds not shown.', { n: nos.length - ROUNDS_SHOWN }) }) : null);

    const talk = el('section', { class: 'ac-block' },
      el('h2', { class: 'ac-h2', text: t('Chat') }),
      chat.length ? el('ol', { class: 'ac-log ac-tight' }, ...chat.map(([mid, m]) => el('li', { class: 'ac-entry' },
        el('div', { class: 'ac-entry-main' },
          el('span', { class: 'ac-chat-head' }, raw('b', {}, m?.name || 'Cuber'), raw('span', { class: 'ac-entry-meta' }, ago(m?.at))),
          raw('span', { class: 'ac-reason' }, m?.text || '')),
        el('div', { class: 'ac-entry-actions' }, el('button', { class: 'ac-btn small', text: t('Delete'), onclick: () => askDeleteMessage(id, mid, m) })))))
        : el('p', { class: 'ac-note', text: 'Nothing said.' }));

    return [...head, who, rounds, talk];
  }

  /** Leaving the inspector stops listening to its room. */
  function leaveRoom() {
    R.room?.unsub?.();
    R.room = null;
  }

  return { start, stop, viewRooms, viewHistory, viewRoom, leaveRoom, seatBlock, relayBlock, loadRelay };
}
