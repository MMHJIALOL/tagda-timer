/* ===========================================================
   Tagda Timer — timer state machine + WCA inspection

   Timing is taken from performance.now() timestamps, never from an
   accumulated frame count, so animation jank can never change a
   recorded time.

   States: idle -> [inspecting] -> holding -> ready -> running -> idle
   =========================================================== */

export const INSPECT_MS   = 15000;
export const PLUS2_MS     = 15000;   // past this -> +2
export const DNF_MS       = 17000;   // past this -> DNF
export const WARN_1_MS    = 8000;    // "8 seconds"
export const WARN_2_MS    = 12000;   // "12 seconds"

export class Timer extends EventTarget {
  constructor(cfg = {}) {
    super();
    this.cfg = {
      inspection: true,
      holdTime: 0,            // ms to hold before "ready"; 0 = armed on contact
      useInspection: true,
      minSolveMs: 500,        // below this, ask instead of recording
      precision: 2,           // decimal places shown while running
      hideWhileRunning: false,
      ...cfg,
    };
    this.state = 'idle';
    this._ignoreUp = false;
    this._holdTimer = null;
    this._raf = null;
    this._warned = { w1: false, w2: false };
    this.inspectStart = 0;
    this.solveStart = 0;
    this.elapsed = 0;
    this.inspectElapsed = 0;
  }

  /* ---------------- helpers ---------------- */

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  _setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.emit('state', { state: s });
  }

  get inspectionEnabled() {
    return this.cfg.inspection && this.cfg.useInspection;
  }

  /* ---------------- input ---------------- */

  down() {
    switch (this.state) {
      case 'running':
        this._stop();
        break;

      case 'idle':
        if (this.inspectionEnabled) {
          this._startInspection();
          this._ignoreUp = true;
        } else {
          this._beginHold();
        }
        break;

      case 'inspecting':
        this._beginHold();
        break;

      default:
        break;
    }
  }

  up() {
    if (this._ignoreUp) { this._ignoreUp = false; return; }

    switch (this.state) {
      case 'cooldown':
        this._setState('idle');
        break;

      case 'holding':
        // released too early — go back where we came from
        clearTimeout(this._holdTimer);
        this._setState(this._returnTo || 'idle');
        break;

      case 'ready':
        this._start();
        break;

      default:
        break;
    }
  }

  /** Escape / right-click — abandon inspection or a pending hold. */
  cancel() {
    if (this.state === 'running') return false;
    clearTimeout(this._holdTimer);
    cancelAnimationFrame(this._raf);
    this._ignoreUp = false;
    this.inspectStart = 0;
    this.inspectElapsed = 0;
    this._warned = { w1: false, w2: false };
    this._setState('idle');
    this.emit('cancel');
    return true;
  }

  /* ---------------- inspection ---------------- */

  _startInspection() {
    this.inspectStart = performance.now();
    this.inspectElapsed = 0;
    this._warned = { w1: false, w2: false };
    this._setState('inspecting');
    this.emit('inspectstart');
    this._loop();
  }

  _inspectionPenalty(atMs) {
    if (atMs > DNF_MS) return 'DNF';
    if (atMs > PLUS2_MS) return '+2';
    return 'none';
  }

  /* ---------------- hold / arm ---------------- */

  _beginHold() {
    this._returnTo = this.state;
    this._setState('holding');
    clearTimeout(this._holdTimer);
    const wait = Math.max(0, this.cfg.holdTime);
    // A hold time of zero still arms and still starts on the release — it just
    // arms the instant your finger lands instead of making you wait for it.
    if (wait === 0) this._setState('ready');
    else this._holdTimer = setTimeout(() => {
      if (this.state === 'holding') this._setState('ready');
    }, wait);
  }

  /* ---------------- run ---------------- */

  _start() {
    // Read the clock directly rather than trusting the animation-frame value:
    // a throttled or dropped frame must never change which penalty you get.
    if (this.inspectionEnabled && this.inspectStart) {
      this.inspectElapsed = performance.now() - this.inspectStart;
      this.pendingPenalty = this._inspectionPenalty(this.inspectElapsed);
    } else {
      this.inspectElapsed = 0;
      this.pendingPenalty = 'none';
    }
    this.inspectStart = 0;
    this.solveStart = performance.now();
    this.elapsed = 0;
    this._setState('running');
    this.emit('start', { penalty: this.pendingPenalty });
    this._loop();
  }

  _stop() {
    const end = performance.now();
    cancelAnimationFrame(this._raf);
    this.elapsed = end - this.solveStart;
    this._setState('cooldown');

    const result = {
      timeMs: Math.round(this.elapsed),
      penalty: this.pendingPenalty || 'none',
      inspectionMs: Math.round(this.inspectElapsed),
      suspicious: this.elapsed < this.cfg.minSolveMs,
    };
    this.inspectElapsed = 0;
    this.emit('stop', result);
  }

  /* ---------------- frame loop ---------------- */

  _loop() {
    cancelAnimationFrame(this._raf);
    const step = () => {
      const now = performance.now();

      if (this.state === 'inspecting' || this.state === 'holding' || this.state === 'ready') {
        if (this.inspectStart && this.inspectionEnabled && this.state !== 'idle') {
          this.inspectElapsed = now - this.inspectStart;
          const e = this.inspectElapsed;
          if (!this._warned.w1 && e >= WARN_1_MS) { this._warned.w1 = true; this.emit('warn', { at: 8 }); }
          if (!this._warned.w2 && e >= WARN_2_MS) { this._warned.w2 = true; this.emit('warn', { at: 12 }); }
          this.emit('inspecttick', {
            elapsed: e,
            remaining: Math.max(0, INSPECT_MS - e),
            penalty: this._inspectionPenalty(e),
          });
          this._raf = requestAnimationFrame(step);
        }
        return;
      }

      if (this.state === 'running') {
        this.elapsed = now - this.solveStart;
        this.emit('tick', { elapsed: this.elapsed });
        this._raf = requestAnimationFrame(step);
      }
    };
    this._raf = requestAnimationFrame(step);
  }

  /** Hard reset (used when switching event/session mid-inspection). */
  reset() {
    clearTimeout(this._holdTimer);
    cancelAnimationFrame(this._raf);
    this._ignoreUp = false;
    this.inspectStart = 0;
    this.inspectElapsed = 0;
    this.elapsed = 0;
    this._setState('idle');
  }
}
