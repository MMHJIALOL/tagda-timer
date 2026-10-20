/* ===========================================================
   Tagda Timer — the 1v1 rating (RATING-PLAN.md)

   Elo, worked out by the Worker's POST /rate and nowhere else: a rating
   any browser computed for itself is one anybody could type in. This file
   is the arithmetic and the decisions, so the Worker bundles it and node
   tests it (js/elo.check.mjs): no DOM, no storage, no imports, no clock.

   A rating belongs to a Google account (ratings/<uid>); a 1v1 seat is
   anonymous and points at one through rooms/<id>/acct/<seat>. The rules
   (firebase.rules.json) hold the same numbers as below: a change of at most
   MAX_STEP, at most PAIR_CAP rated rounds a pair a day, and a rating
   between MIN and MAX.
   =========================================================== */

/** Everybody's first rating. */
export const START = 1000;
/** The rules' range for a rating. */
export const MIN = 100, MAX = 4000;
/** K while a rating is finding its level (the first PROVISIONAL rated rounds), then K_SETTLED. */
export const K_NEW = 40, K_SETTLED = 20, PROVISIONAL = 20;
/** The most one round may move a rating: the rules refuse more. K_NEW never exceeds it. */
export const MAX_STEP = 40;
/** Rated rounds a pair of accounts may play in one day (IST); duel.ratedPairCap can only go lower. */
export const PAIR_CAP = 20;
/** The rules let a player turn +2 back into no penalty for this long after submitting. Until then a round can still change. */
export const PENALTY_WINDOW_MS = 15_000;
/** A little past it, so the rules' `now` is safely past too. */
export const FINAL_SLACK_MS = 500;
/** Events a 1v1 is rated on, and the fastest believable time for each (about the world record). */
export const RATED_EVENTS = ['333'];
export const FLOOR_MS = { 333: 3000 };

/** K for a rating that has `n` rated rounds behind it. */
export const kFor = (n) => (n < PROVISIONAL ? K_NEW : K_SETTLED);

/** The chance Elo gives a player rated `r` of beating one rated `opp`. */
export const expected = (r, opp) => 1 / (1 + 10 ** ((opp - r) / 400));

/**
 * One result as a number to compare: the time plus 2 s for a +2, Infinity
 * for a DNF, null for something that is not a result.
 */
export function effective(res) {
  if (!res || typeof res.timeMs !== 'number' || !Number.isFinite(res.timeMs) || res.timeMs < 0) return null;
  if (res.penalty === 'DNF') return Infinity;
  return res.timeMs + (res.penalty === '+2' ? 2000 : 0);
}

/** How the first time did against the second: 1 a win, 0.5 a draw (equal, or both DNF), 0 a loss. */
export const score = (a, b) => (a === b ? 0.5 : a < b ? 1 : 0);

/** A rating after one round against `opp` that scored `s`: the new value and the change, kept inside MIN..MAX. */
export function step(r, n, opp, s) {
  const next = Math.min(MAX, Math.max(MIN, r + Math.round(kFor(n) * (s - expected(r, opp)))));
  return { r: next, d: next - r || 0 };   // `|| 0`: never a -0
}

/** A stored rating, or a new one. */
export const blank = () => ({ r: START, n: 0, w: 0, l: 0, d: 0, v: 0 });
function asRating(x) {
  const ok = x && [x.r, x.n, x.w, x.l, x.d, x.v].every(Number.isInteger);
  return ok ? { r: x.r, n: x.n, w: x.w, l: x.l, d: x.d, v: x.v } : blank();
}

/** The ratingPair/<day>/<key> key for two accounts: the same whichever way round. */
export const pairKey = (a, b) => (a < b ? `${a}_${b}` : `${b}_${a}`);

/** The day a rated round counts towards: the start of today in IST, as the rules write it. */
export const dayKey = (now) => String(now - ((now + 19_800_000) % 86_400_000));

