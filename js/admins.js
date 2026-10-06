/* ===========================================================
   Tagda Timer — who is an admin

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
