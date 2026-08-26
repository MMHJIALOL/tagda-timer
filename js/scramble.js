/* ===========================================================
   Tagda Timer — scramble generation

   Official WCA scrambles come from cubing.js, which wraps the same
   random-state solvers TNoodle (the WCA's own scrambler) uses.
   Generation is async and slow on first run, so we keep a warm queue
   and hand out pre-made scrambles — the user never waits.
   =========================================================== */

import { EVENTS, MODES } from './events.js';
import { PLL, OLL, OLL_EO, OCLL, PLL_CP, PLL_EP, CROSS_SAFE_TRIGGERS, U_MOVES, POOLS, faceOf } from './algs.js';
import { invert, tidy, pick } from './util.js';

// Local copy first (works offline — see tools/mirror_cubing.py), CDN as backup.
const SOURCES = [
  new URL('../vendor/cubing/cubing/scramble.js', import.meta.url).href,
  'https://cdn.cubing.net/v0/js/cubing/scramble',
];

let _randomScramble = null;
let _cubingFailed = false;

/** Lazy-load cubing.js. Resolves to null if neither source can be reached. */
async function cubing() {
  if (_randomScramble || _cubingFailed) return _randomScramble;
  for (const src of SOURCES) {
    try {
      const mod = await import(/* @vite-ignore */ src);
      if (mod?.randomScrambleForEvent) {
        _randomScramble = mod.randomScrambleForEvent;
        return _randomScramble;
      }
    } catch (err) {
      console.warn('[scramble] could not load', src, err.message);
    }
  }
  console.warn('[scramble] cubing.js unavailable — using fallback generator');
  _cubingFailed = true;
  return null;
}

export const cubingAvailable = () => !_cubingFailed;

// Loading cubing.js and compiling its solver is the entire reason the first
// scramble ever feels slow. Start it the moment this module is evaluated —
// before settings, sessions and IndexedDB have been read — so the work happens
// while the rest of the app is still booting instead of after it.
cubing().catch(() => { /* the fallback generator covers this */ });

/* ---------------------------------------------------------
   Fallback generator — only used when the CDN cannot be reached.
   Not random-state, so it is NOT competition legal; the UI says so.
   --------------------------------------------------------- */
const FALLBACK_MOVES = {
  '333': [['R','L'],['U','D'],['F','B']],
  '222': [['R'],['U'],['F']],
  '444': [['R','Rw','L'],['U','Uw','D'],['F','Fw','B']],
  '555': [['R','Rw','L','Lw'],['U','Uw','D','Dw'],['F','Fw','B','Bw']],
  '666': [['R','Rw','3Rw','L'],['U','Uw','3Uw','D'],['F','Fw','3Fw','B']],
  '777': [['R','Rw','3Rw','L','Lw'],['U','Uw','3Uw','D','Dw'],['F','Fw','3Fw','B','Bw']],
  'pyram':[['R'],['L'],['U'],['B']],
  'skewb':[['R'],['U'],['L'],['B']],
};
const FALLBACK_LEN = { '333':21,'222':11,'444':45,'555':60,'666':80,'777':100,'pyram':11,'skewb':11 };

function fallbackScramble(eventId) {
  const base = eventId.replace('bf','').replace('oh','').replace('fm','').replace('mbf','');
  const key = FALLBACK_MOVES[base] ? base : '333';
  const axes = FALLBACK_MOVES[key];
  const len = FALLBACK_LEN[key] || 21;
  const sufs = ['', "'", '2'];
  const out = [];
  let lastAxis = -1;
  while (out.length < len) {
    let a = Math.floor(Math.random() * axes.length);
    if (a === lastAxis) continue;
    lastAxis = a;
    out.push(pick(axes[a]) + pick(sufs));
  }
  return out.join(' ');
}

/* ---------------------------------------------------------
   Trainer generators
   --------------------------------------------------------- */

const SETS = {
  PLL,
  OLL,
  OLL2: [...OLL_EO, ...OCLL],
  PLL2: [...PLL_CP, ...PLL_EP],
  OCLL,
};

export function setFor(modeId) {
  const m = MODES[modeId];
  return m && m.set ? SETS[m.set] : null;
}

const auf = () => pick(U_MOVES);

/** Case-based scramble: AUF + inverse(solution) + AUF. */
function caseScramble(setName, allowed) {
  const set = SETS[setName] || PLL;
  const pool = (allowed && allowed.length) ? set.filter(c => allowed.includes(c.id)) : set;
  const c = pick(pool.length ? pool : set);
  const seq = tidy([auf(), invert(c.alg), auf()].filter(Boolean).join(' '));
  return { scramble: seq, caseId: c.id, caseName: c.label ? `${c.name} · ${c.label}` : c.name };
}

/** Last layer = a random orientation case stacked on a random permutation case. */
function composeLL() {
  const o = pick(OLL), p = pick(PLL);
  const seq = tidy([auf(), invert(p.alg), auf(), invert(o.alg), auf()].join(' '));
  return { scramble: seq, caseId: `${o.id}+${p.id}`, caseName: `OLL ${o.name} + ${p.name}` };
}

/**
 * Random composition of cross-preserving triggers — leaves the cross solved.
 * Short triggers are favoured so the scramble stays executable; anything that
 * still comes out overlong is regenerated rather than handed to the user.
 */
