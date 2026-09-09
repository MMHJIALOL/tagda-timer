/* ===========================================================
   Tagda Timer — race mode configuration

   Everything you have to fill in yourself lives in this one file, for the
   same reason spotifyapp.js exists: the rest of the feature should never
   need editing to get it running.

   Two transports ship, and they answer two different questions:

     'local'    — same browser, several tabs. Needs nothing at all. This is
                  how you develop and how you demo it. It cannot reach
                  another machine, and it enforces nothing (see below).
     'firebase' — real racing between real people over the internet.

   Race mode falls back to 'local' automatically while FIREBASE_CONFIG is
   null, so the feature is usable the moment you pull the branch.
   =========================================================== */

/**
 * Paste the config object out of the Firebase console here
 * (Project settings → General → Your apps → SDK setup, "Config").
 *
 * It is meant to be public — Firebase identifies your project with it and
 * nothing more. What actually protects the data is the rules file
 * (firebase.rules.json), which is where every guarantee in RACE.md is
 * enforced. Shipping the config without those rules is the mistake to avoid.
 *
 * @type {null | {apiKey:string, authDomain:string, databaseURL:string, projectId:string, appId:string}}
 */
/**
 * Hosts that serve Firebase's sign-in helper from their OWN origin.
 *
 * `signInWithPopup` relays its result back to the opener through a hidden
 * iframe on `authDomain`. Pointed at tagda-timer.firebaseapp.com while the
 * app is served from somewhere else, that iframe is third-party — exactly
 * what Firefox's strict tracking protection (so: Zen) and Safari's ITP
 * partition storage for. The popup opens, Google signs you in, and the
 * answer can never make it home; the only way through is a full-page
 * redirect, which is a worse experience and loses the page's state.
 *
 * Firebase's own fix is to stop being third-party: proxy `/__/auth/*` to
 * the firebaseapp.com handler from your own domain (see vercel.json) and
 * name your own domain here, so the iframe and the popup are same-origin
 * and there is no partitioned storage left to block.
 *
 * Listed host by host rather than just using `location.hostname`, because
 * getting this wrong breaks sign-in outright rather than degrading it:
 * on localhost, a Vercel preview URL, or a fork hosted anywhere without
 * that rewrite, `/__/auth/*` is a 404 and there is nothing to relay
 * through at all. Those keep the firebaseapp.com default.
 *
 * A host added here must ALSO be added to the Google Cloud OAuth client's
 * "Authorized redirect URIs" as https://<host>/__/auth/handler — Google
 * refuses the sign-in with redirect_uri_mismatch otherwise. See README.md's
 * "Sign-in and the /__/auth/* proxy".
 */
const SAME_ORIGIN_AUTH_HOSTS = new Set(['tagdatimer.vercel.app']);

const AUTH_DOMAIN = SAME_ORIGIN_AUTH_HOSTS.has(location.hostname)
  ? location.hostname
  : 'tagda-timer.firebaseapp.com';

export const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyD2PUpGwlnvC244V7L11Z5yDrsMS0Xl8dU',
  authDomain: AUTH_DOMAIN,
  databaseURL: 'https://tagda-timer-default-rtdb.firebaseio.com',
  projectId: 'tagda-timer',
  appId: '1:1069147327222:web:f6e149b2b67cd82fa77ad7',
};

/** Pinned rather than 'latest': a surprise major bump should not break racing. */
export const FIREBASE_VERSION = '10.12.0';

/* ---------------------------------------------------------
   Room shape
   --------------------------------------------------------- */

/**
 * Checked on join in race-net.js. Client-side only: Realtime Database rules
 * cannot count children, so this is a limit, not a guarantee. See RACE.md §2.
 */
export const ROOM_MAX = 24;

/** Rows drawn individually before the rest collapse into "+N more". */
export const ROWS_BEFORE_FOLD = 6;

/** Room codes people have to read out loud, so no 0/O or 1/I/L. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 5;

/* ---------------------------------------------------------
   Timing
   --------------------------------------------------------- */

/** How long the round waits for stragglers once everyone else is done. */
export const GRACE_MS = 45000;

/** Silence past this and you are shown to the room as reconnecting. */
export const SOFT_TIMEOUT_MS = 20000;

/** Silence past this and the round stops waiting for you. */
export const HARD_TIMEOUT_MS = 75000;

/** Presence write interval. Deliberately slow — see the note in race-net.js. */
export const HEARTBEAT_MS = 15000;

/** A room with nobody in it for this long is fair game to reap on next join. */
export const STALE_ROOM_MS = 10 * 60 * 1000;

/* ---------------------------------------------------------
   Anti-cheat tuning
   --------------------------------------------------------- */

/**
 * How far a submitted time may sit from the gap the server itself observed
 * between "started solving" and "finished" before the result is refused.
 *
 * Generous on purpose, and it has to be: the two timestamps are written by
 * network round-trips, so the server's gap is always a little LONGER than the
 * real solve. Refusing a legitimate 8-second solve because someone's wifi
 * hiccuped would be far worse than letting a determined cheat through — the
 * job here is to make fabricating a time inconvenient, not to referee.
 */
export const CLOCK_SLACK_MS = 4000;
export const CLOCK_SLACK_RATIO = 0.25;

/**
 * A result this far below the player's own rolling average gets a flag on it.
 * Flag, never block: a genuine personal best is exactly this shape, and an app
 * that eats your best solve of the year to protect a stranger has its
 * priorities backwards.
 */
export const SUSPECT_RATIO = 0.45;

/* ---------------------------------------------------------
   Room chat
   --------------------------------------------------------- */

/**
 * Longest message the room will accept, matched by the database rule.
 *
 * Short on purpose. This is a sidebar tile a few hundred pixels wide sitting
 * next to a running timer, not a messaging app — a cap that forces a sentence
 * rather than a paragraph is the difference between chat you can read at a
 * glance mid-round and chat that buries the room under it.
 */
export const CHAT_MAX_LEN = 200;

/** How many messages the panel keeps on screen and asks the server for. */
export const CHAT_HISTORY = 60;

/** Minimum gap between two messages from the same client. */
export const CHAT_COOLDOWN_MS = 700;

/**
 * The emoji tray, in the order it is drawn.
 *
 * Twenty, deliberately — enough that the thing you want is usually there,
 * few enough that it is two rows of ten in a 240px rail rather than a
 * scrolling grid nobody reads to the bottom of. Weighted towards what a race
 * room actually says: well played, unlucky, that was a lockup, go again.
 *
 * Lives here rather than in race.js because the Scramble of the Day note
 * composer draws the same tray, and two lists of twenty characters would
 * have drifted apart the first time anybody added one.
 */
export const RACE_EMOJI = [
  '🔥', '😭', '💀', '😂', '🎉', '👏', '🧊', '⚡', '😤', '🙃',
  '👀', '🤝', '💪', '🐢', '🎯', '😅', '🫠', '🥶', '🤯', '🏆',
];
