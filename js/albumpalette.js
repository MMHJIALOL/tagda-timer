/* ===========================================================
   Tagda Timer — pull a usable pair of colours out of album art

   Album covers hand you near-black and near-white constantly, and a
   near-black accent on a dark theme is invisible. So this does not return
   the dominant colour: it finds the colours that carry the record's
   identity, then clamps them into a band the interface can survive.

   Hue is preserved exactly — that is the part that says "this album".
   Lightness and saturation are the theme's business, not the artwork's.
   =========================================================== */

/* ---------------- colour space ---------------- */

export function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r)      h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else                h = ((r - g) / d + 4) / 6;
  return [h * 360, s, l];
}

export function hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const seg = Math.floor(h / 60) % 6;
  const [r, g, b] = [
    [c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x],
  ][seg];
  const hx = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${hx(r)}${hx(g)}${hx(b)}`;
}

/** Shortest distance between two hues, in degrees (0-180). */
const hueGap = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

/* ---------------- sampling ---------------- */

/**
 * Load an image for pixel access.
 *
 * crossOrigin must be set *before* src or the request goes out without the
 * CORS headers and the canvas taints anyway — which is the failure this whole
 * module has to detect rather than assume.
 */
export function loadArtwork(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('artwork failed to load'));
    img.src = url;
  });
}

/**
 * True when this origin is allowed to read the artwork's pixels.
 *
 * Checked once per connection rather than assumed: i.scdn.co is behind a CDN
 * whose CORS behaviour is not something to take on faith, and the whole
 * feature has a different shape depending on the answer (see SPOTIFY.md §4.1).
 */
export async function probeArtworkCors(url) {
  try {
    const img = await loadArtwork(url);
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, 1, 1);
    ctx.getImageData(0, 0, 1, 1);      // throws on a tainted canvas
    return true;
  } catch {
    return false;
  }
}

/* ---------------- extraction ---------------- */

const SIZE = 48;          // the art is sampled this small; precision is not the point
const BITS = 4;           // 4 bits per channel -> 4096 bins
const SHIFT = 8 - BITS;

/**
 * Score a bucket. Population alone picks the background of the sleeve, which
 * on most covers is the least interesting thing on it — so weight by how much
 * colour a pixel actually carries, and throw away the ends of the lightness
 * range entirely, where hue is meaningless.
 */
function scoreOf(count, s, l) {
  if (l < 0.12 || l > 0.93) return 0;   // near-black and near-white say nothing
  if (s < 0.14) return 0;               // grey has no hue to borrow
  return count * (0.35 + s);
}

/**
 * Two colours from an image element, or null if nothing in it is colourful
 * enough to be worth borrowing.
 *
 * `dark` picks which lightness band to clamp into — the same colour has to be
 * lighter than the page on a dark theme and darker than it on a light one.
 */
export function paletteFrom(img, { dark = true } = {}) {
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, SIZE, SIZE);

  let data;
  try { data = ctx.getImageData(0, 0, SIZE, SIZE).data; }
  catch { return null; }                // tainted — caller falls back to artwork-as-background

  // sum r/g/b per bucket so the winner is the bucket's true mean, not the
  // quantised corner of it
  const bins = new Map();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 8) continue;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const key = ((r >> SHIFT) << (BITS * 2)) | ((g >> SHIFT) << BITS) | (b >> SHIFT);
    const e = bins.get(key);
    if (e) { e.n++; e.r += r; e.g += g; e.b += b; }
    else bins.set(key, { n: 1, r, g, b });
  }

  const ranked = [];
  for (const e of bins.values()) {
    const r = e.r / e.n, g = e.g / e.n, b = e.b / e.n;
    const [h, s, l] = rgbToHsl(r, g, b);
    const score = scoreOf(e.n, s, l);
    if (score > 0) ranked.push({ h, s, score });
  }
  if (!ranked.length) return null;
  ranked.sort((a, b) => b.score - a.score);

  const primary = ranked[0];
  // A second colour only earns its place if it is far enough round the wheel to
  // read as a different colour. Otherwise take the complement of the first —
  // two near-identical accents look like a mistake, not a palette.
  const secondary = ranked.find(x => hueGap(x.h, primary.h) >= 40)
    || { h: primary.h + 150, s: primary.s };

  return {
    accent:  clampToBand(primary.h, primary.s, dark),
    accent2: clampToBand(secondary.h, secondary.s, dark),
    // A heavily desaturated, very dark/light take on the dominant hue, for the
    // shader's base colour — it sits behind everything and must not compete.
    bg2:     hslToHex(primary.h, Math.min(0.45, primary.s), dark ? 0.13 : 0.9),
  };
}

/**
 * Force a hue into a lightness/saturation range the UI can use.
 * The hue survives untouched; everything else is negotiable.
 */
function clampToBand(h, s, dark) {
  const sat = Math.min(0.92, Math.max(0.45, s));
  const light = dark ? 0.63 : 0.36;
  return hslToHex(h, sat, light);
}

/** Convenience: URL in, palette out. Null on any failure. */
export async function paletteFromUrl(url, opts) {
  try { return paletteFrom(await loadArtwork(url), opts); }
  catch { return null; }
}
