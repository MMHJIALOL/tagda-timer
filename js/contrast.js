/* ===========================================================
   Tagda Timer — keep text readable on whatever is behind it

   A user-supplied background can be anything, white photographs
   included. Rather than guessing, sample what is actually going to
   be on screen and flip the UI to a light or dark palette.
   =========================================================== */

import { Assets } from './db.js';

/** Perceived brightness, 0 (black) to 1 (white). */
const luma = (r, g, b) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

export function hexLuma(hex) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((hex || '').trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  return luma(parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16));
}

/** Average brightness of every colour named in a CSS gradient string. */
function gradientLuma(css) {
  const hexes = (css || '').match(/#[0-9a-f]{3,6}/gi) || [];
  const vals = hexes.map(hexLuma).filter(v => v !== null);
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/** Mean brightness of a bitmap, sampled small — precision is not the point. */
function bitmapLuma(source, w = 24, h = 24) {
  try {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);
    let sum = 0, n = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 8) continue;                 // ignore transparent pixels
      sum += luma(data[i], data[i + 1], data[i + 2]);
      n++;
    }
    return n ? sum / n : null;
  } catch {
    // A tainted canvas or a codec the browser will not decode.
    return null;
  }
}

async function blobLuma(key, isVideo) {
  const blob = await Assets.get(key);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  try {
    if (!isVideo) {
      const bmp = await createImageBitmap(blob);
      const v = bitmapLuma(bmp);
      bmp.close?.();
      return v;
    }
    const video = document.createElement('video');
    video.muted = true; video.playsInline = true; video.preload = 'metadata';
    video.src = url;
    await new Promise((resolve, reject) => {
      const done = () => resolve();
      video.addEventListener('loadeddata', done, { once: true });
      video.addEventListener('error', reject, { once: true });
      setTimeout(resolve, 2500);                      // never hang the boot on this
    });
    try { video.currentTime = Math.min(0.4, (video.duration || 1) / 2); } catch { /* ignore */ }
    await new Promise(r => { video.addEventListener('seeked', r, { once: true }); setTimeout(r, 600); });
    return bitmapLuma(video);
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Brightness of the background layer itself, before the dimming veil. */
async function mediaLuma(s) {
  switch (s.bgMode) {
    case 'solid':    return hexLuma(s.bgSolid);
    case 'gradient': return gradientLuma(s.bgGradient);
    case 'image':    return await blobLuma('bg-image', false);
    case 'video':    return await blobLuma('bg-video', true);
    default:         return shaderLuma();
  }
}

/**
 * Shaders have no bitmap to sample, but they are painted entirely out of the
 * theme's own palette, so the palette is the sample. This used to return null,
 * which meant the light themes never got the contrast pass at all and printed
 * their body text against whatever the shader felt like.
 *
 * Weighted towards the base colour because that is most of the screen; the
 * accents are highlights moving across it.
 */
function shaderLuma() {
  const cs = getComputedStyle(document.documentElement);
  const at = (n, w) => {
    const v = hexLuma(cs.getPropertyValue(n).trim());
    return v === null ? null : [v, w];
  };
  const parts = [at('--bg-2', 3), at('--accent', 1), at('--accent-2', 1)].filter(Boolean);
  if (!parts.length) return null;
  const total = parts.reduce((a, [, w]) => a + w, 0);
  return parts.reduce((a, [v, w]) => a + v * w, 0) / total;
}

/**
 * Decide whether the UI should read as light-on-dark or dark-on-light, and
 * stamp it on <html> for the stylesheet to act on.
 *
 * The veil sits between the media and the content at `bgDim` opacity in the
 * theme's own background colour, so a bright photo behind a heavy dim is
 * genuinely dark by the time you look at it. Blending the two is what makes
 * the answer match what is on screen rather than what was uploaded.
 */
export async function applyContrast(settings) {
  const root = document.documentElement;
  if (!settings.autoContrast) { delete root.dataset.bgLuma; return null; }

  const media = await mediaLuma(settings);
  if (media === null) { delete root.dataset.bgLuma; return null; }

  const themeLuma = hexLuma(getComputedStyle(root).getPropertyValue('--bg').trim()) ?? 0.05;
  const dim = Math.min(1, Math.max(0, Number(settings.bgDim) || 0));
  const effective = media * (1 - dim) + themeLuma * dim;

  root.dataset.bgLuma = effective > 0.55 ? 'light' : 'dark';
  return effective;
}
