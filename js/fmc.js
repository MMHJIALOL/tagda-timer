import { t } from './i18n.js';
/* ===========================================================
   Tagda Timer — Fewest Moves: reading and judging a solution

   Nothing in here touches the DOM, so test.html can ask it the same
   questions the workspace does.

   The rules are WCA Article E, read rather than remembered:

     E2b   60 minutes for the attempt.
     E2c   the solution is correct if scramble + solution leaves the
           puzzle solved.
     E2c2  one unambiguous sequence of moves. Brackets are refused here
           (see BRACKETS below).
     E2c4  only moves exactly defined in 12a may appear.
     E2c4++ R2' means R2.
     E2c6  wrong capitalisation is read as the right capitalisation —
           so `uw` is `Uw`, `Y` is `y`, and a bare `r` is `R`, NOT `Rw`.
     E2d   the result is the move count in OBTM: face and wide turns 1,
           rotations 0.
     E2d1  the solution must not exceed 80 moves in ETM, which counts
           rotations as 1. Two metrics, two different numbers — the one
           that goes on the scorecard is not the one that is capped.
     12a   the whole of the legal notation: U D L R F B, nFw wide turns
           with 1 < n < N (so only `Rw` / `2Rw` on a 3x3), and x y z.
           No M, E or S: slice moves are not 3x3x3 notation.
   =========================================================== */

import { SOLVED, applyAlg, facelets } from './cube3.js';

export const TIME_LIMIT_MS = 60 * 60 * 1000;   // E2b
export const MAX_ETM = 80;                     // E2d1

/* A judge reads "(R U)" as "R U" — E2c4 throws away symbols that are not
   letters, numbers or apostrophes. A typed box is not a judge: brackets in a
   box mean NISS or an insertion, and the moves inside one are not the moves
   that were done, in the order they were done. Reading them literally would
   quietly award a move count nobody performed, so they are refused by name
   instead. Everything else E2c4 discards is refused the same way, as an
   unreadable token. */
const BRACKETS = /[()[\]{}<>]/;

/* One token, given that capitalisation carries no meaning (E2c6). `n` is the
   wide-turn prefix, `w` the wide marker, and the suffix covers R', R2 and the
   R2' / '2 spellings E2c4++ folds into R2. */
