# Album theming — the timer takes its colours from what you're playing

> Link a Spotify account and Tagda Timer tints itself from the album art of the
> track playing right now. Purely cosmetic, purely optional, and it degrades to
> "nothing happens" at every step where it can fail.

---

## 0. TL;DR

- You click **Connect** in the Spotify section (top bar, or `P`). You approve on
  Spotify's own page. There is nothing to set up first — the app is already
  registered and its identifier ships with the site.
- While the tab is open, the timer asks Spotify every 5s what is playing.
- When the track changes, the album art is sampled and two colours are pulled
  out of it, cleaned up, and written into `--accent` / `--accent-2`.
- The sidebar card shows the cover, the track, a progress bar, and **the two
  colours that came out of that cover** — so the tint is visibly the album's
  and not just the theme changing on its own.
- Play / next / previous sit on the card when the account allows them.
- The palette only ever changes **while the timer is idle**. Never mid-solve.
- Disconnect and your real theme comes straight back — the album tint is never
  written to your saved settings.

---

## 1. Why theming first, and controls second

A standalone playback widget was rejected before any of this was built, and the
reasoning is worth keeping because it is also the reason the transport is
acceptable *now*:

| | Standalone widget | Album theming | Transport, once the card exists |
|---|---|---|---|
| Spotify Premium | **required** | not required | required, and **detected** |
| Duplicates hardware | yes — media keys do this from any app | no | partly, but in the card you are already reading |
| Failure mode | dead buttons floating on the page | the theme you already had | the row hides itself and says why |
| New UI surface | a whole widget to design and place | none | three buttons in an existing card |

The change is in the last row. The objection was never "controls are bad", it
was that a whole surface had to be invented to hold buttons that hardware
already provided. The card, the OAuth link and the poller now exist for the
theming, so the transport is three buttons and three endpoints on top of
infrastructure that is already paid for.

Reading what is playing still works on a free account. Only the transport needs
Premium, and it is hidden rather than broken when it is unavailable.

---

## 2. What already exists (and why this is small)

Almost every piece of the output side is already built:

| Need | Already in the repo |
|---|---|
| Read pixels out of an image | `bitmapLuma()` in `js/contrast.js` — canvas, `getImageData`, transparent-pixel skip, tainted-canvas catch |
| Decide light vs dark UI from a background | `applyContrast()` — samples and stamps `data-bg-luma` on `<html>` |
| Keep type readable on an arbitrary accent | `applyTheme()` recomputes `--on-accent` from the accent's own luminance |
| Push colours into the shader | `bg.setColors(bg2, accent, accent2)` |
| Live theme writes | `--accent` / `--accent-2` are plain CSS variables; nothing re-renders |

So the work is: get a colour out of Spotify, clean it up, hand it to the theme
engine. The theme engine already knows what to do with it.

---

## 3. How the link works

Standard **OAuth 2.0 Authorization Code with PKCE**. It is the flow designed for
apps with no backend, which is what this is.

```
 you click Connect
        |
        v
 accounts.spotify.com/authorize        <- Spotify's page, Spotify's login
   ?client_id&redirect_uri
   &code_challenge=S256(verifier)
        |
   you approve
        v
 tagdatimer.../?code=abc               <- back on our origin
        |
 POST accounts.spotify.com/api/token
   grant_type=authorization_code
   code + code_verifier                <- proves we started the flow
        |
        v
 access_token (1h) + refresh_token     <- stored in IndexedDB
        |
        v
 GET api.spotify.com/v1/me/player/currently-playing   every 5s
```

**Your password never touches this site.** PKCE means there is no client secret
to leak, which is what makes it safe to run entirely in the browser — the
`code_verifier` is generated fresh per attempt and never leaves your machine
except as a SHA-256 hash.

Scopes requested:

- `user-read-currently-playing` — what is playing
- `user-read-playback-state` — whether it is playing or paused
- `user-modify-playback-state` — play / pause / next / previous

That is the whole list. It cannot read your library, see your playlists, or
change anything about the account itself.

**Scopes are baked into a token at consent time.** A link made before the
transport existed can never acquire the third scope, so it has to be
re-approved once. The token response reports the scopes actually granted, and
the UI reads that rather than discovering the gap through a `403`.

