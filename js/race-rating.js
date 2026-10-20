/* ===========================================================
   Tagda Timer — a random 1v1's ratings, on the page (RATING-PLAN.md §8)

   The page never works a rating out: the Worker's POST /rate does, as its
   own account, and writes it where this file only reads it:
     rooms/<id>/elo/<seat>       each seat's rating now, for the card
     rooms/<id>/rated/<round>    each round's change ({ <seat>: { r, d } }),
                                 or why it was not rated ({ skip })
   What this file does is ask. When a round settles it asks /rate for that
   round; the Worker says to wait while a +2 can still be undone (15 s after
   the last time went in), and is asked again then. Both players ask; the
   first ask does the work and the other reads it back, so a round is still
   rated when one of them has quit.

   Nothing is shown until the Worker says ratings are on (GET /rate): with
   no service-account secret, rules from before ratings, or duel.rated off,
   a 1v1 looks exactly as it did.
   =========================================================== */

import { t } from './i18n.js';
import { getConfig } from './config.js';
import { hasPersistedSession } from './sync-auth.js';

const START = 1000;                   // js/elo.js START: a rating nobody has earned yet
const ON_TTL_MS = 5 * 60_000;         // how long the Worker's "ratings are on" is believed
const RETRY_FINISH_MS = [4000, 12000]; // one time still missing: ask again, twice, then let it go
const RETRY_BUSY_MS = 2500;

let onAt = 0, onP = null;

/** Whether the Worker rates 1v1s at all right now (GET /rate): the secret, the rules and duel.rated. */
export function ratingsOn() {
  if (!getConfig('duel', 'rated')) return Promise.resolve(false);
  if (onP && Date.now() - onAt < ON_TTL_MS) return onP;
  onAt = Date.now();
  onP = fetch('/rate', { cache: 'no-store' })
    .then(r => (r.ok ? r.json() : null))
    .then(j => j?.on === true)
    .catch(() => false);
  return onP;
}

let mineAt = 0, mineP = null;

/**
 * Your own rating, for the Find an opponent card: { r, n } (n 0 when you
 * have no rated round yet), 'signed-out', or null when ratings are off or
 * the read is refused. Read once with the timer's own sign-in (ratings/<uid>
 * is readable by its account), kept a minute; `fresh` reads it again.
 */
export function myRating(fresh = false) {
  if (!fresh && mineP && Date.now() - mineAt < 60_000) return mineP;
  mineAt = Date.now();
  mineP = (async () => {
    if (!(await ratingsOn())) return null;
    if (!hasPersistedSession()) return 'signed-out';
    try {
      const { getDatabaseHandle } = await import('./sync-auth.js');
      const sdk = await getDatabaseHandle();
      await sdk.auth.authStateReady?.();
      const user = sdk.auth.currentUser;
      if (!user) return 'signed-out';
      const v = (await sdk.get(sdk.ref(sdk.db, `ratings/${user.uid}`))).val();
      return { r: Number.isInteger(v?.r) ? v.r : START, n: Number.isInteger(v?.n) ? v.n : 0 };
    } catch (err) {
      console.warn('[rating] own rating unreadable', err?.code || err?.message || err);
      return null;
    }
  })();
  return mineP;
}

/** "+16", "−12", "±0". */
export const deltaText = (d) => (d > 0 ? `+${d}` : d < 0 ? `−${-d}` : '±0');

/**
 * One 1v1's ratings: started when the opponent arrives, stopped on leaving.
 * `race` is the Race (js/race.js); `onChange` redraws its panel.
 */
export class DuelRating {
  constructor(race, onChange) {
    this.race = race;
    this.onChange = onChange;
    this.room = null;
    this.state = 'pending';           // 'pending' | 'on' | 'unavailable' | 'off'
    this.elo = {};
    this.rated = {};
    this._asked = new Set();
    this._timers = new Set();
    this._unsub = [];
  }

  /** For this room: find out whether ratings are on, then listen. Again for the same room is nothing. */
  async start(room) {
    if (this.room === room) return;
    this.stop();
    this.room = room;
    const on = await ratingsOn();
    if (this.room !== room) return;
    this.state = on ? 'on' : 'unavailable';
    if (on) {
      const net = this.race.net;
      this._unsub.push(
        net.ratedOn((v) => { this.rated = v || {}; this.onChange(); }),
        net.eloOn((v) => { this.elo = v || {}; this.onChange(); }),
      );
    }
    // Whatever was asked for while the Worker was still being asked whether ratings are on.
    const queued = this._queued || [];
    this._queued = [];
    for (const no of queued) (no === 'seed' ? this.seed() : this.roundSettled(no));
    this.onChange();
  }

