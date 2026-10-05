/* ===========================================================
   Tagda Timer — uploaded profile pictures, on other people's screens

   sync-ui.js lets you swap the Google picture for one you upload. That one
   is a few-KB data: URL in `settings.avatar`, synced to
   users/<uid>/settings with the rest of your settings, so for a long time
   only your own top bar could show it. A board row's or chat message's
   `photo` cannot carry it: the rules pin that field to Google's avatar host,
   because it becomes an <img> in everybody else's browser.

   So the Scramble of the Day board and chat ask for it separately, by uid.
   The rules let a signed-in reader see users/<uid>/settings/avatar and
   nothing else under settings, and only while it is a string of at most
   AVATAR_MAX_LEN, so one oversized value cannot make every viewer of a
   board download it. Anyone who never uploaded one, and every row while the
   database runs rules from before this, keeps the Google picture.

   Your own comes from this device's settings instead: it is right the
   moment you change it, and it shows whichever rules are live.
   =========================================================== */

import { KV, onWrite } from './db.js';
import { getDatabaseHandle } from './sync-auth.js';

export const AVATAR_MAX_LEN = 40000;

/* Settings sync from other devices and, here, from other people, so anything
   that isn't the image data URL sync-ui.js makes is dropped rather than put
   in an <img src>. */
export function safeAvatar(v) {
  return typeof v === 'string' && v.length <= AVATAR_MAX_LEN && /^data:image\/(webp|jpeg);base64,[A-Za-z0-9+/=]+$/.test(v) ? v : '';
}

let own = '';
KV.get('settings', {}).then(s => { own = safeAvatar(s?.avatar); }, () => {});
onWrite('kv', ({ key, value }) => { if (key === 'settings') own = safeAvatar(value?.avatar); });

/** uid → '' or a data URL. For the page's lifetime: a picture changed on another account shows after a reload. */
const known = new Map();
const asking = new Map();

/**
 * The picture `uid` uploaded: a data URL, '' for none (use the Google one),
 * or undefined while nobody has asked yet — see lookupFace.
 */
export function knownFace(uid, isMe = false) {
  if (isMe) return own;
  return uid ? known.get(uid) : '';
}

/** Asks the database once per uid per page. Resolves to a data URL or '', never rejects. */
export function lookupFace(uid) {
  if (!uid || /[.#$[\]/]/.test(uid)) return Promise.resolve('');
  if (known.has(uid)) return Promise.resolve(known.get(uid));
  if (!asking.has(uid)) {
    asking.set(uid, getDatabaseHandle()
      .then(({ db, ref, get }) => get(ref(db, `users/${uid}/settings/avatar`)))
      .then(s => safeAvatar(s.val()), () => '')
      .then(face => { known.set(uid, face); asking.delete(uid); return face; }));
  }
  return asking.get(uid);
}
