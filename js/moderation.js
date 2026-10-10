/* ===========================================================
   Tagda Timer — moderation, shared by the app and the admin page

   Reports (reports/, one per account per item), the writes that take
   something down, and the moderation log they go in (modLog/).
   firebase.rules.json decides who may do any of it; ADMIN.md §6 and §19
   have the shapes.
   =========================================================== */

import { t } from './i18n.js';

/** What can be reported, and the path each kind points at. */
export const REPORT_KINDS = ['chat', 'raceChat', 'replay', 'result'];

/**
 * The key under reportOnce/<uid>/ that makes a report one per account per
 * item: the kind and the path, with the path's slashes made into bars,
 * exactly as the rule builds it.
 */
export const reportKey = (kind, path) => `${kind}|${String(path).split('/').join('|')}`;

/**
 * Report something. Resolves 'sent', or 'already' when this account has
 * reported the same item before (the rules refuse a second; the account can
 * read its own reportOnce to tell the two apart). Throws on any other refusal.
 *
 * @param sdk  getDatabaseHandle()'s { push, update, get, ref, db, auth, serverTimestamp }
 */
export async function sendReport(sdk, { kind, path, text = '' }) {
  const uid = sdk.auth?.currentUser?.uid;
  if (!uid) throw new Error('not-signed-in');
  const key = reportKey(kind, path);
  const id = sdk.push(sdk.ref(sdk.db, 'reports')).key;
  const rec = { by: uid, at: sdk.serverTimestamp(), kind, path };
  if (text) rec.text = String(text).slice(0, 200);
  try {
    await sdk.update(sdk.ref(sdk.db), { [`reports/${id}`]: rec, [`reportOnce/${uid}/${key}`]: id });
    return 'sent';
  } catch (err) {
    const had = await sdk.get(sdk.ref(sdk.db, `reportOnce/${uid}/${key}`)).then(s => s.exists(), () => false);
    if (had) return 'already';
    throw err;
  }
}

/**
 * One Scramble of the Day removal (DAILY.md §10), relative to
 * daily/<dayKey>/<event>: the row goes, a `removed` record says so (the
 * person gets the backup unless `final`), and the count and the share claim
 * are cleared. The rules want all of it in one update.
 */
export function removalUpdate(uid, final, ts) {
  return {
    [`results/${uid}`]: null,
    [`removed/${uid}`]: { at: ts, final: !!final },
    [`progress/${uid}/submitted`]: null,
    [`replayClaim/${uid}`]: null,
  };
}

/* ---------------- the word filter (chatFilter.words, ADMIN.md §19) ---------------- */

/** Lower case, accents off, so "Wörd" and "WORD" are "word". */
const fold = (s) => String(s || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

/**
 * The first word or phrase from `list` (the setting: comma-separated, `*` at
 * the end of one for "and anything after") that `text` has as a whole word,
 * or null. Case and accents do not count; "class" does not match "ass".
 */
export function blockedWord(text, list) {
  const body = fold(text);
  if (!body || typeof list !== 'string' || !list.trim()) return null;
  for (const raw of list.split(',')) {
    const w = fold(raw).trim();
    if (!w || w === '*') continue;
    const stem = w.endsWith('*') ? w.slice(0, -1) : w;
    const esc = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${esc}${w.endsWith('*') ? '' : '(?![\\p{L}\\p{N}])'}`, 'u');
    if (re.test(body)) return raw.trim();
  }
  return null;
}

/** What the person is told when the filter stops a message or a note. */
export const filteredText = (word) => t('That has a word this site doesn’t allow (“{word}”), so it wasn’t sent.', { word });

/* ---------------- the moderation log (ADMIN.md §19) ---------------- */

/** What a modLog entry can say was done. firebase.rules.json lists the same words. */
export const MOD_ACTIONS = ['ban', 'unban', 'removeTime', 'removeRaceTime', 'deleteMessage', 'deleteMessages', 'removeReplay', 'kick', 'letBack',
  'strike', 'unstrike', 'close', 'reopen', 'closeAll', 'deleteRoom', 'keep', 'unkeep', 'retime', 'feature', 'unfeature',
  'dismiss', 'actioned', 'reopenReport', 'deleteAccount'];

/**
 * `updates` (paths from the root) with the log entry that says what they do:
 * modLog/<id> = { by, at, action, path, uid?, before?, note?, undo? }. The
 * rules take it only from an admin, stamped now, in their own name.
 */
export function withLog(sdk, updates, { action, path, uid = '', before = null, note = '', undo = '' }) {
  const id = sdk.push(sdk.ref(sdk.db, 'modLog')).key;
  const e = { by: sdk.auth.currentUser.uid, at: sdk.serverTimestamp(), action, path: String(path).slice(0, 300) };
  if (uid) e.uid = String(uid).slice(0, 128);
  if (before !== null && before !== undefined) e.before = before;
  if (note) e.note = String(note).slice(0, 200);
  if (undo) e.undo = undo;
  return { ...updates, [`modLog/${id}`]: e };
}

const refused = (err) => /permission/i.test(String(err?.code || err?.message || err));

/**
 * Do a moderation action and log it, in one update. On rules from before the
 * log (the whole update refused), the action alone, the way it always went:
 * resolves 'logged' or 'unlogged'. Throws when the action itself is refused.
 */
export async function logged(sdk, updates, entry) {
  try {
    await sdk.update(sdk.ref(sdk.db), withLog(sdk, updates, entry));
    return 'logged';
  } catch (err) {
    if (!refused(err)) throw err;
    await sdk.update(sdk.ref(sdk.db), updates);
    console.warn('[moderation] logged without its entry: modLog needs this version of firebase.rules.json');
    return 'unlogged';
  }
}

