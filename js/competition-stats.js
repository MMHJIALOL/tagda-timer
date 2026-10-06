import { averageOf, eff, trimmedIndices } from './stats.js';
import { fmt, fmtResult } from './util.js';
import { t } from './i18n.js';

export function validateCompetitionSize(value) {
  const text = String(value).trim();
  const size = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(size) || size < 5) throw new Error(t('Enter a whole number of attempts, at least 5 (within JavaScript’s safe integer range).'));
  return size;
}
export function competitionResult(set, solves) {
  const complete = set.status === 'complete' && solves.length === set.size && solves.every(Boolean);
  const tr = complete ? trimmedIndices(solves, set.size) : { best: new Set(), worst: new Set() };
  return { value: complete ? averageOf(solves.map(eff)) : null, trimmed: new Set([...tr.best, ...tr.worst]), complete };
}
export function competitionTime(s) {
  if (s.penalty === 'DNF') return `DNF (${fmt(s.timeMs)})`;
  return fmt(eff(s)) + (s.penalty === '+2' ? ' +2' : '');
}
// All timestamps use media milliseconds; penalties are read from current solves.
export function competitionClockAt(set, solves, ms) {
  let current = null, index = 0;
  for (let i = 0; i < solves.length; i++) {
    const s = solves[i];
    if (s?.competitionTiming && ms >= (s.competitionTiming.inspection ?? s.competitionTiming.start)) { current = s; index = i; }
  }
  if (!current) return { kind: 'pre', phase: t('Scrambling / waiting'), text: `Ao${set.size}` };
  const m = current.competitionTiming;
  const prefix = `${index + 1}/${set.size}`;
  if (ms >= m.stop) return { kind: 'done', phase: `${prefix} · ${t('stopped')}`, text: competitionTime(current), pen: '' };
  if (ms >= m.start) return { kind: 'run', phase: `${prefix} · ${t('solving')}`, text: fmt(ms - m.start) };
  return { kind: ms - m.inspection >= 15000 ? 'late' : 'insp', phase: `${prefix} · ${t('inspection')}`, text: String(Math.ceil(Math.max(0, 15000 - (ms - m.inspection))/1000)) };
}
