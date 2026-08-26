/* ===========================================================
   Tagda Timer — animated background
   A single fullscreen WebGL quad with swappable fragment shaders,
   plus image / video / gradient / solid modes.
   Pauses when the tab is hidden and while a solve is running.
   =========================================================== */

const VERT = `
attribute vec2 p;
void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;

const HEAD = `
precision highp float;
uniform vec2  u_res;
uniform float u_t;
uniform vec3  u_c1, u_c2, u_c3;
uniform float u_speed, u_amount;

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
};

export const SHADER_NAMES = Object.keys(SHADERS);

function hexToRgb(hex) {
  const h = (hex || '#000').replace('#', '');
  const s = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const n = parseInt(s.slice(0, 6), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export class Background {
  constructor(canvas, mediaEl) {
    this.canvas = canvas;
    this.mediaEl = mediaEl;
    this.gl = null;
    this.shader = 'aurora';
    this.speed = 1;
    this.amount = 1;
    this.colors = ['#241a4d', '#7c5cff', '#35e6c5'];
    this.paused = false;
    this.slow = 1;
    this._t = 0;
    this._last = 0;
    this._raf = null;
    this.mode = 'shader';

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.stop(); else if (this.mode === 'shader') this.start();
    });
    window.addEventListener('resize', () => this.resize());
  }

  /* ---------------- gl setup ---------------- */

  init() {
    if (this.gl) return true;
    const gl = this.canvas.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'low-power' });
    if (!gl) return false;
    this.gl = gl;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
    this._buf = buf;
    this._compile(this.shader);
    this.resize();
    return true;
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
    const fs = mk(gl.FRAGMENT_SHADER, src);
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
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const w = Math.floor(this.canvas.clientWidth * dpr);
    const h = Math.floor(this.canvas.clientHeight * dpr);
    if (w === 0 || h === 0) return;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
    }
    this.gl.viewport(0, 0, w, h);
  }

  /* ---------------- config ---------------- */

  setShader(name) {
    this.shader = name;
    if (this.gl) this._compile(name);
  }

  setColors(c1, c2, c3) { this.colors = [c1, c2, c3]; }

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

  start() {
    if (this._raf || this.mode !== 'shader') return;
    if (!this.init()) return;
    this._last = performance.now();
    const step = (now) => {
      const dt = Math.min(0.05, (now - this._last) / 1000);
      this._last = now;
      if (!this.paused) this._t += dt * this.slow;
      this.draw();
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
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
