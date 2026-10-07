/* ===========================================================
   Tagda Timer — which deploy this is

   The same number as ?v= in index.html, and bumped with it on every deploy
   (test.html fails if the two disagree). The admin console's
   app.minVersion is compared against it: a tab running anything older says
   a new version is ready and reloads once its timer is idle (main.js,
   wireConfig), so a fix reaches open tabs at once instead of whenever
   sw.js's cache next turns over.
   =========================================================== */

export const APP_VERSION = 108;
