import { t } from './i18n.js';
/* ===========================================================
   Tagda Timer — the admin console's Health tab (js/admin.js)

   What signed-in timers report about themselves (js/health.js; ADMIN.md
   "Health"), so a broken sync, a stranded version, a slow scramble or an
   error shows up here before anybody has to say so.

     Sync       stuck queues (changes waiting over an hour), writes the
                queue had to drop, and 14 days of how many people were stuck
     Versions   today's people by version, when it is safe to raise
                app.minVersion, and self-heals per version (a missed ?v= bump)
     Scrambles  how long each event's scramble takes, per browser family
     Errors     14 days of error reports, grouped, newest first; Mark known

   Today is read live (one listener on health/<today>); the 14 days and the
   errors are read once when the tab opens and on Refresh. Days past 14 are
   swept when the page opens, as the Today tab does for turnDay/.
   =========================================================== */

import { el } from './util.js';
import { toast } from './toast.js';
import { dayKeyFromServerMs } from './dayid.js';
import { eventOf, EVENT_ORDER } from './events.js';
import { APP_VERSION } from './version.js';
import { FIREBASE_CONFIG } from './raceapp.js';
import { EMULATED } from './sync-auth.js';

const DAY_MS = 86_400_000;
const IST_MS = 19_800_000;
const KEEP_DAYS = 14;
/** A queue with changes older than this is stuck. */
const STUCK_MIN = 60;
/** A scramble slower than this (p95) is drawn in the warning colour. */
const SLOW_MS = 3000;
/** Share of today's people on a version or newer before minVersion can go up to it. */
const SAFE_SHARE = 0.95;

const FAMILY = { chrome: 'Chrome', firefox: 'Firefox', safari: 'Safari', edge: 'Edge', other: 'Other' };

/**
 * @param ctx  { S, scheduleRender, raw, ago, who, openSheet, closeSheet, gate, cfg, moderation, stage }
 *             stage(path, value) puts a setting change on the Settings tab's save bar.
 */
