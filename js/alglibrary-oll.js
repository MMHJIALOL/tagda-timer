/* ===========================================================
   Tagda Timer — OLL algorithm library.

   Empty on purpose, and not a bug.

   The research pass for OLL has not been run: OLL is 57 cases against
   PLL's 21, and the sourcing method (community vote share on
   SpeedCubeDB, cross-checked against the Speedsolving wiki, then every
   entry executed against a solved cube) is the expensive part. It is
   deliberately the last step of the rollout — there is no point paying
   for 57 cases of it twice if the card and detail layouts still move.

   Until then the OLL tab is not blank: `displayOrder()` falls back to
   the canonical alg for each case from algs.js, and you can add your
   own on top. Anything you add is verified exactly as a PLL entry is.

   Adding a case here is the only thing needed to light it up — same
   shape as alglibrary-pll.js, ranked best (index 0) to worst.
   =========================================================== */

export const OLL_LIBRARY = {};
