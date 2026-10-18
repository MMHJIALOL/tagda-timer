/* ===========================================================
   Tagda Timer — keybinds

   Every plain-key shortcut, by name, with the key it answers to out of the
   box. settings.keybinds holds only the ones somebody changed, as
   { actionId: 'k1 k2' } — up to two keys each, '' for none. Leaving the
   untouched ones out means a default added in a later version still arrives.

   A key belongs to one action at a time. The editor will not make a clash
   (it asks first), but one can still arrive: two devices syncing different
   choices, or a new default landing on a key somebody already took. resolve()
   settles it the same way every time — a choice somebody made beats a
   default, and between two choices the one earlier in ACTIONS wins — and
   reports the loser so the editor can show it.

   Space, Esc, Tab and Enter are never on offer: the timer, cancelling and
   closing, and moving around the page own them. Ctrl/⌘ chords stay fixed and
   are not in here at all.
   =========================================================== */

import { t } from './i18n.js';

export const MAX_KEYS = 2;

/** [id, group, label, default keys]. Order is display order and tie-break order. */
export const ACTIONS = [
  ['deleteLast', 'Last solve', 'delete last solve',              'Delete Backspace'],
  ['plus2',      'Last solve', 'toggle +2',                      '2'],
  ['dnf',        'Last solve', 'toggle DNF',                     'd'],
  ['noPenalty',  'Last solve', 'clear penalty',                  '0'],
  ['comment',    'Last solve', 'add a comment',                  'c'],
  ['repeat',     'Last solve', 'solve its scramble again',       'r'],
  ['replay',     'Last solve', 'watch its webcam replay',        'w'],

  ['nextScramble', 'Scramble', 'new scramble',                   'n ArrowRight'],
  ['prevScramble', 'Scramble', 'previous scramble',              'ArrowLeft'],
  ['ownScrambles', 'Scramble', 'enter your own scrambles',       'x'],

  ['relayPrev',  'Relay', 'previous puzzle',                     '<'],
  ['relayNext',  'Relay', 'next puzzle',                         '>'],

  ['event',      'Go to', 'event picker',                        'e'],
  ['mode',       'Go to', 'mode + trainer picker',               'm'],
  ['sessions',   'Go to', 'sessions',                            's'],
  ['stats',      'Go to', 'statistics',                          'a'],
  ['history',    'Go to', 'all solves',                          'h'],
  ['appearance', 'Go to', 'appearance',                          't'],
  ['settings',   'Go to', 'settings',                            ','],
  ['cases',      'Go to', 'case picker',                         'k'],
  // No key out of the box: L was given to it and to the Cross + 1 trainer at
  // once, and the trainer always got there first, so it never had one that worked.
  ['learn',      'Go to', 'learn mode on / off',                 ''],
  ['peek',       'Go to', 'show the alg (counts as not knowing it)', 'g'],
  ['palette',    'Go to', 'command palette',                     '/'],
  ['shortcuts',  'Go to', 'this list',                           '?'],
  ['about',      'Go to', 'about',                               'b'],
  ['recon',      'Go to', 'reconstruct a scramble',              'y'],
  ['xp1',        'Go to', 'Cross + 1 trainer',                   'l'],
  ['spotify',    'Go to', 'Spotify',                             'p'],
  ['gear',       'Go to', 'gear',                                'u'],

  ['zen',        'View', 'zen mode',                             'z'],
  ['fullscreen', 'View', 'fullscreen',                           'f'],
  ['cubeView',   'View', '3D / 2D preview',                      'v'],
  ['inspection', 'View', 'toggle inspection',                    'i'],
].map(([id, group, label, def]) => ({ id, group, label, def }));

const BY_ID = new Map(ACTIONS.map(a => [a.id, a]));
export const actionById = id => BY_ID.get(id);

const NOT_KEYS = new Set(['Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'OS', 'CapsLock', 'NumLock',
  'ScrollLock', 'Fn', 'FnLock', 'Dead', 'Unidentified', 'Process', 'Compose', 'ContextMenu']);

