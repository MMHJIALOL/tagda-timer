/* ===========================================================
   Tagda Timer — pull a usable pair of colours out of album art

   The goal is the colour you would name if someone showed you the sleeve —
   which is mostly a question of how much of the cover a colour occupies, not
   how vivid it is. Hue is aggregated across the whole image and never
   altered; only lightness and saturation are nudged, and only far enough to
   stay legible against the page.

   Near-black and near-white are excluded because they have no hue to lend,
   not because they are pale: a face against a white wall is mostly pale, and
   its hue is exactly the thing worth taking.
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

/* ---------------- extraction ---------------- */

const SIZE = 64;          // sample grid; 4096 pixels is plenty and costs nothing
const BUCKETS = 36;       // 10 degrees of hue each
const ARC = 360 / BUCKETS;

/* A pixel has to carry some actual colour to vote. These bounds only exclude
   pixels with no *hue* to contribute — not pixels that are merely pale. A
   photograph of skin against a white wall is mostly pale, and its hue is
   exactly the thing worth borrowing, so the old thresholds (which threw away
   anything under 14% saturation or over 93% lightness) were discarding the
   subject of half the covers people actually own. */
const MIN_SAT = 0.07;
const MIN_LIGHT = 0.07;
const MAX_LIGHT = 0.96;

/**
 * Two colours from an image element, or null when there is genuinely no hue in
 * it worth taking.
 *
 * Aggregates by *hue*, not by RGB bucket. Quantising into a 4-bit-per-channel
 * cube looks reasonable and is quietly wrong for photographs: a smooth gradient
 * — skin, sky, a lit wall — is spread across dozens of neighbouring cells and
 * each one individually loses to a small patch of flat, vivid graphic colour.
 * That is why a cover which reads as "a person against a pale background" came
 * back as the one saturated accessory in the corner. Collapsing to a hue
 * histogram puts the whole gradient back into one bin, where its real size can
 * win.
 *
 * `dark` picks which lightness band to land in — the same hue has to sit
 * lighter than a dark page and darker than a light one.
 */
export function paletteFrom(img, { dark = true } = {}) {
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, SIZE, SIZE);

  let data;
  try { data = ctx.getImageData(0, 0, SIZE, SIZE).data; }
  catch { return null; }                 // tainted — caller falls back to artwork-as-background

  const weight = new Float64Array(BUCKETS);
  // Circular means: hue is an angle, so averaging 350 and 10 as numbers gives
  // 180 — the opposite colour — instead of 0.
  const sin = new Float64Array(BUCKETS);
  const cos = new Float64Array(BUCKETS);
  const satSum = new Float64Array(BUCKETS);
  const lightSum = new Float64Array(BUCKETS);
  const count = new Float64Array(BUCKETS);
  let coloured = 0, total = 0;

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 8) continue;
    total++;
    const [h, sat, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
    if (sat < MIN_SAT || l < MIN_LIGHT || l > MAX_LIGHT) continue;
    coloured++;

    /* Area first, saturation second. What a cover "looks like" is mostly a
       question of how much of it is a given colour; saturation only breaks
       ties, so a large muted region is no longer beaten by a small vivid one. */
    const w = 0.5 + 0.5 * sat;
    const b = Math.min(BUCKETS - 1, Math.floor(h / ARC));
    const rad = h * Math.PI / 180;
    weight[b] += w;
    sin[b] += Math.sin(rad) * w;
    cos[b] += Math.cos(rad) * w;
    satSum[b] += sat * w;
    lightSum[b] += l * w;
    count[b] += w;
  }

  // Almost nothing in this image has a hue at all: a black-and-white sleeve, or
  // a near-white one. Inventing a colour for it would be worse than leaving the
  // user's own theme alone.
  if (!total || coloured / total < 0.04) return null;

  /* Blur the histogram before looking for peaks. A real-world colour is never
     one bucket wide — skin runs roughly 20-40 degrees — so a broad, shallow
     region has to be allowed to out-vote a narrow spike, which is exactly the
     comparison that was going the wrong way. */
  const smooth = new Float64Array(BUCKETS);
  for (let i = 0; i < BUCKETS; i++) {
    const l = (i - 1 + BUCKETS) % BUCKETS, r = (i + 1) % BUCKETS;
    smooth[i] = weight[i] + 0.55 * (weight[l] + weight[r]);
  }

  const readBucket = (b) => {
    if (!count[b]) return null;
    let h = Math.atan2(sin[b], cos[b]) * 180 / Math.PI;
    if (h < 0) h += 360;
    return { h, s: satSum[b] / count[b], l: lightSum[b] / count[b], score: smooth[b] };
  };

  let bestIdx = 0;
  for (let i = 1; i < BUCKETS; i++) if (smooth[i] > smooth[bestIdx]) bestIdx = i;
  const primary = readBucket(bestIdx);
  if (!primary) return null;

  // The second colour has to be far enough round the wheel to read as a
  // different colour at a glance, and carry real weight of its own rather than
  // being the shoulder of the first peak.
  let secondIdx = -1;
  for (let i = 0; i < BUCKETS; i++) {
    if (hueGap(i * ARC + ARC / 2, primary.h) < 40) continue;
    if (secondIdx === -1 || smooth[i] > smooth[secondIdx]) secondIdx = i;
  }
  const runnerUp = secondIdx >= 0 ? readBucket(secondIdx) : null;
  /* 3% of the weight is a low bar on purpose. A logo, a sticker, a strip of
     sky — a small but genuinely different colour in the artwork beats a
     complement computed from the first one, because it is actually *there*.
     Below this the image really is monochromatic and a derived complement is
     the honest answer. */
  const secondary = (runnerUp && runnerUp.score > primary.score * 0.03)
    ? runnerUp
    : { h: primary.h + 150, s: primary.s, l: primary.l };

  return {
    accent:  clampToBand(primary.h, primary.s, primary.l, dark),
    accent2: clampToBand(secondary.h, secondary.s, secondary.l, dark),
    bg2:     hslToHex(primary.h, Math.min(0.4, primary.s), dark ? 0.12 : 0.91),
  };
}

