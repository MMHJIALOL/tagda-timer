/* ===========================================================
   Tagda Timer — searching your solves

   The Stats drawer's search box. One line of text becomes a list of terms,
   and a solve is a result only when it matches every one of them, so
   "dnf oct" is the DNFs from October and "sub 10 today" is today's sub-10s.

   What a term can be:
     12.24            a time as it is shown: 12.24 finds 12.240–12.249, 12.2
                      finds 12.20–12.29, 12 finds anything that reads 12.xx.
                      In a Fewest Moves session, 28 finds 28-move results.
     12-13, 12 to 13  between two times, both ends included (12.00–13.00)
     <10 >=20 sub 10  under / over a time
     dnf +2 ok        by penalty
     today 2026-10-20 20/10/2026 20 oct  oct 2026  october  monday  2026
                      by the day the solve was done, in local time
     #45 #40-50       by solve number, as the Stats drawer numbers them
     anything else    the scramble (whole moves: "R U" does not match R U2),
                      the comment, the case name and the event

   Times are compared the way they are printed: the shown time is the one
   with a +2 added, a DNF has no time, and 12.249 reads as 12.24 because
   fmt() cuts to hundredths rather than rounding.
   =========================================================== */

import { t, lang } from './i18n.js';
import { eff, DNF, isMoveResult } from './stats.js';

const LOCALE = lang === 'ptbr' ? 'pt-BR' : lang;

const fold = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/* Month and weekday names: English always, plus the interface language's own,
   long and short ("october", "oct", "octubre", "oct."). */
function nameTable(kind, count, make) {
  const map = new Map();
  for (const loc of new Set(['en', LOCALE])) {
    for (const style of ['long', 'short']) {
      let f;
      try { f = new Intl.DateTimeFormat(loc, { [kind]: style, timeZone: 'UTC' }); } catch { continue; }
      for (let i = 0; i < count; i++) {
        const name = fold(f.format(make(i))).replace(/\.$/, '');
        if (name.length >= 3 && !map.has(name)) map.set(name, i);
      }
    }
  }
  return map;
}
const MONTHS = nameTable('month', 12, i => new Date(Date.UTC(2001, i, 15)));
MONTHS.set('sept', 8);
// 7 Jan 2001 was a Sunday, so i is getDay()'s numbering.
const WEEKDAYS = nameTable('weekday', 7, i => new Date(Date.UTC(2001, 0, 7 + i)));
for (const [k, v] of [['tues', 2], ['weds', 3], ['thur', 4], ['thurs', 4]]) WEEKDAYS.set(k, v);

/** Does this device write dates day first (20/10) or month first (10/20)? */
function dayFirstHere() {
  try {
    const parts = new Intl.DateTimeFormat(undefined).formatToParts(new Date(2001, 1, 3)).map(p => p.type);
    return parts.indexOf('day') < parts.indexOf('month');
  } catch { return true; }
}

/* ---------- reading a time ---------- */

const TIME_RE = /^(?:\d+:){0,2}\d+(?:\.\d{1,3})?$/;

/**
 * "1:05.6" → { lo: 65600, step: 100, num: null }. `lo` is where the typed
 * value starts in milliseconds and `step` how far its last digit reaches, so
 * lo..lo+step is everything that prints as what was typed. `num` is the plain
 * number for a move count, absent when the text has a colon.
 */
export function parseTime(str) {
  if (!TIME_RE.test(str)) return null;
  const parts = str.split(':');
  const last = parts.pop();
  const [whole, frac = ''] = last.split('.');
  let sec = 0;
  for (const p of parts) sec = sec * 60 + Number(p);
  sec = sec * 60 + Number(whole);
  const ms = Math.round((sec + (frac ? Number('0.' + frac) : 0)) * 1000);
  const step = frac ? 10 ** (3 - frac.length) : 1000;
  return { lo: ms, step, num: parts.length ? null : Number(last), text: str };
}

/* ---------- reading the query ---------- */

