/* ===========================================================
   Tagda Timer — the gear log
   Which cube you are on, what is in it, and what you changed when.

   Two halves that are deliberately kept apart:
     · the records — IndexedDB CRUD, mirroring db.js
     · the arithmetic — pure functions over plain arrays, so the chart
       filter and the marker placement can be tested without a database.

   cubes.json and lubes.json are autocomplete seeds, never an enum. Nothing
   in this file may refuse a brand or a model it has not heard of: new cubes
   ship faster than those files get edited, and a picker that will not take
   what is actually on your desk is worse than no picker.
   =========================================================== */

import { tx, wrap, KV } from './db.js';
import { uid } from './util.js';

/* ---------------- seeds ----------------
   Fetched on first use rather than imported, because they are data files and
   there is no build step to inline them. Cached for the session, and a
   failure is an empty list — you can still type your own, which is the only
   thing that must never break. */
let _seeds = null;

export function loadSeeds() {
  if (!_seeds) _seeds = (async () => {
    const one = async (path) => {
      try {
        const r = await fetch(path);
        if (!r.ok) throw new Error(`${r.status}`);
        const list = await r.json();
        return Array.isArray(list) ? list : [];
      } catch (err) {
        console.warn(`[gear] ${path} unavailable — the picker falls back to typing`, err);
        return [];
      }
    };
    const [cubes, lubes] = await Promise.all([one('./cubes.json'), one('./lubes.json')]);
    return { cubes, lubes };
  })();
  return _seeds;
}

/* ---------------- records ---------------- */

/**
 * A cube you own. Every field optional — a half-filled record is a cube you
 * have not finished describing, not an error.
 */
export function newGear(fields = {}) {
  return {
    id: uid(),
    name: fields.name || '',
    brand: fields.brand || '',
    model: fields.model || '',
    event: fields.event || '333',
    tension: fields.tension || '',
    lubeBrand: fields.lubeBrand || '',
    lube: fields.lube || '',
    notes: fields.notes || '',
    createdAt: fields.createdAt ?? Date.now(),
  };
}

/** What to call a cube in a list: your own name for it, else what it is. */
export function gearLabel(g) {
  if (!g) return 'Untitled cube';
  if (g.name) return g.name;
  const made = [g.brand, g.model].filter(Boolean).join(' ');
  return made || 'Untitled cube';
}

export const LOG_KINDS = {
  lubed:   'Re-lubed',
  tension: 'Tension changed',
  magnets: 'Magnets changed',
  cleaned: 'Cleaned',
  broke:   'Broke / repaired',
  note:    'Note',
};

/** A dated thing you did to a cube. */
export function newLogEntry(gearId, fields = {}) {
  return {
    id: uid(),
    gearId,
    at: fields.at ?? Date.now(),
    kind: fields.kind || 'note',
    text: fields.text || '',
  };
}

export const Gear = {
  async put(g)   { return wrap((await tx('gear', 'readwrite')).put(g)); },
  async get(id)  { return wrap((await tx('gear')).get(id)); },
  async del(id)  {
    await wrap((await tx('gear', 'readwrite')).delete(id));
    // The log belongs to the cube. Left behind it is unreachable rows that
    // would still be drawn as markers on whatever chart asked for them.
    await GearLog.delFor(id);
    if ((await activeGearId()) === id) await setActiveGearId(null);
  },
  async all() {
    const list = await wrap((await tx('gear')).getAll());
    return list.sort((a, b) => a.createdAt - b.createdAt);
  },
};

export const GearLog = {
  async put(e)   { return wrap((await tx('gearLog', 'readwrite')).put(e)); },
  async del(id)  { return wrap((await tx('gearLog', 'readwrite')).delete(id)); },
  async byGear(gearId) {
    const store = await tx('gearLog');
    return sortLog(await wrap(store.index('byGear').getAll(gearId)));
  },
  async delFor(gearId) {
    const list = await this.byGear(gearId);
    const store = await tx('gearLog', 'readwrite');
    await Promise.all(list.map(e => wrap(store.delete(e.id))));
  },
  async all() { return sortLog(await wrap((await tx('gearLog')).getAll())); },
};

/* Which cube is on the desk right now. A settings key rather than a flag on
   the record, so making one active cannot leave two of them active. */
const ACTIVE_KEY = 'gear.active';
export const activeGearId    = () => KV.get(ACTIVE_KEY, null);
export const setActiveGearId = (id) => KV.set(ACTIVE_KEY, id || null);

/* ---------------- arithmetic ---------------- */

/** Newest first, without disturbing the array it was handed. */
export function sortLog(list) {
  return [...(list || [])].sort((a, b) => b.at - a.at);
}

/**
 * The solves done on one cube.
 *
 * No cube chosen is every solve. A cube chosen is only what was tagged with
 * it — a solve recorded before the gear log existed carries no `cubeId`, and
 * counting it towards whichever cube is selected would be inventing evidence
 * about hardware it was never done on.
 */
export function filterByCube(solves, cubeId) {
  const list = solves || [];
  if (!cubeId) return [...list];
  return list.filter(s => s.cubeId === cubeId);
}

/**
 * Where to draw a vertical rule for each gear event, as an index into
 * `solves`.
 *
 * An event lands on the first solve done after it, because that is the first
 * solve the change could have affected. An event newer than every solve has
 * nothing to mark yet and is dropped rather than pinned to the right-hand
 * edge, where it would read as a change that has already moved the times.
 */
export function markersFor(solves, events) {
  const list = solves || [];
  if (!list.length) return [];
  return (events || [])
    .map((e) => {
      const index = list.findIndex(s => s.createdAt >= e.at);
      return index === -1 ? null : { id: e.id, index, kind: e.kind, at: e.at, text: e.text };
    })
    .filter(Boolean)
    .sort((a, b) => a.index - b.index);
}
