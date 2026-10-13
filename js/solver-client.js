import { lang } from './i18n.js';
/* ===========================================================
   Tagda Timer — the one solver worker, and when it goes away

   Reconstruction and Cross + 1 ask the same worker (solver.worker.js)
   their questions. Each used to start its own copy and keep it for the
   rest of the visit, pruning tables and all, so a panel opened once
   held two worker heaps until the tab closed. Now there is one, and it
   is let go once nobody has asked it anything for a while: two minutes
   normally, twenty seconds once the panel that wanted it has closed.
   The next question starts a fresh one, which costs the same warm-up
   the very first question always did.
   =========================================================== */

const IDLE_MS = 120000;
const CLOSED_MS = 20000;

let worker = null;
let dead = false;
let seq = 0;
let idleTimer = 0;
const jobs = new Map();

function rest(ms) {
  clearTimeout(idleTimer);
  if (!worker) return;
  idleTimer = setTimeout(() => {
    if (!worker || jobs.size) return;   // still busy: the last answer re-arms this
    worker.terminate();
    worker = null;
  }, ms);
}

function start() {
  if (worker || dead) return worker;
  try {
    worker = new Worker(new URL(`./solver.worker.js?lang=${lang}`, import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const { id, result, error } = e.data || {};
      const job = jobs.get(id);
      if (!job) return;
      jobs.delete(id);
      if (error) job.reject(new Error(error)); else job.resolve(result);
      if (!jobs.size) rest(IDLE_MS);
    };
    worker.onerror = (e) => {
      console.warn('[solver] worker failed, solving inline from now on', e.message);
      dead = true;
      worker = null;
      for (const job of jobs.values()) job.reject(new Error('worker died'));
      jobs.clear();
    };
  } catch (err) {
    console.warn('[solver] no module workers here, solving inline', err.message);
    dead = true;
  }
  return worker;
}

/** True once the worker has failed for good: callers solve on the page instead. */
export const solverDead = () => dead;

/** Start it (and its tables) now, ahead of the first question. */
export function warmSolver() {
  if (start() && !jobs.size) rest(IDLE_MS);
}

/** The panel using it closed: let it go sooner. */
export function restSolver() {
  if (!jobs.size) rest(CLOSED_MS);
}

/**
 * Send one question; resolves with the worker's answer. Null when there is
 * no worker to ask, so the caller can solve inline. `msg` gets its id here.
 */
export function askWorker(msg) {
  const w = start();
  if (!w) return null;
  clearTimeout(idleTimer);
  const id = ++seq;
  return new Promise((resolve, reject) => {
    jobs.set(id, { resolve, reject });
    w.postMessage({ ...msg, id });
  });
}
