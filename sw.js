/* ===========================================================
   Tagda Timer — offline service worker

   The timer itself needs no network once the page is up: solves and settings
   are IndexedDB, scrambles are generated locally from vendor/cubing. The only
   thing that used to fail offline was loading the page, so that is all this
   fixes. Race rooms, Scramble of the Day, sign-in and Spotify still need a
   connection and are deliberately never cached.

   Nothing here is content-hashed except vendor/ and the fonts, so app files
   are network-first: the cache is a fallback for being offline, never a
   source of a stale half-deploy.
   =========================================================== */

const CACHE = 'tagda-v1';

/* The document is all that has to be in place before the first offline load;
   everything else lands in the cache the first time the page actually fetches
   it (and the page reports what it loaded at boot — see 'cache' below), so
   there is no list of every module here to fall out of date. */
const PRECACHE = ['/', '/index.html'];

/** Content-hashed or never-edited-in-place: safe to serve from cache forever. */
function isImmutable(url) {
  return url.pathname.startsWith('/vendor/')
    || url.pathname.startsWith('/assets/fonts/')
    || url.href.startsWith('https://www.gstatic.com/firebasejs/');
}

/**
 * Traffic that must never be answered from a cache: the auth handler and its
 * relay iframe, Vercel's analytics beacons, and — by being cross-origin and
 * not the versioned Firebase SDK — the Realtime Database sockets, the Spotify
 * API and the Google Fonts API, which all fall through the isCacheable() test
 * below and are left to the network untouched.
 */
function isCacheable(url, request) {
  if (request.method !== 'GET') return false;
  if (isImmutable(url)) return true;
  if (url.origin !== self.location.origin) return false;
  return !url.pathname.startsWith('/__/auth/') && !url.pathname.startsWith('/_vercel/');
}

/* A response that arrived via a redirect cannot be replayed for a navigation
   ("a redirected response was used for a request whose redirect mode is not
   follow"), and `cleanUrls` on Vercel redirects /index.html to /. Copying it
   drops the redirected flag. */
async function store(cache, request, response) {
  if (!response.ok) return;
  const body = response.clone();
  await cache.put(request, response.redirected
    ? new Response(await body.blob(), { status: body.status, headers: body.headers })
    : body);
}

async function cacheFirst(request) {
  const hit = await caches.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  const cache = await caches.open(CACHE);
  await store(cache, request, res.clone());
  return res;
}

async function networkFirst(request) {
  try {
    const res = await fetch(request);
    const cache = await caches.open(CACHE);
    await store(cache, request, res.clone());
    return res;
  } catch (err) {
    /* ignoreSearch so js/main.js?v=56 is still answered by the copy cached as
       ?v=55 — a version bump must not be the thing that breaks offline. */
    const hit = await caches.match(request, { ignoreSearch: true });
    if (hit) return hit;
    if (request.mode === 'navigate') {
      const doc = await caches.match('/') || await caches.match('/index.html');
      if (doc) return doc;
    }
    throw err;
  }
}

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE)
    .then(async (cache) => {
      for (const url of PRECACHE) {
        // One at a time and forgiving: addAll() fails the whole install if any
        // single URL 404s, which would leave the site with no worker at all.
        try { await store(cache, url, await fetch(url, { cache: 'reload' })); }
        catch (err) { console.warn('[sw] could not precache', url, err); }
      }
    })
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (!isCacheable(url, e.request)) return;   // straight to the network, unseen
  e.respondWith(isImmutable(url) ? cacheFirst(e.request) : networkFirst(e.request));
});

/**
 * The page posts what it actually loaded at boot, once it is idle. The first
 * visit is the one that installs this worker, so those files were fetched
 * before it could see them — without this they would only reach the cache on
 * the second load, and a visitor who went offline in between would get
 * nothing. Reported rather than listed here so it stays right as modules are
 * added, split or renamed.
 */
self.addEventListener('message', (e) => {
  if (e.data?.type !== 'cache' || !Array.isArray(e.data.urls)) return;
  e.waitUntil(caches.open(CACHE).then(async (cache) => {
    for (const href of e.data.urls) {
      let url;
      try { url = new URL(href, self.location.origin); } catch { continue; }
      if (!isCacheable(url, { method: 'GET' })) continue;
      if (await cache.match(url.href)) continue;
      try { await store(cache, url.href, await fetch(url.href)); }
      catch { /* it was loadable a moment ago; the next load can try again */ }
    }
  }));
});
