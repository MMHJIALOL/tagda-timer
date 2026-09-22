import { t } from './i18n.js';
/* ===========================================================
   Tagda Timer — the Fewest Moves attempt

   FMC is not a solve you time, it is an hour you spend, so this owns
   the middle of the screen for the 333fm event instead of the
   hold-to-start timer. What it is:

     press Start   — the scramble freezes and a 60:00 countdown begins
     a box         — the solution, judged live by js/fmc.js
     a second box  — scratch notes, never judged, kept with the solve
     Submit        — early is allowed (E2b+)
     Abandon       — asks, then records a DNF
     time out      — submits a solution that works, otherwise a DNF

   The countdown is derived from a timestamp, never counted in frames,
   for the same reason timer.js reads the clock directly: a throttled
   tab must not buy anyone extra minutes. It is Date.now() rather than
   performance.now() because this clock has to survive a reload — the
   scramble, the start stamp and the draft all live in KV, so a crash
   forty minutes in costs nothing but the reload.
   =========================================================== */

import { $, el, debounce } from './util.js';
import { KV } from './db.js';
import { toast, confirmToast } from './toast.js';
import { callout } from './fx.js';
import { canonical } from './cube3.js';
import { validateFmc, parseSolution, TIME_LIMIT_MS, MAX_ETM } from './fmc.js';

const KEY = 'fmc.attempt';

/** Warning calls, in seconds remaining. E2b1 asks a judge for the first. */
const WARN_AT = [5 * 60, 60];

/** The configured attempt length, in ms. Settings > Fewest Moves. */
const limitOf = (app) => {
  const mins = Number(app.settings?.fmcMinutes);
  return Number.isFinite(mins) && mins > 0 ? Math.round(mins * 60000) : TIME_LIMIT_MS;
};