### 3.1 The Last.fm comparison, and where it breaks down

The linking model is exactly Last.fm's. The *behaviour* is not:

Last.fm scrobbling is configured on Spotify's side and runs server-to-server, so
your history keeps building when you are nowhere near Last.fm. Tagda Timer has
no backend — the polling happens in your browser tab.

> **The theme only follows your music while the timer tab is open.**

For tinting a page you are looking at, that is fine. It does mean listening
history, or "what was playing during my PB", is impossible without a server.
Not planned.

### 3.2 The client ID ships with the site

`js/spotifyapp.js` holds the registered application's identifier, and it is
committed deliberately. **With PKCE the client ID is public by design**: it is
already sent in plain text in the authorize URL from every visitor's browser,
so there is nothing to protect. The *secret* is a different string, is not used
by this flow, and must never enter the repository.

The practical effect is that a visitor presses one button. No dashboard, no
setup, no ID to find.

### 3.3 The development-mode cap — the one real limit

The app is in Spotify's development mode: **at most 25 users, each added by
email** under *Settings → User Management* in the dashboard. Extended quota
needs a review Spotify does not grant projects this size, so this is a ceiling
rather than a to-do.

Anyone past it is stopped by Spotify at its own consent screen and never
returns to the timer, which means it cannot be caught and turned into a nice
message here. What the UI can do — and does — is offer the alternative: a
folded-away *Use your own Spotify app* section that accepts a client ID of
their own. Switching apps clears the stored tokens, since a token belongs to
the application that issued it.

For everyone under the cap, and for anyone who never presses Connect, none of
this is visible.

---

## 4. Getting a colour out of album art

### 4.1 The CORS question

Album art is served from `i.scdn.co`. Reading pixels needs `crossOrigin="anonymous"`
**and** an `Access-Control-Allow-Origin` header, or the canvas taints and
`getImageData` throws.

This is checked at runtime, not assumed. `probeArtworkCors()` runs once on
connect and records the answer, and the UI says which mode it ended up in:

- **CORS allowed** → full palette extraction. Accent + accent-2 from the art.
- **CORS blocked** → automatic fallback to **artwork-as-background**. CSS
  `background-image` is not subject to CORS, so the blurred art still works;
  only the derived colours are lost. The existing `bgBlur` / `bgDim` / `bgSat`
  controls apply to it unchanged.

Either way the feature does something. Neither path errors out at the user.

### 4.2 Why not just use the dominant colour

Because album art hands you near-black and near-white constantly, and a
near-black accent on a dark theme is invisible. Raw pixel values are not a
palette.

The extractor follows the same discipline as the chart colours: **pick the
nearest passing step, do not take what the image hands you.**

1. Draw the art at 48×48 into a canvas.
2. Bucket pixels into a coarse 4-bit-per-channel histogram (4096 bins).
3. Score each bin `population × saturation weight`, discarding bins that are
   near-black, near-white or near-grey — they carry no identity.
4. Take the top bin as the accent; take the next bin at least 40° away in hue as
   accent-2. If nothing is far enough away, rotate the accent's hue by 150°
   rather than shipping two colours that read as one.
5. **Clamp both into a band the theme can actually use**: lightness into
   55–72% on dark themes and 28–45% on light ones, saturation to a floor of 45%.
   Hue is preserved exactly — that is the part that carries "this is the album".

The result is recognisably the record's colour, at a lightness the interface can
survive.

---

## 5. The two rules that keep it from being annoying

These are the design constraints, not implementation details. Both exist
because the accent colours are load-bearing for timing feedback.

### 5.0 The transport never touches the timer

The buttons are inside `.fade-layer`, so focus mode blanks them with the rest of
the chrome the moment an attempt starts. They are click-only: no key binding
that could fire mid-solve, and the spacebar belongs to the timer alone.

### 5.1 Status colours are off limits

The inspection ring runs `--accent-2` → `--warn` → `--danger` as the 15 seconds
burn down. If album art could drive `--warn`, the "you're fine" state and the
"you're about to +2" state would stop being distinguishable.

