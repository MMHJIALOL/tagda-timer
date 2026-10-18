import { t } from './i18n.js';
/* ===========================================================
   Tagda Timer — animated background
   A single fullscreen WebGL quad with swappable fragment shaders,
   plus image / video / gradient / solid modes.
   Draws at most 30 frames a second, at half resolution for the soft
   shaders, and stops altogether while the tab is hidden, the window is in
   the background or a solve is running.
   =========================================================== */

const VERT = `
attribute vec2 p;
void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;

const HEAD = `
precision highp float;
uniform vec2  u_res;
uniform float u_t;
uniform vec3  u_c1, u_c2, u_c3;
uniform float u_speed, u_amount, u_sat;

/* The Saturation setting, done here rather than as a CSS saturate() on the
   canvas: a CSS filter on a full-screen layer that changes every frame is a
   second full-screen pass every frame. Same luma weights as CSS saturate(). */
vec4 finish(vec4 c){
  float l = dot(c.rgb, vec3(0.213, 0.715, 0.072));
  return vec4(clamp(mix(vec3(l), c.rgb, u_sat), 0.0, 1.0), c.a);
}

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(hash(i), hash(i+vec2(1,0)), u.x),
             mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), u.x), u.y);
}
float fbm(vec2 p){
  float v = 0.0, a = 0.5;
  for(int i=0;i<5;i++){ v += a*noise(p); p *= 2.02; a *= 0.5; }
  return v;
}`;

const SHADERS = {
  aurora: `${HEAD}
void main(){
  vec2 uv = gl_FragCoord.xy / u_res.xy;
  vec2 q = uv; q.x *= u_res.x / u_res.y;
  float t = u_t * 0.06 * u_speed;
  float f1 = fbm(q * 2.2 + vec2(t, t * 0.6));
  float f2 = fbm(q * 3.1 - vec2(t * 0.8, t * 1.3) + f1);
  float band = smoothstep(0.15, 0.95, f2 + uv.y * 0.55);
  vec3 col = mix(u_c1, u_c2, band);
  col = mix(col, u_c3, smoothstep(0.55, 1.0, f1 * 1.25));
  float glow = pow(1.0 - abs(uv.y - 0.45) * 1.4, 3.0);
  col += u_c3 * glow * 0.14 * u_amount;
  gl_FragColor = vec4(col * u_amount, 1.0);
}`,

  /* Curtains, the way the real thing hangs: each one has a lower edge that
     ripples slowly along its length and is brightest right there, then thins
     out upward in vertical rays. The rays come from noise that varies along x
     only, which is what makes them read as light falling rather than smoke. */
  curtains: `${HEAD}
vec3 curtain(vec2 q, float base, float seed, float t){
  float x = q.x + 0.06 * sin(q.y * 4.0 + q.x * 1.7 + t * 0.9 + seed);
  float edge = base
    + 0.09 * sin(x * 1.1 + t * 0.55 + seed * 7.0)
    + 0.04 * sin(x * 2.9 - t * 0.8 + seed * 3.0)
    + 0.03 * (noise(vec2(x * 3.5 + seed * 11.0, t * 0.4)) - 0.5);
  float d = q.y - edge;
  float on = smoothstep(-0.015, 0.004, d);
  float body = exp(-max(d, 0.0) * 4.2) * on;
  float rays = noise(vec2(x * 34.0 + seed * 5.0, t * 0.5));
  rays = 0.25 + 0.75 * rays * rays;
  float lip = exp(-abs(d) * 55.0) * 0.55;
  vec3 hue = mix(u_c3, u_c2, smoothstep(0.0, 0.32, d));
  return hue * (body * rays + lip * on);
}
void main(){
  vec2 uv = gl_FragCoord.xy / u_res.xy;
  vec2 q = vec2(uv.x * u_res.x / u_res.y, uv.y);
  float t = u_t * 0.35 * u_speed;
  vec3 sky = u_c1 * (0.22 + 0.38 * (1.0 - uv.y));
  vec3 a = curtain(q, 0.34, 0.0, t) * 0.85
         + curtain(q, 0.50, 1.7, t * 0.8) * 0.55
         + curtain(q, 0.64, 3.9, t * 1.1) * 0.32;
  a *= smoothstep(1.02, 0.55, uv.y);
  vec3 col = sky + a * 1.25;
  col = 1.0 - exp(-col * 1.6);
  gl_FragColor = vec4(col * u_amount, 1.0);
}`,

  mesh: `${HEAD}