/** Why a key cannot be bound, or '' if it can. */
export function reservedWhy(key) {
  if (key === ' ') return t('Space starts and stops the timer');
  if (key === 'Escape') return t('Esc cancels inspection and closes windows');
  if (key === 'Tab' || key === 'Enter') return t('{key} is kept for moving around the page', { key: labelOf(key) });
  if (/^F([1-9]|1[0-2])$/.test(key)) return t('the browser uses {key} itself', { key });
  if (NOT_KEYS.has(key)) return t('that key on its own cannot be a shortcut');
  return '';
}

/** The binding name for a keydown: what e.key says, with letters folded so D and d are one key. */
export function keyOf(e) {
  const k = e.key || '';
  return k.length === 1 ? k.toLowerCase() : k;
}

const LABELS = { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Escape: 'Esc', ' ': 'Space',
  Delete: 'Del', Backspace: '⌫', PageUp: 'PgUp', PageDown: 'PgDn' };
export const labelOf = key => LABELS[key] ?? (key.length === 1 ? key.toUpperCase() : key);

const split = s => (typeof s === 'string' ? s.split(' ').filter(Boolean) : []).slice(0, MAX_KEYS);

/**
 * The live picture: which keys each action has, which key runs which action,
 * and the clashes that were turned away.
 *   keys:      id -> [key]
 *   byKey:     key -> id
 *   clashes:   id -> [{ key, owner }]   keys this action asked for but lost
 */
export function resolve(user) {
  const own = user && typeof user === 'object' ? user : {};
  const keys = {}, byKey = new Map(), clashes = {};
  const take = (a, wanted) => {
    keys[a.id] = [];
    for (const k of wanted) {
      if (reservedWhy(k)) continue;
      const owner = byKey.get(k);
      if (owner && owner !== a.id) (clashes[a.id] ||= []).push({ key: k, owner });
      else if (!owner) { byKey.set(k, a.id); keys[a.id].push(k); }
    }
  };
  for (const a of ACTIONS) if (Object.hasOwn(own, a.id)) take(a, split(own[a.id]));
  for (const a of ACTIONS) if (!Object.hasOwn(own, a.id)) take(a, split(a.def));
  return { keys, byKey, clashes };
}

/**
 * The settings.keybinds to store after giving `id` exactly `wanted`, taking
 * any of those keys away from whoever had them. Entries that match the
 * default again are dropped, so the stored object only ever lists changes.
 */
export function assign(user, id, wanted) {
  const cur = resolve(user).keys;
  const next = { ...(user || {}) };
  const put = (aid, list) => {
    const s = list.join(' ');
    if (s === actionById(aid).def) delete next[aid]; else next[aid] = s;
  };
  for (const [aid, list] of Object.entries(cur)) {
    if (aid === id) continue;
    const kept = list.filter(k => !wanted.includes(k));
    if (kept.length !== list.length) put(aid, kept);
  }
  put(id, wanted.slice(0, MAX_KEYS));
  return next;
}

/** Back to the out-of-the-box key for one action (or all of them with no id). */
export function reset(user, id) {
  if (!id) return {};
  const next = { ...(user || {}) };
  delete next[id];
  return next;
}

/* ---- the live map, kept by main.js ---- */

let live = resolve({});
export function setKeybinds(user) { live = resolve(user); }
/** Which action a keydown runs, if any. */
export const actionFor = e => live.byKey.get(keyOf(e)) || null;
/** The first key of an action, for labels in menus ('' if it has none). */
export const keyLabel = id => (live.keys[id]?.[0] ? labelOf(live.keys[id][0]) : '');

/* ---- where the editor reads and saves, set by main.js ---- */

let store = null;
/** { get: () => settings.keybinds, set: next => saves it }. */
export function useKeybindStore(s) { store = s; }
export const keybindStore = () => store;
