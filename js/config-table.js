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
/** The events that can have a Scramble of the Day (events.js dailyEligible), written out:
    this file imports nothing, so the Worker can bundle it. test.html checks the two agree. */
export const SOTD_EVENTS = ['333', '222', '444', '555', '666', '777', '333bf', '333oh', 'clock', 'minx', 'pyram', 'skewb', 'sq1', '444bf', '555bf', 'fto'];
/** The default floor per event, in ms (sotd.floors): about each world record single, so only a time
    that would be a record is held for a look. FTO has no WCA record; its floor is the best unofficial times. */
export const SOTD_FLOORS = '333:3000,222:400,444:15000,555:30000,666:55000,777:90000,333bf:11500,333oh:5500,clock:1800,minx:22000,pyram:700,skewb:700,sq1:3000,444bf:50000,555bf:120000,fto:8000';
const FLOORS = /^([a-z0-9]{2,12}:[0-9]{1,7}(,[a-z0-9]{2,12}:[0-9]{1,7})*)?$/;
/** sotd.floors as { event: ms }. */
export function floorsOf(text) {
  const out = {};
  if (typeof text !== 'string' || !FLOORS.test(text)) return out;
  for (const part of text.split(',').filter(Boolean)) { const [ev, ms] = part.split(':'); out[ev] = Number(ms); }
  return out;
}
/** The latest a time setting can be: 2100. */
const TIME_MAX = 4102444800000;
/** Who a feature is on for (ADMIN.md §9): the 'choice' a section's `audience` key holds. */
export const AUDIENCES = ['everyone', 'testers', 'admins'];

/**
 * One entry per section, one per key inside it.
 *   type   'bool' | 'int' | 'text' | 'time' (ms since 1970) | 'set' (some of `options`, comma-separated)
          | 'choice' (one of `options`)
 *   def    the built-in default
 *   min, max   ints: the range. text: `max` characters.
 *   unit, factor   ints shown in the admin page as value / factor, in `unit`
 *   pattern  text: 'https', a web address
 *   where  where it is enforced: 'rules', 'worker', 'app' or 'nowhere' (ADMIN.md)
 */
