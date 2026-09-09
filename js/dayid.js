/* ===========================================================
   Tagda Timer — Scramble of the Day: the pure half

   Day boundaries, countdowns, solve counting and the avatar-URL check.
   Split out of daily-net.js so that the two callers who need only this can
   have it without the other half: test.html, which exercises every function
   below directly, and main.js, which needs today's date to decide whether to
   show the SOTD chip in the top bar — and must not drag Firebase, the auth
   SDK and the whole transport into the initial page load to ask.

   Nothing here touches the network, the DOM, or the machine's own timezone.
   daily-net.js re-exports all of it, so nothing else had to move.
   =========================================================== */

/* ---------------------------------------------------------
   Pure day/time math — no Firebase, no Date-local-timezone calls, so this
   half of the file is what test.html exercises directly.
   --------------------------------------------------------- */

/** IST is UTC+5:30, year-round — no DST to account for. */
export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * The day id for a server-verified instant, as `YYYY-MM-DD` in IST.
 *
 * Shifting the instant by the IST offset and then reading its UTC calendar
 * fields is what makes this immune to the machine's own timezone: two
 * browsers running this on the same `serverMs`, one set to Tokyo and one to
 * Los Angeles, compute the same string, because neither `getUTCFullYear`
 * nor the shift itself ever consults local time.
 */