vec3 blob(vec2 uv, vec2 c, vec3 col, float r){
  float d = length(uv - c);
  return col * smoothstep(r, 0.0, d);
}
void main(){
  vec2 uv = gl_FragCoord.xy / u_res.xy;
  vec2 q = uv; q.x *= u_res.x / u_res.y;
  float t = u_t * 0.18 * u_speed;
  float ar = u_res.x / u_res.y;
  vec3 col = vec3(0.0);
  col += blob(q, vec2(0.30 * ar + sin(t) * 0.16,  0.32 + cos(t * 0.8) * 0.14), u_c1, 0.72);
  col += blob(q, vec2(0.72 * ar + cos(t * 0.7) * 0.18, 0.66 + sin(t * 1.1) * 0.13), u_c2, 0.68);
  col += blob(q, vec2(0.50 * ar + sin(t * 1.3) * 0.22, 0.50 + cos(t * 0.6) * 0.20), u_c3, 0.60);
  col = col / (1.0 + col);
  gl_FragColor = vec4(col * u_amount, 1.0);
}`,

  plasma: `${HEAD}
void main(){
  vec2 uv = gl_FragCoord.xy / u_res.xy;
  vec2 q = (uv - 0.5) * vec2(u_res.x / u_res.y, 1.0);
  float t = u_t * 0.25 * u_speed;
  float v = sin(q.x * 6.0 + t) + sin(q.y * 5.0 - t * 0.8)
          + sin((q.x + q.y) * 4.5 + t * 0.6)
          + sin(length(q) * 9.0 - t * 1.2);
  v *= 0.25;
  vec3 col = mix(u_c1, u_c2, smoothstep(-0.6, 0.6, v));
  col = mix(col, u_c3, smoothstep(0.35, 0.95, sin(v * 3.14159 + t)));
  gl_FragColor = vec4(col * u_amount, 1.0);
}`,

  grid: `${HEAD}
void main(){
  vec2 uv = gl_FragCoord.xy / u_res.xy;
  vec2 q = (uv - vec2(0.5, 0.42));
  q.x *= u_res.x / u_res.y;
  float t = u_t * 0.32 * u_speed;
  float persp = 1.0 / max(abs(q.y) * 3.2, 0.06);
  vec2 g = vec2(q.x * persp, persp * 0.6 + t);
  vec2 f = abs(fract(g) - 0.5);
  float line = smoothstep(0.46, 0.5, max(f.x, f.y) * -1.0 + 0.5);
  float fade = smoothstep(0.62, 0.02, abs(q.y));
  vec3 col = mix(u_c1 * 0.28, u_c2, line * fade);
  col += u_c3 * pow(max(0.0, 1.0 - abs(q.y) * 4.5), 5.0) * 0.35;
  gl_FragColor = vec4(col * u_amount, 1.0);
}`,

  stars: `${HEAD}
void main(){
  vec2 uv = gl_FragCoord.xy / u_res.xy;
  vec2 q = uv * vec2(u_res.x / u_res.y, 1.0);
  float t = u_t * 0.02 * u_speed;
  vec3 col = mix(u_c1 * 0.35, u_c2 * 0.22, uv.y);
  for(int i = 0; i < 3; i++){
    float fi = float(i);
    vec2 sp = q * (36.0 + fi * 28.0) + vec2(t * (1.0 + fi), 0.0);
    vec2 id = floor(sp);
    vec2 fr = fract(sp) - 0.5;
    float h = hash(id + fi * 41.0);
    float tw = 0.55 + 0.45 * sin(u_t * (0.8 + h * 2.2) + h * 30.0);
    float star = smoothstep(0.055, 0.0, length(fr) + (1.0 - h) * 0.06);
    col += u_c3 * star * tw * (0.5 - fi * 0.11);
  }
  col += u_c3 * fbm(q * 1.7 + t * 3.0) * 0.05;
  gl_FragColor = vec4(col * u_amount, 1.0);
}`,

  /* Aceternity's background beams: a fan of hairline curves across a dark
     field, each with a short bright pulse running along it on its own clock. */
  beams: `${HEAD}
