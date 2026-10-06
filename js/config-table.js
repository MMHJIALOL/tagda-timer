/* ===========================================================
   Tagda Timer — the settings table

   CONFIG below is the whole list: every setting, its default, and the
   range it may take. Everything else is built from it and nothing else:
     - getConfig() in js/config.js, what the app reads;
     - worker.js, which reads the replay settings itself;
     - the admin page's forms (js/admin.js);
     - the `config` block of firebase.rules.json, written by
       `node tools/config-rules.mjs` (and checked by test.html, so the two
       cannot drift);
     - the tables in ADMIN.md.

   Pure data and pure functions, so the Worker can bundle it: no DOM, no
   storage, no imports.

   The default is today's hard-coded value, and it is what everything runs
   on whenever the database has nothing, has junk, or cannot be reached. A
   number's range is the safe side of it: where a setting guards money or
   abuse, the end that would cost more is the old constant itself, and the
   code clips to it as well as the rules (ADMIN.md, "Ceilings").
   =========================================================== */

const MB = 1024 * 1024;

/**
 * One entry per section, one per key inside it.
 *   type   'bool' | 'int' | 'text'
 *   def    the built-in default
 *   min, max   ints: the range. text: `max` characters.
 *   unit, factor   ints shown in the admin page as value / factor, in `unit`
 *   where  where it is enforced: 'rules', 'worker', 'app' or 'nowhere' (ADMIN.md)
 */
export const CONFIG = {
  replays: {
    title: 'Shared replays',
    about: 'Scramble of the Day clips in R2. The Worker reads these, about once a minute, and refuses past them. The money ceilings stay in the code.',
    keys: {
      enabled: { type: 'bool', def: true, label: 'Sharing and watching', where: 'worker',
        help: 'Off: nobody can share or watch a replay. The clips stay, and come back when this is on.' },
      message: { type: 'text', def: '', max: 200, label: 'Message while off', where: 'app',
        help: 'Shown where Share replay would be. Empty: “Replays are switched off for now”.' },
      maxPerDay: { type: 'int', def: 1000, min: 0, max: 1000, label: 'Replays a day', unit: 'clips', where: 'worker',
        help: 'The first this many shares of the day, all events together. 1000 is one page of R2’s list, the ceiling.' },
      maxClipBytes: { type: 'int', def: 10 * MB, min: MB, max: 10 * MB, factor: MB, unit: 'MB', label: 'Biggest clip', where: 'worker',
        help: 'The copy is encoded to fit under this. Ceiling 10 MB (CLIP_MAX).' },
      dayBudgetBytes: { type: 'int', def: 1024 * MB, min: 10 * MB, max: 1024 * MB, factor: MB, unit: 'MB', label: 'Space a day', where: 'worker',
        help: 'All events together. Ceiling 1024 MB (DAY_BUDGET), which keeps R2 storage under its free 10 GB.' },
      keepDays: { type: 'int', def: 7, min: 1, max: 7, unit: 'days', label: 'Kept for', where: 'worker',
        help: 'Days after the day itself. The bucket deletes everything after 8 days anyway, so 7 is the ceiling.' },
    },
  },
  sotdChat: {
    title: 'Scramble of the Day chat',
    about: 'The day’s room for each event. The database rules read these: a message past them is refused whatever the app says.',
    keys: {
      enabled: { type: 'bool', def: true, label: 'Posting', where: 'rules',
        help: 'Off: nobody can post. The room can still be read and messages deleted.' },
      message: { type: 'text', def: '', max: 200, label: 'Message while off', where: 'app',
        help: 'Shown in place of the box you type in. Empty: “The chat is switched off for now”.' },
      gapMs: { type: 'int', def: 1500, min: 1500, max: 600000, unit: 'ms', label: 'Time between messages', where: 'rules',
        help: 'Per account. 1500 is today’s rule and the floor: it can only get slower.' },
      maxLen: { type: 'int', def: 200, min: 20, max: 200, unit: 'characters', label: 'Longest message', where: 'rules' },
    },
  },
  race: {
    title: 'Race rooms',
    about: 'Live rooms between people, on anonymous accounts. Read by the database rules.',
    keys: {
      enabled: { type: 'bool', def: true, label: 'New rooms', where: 'rules',
        help: 'Off: no new rooms. Rooms already open carry on until everybody leaves.' },
      message: { type: 'text', def: '', max: 200, label: 'Message while off', where: 'app',
        help: 'Shown in the race panel. Empty: “New race rooms are switched off for now”.' },
    },
  },
  raceChat: {
    title: 'Race chat',
    about: 'The chat inside a race room. Read by the database rules.',
    keys: {
      enabled: { type: 'bool', def: true, label: 'Posting', where: 'rules',
        help: 'Off: nobody can post in any room.' },
      message: { type: 'text', def: '', max: 200, label: 'Message while off', where: 'app',
        help: 'Shown in place of the box you type in. Empty: “Room chat is switched off for now”.' },
      gapMs: { type: 'int', def: 500, min: 500, max: 600000, unit: 'ms', label: 'Time between messages', where: 'rules',
        help: 'Per account, in the rules since this page. The app waits 0.7 s or this plus half a second, whichever is longer.' },
      maxLen: { type: 'int', def: 200, min: 20, max: 200, unit: 'characters', label: 'Longest message', where: 'rules' },
    },
  },
  app: {
    title: 'The app',
    about: 'Read by the timer when a page loads, and again when a tab comes back into view.',
    keys: {
      minVersion: { type: 'int', def: 0, min: 0, max: 100000, label: 'Oldest version allowed', where: 'app', deployed: true,
        help: 'An open tab older than this says a new version is ready and reloads, once its timer is idle. Never mid-solve.' },
    },
  },
  sandbox: {
    title: 'Sandbox',
    about: 'Nothing reads these. They are here to try the page with: change one, find it in the log, undo it.',
    keys: {
      on:   { type: 'bool', def: false, label: 'A switch', where: 'nowhere' },
      n:    { type: 'int', def: 5, min: 0, max: 10, label: 'A number', where: 'nowhere' },
      text: { type: 'text', def: '', max: 80, label: 'A line of text', where: 'nowhere' },
    },
  },
};

