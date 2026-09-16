/* ===========================================================
   Scramble of the Day — the intro
   ===========================================================

   A hand port of the Claude Design composition "Scramble of the Day
   Intro". That piece was authored as React on a canvas runtime; this is
   the same three seconds of motion expressed as plain DOM, because the
   site has neither React nor the runtime and a three second title card
   is not worth acquiring either.

   The numbers below — the cue times, the easing curves, the 230px cube,
   the -28/34 degree resting angle, the elastic trophy, every colour —
   are copied across unchanged. The design is settled. If something here
   looks like an arbitrary constant it is because it is one, chosen by
   eye in the editor, and it should be left alone.

   Every per frame write is transform, opacity or background: no reads,
   no layout, one composited layer. The 54 cube tiles change colour nine
   times a second rather than sixty, so they are only written when the
   colour actually differs from the one already on the node.

   Whether it plays at all is the caller's question, not this module's:
   openSotd() holds it back once today's scramble is done. All this
   knows is that somebody who asked the browser for less motion never
   wanted it, and that any key or tap ends it early. ---------------- */

const DUR = 3.0;
const CUES = { Charge: 0, Scramble: 0.7, Lock: 1.8, Reveal: 2.4 };
/* The 'chill' tweak the design shipped with: one full turn, half shake. */
const ENERGY_MUL = 0.5;

const FACE_COLOR = {
  top: '#f4f4f4', bottom: '#ffd500', front: '#00a651',
  back: '#1e6fd9', right: '#c41e3a', left: '#ff5800',
};
const PALETTE = ['#f4f4f4', '#ffd500', '#00a651', '#1e6fd9', '#c41e3a', '#ff5800'];
const TOKENS = ["R", "U'", "F2", "L", "D'", "B", "R2", "U", "F'", "L2", "D", "B'"];
const GOLD = '#ffd166', ACCENT = '#7c5cff', TEXT = '#ececf5', TEXT_DIM = '#9a8cd6';
const SUBTITLE = 'One scramble. One shot.';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (from, to, ease) => (p) => from + (to - from) * ease(p);