void main(){
  vec2 uv = gl_FragCoord.xy / u_res.xy;
  float ar = u_res.x / u_res.y;
  float t = u_t * 0.12 * u_speed;
  float px = 1.0 / u_res.y;
  vec3 col = u_c1 * (0.18 + 0.22 * smoothstep(1.2, 0.0, length(uv - vec2(0.5, 0.0))));
  for(int i = 0; i < 14; i++){
    float fi = float(i);
    float h = hash(vec2(fi, 7.0));
    float y = -0.6 + fi * 0.09 + 0.55 * uv.x + 0.22 * uv.x * uv.x + 0.05 * sin(uv.x * 2.4 + fi * 1.3);
    float d = abs(uv.y - y) / px;
    float hair = exp(-d * 0.8) * 0.16;
    float head = fract(t * (0.5 + h * 0.6) + h * 3.7);
    float s = head * 1.5 - 0.25 - uv.x;
    float tail = smoothstep(-0.03, 0.0, s) * exp(-max(s, 0.0) * 5.5);
    float pulse = exp(-d * 0.28) * tail;
    col += mix(u_c2, u_c3, tail) * (hair + pulse * 1.4);
  }
  col = 1.0 - exp(-col * 1.4);
  gl_FragColor = vec4(col * u_amount, 1.0);
}`,

  /* Silk: five ribbons, each a lit edge that fades upward, drifting on two
     sines of their own. */
  waves: `${HEAD}
void main(){
  vec2 uv = gl_FragCoord.xy / u_res.xy;
  float x = uv.x * u_res.x / u_res.y;
  float t = u_t * 0.22 * u_speed;
  vec3 col = u_c1 * (0.35 + 0.25 * uv.y);
  for(int i = 0; i < 5; i++){
    float fi = float(i);
    float y = 0.16 + fi * 0.15
            + 0.07 * sin(x * (1.6 + fi * 0.35) + t * (1.0 + fi * 0.2) + fi * 1.7)
            + 0.03 * sin(x * 4.1 - t * 1.3 + fi);
    float d = uv.y - y;
    float band = smoothstep(0.0, 0.012, d) * exp(-max(d, 0.0) * 9.0);
    col = mix(col, mix(u_c2, u_c3, fi / 4.0), band * 0.55);
  }
  gl_FragColor = vec4(col * u_amount, 1.0);
}`,

  /* Soft smoke: noise warped by noise, slow enough to read as weather. */
  smoke: `${HEAD}
void main(){
  vec2 uv = gl_FragCoord.xy / u_res.xy;
  vec2 q = uv * vec2(u_res.x / u_res.y, 1.0) * 1.6;
  float t = u_t * 0.05 * u_speed;
  vec2 w = vec2(fbm(q + vec2(0.0, t)), fbm(q + vec2(5.2, 1.3) - t));
  float f = fbm(q + 2.2 * w + vec2(t * 0.7, 0.0));
  vec3 col = mix(u_c1 * 0.6, u_c2, smoothstep(0.25, 0.85, f));
  col = mix(col, u_c3, smoothstep(0.6, 1.0, f * w.x * 1.6));
  gl_FragColor = vec4(col * u_amount, 1.0);
}`,

  /* Cells: a voronoi pattern whose seeds wander, edges darkened. */
  cells: `${HEAD}