/**
 * What to do with one finished round of a 1v1, from what the database holds:
 *   { none: why }   nothing to write, now or maybe ever ('not-finished', 'not-a-1v1')
 *   { wait: ms }    ask again in `ms`: a penalty can still change
 *   { skip: why }   mark it unrated: 'event', 'struck', 'unlinked', 'same-account', 'bad-result', 'floor'
 *   { rate: { seats, accounts, s } }   seats in uid order, their Google accounts, and the first seat's score
 * `results` and `struck` are the round's results/ and mod/struck/<round>,
 * `acct` the room's acct/, `now` the server's time.
 */
export function judgeRound({ event, results, acct, struck, now }) {
  const seats = Object.keys(results || {}).filter(s => results[s] && typeof results[s] === 'object').sort();
  if (seats.length < 2) return { none: 'not-finished' };
  if (seats.length > 2) return { none: 'not-a-1v1' };
  if (!RATED_EVENTS.includes(event)) return { skip: 'event' };
  if (seats.some(s => struck && struck[s])) return { skip: 'struck' };
  const accounts = seats.map((s) => {
    const a = acct && acct[s];
    return a && a.ok === true && typeof a.claim === 'string' && /^[A-Za-z0-9]{1,128}$/.test(a.claim) ? a.claim : null;
  });
  if (accounts.some(g => !g)) return { skip: 'unlinked' };
  if (accounts[0] === accounts[1]) return { skip: 'same-account' };
  const last = Math.max(...seats.map(s => Number(results[s].submittedAt) || 0));
  const due = last + PENALTY_WINDOW_MS + FINAL_SLACK_MS;
  if (now < due) return { wait: due - now };
  const t = seats.map(s => effective(results[s]));
  if (t.some(x => x === null)) return { skip: 'bad-result' };
  if (t.some(x => x < (FLOOR_MS[event] || 0))) return { skip: 'floor' };
  return { rate: { seats, accounts, s: score(t[0], t[1]) } };
}

/**
 * The one root update that rates a round, all or nothing: both ratings
 * (version + 1), the pair's count for the day, the room's rated/<round>
 * marker and both seats' elo/ for the card. `ratings` are the two accounts'
 * stored ratings (null for none yet), `pairCount` the pair's count so far
 * today, `ts` what the database should stamp as its own time.
 * Returns { patch, seats: { <seat>: { r, d } } }.
 */
export function roundUpdate({ room, round, seats, accounts, s, ratings, pairCount, day, ts }) {
  const [a, b] = ratings.map(asRating);
  const sa = step(a.r, a.n, b.r, s);
  const sb = step(b.r, b.n, a.r, 1 - s);
  const next = (cur, st, mine) => ({
    r: st.r, n: cur.n + 1,
    w: cur.w + (mine === 1 ? 1 : 0), l: cur.l + (mine === 0 ? 1 : 0), d: cur.d + (mine === 0.5 ? 1 : 0),
    v: cur.v + 1, at: ts,
  });
  const out = { [seats[0]]: { r: sa.r, d: sa.d }, [seats[1]]: { r: sb.r, d: sb.d } };
  const patch = {
    [`ratings/${accounts[0]}`]: next(a, sa, s),
    [`ratings/${accounts[1]}`]: next(b, sb, 1 - s),
    [`ratingPair/${day}/${pairKey(accounts[0], accounts[1])}`]: (pairCount || 0) + 1,
    [`rooms/${room}/rated/${round}`]: { at: ts, ...out },
    [`rooms/${room}/elo/${seats[0]}`]: { r: sa.r, n: a.n + 1 },
    [`rooms/${room}/elo/${seats[1]}`]: { r: sb.r, n: b.n + 1 },
  };
  return { patch, seats: out };
}

/** A stored rated/<round> as the Worker answers it: { at, skip } or { at, seats }. */
export function ratedView(node) {
  if (!node || typeof node !== 'object') return null;
  if (typeof node.skip === 'string') return { at: node.at, skip: node.skip };
  const seats = {};
  for (const [k, v] of Object.entries(node)) if (k !== 'at' && k !== 'skip' && v && typeof v === 'object') seats[k] = { r: v.r, d: v.d };
  return { at: node.at, seats };
}
