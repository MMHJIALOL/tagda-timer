/* ===========================================================
   Tagda Timer — static scramble preview

   Shows the cube exactly as it will look after the scramble.
   Deliberately static: no move-by-move playback, because you are
   going to execute the scramble faster than any animation could.
   =========================================================== */

// Local copy first (works offline), CDN as backup.
const SOURCES = [
  new URL('../vendor/cubing/cubing/twisty.js', import.meta.url).href,
  'https://cdn.cubing.net/v0/js/cubing/twisty',
];

let loaded = null;
let failed = false;

async function loadTwisty() {
  if (loaded) return true;
  if (failed) return false;
  for (const src of SOURCES) {
    try {
      await import(/* @vite-ignore */ src);
      loaded = true;
      return true;
    } catch (err) {
      console.warn('[cube] could not load', src, err.message);
    }
  }
  failed = true;
  return false;
}

/** Colour scheme is applied through twisty's experimental sticker colours. */
const DEFAULT_SCHEME = { U: '#ffffff', D: '#ffe100', F: '#00b04a', B: '#0051ba', R: '#ec0000', L: '#ff8b00' };

export class CubeView {
  constructor(host, fallbackEl) {
    this.host = host;
    this.fallbackEl = fallbackEl;
    this.player = null;
    this.puzzle = '3x3x3';
    this.visualization = '3D';
    this.scheme = { ...DEFAULT_SCHEME };
    this.pending = null;
    this.ready = false;
    this.orbit = null;          // set before init() to restore a saved angle
  }

  async init() {
    const ok = await loadTwisty();
    // twisty-player renders into a *closed* shadow root, so there is no way to
    // inspect its innards from out here — every "did it paint?" watchdog we
    // could write reports a false negative and tears down a working preview.
    // The only honest failure signal is the module not loading or the custom
    // element never being defined, so that is the only thing we check.
    if (!ok || !customElements.get('twisty-player')) {
      this.showFallback('preview unavailable');
      return false;
    }
    this.player = document.createElement('twisty-player');
    this.player.setAttribute('puzzle', this.puzzle);
    this.player.setAttribute('alg', '');
    this.player.setAttribute('control-panel', 'none');
    this.player.setAttribute('background', 'none');
    this.player.setAttribute('hint-facelets', 'floating');
    this.player.setAttribute('back-view', 'top-right');
    this.player.setAttribute('visualization', '3D');
    this.player.setAttribute('tempo-scale', '0');
    if (this.orbit) this.setOrbit(this.orbit);
    this.host.append(this.player);
    this.hideFallback();
    this.ready = true;
    if (this.pending) { const p = this.pending; this.pending = null; this.set(p.scramble, p.opts); }
    return true;
  }

  showFallback(message) {
    if (!this.fallbackEl) return;
    const span = this.fallbackEl.querySelector('span');
    if (span && message) span.textContent = message;
    this.fallbackEl.hidden = false;
  }

  hideFallback() {
    if (this.fallbackEl) this.fallbackEl.hidden = true;
  }

  /**
   * Swap puzzle and view style.
   * The setup alg is written in the notation of whatever puzzle is loaded, so
   * a leftover 3x3 scramble makes the new puzzle throw while parsing and the
   * preview silently freezes on the old cube. Clearing it first is what makes
   * every event work, not just 3x3.
   */
  configure(puzzle, view = '3D') {
    // Compare before assigning — writing this.puzzle first made the check below
    // always false, so the player kept whatever puzzle it was born with.
    const changed = puzzle !== this.puzzle;
    this.puzzle = puzzle;               // remembered even without a live player
    if (!this.player) return;
    if (changed) {
      try { this.player.setAttribute('experimental-setup-alg', ''); } catch { /* ignore */ }
      this.player.setAttribute('puzzle', puzzle);
      this.applied = null;               // force the next set() through
    }
    this.setView(view);
  }

  /** Only 3x3 has a last-layer view, and only cubes have a usable flat net. */
  supports(view) {
    const cube = /^([234567])x\1x\1$/.test(this.puzzle);
    if (view === 'LL' || view === 'LL3') return this.puzzle === '3x3x3';
    if (view === '2D') return cube;
    return true;
  }

  setView(view) {
    if (!this.player) return;
    const use = this.supports(view) ? view : '3D';
    this.visualization = use;
    const vis = use === '2D' ? '2D'
              : use === 'LL' ? 'experimental-2D-LL'
              : use === 'LL3' ? 'PG3D'
              : '3D';
    try { this.player.setAttribute('visualization', vis); }
    catch { this.player.setAttribute('visualization', '3D'); }
    this.player.setAttribute('back-view', use === '3D' ? 'top-right' : 'none');
  }

  /** Show the state produced by `scramble`. Instant — no animation. */
  set(scramble, opts = {}) {
    if (!this.ready) { this.pending = { scramble, opts }; return; }
    if (!this.player) return;
    if (opts.view) this.setView(opts.view);

    // Multi-blind hands over several numbered scrambles; preview the first.
    const clean = (scramble || '').replace(/^\s*\d+\)\s*/gm, '').split('\n')[0].trim();
    if (clean === this.applied) return;

    const apply = () => {
      try {
        this.player.setAttribute('experimental-setup-alg', clean);
        this.player.setAttribute('alg', '');
        this.applied = clean;
        return true;
      } catch (err) {
        console.warn('[cube] could not render scramble for', this.puzzle, err);
        return false;
      }
    };

    // A just-swapped puzzle may not have finished loading, in which case the
    // alg fails to parse. Retry once the puzzle is actually in place.
    if (!apply()) return;
    this.player.experimentalModel?.puzzleLoader?.get?.()
      .then(() => { if (this.applied === clean) apply(); })
      .catch(() => {});
  }

  setScheme(scheme) {
    this.scheme = { ...this.scheme, ...scheme };
    if (!this.player) return;
    try { this.player.style.setProperty('--cube-U', this.scheme.U); }
    catch { /* ignore */ }
  }

  setHints(on) {
    if (this.player) this.player.setAttribute('hint-facelets', on ? 'floating' : 'none');
  }

  /* ---------------- camera angle ----------------
     Spinning the cube to check the back is only useful if it stays put. The
     player exposes the orbit as camera-* attributes going in and through
     twistySceneModel.orbitCoordinates coming out. */

  /** Point the camera at a saved {latitude, longitude, distance}. */
  setOrbit(orbit) {
    if (!this.player || !orbit) return;
    const { latitude, longitude, distance } = orbit;
    try {
      if (Number.isFinite(latitude))  this.player.setAttribute('camera-latitude', String(latitude));
      if (Number.isFinite(longitude)) this.player.setAttribute('camera-longitude', String(longitude));
      if (Number.isFinite(distance))  this.player.setAttribute('camera-distance', String(distance));
    } catch { /* older builds may not accept all three */ }
  }

  /** Where the camera is now, or null if the player cannot say. */
  async getOrbit() {
    try {
      const c = await this.player?.experimentalModel?.twistySceneModel?.orbitCoordinates?.get?.();
      if (!c || !Number.isFinite(c.latitude)) return null;
      return { latitude: c.latitude, longitude: c.longitude, distance: c.distance };
    } catch {
      return null;
    }
  }

  /** Back to the puzzle's default three-quarter view. */
  clearOrbit() {
    if (!this.player) return;
    for (const a of ['camera-latitude', 'camera-longitude', 'camera-distance']) {
      this.player.removeAttribute(a);
    }
  }
}
