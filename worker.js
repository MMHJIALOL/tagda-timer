/* Same-origin Firebase sign-in: proxy /__/auth/* to the firebaseapp.com
   handler, which is what the rewrite in vercel.json does on Vercel. Why it has
   to be same-origin is explained above SAME_ORIGIN_AUTH_HOSTS in raceapp.js. */
export default {
  fetch(request, env) {
    const { pathname, search } = new URL(request.url);
    if (!pathname.startsWith('/__/auth/')) return env.ASSETS.fetch(request);
    return fetch(new Request(`https://tagda-timer.firebaseapp.com${pathname}${search}`, request));
  },
};
