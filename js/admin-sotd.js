import { t } from './i18n.js';
/* ===========================================================
   Tagda Timer — the admin console's Moderate › SOTD (js/admin.js; ADMIN.md §18)

     Held for a look   today's times under their event's floor (sotd.floors)
                       that nobody has looked at: Keep (the board's
                       "checking" mark goes), Set to +2, Set to DNF, Remove
                       (the #141 removal: they get the backup)
     Today's boards    one event at a time: any result re-timed (+2, DNF,
                       none), a shared replay featured for the day, removed
     Past days         the last seven days: each event's winner, entries and
                       removals, read once on asking

   Today's results come from the Moderate tab's listeners (admin-mod.js), so
   this tab adds no listener but the day's featured replay.
   =========================================================== */

import { el } from './util.js';
import { toast } from './toast.js';
import { eventOf } from './events.js';
import { setOf } from './config.js';
import { SOTD_EVENTS, floorsOf } from './config-table.js';
import { pastDayKeys } from './dayid.js';
import { logged } from './moderation.js';

const IST_MS = 19_800_000;
const PAST_DAYS = 7;

/**
 * @param ctx  { S, scheduleRender, raw, ago, who, openSheet, closeSheet, askBan, gate, cfg, moderation }
 */
export function createSotd(ctx) {
  const { S, raw, ago } = ctx;
  const Q = { day: null, off: null, featured: undefined, featuredRefused: false, event: null, past: null, pastBusy: false };
  const sdk = () => S.sdk;
  const ref = (path) => sdk().ref(sdk().db, path);
  // Today is the Moderate tab's day: its listeners follow 00:00 IST.
  const today = () => ctx.moderation.snapshot().dayKey;
  const events = () => setOf(ctx.cfg('sotd', 'events')).filter(e => SOTD_EVENTS.includes(e));
  const evName = (e) => eventOf(e)?.short || e;
  const eff = (r) => (!r || r.penalty === 'DNF' ? Infinity : (r.timeMs || 0) + (r.penalty === '+2' ? 2000 : 0));
  const timeText = (r) => (!r ? '—' : r.penalty === 'DNF' ? 'DNF'
    : `${(Math.floor(eff(r) / 10) / 100).toFixed(2)}${r.penalty === '+2' ? '+' : ''}`);

  /** Watch the day's featured replay, following the Moderate tab's day. */
  function start() {
    if (!S.sdk) return;
    ctx.moderation.start();
    const day = today();
    if (!day || day === Q.day) return;
    Q.off?.();
    Object.assign(Q, { day, featured: undefined, featuredRefused: false, past: null });
    Q.off = sdk().onValue(ref(`sotdFeaturedReplay/${day}`), (s) => { Q.featured = s.val(); Q.featuredRefused = false; ctx.scheduleRender(); },
      () => { Q.featured = null; Q.featuredRefused = true; ctx.scheduleRender(); });
  }

  function stop() {
    Q.off?.();
    Object.assign(Q, { day: null, off: null, featured: undefined, featuredRefused: false, past: null });
  }

  /* ---------------- what is held ---------------- */

  /** Under its event's floor with nobody's look yet: shown "checking" on the board. */
  const isHeld = (ev, row) => { const f = floorsOf(ctx.cfg('sotd', 'floors'))[ev]; return !!f && !row?.review && Number.isFinite(eff(row)) && eff(row) < f; };

  /** Today's times under their event's floor with no review yet: [{ ev, uid, row, floor }], fastest first. */
  function held() {
    const floors = floorsOf(ctx.cfg('sotd', 'floors'));
    const out = [];
    for (const [ev, rows] of Object.entries(ctx.moderation.snapshot().results || {})) {
      for (const [uid, row] of Object.entries(rows || {})) if (isHeld(ev, row)) out.push({ ev, uid, row, floor: floors[ev] });
    }
    return out.sort((a, b) => eff(a.row) - eff(b.row));
  }

  /* ---------------- the actions ---------------- */

  /** One update, logged in the moderation log (ADMIN.md §19). */
  async function write(updates, done, entry) {
    try {
      await logged(sdk(), updates, entry);
      ctx.closeSheet();
      if (done) toast(done, { kind: 'good' });
      return true;
    } catch (err) {
      console.warn('[admin] sotd write refused', err?.code || err);
      toast(t('Refused: these tools need this version’s firebase.rules.json published'), { kind: 'bad', hold: true });
      return false;
    }
  }

  const base = (ev, uid) => `daily/${today()}/${ev}/results/${uid}`;
  const keep = (ev, uid, row) => write({ [`${base(ev, uid)}/review`]: { by: S.user.uid, at: sdk().serverTimestamp(), keep: true } }, t('Kept: the mark is gone'),
    { action: 'keep', path: base(ev, uid), uid, note: timeText(row) });
  const retime = (ev, uid, penalty, row) => write({ [`${base(ev, uid)}/penalty`]: penalty },
    penalty === 'none' ? t('Penalty cleared') : t('Set to {p}', { p: penalty }),
    { action: 'retime', path: base(ev, uid), uid, before: row?.penalty || 'none', note: penalty });
  const feature = (ev, uid) => write({ [`sotdFeaturedReplay/${today()}`]: { event: ev, uid } }, t('Featured'),
    { action: 'feature', path: `sotdFeaturedReplay/${today()}`, uid, before: Q.featured || null, note: evName(ev) });
  const unfeature = () => write({ [`sotdFeaturedReplay/${today()}`]: null }, t('No featured replay'),
    { action: 'unfeature', path: `sotdFeaturedReplay/${today()}`, uid: Q.featured?.uid || '', before: Q.featured || null });

  function askRetime(ev, uid, row, penalty) {
    ctx.openSheet(
      el('h2', { class: 'ac-h2', text: penalty === 'none' ? t('Clear {name}’s penalty?', { name: row.name || 'Cuber' })
        : t('Set {name}’s {event} time to {p}?', { name: row.name || 'Cuber', event: evName(ev), p: penalty }) }),
      el('p', { class: 'ac-sub', text: t('{time} now. For a solve that was real with the wrong time on it: a Stackmat glitch, a +2 they forgot. It moves on the board at once.', { time: timeText(row) }) }),
      el('div', { class: 'ac-sheet-actions' },
        el('button', { class: 'ac-btn', text: 'Back', onclick: ctx.closeSheet }),
        el('button', { class: 'ac-btn primary', text: penalty === 'none' ? t('Clear it') : t('Set to {p}', { p: penalty }), onclick: () => retime(ev, uid, penalty, row) })));
  }

  function askRemove(ev, uid, row) {
    ctx.openSheet(
      el('h2', { class: 'ac-h2', text: t('Remove {name}’s {event} time?', { name: row.name || 'Cuber', event: evName(ev) }) }),
      el('p', { class: 'ac-sub', text: t('They get the backup scramble as a final attempt (or, if this was the backup, that is their day). Its replay goes too.') }),
      el('div', { class: 'ac-sheet-actions' },
        el('button', { class: 'ac-btn', text: 'Back', onclick: ctx.closeSheet }),
        el('button', { class: 'ac-btn primary danger', text: t('Remove time'), onclick: async () => {
          if (await ctx.moderation.takeDown('result', base(ev, uid), row)) { ctx.closeSheet(); toast(t('Removed'), { kind: 'good' }); }
        } })));
  }

  /* ---------------- views ---------------- */

  const block = (title, ...kids) => el('section', { class: 'ac-block' }, el('h2', { class: 'ac-h2', text: title }), ...kids);
  const small = (text, onclick, cls = '') => el('button', { class: `ac-btn small ${cls}`, text, onclick });

  function resultEntry(ev, uid, row, { floor = null, held = false, extra = [] } = {}) {
    return el('li', { class: 'ac-entry' },
      el('div', { class: 'ac-entry-main' },
        el('span', { class: 'ac-chat-head' },
          el('a', { class: 'ac-link', href: `#people/u/${uid}`, text: row.name || 'Cuber' }),
          raw('span', { class: 'ac-pill' }, evName(ev)),
          raw('b', { class: 'ac-time' }, timeText(row))),
        raw('span', { class: 'ac-entry-meta' }, [
          ago(row.submittedAt),
          floor ? t('floor {s} s', { s: (floor / 1000).toFixed(2) }) : null,
          held ? t('held for a look') : null,
          row.backup ? t('backup') : null,
          row.suspect ? t('⚑ under their own average') : null,
          row.review ? t('kept {when} by {who}', { when: ago(row.review.at), who: ctx.who(row.review.by) }) : null,
          row.replay ? t('replay shared') : null,
        ].filter(Boolean).join(' · '))),
      el('div', { class: 'ac-entry-actions' }, ...extra));
  }

  function viewHeld() {
    const list = held();
    const frozen = ctx.cfg('sotd', 'frozen');
    return block(t('Held for a look'),
      frozen ? el('p', { class: 'ac-flag', text: t('Today’s board is closed (sotd.frozen): no new result is accepted.') }) : null,
      el('p', { class: 'ac-sub', text: t('Times under their event’s floor (Settings › Scramble of the Day › Checked under). They stay on the board marked “checking” until you keep or remove them.') }),
      list.length ? el('ol', { class: 'ac-log ac-tight' }, ...list.map(({ ev, uid, row, floor }) => resultEntry(ev, uid, row, { floor, extra: [
        small(t('Keep'), () => keep(ev, uid, row), 'primary'),
        small('+2', () => askRetime(ev, uid, row, '+2')),
        small('DNF', () => askRetime(ev, uid, row, 'DNF')),
        small(t('Remove'), () => askRemove(ev, uid, row), 'danger'),
      ] })))
        : el('p', { class: 'ac-note', text: ctx.moderation.snapshot().dayKey ? 'Nothing held today.' : 'Loading…' }));
  }

  function viewBoards() {
    const res = ctx.moderation.snapshot().results || {};
    // Only the events somebody has played today: sixteen chips of "· 0" say nothing.
    const order = [...events(), ...SOTD_EVENTS];
    const evs = Object.keys(res).filter(e => Object.keys(res[e] || {}).length).sort((a, b) => order.indexOf(a) - order.indexOf(b));
    if (!evs.length) return block(t('Today’s boards'), el('p', { class: 'ac-note', text: ctx.moderation.snapshot().dayKey ? 'No times on any board yet today.' : 'Loading…' }));
    if (!evs.includes(Q.event)) Q.event = evs[0];
    const ev = Q.event;
    const rows = Object.entries(res[ev] || {}).sort((a, b) => eff(a[1]) - eff(b[1]));
    const f = Q.featured;
    return block(t('Today’s boards'),
      el('div', { class: 'ac-chips' }, ...evs.map(e => el('button', {
        class: `ac-chip${e === ev ? ' on' : ''}`, type: 'button',
        onclick: () => { Q.event = e; ctx.scheduleRender(); },
      }, raw('span', {}, `${evName(e)} · ${Object.keys(res[e] || {}).length}`)))),
      f ? raw('p', { class: 'ac-sub' }, t('Featured replay today: {name}, {event}', { name: res[f.event]?.[f.uid]?.name || f.uid, event: evName(f.event) })) : null,
      rows.length ? el('ol', { class: 'ac-log ac-tight' }, ...rows.map(([uid, row]) => resultEntry(ev, uid, row, { held: isHeld(ev, row), extra: [
        row.penalty !== '+2' ? small('+2', () => askRetime(ev, uid, row, '+2')) : null,
        row.penalty !== 'DNF' ? small('DNF', () => askRetime(ev, uid, row, 'DNF')) : null,
        row.penalty && row.penalty !== 'none' ? small(t('No penalty'), () => askRetime(ev, uid, row, 'none')) : null,
        row.replay === true ? (f?.event === ev && f?.uid === uid ? small(t('Unfeature'), () => unfeature()) : small(t('Feature replay'), () => feature(ev, uid))) : null,
        small(t('Remove'), () => askRemove(ev, uid, row), 'danger'),
      ].filter(Boolean) })))
        : null);
  }

  /* The last PAST_DAYS days, before today: each event's results and removals, read once. */
  async function loadPast() {
    if (Q.pastBusy) return;
    Q.pastBusy = true;
    ctx.scheduleRender();
    const days = pastDayKeys(today(), PAST_DAYS);
    const out = [];
    // Each read on its own: the removals need this version's rules, the results do not.
    const read = (path) => sdk().get(ref(path)).then(s => s.val() || {}, () => null);
    await Promise.all(days.flatMap(day => events().map(async (ev) => {
      const [results, removed] = await Promise.all([read(`daily/${day}/${ev}/results`), read(`daily/${day}/${ev}/removed`)]);
      const n = Object.keys(results || {}).length;
      const gone = removed ? Object.keys(removed).length : null;
      if (!n && !gone) return;
      const best = Object.entries(results || {}).sort((a, b) => eff(a[1]) - eff(b[1]))[0];
      out.push({ day, ev, n, removed: gone, winner: best && Number.isFinite(eff(best[1])) ? { uid: best[0], row: best[1] } : null });
    })));
    Q.past = out.sort((a, b) => Number(b.day) - Number(a.day) || events().indexOf(a.ev) - events().indexOf(b.ev));
    Q.pastBusy = false;
    ctx.scheduleRender();
  }

  function viewPast() {
    const label = (d) => new Date(Number(d) + IST_MS).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
    let body;
    if (!Q.past) body = el('button', { class: 'ac-btn small', text: Q.pastBusy ? t('Reading…') : t('Read the last {n} days', { n: PAST_DAYS }), disabled: Q.pastBusy, onclick: loadPast });
    else if (!Q.past.length) body = el('p', { class: 'ac-note', text: 'Nothing on the boards in the last week.' });
    else {
      const byDay = new Map();
      for (const x of Q.past) byDay.set(x.day, [...(byDay.get(x.day) || []), x]);
      body = el('div', { class: 'ac-log' }, ...[...byDay].map(([day, list]) => el('div', { class: 'ac-round' },
        raw('b', {}, label(day)),
        el('ol', { class: 'ac-log ac-tight' }, ...list.map(x => el('li', { class: 'ac-entry' },
          el('div', { class: 'ac-entry-main' },
            el('span', { class: 'ac-chat-head' }, raw('span', { class: 'ac-pill' }, evName(x.ev)),
              x.winner ? el('a', { class: 'ac-link', href: `#people/u/${x.winner.uid}`, text: x.winner.row.name || 'Cuber' }) : raw('span', {}, '—'),
              x.winner ? raw('b', { class: 'ac-time' }, timeText(x.winner.row)) : null),
            raw('span', { class: 'ac-entry-meta' }, [(x.n === 1 ? t('1 entry') : t('{n} entries', { n: x.n })), x.removed ? t('{n} removed', { n: x.removed }) : null].filter(Boolean).join(' · ')))))))));
    }
    return block(t('Past days'),
      el('p', { class: 'ac-sub', text: 'Each event’s winner, how many took part and how many times were removed, for the seven days before today.' }),
      body);
  }

  function view() {
    start();
    if (Q.featuredRefused) {
      return [viewHeld(), viewBoards(), viewPast(), ctx.gate('Some of this needs publishing', 'Keeping a held time, re-timing and featuring a replay need the firebase.rules.json from this version of the page.')];
    }
    return [viewHeld(), viewBoards(), viewPast()];
  }

  /** Held times, for Moderate's sub-tab count and Today. */
  const count = () => held().length;

  return { start, stop, view, count };
}