**Only `--accent`, `--accent-2` and `--bg-2` are ever written.** `--warn`,
`--danger`, `--ok` and `--gold` are never touched. They are already separate
tokens in `css/tokens.css`, so this is discipline rather than refactoring.

### 5.2 Nothing changes mid-solve

A theme that shifts while you are inspecting or solving is exactly the
distraction a timer must not have. New palettes are queued and applied on the
next transition to `idle`.

The timer already emits a `state` event for this; the album tint listens to the
same one the focus mode does.

---

## 6. Persistence — what gets saved and what does not

The album tint is a **transient override**. It is written to `<html>` as inline
custom properties and is *never* written into saved settings.

That matters: without it, three minutes of listening would permanently overwrite
whatever accent you had picked, and disconnecting would leave you stuck with the
last album's colours. Instead:

- `theme.js` holds the active tint in a module-level variable.
- `applyTheme()` re-applies it last, so a theme change does not clobber it.
- Disconnecting, pausing, or closing the tab restores your real theme with no
  cleanup step.

What *is* saved: the client ID, the tokens, and your on/off + mode preference.

### 6.1 On storing tokens in the browser

The refresh token lives in IndexedDB. This is the standard trade-off for a
PKCE single-page app with no backend — there is nowhere else to put it. Anyone
with access to your browser profile can read it. The blast radius is one scope,
`user-read-currently-playing`, which cannot change anything about your account.

**Disconnect** deletes both tokens. It does not revoke the app on Spotify's
side — that is done at spotify.com/account/apps, and the UI links there.

---

## 7. Failure modes, and what each one does

Every one of these is a state the UI can actually end up in, so each has a
defined behaviour rather than an exception.

| What happens | What the user sees |
|---|---|
| No client ID configured | The setup row, with the dashboard link and the redirect URI to copy |
| Never connected | "Not connected" and a Connect button. No polling. |
| Nothing playing (`204`) | Tint fades back to the base theme; still polling |
| Podcast / local file (no artwork) | Base theme; the track is ignored |
| Access token expired (`401`) | Silent refresh, one retry, no user-visible blip |
| Refresh token rejected | Marked disconnected, one toast, tokens cleared |
| Rate limited (`429`) | Backs off for `Retry-After`, then resumes |
| Artwork CORS blocked | Falls back to background mode, states so in the UI |
| Control pressed on a free account (`403`) | Row hides, card explains Premium is required |
| Control pressed with no active device (`404`) | Toast: start playback on a device first |
| Control pressed on a pre-transport link | Card asks the user to reconnect |
| Offline / network error | Keeps the last tint, retries with backoff |
| Tab hidden | Polling stops entirely — same rule `bg.js` uses |

---

## 8. What this deliberately does not do

- **No volume, shuffle, repeat or seeking.** Play, next and previous cover the
  reason anyone would look away from a timer; the rest is a media player, and
  the Spotify app is right there.
- **No listening history or stats.** Needs a backend; see §3.1.
- **No lyrics, no track name on screen by default.** The point is the colour.
  A small now-playing line is available but off by default — the timer screen
  is meant to be empty.
- **No auto-connect.** Polling never starts until you press the button.

---

## 9. Using it

**As a visitor:** open the Spotify section (top bar, or `P`) and press
**Connect Spotify**. That is the whole thing.

**As the maintainer**, two jobs remain:

1. **Add people.** *Settings → User Management* in the dashboard, by Spotify
   account email. Twenty-five maximum — see §3.3. Anyone not listed is refused
   by Spotify before they ever get back to the timer.
2. **Keep the redirect URIs registered.** They must match byte for byte:
   - `https://tagdatimer.vercel.app/` — production
   - `http://127.0.0.1:5199/` — local development. Spotify permits `http` only
     on a loopback **IP**; `localhost` is rejected outright, and the panel
     detects this and prints the URL to use instead.

   Any new deploy origin (a preview URL, a custom domain) has to be added to
   the dashboard *and* to the list in `js/spotifyapp.js` before Connect works
   there.

**Premium** is required for the transport controls only. Reading what is
playing, and therefore all of the theming, works on a free account.
