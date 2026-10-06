/* ===========================================================
   Tagda Timer — who has a feature that is on for some people first

   A settings section with an `audience` key ('everyone' | 'testers' |
   'admins', ADMIN.md §9) is on only for those. Where it matters the server
   checks it too (the rules for the day's chat, the Worker for replays);
   this is so the app does not offer what would be refused, and hides it
   rather than saying it is off.

   What the signed-in account is, a tester or an admin, is its own
   testers/<uid> and admins/<uid>, read once per account per page on the
   connection the signed-in app already has (sync.js), never a new one. The
   last answer is kept in localStorage so a feature can be decided as the
   page loads; until an account's answer is in, it is neither.
   =========================================================== */

import { getConfig } from './config.js';
import { adminStatus, testerStatus } from './admins.js';

const KEY = 'tdt-roles';
const asked = new Map();

let me = (() => {
  try {
    const got = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (got && typeof got.uid === 'string') return { uid: got.uid, tester: got.tester === true, admin: got.admin === true };
  } catch { /* nothing kept */ }
  return { uid: null, tester: false, admin: false };
})();

/** The signed-in account's roles as last read: { uid, tester, admin }. */
export const roles = () => ({ ...me });

/** Record what an account is (daily-net reads it too) and tell whoever draws a feature. */
export function setRoles(uid, { tester = false, admin = false } = {}) {
  const next = { uid: uid || null, tester: !!uid && tester === true, admin: !!uid && admin === true };
  if (next.uid === me.uid && next.tester === me.tester && next.admin === me.admin) return;
  me = next;
  try { localStorage.setItem(KEY, JSON.stringify(me)); } catch { /* this page still knows */ }
  if (typeof dispatchEvent === 'function') dispatchEvent(new CustomEvent('tdt-roles'));
}

/**
 * Read `user`'s roles, once per account per page. Signed out (or no
 * account): nobody's. A failed read keeps what was known.
 * @param sdk  getDatabaseHandle()'s { get, ref, db }
 */
export function loadRoles(sdk, user) {
  if (!user) { setRoles(null); return Promise.resolve(roles()); }
  if (me.uid !== user.uid) setRoles(user.uid);           // somebody else's answer is nobody's
  if (!asked.has(user.uid)) {
    asked.set(user.uid, Promise.all([adminStatus(sdk, user), testerStatus(sdk, user)]).then(([a, tester]) => {
      setRoles(user.uid, { admin: a.admin, tester });
      return roles();
    }, (err) => {
      asked.delete(user.uid);
      console.warn('[audience] could not read the roles', err?.code || err);
      return roles();
    }));
  }
  return asked.get(user.uid);
}

/** Whether this account has the feature `section` stands for, by its audience. Nothing set: everybody. */
export function hasFeature(section, uid = me.uid) {
  const a = getConfig(section, 'audience');
  if (!a || a === 'everyone') return true;
  if (!uid || uid !== me.uid) return false;
  if (a === 'testers') return me.tester || me.admin;
  return a === 'admins' && me.admin;
}
