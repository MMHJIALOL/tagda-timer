import { t } from './i18n.js';
/* ===========================================================
   Tagda Timer — account UI

   The one merge dialog and the one settings-panel account row. Split out
   of panels.js so that file doesn't have to know about Firebase, and out
   of sync.js so the sync engine doesn't have to know about the DOM.
   =========================================================== */

import { el } from './util.js';
import { toast } from './toast.js';
import { popover } from './popover.js';
import { onAuthChange, signIn, signOutUser } from './sync-auth.js';
import { initSync } from './sync.js';
import { KV, onWrite } from './db.js';

let _initStarted = false;

/**
 * The one username, shared everywhere: it's `settings.raceName` — the same
 * field Race mode has always used for the room's player list and its
 * post-round leaderboard (js/race.js's nickname(), edited today from the
 * Race panel in js/panels.js). Reusing it rather than adding a second name
 * means there's one identity, not two that can drift apart, and it already
 * rides the existing settings sync path — no new plumbing needed for it to
 * follow you across devices once signed in.
 */
let _username = '';
/* `settings.avatar`: a picture the user uploaded, as a small data: URL
   (see shrinkAvatar). Rides the same settings sync as the username. Empty
   means "use the Google account's photo". */
let _avatar = '';
async function refreshUsername() {
  const s = await KV.get('settings', {});
  _username = (s?.raceName || '').trim();
  _avatar = safeAvatar(s?.avatar);
  return _username;
}
onWrite('kv', ({ key, value }) => {
  if (key !== 'settings') return;
  _username = (value?.raceName || '').trim();
  _avatar = safeAvatar(value?.avatar);
});
refreshUsername();

function displayNameOf(user) {
  return _username || user?.displayName || user?.email || t('Signed in');
}

/**
 * The one dialog in this feature, and it only has one button. There is
 * deliberately no "cancel" or "keep separate" — additive merge is the only
 * path once two histories both have solves in them (see PLAN.md / sync.js
 * mergeOnSignIn). Resolves once the merge has actually finished.
 */
export function showMergeDialog({ localCount, cloudCount, totalCount, email, confirm }) {
  return new Promise((resolve) => {
    const scrim = el('div', { class: 'sync-merge-scrim' });
    const btn = el('button', { class: 'btn primary', text: t('Merge and continue') });
    const card = el('div', { class: 'sync-merge-card' },
      el('h3', { text: t('Merging your solves') }),
      el('p', { text: t('This device has {local} solves recorded before signing in. Your account ({email}) already has {cloud} solves from other devices.', { local: localCount, email, cloud: cloudCount }) }),
      el('p', { text: t('Signing in will combine both — nothing is deleted, overwritten, or replaced, here or in the cloud. Session names, penalties, and comments all come along with them.') }),
      el('p', { text: t("After this, you'll have {n} solves total, synced everywhere.", { n: totalCount }) }),
      btn,
    );
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = t('Merging…');
      try {
        await confirm();
      } catch (err) {
        // Left spinning, the dialog sat over the timer for good and sync never started.
        console.warn('[sync] merge failed', err?.code || err);
        toast(t('Could not merge — check your connection and try again'), { kind: 'bad' });
        btn.disabled = false;
        btn.textContent = t('Merge and continue');
        return;
      }
      scrim.remove();
      card.remove();
      toast(`Merged — ${totalCount} solves synced`, { kind: 'good' });
      resolve();
    });
    document.body.append(scrim, card);
  });
}

/**
 * Wires the sync engine once. Called from main.js at boot (fire-and-forget,
 * so a signed-in user resumes syncing without ever opening settings) and
 * again — as a no-op the second time — from buildAccountRow, in case boot
 * somehow raced ahead of this module loading.
 */
export function autoStart() {
  if (_initStarted) return;
  _initStarted = true;
  initSync({ onMergeNeeded: showMergeDialog }).catch(err => {
    console.warn('[sync] failed to start', err);
  });
}

/**
 * Only one settings drawer exists at a time and buildSettings() rebuilds
 * its whole body from scratch on every open (and on some in-panel toggles —
 * see panels.js's inputMode row), discarding the previous Account row's DOM
 * node but not its onAuthChange subscription. Tracking the one active
 * subscription here and dropping the previous one before adding a new one
 * keeps that from accumulating a listener per open for the life of the page.
 */
let _activeUnsub = null;