export function dayIdFromServerMs(serverMs) {
  const d = new Date(serverMs + IST_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** The UTC epoch ms of the 00:00 IST instant that begins this day id. */
export function dayStartMs(dayId) {
  return Date.parse(`${dayId}T00:00:00.000Z`) - IST_OFFSET_MS;
}

/**
 * The day id `delta` days away from `dayId`.
 *
 * Goes through the boundary instant rather than adding to the calendar
 * fields, so it inherits the same immunity to the machine's timezone that
 * dayIdFromServerMs has: every IST day is exactly 86400000ms wide (no DST),
 * so stepping a boundary by a day and reading the label back is exact.
 */
export function shiftDayId(dayId, delta) {
  return dayIdFromServerMs(dayStartMs(dayId) + delta * 86400000);
}

/** The next reset instant at or after a server-verified instant. */
export function nextResetMs(serverMs) {
  return dayStartMs(dayIdFromServerMs(serverMs)) + 86400000;
}

/**
 * The database path segment for "today", as the epoch ms of its 00:00 IST
 * boundary rather than the `YYYY-MM-DD` label `dayIdFromServerMs` returns.
 *
 * This is what actually keys `daily/<key>/<event>` — not the friendly date
 * string, even though the two always name the same day. The reason is the
 * security rules: a rule can compare a numeric path segment against `now`
 * to reject a write to a day that has not started yet (`$dayStart <= now`),
 * but it has no date parser to pull a comparable instant back out of
 * "2026-09-08". Keying on the string left that check impossible to write,
 * which let any signed-in visitor pre-plant a future day's "official"
 * scramble — solve it in advance, then post an unflaggable time on the day
 * it actually opens. Keying on the boundary's own epoch ms instead makes
 * the rule a one-line comparison instead of a parsing problem.
 */
export function dayKeyFromServerMs(serverMs) {
  return String(dayStartMs(dayIdFromServerMs(serverMs)));
}

/* ---------------------------------------------------------
   The solve-count board
   ---------------------------------------------------------

   The second board is "who has done the most solves today", and it is a
   different kind of thing from the time board above it: no scramble to be
   fair about, no reveal gate, nothing to referee. That lets it be much
   simpler, and the simplification is worth stating outright.

   Nothing increments. Each client counts its OWN solve list against the day
   window and writes the total, and the rule only lets that number climb
   (`newData.val() >= data.val()`). Three things fall out of that:

     - the count is a pure function of a list you already have, so it is
       testable without a database and cannot drift out of step with one;
     - a solve done offline is not lost, because the next write is a total
       rather than a delta that needed to happen at the time;
     - it does not need daily.js to have been loaded when you solved, which
       an increment-per-solve design would have quietly required.

   What it emphatically does NOT get is the time board's anti-cheat. A count
   cannot be checked against anything -- there is no scramble it had to be a
   solve OF, and holding the spacebar is a real solve as far as any of this
   can tell. See DAILY.md; the board is honest about being a volume board.
   --------------------------------------------------------- */

/**
 * An avatar URL, but only if it is one this app is willing to fetch.
 *
 * Board rows are written by other people, and a row's `photo` becomes an
 * `<img src>` in every viewer's browser — including signed-out ones, since
 * the count board is public to read the same way `scramble` and `progress`
 * are. An unrestricted string there is not a cosmetic problem: anyone signed
 * in could write `https://their-server/x.png` straight to the database with
 * no help from this app, and every visitor who opened the board would then
 * hand that server their IP and user agent, on every redraw. That is a
 * tracking beacon on a public page, and it is worth far more to an attacker
 * than the fake solve count the board is already honest about not policing.
 *
 * So the URL is pinned to the host the account picture actually comes from.
 * Anything else — another host, `http:`, a `data:` or `javascript:` URI, a
 * protocol-relative `//evil/x` — is dropped and the row falls back to its
 * initial, which is what most rows are anyway.
 *
 * The identical check is a `.validate` in firebase.rules.json, which is what
 * makes it a rule rather than a request. This copy matters regardless: it is
 * what protects viewers from rows that were written before the rule was, and
 * it keeps a row a bad URL cannot make un-renderable.
 */
export function safePhotoUrl(url) {
  return /^https:\/\/lh[0-9]+\.googleusercontent\.com\//.test(String(url || '')) ? url : null;
}

/** How many of `solves` were recorded inside the IST day beginning at `dayStart`. */
export function countSolvesForDay(solves, dayStart) {
  if (!Array.isArray(solves)) return 0;
  const end = dayStart + 86400000;
  // Half-open, so a solve recorded exactly on a boundary counts for the day
  // it opened and never for both days either side of it.
  return solves.filter(s => {
    const at = s?.createdAt;
    return typeof at === 'number' && at >= dayStart && at < end;
  }).length;
}

/**
 * The solve-count board, most solves first.
 *
 * Ties break on the name rather than on whatever order the database handed
 * the object back in: two people comparing screenshots of the same board
 * have to see the same order, and object key order is not something Firebase
 * promises to keep stable between clients.
 */
export function rankByCount(counts, myUid) {
  return Object.entries(counts || {})
    .map(([uid, c]) => ({
      uid,
      n: Number(c?.n) || 0,
      name: c?.name || 'Cuber',
      photo: safePhotoUrl(c?.photo),
      isMe: uid === myUid,
    }))
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
}

/**
 * "4h 12m", floored to the minute so it never reads as a promise it cannot
 * keep — a viewer who reads "4h 13m" and lands a second later than that is
 * seeing the clock round down like every other countdown they know.
 */
export function formatCountdown(msRemaining) {
  const ms = Math.max(0, msRemaining);
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 1) return 'under a minute';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/* ---------------------------------------------------------
   The "you have already done today's" note
   ---------------------------------------------------------

   Where the top bar looks to decide whether to still be inviting you. It
   lives in this half of the feature, not in daily.js, because main.js has
   to answer the question on first paint — loading Firebase to render a top
   bar would undo the whole reason that module is lazy — and because signing
   out has to be able to clear it without loading Firebase either.

   Cosmetic on purpose. It retires a button; it grants nothing. Editing it by
   hand gets the gold pill back, which a reload would also have given you,
   and whether you may actually submit is decided by a database rule that has
   never heard of it.
   --------------------------------------------------------- */

export const SOTD_DONE_KEY = 'tdt.sotd.doneDay';

/** Fired whenever the note changes, so the chip redraws without a reload. */
function announce(dayId) {
  window.dispatchEvent(new CustomEvent('sotd-done', { detail: { dayId } }));
}

export function markSotdDone(dayId) {
  if (!dayId) return;
  try { localStorage.setItem(SOTD_DONE_KEY, dayId); } catch { /* private mode */ }
  announce(dayId);
}

/**
 * Forget it, and say so.
 *
 * Called on sign-out and whenever the database says this account has no
 * result for today after all. The note is one line of localStorage shared by
 * every identity that uses this browser, so without this it outlived the
 * account that earned it: sign out and the chip stayed retired all day even
 * though a signed-out visitor has no attempt in and cannot have one, and
 * signing in as somebody else inherited the first account's finished day.
 */
export function clearSotdDone() {
  try { localStorage.removeItem(SOTD_DONE_KEY); } catch { /* private mode */ }
  announce(null);
}

/** Whether today, by this device's clock, is the day last submitted. */
export function sotdDoneOn(dayId) {
  try { return localStorage.getItem(SOTD_DONE_KEY) === dayId; } catch { return false; }
}
