import { t } from './i18n.js';
/* ===========================================================
   Tagda Timer — scramble generation

   Official WCA scrambles come from cubing.js, which wraps the same
   random-state solvers TNoodle (the WCA's own scrambler) uses.
   Generation is async and slow on first run, so we keep a warm queue
   and hand out pre-made scrambles — the user never waits.
   =========================================================== */

import { EVENTS, MODES } from './events.js';
import { PLL, OLL, OLL_EO, OCLL, PLL_CP, PLL_EP, CROSS_SAFE_TRIGGERS, U_MOVES, POOLS, faceOf } from './algs.js';
import { F2L } from './f2l.js';
import { OLL_222, PBL_222, CLL_222, EG1_222, EG2_222 } from './algs2.js';
import { ZBLL_SET } from './zbll.js';
import { invert, tidy, pick } from './util.js';
import { preferredAlg, loadSet } from './alglibrary.js';
import { clockScramble } from './sidescramble.js';

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
/* The square-1 tables take a couple of seconds to build. They build on their
   own thread, so start now: by the time anyone picks square-1 they are there.
   ponytail: every visit pays ~2 s of one background core and ~11 MB for this;
   build on first use instead if that ever matters on low-end phones. */
setTimeout(() => sq1(true), 0);

/* ---------------------------------------------------------
   Square-1 and clock: made here, not in cubing.js
   --------------------------------------------------------- */

/* See js/sidescramble.js for why. Square-1 builds ~11 MB of tables the first
   time and then searches, so it runs in a worker of its own: never on the
   page, where it would stall the timer, and never in cubing.js's worker,
   where it would hold up every other puzzle. */
const OWN = { clock: () => clockScramble(), sq1: () => sq1() };

let sq1Worker = null;
const sq1Waiting = new Map();
let sq1Seq = 0;

function sq1(warmOnly = false) {
  if (sq1Worker === null) {
    try {
      sq1Worker = new Worker(new URL('./sidescramble.worker.js', import.meta.url), { type: 'module' });
      sq1Worker.onmessage = ({ data }) => { sq1Waiting.get(data.id)?.resolve(data.scramble); sq1Waiting.delete(data.id); };
      sq1Worker.onerror = (err) => {
        console.warn('[scramble] square-1 worker failed — making them on the page', err.message);
        sq1Worker = false;
        for (const w of sq1Waiting.values()) sq1().then(w.resolve);
        sq1Waiting.clear();
      };
    } catch {
      sq1Worker = false;          // no module workers: the page makes them
    }
  }
  if (warmOnly) { if (sq1Worker) sq1Worker.postMessage({ warm: true }); return null; }
  if (!sq1Worker) return import('./sidescramble.js').then(m => m.sq1Scramble());
  return new Promise((resolve) => {
    const id = ++sq1Seq;
    sq1Waiting.set(id, { resolve });
    sq1Worker.postMessage({ id });
  });
}

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
  ZBLL: ZBLL_SET,
  F2L,
  /* 2x2. Small enough to sit beside the rest — 135 cases of short strings,
     against the 472 ZBLL cases already here. */
  OLL222: OLL_222,
  PBL222: PBL_222,
  CLL222: CLL_222,
  EG1222: EG1_222,
  EG2222: EG2_222,
};

export function setFor(modeId) {
  const m = MODES[modeId];
  return m && m.set ? SETS[m.set] || null : null;
}

/* Library sets the timer has fetched, by set id, and puzzles.js once a
   pyraminx, skewb or square-1 set has needed it. */
const LIBRARY = {};
let PUZ = null;

/**
 * Make sure a mode's case list is here, fetching it from the algorithm library
 * the first time. The sets above are always loaded; the library's COLL, CMLL,
 * square-1 and the rest are not, because nobody should pay for 500 square-1
 * cases to time a 3x3. Resolves to the case list, or null if it cannot be had.
 */
export async function loadSetFor(modeId) {
  const name = MODES[modeId]?.set;
  if (!name) return null;
  if (SETS[name]) return SETS[name];
  try {
    const set = await loadSet(name);
    if (!set) return null;
    if (set.puzzle !== 'cube' && !PUZ) PUZ = await import('./puzzles.js');
    LIBRARY[name] = set;
    SETS[name] = set.cases;
    return SETS[name];
  } catch (err) {
    console.warn('[scramble] could not load the case list for', modeId, err.message);
    return null;
  }
}

/* cubing.js reads a 4x4 in SiGN, where a slice letter or a lowercase face does
   not mean what these algorithms mean by it. Spell those out as the layers they
   actually turn, so the scramble and its preview agree with the simulator the
   algorithms were checked on. */