  stop() {
    for (const u of this._unsub) u?.();
    this._unsub = [];
    for (const id of this._timers) clearTimeout(id);
    this._timers.clear();
    this._asked.clear();
    this._queued = [];
    this.room = null;
    this.elo = {};
    this.rated = {};
    this.state = 'pending';
  }

  /** Both linked seats' ratings onto the card, before the first round. Once this seat is linked. */
  seed() {
    if (this.state === 'pending') { (this._queued ||= []).push('seed'); return; }
    if (this.state !== 'on' || this._asked.has('seed')) return;
    this._asked.add('seed');
    this._ask(null);
  }

  /** A round of this 1v1 has settled: ask for its rating. */
  roundSettled(no) {
    if (this.state === 'pending') { (this._queued ||= []).push(no); return; }
    if (this.state !== 'on' || this._asked.has(no) || this.rated[no]) return;
    this._asked.add(no);
    this._ask(no);
  }

  _later(ms, fn) {
    const room = this.room;
    const id = setTimeout(() => { this._timers.delete(id); if (this.room === room) fn(); }, ms);
    this._timers.add(id);
  }

  async _ask(no, tries = 0) {
    const room = this.room;
    const res = await this.race.net?.rate?.(no);
    if (this.room !== room || !res) return;
    const { status, body } = res;
    if (status === 200) {
      // The listener brings it too; this is only sooner.
      if (no != null && body && !this.rated[no]) {
        this.rated = { ...this.rated, [no]: body.skip ? { at: body.at, skip: body.skip } : { at: body.at, ...(body.seats || {}) } };
        this.onChange();
      }
      if (no != null && body?.seats?.[this.race.uid]) myRating(true);
      return;
    }
    if (status === 202 && Number.isFinite(body?.wait)) {
      this._later(Math.max(500, body.wait + 300), () => this._ask(no, tries));
    } else if (status === 409 && body?.error === 'not-finished' && tries < RETRY_FINISH_MS.length) {
      this._later(RETRY_FINISH_MS[tries], () => this._ask(no, tries + 1));
    } else if (status === 409 && body?.error === 'busy' && tries < 1) {
      this._later(RETRY_BUSY_MS, () => this._ask(no, tries + 1));
    } else if (status === 403 && body?.error === 'off') {
      this.state = 'off';
      this.onChange();
    } else if (status === 503) {
      // No secret, or rules from before ratings: as if there were no ratings at all.
      this.state = 'unavailable';
      this.onChange();
    }
  }

  /** The newest round with a marker, as [no, marker], or null. */
  _latest() {
    let best = null;
    for (const [k, v] of Object.entries(this.rated)) {
      const no = Number(k);
      if (v && (!best || no > best[0])) best = [no, v];
    }
    return best;
  }

  /**
   * What the card shows under a seat's name: { r, d } (d undefined until a
   * round has been rated), or null for nothing at all.
   */
  view(seat) {
    if (this.state !== 'on') return null;
    let d, at = -1;
    for (const [k, v] of Object.entries(this.rated)) {
      if (v?.[seat] && Number(k) > at) { at = Number(k); d = v[seat].d; }
    }
    const r = this.elo[seat]?.r ?? (at >= 0 ? this.rated[at][seat].r : undefined);
    return Number.isInteger(r) ? { r, d: Number.isInteger(d) ? d : undefined } : null;
  }

  /**
   * One line on the card when this 1v1 is not being rated, saying why, or ''.
   * `link` is this seat's linkAccount() state, `name` the opponent's.
   */
  note(link, name) {
    if (this.state === 'off') return t('Ratings are off right now');
    if (this.state !== 'on') return '';
    if (link === 'signed-out') return t('Sign in to get a rating');
    const last = this._latest();
    if (!last || typeof last[1].skip !== 'string') return '';
    const [no, { skip }] = last;
    switch (skip) {
      case 'unlinked': return link === 'linked'
        ? t('{name} isn’t signed in, so this 1v1 isn’t rated', { name })
        : t('Sign in to get a rating');
      case 'same-account': return t('You’re both on one account, so this 1v1 isn’t rated');
      case 'cap': return t('Rated rounds with {name} are done for today', { name });
      case 'struck': return t('Round {n} wasn’t rated: a moderator struck a time', { n: no });
      case 'floor': return t('Round {n} wasn’t rated: a time under 3 seconds', { n: no });
      default: return t('Round {n} wasn’t rated', { n: no });
    }
  }

  /** For the panel's redraw signature. */
  sig() {
    const last = this._latest();
    return [this.state, JSON.stringify(this.elo), last ? `${last[0]}:${JSON.stringify(last[1])}` : ''].join('/');
  }
}