const clock = (ms) => {
  const t = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

export class Fmc {
  /**
   * @param app   the shared app object — settings, session, scramble
   * @param hooks record(result) / preview(alg) / scramble()
   */
  constructor(app, hooks = {}) {
    this.app = app;
    this.hooks = hooks;
    this.attempt = null;          // { scramble, startedAt, limitMs, draft, warned }
    this.host = null;
    this._tick = null;
    this._save = debounce(() => this._persist(), 400);
  }

  get attempting() { return !!this.attempt; }

  /* ---------------- mounting ---------------- */

  /** Build the workspace once, under the timer. */
  mount() {
    if (this.host) return this.host;

    this.startBtn = el('button', { class: 'fmc-start', type: 'button', text: t('Start attempt') });
    this.startBtn.addEventListener('click', () => this.start());
    this.idle = el('div', { class: 'fmc-idle' },
      this.startBtn,
      el('p', { class: 'fmc-hint', text: t('One solution, 60 minutes, counted in moves. The clock starts when you press it.') }),
    );

    this.clockEl = el('div', { class: 'fmc-clock', id: 'fmc-clock', text: t('60:00') });
    this.submitBtn = el('button', { class: 'ghost-btn sm', type: 'button', id: 'fmc-submit', text: t('Submit') });
    this.abandonBtn = el('button', { class: 'ghost-btn sm', type: 'button', id: 'fmc-abandon', text: t('Abandon') });
    this.submitBtn.addEventListener('click', () => this.submit());
    this.abandonBtn.addEventListener('click', () => this.abandon());

    this.solution = el('textarea', {
      class: 'fmc-box', id: 'fmc-solution', spellcheck: 'false', rows: 3,
      placeholder: t("your solution — R U R' U' …"),
      'aria-label': t('Your solution'),
    });
    this.notes = el('textarea', {
      class: 'fmc-box fmc-notes', id: 'fmc-notes', spellcheck: 'false', rows: 2,
      placeholder: t('scratch notes — never judged, kept with the solve'),
      'aria-label': t('Scratch notes'),
    });
    this.count = el('span', { class: 'fmc-count', id: 'fmc-count' });
    this.etmEl = el('span', { class: 'fmc-etm', id: 'fmc-etm' });
    this.state = el('span', { class: 'fmc-state', id: 'fmc-state' });
    this.why = el('span', { class: 'fmc-why', id: 'fmc-why' });

    for (const box of [this.solution, this.notes]) {
      box.addEventListener('input', () => { this._readout(); this._save(); });
      // Escape belongs to the box while you are in it; the app's own Escape
      // would otherwise reach through and cancel something behind it.
      box.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); box.blur(); } });
    }

    this.live = el('div', { class: 'fmc-live', hidden: true },
      el('div', { class: 'fmc-bar' }, this.clockEl,
        el('span', { class: 'fmc-acts' }, this.submitBtn, this.abandonBtn)),
      this.solution,
      el('div', { class: 'fmc-readout' }, this.count, this.etmEl, this.state, this.why),
      this.notes,
    );

    this.host = el('div', { class: 'fmc-zone', id: 'fmc-zone' }, this.idle, this.live);
    ($('#timer-core') || document.body).append(this.host);
    return this.host;
  }

  /** Show or hide the whole thing for the event we are on. */
  async sync(on) {
    document.body.classList.toggle('fmc', !!on);
    if (!on) {
      if (this.host) this.host.hidden = true;
      /* Leaving the event does not abandon the attempt — the clock is wall
         time, so it keeps running whether anyone is watching or not, and
         switching back picks it up with the right number on it. What stops
         is the tick, so a hidden attempt can never submit itself into a
         session you have since moved to. Say so, or an hour disappears
         quietly. */
      this._stopTick();
      document.body.classList.remove('fmc-attempting');
      if (this.attempt) {
        toast('Your Fewest Moves attempt is still open — switch back to finish it', { long: true });
      }
      return;
    }
    this.mount();
    this.host.hidden = false;
    if (!this.attempt) await this.restore();
    this._paint();
  }

  /* ---------------- the attempt ---------------- */

  /** Pick up an attempt left behind by a reload or a crash. */
  async restore() {
    let saved = null;
    try { saved = await KV.get(KEY, null); }
    catch { /* an unreadable draft is not worth failing a boot over */ }
    if (!saved?.scramble || !saved?.startedAt) return;

    const limitMs = saved.limitMs || TIME_LIMIT_MS;
    this.attempt = {
      scramble: saved.scramble,
      startedAt: saved.startedAt,
      limitMs,
      draft: saved.draft || { solution: '', notes: '' },
      // Anything whose moment has already gone is not called out again.
      warned: WARN_AT.filter(s => this.remaining(saved.startedAt, limitMs) <= s * 1000),
    };
    this.solution.value = this.attempt.draft.solution || '';
    this.notes.value = this.attempt.draft.notes || '';
    this.hooks.onRestore?.(this.attempt);
    toast('Picked your attempt back up', { kind: 'good' });
  }

  remaining(startedAt = this.attempt?.startedAt, limitMs = this.attempt?.limitMs) {
    if (!startedAt) return 0;
    return Math.max(0, startedAt + limitMs - Date.now());
  }

  start() {
    if (this.attempt) return;
    const scramble = this.hooks.scramble?.() || this.app.scramble?.scramble || '';
    if (!scramble) { toast('No scramble yet — one moment', { kind: 'bad' }); return; }
    this.attempt = {
      scramble,
      startedAt: Date.now(),
      limitMs: limitOf(this.app),
      draft: { solution: '', notes: '' },
      warned: [],
    };
    this.solution.value = '';
    this.notes.value = '';
    this._persist();
    this._paint();
    this.solution.focus();
  }

  /** Submit what is in the box. An unsolved solution is confirmed first. */
  async submit({ auto = false } = {}) {
    if (!this.attempt) return;
    const v = this.judge();
    if (!v.ok && !auto) {
      const why = v.error ? v.error.message
        : !v.moves ? t('the box is empty')
        : t('it does not solve the cube');
      const go = await confirmToast(`That is a DNF — ${why}. Submit anyway?`, t('submit DNF'), { timeout: 12000 });
      if (!go || !this.attempt) return;      // cancelled, or the clock ran out while asking
    }
    await this._finish(v);
  }

  async abandon() {
    if (!this.attempt) return;
    const go = await confirmToast('Abandon this attempt? It is recorded as a DNF.', 'abandon');
    if (!go || !this.attempt) return;
    await this._finish({ ok: false, moves: null });
  }

  /** What the box says right now, judged against this attempt's scramble. */
  judge() {
    const scramble = this.attempt?.scramble || this.app.scramble?.scramble || '';
    return validateFmc(scramble, this.solution?.value || '');
  }

  async _finish(v) {
    const a = this.attempt;
    this.attempt = null;
    this._stopTick();
    try { await KV.del(KEY); } catch { /* the attempt is over either way */ }

    const solution = (this.solution.value || '').trim();
    const notes = (this.notes.value || '').trim();
    this.solution.value = '';
    this.notes.value = '';
    this._paint();

    await this.hooks.record?.({
      timeMs: Math.min(a.limitMs, Math.max(0, Date.now() - a.startedAt)),
      penalty: v.ok ? 'none' : 'DNF',
      scramble: a.scramble,
      fmcMoves: v.ok ? v.moves : null,
      fmcSolution: solution,
      fmcNotes: notes,
    });
    toast(v.ok ? t('{n} moves', { n: v.moves }) : 'DNF', { kind: v.ok ? 'good' : 'bad', long: true });
  }

  /* ---------------- painting ---------------- */

  _paint() {
    if (!this.host) return;
    const live = !!this.attempt;
    this.idle.hidden = live;
    this.live.hidden = !live;
    document.body.classList.toggle('fmc-attempting', live);
    if (live) { this._readout(); this._startTick(); }
    else { this._stopTick(); this.hooks.preview?.(null); }
  }

  _readout() {
    const v = this.judge();
    const etm = v.etm ?? 0;

    this.count.textContent = v.moves === null ? '—' : t('{n} moves', { n: v.moves });
    this.count.title = t('the result is the OBTM count: a face or wide turn is 1, a rotation is 0 (WCA E2d)');

    /* Two numbers, because the WCA caps a different metric from the one it
       scores: the 80 is ETM, which counts rotations, and the result is OBTM,
       which does not. Showing only the result against 80 would tell someone
       with six rotations in their skeleton that they had room they have not
       got. */
    this.etmEl.textContent = `${etm} / ${MAX_ETM}`;
    this.etmEl.title = t('the {n}-move limit is counted in ETM, rotations included (WCA E2d1)', { n: MAX_ETM });
    this.etmEl.classList.toggle('near', etm > MAX_ETM - 10 && etm <= MAX_ETM);
    this.etmEl.classList.toggle('over', etm > MAX_ETM);

    const verdict = v.error ? '' : !v.moves ? '' : v.solved ? 'solved' : t('not solved');
    this.state.textContent = verdict;
    this.state.className = `fmc-state ${v.solved ? 'good' : verdict ? 'bad' : ''}`;
    this.why.textContent = v.error ? v.error.message : (v.warnings?.[0] || '');
    this.why.className = `fmc-why ${v.error ? 'bad' : v.warnings?.length ? 'warn' : ''}`;

    /* The preview is the scramble with whatever is in the box applied, so an
       unfinished solution is a picture of how far you have got. A solution
       that cannot be read leaves the scramble on screen rather than blanking
       the cube — the line above has already said what is wrong. */
    const scramble = this.attempt?.scramble || '';
    const spelled = v.error ? '' : (canonical(parseSolution(this.solution.value).tokens || []) || '');
    this.hooks.preview?.(`${scramble} ${spelled}`.trim());
  }

  /* ---------------- the clock ---------------- */

  _startTick() {
    this._stopTick();
    const step = () => {
      if (!this.attempt) return;
      const left = this.remaining();
      this.clockEl.textContent = clock(left);
      this.clockEl.classList.toggle('warn', left <= 5 * 60000 && left > 60000);
      this.clockEl.classList.toggle('danger', left <= 60000);

      for (const at of WARN_AT) {
        if (left <= at * 1000 && !this.attempt.warned.includes(at)) {
          this.attempt.warned.push(at);
          // The same two-tone call inspection uses, answering the same setting.
          callout(at === 60 ? 12 : 8, this.app.settings?.callouts);
          toast(at === 60 ? t('One minute left') : t('Five minutes left'), { kind: 'bad', long: true });
        }
      }
      if (left <= 0) { this._stopTick(); this._timeUp(); }
    };
    step();
    this._tick = setInterval(step, 250);
  }

  _stopTick() { clearInterval(this._tick); this._tick = null; }

  async _timeUp() {
    if (!this.attempt) return;
    const v = this.judge();
    toast(v.ok ? t('Time — your solution counts') : t('Time — DNF'), { kind: v.ok ? 'good' : 'bad', long: true });
    await this._finish(v);
  }

  _persist() {
    if (!this.attempt) return;
    this.attempt.draft = { solution: this.solution.value, notes: this.notes.value };
    KV.set(KEY, {
      scramble: this.attempt.scramble,
      startedAt: this.attempt.startedAt,
      limitMs: this.attempt.limitMs,
      draft: this.attempt.draft,
    }).catch(() => { /* a draft that will not save still shows on screen */ });
  }
}

let _fmc = null;
export function getFmc(app, hooks) {
  if (!_fmc) _fmc = new Fmc(app, hooks);
  return _fmc;
}
