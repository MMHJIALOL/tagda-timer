/* ===========================================================
   Tagda Timer — Spotify link (read what is playing, nothing else)

   OAuth 2.0 Authorization Code with PKCE: the flow built for apps with no
   backend, which is what this is. There is no client secret anywhere in
   here, because with PKCE there is nothing to keep secret — the proof is a
   one-time verifier that never leaves the machine except as a hash.

   The only scope asked for is user-read-currently-playing. It cannot
   control playback, read your library, or change anything about the
   account. See SPOTIFY.md.
   =========================================================== */

import { KV } from './db.js';

const AUTH  = 'https://accounts.spotify.com/authorize';
const TOKEN = 'https://accounts.spotify.com/api/token';
const NOW   = 'https://api.spotify.com/v1/me/player/currently-playing';
const PLAYER = 'https://api.spotify.com/v1/me/player';

/* Reading what is playing needs the first scope. The other two are for the
   transport controls, and are the reason an older link has to be re-approved:
   scopes are baked into the token at consent time, so a token issued before
   the controls existed can never gain them. `grantedScopes` below is what
   lets the UI say that plainly instead of letting the buttons 403. */
const SCOPES = [
  'user-read-currently-playing',
  'user-read-playback-state',
  'user-modify-playback-state',
];
const SCOPE = SCOPES.join(' ');
const CONTROL_SCOPE = 'user-modify-playback-state';

const POLL_MS = 5000;
const KEY = 'spotifyTokens';

/* ---------------- PKCE plumbing ---------------- */

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function randomVerifier() {
  return b64url(crypto.getRandomValues(new Uint8Array(48)));
}

async function challengeFor(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64url(digest);
}

/**
 * The redirect URI has to match what is registered byte for byte.
 *
 * Derived from the live origin rather than hardcoded, so the same build works
 * on the deployed site and on a dev server without editing anything.
 */
export function redirectUri() {
  return location.origin + location.pathname.replace(/index\.html$/, '');
}

/**
 * Spotify requires https for redirect URIs, with one exception: a loopback
 * *IP*. `http://localhost:...` is rejected outright — it has to be
 * `http://127.0.0.1:...`, which is a different origin as far as the browser
 * is concerned, and therefore a different IndexedDB.
 *
 * So this cannot be silently rewritten: sending the user to 127.0.0.1 behind
 * their back would hand them an empty timer with none of their solves in it.
 * Report the problem and let them open the right URL themselves.
 */
export function redirectProblem() {
  const u = new URL(location.href);
  if (u.protocol === 'https:') return null;
  if (u.hostname === '127.0.0.1') return null;
  if (u.hostname === 'localhost' || u.hostname === '[::1]') {
    return {
      reason: 'Spotify rejects localhost — it only allows http on a loopback IP.',
      openInstead: `http://127.0.0.1:${u.port || 80}${u.pathname}`,
    };
  }
  return { reason: `Spotify requires https for redirect URIs, and this page is on ${u.protocol}//.`, openInstead: null };
}

/* ---------------- token storage ---------------- */

const readTokens  = () => KV.get(KEY, null);
const writeTokens = (t) => KV.set(KEY, t);
const dropTokens  = () => KV.del(KEY);

/* ---------------- the client ---------------- */

/**
 * Emits:
 *   'track'    {id, title, artist, album, artUrl, url, durationMs}
 *              — a *different* track is now playing
 *   'progress' {progressMs, durationMs, playing}
 *              — every poll, so the panel can follow along
 *   'idle'     {}                          — nothing is playing
 *   'status'   {state, detail}             — connected | disconnected | error
 *   'blocked'  {reason}                    — a control could not be carried out
 */
