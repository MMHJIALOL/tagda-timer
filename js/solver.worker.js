/* ===========================================================
   Tagda Timer — the solver, off the main thread

   A last-slot F2L search can run for three seconds. Run on the main
   thread that is three seconds of frozen page: the cube stops
   mid-turn, hovering does nothing, and the panel reads as broken
   rather than busy. So it runs here instead, and the pruning tables
   stay warm between messages because the module lives as long as the
   worker does.

   The protocol is one message each way, keyed by a ticket the panel
   throws away when a newer request has already outrun it.
   =========================================================== */

import { suggest } from './solver.js';

self.onmessage = (e) => {
  const { id, state, frame, analysis, opts } = e.data || {};
  try {
    const result = suggest(new Uint8Array(state), frame, analysis, opts || {});
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
