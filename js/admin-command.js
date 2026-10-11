import { t } from './i18n.js';
/* ===========================================================
   Tagda Timer — the admin console's command bar (js/admin.js; ADMIN.md §22)

   Ctrl+K (⌘K) or "/" on a keyboard, the magnifier beside the account on a
   phone: one box that goes anywhere. A page or a sub-tab, any setting (the
   timer's own settings search: aliases, typos), a person from the directory,
   a race room by its code, an open report. Only what this person may open:
   a moderator gets the parts of Moderate they have.
   =========================================================== */

import { el } from './util.js';
import { matchesSetting } from './settings-search.js';

const SHOWN = 12;

/**
 * @param ctx  { S, raw, CONFIG, people, moderation, may(scope), isAdmin(), navigate(hash) }
 */
export function createCommand(ctx) {
  const { raw } = ctx;
  let host = null;

  /** Everything there is to go to, for this person: { label, kind, text, hash }. */
  function items() {
    const out = [];
    const page = (label, hash, text = '') => out.push({ label, kind: t('Page'), text, hash });
    const admin = ctx.isAdmin();
    if (admin) {
      page(t('Today'), '#today', 'dashboard costs connections');
      page(t('Days ahead'), '#days', 'scramble future featured event');
      page(t('Settings'), '#settings');
      page(t('Announce'), '#ann', 'announcements popup card pill');
      page(t('What’s new'), '#news', 'changelog');
      for (const [sub, label] of [['lookup', t('Lookup')], ['support', t('Support')], ['feedback', t('Feedback')], ['requests', t('Requests')],
        ['bans', t('Bans')], ['testers', t('Testers')], ['team', t('Team')]]) page(`${t('People')} › ${label}`, `#people/${sub}`);
      for (const [sub, label] of [['sync', t('Sync')], ['versions', t('Versions')], ['scrambles', t('Scrambles')], ['errors', t('Errors')], ['storage', t('Storage')]]) {
        page(`${t('Health')} › ${label}`, `#health/${sub}`);
      }
      page(t('Change log'), '#log', 'settings history undo');
      page(`${t('Log')} › ${t('Moderation')}`, '#log/mod', 'moderation history undo');
    }
    const mod = [['reports', t('Reports'), ['reports']], ['sotd', t('SOTD'), ['sotd']], ['chats', t('Chats'), ['chat']],
      ['suspect', t('Suspect'), ['sotd', 'race']], ['replays', t('Replays'), ['sotd']], ['rooms', t('Rooms'), ['race']], ['history', t('Room history'), ['race']]];
    for (const [sub, label, needs] of mod) if (needs.some(ctx.may)) page(`${t('Moderate')} › ${label}`, `#mod/${sub}`);
    if (admin) {
      for (const [s, sec] of Object.entries(ctx.CONFIG)) {
        for (const sp of Object.values(sec.keys)) out.push({ label: t(sp.label), kind: t(sec.title), text: [sp.help ? t(sp.help) : '', s].join(' '), hash: `#settings/${s}` });
      }
      for (const p of ctx.people.directory?.() || []) {
        out.push({ label: p.name || p.uid, kind: t('Person'), text: p.uid, hash: `#people/u/${p.uid}` });
      }
    }
    if (ctx.may('race')) {
      for (const id of Object.keys(ctx.moderation.snapshot().rooms || {})) out.push({ label: t('Room {id}', { id }), kind: t('Room'), text: id, hash: `#mod/room/${id}` });
    }
    if (ctx.may('reports')) {
      const seen = new Set();
      for (const r of ctx.moderation.reportsList() || []) {
        if (r.status || seen.has(r.path)) continue;
        seen.add(r.path);
        out.push({ label: r.text || r.path, kind: t('Report'), text: `${r.kind} ${r.path}`, hash: '#mod/reports' });
      }
    }
    return out;
  }

  /** What the query finds, best first: a room code or a uid typed whole goes straight there. */
  function find(query) {
    const q = query.trim();
    if (!q) return items().filter(i => i.kind === t('Page')).slice(0, SHOWN);
    const out = [];
    if (/^[A-Za-z0-9]{3,12}$/.test(q) && ctx.may('race')) out.push({ label: t('Open room {id}', { id: q.toUpperCase() }), kind: t('Room'), hash: `#mod/room/${q.toUpperCase()}` });
    if (/^[A-Za-z0-9]{20,128}$/.test(q) && ctx.isAdmin()) out.push({ label: t('Open {uid}', { uid: q }), kind: t('Person'), hash: `#people/u/${q}` });
    const lq = q.toLowerCase();
    const hits = items().filter(i => matchesSetting(q, { label: i.label, section: i.kind, text: i.text || '' }) || i.label.toLowerCase().includes(lq));
    // A label that starts with it, then one that has it, then a label that is a near miss of it, then
    // the rest (found in a setting's help, say).
    const rank = (i) => (i.label.toLowerCase().startsWith(lq) ? 0 : i.label.toLowerCase().includes(lq) ? 1
      : matchesSetting(q, { label: i.label }) ? 2 : 3);
    return [...out, ...hits.sort((a, b) => rank(a) - rank(b))].slice(0, SHOWN);
  }

  function close() { host?.remove(); host = null; }

  function open() {
    if (host) return;
    const input = el('input', { class: 'ac-inp ac-cmd-input', type: 'search', autocomplete: 'off', spellcheck: 'false',
      placeholder: t('Go to a page, setting, person, room…'), 'aria-label': t('Go to') });
    const list = el('ol', { class: 'ac-cmd-list', role: 'listbox' });
    let found = [], pick = 0;
    const go = (i) => { const it = found[i]; if (!it) return; close(); ctx.navigate(it.hash); };
    const paint = () => {
      found = find(input.value);
      pick = Math.min(pick, Math.max(0, found.length - 1));
      list.replaceChildren(...(found.length ? found.map((it, i) => el('li', {
        class: `ac-cmd-item${i === pick ? ' on' : ''}`, role: 'option', 'aria-selected': String(i === pick),
        onclick: () => go(i), onmousemove: () => { if (pick !== i) { pick = i; paint(); } } },
      raw('span', { class: 'ac-cmd-label' }, it.label), raw('span', { class: 'ac-cmd-kind' }, it.kind)))
        : [el('li', { class: 'ac-cmd-none', text: t('Nothing by that') })]));
    };
    input.addEventListener('input', () => { pick = 0; paint(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); pick = Math.min(found.length - 1, pick + 1); paint(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); pick = Math.max(0, pick - 1); paint(); }
      else if (e.key === 'Enter') { e.preventDefault(); go(pick); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    host = el('div', { class: 'ac-cmd', role: 'dialog', 'aria-label': t('Go to'), onclick: (e) => { if (e.target === host) close(); } },
      el('div', { class: 'ac-cmd-box' }, input, list, raw('p', { class: 'ac-cmd-hint' }, t('↑ ↓ to choose · Enter to go · Esc to close'))));
    document.body.append(host);
    paint();
    input.focus();
  }

  /** Ctrl+K / ⌘K anywhere, "/" when not typing. */
  function wire() {
    addEventListener('keydown', (e) => {
      if (ctx.S.status !== 'admin') return;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '') || document.activeElement?.isContentEditable;
      if ((e.key === 'k' || e.key === 'K') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); host ? close() : open(); }
      else if (e.key === '/' && !typing && !host) { e.preventDefault(); open(); }
    });
  }

  return { open, close, wire, find };
}