function triggerScramble([lo, hi], maxMoves = 26) {
  const short = CROSS_SAFE_TRIGGERS.filter(t => t.split(' ').length <= 3);
  for (let attempt = 0; attempt < 12; attempt++) {
    const n = lo + Math.floor(Math.random() * (hi - lo + 1));
    const parts = [];
    for (let i = 0; i < n; i++) {
      // mostly short triggers, with the occasional longer one for variety
      parts.push(pick(Math.random() < 0.82 ? short : CROSS_SAFE_TRIGGERS));
      parts.push(auf());
    }
    // Inverting keeps the cross solved and makes the sequence feel like a scramble.
    const seq = tidy(invert(parts.filter(Boolean).join(' ')));
    const len = seq.split(/\s+/).filter(Boolean).length;
    if (len <= maxMoves && len >= 8) return { scramble: seq };
  }
  return { scramble: tidy(invert(Array.from({ length: lo }, () => `${pick(short)} ${auf()}`).join(' '))) };
}

/** Random moves from a restricted pool (2-gen, LSE, Roux). */
function subgroupScramble(poolName, [lo, hi]) {
  const pool = POOLS[poolName] || POOLS['2gen'];
  const n = lo + Math.floor(Math.random() * (hi - lo + 1));
  const out = [];
  let last = '';
  while (out.length < n) {
    const m = pick(pool);
    if (faceOf(m) === last) continue;
    last = faceOf(m);
    out.push(m);
  }
  return { scramble: out.join(' ') };
}

/* ---------------------------------------------------------
   Public API
   --------------------------------------------------------- */

/**
 * Generate one scramble.
 * @returns {Promise<{scramble:string, caseId?:string, caseName?:string, official:boolean, parts?:string[]}>}
 */
export async function generate(eventId, modeId = 'wca', opts = {}) {
  const mode = MODES[modeId] || MODES.wca;

  if (mode.kind === 'case')     return { ...caseScramble(mode.set, opts.allowedCases), official: false };
  if (mode.kind === 'compose')  return { ...composeLL(), official: false };
  if (mode.kind === 'trigger')  return { ...triggerScramble(mode.depth, mode.maxMoves), official: false };
  if (mode.kind === 'subgroup') return { ...subgroupScramble(mode.pool, mode.depth), official: false };

  // wca + wca-goal: official random-state scramble
  const ev = EVENTS[eventId] || EVENTS['333'];
  const gen = await cubing();

  if (ev.multi) {
    const count = opts.multiCount || 3;
    const parts = [];
    for (let i = 0; i < count; i++) parts.push(await one(gen, eventId));
    return { scramble: parts.map((p, i) => `${i + 1}) ${p}`).join('\n'), parts, official: !!gen };
  }

  return { scramble: await one(gen, eventId), official: !!gen };
}

async function one(gen, eventId) {
  if (!gen) return fallbackScramble(eventId);
  try {
    const alg = await gen(eventId);
    return alg.toString();
  } catch (err) {
    console.warn('[scramble] generation failed for', eventId, err);
    return fallbackScramble(eventId);
  }
}

/* ---------------------------------------------------------
   Queue — always keeps N scrambles ready for the active mode
   --------------------------------------------------------- */
export class ScrambleQueue {
  constructor(depth = 3) {
    this.depth = depth;
    this.key = '';
    this.items = [];
    this.filling = false;
    this.opts = {};
    this.onReady = null;
    this.waiters = [];
  }

  /** Switch event/mode. Drops the old queue and starts warming the new one. */
  setContext(eventId, modeId, opts = {}) {
    const key = `${eventId}|${modeId}|${JSON.stringify(opts.allowedCases || '')}|${opts.multiCount || ''}`;
    if (key === this.key) return;
    this.key = key;
    this.eventId = eventId;
    this.modeId = modeId;
    this.opts = opts;
    this.items = [];
    this._release();          // let anyone mid-wait fall through to a fresh one
    this.fill();
  }

  async fill() {
    if (this.filling) return;
    this.filling = true;
    const key = this.key;
    try {
      while (this.items.length < this.depth && key === this.key) {
        const s = await generate(this.eventId, this.modeId, this.opts);
        if (key !== this.key) break;             // context changed mid-flight
        this.items.push(s);
        this._release();
        if (this.items.length === 1 && this.onReady) this.onReady();
      }
    } finally {
      this.filling = false;
      this._release();
    }
  }

  /** Wake anyone waiting on next() as soon as there is something to hand out. */
  _release() {
    if (!this.items.length || !this.waiters.length) return;
    const w = this.waiters;
    this.waiters = [];
    for (const resolve of w) resolve();
  }

  /**
   * Take the next scramble.
   * If the queue is still warming, wait for the in-flight fill rather than
   * kicking off a second generation of the same thing — on the very first
   * scramble that doubled the solver's start-up cost for no benefit.
   */
  async next() {
    if (!this.items.length) {
      const key = this.key;
      if (!this.filling) this.fill();
      if (!this.items.length) await new Promise(r => this.waiters.push(r));
      // The fill can end empty (context switched, or generation threw), and it
      // can end because the context switched under us. Either way, make one
      // ourselves rather than handing back undefined.
      if (!this.items.length || key !== this.key) {
        return generate(this.eventId, this.modeId, this.opts);
      }
    }
    const s = this.items.shift();
    this.fill();
    return s;
  }

  get ready() { return this.items.length > 0; }
}
