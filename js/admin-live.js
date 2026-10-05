import { t } from './i18n.js';
/* ===========================================================
   Tagda Timer — the admin console's Today tab, its days ahead, and testers
   (js/admin.js)

     Today       the day so far: Scramble of the Day times per event,
                 replays and their space against the limits in force (the
                 Worker's /replay/usage), chat messages, race rooms, reports,
                 bans, testers and what is scheduled. Beside them, what this
                 page cannot see, and where to look for it instead.
     Days ahead  a day's scramble set by hand before the day starts, and a
                 day's featured event (DAILY.md §3)
     Testers     testers/<uid>: who gets a feature whose audience is testers
                 (ADMIN.md §9)

   The counts come from the Moderate tab's listeners (admin-mod.js), which
   this tab starts if they are not running, plus two kinds of one-off read
   when it opens or Refresh is pressed: the Worker's list of today's clips,
   and each event's chat read shallow over REST, so only the message ids
   come down. Nothing here listens to anything new but the featured days.
   =========================================================== */

import { el } from './util.js';
import { toast } from './toast.js';
import { EVENTS } from './events.js';
import { dayKeyFromServerMs, dayIdFromServerMs, nextResetMs, formatCountdown } from './dayid.js';
import { faceletsFor, cubeSizeFor, drawNet, parseAlg } from './cubenet.js';
import { addTester, removeTester } from './admins.js';
import { setOf } from './config.js';
import { SOTD_EVENTS } from './config-table.js';
import { FIREBASE_CONFIG } from './raceapp.js';
import { EMULATED } from './sync-auth.js';

const DAY_MS = 86_400_000;
const IST_MS = 19_800_000;
const MB = 1024 * 1024;
/** How far ahead a day's scramble and featured event can be planned here. */
const AHEAD_DAYS = 14;
/** One-off reads (the Worker's list, the chats' sizes) are not repeated sooner than this. */
const FRESH_MS = 60_000;
const UID_RE = /^[A-Za-z0-9]{1,128}$/;

/**
 * @param ctx  { S, scheduleRender, raw, ago, who, openSheet, closeSheet, gate, cfg, moderation, scheduledList }
 */
