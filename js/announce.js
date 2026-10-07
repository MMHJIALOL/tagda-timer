/* ===========================================================
   Tagda Timer — announcements: what one is, who sees it, and when

   announcements/<id> in the database, written from the admin page and read
   by the app with one REST fetch per page load (config.js, beside config/):

     { title, text, button?: { label, action: 'link' | 'panel', target },
       style: 'popup' | 'card' | 'pill',
       audience: 'everyone' | 'signedIn' | 'webcamOff' | 'notOpened' | 'newUsers' | 'returningUsers',
       startAt, endAt?, maxShows, version, log, by, updatedAt }

   Three are built in (BUILT_IN): the two the app used to hand-write, and the
   random 1v1 launch, so they behave with no database at all, and so they can
   be edited or pushed again from the admin page. A record in the database
   with the same id replaces the built-in one.

   Pure: no DOM, no storage. The app's manager (main.js, wireAnnouncements)
   and the admin page's preview build on it; announce-ui.js draws them.
   =========================================================== */

export const ANN_STYLES = ['popup', 'card', 'pill'];
export const ANN_AUDIENCES = ['everyone', 'signedIn', 'webcamOff', 'notOpened', 'newUsers', 'returningUsers', 'testers', 'admins'];
/** What a button may open: main.js maps each to its panel (ANN_OPEN). */
export const ANN_PANELS = ['camera', 'sotd', 'race', 'stats', 'appearance', 'settings', 'spotify', 'gear', 'about'];
/** Fewer solves than this on this device is a new user; this many or more, a returning one. */
export const NEW_USER_SOLVES = 50;
export const ANN_ID = /^[a-z0-9-]{1,40}$/;
export const LIMITS = { title: 80, text: 400, label: 30, target: 300, maxShows: 100 };
const HTTPS = /^https:\/\/[^\s]+$/;

/**
 * The announcements the app hand-wrote before the console, and the 1v1 one. The webcam card
 * (once anchored to the camera, wherever it is on screen) and the feedback
 * form's popup, whose link and end come from config/feedback. `answeredBy`
 * names the flags those versions stored, so nobody who answered them is
 * asked again (main.js migrates them once).
 */
export const BUILT_IN = {
  'webcam-replay': {
    title: 'New: replay your solves',
    text: 'Film every attempt with your webcam, watch it back with the clock running, and save it as a video.',
    button: { label: 'Try it', action: 'panel', target: 'camera' },
    style: 'card', audience: 'webcamOff', startAt: 0, endAt: 0, maxShows: 0, version: 1,
  },
  feedback: {
    title: 'Help shape Tagda Timer',
    text: 'Got 2 minutes? Tell us what to build next, what bugs you hit, and which timer you like best. It is anonymous and your name is optional.',
    button: { label: 'Fill the form', action: 'link', target: '' },
    style: 'popup', audience: 'everyone', startAt: 0, endAt: 0, maxShows: 1, version: 1,
    // After "Maybe later", a pill on the main screen until it is crossed out (the old form's).
    reminder: true,
  },
  // The launch of random 1v1 (RACE.md §8), asked for by many: a card pointing at the race flag, for a month.
  // Version 2: version 1 was a popup in the middle, so whoever answered that sees where the flag is once.
  'random-1v1': {
    title: 'New: random 1v1',
    text: 'Race a stranger on 3x3: the same scramble for both of you, head to head, round after round until one of you quits.',
    button: { label: 'Try it', action: 'panel', target: 'race' },
    // 7 Oct to 7 Nov 2026, 00:00 IST.
    style: 'card', audience: 'everyone', startAt: 1791311400000, endAt: 1793989800000, maxShows: 3, version: 2,
  },
};