export const CONFIG = {
  replays: {
    title: 'Shared replays',
    about: 'Scramble of the Day clips in R2. The Worker reads these, about once a minute, and refuses past them. The money ceilings stay in the code.',
    keys: {
      enabled: { type: 'bool', def: true, label: 'Sharing and watching', where: 'worker',
        help: 'Off: nobody can share or watch a replay. The clips stay, and come back when this is on.' },
      audience: { type: 'choice', def: 'everyone', options: AUDIENCES, label: 'Who has it', where: 'worker',
        help: 'While it is on: everybody, only testers and admins, or only admins. The Worker checks the account.' },
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
      audience: { type: 'choice', def: 'everyone', options: AUDIENCES, label: 'Who has it', where: 'rules',
        help: 'While it is on: everybody, only testers and admins, or only admins. Everybody else sees no chat at all.' },
      message: { type: 'text', def: '', max: 200, label: 'Message while off', where: 'app',
        help: 'Shown in place of the box you type in. Empty: “The chat is switched off for now”.' },
      gapMs: { type: 'int', def: 1500, min: 1500, max: 600000, unit: 'ms', label: 'Time between messages', where: 'rules',
        help: 'Per account. 1500 is today’s rule and the floor: it can only get slower.' },
      maxLen: { type: 'int', def: 200, min: 20, max: 200, unit: 'characters', label: 'Longest message', where: 'rules' },
    },
  },
  race: {
    title: 'Race rooms',
    about: 'Live rooms between people, on anonymous accounts. The switch is in the database rules; the tuning is read by the app.',
    keys: {
      enabled: { type: 'bool', def: true, label: 'New rooms', where: 'rules',
        help: 'Off: no new rooms. Rooms already open carry on until everybody leaves.' },
      message: { type: 'text', def: '', max: 200, label: 'Message while off', where: 'app',
        help: 'Shown in the race panel. Empty: “New race rooms are switched off for now”.' },
      roomMax: { type: 'int', def: 24, min: 2, max: 24, unit: 'people', label: 'Room size', where: 'app',
        help: 'Checked when somebody joins; the rules cannot count, so it is a limit, not a guarantee. 24 is the ceiling.' },
      graceSec: { type: 'int', def: 45, min: 5, max: 600, unit: 's', label: 'Wait for stragglers', where: 'app',
        help: 'Once everybody else is done, how long a round waits for the rest.' },
      hardTimeoutSec: { type: 'int', def: 75, min: 30, max: 600, unit: 's', label: 'Silence before a racer is dropped', where: 'app' },
      heartbeatSec: { type: 'int', def: 15, min: 15, max: 120, unit: 's', label: 'Presence every', where: 'app',
        help: 'Each racer writes this often. 15 s is the floor: more often costs database writes.' },
      staleRoomMin: { type: 'int', def: 10, min: 1, max: 1440, unit: 'min', label: 'Empty room reaped after', where: 'app' },
      rowsBeforeFold: { type: 'int', def: 6, min: 1, max: 24, unit: 'rows', label: 'Rows before “+N more”', where: 'app' },
      suspectPct: { type: 'int', def: 45, min: 10, max: 90, unit: '%', label: 'Flag times under', where: 'app',
        help: 'Of the person’s own recent average: the ⚑ on race and Scramble of the Day boards. Flagged, never blocked.' },
    },
  },
  duel: {
    title: 'Random 1v1',
    about: 'Matching strangers on 3x3 (RACE.md §8) and the 1v1’s cam and mic (§9). The switches are in the database rules as well as the app; the relay is the Worker’s.',
    keys: {
      enabled: { type: 'bool', def: true, label: 'Find an opponent', where: 'rules',
        help: 'Off: the button shows the message instead of searching, and the rules refuse the waiting seat and new 1v1 rooms. A 1v1 already running plays on.' },
      audience: { type: 'choice', def: 'everyone', options: AUDIENCES, label: 'Who has it', where: 'app',
        help: 'While it is on: everybody, only testers and admins, or only admins. Everybody else does not see Random 1v1 or its announcement.' },
      message: { type: 'text', def: '', max: 200, label: 'Message while off', where: 'app',
        help: 'Shown in place of Find an opponent. Empty: “Random 1v1 is switched off for now”.' },
      searchSec: { type: 'int', def: 60, min: 15, max: 300, unit: 's', label: 'A search gives up after', where: 'app' },
      refreshSec: { type: 'int', def: 10, min: 5, max: 60, unit: 's', label: 'The waiting seat is re-stamped every', where: 'app',
        help: 'Each stamp is one database write by the person waiting.' },
      staleSec: { type: 'int', def: 25, min: 10, max: 120, unit: 's', label: 'A seat is abandoned after', where: 'app',
        help: 'Not re-stamped for this long, the next person takes the seat over. The app keeps it above two stamps, whatever is set here.' },
      showupSec: { type: 'int', def: 15, min: 5, max: 60, unit: 's', label: 'The opponent must arrive within', where: 'app',
        help: 'Matched, but nobody came into the room: search again.' },
      goneSec: { type: 'int', def: 10, min: 5, max: 60, unit: 's', label: 'The opponent gone ends the 1v1 after', where: 'app',
        help: 'Short enough to end a 1v1 somebody quit, long enough for a phone changing network.' },
      camEnabled: { type: 'bool', def: true, label: 'Camera and mic', where: 'rules',
        help: 'Off: the cam and mic buttons are hidden, the rules refuse the call’s setup, and the Worker hands out no relay. Calls already connected carry on until the 1v1 ends.' },
      turnEnabled: { type: 'bool', def: true, label: 'Relay for strict networks (TURN)', where: 'worker',
        help: 'The only part of the site billed by the gigabyte: 1,000 GB a month free, then $0.05/GB. Off: two players behind strict NATs see “Couldn’t connect”; everybody else connects directly as before.' },
      turnTtlMin: { type: 'int', def: 240, min: 10, max: 240, unit: 'min', label: 'A relay login lasts', where: 'worker',
        help: 'How long the credentials the Worker hands out stay good. 240 (4 h, TURN_TTL) is the ceiling.' },
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
  chatFilter: {
    title: 'Word filter',
    about: 'Words the timer will not send, in either chat or a Scramble of the Day note. The app checks them, not the database rules: they cannot read a list, so anybody determined can get round it. It is for the casual case; bans are for the rest.',
    keys: {
      words: { type: 'text', def: '', max: 2000, label: 'Words and phrases', where: 'app',
        help: 'Comma-separated. Whole words only, ignoring case and accents, so “ass” never stops “class”. End one with * for anything starting with it. The person is told which word stopped it.' },
    },
  },
  sotd: {
    title: 'Scramble of the Day',
    about: 'The daily scramble, its boards and its misfire rules. Read by the app.',
    keys: {
      events: { type: 'set', def: SOTD_EVENTS.join(','), options: SOTD_EVENTS, label: 'Events with a daily scramble', where: 'app',
        help: 'Unticked events have no window, board or chat. What is already in the database stays.' },
      countBoard: { type: 'bool', def: false, label: 'The “most solves today” board', where: 'app',
        help: 'Built and switched off (DAILY.md §6): a volume board with nothing behind it.' },
      autoDiscardMs: { type: 'int', def: 2000, min: 0, max: 5000, unit: 'ms', label: 'Misfire: thrown away under', where: 'app',
        help: 'A main-scramble solve this short is discarded and the backup comes up. 2x2, Pyraminx, Skewb and Clock never are.' },
      askMs: { type: 'int', def: 5000, min: 0, max: 15000, unit: 'ms', label: 'Misfire: asked under', where: 'app',
        help: 'Under this (and over the line above), “misfire? Use backup / Keep”.' },
      floors: { type: 'text', def: SOTD_FLOORS, max: 400, pattern: 'floors', label: 'Checked under', where: 'app',
        help: 'Per event, in ms: a time under its floor stays on the board marked “checking” and waits in Moderate › SOTD until an admin keeps or removes it. Roughly the world record, so a normal time never waits. Written event:ms, comma-separated; an event left out is never checked.' },
      frozen: { type: 'bool', def: false, label: 'Board closed for today', where: 'rules',
        help: 'On: no new result is accepted on any event today, whatever the app says. For a scramble that leaked or is broken. The board, its chat and its replays stay.' },
      frozenMessage: { type: 'text', def: '', max: 200, label: 'Message while closed', where: 'app',
        help: 'Shown in place of today’s scramble while the board is closed. Empty: “Today’s board is closed: no new times are taken until the reset.”' },
    },
  },
  competition: {
    title: 'Competition Mode',
    about: 'Averages timed the way a competition runs them (Ao5, Ao12, any AoX). Read by the app.',
    keys: {
      enabled: { type: 'bool', def: true, label: 'Starting a new set', where: 'app',
        help: 'Off: Start Competition Mode shows the message. A set already under way can still be finished, and history still opens.' },
      message: { type: 'text', def: '', max: 200, label: 'Message while off', where: 'app',
        help: 'Empty: “Competition Mode is switched off for now”.' },
    },
  },
  features: {
    title: 'Features',
    about: 'Parts of the timer that lean on one browser feature, so a part that breaks on one browser can be turned off, or given to testers first, without a deploy. Read by the app when a page loads.',
    keys: {
      webcamReplay: { type: 'bool', def: true, label: 'Webcam replays', where: 'app',
        help: 'Off: nothing records, the camera panel shows the message instead of its switch, and Competition Mode starts without replay. Replays already saved on a device can still be watched there.' },
      webcamReplayAudience: { type: 'choice', def: 'everyone', options: AUDIENCES, label: 'Webcam replays: who has it', where: 'app' },
      webcamReplayMessage: { type: 'text', def: '', max: 200, label: 'Webcam replays: message while off', where: 'app',
        help: 'Shown in the camera panel. Empty: “Webcam replays are switched off for now”.' },
      stackmat: { type: 'bool', def: true, label: 'Stackmat timer input', where: 'app',
        help: 'Off: the timer cannot be switched to a Stackmat, and a timer already on one goes back to the keyboard. The microphone is let go.' },
      stackmatAudience: { type: 'choice', def: 'everyone', options: AUDIENCES, label: 'Stackmat: who has it', where: 'app' },
      stackmatMessage: { type: 'text', def: '', max: 200, label: 'Stackmat: message while off', where: 'app',
        help: 'Empty: “Stackmat input is switched off for now”.' },
    },
  },
  health: {
    title: 'Client health',
    about: 'The heartbeat and error reports a signed-in timer sends, which the Health tab is made of (ADMIN.md, "Health"). Read by the app. Anybody can turn both off for their own device in Data Health.',
    keys: {
      enabled: { type: 'bool', def: true, label: 'Heartbeat', where: 'app',
        help: 'Off: no timer sends its heartbeat. What the Health tab already has stays until it is swept after 14 days.' },
      beatMin: { type: 'int', def: 60, min: 15, max: 1440, unit: 'min', label: 'A heartbeat at most every', where: 'app',
        help: 'Per signed-in person and device, and at once when a new version loads. Each is one small database write.' },
      errorsEnabled: { type: 'bool', def: true, label: 'Error reports', where: 'app',
        help: 'Off: no timer reports the errors it hits. At most five different ones a page load, each once.' },
    },
  },
  support: {
    title: 'Support card',
    about: 'The “Enjoying Tagda Timer?” card that points at the coffee link in About. Read by the app.',
    keys: {
      enabled: { type: 'bool', def: true, label: 'Shown at all', where: 'app' },
      oddsPct: { type: 'int', def: 1, min: 0, max: 100, unit: '%', label: 'Page loads that ask', where: 'app',
        help: 'After the one ask everybody who has solved gets, and the quiet days after an answer.' },
      quietDays: { type: 'int', def: 30, min: 1, max: 365, unit: 'days', label: 'Quiet after an answer', where: 'app' },
      shows: { type: 'int', def: 2, min: 0, max: 10, label: 'Times on one page load', where: 'app' },
    },
  },
  feedback: {
    title: 'Feedback form',
    about: 'The built-in “Help shape Tagda Timer” announcement takes its form and its end from here. Change the link and the end, then Show again on the Announce tab.',
    keys: {
      url: { type: 'text', def: 'https://docs.google.com/forms/d/e/1FAIpQLScQ9uZRzZke7bBtlw3lkCW41-UXi9cZ-DksEKKliibsM5UCPQ/viewform',
        max: 300, pattern: 'https', label: 'Form link', where: 'app' },
      endAt: { type: 'time', def: Date.parse('2026-10-01T12:22:00Z'), min: 0, max: TIME_MAX, label: 'Ends', where: 'app' },
    },
  },
  spotify: {
    title: 'Spotify',
    about: 'The built-in connection works only while the site owner has Spotify Premium (SPOTIFY.md §3.4). People with their own connection are not affected.',
    keys: {
      enabled: { type: 'bool', def: true, label: 'Built-in connection', where: 'app',
        help: 'Off: Connect is turned off and nothing polls Spotify through it.' },
      message: { type: 'text', def: '', max: 200, label: 'Message while off', where: 'app',
        help: 'Shown in the Spotify panel. Empty: “The built-in Spotify connection is off for now”.' },
    },
  },
  app: {
    title: 'The app',
    about: 'Read by the timer when a page loads, and again when a tab comes back into view.',
    keys: {
      minVersion: { type: 'int', def: 0, min: 0, max: 100000, label: 'Oldest version allowed', where: 'app', deployed: true,
        help: 'An open tab older than this says a new version is ready and reloads, once its timer is idle. Never mid-solve.' },
      banner: { type: 'text', def: '', max: 200, label: 'Banner', where: 'app',
        help: 'A thin strip across the top of the timer, for everybody. Empty: none, unless the timer is read-only.' },
      bannerKind: { type: 'choice', def: 'info', options: ['info', 'warn', 'down'], label: 'Banner colour', where: 'app' },
      readOnly: { type: 'bool', def: false, label: 'Read-only', where: 'app',
        help: 'For an outage, or before a risky rules publish. Timing works and every solve is kept on the device; sync holds its changes and sends them when this is off again. Races, 1v1s and the Scramble of the Day show the banner instead of their buttons. Not enforced by the rules: a cached old tab can still write.' },
      idleDisconnectMin: { type: 'int', def: 0, min: 0, max: 240, unit: 'minutes', label: 'Let a hidden tab go after', where: 'app',
        help: 'A tab hidden this long closes its database connections and opens them again when it is shown; what changed meanwhile goes then. 0: never. The Spark plan allows 100 connections at once: Today shows how many there are now.' },
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
  if (sp.type === 'int' || sp.type === 'time') {
    if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
    return Math.min(sp.max, Math.max(sp.min, Math.round(v)));
  }
  if (sp.type === 'text') {
    if (typeof v !== 'string') return undefined;
    if (sp.pattern === 'https' && !HTTPS.test(v)) return undefined;
    if (sp.pattern === 'floors' && !FLOORS.test(v)) return undefined;
    return v.slice(0, sp.max);
  }
  if (sp.type === 'choice') return sp.options.includes(v) ? v : undefined;
  if (sp.type === 'set') {
    if (typeof v !== 'string') return undefined;
    // Unknown items dropped, order kept to the table's.
    const got = new Set(v.split(',').filter(Boolean));
    return sp.options.filter(o => got.has(o)).join(',');
  }
  return undefined;
}

const HTTPS = /^https:\/\/[^\s]+$/;

/** Whether `v` may be written as it is: what the rules accept, checked before sending. */
export function valid(sp, v) {
  if (!sp) return false;
  if (sp.type === 'bool') return typeof v === 'boolean';
  if (sp.type === 'int' || sp.type === 'time') return Number.isInteger(v) && v >= sp.min && v <= sp.max;
  if (sp.type === 'text') return typeof v === 'string' && v.length <= sp.max && (sp.pattern !== 'https' || HTTPS.test(v)) && (sp.pattern !== 'floors' || FLOORS.test(v));
  if (sp.type === 'choice') return sp.options.includes(v);
  if (sp.type === 'set') {
    if (typeof v !== 'string') return false;
    const items = v ? v.split(',') : [];
    return items.every(i => sp.options.includes(i)) && new Set(items).size === items.length;
  }
  return false;
}

/** A 'set' setting as an array. */
export const setOf = (v) => (v ? String(v).split(',').filter(Boolean) : []);

/** A whole section of stored values ({ key: value }) with every key cleaned or defaulted. */
export function sectionOf(section, stored) {
  const out = {};
  for (const [k, sp] of Object.entries(CONFIG[section]?.keys || {})) {
    const v = clean(sp, stored?.[k]);
    out[k] = v === undefined ? sp.def : v;
  }
  return out;
}