const DAY_RE = /^(\d{1,2})(?:st|nd|rd|th)?$/;
const YEAR_RE = /^(\d{4})$/;
const OPS = { sub: '<', under: '<', below: '<', over: '>', above: '>' };
// How many days ago, in English and in the interface's other languages.
const DAYS_BACK = { today: 0, hoy: 0, hoje: 0, yesterday: 1, ayer: 1, ontem: 1 };

/** Split into words, keeping "quoted phrases" whole. */
function words(query) {
  const out = [];
  const re = /"([^"]*)"?|(\S+)/g;
  const clean = String(query).replace(/[–—]/g, '-').replace(/[‘’′]/g, "'").replace(/,/g, ' ');
  let m;
  while ((m = re.exec(clean))) {
    if (m[1] !== undefined) { if (m[1].trim()) out.push({ quoted: m[1].trim() }); }
    else out.push(m[2]);
  }
  return out;
}

const validDay = (y, m, d) => {
  if (!(m >= 0 && m < 12 && d >= 1 && d <= 31)) return false;
  return y === undefined || new Date(y, m, d).getDate() === d;
};

const fullYear = (y) => (y.length === 2 ? 2000 + Number(y) : Number(y));

/**
 * The query as a list of terms. Each has a `kind`, what it matches, and a
 * `label` saying how it was read, so the drawer can show "time 12.24 · DNF"
 * and you can see a typo for what it is.
 */