/** A record made safe to use, or null. Lengths cut, unknown values refused. */
export function normalise(a) {
  if (!a || typeof a !== 'object') return null;
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);
  const out = {
    title: str(a.title, LIMITS.title),
    text: str(a.text, LIMITS.text),
    style: ANN_STYLES.includes(a.style) ? a.style : null,
    audience: ANN_AUDIENCES.includes(a.audience) ? a.audience : 'everyone',
    startAt: num(a.startAt), endAt: num(a.endAt),
    maxShows: Math.min(LIMITS.maxShows, num(a.maxShows)),
    version: Math.max(1, num(a.version)),
    reminder: a.reminder === true,
    button: null,
  };
  const b = a.button;
  if (b && typeof b === 'object' && str(b.label, LIMITS.label)) {
    const target = str(b.target, LIMITS.target);
    if (b.action === 'link' && HTTPS.test(target)) out.button = { label: str(b.label, LIMITS.label), action: 'link', target };
    if (b.action === 'panel' && ANN_PANELS.includes(target)) out.button = { label: str(b.label, LIMITS.label), action: 'panel', target };
  }
  if (!out.style || !out.title) return null;
  return out;
}

/**
 * Every announcement, by id: the built-in ones (with config/feedback filled
 * into the form's), then the database's, which replace them on the same id.
 *
 * @param stored     announcements/ as fetched, or null
 * @param getConfig  config.js getConfig, for the built-in form's link and end
 */
export function allAnnouncements(stored, getConfig) {
  const out = {};
  for (const [id, a] of Object.entries(BUILT_IN)) {
    const rec = { ...a, button: a.button ? { ...a.button } : null };
    if (id === 'feedback' && getConfig) {
      rec.button.target = getConfig('feedback', 'url');
      rec.endAt = getConfig('feedback', 'endAt');
    }
    const n = normalise(rec);
    if (n) out[id] = { ...n, id, builtIn: true };
  }
  for (const [id, a] of Object.entries(stored || {})) {
    if (!ANN_ID.test(id)) continue;
    const n = normalise(a);
    if (n) out[id] = { ...n, id, builtIn: !!BUILT_IN[id], stored: true };
  }
  return out;
}

/** Between its start and its end. An end of 0 is none. */
export const isLive = (a, now = Date.now()) => now >= (a.startAt || 0) && (!a.endAt || now < a.endAt);

/**
 * Whether `who` is in the announcement's audience.
 * @param who  { signedIn, webcamOn, solves, opened: Set of panel ids }
 */
export function inAudience(a, who) {
  switch (a.audience) {
    case 'signedIn': return !!who.signedIn;
    case 'webcamOff': return !who.webcamOn;
    // Has not opened the panel the button goes to (a link: has not followed this one).
    case 'notOpened': return !(a.button?.action === 'panel' && who.opened?.has(a.button.target));
    case 'newUsers': return (who.solves ?? 0) < NEW_USER_SOLVES;
    case 'returningUsers': return (who.solves ?? 0) >= NEW_USER_SOLVES;
    // testers/<uid> and admins/<uid>, as audience.js last read them for this account (ADMIN.md §9).
    case 'testers': return !!(who.tester || who.admin);
    case 'admins': return !!who.admin;
    default: return true;
  }
}

/**
 * What this browser remembers of one announcement, for its current version:
 * { answer: null | 'clicked' | 'dismissed' | 'later', shows }. A memory of an
 * older version counts for nothing, which is how Show again works.
 */
export function memoryFor(a, mem) {
  const m = mem?.[a.id];
  return m && m.v === a.version ? { answer: m.answer || null, shows: m.shows || 0 } : { answer: null, shows: 0 };
}

/**
 * Whether it should be shown now, as `as` ('main' style, or 'pill' for a
 * popup's reminder). Answered is final, except a popup's "later", which
 * leaves its reminder pill.
 */
export function due(a, mem, who, now = Date.now()) {
  if (!isLive(a, now) || !inAudience(a, who)) return null;
  const m = memoryFor(a, mem);
  if (m.answer === 'later') return a.reminder ? 'pill' : null;
  if (m.answer) return null;
  if (a.maxShows && m.shows >= a.maxShows) return null;
  return a.style;
}

/** The one to show next: popups first, then cards, then pills; the newest start first. */
export function pick(anns, mem, who, now = Date.now()) {
  const rank = { popup: 0, card: 1, pill: 2 };
  let best = null;
  for (const a of Object.values(anns)) {
    const as = due(a, mem, who, now);
    if (!as) continue;
    if (!best || rank[as] < rank[best.as] || (rank[as] === rank[best.as] && (a.startAt || 0) > (best.a.startAt || 0))) best = { a, as };
  }
  return best;
}
