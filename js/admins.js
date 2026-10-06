import { t } from './i18n.js';
/* ===========================================================
   Tagda Timer — who is an admin, and who is banned

   `admins/<uid>: true` in the Realtime Database, added by hand in the
   Firebase console; nothing in the app can write it. Each account may read
   its own entry, so asking is one get(). firebase.rules.json and worker.js
   decide what an admin may actually do; this only decides who is shown the
   admin's buttons, and who gets past the admin page's front door.
   =========================================================== */

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
   Bans
   ---------------------------------------------------------

   bans/<uid>: { at, by, reason, name?, until? }, written by an admin only,
   readable by admins and by the account itself. A banned account cannot
   post in either chat, share a replay, or put a time or a note on the
   Scramble of the Day board; the timer and its own synced data are
   untouched. firebase.rules.json and worker.js enforce it; what follows only
   writes it and explains it.
   --------------------------------------------------------- */

/** Whether a stored ban is in force at `now`: no end date, or one still ahead. */
export function banActive(ban, now = Date.now()) {
  return !!ban && !(typeof ban.until === 'number' && ban.until <= now);
}

/** What a banned account is told, wherever it is stopped. */
export function banLine(ban) {
  const reason = String(ban?.reason || '').trim() || '—';
  return typeof ban?.until === 'number'
    ? t('This account can’t post, share replays or submit until {when}. Reason: {reason}',
      { when: new Date(ban.until).toLocaleString(), reason })
    : t('This account can’t post, share replays or submit. Reason: {reason}', { reason });
}

/**
 * Ban an account. `until` (ms) is optional: without it the ban lasts until an
 * admin lifts it. The rules want `at` to be the server's clock and `by` the
 * admin's own uid.
 *
 * @param sdk  getDatabaseHandle()'s { set, ref, db, auth, serverTimestamp }
 */
export async function banAccount(sdk, { uid, name = '', reason = '', until = null }) {
  if (!uid) throw new Error('no-uid');
  const rec = { at: sdk.serverTimestamp(), by: sdk.auth.currentUser?.uid, reason: String(reason).slice(0, 200) };
  if (name) rec.name = String(name).slice(0, 32);
  if (until) rec.until = Math.round(until);
  await sdk.set(sdk.ref(sdk.db, `bans/${uid}`), rec);
}

export async function unbanAccount(sdk, uid) {
  await sdk.remove(sdk.ref(sdk.db, `bans/${uid}`));
}
