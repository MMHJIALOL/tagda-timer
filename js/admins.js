import { t } from './i18n.js';
/* ===========================================================
   Tagda Timer — who is an admin, and who is banned

   `admins/<uid>: true` in the Realtime Database, added by hand in the
   Firebase console; nothing in the app can write it. Each account may read
   its own entry, so asking is one get(). firebase.rules.json and worker.js
   decide what an admin may actually do; this only decides who is shown the
   admin's buttons, and who gets past the admin page's front door.
   =========================================================== */

import { logged } from './moderation.js';

/**
 * The admin before admins/ existed, as the old firebase.rules.json and
 * ADMIN_UIDS in wrangler.jsonc hard-code it. Asked only while the database
 * refuses to answer, which is those old rules: there the uid is what counts.
 */
export const LEGACY_ADMIN_UIDS = ['8lSr96LEO1cdHDVlMDv8tCCFQag1'];

const google = (user) => !!user?.providerData?.some(p => p.providerId === 'google.com');

/**
 * { admin, rules } for a signed-in user. `rules` is 'new' when the database
 * knows about admins/, 'old' when it refused the read (rules from before the
 * admin console). Only Google sign-ins can be admins: race mode's anonymous
 * accounts never are, whatever admins/ says. Rejects on a network failure.
 *
 * @param sdk  getDatabaseHandle()'s { get, ref, db }
 */
export async function adminStatus(sdk, user) {
  if (!user) return { admin: false, rules: 'unknown' };
  try {
    const snap = await sdk.get(sdk.ref(sdk.db, `admins/${user.uid}`));
    return { admin: google(user) && snap.val() === true, rules: 'new' };
  } catch (err) {
    if (!/permission/i.test(`${err?.code} ${err?.message}`)) throw err;
    return { admin: google(user) && LEGACY_ADMIN_UIDS.includes(user.uid), rules: 'old' };
  }
}

/* ---------------------------------------------------------
   Testers
   ---------------------------------------------------------

   testers/<uid>: { at, by, name? }, written by an admin from the admin
   page's People tab, readable by admins and by the account itself. A tester
   gets a feature whose audience is 'testers' (ADMIN.md §9, audience.js).
   --------------------------------------------------------- */

/** Whether `user` is listed under testers/. Refused (rules from before testers): no. */
export async function testerStatus(sdk, user) {
  if (!user) return false;
  try {
    return (await sdk.get(sdk.ref(sdk.db, `testers/${user.uid}`))).exists();
  } catch (err) {
    if (!/permission/i.test(`${err?.code} ${err?.message}`)) throw err;
    return false;
  }
}

/** Make `uid` a tester (admins only; the rules refuse anybody else). */
export function addTester(sdk, { uid, name = '' }) {
  const rec = { at: sdk.serverTimestamp(), by: sdk.auth.currentUser.uid };
  if (name) rec.name = String(name).slice(0, 32);
  return sdk.set(sdk.ref(sdk.db, `testers/${uid}`), rec);
}

/** Take `uid` off the testers. */
export function removeTester(sdk, uid) {
  return sdk.remove(sdk.ref(sdk.db, `testers/${uid}`));
}

/* ---------------------------------------------------------
   Bans
   ---------------------------------------------------------

   bans/<uid>: { at, by, reason, name?, until?, scope? }, written by an admin
   only, readable by admins and by the account itself. Without a scope a
   banned account cannot post in either chat, share a replay, report, race,
   play a 1v1 or put a time or a note on the Scramble of the Day board; with
   one ("chat,reports"), only those (ADMIN.md §5). The timer and its own
   synced data are untouched. firebase.rules.json and worker.js enforce it;
   what follows only writes it and explains it.
   --------------------------------------------------------- */

/** What a ban can be limited to; the same list as js/config-rules.js BAN_SCOPES. */
export const BAN_SCOPES = ['chat', 'sotd', 'race', 'duel', 'replays', 'reports'];

/** A ban's scopes, or null for "everything" (no scope stored, as every ban before scopes). */
export function banScopes(ban) {
  if (typeof ban?.scope !== 'string' || !ban.scope) return null;
  const list = ban.scope.split(',').filter(s => BAN_SCOPES.includes(s));
  return list.length ? list : null;
}

/**
 * Whether a stored ban is in force at `now`: no end date, or one still ahead.
 * With `scope`, whether it is in force for that: a ban with no scope covers all.
 */
export function banActive(ban, now = Date.now(), scope = null) {
  if (!ban || (typeof ban.until === 'number' && ban.until <= now)) return false;
  const list = banScopes(ban);
  return !scope || !list || list.includes(scope);
}

/** What each scope stops, as the end of "This account can’t …". */
const CANT = () => ({
  chat: t('chat or write notes'), sotd: t('put times on the Scramble of the Day'), race: t('race'),
  duel: t('play 1v1s'), replays: t('share replays'), reports: t('report'),
});

/** What a banned account is told, wherever it is stopped: about `scope` there, else everything it covers. */
export function banLine(ban, scope = null) {
  const reason = String(ban?.reason || '').trim() || '—';
  const list = banScopes(ban);
  const until = typeof ban?.until === 'number' ? new Date(ban.until).toLocaleString() : null;
  if (!list && !scope) {
    return until
      ? t('This account can’t post, share replays or submit until {when}. Reason: {reason}', { when: until, reason })
      : t('This account can’t post, share replays or submit. Reason: {reason}', { reason });
  }
  const what = (scope ? [scope] : list).map(s => CANT()[s]).join(', ');
  return until
    ? t('This account can’t {what} until {when}. Reason: {reason}', { what, when: until, reason })
    : t('This account can’t {what}. Reason: {reason}', { what, reason });
}

/**
 * Ban an account. `until` (ms) is optional: without it the ban lasts until an
 * admin lifts it. `scope` (a list of BAN_SCOPES) limits it; empty is all of
 * them. The rules want `at` to be the server's clock and `by` the admin's own
 * uid. Logged (modLog/, ADMIN.md §19) in the same update.
 *
 * @param sdk  getDatabaseHandle()'s { update, push, ref, db, auth, serverTimestamp }
 */
export async function banAccount(sdk, { uid, name = '', reason = '', until = null, scope = [], before = null, undo = '' }) {
  if (!uid) throw new Error('no-uid');
  const rec = { at: sdk.serverTimestamp(), by: sdk.auth.currentUser?.uid, reason: String(reason).slice(0, 200) };
  if (name) rec.name = String(name).slice(0, 32);
  if (until) rec.until = Math.round(until);
  const list = BAN_SCOPES.filter(s => scope.includes(s));
  if (list.length && list.length < BAN_SCOPES.length) rec.scope = list.join(',');
  return logged(sdk, { [`bans/${uid}`]: rec }, { action: 'ban', path: `bans/${uid}`, uid, before, note: rec.reason, undo });
}

/** Lift a ban; `before` (the ban as it was) goes in the log, so Undo can put it back. `undo`: the log entry this undoes. */
export async function unbanAccount(sdk, uid, before = null, undo = '') {
  return logged(sdk, { [`bans/${uid}`]: null }, { action: 'unban', path: `bans/${uid}`, uid, before, undo });
}