/**
 * Nudge a colour into a range the UI can use, rather than overwriting it.
 *
 * The hue is never touched — that is the part that says which record this is.
 * Lightness and saturation are clamped into a band instead of being pinned to
 * one value, so a muted sleeve still reads as muted and a vivid one still reads
 * as vivid; they just both stay legible against the page.
 */
function clampToBand(h, s, l, dark) {
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  return hslToHex(
    h,
    clamp(s, 0.42, 0.9),
    dark ? clamp(l, 0.54, 0.72) : clamp(l, 0.28, 0.46),
  );
}

/* ---------------- caching ----------------
   A track change used to fetch and decode the cover three separate times: once
   to test CORS, once for the palette, and once more for the <img> in the card.
   The bytes come from the HTTP cache after the first, but the *decode* does
   not, and three decodes of a 640px JPEG in the same tick is what made changing
   track feel heavy. One decode now, kept for as long as it is useful. */
const CACHE_MAX = 40;
const _cache = new Map();          // url -> {palette, blocked} | Promise

/**
 * Palette for an artwork URL. Returns `{palette, blocked}`, where `blocked`
 * means the CDN would not let us read the pixels — the caller falls back to
 * using the artwork as a background, which CORS cannot prevent.
 */
export function paletteForUrl(url, opts = {}) {
  const key = `${url}|${opts.dark ? 'd' : 'l'}`;
  const hit = _cache.get(key);
  if (hit) return Promise.resolve(hit);

  const job = (async () => {
    try {
      /* No explicit decode() step. It looks like a free optimisation and is
         not: it can sit unresolved in a tab that is not compositing, and since
         this promise is cached that would wedge the URL for the whole session.
         Guarding it with a timer is worse again — background tabs clamp timers
         to a second, so the guard becomes the cost. An image that has fired
         onload draws fine, and drawing it into a 64px canvas is microseconds. */
      const img = await loadArtwork(url);
      const palette = paletteFrom(img, opts);
      return { palette, blocked: palette === null && !!img.naturalWidth && isTainted(img) };
    } catch {
      return { palette: null, blocked: false };
    }
  })().then(res => {
    if (_cache.size >= CACHE_MAX) _cache.delete(_cache.keys().next().value);
    _cache.set(key, res);
    return res;
  });

  _cache.set(key, job);
  return job;
}

/** Did this image poison the canvas? Asked only when extraction came back empty. */
function isTainted(img) {
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, 1, 1);
    ctx.getImageData(0, 0, 1, 1);
    return false;
  } catch { return true; }
}

/** Convenience: URL in, palette out. Null on any failure. */
export async function paletteFromUrl(url, opts) {
  return (await paletteForUrl(url, opts)).palette;
}
