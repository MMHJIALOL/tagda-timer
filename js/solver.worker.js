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

   Two kinds of question come through here, told apart by `type`. It
   defaults to the reconstruction panel's, so every caller that was
   written before there was a second kind still asks the same way.
   =========================================================== */

/* Imported, not statically: solver.js pulls in i18n.js, whose top-level
   await loads the dictionary, and a message that arrives while a worker's
   module graph is still evaluating has no handler to land on and is lost.
   The handler goes on now; the solver is awaited inside it. */
const solver = import('./solver.js');

self.onmessage = async (e) => {
  const { suggest, suggestCrossPlusOne } = await solver;
  const { id, type = 'suggest', state, frame, analysis, opts } = e.data || {};
  try {
    const result = type === 'xp1'
      ? suggestCrossPlusOne(new Uint8Array(state), frame, opts || {})
      : suggest(new Uint8Array(state), frame, analysis, opts || {});
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
