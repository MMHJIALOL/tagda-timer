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
 * The app is in Spotify's development mode, which allows at most 25 listed
 * users. Anyone else is stopped by Spotify at the consent screen and never
 * returns here, so this is the note the UI shows rather than an error we can
 * catch. Add people by email under Settings -> User Management.
 */
export const DEV_MODE_LIMIT = 25;