export function createLive(ctx) {
  const { S, raw, ago, who } = ctx;
  const L = {
    started: false, unsubs: [],
    featured: {}, featuredRefused: false,
    usage: null, usageErr: null, usageAt: 0, usageBusy: false,
    chats: null, chatsAt: 0, chatsBusy: false,
    scrambles: new Map(),      // dayKey -> { event: scramble | null } once read
  };
  const sdk = () => S.sdk;
  const ref = (path) => sdk().ref(sdk().db, path);
  const serverNow = () => Date.now() + (ctx.moderation.offset() || 0);
  /** Today's day key as a number (dayid.js hands back the string a path wants). */
  const today = () => Number(dayKeyFromServerMs(serverNow()));
  const evName = (e) => EVENTS[e]?.short || e;
  /** The events that have a Scramble of the Day, by the setting (config/sotd/events). */
  const sotdEvents = () => setOf(ctx.cfg('sotd', 'events')).filter(e => SOTD_EVENTS.includes(e));
  /** A day key as people say it: Today, Tomorrow, or "Wed 8 Oct" (the IST day). */
  const dayLabel = (key, base = today()) => {
    if (key === base) return t('Today');
    if (key === base + DAY_MS) return t('Tomorrow');
    return new Date(key + IST_MS).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  };
  const mb = (bytes) => `${Math.round((bytes / MB) * 10) / 10}`;

  /* ---------------- listening ---------------- */

  function start() {
    if (L.started || !S.sdk) return;
    L.started = true;
    const { onValue, query, orderByKey, startAt } = sdk();
    // Today's and the days ahead only: a past day's pick is history.
    L.unsubs.push(onValue(query(ref('sotdFeatured'), orderByKey(), startAt(String(today()))), (s) => {
      L.featured = s.val() || {};
      L.featuredRefused = false;
      ctx.scheduleRender();
    }, () => { L.featuredRefused = true; ctx.scheduleRender(); }));
  }

  function stop() {
    for (const off of L.unsubs.splice(0)) off();
    Object.assign(L, { started: false, featured: {}, featuredRefused: false, usage: null, usageErr: null, usageAt: 0,
      chats: null, chatsAt: 0, scrambles: new Map() });
  }

  /** The Worker's look at today's clips (/replay/usage, admins only). */
  async function loadUsage(force = false) {
    if (L.usageBusy || (!force && L.usageAt && Date.now() - L.usageAt < FRESH_MS)) return;
    L.usageBusy = true;
    try {
      const token = await S.user.getIdToken();
      const r = await fetch('/replay/usage', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
      if (r.ok) { L.usage = await r.json(); L.usageErr = null; }
      // An older Worker answers the path as a bad replay path; Vercel has no Worker at all.
      else L.usageErr = [400, 404, 405].includes(r.status) ? 'old' : 'failed';
    } catch { L.usageErr = 'failed'; }
    L.usageAt = Date.now();
    L.usageBusy = false;
    ctx.scheduleRender();
  }

  /** How many messages each event's room has today: the ids only (?shallow), over REST, as this admin. */
  async function loadChats(force = false) {
    if (L.chatsBusy || (!force && L.chatsAt && Date.now() - L.chatsAt < FRESH_MS)) return;
    L.chatsBusy = true;
    const day = today();
    try {
      const token = await S.user.getIdToken();
      const base = EMULATED ? 'http://127.0.0.1:9000' : FIREBASE_CONFIG.databaseURL;
      const ns = EMULATED ? '&ns=tagda-timer-default-rtdb' : '';
      const counts = {};
      await Promise.all(sotdEvents().map(async (e) => {
        const r = await fetch(`${base}/daily/${day}/${e}/chat/m.json?shallow=true&auth=${encodeURIComponent(token)}${ns}`, { cache: 'no-store' });
        if (r.ok) { const j = await r.json(); counts[e] = j ? Object.keys(j).length : 0; }
      }));
      L.chats = { day, counts };
    } catch { /* the last numbers stay */ }
    L.chatsAt = Date.now();
    L.chatsBusy = false;
    ctx.scheduleRender();
  }

  function refresh() {
    loadUsage(true);
    loadChats(true);
    ctx.moderation.refreshRooms();
  }

  /* ---------------- Today ---------------- */

  const stat = (value, label, sub = null, cls = '') => el('div', { class: `ad-stat ${cls}` },
    raw('b', { class: 'ad-stat-n' }, String(value)),
    el('span', { class: 'ad-stat-label', text: label }),
    sub ? raw('span', { class: 'ad-stat-sub' }, sub) : null);
  const meter = (used, of) => {
    const pct = of > 0 ? Math.min(100, Math.round((used / of) * 100)) : 0;
    return el('div', { class: `ad-meter${pct >= 90 ? ' hot' : ''}`, role: 'meter', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 },
      el('i', { style: { width: `${pct}%` } }));
  };
  const block = (title, ...kids) => el('section', { class: 'ad-block' }, el('h2', { class: 'ad-h2', text: title }), ...kids);

  function viewToday() {
    start();
    ctx.moderation.start();
    loadUsage();
    loadChats();
    const m = ctx.moderation.snapshot();
    const now = serverNow();
    const day = today();
    const events = sotdEvents();

    // Scramble of the Day: times on each board.
    const per = events.map(e => [e, Object.keys(m.results?.[e] || {}).length]);
    const times = per.reduce((n, [, c]) => n + c, 0);
    const featured = L.featured[day];
    const sotd = block(t('Scramble of the Day'),
      el('div', { class: 'ad-stats' },
        stat(times, t('times submitted'), m.dayKey ? null : t('Loading…')),
        stat(per.filter(([, c]) => c).length, t('events played'), t('of {n}', { n: events.length }))),
      el('div', { class: 'ad-chips' }, ...per.filter(([, c]) => c).map(([e, c]) =>
        raw('span', { class: `ad-chip${e === featured ? ' on' : ''}` }, `${evName(e)} · ${c}`))),
      el('p', { class: 'ad-sub', text: featured ? t('Featured today: {event}', { event: evName(featured) }) : t('No featured event today.') }),
      el('a', { class: 'ad-btn small', href: '#days', text: t('Days ahead ›') }));

    // Replays: the Worker's numbers, with the limits in force.
    const u = L.usage;
    const replays = block(t('Shared replays'),
      L.usageErr === 'old' ? el('p', { class: 'ad-sub', text: 'The Worker on this deploy is older than this page: its numbers come with this version’s worker.js.' })
        : L.usageErr ? el('p', { class: 'ad-err', text: 'Couldn’t ask the Worker. Refresh to try again.' })
          : !u ? el('p', { class: 'ad-note ad-small', text: 'Loading…' })
            : el('div', { class: 'ad-stack' },
              el('div', { class: 'ad-meter-row' },
                raw('span', {}, t('{n} of {max} clips', { n: u.clips, max: u.perDay })), meter(u.clips, u.perDay)),
              el('div', { class: 'ad-meter-row' },
                raw('span', {}, t('{used} of {max} MB', { used: mb(u.bytes), max: mb(u.budget) })), meter(u.bytes, u.budget)),
              !u.enabled ? el('span', { class: 'ad-pill warn', text: t('Switched off') }) : null,
              u.audience && u.audience !== 'everyone' ? el('span', { class: 'ad-pill', text: t('On for {who}', { who: audienceLabel(u.audience) }) }) : null));

    // Chat: the day's rooms (read shallow) and the race rooms (the Moderate tab's read).
    const sotdMsgs = L.chats?.day === day ? Object.values(L.chats.counts).reduce((a, b) => a + b, 0) : null;
    let raceMsgs = 0, open = 0, racers = 0;
    const stale = ctx.cfg('race', 'staleRoomMin') * 60_000;
    for (const room of Object.values(m.rooms || {})) {
      raceMsgs += Object.values(room?.chat || {}).filter(c => (c?.at || 0) >= day).length;
      const here = Object.values(room?.players || {}).filter(p => now - (p?.lastSeen || 0) < stale).length;
      if (here) { open++; racers += here; }
    }
    const chat = block(t('Chat'),
      el('div', { class: 'ad-stats' },
        stat(sotdMsgs ?? '…', t('in the day’s rooms')),
        stat(m.roomsRefused ? '—' : raceMsgs, t('in race rooms'))));
    const race = block(t('Race rooms'),
      el('div', { class: 'ad-stats' },
        stat(m.roomsRefused ? '—' : open, t('open now'), m.roomsRefused ? null : t('{n} people in them', { n: racers })),
        stat(m.roomsRefused ? '—' : Object.keys(m.rooms || {}).length, t('made in the last day'))));

    // Moderation and people.
    const banned = Object.values(S.bans).filter(b => !(typeof b?.until === 'number' && b.until <= Date.now())).length;
    const people = block(t('Moderation'),
      el('div', { class: 'ad-stats' },
        el('a', { class: 'ad-stat-link', href: '#mod' }, stat(m.reportsRefused ? '—' : m.reports, t('open reports'))),
        el('a', { class: 'ad-stat-link', href: '#people/bans' }, stat(banned, t('banned'))),
        el('a', { class: 'ad-stat-link', href: '#people/testers' }, stat(Object.keys(S.testers || {}).length, t('testers')))));

    // What is scheduled next.
    const next = ctx.scheduledList().slice(0, 3);
    const scheduled = block(t('Scheduled changes'),
      next.length ? el('ol', { class: 'ad-log' }, ...next.map(ctx.scheduledRow))
        : el('p', { class: 'ad-sub', text: 'Nothing is scheduled. Any setting can be given a time to change, in the sheet that saves it.' }));

    const blind = block(t('What this page can’t see'),
      el('p', { class: 'ad-sub', text: 'None of it is readable from here, so none of it is guessed at.' }),
      el('ul', { class: 'ad-blind' },
        el('li', {},
          el('b', { text: 'Database connections and downloads' }),
          el('span', { text: 'The Spark plan allows 100 connections at once and 10 GB of downloads a month.' }),
          el('a', { href: 'https://console.firebase.google.com/project/tagda-timer/database/tagda-timer-default-rtdb/usage', target: '_blank', rel: 'noopener', text: 'Firebase › Realtime Database › Usage' })),
        el('li', {},
          el('b', { text: 'Worker requests' }),
          el('span', { text: 'Workers Free stops at 100,000 a day.' }),
          el('a', { href: 'https://dash.cloudflare.com/?to=/:account/workers-and-pages', target: '_blank', rel: 'noopener', text: 'Cloudflare › Workers' })),
        el('li', {},
          el('b', { text: 'Billing' }),
          el('span', { text: 'R2 is the only part that bills past its free tier instead of failing, and the Worker keeps it under (DAILY.md §8). Firebase on Spark has no bill.' }),
          el('a', { href: 'https://dash.cloudflare.com/?to=/:account/r2/overview', target: '_blank', rel: 'noopener', text: 'Cloudflare › R2' }),
          el('a', { href: 'https://console.firebase.google.com/project/tagda-timer/usage', target: '_blank', rel: 'noopener', text: 'Firebase › Usage and billing' }))));

    const left = Math.max(0, nextResetMs(now) - now);
    return [
      el('div', { class: 'ad-head-row' },
        el('h1', { class: 'ad-h1', text: 'Today' }),
        el('button', { class: 'ad-btn small', type: 'button', text: 'Refresh', onclick: refresh })),
      raw('p', { class: 'ad-sub' }, t('{day} · resets in {left} (00:00 IST)', { day: dayIdFromServerMs(now), left: formatCountdown(left) })),
      sotd, replays, chat, race, people, scheduled, blind,
    ];
  }

  const audienceLabel = (a) => ({ everyone: t('everybody'), testers: t('testers'), admins: t('admins') })[a] || a;

  /* ---------------- days ahead ---------------- */

  /** Each event's scramble on `day`, read once (they are public). */
  function loadScrambles(day) {
    if (L.scrambles.has(day)) return;
    L.scrambles.set(day, null);
    const evs = SOTD_EVENTS;
    Promise.all(evs.map(e => sdk().get(ref(`daily/${day}/${e}/scramble`)).then(s => s.val(), () => null))).then((vals) => {
      L.scrambles.set(day, Object.fromEntries(evs.map((e, i) => [e, typeof vals[i] === 'string' ? vals[i] : null])));
      ctx.scheduleRender();
    });
  }

  function viewDays(sub) {
    start();
    ctx.moderation.start();
    const base = today();
    const days = Array.from({ length: AHEAD_DAYS }, (_, i) => base + i * DAY_MS);
    const day = days.includes(Number(sub)) ? Number(sub) : base + DAY_MS;
    loadScrambles(day);
    const isToday = day === base;
    const head = [
      el('a', { class: 'ad-back', href: '#today', text: '‹ Today' }),
      el('h1', { class: 'ad-h1', text: 'Days ahead' }),
      el('p', { class: 'ad-sub', text: 'A day’s scramble set by hand takes the place of the random one, for everybody. It can be changed or cleared until the day starts at 00:00 IST; after that it is the day’s, like any other. The featured event is starred in the window and the panel.' }),
      el('nav', { class: 'ad-subtabs', 'aria-label': t('Day') }, ...days.map(k => raw('a', {
        class: `ad-subtab${k === day ? ' on' : ''}`, href: `#days/${k}`, 'aria-current': k === day ? 'page' : null,
      }, dayLabel(k, base) + (L.featured[k] ? ' ★' : '')))),
    ];
    if (L.featuredRefused) return [...head, ctx.gate('Publish the rules first', 'Planning days ahead needs the firebase.rules.json from this version of the page.')];

    const events = sotdEvents();
    const pick = el('select', { class: 'ad-inp', 'aria-label': t('Featured event') },
      raw('option', { value: '' }, t('None')),
      ...events.map(e => raw('option', { value: e }, evName(e))));
    pick.value = L.featured[day] || '';
    pick.addEventListener('change', () => setFeatured(day, pick.value));

    const got = L.scrambles.get(day);
    const rows = !got ? el('p', { class: 'ad-note', text: 'Loading…' })
      : el('ol', { class: 'ad-log' }, ...events.map((e) => {
        const s = got[e];
        const note = s ? null
          : isToday ? t('Not published yet: the first person to open it makes one, unless you set it now.')
            : t('Random, made when the first person opens it.');
        return el('li', { class: 'ad-entry ad-day-row' },
          el('div', { class: 'ad-entry-main' },
            el('b', { text: evName(e) }),
            s ? raw('span', { class: 'ad-scr' }, s) : el('span', { class: 'ad-entry-meta', text: note })),
          el('div', { class: 'ad-entry-actions' },
            (isToday && s) ? el('span', { class: 'ad-pill', text: t('Out') })
              : el('button', { class: 'ad-btn small', type: 'button', text: s ? t('Change') : t('Set'), onclick: () => askScramble(day, e, s) }),
            (!isToday && s) ? el('button', { class: 'ad-btn small danger', type: 'button', text: t('Clear'), onclick: () => askClear(day, e) }) : null));
      }));

    return [...head,
      el('section', { class: 'ad-row' },
        el('label', { class: 'ad-label', text: t('Featured event · {day}', { day: dayLabel(day, base) }) }),
        pick,
        el('p', { class: 'ad-help', text: 'Starred in the Scramble of the Day window, with a way across from any other event. Saved as soon as it is picked.' })),
      el('h2', { class: 'ad-h2 ad-gap', text: t('Scrambles · {day}', { day: dayLabel(day, base) }) }),
      rows];
  }

  async function setFeatured(day, ev) {
    try {
      if (ev) await sdk().set(ref(`sotdFeatured/${day}`), ev);
      else await sdk().remove(ref(`sotdFeatured/${day}`));
      toast(ev ? t('{event} is featured {day}', { event: evName(ev), day: dayLabel(day).toLowerCase() }) : t('No featured event {day}', { day: dayLabel(day).toLowerCase() }), { kind: 'good' });
    } catch (err) {
      console.warn('[admin] featured refused', err?.code || err);
      toast(t('The database refused that'), { kind: 'bad', hold: true });
      ctx.scheduleRender();
    }
  }

  function askScramble(day, e, cur) {
    const n = cubeSizeFor(e);
    const area = el('textarea', { class: 'ad-inp ad-scr-inp', rows: 3, maxlength: 600, spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', 'aria-label': t('Scramble') });
    area.value = cur || '';
    const canvas = n ? el('canvas', { class: 'ad-net', width: 640, height: 480, 'aria-hidden': 'true' }) : null;
    const note = el('p', { class: 'ad-help' });
    const save = el('button', { class: 'ad-btn primary', type: 'button', text: t('Save') });
    const text = () => area.value.trim().replace(/\s+/g, ' ');
    const check = () => {
      const s = text();
      let ok = s.length > 0 && s.length <= 600;
      if (n) {
        const toks = s ? parseAlg(s) : null;
        ok = ok && !!toks;
        note.textContent = !s ? '' : toks ? t('{n} moves', { n: toks.length }) : t('This page can’t read that as a {event} scramble: check the notation.', { event: evName(e) });
        const g = canvas.getContext('2d');
        g.clearRect(0, 0, canvas.width, canvas.height);
        if (toks) drawNet(g, faceletsFor(s, n), n, 0, 0, canvas.width, canvas.height);
      } else {
        note.textContent = t('This page can’t draw a {event} scramble: check it carefully before saving.', { event: evName(e) });
      }
      save.disabled = !ok;
    };
    area.addEventListener('input', check);
    save.addEventListener('click', async () => {
      save.disabled = true;
      const s = text();
      try {
        await sdk().set(ref(`daily/${day}/${e}/scramble`), s);
        const got = L.scrambles.get(day);
        if (got) got[e] = s;
        ctx.closeSheet();
        toast(t('Saved: {event}, {day}', { event: evName(e), day: dayLabel(day).toLowerCase() }), { kind: 'good' });
        ctx.scheduleRender();
      } catch (err) {
        console.warn('[admin] scramble refused', err?.code || err);
        // Today's, published a moment ago by somebody opening the window: it is the day's now.
        L.scrambles.delete(day);
        toast(day === today() ? t('Somebody opened it first: today’s scramble is out and can’t change.') : t('The database refused that'), { kind: 'bad', hold: true });
        ctx.closeSheet();
        ctx.scheduleRender();
      }
    });
    ctx.openSheet(
      el('h2', { class: 'ad-h2', text: t('{event} · {day}', { event: evName(e), day: dayLabel(day) }) }),
      area, canvas, note,
      el('p', { class: 'ad-sub', text: day === today()
        ? 'Nobody has opened today’s yet, so this becomes today’s scramble. As soon as anybody opens the window it is out, and it can’t change.'
        : 'It takes the place of the random one for everybody. You can change or clear it until the day starts. The backup scramble (DAILY.md §7) is still made at random.' }),
      el('div', { class: 'ad-sheet-actions' },
        el('button', { class: 'ad-btn', type: 'button', text: 'Back', onclick: ctx.closeSheet }),
        save));
    check();
    area.focus();
  }

  function askClear(day, e) {
    const go = el('button', { class: 'ad-btn primary', type: 'button', text: t('Clear it') });
    go.addEventListener('click', async () => {
      go.disabled = true;
      try {
        await sdk().remove(ref(`daily/${day}/${e}/scramble`));
        const got = L.scrambles.get(day);
        if (got) got[e] = null;
        ctx.closeSheet();
        toast(t('Cleared. That day gets a random one.'), { kind: 'good' });
        ctx.scheduleRender();
      } catch (err) {
        console.warn('[admin] clear refused', err?.code || err);
        toast(t('The database refused that'), { kind: 'bad', hold: true });
        go.disabled = false;
      }
    });
    ctx.openSheet(
      el('h2', { class: 'ad-h2', text: t('Clear the {event} scramble for {day}?', { event: evName(e), day: dayLabel(day).toLowerCase() }) }),
      el('div', { class: 'ad-sheet-actions' },
        el('button', { class: 'ad-btn', type: 'button', text: 'Back', onclick: ctx.closeSheet }),
        go));
  }

  /* ---------------- testers ---------------- */

  function viewTesters() {
    const field = (label, input) => el('label', { class: 'ad-field' }, el('span', { class: 'ad-label', text: label }), input);
    const find = el('input', { class: 'ad-inp', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', maxlength: 128 });
    const name = el('input', { class: 'ad-inp', autocomplete: 'off', maxlength: 32 });
    const picks = el('div', { class: 'ad-chips ad-picks' });
    const known = () => ctx.moderation.people().filter(p => !S.testers?.[p.uid]);
    const suggest = () => {
      const q = find.value.trim().toLowerCase();
      const list = q.length < 2 ? [] : known().filter(p => p.name.toLowerCase().includes(q) || p.uid.toLowerCase().startsWith(q)).slice(0, 6);
      picks.replaceChildren(...list.map(p => el('button', {
        class: 'ad-chip', type: 'button',
        onclick: () => { find.value = p.uid; name.value = p.name; picks.replaceChildren(); },
      }, raw('span', {}, p.name || t('Cuber')), raw('span', { class: 'ad-uid' }, `${p.uid.slice(0, 8)}…`))));
    };
    find.addEventListener('input', suggest);
    const form = el('form', { class: 'ad-row ad-ban-form' },
      el('b', { text: 'Add a tester' }),
      field(t('Name or account id'), find),
      picks,
      el('p', { class: 'ad-help', text: 'Names come from today’s boards and chats. Anybody else: their account id, from a ban sheet or the Firebase console.' }),
      field(t('Name, for this list'), name),
      el('div', { class: 'ad-sheet-actions' }, el('button', { class: 'ad-btn primary', type: 'submit', text: 'Add' })));
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const uid = find.value.trim();
      if (!UID_RE.test(uid)) { toast(t('That is not an account id: letters and digits only'), { kind: 'bad', long: true }); return; }
      try {
        await addTester(sdk(), { uid, name: name.value.trim() });
        toast(t('Added. They get what is on for testers the next time they open it.'), { kind: 'good', long: true });
        find.value = ''; name.value = '';
      } catch (err) {
        console.warn('[admin] tester refused', err?.code || err);
        toast(t('The database refused that'), { kind: 'bad', hold: true });
      }
    });
    const head = el('p', { class: 'ad-sub', text: 'A tester gets every feature whose audience is “testers” before everybody does, and any announcement for testers. Admins get all of it too. It needs a Google sign-in on the timer.' });
    if (S.testersRefused) return [head, ctx.gate('Publish the rules first', 'Testers need the firebase.rules.json from this version of the page.')];
    const rows = Object.entries(S.testers || {}).sort((a, b) => (b[1]?.at || 0) - (a[1]?.at || 0));
    return [head, form,
      el('h2', { class: 'ad-h2 ad-gap', text: 'Testers now' }),
      !S.loaded.testers ? el('p', { class: 'ad-note', text: 'Loading…' })
        : !rows.length ? el('p', { class: 'ad-note', text: 'Nobody yet.' })
          : el('ol', { class: 'ad-log' }, ...rows.map(([uid, r]) => el('li', { class: 'ad-entry' },
            el('div', { class: 'ad-entry-main' },
              raw('b', {}, r?.name || uid),
              raw('span', { class: 'ad-uid' }, uid),
              raw('span', { class: 'ad-entry-meta' }, [ago(r?.at), r?.by ? t('by {who}', { who: who(r.by) }) : ''].filter(Boolean).join(' · '))),
            el('button', { class: 'ad-btn small', type: 'button', text: t('Remove'), onclick: () => askRemove(uid, r) }))))];
  }

  function askRemove(uid, r) {
    const go = el('button', { class: 'ad-btn primary', type: 'button', text: t('Remove') });
    go.addEventListener('click', async () => {
      go.disabled = true;
      try { await removeTester(sdk(), uid); ctx.closeSheet(); toast(t('Removed'), { kind: 'good' }); }
      catch (err) {
        console.warn('[admin] tester removal refused', err?.code || err);
        toast(t('The database refused that'), { kind: 'bad', hold: true });
        go.disabled = false;
      }
    });
    ctx.openSheet(
      el('h2', { class: 'ad-h2', text: t('Take {who} off the testers?', { who: r?.name || uid }) }),
      el('p', { class: 'ad-sub', text: 'What is on for testers only goes away for them the next time they open it.' }),
      el('div', { class: 'ad-sheet-actions' },
        el('button', { class: 'ad-btn', type: 'button', text: 'Back', onclick: ctx.closeSheet }),
        go));
  }

  return { start, stop, viewToday, viewDays, viewTesters };
}
