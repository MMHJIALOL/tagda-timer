import { t, translateDOM } from './i18n.js';
/* ===========================================================
   Tagda Timer — the admin console (admin.html, tagdatimer.me/admin)

   The site's settings, changed from a phone without touching code. Who may
   use it is admins/<uid> in the database (js/admins.js); what the settings
   are is js/config.js; ADMIN.md has the rest.

   Seven tabs: Today (js/admin-live.js: the day's numbers, and the days
   ahead), Settings, Moderate (js/admin-mod.js: reports, every chat, flagged
   times, shared replays; js/admin-rooms.js: race rooms and 1v1), Announce
   (js/admin-ann.js), People (testers/ and bans/), Health (js/admin-health.js:
   what signed-in timers report about themselves) and the Log.

   Every Save is one multi-path update: the value, its configMeta pointer and
   a configLog entry saying who changed what from what to what. The rules
   refuse a value that arrives without both, so the log cannot miss a change
   made from anywhere. Undo is an ordinary change that names the entry it
   undoes. A change can also be scheduled instead (configScheduled/), and
   the Worker's cron applies it at its time, through the same chain.

   Live listeners are fine here, unlike in the app (config.js): only admins
   get past the front door, so this page costs one of the Spark plan's 100
   connections per admin with it open.
   =========================================================== */

import { el } from './util.js';
import { toast } from './toast.js';
import { onAuthChange, signIn, signOutUser, getDatabaseHandle, preloadAuth, takeRedirectError } from './sync-auth.js';
import { adminStatus, banAccount, unbanAccount, banActive, banScopes, BAN_SCOPES } from './admins.js';
import { CONFIG, spec, clean, valid } from './config.js';
import { SCHEDULER_UID, SCHEDULE_AHEAD_MS } from './config-rules.js';
import { APP_VERSION } from './version.js';
import { createModeration } from './admin-mod.js';
import { createAnnounce } from './admin-ann.js';
import { createLive } from './admin-live.js';
import { createRooms } from './admin-rooms.js';
import { createHealth } from './admin-health.js';
import { createPeople } from './admin-people.js';
import { createSotd } from './admin-sotd.js';
import { createModLog } from './admin-modlog.js';
import { createStorage } from './admin-storage.js';
import { eventOf } from './events.js';

/** How many log entries the page keeps live. Older ones stay in the database. */
const LOG_SHOWN = 200;
/** An edit that puts a setting back on its built-in default (deletes the value). */
const DEFAULT = Symbol('default');

const WHERE = {
  rules: 'Enforced by the database rules',
  worker: 'Enforced by the Worker',
  app: 'Read by the app when a page loads',
  nowhere: 'Nothing reads it',
};

const $main = document.getElementById('ac-main');
const $tabs = document.getElementById('ac-tabs');
const $account = document.getElementById('ac-account');
const $savebar = document.getElementById('ac-savebar');
const $sheet = document.getElementById('ac-sheet');

const S = {
  /** 'loading' | 'signed-out' | 'checking' | 'not-admin' | 'old-rules' | 'admin' | 'error' */
  status: 'loading',
  user: null,
  sdk: null,
  config: {},
  meta: {},
  log: [],
  bans: {},
  testers: {},
  /** configScheduled: { section: { key: { id: { to?, def?, at, by, createdAt } } } } */
  scheduled: {},
  loaded: { config: false, log: false, bans: false, testers: false },
  /** 'section/key' -> the value Save will write, or DEFAULT. */
  edits: new Map(),
  unsubs: [],
  saving: false,
};

/* ---------------- small helpers ---------------- */

/** An element whose text is data (a value, a uid), never run through t(). */
function raw(tag, props, text) {
  const n = el(tag, props);
  n.textContent = text;
  return n;
}

/** What the page shows a number in: MB for bytes, say (the table's `factor`). */
const fac = (sp) => sp?.factor || 1;
/** The highest value allowed here. `deployed`: no higher than this deploy's own version. */
const maxHere = (sp) => (sp?.deployed ? Math.min(sp.max, APP_VERSION) : sp?.max);
/** valid(), and for minVersion not past this deploy: no tab could ever satisfy it. */
const validHere = (sp, v) => valid(sp, v) && !(sp?.deployed && v > APP_VERSION);

const stored = (path) => {
  const [s, k] = path.split('/');
  const v = S.config?.[s]?.[k];
  return v === null ? undefined : v;
};

/** What a value looks like on the page. undefined and DEFAULT are the default. */
function show(sp, v) {
  if (v === undefined || v === DEFAULT) {
    if (!sp) return t('nothing');
    return sp.def === '' ? t('default (empty)') : t('default ({v})', { v: show(sp, sp.def) });
  }
  if (sp?.type === 'bool' || typeof v === 'boolean') return v ? t('On') : t('Off');
  if (sp?.type === 'choice') return t(CHOICE[v] || v);
  if (sp?.type === 'time') return new Date(v).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  if (sp?.type === 'set') {
    const items = String(v).split(',').filter(Boolean);
    if (!items.length) return t('none');
    if (items.length === sp.options.length) return t('all {n}', { n: items.length });
    return items.map(optionLabel).join(', ');
  }
  if (typeof v === 'string') return v === '' ? t('(empty)') : `“${v}”`;
  const n = typeof v === 'number' ? v / fac(sp) : v;
  return sp?.unit ? `${n} ${t(sp.unit)}` : String(n);
}

