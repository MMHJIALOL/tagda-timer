/* ===========================================================
   Tagda Timer — account UI

   The one merge dialog and the one settings-panel account row. Split out
   of panels.js so that file doesn't have to know about Firebase, and out
   of sync.js so the sync engine doesn't have to know about the DOM.
   =========================================================== */

import { el } from './util.js';
import { toast } from './toast.js';
import { popover } from './popover.js';
import { onAuthChange, signIn, signOutUser, getStorageHandle, updateUserProfile } from './sync-auth.js';
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
async function refreshUsername() {
  const s = await KV.get('settings', {});
  _username = (s?.raceName || '').trim();
  return _username;
}
onWrite('kv', ({ key, value }) => { if (key === 'settings') _username = (value?.raceName || '').trim(); });
refreshUsername();

function displayNameOf(user) {
  return _username || user?.displayName || user?.email || 'Signed in';
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
    const btn = el('button', { class: 'btn primary', text: 'Merge and continue' });
    const card = el('div', { class: 'sync-merge-card' },
      el('h3', { text: 'Merging your solves' }),
      el('p', { text: `This device has ${localCount} solves recorded before signing in. ` +
                       `Your account (${email}) already has ${cloudCount} solves from other devices.` }),
      el('p', { text: 'Signing in will combine both — nothing is deleted, overwritten, or ' +
                       'replaced, here or in the cloud. Session names, penalties, and comments ' +
                       'all come along with them.' }),
      el('p', { text: `After this, you'll have ${totalCount} solves total, synced everywhere.` }),
      btn,
    );
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Merging…';
      await confirm();
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
          el('span', { class: 'sub', text: `syncing as ${user.email}` })),
        el('button', {
          class: 'ghost-btn', text: 'sign out',
          onclick: async () => {
            await signOutUser();
            toast('Signed out — your solves stay on this device', { kind: '' });
          },
        }),
      );
    } else {
      wrap.append(
        el('div', { class: 'lbl' },
          el('span', { text: 'Cloud sync' }),
          el('span', { class: 'sub', text: 'follow your solves across devices' })),
        el('button', {
          class: 'ghost-btn', text: 'sign in with Google',
          onclick: async () => {
            try {
              await signIn('google');
            } catch (err) {
              reportSignInFailure(err);
            }
          },
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
    btn.title = `Signed in as ${name}`;
    btn.append(
      user.photoURL
        ? el('img', { class: 'account-avatar', src: user.photoURL, alt: '', referrerpolicy: 'no-referrer' })
        : el('span', { class: 'account-initial', text: name.charAt(0).toUpperCase() }),
      el('span', { class: 'account-username', text: name }),
    );
  } else {
    btn.classList.remove('on');
    btn.title = 'Sign in to sync your solves';
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

const MAX_AVATAR_UPLOAD_BYTES = 8 * 1024 * 1024;

/**
 * Downscales and center-crops an arbitrary uploaded photo to a small square
 * JPEG before it ever reaches the network — an avatar shown at ~20px has no
 * use for whatever multi-megapixel photo a phone camera actually produced,
 * and uploading it as-is would be a real, ongoing storage/bandwidth cost for
 * zero visible benefit. Exported for the pure-logic test in sync-test.html
 * (which drives it with a synthetic canvas image, no real photo needed).
 */
export async function resizeImageToSquare(file, size = 256) {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  canvas.getContext('2d').drawImage(
    bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
  bitmap.close?.();
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('could not encode image')), 'image/jpeg', 0.85);
  });
}

/**
 * One file, one path per user (`avatars/<uid>`) — a new upload overwrites
 * the last one rather than accumulating, so there's never an orphaned photo
 * left in Storage costing money after someone changes it twice. Firebase
 * Auth's `photoURL` itself is what makes the new photo show up on other
 * devices too — nothing here needs to touch the Realtime Database.
 */
function changeAvatar(btn) {
  const input = el('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
  document.body.append(input);
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.remove();
    if (!file) return;
    if (!file.type.startsWith('image/')) { toast('That file is not an image', { kind: 'bad' }); return; }
    if (file.size > MAX_AVATAR_UPLOAD_BYTES) { toast('That image is too large (max 8MB)', { kind: 'bad' }); return; }
    try {
      const blob = await resizeImageToSquare(file);
      const { storage, ref, uploadBytes, getDownloadURL, auth } = await getStorageHandle();
      const sref = ref(storage, `avatars/${auth.currentUser.uid}`);
      await uploadBytes(sref, blob, { contentType: 'image/jpeg' });
      const url = await getDownloadURL(sref);
      const user = await updateUserProfile({ photoURL: url });
      renderAccountButton(btn, user);
      toast('Avatar updated', { kind: 'good' });
    } catch (err) {
      console.warn('[sync] avatar upload failed', err?.code || err);
      toast('Could not update avatar — try again', { kind: 'bad' });
    }
  }, { once: true });
  input.click();
}

/**
 * The top-bar account icon (index.html's #btn-account) — the "is my account
 * connected" answer that's visible from the home screen, not three clicks
 * into Settings. Same avatar-or-initial-or-plain-icon shape as
 * renderAccountButton, plus a click: sign in directly while signed out, or
 * a small popover — your username, an edit option, and sign out — while
 * signed in.
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
        { label: 'Edit username', onSelect: () => editUsername(btn, setSetting) },
        { label: 'Change avatar', onSelect: () => changeAvatar(btn) },
        { label: 'Sign out', onSelect: async () => {
          await signOutUser();
          toast('Signed out — your solves stay on this device', { kind: '' });
        } },
      ]);
    } else {
      signIn('google').catch(reportSignInFailure);
    }
  });

  autoStart();
}
