/* ===========================================================
   Tagda Timer — moderation, shared by the app and the admin page

   Reports (reports/, one per account per item), and the writes that take
   something down. firebase.rules.json decides who may do any of it; ADMIN.md
   §6 has the shapes.
   =========================================================== */

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