export function parseQuery(query, { now = Date.now(), dayFirst = dayFirstHere() } = {}) {
  const w = words(query);
  const terms = [];
  let phrase = [];
  const flush = () => {
    if (phrase.length) terms.push(textTerm(phrase.join(' ')));
    phrase = [];
  };
  const push = (term) => { flush(); terms.push(term); };
  const lower = (x) => (typeof x === 'string' ? fold(x) : null);

  for (let i = 0; i < w.length; i++) {
    const raw = w[i];
    if (typeof raw !== 'string') { push(textTerm(raw.quoted)); continue; }
    const x = lower(raw);
    const next = lower(w[i + 1]);

    // ---- penalties ----
    if (x === 'dnf' || x === 'dnfs') { push(penaltyTerm('DNF')); continue; }
    if (x === '+2' || x === 'plus2' || x === '+2s') { push(penaltyTerm('+2')); continue; }
    if (x === 'ok' || x === 'clean') { push(penaltyTerm('none')); continue; }
    if (x === 'no' && (next === 'penalty' || next === 'penalties')) { push(penaltyTerm('none')); i++; continue; }

    // ---- days by name ----
    if (x in DAYS_BACK) {
      const d = new Date(now);
      d.setDate(d.getDate() - DAYS_BACK[x]);
      push(dateTerm({ y: d.getFullYear(), m: d.getMonth(), d: d.getDate() }, DAYS_BACK[x] ? 'yesterday' : 'today'));
      continue;
    }
    if (MONTHS.has(x)) {
      // "20 oct", "oct 20", "20th october 2026", "oct 2026". The day before
      // the month name has already been read as a time, so take it back.
      const m = MONTHS.get(x);
      const prev = phrase.length ? null : terms[terms.length - 1];
      let d, from = null, j = i;
      if (prev?.kind === 'value' && prev.fromWord === i - 1 && DAY_RE.test(prev.text)) {
        d = Number(prev.text.match(DAY_RE)[1]); from = 'term';
      } else if (phrase.length && DAY_RE.test(phrase[phrase.length - 1])) {
        d = Number(phrase[phrase.length - 1].match(DAY_RE)[1]); from = 'phrase';
      } else if (next && DAY_RE.test(next)) { d = Number(next.match(DAY_RE)[1]); j++; }
      const after = lower(w[j + 1]);
      const y = after && YEAR_RE.test(after) ? Number(after) : undefined;
      // "32 oct" is a time and a month, not a day that does not exist.
      if (d !== undefined && !validDay(y, m, d)) { d = undefined; from = null; j = i; }
      else if (y !== undefined) j++;
      if (from === 'term') terms.pop();
      if (from === 'phrase') phrase.pop();
      i = j;
      push(dateTerm({ y, m, d }));
      continue;
    }
    if (WEEKDAYS.has(x)) { push(dateTerm({ dow: WEEKDAYS.get(x) })); continue; }

    // ---- numeric dates ----
    let m;
    if ((m = x.match(/^(\d{4})[-/.](\d{1,2})(?:[-/.](\d{1,2}))?$/))) {
      const y = Number(m[1]), mo = Number(m[2]) - 1, d = m[3] ? Number(m[3]) : undefined;
      if (mo >= 0 && mo < 12 && (d === undefined || validDay(y, mo, d))) { push(dateTerm({ y, m: mo, d })); continue; }
    }
    if ((m = x.match(/^(\d{1,2})([-/.])(\d{1,2})\2(\d{2}|\d{4})$/)) || (m = x.match(/^(\d{1,2})(\/)(\d{1,2})$/))) {
      let a = Number(m[1]), b = Number(m[3]);
      const y = m[4] ? fullYear(m[4]) : undefined;
      // Whichever way round this device writes dates, unless the numbers say otherwise.
      let [d, mo] = dayFirst ? [a, b] : [b, a];
      if (mo > 12 && d <= 12) [d, mo] = [mo, d];
      if (validDay(y, mo - 1, d)) { push(dateTerm({ y, m: mo - 1, d })); continue; }
    }

    // ---- solve numbers ----
    if ((m = x.match(/^#(\d+)(?:-#?(\d+))?$/))) {
      const a = Number(m[1]), b = m[2] ? Number(m[2]) : a;
      push(numberTerm(Math.min(a, b), Math.max(a, b)));
      continue;
    }

    // ---- comparisons: <10, < 10, sub 10, sub10, >=20 ----
    let op = null, rest = '';
    if ((m = x.match(/^(<=|>=|<|>|=<|=>)(.*)$/))) { op = m[1].replace('=<', '<=').replace('=>', '>='); rest = m[2]; }
    else if ((m = x.match(/^(sub|under|below|over|above)(.*)$/)) && (m[2] === '' || TIME_RE.test(m[2]))) { op = OPS[m[1]]; rest = m[2]; }
    if (op) {
      let v = rest ? parseTime(rest) : null;
      if (!rest && next && parseTime(next)) { v = parseTime(next); i++; }
      if (v) { push(compareTerm(op, v)); continue; }
      if (!rest && !(x in OPS)) { phrase.push(raw); continue; }
    }

    // ---- ranges: 12-13, 12..13, 12 - 13, 12 to 13 ----
    if ((m = x.match(/^([\d:.]+?)(?:-|\.\.)([\d:.]+)$/)) && parseTime(m[1]) && parseTime(m[2])) {
      push(rangeTerm(parseTime(m[1]), parseTime(m[2]))); continue;
    }
    const here = parseTime(x);
    if (here && (next === '-' || next === 'to' || next === '..') && parseTime(lower(w[i + 2]) || '')) {
      push(rangeTerm(here, parseTime(lower(w[i + 2])))); i += 2; continue;
    }

    // ---- a year on its own ----
    if (YEAR_RE.test(x) && Number(x) >= 2000 && Number(x) <= 2099) { push(dateTerm({ y: Number(x) })); continue; }

    // ---- a time ----
    if (here) { push({ ...valueTerm(here), fromWord: i }); continue; }

    phrase.push(raw);
  }
  flush();
  return terms;
}

/* ---------- the terms ---------- */

/** What is compared: the printed time (hundredths) unless milliseconds were typed. */
const shown = (s, v) => {
  const e = eff(s);
  if (e === DNF) return null;
  if (isMoveResult(s)) return v.num === null ? null : e;
  return v.step < 10 ? e : Math.floor(e / 10) * 10;
};
const at = (s, v) => (isMoveResult(s) ? v.num : v.lo);
const timeLabel = (v) => v.text;

function valueTerm(v) {
  return {
    kind: 'value', text: v.text, label: t('time {v}', { v: timeLabel(v) }),
    test: (s) => {
      const e = eff(s);
      if (e === DNF) return false;
      if (isMoveResult(s)) return v.num !== null && e >= v.num && e < v.num + v.step / 1000;
      return e >= v.lo && e < v.lo + v.step;
    },
  };
}

function rangeTerm(a, b) {
  if (b.lo < a.lo) [a, b] = [b, a];
  return {
    kind: 'range', label: t('time {a} to {b}', { a: timeLabel(a), b: timeLabel(b) }),
    test: (s) => {
      const q = shown(s, a.step < b.step ? a : b);
      return q !== null && q >= at(s, a) && q <= at(s, b);
    },
  };
}

function compareTerm(op, v) {
  const words = { '<': 'under {v}', '<=': 'up to {v}', '>': 'over {v}', '>=': '{v} or more' };
  return {
    kind: 'compare', label: t(words[op], { v: timeLabel(v) }),
    test: (s) => {
      const q = shown(s, v);
      if (q === null || at(s, v) === null) return false;
      const x = at(s, v);
      return op === '<' ? q < x : op === '<=' ? q <= x : op === '>' ? q > x : q >= x;
    },
  };
}

function penaltyTerm(p) {
  return {
    kind: 'penalty', label: p === 'none' ? t('no penalty') : p,
    test: (s) => (s.penalty || 'none') === p,
  };
}

function dateTerm(when, word) {
  const { y, m, d, dow } = when;
  let label;
  if (word) label = t(word);
  else if (dow !== undefined) {
    label = new Intl.DateTimeFormat(LOCALE, { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2001, 0, 7 + dow)));
  } else {
    const opts = {};
    if (d !== undefined) opts.day = 'numeric';
    if (m !== undefined) opts.month = d !== undefined ? 'short' : 'long';
    if (y !== undefined) opts.year = 'numeric';
    label = new Intl.DateTimeFormat(LOCALE, opts).format(new Date(y ?? 2000, m ?? 0, d ?? 1));
  }
  return {
    kind: 'date', label,
    test: (s) => {
      const c = new Date(s.createdAt);
      return (y === undefined || c.getFullYear() === y) && (m === undefined || c.getMonth() === m) &&
        (d === undefined || c.getDate() === d) && (dow === undefined || c.getDay() === dow);
    },
  };
}

function numberTerm(a, b) {
  return {
    kind: 'number', label: a === b ? t('solve #{n}', { n: a }) : t('solves #{a}–#{b}', { a, b }),
    test: (s, n) => n >= a && n <= b,
  };
}

/* Moves are matched whole and in order, so "R U" finds "R U R'" but not
   "R U2"; everything else is a plain "contains". */
function textTerm(phrase) {
  const want = fold(phrase);
  const moves = phrase.trim().split(/\s+/);
  return {
    kind: 'text', label: `“${phrase}”`,
    test: (s, n, extra) => {
      const scr = String(s.scramble || '').split(/\s+/).filter(Boolean);
      outer: for (let i = 0; i + moves.length <= scr.length; i++) {
        for (let j = 0; j < moves.length; j++) if (scr[i + j] !== moves[j]) continue outer;
        return true;
      }
      return [s.comment, s.caseName, s.fmcNotes, s.fmcSolution, extra]
        .some(f => f && fold(f).includes(want));
    },
  };
}

/**
 * The solves matching every term, newest first. `solves` is the list as the
 * drawer has it, oldest first, which is also where the #numbers come from.
 * `extraText(solve)` adds words a solve should be findable by (its event).
 */
export function searchSolves(solves, query, { now, dayFirst, extraText } = {}) {
  const terms = parseQuery(query, { now, dayFirst });
  if (!terms.length) return { terms, matches: [] };
  const matches = [];
  for (let i = solves.length - 1; i >= 0; i--) {
    const s = solves[i];
    const extra = extraText ? extraText(s) : '';
    if (terms.every(term => term.test(s, i + 1, extra))) matches.push({ solve: s, n: i + 1 });
  }
  return { terms, matches };
}