const BIG_SLICE = { M: ['2L', '2R'], E: ['2D', '2U'], S: ['2F', '2B'] };
function forBigCube(seq) {
  return seq.split(' ').filter(Boolean).flatMap(t => {
    const m = /^([MESudfblr])(2?'?)$/.exec(t);
    if (!m) return [t];
    const [, letter, s] = m;
    if (!BIG_SLICE[letter]) return [`${letter.toUpperCase()}w${s}`];
    const back = s === "'" ? '' : s === '' ? "'" : s;
    return [BIG_SLICE[letter][0] + s, BIG_SLICE[letter][1] + back];
  }).join(' ');
}

/**
 * A scramble for a library case: the set's own filler before it, the case's
 * setup, the algorithm backwards, and the filler after — the same recipe as
 * every other case scramble, with the set saying what "AUF" means on its puzzle.
 *
 * A skewb scramble is written in the notation of its algorithms, which
 * cubing.js does not share, so it carries a `preview` for the cube on screen.
 */
function libraryScramble(set, c, alg) {
  const fill = set.scramble || {};
  const pre = Array.from({ length: fill.preRepeat || 1 }, () => pick(fill.pre || [''])).join(' ');
  const post = pick(fill.post || ['']);
  if (set.puzzle === 'cube') {
    /* tidy() reads `R2'` as three quarter turns; it is the same half turn. */
    const seq = tidy([pre, c.setup, invert(alg), post].filter(Boolean).join(' ').replace(/2'/g, '2'));
    return { scramble: set.n === 4 ? forBigCube(seq) : seq };
  }
  const seq = PUZ.joinMoves(set.puzzle, [pre, c.setup, PUZ.invertMoves(set.puzzle, alg), post]);
  return set.puzzle === 'skewb' ? { scramble: seq, preview: PUZ.skewbForCubing(seq) } : { scramble: seq };
}

/** What the preview should play for a scramble recorded in `modeId`, when that differs from the text. */
export function previewOf(modeId, scramble) {
  const set = LIBRARY[MODES[modeId]?.set];
  return set?.puzzle === 'skewb' && PUZ ? PUZ.skewbForCubing(scramble) : null;
}

const auf = () => pick(U_MOVES);

/**
 * Case-based scramble: AUF + inverse(solution) + AUF.
 *
 * The solution inverted is whichever alg you put first in the algorithm
 * library for that case, and the one in algs.js when you never touched it.
 * That is the whole point of being able to drag the list: the case you are
 * handed is built from the alg you actually drill, so the scramble undoes
 * your execution rather than someone else's. Verified equivalent before it
 * could ever be stored, so the case is unchanged either way.
 */
function caseScramble(setName, allowed) {
  const set = SETS[setName] || PLL;
  const pool = (allowed && allowed.length) ? set.filter(c => allowed.includes(c.id)) : set;
  const c = pick(pool.length ? pool : set);
  const alg = preferredAlg(c.id) || c.alg;
  if (LIBRARY[setName]) return { ...libraryScramble(LIBRARY[setName], c, alg), caseId: c.id, caseName: c.name };
  const seq = tidy([auf(), invert(alg), auf()].filter(Boolean).join(' '));
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

  /* A case set that cannot be fetched falls through to a random-state
     scramble for the event, rather than a case from some other puzzle's list —
     and rather than the offline generator, which knows no square-1. */
  if (mode.kind === 'case' && await loadSetFor(modeId)) {
    return { ...caseScramble(mode.set, opts.allowedCases), official: false };
  }
  if (mode.kind === 'compose')  return { ...composeLL(), official: false };
  if (mode.kind === 'trigger')  return { ...triggerScramble(mode.depth, mode.maxMoves), official: false };
  if (mode.kind === 'subgroup') return { ...subgroupScramble(mode.pool, mode.depth), official: false };

  // wca + wca-goal: official random-state scramble
  const ev = EVENTS[eventId] || EVENTS['333'];
  // Nothing to wait for: these never touch cubing.js.
  if (OWN[eventId]) return { scramble: await OWN[eventId](), official: true };
  const gen = await cubing();

  if (ev.multi) {
    const count = opts.multiCount || 3;
    const parts = [];
    for (let i = 0; i < count; i++) parts.push(await one(gen, eventId));
    return { scramble: parts.map((p, i) => `${i + 1}) ${p}`).join('\n'), parts, official: !!gen };
  }

  /* A relay: one scramble per puzzle in the session's list, generated in order.
     `scramble` is the numbered join of all of them, exactly as multi-blind
     writes its own, so every existing reader of solve.scramble -- CSV, the
     csTimer-style export, the history, the share text -- keeps working without
     knowing relays exist. `parts` is what the relay UI and the solve record
     read instead.

     Big-cube random-state generation is seconds per puzzle, so onProgress
     reports each leg as it lands: the queue is what keeps this off the timer's
     path, and that progress line is what the first fill shows instead of an
     empty box. */
  if (ev.relay) {
    const list = (opts.relay || []).filter(id => EVENTS[id]);
    if (!list.length) return { scramble: '', parts: [], official: false };
    const parts = [];
    for (const id of list) {
      parts.push({ event: id, scramble: await one(gen, id) });
      opts.onProgress?.(parts.length, list.length);
    }
    return {
      scramble: parts.map((part, i) => `${i + 1}) ${part.scramble}`).join('\n'),
      parts,
      official: !!gen,
    };
  }


  return { scramble: await one(gen, eventId), official: !!gen };
}

async function one(gen, eventId) {
  if (OWN[eventId]) return OWN[eventId]();
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
const WARM = ['pyram', 'skewb', '222', 'sq1', 'clock'];

export class ScrambleQueue {
  constructor(depth = 3) {
    this.depth = depth;
    this.key = '';
    this.items = [];
    this.filling = false;
    this.opts = {};
    this.onReady = null;
    this.waiters = [];
    /* Scrambles already made for contexts that are not active: the rest of a
       queue you switched away from, and the one-each warm-up below. Switching
       back to an event hands them straight out instead of starting cold. */
    this.stash = new Map();
  }

  static keyOf(eventId, modeId, opts = {}) {
    /* The relay list is part of the context: two relay sessions are the same
       event and the same mode, and a queue warmed for a 2-4 relay must never
       hand its scramble set to a session racing five 2x2s. The relay list and
       the multi-blind count only mean anything to those events, so nothing
       else carries them -- or a pyraminx warmed up from a 3x3 session would
       never match the key pyraminx asks for. */
    const ev = EVENTS[eventId] || {};
    return `${eventId}|${modeId}|${JSON.stringify(opts.allowedCases || '')}|${ev.multi ? opts.multiCount || '' : ''}|${ev.relay ? (opts.relay || []).join(',') : ''}`;
  }

  /** Switch event/mode. Drops the old queue and starts warming the new one. */
  setContext(eventId, modeId, opts = {}) {
    const key = ScrambleQueue.keyOf(eventId, modeId, opts);
    if (key === this.key) return;
    if (this.key) this.stash.set(this.key, this.items);
    this.key = key;
    this.eventId = eventId;
    this.modeId = modeId;
    this.opts = opts;
    this.items = this.stash.get(key) || [];
    this.stash.delete(key);
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
        // Context changed mid-flight: keep it for when that context comes back.
        if (key !== this.key) { this.stash.get(key)?.push(s); break; }
        this.items.push(s);
        this._release();
        if (this.items.length === 1 && this.onReady) this.onReady();
        /* One in hand is enough to be going on with: warm the other puzzles
           now rather than after two more of this one, so a switch in the
           first seconds after loading does not wait behind them. */
        if (this.items.length === 1) await this.warm(key);
      }
      if (key === this.key) await this.warm(key);
    } finally {
      this.filling = false;
      this._release();
    }
    /* The context switched while that fill was in flight. setContext's own
       fill() returned straight away because this one still held the flag, so
       nothing has started on the new event -- and next() is parked waiting
       for it. Start it now, or the new event never gets a scramble at all. */
    if (key !== this.key) this.fill();
  }

  /**
   * Once the active queue has one ready, make one scramble for each of the
   * quick WCA puzzles. cubing.js builds each puzzle's solver the first time
   * it is asked -- up to a few seconds for pyraminx in Firefox, and behind
   * whatever the worker is already doing -- which is what made switching sit on
   * "generating scramble…". Paid here, while you are solving, it is gone by
   * the time you switch.
   */
  async warm(active) {
    if (this.modeId !== 'wca') return;
    for (const id of WARM) {
      if (this.key !== active) return;          // switched: that event goes first
      const key = ScrambleQueue.keyOf(id, 'wca', this.opts);
      if (this.stash.get(key)?.length || key === this.key) continue;
      const s = await generate(id, 'wca', this.opts);
      if (key === this.key) { this.items.push(s); continue; }  // switched to it meanwhile
      this.stash.set(key, [...(this.stash.get(key) || []), s]);
      if (!this.items.length) return;           // the active queue comes first
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
      if (!this.filling) this.fill();
      if (!this.items.length) await new Promise(r => this.waiters.push(r));
      // The fill can end empty (generation threw). Make one ourselves rather
      // than handing back undefined. A context switch while waiting is fine:
      // items and eventId are both the new context's by now.
      if (!this.items.length) {
        return generate(this.eventId, this.modeId, this.opts);
      }
    }
    const s = this.items.shift();
    this.fill();
    return s;
  }

  get ready() { return this.items.length > 0; }
}