/** The "Account" row for the settings drawer. Rebuilds itself on auth changes. */
export function buildAccountRow() {
  const wrap = el('div', { class: 'row' });

  if (_activeUnsub) { _activeUnsub(); _activeUnsub = null; }
  const myUnsubPromise = onAuthChange((user) => {
    if (!wrap.isConnected) return; // this row's drawer has since been rebuilt/closed
    wrap.innerHTML = '';
    if (user) {
      wrap.append(
        el('div', { class: 'lbl' },
          el('span', { text: displayNameOf(user) }),
          el('span', { class: 'sub', text: t('syncing as {email}', { email: user.email }) })),
        el('button', {
          class: 'ghost-btn', text: t('sign out'),
          onclick: async () => {
            await signOutUser();
            toast('Signed out — your solves stay on this device', { kind: '' });
          },
        }),
      );
    } else {
      wrap.append(
        el('div', { class: 'lbl' },
          el('span', { text: t('Cloud sync') }),
          el('span', { class: 'sub', text: t('follow your solves across devices') })),
        el('button', {
          class: 'ghost-btn', text: t('sign in with Google'),
          onclick: () => signInAndSay(),
        }),
      );
    }
  });

  myUnsubPromise.then((unsub) => { _activeUnsub = unsub; });
  autoStart();
  return wrap;
}

/**
 * Closing the popup yourself is a decision, not a failure, so it says
 * nothing. Everything else gets the same short toast — but the code goes to
 * the console, because these are the errors that are otherwise invisible:
 * signIn() only leaves the page for the handful of codes a popup genuinely
 * cannot survive, and anything else now lands here instead of silently
 * redirecting, which is only an improvement if the code is findable.
 */
function reportSignInFailure(err) {
  if (err?.code === 'auth/popup-closed-by-user' || err?.code === 'auth/cancelled-popup-request') return;
  console.warn('[sync] sign-in failed', err?.code || err);
  toast('Could not sign in — try again', { kind: 'bad' });
}

/* The popup closes a beat before the account has answered. Saying so right
   away keeps that beat from looking like the sign-in did nothing. */
function signInAndSay() {
  return signIn('google')
    .then((user) => { if (user) toast(t('Signed in — syncing your solves…')); })
    .catch(reportSignInFailure);
}

const ACCOUNT_ICON = '<svg viewBox="0 0 24 24"><circle cx="12" cy="8.5" r="3.4"/><path d="M4.8 20a7.2 7.2 0 0114.4 0"/></svg>';

let _topBarUser = null;

/**
 * Builds the box's contents fresh each time rather than patching pieces —
 * it's cheap (a handful of nodes) and there's no state (scroll position,
 * focus) worth preserving across a sign-in/sign-out/rename, unlike the
 * settings drawer this deliberately doesn't rebuild wholesale each time.
 */
function renderAccountButton(btn, user) {
  _topBarUser = user;
  btn.innerHTML = '';
  if (user) {
    btn.classList.add('on');
    const name = displayNameOf(user);
    btn.title = t('Signed in as {name}', { name });
    btn.append(
      _avatar || user.photoURL
        ? el('img', { class: 'account-avatar', src: _avatar || user.photoURL, alt: '', referrerpolicy: 'no-referrer' })
        : el('span', { class: 'account-initial', text: name.charAt(0).toUpperCase() }),
      el('span', { class: 'account-username', text: name }),
    );
  } else {
    btn.classList.remove('on');
    btn.title = t('Sign in to sync your solves');
    btn.append(el('span', { class: 'account-glyph', html: ACCOUNT_ICON }));
  }
}

/**
 * Prompts for a new username and saves it to `settings.raceName` — through
 * `setSetting` when the caller has one (keeps main.js's in-memory
 * app.settings and the Race panel's already-open form in step with the
 * edit), falling back to writing the KV store directly when it doesn't
 * (nothing else in this session has app.settings loaded to go stale).
 */
function editUsername(btn, setSetting) {
  const next = prompt('Username — used in Race mode and shown on your account', _username);
  if (next === null) return;
  const trimmed = next.trim().slice(0, 18);
  _username = trimmed;
  if (setSetting) {
    setSetting('raceName', trimmed);
  } else {
    KV.get('settings', {}).then(s => KV.set('settings', { ...s, raceName: trimmed }));
  }
  renderAccountButton(btn, _topBarUser);
}

const AVATAR_PX = 96;
const AVATAR_MAX_BYTES = 25e6;
const AVATAR_MAX_LEN = 40000;