void main(){
  vec2 uv = gl_FragCoord.xy / u_res.xy;
  vec2 q = uv * vec2(u_res.x / u_res.y, 1.0) * 5.0;
  float t = u_t * 0.3 * u_speed;
  vec2 i = floor(q), f = fract(q);
  float d1 = 8.0, d2 = 8.0, id = 0.0;
  for(int y = -1; y <= 1; y++){
    for(int x = -1; x <= 1; x++){
      vec2 g = vec2(float(x), float(y));
      vec2 o = vec2(hash(i + g), hash(i + g + 17.3));
      o = 0.5 + 0.42 * sin(t + 6.2831 * o);
      float d = length(g + o - f);
      if(d < d1){ d2 = d1; d1 = d; id = hash(i + g); } else if(d < d2){ d2 = d; }
    }
  }
  float edge = smoothstep(0.0, 0.08, d2 - d1);
  vec3 col = mix(u_c1, mix(u_c2, u_c3, id), 0.35 + 0.35 * (1.0 - d1));
  col *= 0.55 + 0.45 * edge;
  col += u_c3 * (1.0 - edge) * 0.25;
  gl_FragColor = vec4(col * u_amount, 1.0);
}`,
};

export const SHADER_NAMES = Object.keys(SHADERS);

/* Shaders with nothing sharp in them: drawn at half resolution and stretched,
   which the eye cannot tell apart and the GPU does in a quarter of the work.
   beams, grid, stars and waves have hairlines and points, so they stay at
   full size. */
const SOFT = new Set(['aurora', 'curtains', 'mesh', 'plasma', 'smoke', 'cells']);

/* Nothing in any shader moves fast enough to need more. Without a cap the
   loop ran at the monitor's refresh rate — 144 full-screen passes a second
   on a 144 Hz screen. */
const MAX_FPS = 30;

/* How long a lost WebGL context gets to come back by itself before the canvas
   is swapped for a fresh one. Zen once lost its context and never restored it:
   the background stayed black until the browser was restarted. */
const RESTORE_WAIT_MS = 1500;

function hexToRgb(hex) {
  const h = (hex || '#000').replace('#', '');
  const s = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const n = parseInt(s.slice(0, 6), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/**
 * Whether WebGL here would be drawn by the CPU: hardware acceleration switched
 * off, or a software driver. Then a full-screen shader every frame (and every
 * glass blur over it) is the whole machine's worth of work — Opera and Brave
 * with acceleration off lagged the timer itself.
 */
export function softwareGL() {
  try {
    const gl = document.createElement('canvas').getContext('webgl', { failIfMajorPerformanceCaveat: true });
    if (!gl) return true;
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const name = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /swiftshader|llvmpipe|softpipe|software|basic render/i.test(name);
  } catch { return true; }
}

export class Background {
  constructor(canvas, mediaEl) {
    this.canvas = canvas;
    this._onLost = (e) => this._lost(e);
    this._onRestored = () => this._restored();
    this._watch(canvas);
    this._restoreTimer = null;
    this.mediaEl = mediaEl;
    this.gl = null;
    this.shader = 'aurora';
    this.speed = 1;
    this.amount = 1;
    this.colors = ['#241a4d', '#7c5cff', '#35e6c5'];
    this.paused = false;
    this.slow = 1;
    this.sat = 1;
    this._sat = 1;                // what is drawn; eases toward the target
    this._focus = false;
    this._t = 0;
    this._last = 0;
    this._drawn = 0;
    this._minStep = 1000 / MAX_FPS;
    this._raf = null;
    this._holds = new Set();      // reasons to stand still: 'hidden', 'blur', 'solve'
    this.mode = 'shader';
    this.lite = false;            // one still frame instead of an animation — see softwareGL()

    document.addEventListener('visibilitychange', () => this.hold('hidden', document.hidden));
    // A timer left open on one screen while you work on another was animating
    // at full tilt behind everything else.
    window.addEventListener('blur', () => this.hold('blur', true));
    window.addEventListener('focus', () => this.hold('blur', false));
    if (document.hidden) this._holds.add('hidden');
    if (!document.hasFocus()) this._holds.add('blur');
    window.addEventListener('resize', () => this.resize());
  }

  /* ---------------- gl setup ---------------- */

  init() {
    if (this.gl) return true;
    const gl = this.canvas.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'low-power' });
    // Lost and not back yet: _restored() or _replaceCanvas() will init again.
    if (!gl || gl.isContextLost()) return false;
    this.gl = gl;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
    this._buf = buf;
    this._compile(this.shader);
    this.resize();
    return true;
  }

  /* ---------------- context loss ----------------
     A GPU reset, a driver update, sleep, or the browser running out of WebGL
     contexts takes the context away and leaves the canvas black. Without a
     preventDefault() on the loss the browser never gives it back, and nothing
     here would ask again: the background stayed black until a restart. */

  _watch(canvas) {
    canvas.addEventListener('webglcontextlost', this._onLost);
    canvas.addEventListener('webglcontextrestored', this._onRestored);
  }

  _lost(e) {
    e.preventDefault();             // without this the context is never restored
    this.stop();
    this.gl = null; this._prog = null; this._buf = null;
    clearTimeout(this._restoreTimer);
    // Some browsers never send webglcontextrestored. A new canvas gets a new
    // context, so swap one in rather than wait for ever.
    this._restoreTimer = setTimeout(() => this._replaceCanvas(), RESTORE_WAIT_MS);
  }

  _restored() {
    clearTimeout(this._restoreTimer);
    this._restoreTimer = null;
    this._reinit();
  }

  _replaceCanvas() {
    this._restoreTimer = null;
    const old = this.canvas;
    const fresh = old.cloneNode(false);  // same id, class and hidden state
    old.removeEventListener('webglcontextlost', this._onLost);
    old.removeEventListener('webglcontextrestored', this._onRestored);
    this._watch(fresh);
    old.replaceWith(fresh);
    this.canvas = fresh;
    this._reinit();
  }

  /** Everything init() set up lived on the old context: build it again. */
  _reinit() {
    this.gl = null; this._prog = null; this._buf = null;
    if (this.mode !== 'shader') return;   // setMode('shader') will init it
    this.init();
    this.start();
  }

  _compile(name) {
    const gl = this.gl;
    if (!gl) return;
    const src = SHADERS[name] || SHADERS.aurora;
    const mk = (type, code) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, code); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.warn('[bg] shader error:', gl.getShaderInfoLog(s));
        return null;
      }
      return s;
    };
    const vs = mk(gl.VERTEX_SHADER, VERT);
    const fs = mk(gl.FRAGMENT_SHADER, src.replace(/gl_FragColor\s*=\s*([^;]+);/g, 'gl_FragColor = finish($1);'));
    if (!vs || !fs) return;
    const prog = gl.createProgram();
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (this._prog) gl.deleteProgram(this._prog);
    this._prog = prog;
    gl.useProgram(prog);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.bindBuffer(gl.ARRAY_BUFFER, this._buf);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.u = {
      sat:    gl.getUniformLocation(prog, 'u_sat'),
      res:    gl.getUniformLocation(prog, 'u_res'),
      t:      gl.getUniformLocation(prog, 'u_t'),
      c1:     gl.getUniformLocation(prog, 'u_c1'),
      c2:     gl.getUniformLocation(prog, 'u_c2'),
      c3:     gl.getUniformLocation(prog, 'u_c3'),
      speed:  gl.getUniformLocation(prog, 'u_speed'),
      amount: gl.getUniformLocation(prog, 'u_amount'),
    };
  }

  resize() {
    if (!this.gl) return;
    const dpr = SOFT.has(this.shader) ? 0.5 : Math.min(window.devicePixelRatio || 1, 1);
    const w = Math.floor(this.canvas.clientWidth * dpr);
    const h = Math.floor(this.canvas.clientHeight * dpr);
    if (w === 0 || h === 0) return;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
    }
    this.gl.viewport(0, 0, w, h);
    this._still();
  }

  /* ---------------- config ---------------- */

  setShader(name) {
    const resized = SOFT.has(name) !== SOFT.has(this.shader);
    this.shader = name;
    if (this.gl) this._compile(name);
    if (resized) this.resize(); else this._still();
  }

  /** The Saturation setting (1 = as drawn). */
  setSat(v) {
    this.sat = v;
    if (!this._focus) this._sat = this._target();
    this._still();
  }

  /** Focus mode drains the colour out while an attempt is on. */
  setFocus(on) {
    if (on === this._focus) return;
    this._focus = on;
    // Eased in the loop when it is running; set outright when it is not.
    if (!this._raf) { this._sat = this._target(); this._still(); }
  }

  _target() { return this._focus ? 0.25 : (this.lite ? 1 : this.sat); }

  /**
   * Stand still for a reason, or stop standing still for it. The last frame
   * stays on the canvas, so stopping costs nothing to look at.
   */
  hold(reason, on) {
    if (on) this._holds.add(reason); else this._holds.delete(reason);
    if (this._holds.size) {
      // A solve lets the colour finish draining first; the loop stops itself.
      if (reason !== 'solve' || !on) this.stop();
    } else if (this.mode === 'shader') this.start();
  }

  setColors(c1, c2, c3) { this.colors = [c1, c2, c3]; this._still(); }

  /** Reduce effects: draw one frame and stop, or go back to animating. */
  setLite(on) {
    this.lite = on;
    this._sat = this._target();
    this.stop();
    this.start();
  }

  /** When nothing is redrawing on its own, a change has to. */
  _still() { if (!this._raf && this.mode === 'shader' && this.gl) this.draw(); }

  /** 1 = normal, <1 = calmed down (used during a solve). */
  setSlow(v) { this.slow = v; }

  setMode(mode) {
    this.mode = mode;
    const shaderMode = mode === 'shader';
    this.canvas.hidden = !shaderMode;
    this.mediaEl.hidden = shaderMode;
    if (shaderMode) { this.init(); this.start(); } else { this.stop(); }
  }

  /** mode: 'image' | 'video' | 'gradient' | 'solid' */
  setMedia(css, videoUrl = null) {
    this.mediaEl.innerHTML = '';
    this.mediaEl.style.background = css || '';
    if (videoUrl) {
      const v = document.createElement('video');
      v.src = videoUrl; v.loop = true; v.muted = true; v.playsInline = true; v.autoplay = true;
      v.play().catch(() => {});
      this.mediaEl.append(v);
    }
  }

  /* ---------------- loop ---------------- */

  /**
   * Draw at most `fps` frames a second; 0 puts it back to the usual cap.
   *
   * A full-screen fragment shader is the most expensive thing on the page, and
   * during a celebration it is also the least important — the confetti is what
   * you are looking at. Throttled rather than stopped, so the canvas is still
   * being drawn into and the shader keeps its own clock: nothing jumps when it
   * comes back up to speed.
   */
  throttle(fps) { this._minStep = 1000 / (fps || MAX_FPS); }

  start() {
    if (this._raf || this.mode !== 'shader') return;
    if (!this.init()) return;
    if (this.lite || this._holds.size) { this.draw(); return; }
    this._last = performance.now();
    const step = (now) => {
      const dt = Math.min(0.05, (now - this._last) / 1000);
      this._last = now;
      if (!this.paused) this._t += dt * this.slow;
      const target = this._target();
      this._sat += (target - this._sat) * Math.min(1, dt * 12);
      // Within a frame's step of 1 ms, so the rAF and the draw throttle agree.
      if (now - this._drawn >= this._minStep - 1) {
        this._drawn = now;
        this.draw();
      }
      // Held for a solve: carry on only until the colour has finished easing.
      if (this._holds.size && Math.abs(target - this._sat) < 0.01) {
        this._sat = target;
        this.draw();
        this._raf = null;
        return;
      }
      this._raf = requestAnimationFrame(step);
    };
    this._raf = requestAnimationFrame(step);
  }

  stop() { cancelAnimationFrame(this._raf); this._raf = null; }

  draw() {
    const gl = this.gl; if (!gl || !this._prog) return;
    gl.useProgram(this._prog);
    gl.uniform2f(this.u.res, this.canvas.width, this.canvas.height);
    gl.uniform1f(this.u.t, this._t);
    gl.uniform3fv(this.u.c1, hexToRgb(this.colors[0]));
    gl.uniform3fv(this.u.c2, hexToRgb(this.colors[1]));
    gl.uniform3fv(this.u.c3, hexToRgb(this.colors[2]));
    gl.uniform1f(this.u.speed, this.speed);
    gl.uniform1f(this.u.amount, this.amount);
    gl.uniform1f(this.u.sat, this._sat);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
