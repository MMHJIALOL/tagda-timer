/* ===========================================================
   Tagda Timer — account UI

   The one merge dialog and the one settings-panel account row. Split out
   of panels.js so that file doesn't have to know about Firebase, and out
   of sync.js so the sync engine doesn't have to know about the DOM.
   =========================================================== */

import { el } from './util.js';
import { toast } from './toast.js';
import { onAuthChange, signIn, signOutUser, hasPersistedSession } from './sync-auth.js';
import { initSync } from './sync.js';

let _initStarted = false;

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
          el('span', { text: user.displayName || user.email || 'Signed in' }),
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
              if (err?.code !== 'auth/popup-closed-by-user') {
                toast('Could not sign in — try again', { kind: 'bad' });
              }
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