/* Settings sync from other devices, so anything that isn't the image data
   URL this file makes is dropped rather than put in an <img src>. */
function safeAvatar(v) {
  return typeof v === 'string' && v.length <= AVATAR_MAX_LEN && /^data:image\/(webp|jpeg);base64,[A-Za-z0-9+/=]+$/.test(v) ? v : '';
}

/**
 * Any image the browser can decode (PNG, JPEG, WebP, AVIF, GIF, HEIC in
 * Safari), any size up to AVATAR_MAX_BYTES, becomes a 96px square of a few
 * KB. The original never leaves the device: only this data URL is stored,
 * in settings, which is how it syncs without Cloud Storage (Blaze-only).
 * Safari before 17 can't encode WebP and quietly hands back PNG, so that
 * case is re-encoded as JPEG over a solid background — JPEG has no alpha,
 * and a transparent PNG would otherwise come out black.
 */
async function shrinkAvatar(file) {
  // ponytail: decodes the whole image before scaling; a 100 MP photo could
  // run a phone tab out of memory. Decode at reduced size if that shows up.
  const img = await createImageBitmap(file);
  const side = Math.min(img.width, img.height);
  const canvas = el('canvas', { width: AVATAR_PX, height: AVATAR_PX });
  const g = canvas.getContext('2d');
  g.imageSmoothingQuality = 'high';
  const draw = () => g.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, AVATAR_PX, AVATAR_PX);
  draw();
  let url = canvas.toDataURL('image/webp', 0.8);
  if (!url.startsWith('data:image/webp')) {
    g.fillStyle = '#fff';
    g.fillRect(0, 0, AVATAR_PX, AVATAR_PX);
    draw();
    url = canvas.toDataURL('image/jpeg', 0.85);
  }
  img.close();
  return url;
}

function saveAvatar(btn, setSetting, value) {
  _avatar = value;
  if (setSetting) {
    setSetting('avatar', value);
  } else {
    KV.get('settings', {}).then(s => KV.set('settings', { ...s, avatar: value }));
  }
  renderAccountButton(btn, _topBarUser);
}

function changeAvatar(btn, setSetting) {
  const input = el('input', { type: 'file', accept: 'image/*' });
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > AVATAR_MAX_BYTES) { toast(t('That image is too large — pick one under 25 MB'), { kind: 'bad' }); return; }
    let url;
    try {
      url = safeAvatar(await shrinkAvatar(file));
    } catch (err) {
      console.warn('[sync] avatar decode failed', err);
    }
    if (!url) { toast(t('Could not read that image'), { kind: 'bad' }); return; }
    saveAvatar(btn, setSetting, url);
    toast(t('Profile picture updated'), { kind: 'good' });
  });
  input.click();
}

/**
 * The top-bar account icon (index.html's #btn-account) — the "is my account
 * connected" answer that's visible from the home screen, not three clicks
 * into Settings. Same avatar-or-initial-or-plain-icon shape as
 * renderAccountButton, plus a click: sign in directly while signed out, or
 * a small popover — your username, an edit option, and sign out — while
 * signed in.
 *
 * The avatar is the Google account's photo unless the user picked their
 * own (changeAvatar). That one is shown here only: the daily boards still
 * carry the Google photo, since their rules accept googleusercontent URLs
 * and nothing else.
 */
export function wireAccountButton(btn, { setSetting } = {}) {
  if (btn.dataset.wired) { autoStart(); return; }
  btn.dataset.wired = '1';

  onAuthChange(async (user) => { await refreshUsername(); renderAccountButton(btn, user); });
  onWrite('kv', ({ key }) => { if (key === 'settings' && _topBarUser) renderAccountButton(btn, _topBarUser); });

  btn.addEventListener('click', () => {
    if (_topBarUser) {
      popover(btn, [
        { title: displayNameOf(_topBarUser) },
        { label: t('Edit username'), onSelect: () => editUsername(btn, setSetting) },
        { label: t('Change profile picture'), onSelect: () => changeAvatar(btn, setSetting) },
        ..._avatar ? [{ label: t('Remove profile picture'), onSelect: () => saveAvatar(btn, setSetting, '') }] : [],
        { label: t('Sign out'), onSelect: async () => {
          await signOutUser();
          toast('Signed out — your solves stay on this device', { kind: '' });
        } },
      ]);
    } else {
      signInAndSay();
    }
  });

  autoStart();
}