export function createHealth(ctx) {
  const { S, raw, ago } = ctx;
  const H = {
    started: false, unsubs: [],
    today: null, todayRefused: false,
    days: null, daysBusy: false, daysAt: 0,
    errors: null, errorsBusy: false, errorsRefused: false,
    known: {}, showKnown: false,
    swept: false,
  };
  const sdk = () => S.sdk;
  const ref = (path) => sdk().ref(sdk().db, path);
  const now = () => Date.now() + (ctx.moderation.offset() || 0);
  const today = () => Number(dayKeyFromServerMs(now()));
  const dayLabel = (key) => new Date(key + IST_MS).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });

  /* ---------------- reading ---------------- */

  function start() {
    if (H.started || !S.sdk) return;
    H.started = true;
    const day = today();
    H.unsubs.push(
      sdk().onValue(ref(`health/${day}`), (s) => { H.today = { day, recs: s.val() || {} }; H.todayRefused = false; ctx.scheduleRender(); },
        () => { H.todayRefused = true; ctx.scheduleRender(); }),
      sdk().onValue(ref('errorsKnown'), (s) => { H.known = s.val() || {}; ctx.scheduleRender(); }, () => {}),
    );
    loadDays();
    loadErrors();
    sweep();
  }

  function stop() {
    for (const off of H.unsubs.splice(0)) off();
    Object.assign(H, { started: false, today: null, days: null, daysAt: 0, errors: null, known: {}, swept: false });
  }

  async function loadDays(force = false) {
    if (H.daysBusy || (!force && H.days)) return;
    H.daysBusy = true;
    const { get, query, orderByKey, startAt } = sdk();
    try {
      const s = await get(query(ref('health'), orderByKey(), startAt(String(today() - (KEEP_DAYS - 1) * DAY_MS))));
      H.days = s.val() || {};
    } catch { H.days = {}; }
    H.daysBusy = false;
    ctx.scheduleRender();
  }

  async function loadErrors(force = false) {
    if (H.errorsBusy || (!force && H.errors)) return;
    H.errorsBusy = true;
    const { get, query, orderByKey, startAt } = sdk();
    try {
      const s = await get(query(ref('errors'), orderByKey(), startAt(String(today() - (KEEP_DAYS - 1) * DAY_MS))));
      H.errors = s.val() || {};
      H.errorsRefused = false;
    } catch { H.errors = {}; H.errorsRefused = true; }
    H.errorsBusy = false;
    ctx.scheduleRender();
  }

  /* Days past KEEP_DAYS, read shallow over REST (the SDK cannot) and deleted, once a page load. */
  async function sweep() {
    if (H.swept) return;
    H.swept = true;
    const token = await S.user.getIdToken();
    const base = EMULATED ? 'http://127.0.0.1:9000' : FIREBASE_CONFIG.databaseURL;
    const ns = EMULATED ? '&ns=tagda-timer-default-rtdb' : '';
    const cut = today() - KEEP_DAYS * DAY_MS;
    const gone = {};
    for (const node of ['health', 'errors']) {
      try {
        const r = await fetch(`${base}/${node}.json?shallow=true&auth=${encodeURIComponent(token)}${ns}`, { cache: 'no-store' });
        if (!r.ok) continue;
        for (const k of Object.keys((await r.json()) || {})) if (Number(k) < cut) gone[`${node}/${k}`] = null;
      } catch { /* next time */ }
    }
    if (Object.keys(gone).length) {
      await sdk().update(sdk().ref(sdk().db), gone).catch(err => console.warn('[admin] health sweep refused', err?.code || err));
    }
  }

  function refresh() {
    loadDays(true);
    loadErrors(true);
  }

  /* ---------------- what the records say ---------------- */

  const recs = () => (H.today?.day === today() ? Object.entries(H.today.recs || {}) : []);
  const stuck = (r) => (r?.q || 0) > 0 && (r?.qOldestMin || 0) > STUCK_MIN;

  /** Every error group over the kept days: { hash, msg, where, n, users, vers, first, last, firstVer, days }. */
  function errorGroups() {
    const by = new Map();
    for (const [day, hashes] of Object.entries(H.errors || {})) {
      for (const [hash, e] of Object.entries(hashes || {})) {
        const g = by.get(hash) || { hash, msg: e?.msg || '', where: e?.where || '', n: 0, users: new Set(), vers: new Set(), uas: new Set(), first: Infinity, last: 0, firstVer: Infinity, days: new Set() };
        g.msg ||= e?.msg || '';
        g.where ||= e?.where || '';
        g.days.add(Number(day));
        for (const [uid, u] of Object.entries(e?.u || {})) {
          g.n += u?.n || 0;
          g.users.add(uid);
          if (Number.isFinite(u?.ver)) { g.vers.add(u.ver); g.firstVer = Math.min(g.firstVer, u.ver); }
          if (u?.ua) g.uas.add(u.ua);
          g.first = Math.min(g.first, u?.first || Infinity);
          g.last = Math.max(g.last, u?.last || 0);
        }
        by.set(hash, g);
      }
    }
    return [...by.values()].sort((a, b) => b.last - a.last);
  }

  /** The three numbers on Today. */
  function summary() {
    const list = recs().map(([, r]) => r);
    const day = today();
    const fresh = errorGroups().filter(g => !H.known[g.hash] && Math.min(...g.days) === day).length;
    return {
      loaded: !!H.today, refused: H.todayRefused,
      people: list.length,
      stuck: list.filter(stuck).length,
      old: list.filter(r => (r?.ver || 0) < APP_VERSION).length,
      newErrors: H.errors ? fresh : null,
    };
  }

  /* ---------------- views ---------------- */

  const SUBS = () => [['sync', t('Sync')], ['versions', t('Versions')], ['scrambles', t('Scrambles')], ['errors', t('Errors')], ['storage', t('Storage')]];
  const block = (title, ...kids) => el('section', { class: 'ac-block' }, el('h2', { class: 'ac-h2', text: title }), ...kids);
  const stat = (value, label, sub = null) => el('div', { class: 'ac-stat' },
    raw('b', { class: 'ac-stat-n' }, String(value)), el('span', { class: 'ac-stat-label', text: label }),
    sub ? raw('span', { class: 'ac-stat-sub' }, sub) : null);
  const device = (r) => `${FAMILY[r?.ua] || r?.ua || '?'} · ${r?.os || '?'}${r?.phone ? ` · ${t('phone')}` : ''} · v${r?.ver ?? '?'}`;
  const minutes = (m) => (m < 120 ? t('{n} min', { n: m }) : m < 2880 ? t('{n} h', { n: Math.round(m / 60) }) : t('{n} days', { n: Math.round(m / 1440) }));
  const people = (n) => (n === 1 ? t('1 person') : t('{n} people', { n }));
  const times = (n) => (n === 1 ? t('once') : t('{n} times', { n }));
  const copy = (uid) => el('button', { class: 'ac-link ac-uid', text: uid, title: t('Copy'),
    onclick: () => navigator.clipboard?.writeText(uid).then(() => toast(t('Copied'))) });

  function view(sub) {
    start();
    const s = summary();
    const nav = el('nav', { class: 'ac-subtabs', 'aria-label': t('Health') },
      ...SUBS().map(([key, label]) => raw('a', {
        class: `ac-subtab${sub === key ? ' on' : ''}`, href: `#health/${key}`, 'aria-current': sub === key ? 'page' : null,
      }, label)));
    // Five across a phone run off its edge: the one you are on is kept in view (as Moderate's are).
    requestAnimationFrame(() => {
      const cur = nav.querySelector('.ac-subtab.on');
      const over = cur && nav.isConnected ? cur.getBoundingClientRect().right - nav.getBoundingClientRect().right : 0;
      if (over > 0) nav.scrollLeft += over + 12;
    });
    const head = [
      el('div', { class: 'ac-head-row' },
        el('h1', { class: 'ac-h1', text: 'Health' }),
        el('button', { class: 'ac-btn small', type: 'button', text: 'Refresh', onclick: refresh })),
      el('p', { class: 'ac-sub', text: s.loaded ? t('{n} signed-in people reported today.', { n: s.people }) : t('Loading…') }),
      nav,
    ];
    if (H.todayRefused) return [...head, ctx.gate('Publish the rules first', 'The Health tab needs the firebase.rules.json from this version of the page. Until then no timer can send a heartbeat.')];
    if (sub === 'versions') return [...head, ...viewVersions()];
    if (sub === 'scrambles') return [...head, ...viewScrambles()];
    if (sub === 'errors') return [...head, ...viewErrors()];
    if (sub === 'storage') return [...head, ...ctx.storage().view()];
    return [...head, ...viewSync()];
  }

  function viewSync() {
    const list = recs();
    const stuckList = list.filter(([, r]) => stuck(r)).sort((a, b) => (b[1].qOldestMin || 0) - (a[1].qOldestMin || 0));
    const lost = list.filter(([, r]) => (r?.dropped || 0) > 0).sort((a, b) => b[1].dropped - a[1].dropped);
    const row = (uid, r, line) => el('li', { class: 'ac-entry' },
      el('div', { class: 'ac-entry-main' },
        raw('b', {}, line),
        raw('span', { class: 'ac-entry-meta' }, `${device(r)} · ${t('last heard {when}', { when: ago(r?.at) })}`),
        r?.lastErr ? raw('span', { class: 'ac-flag' }, t('last error: {code}', { code: r.lastErr })) : null,
        copy(uid)));
    // 14 days: of the people who reported each day, how many were stuck.
    const days = Array.from({ length: KEEP_DAYS }, (_, i) => today() - (KEEP_DAYS - 1 - i) * DAY_MS);
    const trend = days.map((d) => {
      const day = d === today() && H.today ? H.today.recs : H.days?.[d] || {};
      const all = Object.values(day || {});
      return { d, n: all.length, stuck: all.filter(stuck).length };
    });
    const top = Math.max(1, ...trend.map(x => (x.n ? x.stuck / x.n : 0)));
    return [
      block(t('Stuck syncs'),
        el('p', { class: 'ac-sub', text: t('Changes waiting on a device for over an hour. A queue that stops moving is how the sync freeze in #151 looked.') }),
        stuckList.length ? el('ol', { class: 'ac-log ac-tight' }, ...stuckList.map(([uid, r]) =>
          row(uid, r, t('{n} changes waiting for {age}', { n: r.q, age: minutes(r.qOldestMin) }))))
          : el('p', { class: 'ac-note', text: H.today ? 'Nobody is stuck today.' : 'Loading…' })),
      block(t('Lost writes'),
        el('p', { class: 'ac-sub', text: t('Changes the database could never store, dropped so they stop holding up the rest (#152). Still saved on that device.') }),
        lost.length ? el('ol', { class: 'ac-log ac-tight' }, ...lost.map(([uid, r]) =>
          row(uid, r, t('{n} dropped today', { n: r.dropped }))))
          : el('p', { class: 'ac-note', text: H.today ? 'None today.' : 'Loading…' })),
      block(t('Stuck, the last 14 days'),
        el('p', { class: 'ac-sub', text: t('Of the people who reported each day, the share with a stuck sync. A jump after a deploy means that deploy broke sync.') }),
        el('div', { class: 'ac-bars', role: 'img', 'aria-label': t('Stuck syncs by day') }, ...trend.map(x => el('div', { class: 'ac-bar-col', title: `${dayLabel(x.d)}: ${x.stuck}/${x.n}` },
          el('i', { class: `ac-bar${x.stuck ? ' hot' : ''}`, style: { height: `${x.n ? Math.max(3, (x.stuck / x.n / top) * 100) : 0}%` } }),
          raw('span', { class: 'ac-bar-x' }, String(new Date(x.d + IST_MS).getUTCDate()))))),
        H.days ? null : el('p', { class: 'ac-note ac-small', text: 'Loading…' })),
    ];
  }

  function viewVersions() {
    const list = recs().map(([, r]) => r);
    const by = new Map();
    for (const r of list) {
      const v = r?.ver ?? 0;
      const x = by.get(v) || { v, n: 0, heals: 0 };
      x.n++;
      x.heals += r?.swHeals || 0;
      by.set(v, x);
    }
    const vers = [...by.values()].sort((a, b) => b.v - a.v);
    const total = list.length;
    const min = ctx.cfg('app', 'minVersion');
    // The newest version at least SAFE_SHARE of today's people are on (or past), when it is above minVersion.
    let safe = null, run = 0;
    for (const x of vers) {
      run += x.n;
      if (total && run / total >= SAFE_SHARE) { safe = x.v; break; }
    }
    const canRaise = safe != null && safe > min && safe <= APP_VERSION;
    return [
      block(t('Versions today'),
        el('p', { class: 'ac-sub', text: t('This deploy is version {v}. app.minVersion is {min}.', { v: APP_VERSION, min }) }),
        vers.length ? el('div', { class: 'ac-stack' }, ...vers.map(x => el('div', { class: 'ac-meter-row' },
          raw('span', {}, `v${x.v}${x.v === APP_VERSION ? ` · ${t('this deploy')}` : ''} · ${people(x.n)}`
            + (x.heals ? ` · ${t('{n} self-heals', { n: x.heals })}` : '')),
          el('div', { class: `ac-meter${x.v === APP_VERSION ? '' : ' hot'}` }, el('i', { style: { width: `${Math.round((x.n / total) * 100)}%` } })))))
          : el('p', { class: 'ac-note', text: H.today ? 'Nobody has reported today yet.' : 'Loading…' }),
        canRaise ? el('div', { class: 'ac-stack' },
          el('p', { class: 'ac-sub', text: t('Safe to raise app.minVersion to {v}: {pct}% of today’s people are on it or newer. The rest reload once their timer is idle.', { v: safe, pct: Math.floor((run / total) * 100) }) }),
          el('button', { class: 'ac-btn small', text: t('Raise to {v}…', { v: safe }), onclick: () => ctx.stage('app/minVersion', safe) }))
          : null,
        el('p', { class: 'ac-note ac-small', text: 'A self-heal is a page that found two deploys mixed in its cache and reloaded (#125). Heals on a new version mean its ?v= bump was missed.' })),
    ];
  }

  function viewScrambles() {
    // event -> family -> [p95 per person]
    const cells = new Map();
    for (const [, r] of recs()) {
      for (const [ev, ms] of Object.entries(r?.scr || {})) {
        const fam = r?.ua || 'other';
        if (!cells.has(ev)) cells.set(ev, new Map());
        const m = cells.get(ev);
        m.set(fam, [...(m.get(fam) || []), ms]);
      }
    }
    const median = (a) => { const s = [...a].sort((x, y) => x - y); const i = s.length >> 1; return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2; };
    const rank = (e) => { const i = EVENT_ORDER.indexOf(e); return i < 0 ? 999 : i; };
    const evs = [...cells.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    const secs = (ms) => (ms < 10_000 ? (ms / 1000).toFixed(2) : (ms / 1000).toFixed(1)) + ' s';
    return [
      block(t('Scramble speed today'),
        el('p', { class: 'ac-sub', text: t('How long an official scramble takes to make, per browser: the middle of each person’s slowest-in-twenty (p95). Over 3 s is in the warning colour. Square-1 in Firefox was 15 s before #162.') }),
        evs.length ? el('ol', { class: 'ac-log ac-tight' }, ...evs.map(ev => el('li', { class: 'ac-entry' },
          el('div', { class: 'ac-entry-main' },
            raw('b', {}, eventOf(ev)?.short || ev),
            el('div', { class: 'ac-chips' }, ...[...cells.get(ev)].sort((a, b) => b[1].length - a[1].length).map(([fam, list]) => {
              const p = median(list);
              return raw('span', { class: `ac-chip${p > SLOW_MS ? ' hot' : ''}` }, `${FAMILY[fam] || fam} ${secs(p)} · ${list.length}`);
            }))))))
          : el('p', { class: 'ac-note', text: H.today ? 'No scramble times reported today yet.' : 'Loading…' })),
    ];
  }

  function viewErrors() {
    if (H.errorsRefused) return [ctx.gate('Publish the rules first', 'Error reports need the firebase.rules.json from this version of the page.')];
    if (!H.errors) return [el('p', { class: 'ac-note', text: 'Loading…' })];
    const all = errorGroups();
    const known = all.filter(g => H.known[g.hash]);
    const list = H.showKnown ? all : all.filter(g => !H.known[g.hash]);
    const toggle = known.length ? el('button', { class: 'ac-link', text: H.showKnown ? t('Hide the {n} marked known', { n: known.length }) : t('Show the {n} marked known', { n: known.length }),
      onclick: () => { H.showKnown = !H.showKnown; ctx.scheduleRender(); } }) : null;
    return [
      block(t('Errors, the last 14 days'),
        el('p', { class: 'ac-sub', text: t('What broke on people’s screens, grouped by message and place, newest first. Each device sends at most five different ones a page load.') }),
        toggle,
        list.length ? el('ol', { class: 'ac-log ac-tight' }, ...list.map(g => {
          const k = H.known[g.hash];
          const vers = [...g.vers].sort((a, b) => b - a);
          return el('li', { class: `ac-entry${k ? ' ac-ended' : ''}` },
            el('div', { class: 'ac-entry-main' },
              raw('b', { class: 'ac-err-msg' }, g.msg),
              raw('span', { class: 'ac-uid' }, g.where),
              raw('span', { class: 'ac-entry-meta' }, [times(g.n), people(g.users.size), [...g.uas].map(f => FAMILY[f] || f).join(', ') || '?'].join(' · ')),
              raw('span', { class: 'ac-entry-meta' }, t('first seen {when} in v{v} · last {last} · versions {vers}', {
                when: ago(g.first), v: Number.isFinite(g.firstVer) ? g.firstVer : '?', last: ago(g.last), vers: vers.join(', ') || '?' })),
              k ? raw('span', { class: 'ac-flag' }, t('marked known {when} by {who}', { when: ago(k.at), who: ctx.who(k.by) }) + (k.note ? ` · ${k.note}` : '')) : null),
            el('div', { class: 'ac-entry-actions' },
              k ? el('button', { class: 'ac-btn small', text: t('Unmark'), onclick: () => mark(g.hash, null) })
                : el('button', { class: 'ac-btn small', text: t('Mark known'), onclick: () => askMark(g) })));
        })) : el('p', { class: 'ac-note', text: all.length ? 'Every error is marked known.' : 'No errors reported in the last 14 days.' })),
    ];
  }

  function askMark(g) {
    const note = el('input', { class: 'ac-inp', maxlength: 200, placeholder: t('A note (optional): what it is, what is being done') });
    ctx.openSheet(
      el('h2', { class: 'ac-h2', text: t('Mark this error known?') }),
      raw('p', { class: 'ac-reason' }, g.msg),
      el('p', { class: 'ac-sub', text: t('It leaves the list and the count on Today. Reports keep coming in, and Show marked known brings it back.') }),
      el('div', { class: 'ac-text' }, note),
      el('div', { class: 'ac-sheet-actions' },
        el('button', { class: 'ac-btn', text: 'Back', onclick: ctx.closeSheet }),
        el('button', { class: 'ac-btn primary', text: t('Mark known'), onclick: () => mark(g.hash, note.value.trim()) })));
  }

  async function mark(hash, note) {
    try {
      await sdk().set(ref(`errorsKnown/${hash}`), note === null ? null
        : { by: S.user.uid, at: sdk().serverTimestamp(), ...(note ? { note: note.slice(0, 200) } : {}) });
      ctx.closeSheet();
    } catch (err) {
      console.warn('[admin] mark known refused', err?.code || err);
      toast(t('The database refused that'), { kind: 'bad', hold: true });
    }
  }

  /** Today's three numbers (js/admin-live.js), each opening its view. */
  function todayBlock() {
    start();
    const s = summary();
    const link = (href, value, label) => el('a', { class: 'ac-stat-link', href }, stat(value, label));
    return el('section', { class: 'ac-block' },
      el('h2', { class: 'ac-h2', text: t('Health') }),
      s.refused ? el('p', { class: 'ac-sub', text: 'The heartbeat needs this version’s firebase.rules.json published.' })
        : el('div', { class: 'ac-stats' },
          link('#health/sync', s.loaded ? s.stuck : '…', t('stuck syncs')),
          link('#health/errors', s.newErrors ?? '…', t('new errors today')),
          link('#health/versions', s.loaded ? s.old : '…', t('people on an older version'))));
  }

  /** One person's error groups over the kept days (null while loading), and the paths of their own entries. */
  function errorsOf(uid) {
    start();
    if (!H.errors) return null;
    const out = [];
    for (const [day, hashes] of Object.entries(H.errors)) {
      for (const [hash, e] of Object.entries(hashes || {})) if (e?.u?.[uid]) out.push({ day: Number(day), hash, msg: e.msg, where: e.where, n: e.u[uid].n, path: `errors/${day}/${hash}/u/${uid}` });
    }
    return out.sort((a, b) => b.day - a.day);
  }
  /** One person's heartbeats over the kept days: [[day, record]], newest first, or null while loading. */
  function beatsOf(uid) {
    start();
    if (!H.days) return null;
    const all = { ...H.days, ...(H.today ? { [H.today.day]: H.today.recs } : {}) };
    return Object.entries(all).filter(([, recs]) => recs?.[uid]).map(([d, recs]) => [Number(d), recs[uid]]).sort((a, b) => b[0] - a[0]);
  }

  return { view, start, stop, todayBlock, summary, errorsOf, beatsOf };
}