const E = {
  linear: (x) => x,
  outQuad: (x) => 1 - (1 - x) * (1 - x),
  inQuad: (x) => x * x,
  inOutCubic: (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
  outBack: (x) => {
    const c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
  },
  outElastic: (x) =>
    x === 0 ? 0 : x === 1 ? 1
      : Math.pow(2, -10 * x) * Math.sin((x * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1,
};

/* Deliberately not a real cube simulation. The colours churn on a hash
   of the tile index for the 1.1s the thing is spinning too fast to read,
   and freeze wherever they happen to be when the lock lands. */
function tileColor(seed, solved, T) {
  if (T < CUES.Scramble) return solved;
  const t = T < CUES.Lock ? T : CUES.Lock;
  return PALETTE[Math.floor(t * 9 + seed * 3.7) % PALETTE.length];
}

const mk = (tag, style, parent) => {
  const n = document.createElement(tag);
  if (style) Object.assign(n.style, style);
  if (parent) parent.appendChild(n);
  return n;
};

const STREAK_ROWS = [
  { y: 300, delay: 0, speed: 1 },
  { y: 470, delay: 0.15, speed: 1.3 },
  { y: 650, delay: 0.3, speed: 0.9 },
  { y: 790, delay: 0.45, speed: 1.15 },
];

function trophy(parent) {
  const wrap = mk('div', { position: 'relative', width: '148px', height: '150px' }, parent);
  mk('div', {
    position: 'absolute', left: '50%', top: '0', transform: 'translateX(-50%)',
    width: '92px', height: '78px', borderRadius: '0 0 46px 46px',
    background: `linear-gradient(160deg, #ffe6a3, ${GOLD} 55%, #b3821f)`,
    boxShadow: 'inset 0 -10px 18px rgba(0,0,0,.25), 0 14px 30px -10px rgba(255,209,102,.5)',
  }, wrap);
  for (const side of [-1, 1]) {
    mk('div', {
      position: 'absolute', top: '10px',
      left: side < 0 ? '-18px' : '', right: side > 0 ? '-18px' : '',
      width: '26px', height: '34px', borderRadius: '16px',
      border: `7px solid ${GOLD}`,
      borderRightColor: side < 0 ? 'transparent' : GOLD,
      borderLeftColor: side > 0 ? 'transparent' : GOLD,
      boxSizing: 'border-box',
    }, wrap);
  }
  mk('div', {
    position: 'absolute', left: '50%', top: '74px', transform: 'translateX(-50%)',
    width: '20px', height: '30px', background: `linear-gradient(180deg, ${GOLD}, #b3821f)`,
  }, wrap);
  mk('div', {
    position: 'absolute', left: '50%', bottom: '0', transform: 'translateX(-50%)',
    width: '78px', height: '16px', borderRadius: '5px',
    background: 'linear-gradient(180deg, #ffe6a3, #b3821f)',
    boxShadow: '0 6px 16px -6px rgba(0,0,0,.5)',
  }, wrap);
  return wrap;
}

/* Builds the whole scene once and hands back the one function that
   moves it. Nothing is created or destroyed per frame. */
function build(root) {
  const stage = mk('div', {
    position: 'absolute', left: '50%', top: '50%',
    width: '1080px', height: '1080px',
    transform: 'translate(-50%,-50%) scale(var(--sotd-intro-scale))',
    transformOrigin: '50% 50%',
    background: 'radial-gradient(circle at 50% 38%, #171335, #07070c 68%)',
    overflow: 'hidden',
    fontFamily: "var(--font-ui, 'Inter', system-ui, sans-serif)",
  }, root);

  /* ---- cube ---- */
  const cubeOuter = mk('div', { position: 'absolute', inset: '0' }, stage);
  const persp = mk('div', { position: 'absolute', inset: '0', perspective: '900px' }, cubeOuter);
  const view = mk('div', {
    position: 'absolute', left: '50%', top: '50%', width: '0', height: '0',
    transformStyle: 'preserve-3d',
  }, persp);

  const size = 230, half = size / 2;
  /* All six faces exist, so the cube is a closed solid and can take a
     continuous rotation on both axes without ever showing a gap. */
  const faces = [
    { color: FACE_COLOR.front, seedBase: 0, base: `translateZ(${half}px)` },
    { color: FACE_COLOR.back, seedBase: 9, base: `rotateY(180deg) translateZ(${half}px)` },
    { color: FACE_COLOR.right, seedBase: 18, base: `rotateY(90deg) translateZ(${half}px)` },
    { color: FACE_COLOR.left, seedBase: 27, base: `rotateY(-90deg) translateZ(${half}px)` },
    { color: FACE_COLOR.top, seedBase: 36, base: `rotateX(90deg) translateZ(${half}px)` },
    { color: FACE_COLOR.bottom, seedBase: 45, base: `rotateX(-90deg) translateZ(${half}px)` },
  ];
  const faceNodes = [], tiles = [];
  for (const f of faces) {
    const holder = mk('div', {
      position: 'absolute', left: '0', top: '0', width: '0', height: '0',
      transformStyle: 'preserve-3d', transform: f.base,
    }, view);
    const face = mk('div', {
      position: 'absolute', top: `${-half}px`, left: `${-half}px`,
      width: `${size}px`, height: `${size}px`,
      display: 'grid',
      gridTemplateColumns: 'repeat(3,1fr)', gridTemplateRows: 'repeat(3,1fr)',
      gap: `${size * 0.045}px`, padding: `${size * 0.045}px`,
      background: '#0b0b10', borderRadius: `${size * 0.06}px`,
      backfaceVisibility: 'hidden', boxSizing: 'border-box',
    }, holder);
    faceNodes.push(face);
    for (let i = 0; i < 9; i++) {
      const node = mk('div', {
        borderRadius: `${size * 0.05}px`, background: f.color,
        boxShadow: 'inset 0 0 0 2px rgba(0,0,0,.4)',
      }, face);
      tiles.push({ node, seed: f.seedBase + i, solved: f.color, last: f.color });
    }
  }

  /* ---- notation flickering around the cube, before the spin ---- */
  const glitchWrap = mk('div', { position: 'absolute', inset: '0' }, stage);
  const glitchNodes = [];
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * Math.PI * 2 + 0.4, r = 235;
    glitchNodes.push(mk('div', {
      position: 'absolute',
      left: `${540 + Math.cos(angle) * r}px`,
      top: `${500 + Math.sin(angle) * r * 0.72}px`,
      transform: 'translate(-50%,-50%)',
      fontFamily: "var(--font-mono, 'JetBrains Mono', monospace)",
      fontWeight: '700', fontSize: '26px', color: ACCENT, letterSpacing: '0.03em',
    }, glitchWrap));
  }

  /* ---- moves streaking past while it spins ---- */
  const streakWrap = mk('div', { position: 'absolute', inset: '0', overflow: 'hidden' }, stage);
  const streakNodes = STREAK_ROWS.map((row, i) => {
    const n = mk('div', {
      position: 'absolute', top: `${row.y}px`,
      fontFamily: "var(--font-mono, 'JetBrains Mono', monospace)",
      fontWeight: '600', fontSize: '34px', letterSpacing: '0.08em',
      color: TEXT_DIM, opacity: '0.5', whiteSpace: 'nowrap', filter: 'blur(0.4px)',
    }, streakWrap);
    n.textContent = TOKENS.slice(i * 2, i * 2 + 4).join('  ');
    return n;
  });

  const flash = mk('div', {
    position: 'absolute', inset: '0', opacity: '0', mixBlendMode: 'screen',
    background: 'radial-gradient(circle at 50% 40%, rgba(255,255,255,.9), rgba(255,209,102,.4) 22%, transparent 40%)',
  }, stage);

  /* ---- the reveal ---- */
  const revealGlow = mk('div', { position: 'absolute', inset: '0', opacity: '0' }, stage);
  const trophyWrap = mk('div', {
    position: 'absolute', left: '50%', top: '500px', opacity: '0',
  }, stage);
  trophy(trophyWrap);

  const pill = mk('div', {
    position: 'absolute', left: '50%', top: '690px', opacity: '0',
    background: GOLD, color: '#241a04',
    fontWeight: '800', fontSize: '20px', letterSpacing: '0.16em',
    padding: '7px 22px', borderRadius: '999px',
    boxShadow: '0 10px 26px -8px rgba(255,209,102,.55)',
  }, stage);
  pill.textContent = 'SOTD';

  const title = mk('div', {
    position: 'absolute', left: '50%', top: '750px', transform: 'translate(-50%,0)',
    display: 'flex', flexWrap: 'nowrap', gap: '0.28em',
    fontWeight: '800', fontSize: '42px', color: TEXT,
    letterSpacing: '0.01em', whiteSpace: 'nowrap',
  }, stage);
  const wordNodes = 'SCRAMBLE OF THE DAY'.split(' ').map((word) => {
    const n = mk('span', { display: 'inline-block', opacity: '0' }, title);
    n.textContent = word;
    return n;
  });

  const sub = mk('div', {
    position: 'absolute', left: '50%', top: '820px', opacity: '0',
    fontStyle: 'italic', fontWeight: '500', fontSize: '20px',
    color: TEXT_DIM, letterSpacing: '0.02em', whiteSpace: 'nowrap',
  }, stage);
  sub.textContent = SUBTITLE;

  return function frame(T) {
    const opIn = clamp(T / 0.28, 0, 1);
    const popIn = E.outBack(clamp(T / 0.5, 0, 1));
    const spinEnv =
      T > CUES.Scramble && T < CUES.Lock
        ? lerp(0, 1, E.inOutCubic)(clamp((T - CUES.Scramble) / 0.15, 0, 1)) *
          lerp(1, 0, E.inOutCubic)(clamp((T - (CUES.Lock - 0.15)) / 0.15, 0, 1))
        : 0;
    const spinWin = Math.max(0.001, CUES.Lock - CUES.Scramble);
    const spinP = clamp((T - CUES.Scramble) / spinWin, 0, 1);
    const turns = ENERGY_MUL < 1 ? 1 : ENERGY_MUL > 1 ? 3 : 2;
    /* Eased whole turns, so it lands exactly back on the resting angle. */
    const spinY = lerp(0, turns * 360, E.inOutCubic)(spinP);
    const spinX = Math.sin(spinP * Math.PI * turns * 2) * 14 * spinEnv;
    const shakeX = Math.sin(T * 47) * 3 * spinEnv * ENERGY_MUL;
    const shakeY = Math.cos(T * 39) * 3 * spinEnv * ENERGY_MUL;
    const bob = Math.sin(T * 1.6) * 4;
    const settle = clamp((T - CUES.Reveal) / 0.5, 0, 1);
    const scaleMul = T < CUES.Reveal ? popIn : lerp(1, 0.66, E.inOutCubic)(settle);
    const liftUp = lerp(0, -235, E.inOutCubic)(settle);

    cubeOuter.style.transform =
      `translate(${shakeX}px, ${shakeY + bob + liftUp}px) scale(${scaleMul})`;
    view.style.transform = `rotateX(${-28 + spinX}deg) rotateY(${34 + spinY}deg)`;
    for (const n of faceNodes) n.style.opacity = String(opIn);
    for (const t of tiles) {
      const c = tileColor(t.seed, t.solved, T);
      if (c !== t.last) { t.node.style.background = c; t.last = c; }
    }

    const glitchOn = T <= CUES.Scramble + 0.05;
    glitchWrap.style.display = glitchOn ? 'block' : 'none';
    if (glitchOn) {
      const enter = clamp(T / 0.4, 0, 1);
      glitchNodes.forEach((n, i) => {
        const flicker = (Math.sin(T * 26 + i * 3.1) + 1) / 2;
        n.style.opacity = String(enter * (0.25 + flicker * 0.55));
        n.textContent = TOKENS[(i * 3 + Math.floor(T * 8)) % TOKENS.length];
      });
    }

    const streakOn = T >= CUES.Scramble && T <= CUES.Lock + 0.05;
    streakWrap.style.display = streakOn ? 'block' : 'none';
    if (streakOn) {
      STREAK_ROWS.forEach((row, i) => {
        const local = T - CUES.Scramble - row.delay;
        streakNodes[i].style.left =
          `${lerp(-260, 1340, E.linear)(clamp((local * row.speed) / 1.8, 0, 1))}px`;
      });
    }

    const fEnv =
      lerp(0, 1, E.outQuad)(clamp((T - CUES.Lock) / 0.06, 0, 1)) *
      lerp(1, 0, E.inQuad)(clamp((T - CUES.Lock - 0.02) / 0.22, 0, 1));
    flash.style.opacity = String(T > CUES.Lock - 0.02 ? fEnv * 0.85 : 0);

    const p = clamp((T - CUES.Reveal) / 0.55, 0, 1);
    const trophyP = E.outElastic(clamp((T - CUES.Reveal - 0.02) / 0.4, 0, 1));
    const pillP = E.outBack(clamp((T - CUES.Reveal - 0.18) / 0.3, 0, 1));
    const wordP = clamp((T - CUES.Reveal - 0.26) / 0.34, 0, 1);
    const subP = clamp((T - CUES.Reveal - 0.42) / 0.3, 0, 1);
    const glow = 0.35 + Math.sin(T * 3) * 0.12;

    revealGlow.style.opacity = String(p);
    revealGlow.style.background =
      `radial-gradient(circle at 50% 62%, rgba(255,209,102,${glow * 0.35}), transparent 60%)`;
    trophyWrap.style.transform =
      `translate(-50%,0) scale(${0.5 + trophyP * 0.5}) rotate(${(1 - trophyP) * -14}deg)`;
    trophyWrap.style.opacity = String(clamp((T - CUES.Reveal - 0.02) / 0.15, 0, 1));
    pill.style.transform = `translate(-50%,${(1 - pillP) * 14}px)`;
    pill.style.opacity = String(pillP);
    wordNodes.forEach((n, i) => {
      const e = clamp(E.outBack(clamp((wordP - i * 0.16) / 0.35, 0, 1)), 0, 1);
      n.style.opacity = String(e);
      n.style.transform = `translateY(${(1 - e) * 22}px)`;
    });
    sub.style.transform = `translate(-50%,${(1 - subP) * 10}px)`;
    sub.style.opacity = String(subP * 0.85);
  };
}

/* The stage is authored at 1080 square and scaled to whichever viewport
   edge is shorter, so the framing the design was composed in survives a
   phone in portrait and a wide monitor alike, letterboxed on its own
   background rather than cropped.

   The ratio has to come from JS rather than a calc() in the stylesheet:
   min(100vw,100vh)/1080 is a length, scale() wants a bare number, and
   CSS will not divide one length by another. A stylesheet that tries it
   is not a smaller scale, it is an invalid transform, which the browser
   drops in silence and renders at 1080 square off the side of a phone. */
function injectStyle() {
  if (document.getElementById('sotd-intro-css')) return;
  const s = document.createElement('style');
  s.id = 'sotd-intro-css';
  s.textContent =
    '.sotd-intro{position:fixed;inset:0;z-index:9999;background:#07070c;' +
    'overflow:hidden;cursor:pointer;--sotd-intro-scale:1}' +
    /* Anchored to the viewport rather than the stage, so it stays put
       and stays tappable whichever way the 1080 square gets letterboxed. */
    '.sotd-intro-skip{position:absolute;z-index:1;' +
    'right:calc(16px + env(safe-area-inset-right));' +
    'bottom:calc(16px + env(safe-area-inset-bottom));' +
    'display:flex;align-items:center;gap:8px;' +
    'padding:9px 14px;border:1px solid rgba(236,236,245,.16);border-radius:999px;' +
    'background:rgba(7,7,12,.5);color:#9a8cd6;cursor:pointer;' +
    "font:600 13px/1 var(--font-ui,'Inter',system-ui,sans-serif);letter-spacing:.06em;" +
    /* Visible from the first frame rather than faded in on a delay. A
       second clock for a three second event buys nothing, and the one
       time the delay would matter — a throttled tab, a phone saving
       power — is exactly when it leaves the escape hatch invisible. */
    'opacity:.85;-webkit-tap-highlight-color:transparent}' +
    '.sotd-intro-skip:hover,.sotd-intro-skip:focus-visible' +
    '{color:#ececf5;border-color:rgba(236,236,245,.34);outline:none}' +
    /* The key cap, so the spacebar is discoverable and not folklore. */
    '.sotd-intro-skip kbd{padding:2px 7px;border-radius:5px;' +
    'background:rgba(236,236,245,.1);color:inherit;' +
    'font:inherit;font-size:11px;letter-spacing:.08em}';
  document.head.appendChild(s);
}

function fitTo(root) {
  const edge = Math.min(innerWidth, innerHeight);
  root.style.setProperty('--sotd-intro-scale', String(edge > 0 ? edge / 1080 : 1));
}

/* Resolves when the intro is off the screen, so the caller can open the
   window into a clean frame. Resolves immediately when there is nothing
   to play. */
export function playSotdIntro() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return Promise.resolve();

  injectStyle();
  const root = document.createElement('div');
  root.className = 'sotd-intro';
  document.body.appendChild(root);
  const fit = () => fitTo(root);
  fit();
  addEventListener('resize', fit);
  const frame = build(root);
  frame(0);

  const skipBtn = mk('button', null, root);
  skipBtn.className = 'sotd-intro-skip';
  skipBtn.type = 'button';
  skipBtn.innerHTML = 'Skip <kbd>space</kbd>';

  return new Promise((resolve) => {
    let raf = 0, start = 0, done = false;

    const finish = () => {
      if (done) return;
      done = true;
      cancelAnimationFrame(raf);
      removeEventListener('keydown', onKey, true);
      removeEventListener('resize', fit);
      root.removeEventListener('pointerdown', finish);
      root.style.transition = 'opacity .22s ease';
      root.style.opacity = '0';
      setTimeout(() => { root.remove(); resolve(); }, 220);
    };

    /* Any key, any tap, and a button for people who want to be told.
       The keystroke has to die here: the timer listens for Space on
       document, and capture runs window first, so without stopping it
       the space that skips the intro also starts the solve underneath
       — a running timer behind a fading title card. Killing the keydown
       takes the keyup with it, since that handler only acts on releases
       whose press it claimed. */
    function onKey(e) {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      finish();
    }

    addEventListener('keydown', onKey, true);
    root.addEventListener('pointerdown', finish);

    const tick = (now) => {
      if (!start) start = now;
      const T = (now - start) / 1000;
      frame(T < DUR ? T : DUR);
      /* Hold the last frame a beat so the wordmark reads. */
      if (T >= DUR + 0.35) { finish(); return; }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  });
}