function ago(ms) {
  if (!ms) return '';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return t('just now');
  if (s < 3600) return t('{n} min ago', { n: Math.max(1, Math.round(s / 60)) });
  if (s < 86400) return t('{n} h ago', { n: Math.round(s / 3600) });
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

const who = (uid) => (uid === S.user?.uid ? t('you') : uid === SCHEDULER_UID ? t('the scheduler') : `${String(uid).slice(0, 6)}…`);

/** What a 'choice' setting's options are called (the audiences, ADMIN.md §9). */
const CHOICE = { everyone: 'Everybody', testers: 'Testers and admins', admins: 'Admins only',
  info: 'Information (the theme’s colour)', warn: 'Warning (amber)', down: 'Outage (red)' };

/** One option of a 'set' setting, as people know it (the events: 3x3, OH…). */
const optionLabel = (o) => eventOf(o)?.short || o;

/** The settings' current values, as getConfig() would give them, from the live copy: for the built-in announcements. */
const cfg = (s, k) => { const sp = spec(s, k); const v = clean(sp, S.config?.[s]?.[k]); return v === undefined ? sp?.def : v; };

function labelOf(path) {
  if (String(path).startsWith('ann/')) return t('Announcement · {id}', { id: String(path).slice(4) });
  const [s, k] = String(path).split('/');
  const sec = CONFIG[s];
  const sp = spec(s, k);
  return sec && sp ? `${t(sec.title)} · ${t(sp.label)}` : path;
}

/* ---------------- rendering ---------------- */

let renderPending = false;

/** Redraw, unless somebody is typing in a field: then once they leave it. */
function scheduleRender() {
  const active = document.activeElement;
  if (active && $main.contains(active) && /^(INPUT|TEXTAREA)$/.test(active.tagName)) {
    if (!renderPending) {
      renderPending = true;
      active.addEventListener('blur', () => { renderPending = false; render(); }, { once: true });
    }
    return;
  }
  render();
}

function route() {
  const h = location.hash.replace(/^#/, '');
  if (h === '' || h === 'today') return { view: 'today' };
  if (h === 'log' || h === 'log/settings') return { view: 'log', sub: 'settings' };
  if (h === 'log/mod') return { view: 'log', sub: 'mod' };
  if (h === 'bans') return { view: 'people', sub: 'bans' };
  const ppl = /^people(?:\/(testers|bans|lookup|support|requests))?$/.exec(h);
  if (ppl) return { view: 'people', sub: ppl[1] || 'lookup' };
  const person = /^people\/u\/([A-Za-z0-9]{1,128})$/.exec(h);
  if (person) return { view: 'people', sub: 'u', id: person[1] };
  const hl = /^health(?:\/(sync|versions|scrambles|errors|storage))?$/.exec(h);
  if (hl) return { view: 'health', sub: hl[1] || 'sync' };
  const days = /^days(?:\/(\d{13}))?$/.exec(h);
  if (days) return { view: 'days', sub: days[1] || null };
  const mod = /^mod(?:\/(reports|sotd|chats|suspect|replays|rooms|history))?$/.exec(h);
  if (mod) return { view: 'mod', sub: mod[1] || 'reports' };
  const room = /^mod\/room\/([A-Za-z0-9_-]{1,64})$/.exec(h);
  if (room) return { view: 'mod', sub: 'room', id: room[1] };
  const ann = /^ann(?:\/(new|[a-z0-9-]{1,40}))?$/.exec(h);
  if (ann) return { view: 'ann', sub: ann[1] || null };
  const m = /^settings\/([a-zA-Z]+)$/.exec(h);
  if (m && CONFIG[m[1]]) return { view: 'section', section: m[1] };
  return { view: 'sections' };
}

function render() {
  renderAccount();
  const admin = S.status === 'admin';
  $tabs.hidden = !admin;
  if (admin) renderTabs();
  // A view may hand back a group of nodes, or nothing, in place of one: never the text "null".
  $main.replaceChildren(...view().flat().filter(Boolean));
  renderSavebar();
  document.body.dataset.status = S.status;
}

function view() {
  switch (S.status) {
    case 'loading': return [el('p', { class: 'ac-note', text: 'Loading…' })];
    case 'checking': return [el('p', { class: 'ac-note', text: 'Checking your account…' })];
    case 'signed-out': return [gate(
      'Tagda Timer admin',
      'Sign in with the Google account you use on the timer.',
      el('button', { class: 'ac-btn primary', text: 'Sign in with Google', onclick: doSignIn }))];
    case 'not-admin': return [gate('This page is for the site’s admins.', null)];
    case 'old-rules': return [gate(
      'Publish the rules first',
      'The database is still on firebase.rules.json from before this page, so it cannot keep a change log and refuses every change. Publish the rules in the Firebase console, add yourself under admins, and reload. ADMIN.md has the steps.')];
    case 'error': return [gate(
      'Couldn’t reach the database',
      'Check the connection, then try again.',
      el('button', { class: 'ac-btn', text: 'Try again', onclick: () => onUser(S.user) }))];
    default: {
      const r = route();
      if (r.view === 'today') return live.viewToday();
      if (r.view === 'days') return live.viewDays(r.sub);
      if (r.view === 'log') return viewLog(r.sub);
      if (r.view === 'people') return viewPeople(r.sub, r.id);
      if (r.view !== 'mod' || r.sub !== 'room') rooms.leaveRoom();
      if (r.view === 'mod') return moderation.view(r.sub, r.id);
      if (r.view === 'ann') return announce.view(r.sub);
      if (r.view === 'health') return health.view(r.sub);
      if (r.view === 'section') return viewSection(r.section);
      return viewSections();
    }
  }
}

function gate(title, text, ...extra) {
  return el('section', { class: 'ac-gate' },
    el('h1', { class: 'ac-h1', text: title }),
    text ? el('p', { class: 'ac-sub', text }) : null,
    ...extra);
}

function renderAccount() {
  const u = S.user;
  if (!u) { $account.replaceChildren(); return; }
  const face = u.photoURL
    ? el('img', { class: 'ac-face', src: u.photoURL, alt: '', referrerpolicy: 'no-referrer', width: 28, height: 28 })
    : raw('span', { class: 'ac-face ac-face-letter', 'aria-hidden': 'true' }, (u.displayName || u.email || '?')[0].toUpperCase());
  $account.replaceChildren(face,
    raw('span', { class: 'ac-name' }, u.displayName || u.email || ''),
    el('button', { class: 'ac-link', text: 'Sign out', onclick: doSignOut }));
}

function renderTabs() {
  const r = route().view;
  // Seven across a phone: a count is a badge on the tab, not words beside it.
  const tab = (href, label, on, n = 0) => el('a', { class: `ac-tab${on ? ' on' : ''}`, href, 'aria-current': on ? 'page' : null },
    el('span', { text: label }), n ? raw('span', { class: 'ac-tab-n', 'aria-label': t('{n} open', { n }) }, String(n)) : null);
  // Open reports and Scramble of the Day times held for a look: what is waiting on an admin.
  const open = moderation.counts().reports + moderation.counts().sotd;
  $tabs.replaceChildren(
    tab('#today', 'Today', r === 'today' || r === 'days'),
    tab('#settings', 'Settings', r === 'sections' || r === 'section'),
    tab('#mod', 'Moderate', r === 'mod', open),
    tab('#ann', 'Announce', r === 'ann'),
    tab('#people', 'People', r === 'people', people.counts().support + people.counts().requests),
    tab('#health', 'Health', r === 'health', health.summary().stuck),
    tab('#log', 'Log', r === 'log'));
}

/* ---------------- settings ---------------- */

function viewSections() {
  return [
    el('h1', { class: 'ac-h1', text: 'Settings' }),
    el('p', { class: 'ac-sub', text: 'Each setting runs on its built-in default until it is changed here. Every change is logged and can be undone, and any change can be given a time instead of now.' }),
    scheduledList().length ? [
      el('h2', { class: 'ac-h2 ac-gap', text: 'Scheduled' }),
      el('ol', { class: 'ac-log' }, ...scheduledList().map(scheduledRow)),
      el('h2', { class: 'ac-h2 ac-gap', text: 'Sections' }),
    ] : null,
    el('div', { class: 'ac-list' }, ...Object.entries(CONFIG).map(([s, sec]) => {
      const keys = Object.keys(sec.keys);
      const changed = keys.filter(k => stored(`${s}/${k}`) !== undefined).length;
      const pending = keys.filter(k => S.edits.has(`${s}/${k}`)).length;
      const planned = keys.filter(k => Object.keys(S.scheduled?.[s]?.[k] || {}).length).length;
      return el('a', { class: 'ac-card', href: `#settings/${s}` },
        el('div', { class: 'ac-card-main' },
          el('b', { text: sec.title }),
          el('span', { class: 'ac-card-sub', text: sec.about })),
        el('div', { class: 'ac-card-side' },
          pending ? el('span', { class: 'ac-pill warn', text: t('{n} unsaved', { n: pending }) }) : null,
          planned ? el('span', { class: 'ac-pill', text: t('{n} scheduled', { n: planned }) }) : null,
          el('span', { class: 'ac-pill', text: changed ? t('{n} of {m} changed', { n: changed, m: keys.length }) : t('all default') }),
          raw('span', { class: 'ac-chev', 'aria-hidden': 'true' }, '›')));
    })),
  ];
}

function viewSection(s) {
  const sec = CONFIG[s];
  return [
    el('a', { class: 'ac-back', href: '#settings', text: '‹ Settings' }),
    el('h1', { class: 'ac-h1', text: sec.title }),
    el('p', { class: 'ac-sub', text: sec.about }),
    S.loaded.config ? el('div', { class: 'ac-form' }, ...Object.entries(sec.keys).map(([k, sp]) => settingRow(s, k, sp)))
      : el('p', { class: 'ac-note', text: 'Loading…' }),
  ];
}

/** The value a key's control should show: the pending edit, else what is stored, else the default. */
function shownValue(path, sp) {
  if (S.edits.has(path)) { const e = S.edits.get(path); return e === DEFAULT ? sp.def : e; }
  const v = clean(sp, stored(path));
  return v === undefined ? sp.def : v;
}

/** Record what the control now says, as an edit or as no edit at all. */
function setEdit(path, sp, v) {
  const was = stored(path);
  if ((was !== undefined && v === was) || (was === undefined && v === sp.def)) S.edits.delete(path);
  else S.edits.set(path, v);
}

function settingRow(s, k, sp) {
  const path = `${s}/${k}`;
  const id = `ac-${s}-${k}`;
  const status = el('div', { class: 'ac-status' });
  const row = el('div', { class: 'ac-row', dataset: { path } });

  const refresh = () => {
    const has = S.edits.has(path);
    const e = S.edits.get(path);
    const bad = has && e !== DEFAULT && !validHere(sp, e);
    row.classList.toggle('pending', has);
    row.classList.toggle('bad', bad);
    const was = stored(path);
    const meta = S.meta?.[s]?.[k];
    const kids = [];
    if (bad) kids.push(el('span', { class: 'ac-err', text: rangeText(sp) }));
    else if (has) kids.push(raw('span', { class: 'ac-was' }, t('Unsaved · currently {v}', { v: show(sp, was) })));
    else if (was !== undefined) {
      kids.push(raw('span', {}, meta ? t('Changed {when} by {who}', { when: ago(meta.at), who: who(meta.by) }) : t('Changed')));
    } else kids.push(el('span', { class: 'ac-pill', text: 'default' }));
    if (!has && was !== undefined) {
      kids.push(raw('span', { class: 'ac-def' }, t('Default: {v}', { v: show(sp, sp.def) })),
        el('button', { class: 'ac-link', text: 'Use default', onclick: () => { S.edits.set(path, DEFAULT); render(); } }));
    }
    if (has) kids.push(el('button', { class: 'ac-link', text: 'Keep as it was', onclick: () => { S.edits.delete(path); render(); } }));
    for (const e of scheduledList().filter(x => x.path === path)) {
      kids.push(raw('span', { class: 'ac-sched' }, t('Scheduled: {v} on {when}', { v: show(sp, e.def ? DEFAULT : e.to), when: whenText(e.at) })),
        el('button', { class: 'ac-link', text: 'Cancel', onclick: () => askCancel(e) }));
    }
    status.replaceChildren(...kids);
    renderSavebar();
  };

  let control;
  if (sp.type === 'bool') {
    const input = el('input', { type: 'checkbox', id, role: 'switch' });
    input.checked = shownValue(path, sp) === true;
    input.addEventListener('change', () => { setEdit(path, sp, input.checked); refresh(); });
    control = el('label', { class: 'switch' }, input, el('span', { class: 'track' }), el('span', { class: 'thumb' }));
  } else if (sp.type === 'int') {
    // In the table's unit (MB for bytes): what is typed is multiplied back before it is stored.
    const f = fac(sp);
    const input = el('input', { type: 'text', id, inputmode: 'numeric', autocomplete: 'off', class: 'ac-inp ac-num-inp' });
    input.value = String(shownValue(path, sp) / f);
    const read = () => {
      const txt = input.value.trim();
      setEdit(path, sp, /^-?\d+$/.test(txt) ? Number(txt) * f : txt);
      refresh();
    };
    input.addEventListener('input', read);
    const step = (d) => {
      const n = Number(input.value);
      const next = Number.isInteger(n) ? Math.min(maxHere(sp) / f, Math.max(sp.min / f, n + d)) : sp.def / f;
      input.value = String(next);
      read();
    };
    control = el('div', { class: 'ac-num' },
      raw('button', { class: 'ac-step', type: 'button', 'aria-label': 'Less', onclick: () => step(-1) }, '−'),
      input,
      raw('button', { class: 'ac-step', type: 'button', 'aria-label': 'More', onclick: () => step(1) }, '+'));
  } else if (sp.type === 'time') {
    const toLocal = (ms) => {
      const d = new Date(ms);
      const p2 = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`;
    };
    const input = el('input', { id, class: 'ac-inp', type: 'datetime-local' });
    input.value = toLocal(shownValue(path, sp));
    input.addEventListener('input', () => { setEdit(path, sp, input.value ? new Date(input.value).getTime() : sp.def); refresh(); });
    control = el('div', { class: 'ac-text' }, input);
  } else if (sp.type === 'choice') {
    const input = el('select', { id, class: 'ac-inp' }, ...sp.options.map(o => raw('option', { value: o }, t(CHOICE[o] || o))));
    input.value = shownValue(path, sp);
    input.addEventListener('change', () => { setEdit(path, sp, input.value); refresh(); });
    control = el('div', { class: 'ac-text' }, input);
  } else if (sp.type === 'set') {
    // A tick each, in the table's order; stored as the ticked ones, comma-separated.
    const now = new Set(String(shownValue(path, sp)).split(',').filter(Boolean));
    const boxes = sp.options.map((o) => {
      const box = el('input', { type: 'checkbox' });
      box.checked = now.has(o);
      box.addEventListener('change', () => {
        setEdit(path, sp, sp.options.filter((x, i) => boxes[i].firstChild.checked).join(','));
        refresh();
      });
      return el('label', { class: 'ac-chip' }, box, raw('span', {}, optionLabel(o)));
    });
    control = el('div', { class: 'ac-chips', id }, ...boxes);
  } else {
    const long = sp.max > 120;
    const input = el(long ? 'textarea' : 'input', { id, class: 'ac-inp', maxlength: sp.max, autocomplete: 'off', rows: long ? 3 : null });
    input.value = shownValue(path, sp);
    const count = raw('span', { class: 'ac-count' }, '');
    const read = () => {
      count.textContent = `${input.value.length}/${sp.max}`;
      setEdit(path, sp, input.value);
      refresh();
    };
    input.addEventListener('input', read);
    count.textContent = `${input.value.length}/${sp.max}`;
    control = el('div', { class: 'ac-text' }, input, count);
  }

  // replaceChildren(), like append(), writes a null out as the text "null".
  row.replaceChildren(...[
    el('div', { class: 'ac-row-head' },
      el('label', { class: 'ac-label', for: id, text: sp.label }),
      sp.type === 'bool' ? control : null),
    sp.help ? el('p', { class: 'ac-help', text: sp.help }) : null,
    sp.type === 'bool' ? null : control,
    el('div', { class: 'ac-facts' },
      sp.type === 'int' ? raw('span', { class: 'ac-range' }, t('{min} to {max}', { min: sp.min / fac(sp), max: maxHere(sp) / fac(sp) }) + (sp.unit ? ` ${t(sp.unit)}` : '')) : null,
      sp.deployed ? raw('span', { class: 'ac-range' }, t('this deploy is version {v}', { v: APP_VERSION })) : null,
      el('span', { class: 'ac-where', text: WHERE[sp.where] || sp.where })),
    status].filter(Boolean));
  refresh();
  return row;
}

function rangeText(sp) {
  if (sp.deployed) return t('A whole number from {min} to {max}: no deploy is newer than this one yet', { min: sp.min, max: maxHere(sp) });
  if (sp.type === 'int') return t('A whole number from {min} to {max}', { min: sp.min / fac(sp), max: sp.max / fac(sp) });
  if (sp.type === 'text') return t('At most {max} characters', { max: sp.max });
  if (sp.type === 'choice') return t('One of the choices');
  return t('On or off');
}

/* ---------------- saving ---------------- */

function pendingChanges() {
  return [...S.edits].map(([path, to]) => {
    const [s, k] = path.split('/');
    const sp = spec(s, k);
    return { path, sp, from: stored(path), to, ok: to === DEFAULT || validHere(sp, to) };
  });
}

function renderSavebar() {
  const list = pendingChanges();
  const show = S.status === 'admin' && list.length > 0 && ['sections', 'section'].includes(route().view);
  $savebar.hidden = !show;
  document.body.classList.toggle('has-savebar', show);
  if (!show) return;
  const bad = list.some(c => !c.ok);
  $savebar.replaceChildren(
    raw('span', { class: 'ac-savebar-text' }, bad ? t('Fix the highlighted setting first')
      : list.length === 1 ? t('1 unsaved change') : t('{n} unsaved changes', { n: list.length })),
    el('button', { class: 'ac-btn', text: 'Discard', onclick: () => { S.edits.clear(); render(); } }),
    el('button', { class: 'ac-btn primary', text: 'Review', disabled: bad || S.saving, onclick: review }));
}

function closeSheet() {
  $sheet.hidden = true;
  $sheet.replaceChildren();
  document.body.classList.remove('sheet-open');
}

function openSheet(...kids) {
  const panel = el('div', { class: 'ac-sheet-panel', role: 'dialog', 'aria-modal': 'true' }, ...kids);
  $sheet.replaceChildren(el('div', { class: 'ac-sheet-back', onclick: closeSheet }), panel);
  $sheet.hidden = false;
  document.body.classList.add('sheet-open');
  panel.querySelector('.primary')?.focus();
}

document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$sheet.hidden) closeSheet(); });

function diffRow(label, sp, from, to) {
  return el('li', { class: 'ac-diff' },
    raw('b', {}, label),
    el('span', { class: 'ac-diff-vals' },
      raw('span', { class: 'ac-from' }, show(sp, from)),
      raw('span', { class: 'ac-arrow', 'aria-hidden': 'true' }, '→'),
      raw('span', { class: 'ac-to' }, show(sp, to))));
}

/** The next whole hour, as a datetime-local input wants it. */
function nextHourLocal() {
  const d = new Date(Date.now() + 3_600_000);
  d.setMinutes(0, 0, 0);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

const whenText = (ms) => new Date(ms).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function review() {
  const list = pendingChanges();
  if (!list.length || list.some(c => !c.ok)) return;
  const label = () => (when.value === 'later'
    ? (list.length === 1 ? t('Schedule it') : t('Schedule all {n}', { n: list.length }))
    : (list.length === 1 ? t('Save it') : t('Save all {n}', { n: list.length })));
  const when = el('select', { class: 'ac-inp', 'aria-label': t('When') },
    raw('option', { value: 'now' }, t('Now')), raw('option', { value: 'later' }, t('At a time…')));
  const at = el('input', { class: 'ac-inp', type: 'datetime-local', 'aria-label': t('At') });
  at.value = nextHourLocal();
  const atField = el('label', { class: 'ac-field', hidden: true }, el('span', { class: 'ac-label', text: 'At (this device’s time)' }), at,
    el('span', { class: 'ac-help', text: 'Applied by the Worker within a minute of it, and logged then, as the scheduler’s change on your behalf.' }));
  const save = el('button', { class: 'ac-btn primary', text: label() });
  when.addEventListener('change', () => { atField.hidden = when.value !== 'later'; save.textContent = label(); });
  save.addEventListener('click', async () => {
    const changes = list.map(c => ({ path: c.path, to: c.to }));
    if (when.value === 'later') {
      const ms = at.value ? new Date(at.value).getTime() : NaN;
      if (!(ms > Date.now() + 60_000) || ms > Date.now() + SCHEDULE_AHEAD_MS - 60_000) {
        toast(t('A time from a minute from now to a year ahead'), { kind: 'bad', long: true });
        return;
      }
      save.disabled = true;
      if (await schedule(changes, ms)) {
        S.edits.clear(); closeSheet(); render();
        toast(t('Scheduled for {when}.', { when: whenText(ms) }), { kind: 'good', long: true });
      } else save.disabled = false;
      return;
    }
    save.disabled = true;
    const ok = await write(changes);
    if (ok) { S.edits.clear(); closeSheet(); render(); toast(t('Saved. It is in the change log.'), { kind: 'good', long: true }); }
    else save.disabled = false;
  });
  openSheet(
    el('h2', { class: 'ac-h2', text: list.length === 1 ? t('Save this change?') : t('Save these {n} changes?', { n: list.length }) }),
    el('ul', { class: 'ac-diffs' }, ...list.map(c => diffRow(labelOf(c.path), c.sp, c.from, c.to))),
    el('label', { class: 'ac-field' }, el('span', { class: 'ac-label', text: 'When' }), when),
    atField,
    el('div', { class: 'ac-sheet-actions' },
      el('button', { class: 'ac-btn', text: 'Back', onclick: closeSheet }),
      save));
}

/* ---------------- scheduled changes (ADMIN.md §10) ---------------- */

/** Every scheduled change, soonest first: [{ path, id, to?, def?, at, by, createdAt }]. */
function scheduledList() {
  const out = [];
  for (const [s, keys] of Object.entries(S.scheduled || {})) {
    for (const [k, ids] of Object.entries(keys || {})) {
      for (const [id, e] of Object.entries(ids || {})) out.push({ path: `${s}/${k}`, id, ...e });
    }
  }
  return out.sort((a, b) => (a.at || 0) - (b.at || 0));
}

/** One update for the lot: a configScheduled entry per setting. The rules check each value as they would the setting. */
async function schedule(changes, at) {
  const { db, ref, push, update, serverTimestamp } = S.sdk;
  const body = {};
  for (const { path, to } of changes) {
    const id = push(ref(db, `configScheduled/${path}`)).key;
    const rec = { at, by: S.user.uid, createdAt: serverTimestamp() };
    if (to === DEFAULT) rec.def = true; else rec.to = to;
    body[`configScheduled/${path}/${id}`] = rec;
  }
  try {
    await update(ref(db), body);
    return true;
  } catch (err) {
    console.warn('[admin] schedule refused', err?.code || err);
    toast(t('The database refused that. Scheduling needs the firebase.rules.json from this version of the page.'), { kind: 'bad', hold: true });
    return false;
  }
}

/** A scheduled change as a row: what, when, whose, and whether it is late (the Worker has not run it). */
function scheduledRow(e) {
  const [s, k] = e.path.split('/');
  const sp = spec(s, k);
  const late = e.at < Date.now() - 3 * 60_000;
  return el('li', { class: `ac-entry${late ? ' ac-late' : ''}` },
    el('div', { class: 'ac-entry-main' },
      raw('b', {}, labelOf(e.path)),
      el('span', { class: 'ac-diff-vals' },
        raw('span', { class: 'ac-from' }, show(sp, stored(e.path))),
        raw('span', { class: 'ac-arrow', 'aria-hidden': 'true' }, '→'),
        raw('span', { class: 'ac-to' }, show(sp, e.def ? DEFAULT : e.to))),
      raw('span', { class: 'ac-entry-meta' }, [whenText(e.at), t('by {who}', { who: who(e.by) })].join(' · ')),
      late ? el('span', { class: 'ac-err', text: 'Overdue: the Worker has not applied it. ADMIN.md §10 says what to check.' }) : null),
    el('button', { class: 'ac-btn small', text: 'Cancel', onclick: () => askCancel(e) }));
}

function askCancel(e) {
  const [s, k] = e.path.split('/');
  const sp = spec(s, k);
  const go = el('button', { class: 'ac-btn primary', text: 'Cancel it' });
  go.addEventListener('click', async () => {
    go.disabled = true;
    try {
      await S.sdk.remove(S.sdk.ref(S.sdk.db, `configScheduled/${e.path}/${e.id}`));
      closeSheet();
      toast(t('Cancelled. Nothing changes.'), { kind: 'good' });
    } catch (err) {
      console.warn('[admin] cancel refused', err?.code || err);
      toast(t('The database refused that'), { kind: 'bad', hold: true });
      go.disabled = false;
    }
  });
  openSheet(
    el('h2', { class: 'ac-h2', text: 'Cancel this scheduled change?' }),
    el('ul', { class: 'ac-diffs' }, diffRow(labelOf(e.path), sp, stored(e.path), e.def ? DEFAULT : e.to)),
    raw('p', { class: 'ac-sub' }, t('It was due {when}.', { when: whenText(e.at) })),
    el('div', { class: 'ac-sheet-actions' },
      el('button', { class: 'ac-btn', text: 'Back', onclick: closeSheet }),
      go));
}

/**
 * One update for the lot: per setting, the value, its configMeta pointer and
 * a configLog entry. `from` is what this page last heard from the database;
 * if somebody changed it since, the rules refuse the whole update.
 */
async function write(changes, { undo = null } = {}) {
  const { db, ref, push, update, serverTimestamp } = S.sdk;
  const now = serverTimestamp();
  const body = {};
  for (const { path, to } of changes) {
    const id = push(ref(db, 'configLog')).key;
    const from = stored(path);
    const entry = { uid: S.user.uid, at: now, path };
    if (from !== undefined) entry.from = from;
    if (to !== DEFAULT) entry.to = to;
    if (undo) entry.undo = undo;
    body[`config/${path}`] = to === DEFAULT ? null : to;
    body[`configMeta/${path}`] = { at: now, by: S.user.uid, log: id };
    body[`configLog/${id}`] = entry;
  }
  S.saving = true;
  try {
    await update(ref(db), body);
    return true;
  } catch (err) {
    console.warn('[admin] save refused', err?.code || err);
    toast(t('The database refused that. If somebody changed it a moment ago, check it and save again. A setting new in this version needs its firebase.rules.json published first.'), { kind: 'bad', hold: true });
    return false;
  } finally {
    S.saving = false;
  }
}

/* ---------------- the change log ---------------- */

function viewLog(sub = 'settings') {
  const nav = el('nav', { class: 'ac-subtabs', 'aria-label': t('Log') },
    ...[['settings', t('Settings')], ['mod', t('Moderation')]].map(([key, label]) => raw('a', {
      class: `ac-subtab${sub === key ? ' on' : ''}`, href: key === 'settings' ? '#log' : '#log/mod', 'aria-current': sub === key ? 'page' : null }, label)));
  if (sub === 'mod') {
    return [
      el('h1', { class: 'ac-h1', text: 'Change log' }), nav,
      el('p', { class: 'ac-sub', text: 'Every moderation action, from this page and from an admin’s buttons in the timer, newest first. Undo, where it can be undone, is an action of its own.' }),
      ...modlog.view(),
    ];
  }
  const head = [
    el('h1', { class: 'ac-h1', text: 'Change log' }), nav,
    el('p', { class: 'ac-sub', text: 'Every change made here, newest first. Undo puts a setting back to what it was before that change, as a new change of its own.' }),
  ];
  if (!S.loaded.log) return [...head, el('p', { class: 'ac-note', text: 'Loading…' })];
  if (!S.log.length) return [...head, el('p', { class: 'ac-note', text: 'Nothing has been changed yet.' })];
  const byId = new Map(S.log.map(e => [e.id, e]));
  return [...head, el('ol', { class: 'ac-log' }, ...S.log.map(e => logRow(e, byId)))];
}

function logRow(e, byId) {
  // An announcement's entry: what was done to it. Undone by editing it, not from here.
  if (String(e.path).startsWith('ann/')) {
    const what = { create: t('created'), edit: t('edited'), end: t('ended'), again: t('shown again') }[e.action] || e.action;
    return el('li', { class: 'ac-entry' },
      el('div', { class: 'ac-entry-main' },
        raw('b', {}, labelOf(e.path)),
        raw('span', { class: 'ac-reason' }, `${e.title ? `“${e.title}” ` : ''}${what}`),
        raw('span', { class: 'ac-entry-meta', title: e.at ? new Date(e.at).toLocaleString() : '' }, [who(e.uid), ago(e.at)].join(' · '))),
      el('a', { class: 'ac-btn small', href: `#ann/${String(e.path).slice(4)}`, text: 'Open' }));
  }
  const [s, k] = String(e.path).split('/');
  const sp = spec(s, k);
  const now = stored(e.path);
  const undone = byId.get(e.undo);
  const can = !!sp && (e.from === undefined || validHere(sp, e.from)) && now !== e.from;
  return el('li', { class: 'ac-entry' },
    el('div', { class: 'ac-entry-main' },
      raw('b', {}, labelOf(e.path)),
      el('span', { class: 'ac-diff-vals' },
        raw('span', { class: 'ac-from' }, show(sp, e.from)),
        raw('span', { class: 'ac-arrow', 'aria-hidden': 'true' }, '→'),
        raw('span', { class: 'ac-to' }, show(sp, e.to))),
      raw('span', { class: 'ac-entry-meta', title: e.at ? new Date(e.at).toLocaleString() : '' },
        [e.sched ? t('scheduled by {who}', { who: who(e.by) }) : who(e.uid), ago(e.at), e.undo ? (undone ? t('undid the change from {when}', { when: ago(undone.at) }) : t('an undo')) : '']
          .filter(Boolean).join(' · '))),
    el('button', {
      class: 'ac-btn small', text: 'Undo', disabled: !can,
      title: !sp ? t('That setting no longer exists') : now === e.from ? t('It is already {v}', { v: show(sp, e.from) }) : null,
      onclick: () => askUndo(e, sp),
    }));
}

function askUndo(e, sp) {
  const now = stored(e.path);
  const to = e.from === undefined ? DEFAULT : e.from;
  const moved = now !== e.to;
  const go = el('button', { class: 'ac-btn primary', text: 'Undo it' });
  go.addEventListener('click', async () => {
    go.disabled = true;
    // An unsaved edit to the same setting would be stale after this.
    S.edits.delete(e.path);
    if (await write([{ path: e.path, to }], { undo: e.id })) {
      closeSheet(); render(); toast(t('Undone. That is in the log too.'), { kind: 'good', long: true });
    } else go.disabled = false;
  });
  openSheet(
    el('h2', { class: 'ac-h2', text: 'Undo this change?' }),
    el('ul', { class: 'ac-diffs' }, diffRow(labelOf(e.path), sp, now, to)),
    moved ? raw('p', { class: 'ac-warn' }, t('It has been changed again since: it is {now} now, not {was}. Undo sets it to {to} anyway.',
      { now: show(sp, now), was: show(sp, e.to), to: show(sp, to) })) : null,
    el('div', { class: 'ac-sheet-actions' },
      el('button', { class: 'ac-btn', text: 'Back', onclick: closeSheet }),
      go));
}

/* ---------------- bans ---------------- */

const UID_RE = /^[A-Za-z0-9]{1,128}$/;
const banFor = () => [
  { label: t('Until unbanned'), ms: 0 },
  { label: t('1 day'), ms: 86_400_000 },
  { label: t('7 days'), ms: 7 * 86_400_000 },
  { label: t('30 days'), ms: 30 * 86_400_000 },
];

/** People: testers (admin-live.js) and bans, as two views of one tab. */
function viewPeople(sub, id = null) {
  const c = people.counts();
  const on = sub === 'u' ? 'lookup' : sub;
  const nav = el('nav', { class: 'ac-subtabs', 'aria-label': t('People') },
    ...[['lookup', t('Lookup'), 0], ['support', t('Support'), c.support], ['requests', t('Requests'), c.requests],
      ['bans', t('Bans'), Object.values(S.bans).filter(b => banActive(b)).length], ['testers', t('Testers'), Object.keys(S.testers || {}).length]]
      .map(([key, label, n]) => raw('a', { class: `ac-subtab${on === key ? ' on' : ''}`, href: `#people/${key}`, 'aria-current': on === key ? 'page' : null },
        n ? `${label} · ${n}` : label)));
  const head = [el('h1', { class: 'ac-h1', text: 'People' }), nav];
  if (sub === 'u' && id) return [...head, ...people.viewPerson(id)];
  if (sub === 'lookup') return [...head, ...people.viewLookup()];
  if (sub === 'support') return [...head, ...people.viewSupport()];
  if (sub === 'requests') return [...head, ...people.viewRequests()];
  return [...head, ...(sub === 'testers' ? live.viewTesters() : viewBans())];
}

/** What each ban scope is called on the ban form and in the list. */
const SCOPE_NAMES = () => ({ chat: t('Chat and notes'), sotd: t('Scramble of the Day times'), race: t('Race rooms'),
  duel: t('1v1s'), replays: t('Sharing replays'), reports: t('Reporting') });

/** Ticks for a ban's scope: none ticked is everything. Returns { node, value() }. */
function scopeTicks(pre = []) {
  const boxes = BAN_SCOPES.map(s => el('input', { type: 'checkbox', value: s, checked: pre.includes(s) }));
  const node = el('fieldset', { class: 'ac-field ac-scope' },
    el('legend', { class: 'ac-label', text: t('Only from (none ticked: everything)') }),
    el('div', { class: 'ac-chips ac-picks' }, ...boxes.map((b, i) => el('label', { class: 'ac-chip' }, b, raw('span', {}, SCOPE_NAMES()[BAN_SCOPES[i]])))));
  return { node, value: () => boxes.filter(b => b.checked).map(b => b.value) };
}

const scopeText = (b) => { const l = banScopes(b); return l ? t('only: {what}', { what: l.map(s => SCOPE_NAMES()[s]).join(', ') }) : t('everything'); };

function viewBans() {
  const head = [
    el('p', { class: 'ac-sub', text: 'A ban stops an account posting in either chat or writing a note, putting a time on the Scramble of the Day, racing, playing 1v1s, sharing replays and reporting: all of it, or only what is ticked. Its timer and its own synced solves are untouched. The database rules and the Worker enforce it. In the timer, an admin can also ban from a chat message, a board row or a shared replay.' }),
  ];
  const field = (label, input) => el('label', { class: 'ac-field' }, el('span', { class: 'ac-label', text: label }), input);
  const uid = el('input', { class: 'ac-inp', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', maxlength: 128 });
  const name = el('input', { class: 'ac-inp', autocomplete: 'off', maxlength: 32 });
  const reason = el('input', { class: 'ac-inp', autocomplete: 'off', maxlength: 200 });
  const len = el('select', { class: 'ac-inp' }, ...banFor().map((b, i) => raw('option', { value: String(i) }, b.label)));
  const ticks = scopeTicks();
  const form = el('form', { class: 'ac-row ac-ban-form' },
    el('b', { text: 'Ban an account' }),
    field(t('Account id (uid)'), uid),
    field(t('Name, for this list'), name),
    field(t('Reason, which they are shown'), reason),
    field(t('For'), len),
    ticks.node,
    el('div', { class: 'ac-sheet-actions' }, el('button', { class: 'ac-btn primary', type: 'submit', text: 'Ban…' })));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const id = uid.value.trim();
    if (!UID_RE.test(id)) { toast(t('That is not an account id: letters and digits only'), { kind: 'bad', long: true }); return; }
    if (id === S.user?.uid) { toast(t('That is your own account'), { kind: 'bad', long: true }); return; }
    const pick = banFor()[Number(len.value)] || banFor()[0];
    askBan({ uid: id, name: name.value.trim(), reason: reason.value.trim(), ms: pick.ms, scope: ticks.value() });
  });
  if (S.bansRefused) {
    return [...head, gate('Publish the rules first', 'Bans need the firebase.rules.json from this version of the page. Publish it in the Firebase console and reload.')];
  }
  const rows = Object.entries(S.bans).sort((a, b) => (b[1]?.at || 0) - (a[1]?.at || 0));
  const list = !S.loaded.bans ? el('p', { class: 'ac-note', text: 'Loading…' })
    : !rows.length ? el('p', { class: 'ac-note', text: 'Nobody is banned.' })
      : el('ol', { class: 'ac-log' }, ...rows.map(([id, b]) => banRow(id, b)));
  return [...head, form, el('h2', { class: 'ac-h2 ac-gap', text: 'Banned now' }), list];
}

function banRow(id, b) {
  const live = banActive(b);
  const until = typeof b?.until === 'number'
    ? (live ? t('until {when}', { when: new Date(b.until).toLocaleString() }) : t('ended {when}', { when: ago(b.until) }))
    : t('until unbanned');
  return el('li', { class: `ac-entry${live ? '' : ' ac-ended'}` },
    el('div', { class: 'ac-entry-main' },
      raw('b', {}, b?.name || id),
      raw('span', { class: 'ac-uid' }, id),
      raw('span', { class: 'ac-reason' }, b?.reason || '—'),
      raw('span', { class: 'ac-entry-meta', title: b?.at ? new Date(b.at).toLocaleString() : '' },
        [ago(b?.at), b?.by ? t('by {who}', { who: who(b.by) }) : '', until, scopeText(b)].filter(Boolean).join(' · '))),
    el('button', { class: 'ac-btn small', text: live ? t('Unban') : t('Clear'), onclick: () => askUnban(id, b) }));
}

/**
 * Ban `uid`, after a sheet where the reason (which they are shown) and the
 * length can still be changed. `then` runs after it lands (the Moderate tab
 * resolves the reports about it).
 */
function askBan({ uid, name = '', reason = '', ms = 0, then = null, scope = [] }) {
  if (uid === S.user?.uid) { toast(t('That is your own account'), { kind: 'bad', long: true }); return; }
  const why = el('input', { class: 'ac-inp', autocomplete: 'off', maxlength: 200 });
  why.value = String(reason).slice(0, 200);
  const choices = banFor();
  const len = el('select', { class: 'ac-inp' }, ...choices.map((b, i) => raw('option', { value: String(i) }, b.label)));
  len.value = String(Math.max(0, choices.findIndex(b => b.ms === ms)));
  const ticks = scopeTicks(scope);
  const go = el('button', { class: 'ac-btn primary', text: 'Ban' });
  go.addEventListener('click', async () => {
    go.disabled = true;
    const pick = choices[Number(len.value)] || choices[0];
    try {
      await banAccount(S.sdk, { uid, name, reason: why.value.trim(), until: pick.ms ? Date.now() + pick.ms : null, scope: ticks.value(), before: S.bans?.[uid] || null });
      closeSheet();
      toast(t('Banned. They can still use the timer.'), { kind: 'good', long: true });
      await then?.();
    } catch (err) {
      console.warn('[admin] ban refused', err?.code || err);
      toast(t('The database refused that ban'), { kind: 'bad', hold: true });
      go.disabled = false;
    }
  });
  const field = (label, input) => el('label', { class: 'ac-field' }, el('span', { class: 'ac-label', text: label }), input);
  openSheet(
    el('h2', { class: 'ac-h2', text: t('Ban {who}?', { who: name || uid }) }),
    raw('span', { class: 'ac-uid' }, uid),
    field(t('Reason, which they are shown'), why),
    field(t('For'), len),
    ticks.node,
    el('p', { class: 'ac-sub', text: 'Until it ends or you unban them, whatever is ticked, or all of it: chat and notes, Scramble of the Day times, race rooms, 1v1s, sharing replays, reporting. A race account is a throwaway, so a ban on one lasts only as long as that tab’s account.' }),
    el('div', { class: 'ac-sheet-actions' },
      el('button', { class: 'ac-btn', text: 'Back', onclick: closeSheet }),
      go));
}

function askUnban(id, b) {
  const go = el('button', { class: 'ac-btn primary', text: banActive(b) ? t('Unban') : t('Clear') });
  go.addEventListener('click', async () => {
    go.disabled = true;
    try {
      await unbanAccount(S.sdk, id, b || null);
      closeSheet();
      toast(t('Unbanned'), { kind: 'good' });
    } catch (err) {
      console.warn('[admin] unban refused', err?.code || err);
      toast(t('The database refused that'), { kind: 'bad', hold: true });
      go.disabled = false;
    }
  });
  openSheet(
    el('h2', { class: 'ac-h2', text: banActive(b) ? t('Unban {who}?', { who: b?.name || id }) : t('Clear this ended ban?') }),
    el('div', { class: 'ac-sheet-actions' },
      el('button', { class: 'ac-btn', text: 'Back', onclick: closeSheet }),
      go));
}

/* ---------------- account ---------------- */

async function doSignIn() {
  try {
    await signIn('google');
  } catch (err) {
    if (err?.code === 'auth/popup-closed-by-user' || err?.code === 'auth/cancelled-popup-request') return;
    toast(t('Sign-in didn’t work: {why}', { why: err?.code || err?.message || err }), { kind: 'bad', hold: true });
  }
}

async function doSignOut() {
  if (S.edits.size && !confirm(t('Sign out and lose the unsaved changes?'))) return;
  S.edits.clear();
  await signOutUser().catch(() => {});
}

function teardown() {
  moderation.stop();
  sotd.stop();
  modlog.stop();
  rooms.stop();
  health.stop();
  people.stop();
  announce.stop();
  live.stop();
  for (const off of S.unsubs.splice(0)) off();
  S.config = {}; S.meta = {}; S.log = []; S.bans = {}; S.testers = {}; S.scheduled = {};
  S.loaded = { config: false, log: false, bans: false, testers: false };
}

/** A read the rules refuse mid-session: this account was taken off admins/. */
function lost(err) {
  console.warn('[admin] read refused', err?.code || err);
  teardown();
  S.status = 'not-admin';
  S.edits.clear();
  render();
}

function listen() {
  const { db, ref, onValue, query, orderByKey, limitToLast } = S.sdk;
  S.unsubs.push(
    onValue(ref(db, 'config'), (s) => { S.config = s.val() || {}; S.loaded.config = true; scheduleRender(); }, lost),
    onValue(ref(db, 'configMeta'), (s) => { S.meta = s.val() || {}; scheduleRender(); }, lost),
    onValue(query(ref(db, 'configLog'), orderByKey(), limitToLast(LOG_SHOWN)), (s) => {
      const list = [];
      s.forEach((c) => { list.push({ id: c.key, ...c.val() }); });
      S.log = list.reverse();
      S.loaded.log = true;
      scheduleRender();
    }, lost),
    /* Refused here is rules from before bans (phase 1's), not a lost admin:
       the Bans tab says so, and everything else carries on. */
    onValue(ref(db, 'bans'), (s) => { S.bans = s.val() || {}; S.loaded.bans = true; S.bansRefused = false; scheduleRender(); },
      () => { S.bansRefused = true; S.loaded.bans = true; scheduleRender(); }),
    // The same for rules from before testers and schedules (phase 4's).
    onValue(ref(db, 'testers'), (s) => { S.testers = s.val() || {}; S.loaded.testers = true; S.testersRefused = false; scheduleRender(); },
      () => { S.testersRefused = true; S.loaded.testers = true; scheduleRender(); }),
    onValue(ref(db, 'configScheduled'), (s) => { S.scheduled = s.val() || {}; scheduleRender(); }, () => { S.scheduled = {}; }),
  );
}

let checking = 0;

async function onUser(user) {
  const mine = ++checking;
  teardown();
  S.user = user || null;
  if (!user) { S.status = 'signed-out'; S.edits.clear(); render(); return; }
  S.status = 'checking';
  render();
  try {
    S.sdk = S.sdk || await getDatabaseHandle();
    const { admin, rules } = await adminStatus(S.sdk, user);
    if (mine !== checking) return;
    S.status = !admin ? 'not-admin' : rules === 'old' ? 'old-rules' : 'admin';
  } catch (err) {
    if (mine !== checking) return;
    console.warn('[admin] could not check the account', err?.code || err);
    S.status = 'error';
  }
  render();
  if (S.status === 'admin') { listen(); moderation.start(); }
}

/** A name for a uid, from whatever the console has read: the directory, today's boards, bans. */
const nameOf = (uid) => { people.start(); return people.nameOf(uid) || S.bans?.[uid]?.name || ''; };
const moderation = createModeration({ S, scheduleRender, raw, ago, who, openSheet, closeSheet, askBan, gate, nameOf, rooms: () => rooms, sotd: () => sotd });
const modlog = createModLog({ S, scheduleRender, raw, ago, who, openSheet, closeSheet, gate, nameOf });
const rooms = createRooms({ S, scheduleRender, raw, ago, who, openSheet, closeSheet, askBan, gate, cfg, moderation });
const sotd = createSotd({ S, scheduleRender, raw, ago, who, openSheet, closeSheet, askBan, gate, cfg, moderation });
const announce = createAnnounce({ S, scheduleRender, raw, ago, who, openSheet, closeSheet, gate, cfg });
/** Put a setting change on the save bar and open its section, for the usual review (the Health tab's minVersion). */
function stage(path, value) {
  S.edits.set(path, value);
  location.hash = `#settings/${path.split('/')[0]}`;
  render();
}
const storage = createStorage({ S, scheduleRender, raw, ago, openSheet, closeSheet, rooms, moderation });
const health = createHealth({ S, scheduleRender, raw, ago, who, openSheet, closeSheet, gate, cfg, moderation, stage, storage: () => storage });
const people = createPeople({ S, scheduleRender, raw, ago, who, openSheet, closeSheet, askBan, askUnban, gate, cfg, moderation, rooms, health, modLabel: (a) => modlog.label(a) });
const live = createLive({ S, scheduleRender, raw, ago, who, openSheet, closeSheet, gate, cfg, moderation, rooms, health, scheduledList, scheduledRow });

window.addEventListener('hashchange', () => { closeSheet(); render(); window.scrollTo(0, 0); });
window.addEventListener('beforeunload', (e) => { if (S.edits.size) e.preventDefault(); });
// "5 min ago" goes stale on a page left open.
setInterval(() => { if (S.status === 'admin' && $sheet.hidden) scheduleRender(); }, 60_000);

translateDOM();
render();
preloadAuth();
onAuthChange(onUser).then(() => {
  const err = takeRedirectError();
  if (err) toast(t('Sign-in didn’t work: {why}', { why: err?.code || err?.message || err }), { kind: 'bad', hold: true });
}).catch((err) => {
  console.warn('[admin] auth unavailable', err?.code || err);
  S.status = 'error';
  render();
});
