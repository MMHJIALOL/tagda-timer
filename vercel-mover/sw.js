/* ===========================================================
   tagdatimer.vercel.app — the service worker that retires the old one

   Anyone who used the app here has the offline worker installed, and it keeps
   asking this origin for /sw.js and app files. This file replaces it: it
   empties the old caches, unregisters itself, and reloads any open tab, which
   then gets the move page (index.html) from the network and goes on to
   tagdatimer.me. After that the browser has no reason to call here at all.

   No fetch handler, so nothing is ever answered from here.
   =========================================================== */

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) await caches.delete(key);
    await self.registration.unregister();
    for (const client of await self.clients.matchAll({ type: 'window' })) {
      client.navigate(client.url).catch(() => {});
    }
  })());
});