/** A section or key name, as the rules and the log's `path` allow it. */
export const NAME = /^[a-zA-Z]{1,24}$/;

export function spec(section, key) {
  return CONFIG[section]?.keys?.[key] || null;
}

/** Every setting as [section, key, spec], in table order. */
export function allSettings() {
  return Object.entries(CONFIG).flatMap(([s, sec]) => Object.entries(sec.keys).map(([k, sp]) => [s, k, sp]));
}

/**
 * A stored value made safe to use, or undefined when it is not one. A number
 * past the range is clipped to it rather than thrown away: the ceiling is
 * min(setting, max), whatever reached the database.
 */
export function clean(sp, v) {
  if (!sp) return undefined;
  if (sp.type === 'bool') return typeof v === 'boolean' ? v : undefined;
  if (sp.type === 'int') {
    if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
    return Math.min(sp.max, Math.max(sp.min, Math.round(v)));
  }
  if (sp.type === 'text') return typeof v === 'string' ? v.slice(0, sp.max) : undefined;
  return undefined;
}

/** Whether `v` may be written as it is: what the rules accept, checked before sending. */
export function valid(sp, v) {
  if (!sp) return false;
  if (sp.type === 'bool') return typeof v === 'boolean';
  if (sp.type === 'int') return Number.isInteger(v) && v >= sp.min && v <= sp.max;
  if (sp.type === 'text') return typeof v === 'string' && v.length <= sp.max;
  return false;
}

/** A whole section of stored values ({ key: value }) with every key cleaned or defaulted. */
export function sectionOf(section, stored) {
  const out = {};
  for (const [k, sp] of Object.entries(CONFIG[section]?.keys || {})) {
    const v = clean(sp, stored?.[k]);
    out[k] = v === undefined ? sp.def : v;
  }
  return out;
}
