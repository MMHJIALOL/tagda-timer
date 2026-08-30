/* ===========================================================
   Tagda Timer — the registered Spotify application

   This identifier is public by design. PKCE exists precisely so that a
   browser app needs no client secret: the ID is already sent in plain text
   in the authorize URL from every visitor's browser, so committing it leaks
   nothing. The secret is a different string, is not used by this flow, and
   must never appear in this repository.

   Kept in its own file so main.js can know a built-in app exists without
   pulling in the whole OAuth client — the rest of spotify.js is still only
   fetched once someone actually links an account.

   Redirect URIs registered against it (both must stay registered, and any new
   deploy origin has to be added here *and* in the dashboard before it works):
     https://tagdatimer.vercel.app/
     http://127.0.0.1:5199/          — local development
   =========================================================== */

export const SPOTIFY_CLIENT_ID = 'da6c13c1ef5f490db321d6385b0c6294';

/**
 * The app is in Spotify's development mode, which allows at most 5 listed
 * users. Add people by email under Settings -> User Management.
 *
 * This was 25 until Spotify lowered it. Extended quota mode -- the only way
 * past the cap -- has been organisation-only since 15 May 2025 and requires a
 * registered business with 250k+ monthly active users, so for a project this
 * size the cap is permanent rather than a to-do.
 *
 * Note the failure mode is NOT a refusal at the consent screen: a user who is
 * not on the list can complete the OAuth flow and get a valid token, and then
 * every API call returns 403. That is catchable, and spotify.js catches it.
 */
export const DEV_MODE_LIMIT = 5;

/**
 * Since February 2026 a development-mode app only works while its *owner*
 * holds an active Spotify Premium subscription. The requirement lands on the
 * owner alone, so the listed users may be on free accounts -- but anyone who
 * supplies a client ID of their own becomes an owner, and therefore needs
 * Premium themselves.
 */
export const OWNER_NEEDS_PREMIUM = true;
