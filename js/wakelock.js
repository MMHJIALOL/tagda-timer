/* Keeps the screen on while you are practising.

   A phone dims after 30 s or so of no touches, which lands in the middle of a
   long BLD memo, a 15 s inspection, or just the gap between solves while you
   scramble. Each bit of timer activity asks for a screen wake lock and pushes
   back its release; ten minutes after the last one the lock is let go and the
   device's own timeout applies again.

   The browser drops the lock by itself whenever the tab is hidden, so coming
   back to the tab inside the window asks for it again. Where the API is
   missing (older Safari, insecure origins) this does nothing at all. */

const IDLE_MS = 10 * 60 * 1000;

let sentinel = null;
let pending = null;
let until = 0;
let releaseTimer = 0;

function acquire() {
  if (sentinel || pending || document.visibilityState !== 'visible') return;
  pending = navigator.wakeLock.request('screen')
    .then((s) => {
      sentinel = s;
      s.addEventListener('release', () => { if (sentinel === s) sentinel = null; });
      // The window may have run out while the request was in flight.
      if (Date.now() >= until) release();
    })
    .catch(() => { /* refused (battery saver, permissions policy): the screen just sleeps as usual */ })
    .finally(() => { pending = null; });
}

function release() {
  clearTimeout(releaseTimer);
  const s = sentinel;
  sentinel = null;
  s?.release().catch(() => {});
}

/** Marks activity: holds the screen on for the next ten minutes. */
export function keepAwake() {
  if (!('wakeLock' in navigator)) return;
  until = Date.now() + IDLE_MS;
  clearTimeout(releaseTimer);
  releaseTimer = setTimeout(release, IDLE_MS);
  acquire();
}

if ('wakeLock' in navigator) {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() < until) acquire();
  });
}