const TOKEN = /^(\d*)([UDLRFBXYZudlrfbxyz])([wW]?)(2'|'2|['2])?$/;

const named = (token, why) => ({ token, message: `${token} — ${why}` });

/**
 * Read a solution as a list of moves the cube model can execute.
 *
 * @returns {{tokens: Array|null, error: {token,message}|null, warnings: string[]}}
 *   `tokens` are cube3.js's own shape, so applyAlg can take them directly.
 */
export function parseSolution(text) {
  const raw = String(text ?? '').trim();
  const warnings = [];
  if (BRACKETS.test(raw)) {
    const tok = raw.split(/\s+/).find(t => BRACKETS.test(t)) || raw.slice(0, 8);
    return { tokens: null, warnings, error: named(tok,
      t('brackets are not a move. Write the solution out in the order it is turned (WCA E2c2)')) };
  }
  if (!raw) return { tokens: [], warnings, error: null };

  const tokens = [];
  for (const tok of raw.split(/\s+/)) {
    if (!tok) continue;
    const m = TOKEN.exec(tok);
    if (!m) {
      const why = /^[MES]/i.test(tok)
        ? t('slice moves are not 3x3x3 notation (WCA 12a, E2c4)')
        : t('not a move defined in WCA 12a');
      return { tokens: null, warnings, error: named(tok, why) };
    }
    const [, count, letter, wideMark, suffix] = m;
    const amount = !suffix ? 1 : suffix.includes('2') ? 2 : 3;

    if ('XYZxyz'.includes(letter)) {
      if (wideMark || count) {
        return { tokens: null, warnings, error: named(tok, t('a rotation is written x, y or z on its own (WCA 12a4)')) };
      }
      tokens.push({ tok, letter: letter.toLowerCase(), wide: false, amount, rotation: true });
      continue;
    }

    const wide = !!wideMark;
    if (count && !wide) {
      return { tokens: null, warnings, error: named(tok, t('only wide turns take a number in front (WCA 12a2)')) };
    }
    if (wide && count && count !== '2') {
      return { tokens: null, warnings, error: named(tok,
        t('{n} layers is not a turn on a 3x3x3 — only Rw (or 2Rw) exists here (WCA 12a2+)', { n: count })) };
    }
    /* E2c6+ is explicit that a bare `r` is `R` and not `Rw`, which is the
       opposite of what every other cubing program on the machine does with
       it. Counted the WCA's way, and said out loud, because a solution that
       silently means something else is the one way to lose an attempt to
       notation rather than to cubing. */
    if (!wide && letter === letter.toLowerCase()) {
      warnings.push(t('{tok} counts as {move}, not a wide turn (WCA E2c6)', { tok, move: letter.toUpperCase() + (amount === 2 ? '2' : amount === 3 ? "'" : '') }));
    }
    tokens.push({ tok, letter: letter.toUpperCase(), wide, amount, rotation: false });
  }
  return { tokens, warnings, error: null };
}

/**
 * The two metrics for a solution.
 *
 * @returns {{obtm: number|null, etm: number|null, error: {token,message}|null, warnings: string[]}}
 *   `obtm` is the result that goes on the scorecard (E2d); `etm` is the one
 *   the 80-move limit is measured in (E2d1). Both null when a token could not
 *   be read, and `error` then names it.
 */
export function countMoves(solution) {
  const { tokens, error, warnings } = parseSolution(solution);
  if (error) return { obtm: null, etm: null, error, warnings };
  return {
    obtm: tokens.filter(t => !t.rotation).length,
    etm: tokens.length,
    error: null,
    warnings,
  };
}

/** Every face showing one colour — solved however the cube ended up held. */
export function isSolved(state) {
  const f = facelets(state);
  for (let face = 0; face < 6; face++) {
    const first = f[face * 9];
    for (let i = 1; i < 9; i++) if (f[face * 9 + i] !== first) return false;
  }
  return true;
}

/**
 * Judge one attempt.
 *
 * @returns {{ok, moves, etm, solved, error, warnings}}
 *   `ok` is "this would be a result": read, within the limit, and solved.
 *   `moves` is the OBTM count whenever the notation was legal, so the box can
 *   keep counting past 80 rather than going blank at the moment it matters.
 */
export function validateFmc(scramble, solution) {
  const { obtm, etm, error, warnings } = countMoves(solution);
  if (error) return { ok: false, moves: null, etm: null, solved: false, error, warnings };

  if (etm > MAX_ETM) {
    return { ok: false, moves: obtm, etm, solved: false, warnings, error: {
      token: null,
      message: t('{n} moves in Execution Turn Metric — the limit is {max}, rotations included (WCA E2d1)', { n: etm, max: MAX_ETM }),
    } };
  }

  const scrambled = applyAlg(SOLVED, String(scramble || ''));
  if (!scrambled) {
    return { ok: false, moves: obtm, etm, solved: false, warnings, error: {
      token: null, message: t('the scramble could not be read'),
    } };
  }
  if (!etm) return { ok: false, moves: 0, etm: 0, solved: false, error: null, warnings };

  const { tokens } = parseSolution(solution);
  const end = applyAlg(scrambled.state, tokens, scrambled.frame);
  const solved = !!end && isSolved(end.state);
  return { ok: solved, moves: obtm, etm, solved, error: null, warnings };
}

/** A finished attempt, as the solve record and the stats want it. */
export function resultOf(scramble, solution) {
  const v = validateFmc(scramble, solution);
  return v.ok ? { moves: v.moves, penalty: 'none' } : { moves: null, penalty: 'DNF' };
}