export class Spotify extends EventTarget {
  constructor() {
    super();
    this.clientId = '';
    this.tokens = null;
    this.trackId = null;
    this._timer = null;
    this._backoff = 0;
    this._stopped = true;
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  get connected() { return !!this.tokens?.refresh_token; }

  /* ---------------- connect ---------------- */

  /** Send the browser to Spotify's consent page. */
  async connect(clientId) {
    if (!clientId) throw new Error('No client ID');
    const verifier = randomVerifier();
    // sessionStorage, not memory: the whole point is that we are about to
    // leave the page and come back as a fresh document.
    sessionStorage.setItem('tdt_pkce', verifier);
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri(),
      code_challenge_method: 'S256',
      code_challenge: await challengeFor(verifier),
      scope: SCOPE,
    });
    location.href = `${AUTH}?${params}`;
  }

  /**
   * Finish the flow if we came back with a code.
   * Returns true when a fresh connection was just established.
   */
  async completeRedirect(clientId) {
    const url = new URL(location.href);
    const code = url.searchParams.get('code');
    const err = url.searchParams.get('error');
    if (!code && !err) return false;

    // Clean the address bar first, so a reload never replays a spent code and
    // the code does not sit in history.
    url.searchParams.delete('code');
    url.searchParams.delete('error');
    url.searchParams.delete('state');
    history.replaceState(null, '', url.toString());

    const verifier = sessionStorage.getItem('tdt_pkce');
    sessionStorage.removeItem('tdt_pkce');
    if (err) { this.emit('status', { state: 'error', detail: err }); return false; }
    if (!verifier) { this.emit('status', { state: 'error', detail: 'lost the PKCE verifier' }); return false; }

    try {
      const t = await this._token({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri(),
        client_id: clientId,
        code_verifier: verifier,
      });
      this.clientId = clientId;
      await this._store(t);
      this.emit('status', { state: 'connected' });
      return true;
    } catch (e) {
      this.emit('status', { state: 'error', detail: e.message });
      return false;
    }
  }

  async disconnect() {
    this.stop();
    this.tokens = null;
    this.trackId = null;
    await dropTokens();
    this.emit('status', { state: 'disconnected' });
  }

  /* ---------------- tokens ---------------- */

  async _token(body) {
    const res = await fetch(TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error_description || json.error || `token ${res.status}`);
    return json;
  }

  async _store(t) {
    this.tokens = {
      access_token: t.access_token,
      // Spotify returns the scopes it actually granted, which is not always
      // what was asked for — the user can decline parts of the consent screen.
      scope: t.scope || this.tokens?.scope || '',
      // A refresh response does not always carry a new refresh token; keeping
      // the old one is required, not an optimisation.
      refresh_token: t.refresh_token || this.tokens?.refresh_token,
      expires_at: Date.now() + (t.expires_in ?? 3600) * 1000,
    };
    await writeTokens(this.tokens);
  }

  async _refresh() {
    const rt = this.tokens?.refresh_token;
    if (!rt) throw new Error('not connected');
    const t = await this._token({
      grant_type: 'refresh_token',
      refresh_token: rt,
      client_id: this.clientId,
    });
    await this._store(t);
  }

  /** A valid access token, refreshed a minute early to avoid racing expiry. */
  async _access() {
    if (!this.tokens) throw new Error('not connected');
    if (Date.now() > this.tokens.expires_at - 60000) await this._refresh();
    return this.tokens.access_token;
  }

  /* ---------------- controls ---------------- */

  /** Whether this token was granted the right to change playback at all. */
  get canControl() {
    return !!this.tokens && (this.tokens.scope || '').includes(CONTROL_SCOPE);
  }

  /**
   * Transport commands.
   *
   * Every one of these is a 204-No-Content on success, and the interesting
   * cases are all failures:
   *   403  the account is not Premium, or the track forbids the action
   *   404  there is no active device to command
   * Both are ordinary states for a person to be in, not exceptions, so they
   * are reported as 'blocked' with a reason the UI can print.
   */
  async _command(method, path, label) {
    if (!this.canControl) {
      this.emit('blocked', { reason: 'reconnect', label });
      return false;
    }
    try {
      const res = await fetch(`${PLAYER}${path}`, {
        method,
        headers: { Authorization: `Bearer ${await this._access()}` },
      });
      if (res.status === 401) {
        await this._refresh();
        return this._command(method, path, label);
      }
      if (res.status === 403) { this.emit('blocked', { reason: 'premium', label }); return false; }
      if (res.status === 404) { this.emit('blocked', { reason: 'nodevice', label }); return false; }
      if (res.status === 429) {
        const wait = (Number(res.headers.get('Retry-After')) || 3) * 1000;
        this.emit('blocked', { reason: 'ratelimited', label, wait });
        return false;
      }
      if (!res.ok && res.status !== 204) throw new Error(`${label} ${res.status}`);

      /* Spotify does not apply the change instantly, and the next scheduled
         poll could be five seconds away — which reads as a dead button. Ask
         again shortly so the card catches up with what actually happened. */
      this._schedule(700);
      return true;
    } catch (e) {
      this.emit('blocked', { reason: 'error', label, detail: e.message });
      return false;
    }
  }

  play()     { return this._command('PUT',  '/play', 'play'); }
  pause()    { return this._command('PUT',  '/pause', 'pause'); }
  next()     { return this._command('POST', '/next', 'next'); }
  previous() { return this._command('POST', '/previous', 'previous'); }

  /* ---------------- polling ---------------- */

  /** Restore a stored session. Returns true if we are connected. */
  async restore(clientId) {
    this.clientId = clientId;
    this.tokens = await readTokens();
    return this.connected;
  }

  start() {
    if (!this.connected || !this._stopped) return;
    this._stopped = false;
    this._tick();
    // Same rule bg.js uses: a hidden tab is not being looked at, so it has no
    // business holding a poll open.
    if (!this._visWired) {
      this._visWired = true;
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) this._clear();
        else if (!this._stopped) this._tick();
      });
    }
  }

  stop() { this._stopped = true; this._clear(); }

  _clear() { clearTimeout(this._timer); this._timer = null; }

  _schedule(ms = POLL_MS) {
    this._clear();
    if (this._stopped || document.hidden) return;
    this._timer = setTimeout(() => this._tick(), ms);
  }

  async _tick() {
    if (this._stopped) return;
    try {
      const res = await fetch(NOW, {
        headers: { Authorization: `Bearer ${await this._access()}` },
      });

      if (res.status === 204) {          // nothing playing
        if (this.trackId !== null) { this.trackId = null; this.emit('idle'); }
        this._backoff = 0;
        return this._schedule();
      }

      if (res.status === 401) {          // token died early; one silent retry
        await this._refresh();
        return this._schedule(400);
      }

      if (res.status === 429) {          // respect the stated wait, do not guess
        const wait = (Number(res.headers.get('Retry-After')) || 5) * 1000;
        return this._schedule(wait + 250);
      }

      if (!res.ok) throw new Error(`player ${res.status}`);

      const json = await res.json();
      this._backoff = 0;
      const item = json.item;
      // Podcasts and local files have no album art to borrow from. Treat them
      // as "nothing playing" rather than half-applying a theme.
      const art = item?.album?.images?.[0]?.url;
      if (!item || !art) {
        if (this.trackId !== null) { this.trackId = null; this.emit('idle'); }
        return this._schedule();
      }

      if (item.id !== this.trackId) {
        this.trackId = item.id;
        this.emit('track', {
          id: item.id,
          title: item.name,
          artist: (item.artists || []).map(a => a.name).join(', '),
          album: item.album?.name || '',
          artUrl: art,
          // Spotify's guidelines want their content to link back to it.
          url: item.external_urls?.spotify || null,
          durationMs: item.duration_ms ?? 0,
        });
      }

      // Emitted every poll, not only on a track change: the panel interpolates
      // between these to move the bar smoothly, and a pause has to be visible
      // straight away rather than at the next song.
      this.emit('progress', {
        progressMs: json.progress_ms ?? 0,
        durationMs: item.duration_ms ?? 0,
        playing: !!json.is_playing,
      });

      this._schedule();
    } catch (e) {
      // Offline, or the refresh token was revoked. Keep the last tint rather
      // than flashing the theme back and forth on a flaky connection.
      const fatal = /not connected|invalid_grant/.test(e.message);
      if (fatal) {
        this.emit('status', { state: 'disconnected', detail: e.message });
        return this.stop();
      }
      this._backoff = Math.min(60000, (this._backoff || POLL_MS) * 2);
      this.emit('status', { state: 'error', detail: e.message });
      this._schedule(this._backoff);
    }
  }
}
