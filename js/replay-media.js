import { t } from './i18n.js';
/* ===========================================================
   Tagda Timer — webcam replay: converting and exporting clips

   Two jobs, both done with Mediabunny (vendor/mediabunny, MPL-2.0, unmodified;
   its licence is next to it) over the browser's own WebCodecs encoders, and
   both loaded only when there is a clip to work on.

   finishClip: after a solve, the recorder's WebM (or Safari's MP4) is encoded
   again with a keyframe every half second and a seek index, frame times kept,
   so the player can seek anywhere without decoding seconds of video first.

   exportVideo: the MP4 you download. The clip is redrawn frame by frame onto
   a canvas beside the clock (inspection countdown, the running time, the
   final result and penalty), the cube as the scramble leaves it, the
   scramble, and the share card's branding, at 30 fps:
     reel   1080x1920, the share card with a square of the picture in it (the
            square you chose in the player, or the middle)
     wide   1920x1080, the whole picture as filmed with a panel beside it
     clean  the picture as filmed and nothing else, but tagdatimer.me in a
            corner
   The clock comes from clockAt() in replay.js, the same function the player
   draws with, so the download says exactly what the player said.

   Sound, when the clip has it, goes along: copied as it is into the seekable
   copy, and in a download AAC where the browser can encode it, else Opus.
   =========================================================== */

import * as MB from '../vendor/mediabunny/mediabunny.min.js';
import { W as CARD_W, MONO, SANS, SITE, INSTA, rr, hex, paintBackground, paintHeader, paintFooter,
         paintScramble, logoImage, fontsReady } from './sharecard.js';
import { faceletsFor, drawNet, cubeSizeFor } from './cubenet.js';
import { themeColors } from './theme.js';
import { eventOf } from './events.js';
import { fmtDate } from './util.js';
import { clockAt } from './replay.js';

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/* Firefox's H.264 WebCodecs encoder (on Windows, at least) hands back an avcC
   whose parameter sets each start with their NAL header byte twice (SPS
   67 67 64 00 28, PPS 68 68 ce...), and without the four bytes ISO 14496-15
   requires after them for a High-profile stream. Firefox's own player and
   FFmpeg shrug it off by reading the copies inside the first frame; stricter
   players (iPhones, Instagram's upload checks) read this one, and the MP4 is
   written from it. So it is mended as it leaves the encoder: a doubled header
   byte is dropped, a missing High-profile tail is added (4:2:0, 8-bit, which
   is all these encoders make), and an avcC with neither fault is returned
   untouched. Installed once, while this module is loaded; Mediabunny looks
   VideoEncoder up each time it makes one. */
export function mendAvcc(desc) {
  const b = desc instanceof Uint8Array ? desc : ArrayBuffer.isView(desc)
    ? new Uint8Array(desc.buffer, desc.byteOffset, desc.byteLength) : new Uint8Array(desc);
  if (b.length < 7 || b[0] !== 1) return desc;
  const profile = b[1];
  let p = 5;
  const list = (count) => {
    const out = [];
    for (let n = count; n > 0; n--) {
      if (p + 2 > b.length) return null;
      const len = (b[p] << 8) | b[p + 1];
      out.push(b.subarray(p + 2, p + 2 + len));
      p += 2 + len;
    }
    return p > b.length ? null : out;
  };
  const sps = list(b[p++] & 31);
  if (!sps || p >= b.length) return desc;
  const pps = list(b[p++]);
  if (!pps) return desc;
  let tail = b.subarray(p);
  let changed = false;
  const undouble = (s, type) => {
    if (s.length > 2 && (s[0] & 31) === type && s[1] === s[0]) { changed = true; return s.subarray(1); }
    return s;
  };
  const sps2 = sps.map(s => undouble(s, 7));
  const pps2 = pps.map(s => undouble(s, 8));
  if ([100, 110, 122, 144].includes(profile) && tail.length < 4) {
    tail = Uint8Array.of(0xfc | 1, 0xf8, 0xf8, 0);   // chroma_format 4:2:0, 8-bit luma and chroma, no SPS extensions
    changed = true;
  }
  if (!changed) return desc;
  const size = 7 + [...sps2, ...pps2].reduce((n, s) => n + 2 + s.length, 0) + tail.length;
  const out = new Uint8Array(size);
  out.set(b.subarray(0, 5));
  let q = 5;
  const put = (arr) => { for (const s of arr) { out[q++] = s.length >> 8; out[q++] = s.length & 255; out.set(s, q); q += s.length; } };
  out[q++] = 0xe0 | sps2.length;
  put(sps2);
  out[q++] = pps2.length;
  put(pps2);
  out.set(tail, q);
  return out;
}
if (typeof VideoEncoder === 'function' && !VideoEncoder.mended) {
  const Native = VideoEncoder;
  globalThis.VideoEncoder = class extends Native {
    static mended = true;
    constructor(init) {
      super({
        ...init,
        output: (chunk, meta) => {
          const dc = meta?.decoderConfig;
          if (dc?.description && /^avc[13]\./.test(dc.codec || '')) {
            meta = { ...meta, decoderConfig: { ...dc, description: mendAvcc(dc.description) } };
          }
          init.output(chunk, meta);
        },
      });
    }
  };
}

/** Cancel `conv` when `signal` fires, and say so with an AbortError. */
async function run(conv, signal, onProgress) {
  if (onProgress) conv.onProgress = (p) => onProgress(Math.min(1, p));
  const stop = () => { conv.cancel().catch(() => {}); };
  signal?.addEventListener('abort', stop);
  try {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    await conv.execute();
  } catch (err) {
    if (signal?.aborted || err instanceof MB.ConversionCanceledError) throw new DOMException('Cancelled', 'AbortError');
    throw err;
  } finally {
    signal?.removeEventListener('abort', stop);
  }
}

const input = (blob) => new MB.Input({ source: new MB.BlobSource(blob), formats: MB.ALL_FORMATS });

/** The best codec this browser can encode at this size, and the file it goes in. */
async function encoder(width, height, order = ['avc', 'vp9', 'vp8'], bitrate) {
  // With the bitrate the conversion will ask for, its own check finds this answer
  // already remembered: one test encode instead of two.
  const codec = await MB.getFirstEncodableVideoCodec(order, bitrate ? { width, height, bitrate } : { width, height });
  if (!codec) return null;
  const mp4 = codec === 'avc';
  return {
    codec,
    format: mp4 ? new MB.Mp4OutputFormat({ fastStart: 'in-memory' }) : new MB.WebMOutputFormat(),
    mime: mp4 ? 'video/mp4' : 'video/webm',
    ext: mp4 ? 'mp4' : 'webm',
  };
}

/* ---------------- storage: seekable copy ----------------
   VP8 in WebM first. Measured on an eight-second clip: seeks went from a
   median 136 ms (Firefox) and 41 ms (Chrome) on the recorder's file to 13 ms,
   and it is the quickest to encode. Firefox's H.264 encoder labels each frame
   with the next frame's time, which would put the picture a frame off the
   clock, so H.264 is only the fallback (Safari). The frame times stored with
   the clip are read back out of the finished file, not taken on the way in. */
const STORE_CODECS = ['vp8', 'vp9', 'avc'];

async function packetTimes(blob) {
  const track = await input(blob).getPrimaryVideoTrack();
  const out = [];
  for await (const p of new MB.EncodedPacketSink(track).packets()) out.push(p.timestamp);
  return out.sort((a, b) => a - b);
}

/**
 * The clip again, with a keyframe every half second and the same frame times,
 * as a job that can be paused (an attempt has started) and picked up again
 * where it left off: { run(pauseSignal) -> finished?, result(), cancel() }.
 * Resolves null when nothing here can encode it (the original then stays).
 * Pausing rather than cancelling means no work thrown away, and no decoded
 * frames abandoned mid-flight for the garbage collector to find.
 */
export async function prepareFinish(blob, order = STORE_CODECS) {
  const inp = input(blob);
  const track = await inp.getPrimaryVideoTrack();
  if (!track) return null;
  const enc = await encoder(even(track.displayWidth), even(track.displayHeight), order);
  if (!enc) return null;
  const output = new MB.Output({ format: enc.format, target: new MB.BufferTarget() });
  const conv = await MB.Conversion.init({
    input: inp, output,
    video: { codec: enc.codec, keyFrameInterval: 0.5, forceTranscode: true },
    // The sound as recorded: copied, not encoded again (Opus goes in WebM and MP4 alike).
    audio: { forceTranscode: false },
  });
  if (!conv.isValid) return null;
  return {
    async run(pauseSignal) {
      await conv.execute({ pauseSignal });
      return conv.state === 'done';
    },
    async result() {
      const out = new Blob([output.target.buffer], { type: enc.mime });
      return { blob: out, frames: await packetTimes(out) };
    },
    cancel: () => conv.cancel().catch(() => {}),
  };
}

/** The same, start to finish in one go (tests, and anything that cannot be paused). */
export async function finishClip(blob, signal, order = STORE_CODECS) {
  const job = await prepareFinish(blob, order);
  if (!job) return null;
  const stop = () => job.cancel();
  signal?.addEventListener('abort', stop);
  try {
    if (!(await job.run())) return null;
  } finally { signal?.removeEventListener('abort', stop); }
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  return job.result();
}

/* ---------------- downloads: the clip with its clock ---------------- */

// A page canvas rather than an OffscreenCanvas: the webfonts are certain to be there.
const canvas = (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h });

const clockColour = (c, kind) => ({ pre: hex(c.text, 0.45), insp: c.warn, late: c.danger, run: c.text, done: c.accent2 }[kind] || c.text);

/** Set the biggest font, up to `size`, at which `text` fits in `max` px. */
function fitFont(ctx, text, max, weight, size, family) {
  ctx.font = `${weight} ${size}px ${family}`;
  const w = ctx.measureText(text).width;
  if (w > max) { size = Math.floor(size * max / w); ctx.font = `${weight} ${size}px ${family}`; }
  return size;
}

/* The phase label, then the time (and a penalty after it), shrunk to fit `max`. */
function paintClock(ctx, c, k, { x, labelY, digitsY, max, size, label = 30, pen = 0.4 }) {
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillStyle = c.accent2;
  ctx.font = `700 ${label}px ${SANS}`;
  ctx.letterSpacing = `${Math.round(label / 5)}px`;
  ctx.fillText(k.phase.toUpperCase(), x + 4, labelY);
  ctx.letterSpacing = '0px';
  let penW = 0;
  if (k.pen) {
    ctx.font = `800 ${Math.round(size * pen)}px ${MONO}`;
    penW = ctx.measureText(k.pen).width + size * 0.14;
  }
  const s = fitFont(ctx, k.text, max - penW, 800, size, MONO);
  ctx.fillStyle = clockColour(c, k.kind);
  ctx.fillText(k.text, x, digitsY);
  if (k.pen) {
    const px = x + ctx.measureText(k.text).width + s * 0.14;
    ctx.fillStyle = c.danger;
    ctx.font = `800 ${Math.round(s * pen)}px ${MONO}`;
    ctx.fillText(k.pen, px, digitsY);
  }
}

/* The cube as the scramble leaves it, from the same net the share card draws. */
function paintCube(ctx, c, info, x, y, w, h) {
  if (!info.n) return false;
  ctx.fillStyle = hex(c.text, 0.05);
  rr(ctx, x, y, w, h, 18);
  ctx.fill();
  drawNet(ctx, faceletsFor(info.scramble, info.n), info.n, x + 14, y + 14, w - 28, h - 28);
  return true;
}

/* 9:16, for Reels, TikTok and Shorts: the share card's background, header and
   footer, a square of the picture (the one chosen in the player, else the
   middle), then the clock with the cube's scrambled state beside it, then the
   scramble. The square sits inside the card's hairline frame with its own
   rounded corners: run edge to edge, it cut across the frame's sides.
   Instagram lays its caption and buttons over the bottom of a Reel, so what
   matters sits in the upper three quarters. */
function reelLayout(vw, vh, info, c, logo) {
  const W = CARD_W, H = 1920;
  const video = { x: 40, y: 150, w: W - 80, h: W - 80, r: 30, crop: true };
  const top = video.y + video.h;
  const net = info.n ? { x: 690, y: top + 30, w: 316, h: 240 } : null;
  const clock = { x: 68, labelY: top + 76, digitsY: top + 232, max: (net ? net.x - 24 : W - 74) - 68, size: 164 };
  const base = canvas(W, H);
  const g = base.getContext('2d');
  paintBackground(g, H, c);
  paintHeader(g, c, logo, info.kicker);
  g.fillStyle = '#000';
  rr(g, video.x, video.y, video.w, video.h, video.r);
  g.fill();
  if (net) paintCube(g, c, info, net.x, net.y, net.w, net.h);
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  g.fillStyle = hex(c.text, 0.55);
  g.font = `500 28px ${SANS}`;
  g.fillText(info.line, 74, top + 312);
  if (info.scramble) paintScramble(g, c, top + 340, info.scramble, { maxLines: 3, size: 32 });
  paintFooter(g, H, c);
  // A hairline round the picture, drawn over it, so its edge reads as part of the card.
  const over = (ctx) => {
    ctx.strokeStyle = hex(c.text, 0.14);
    ctx.lineWidth = 2;
    rr(ctx, video.x + 1, video.y + 1, video.w - 2, video.h - 2, video.r);
    ctx.stroke();
  };
  return { W, H, base, video, bps: 8_000_000, over, clock: (ctx, k) => paintClock(ctx, c, k, clock) };
}

/* As filmed, at the camera's own size, with nothing on it but the site's name
   in the bottom-right corner: small, translucent, shadowed so it reads on a
   light or a dark picture. */
function cleanLayout(vw, vh, info, c, logo) {
  const W = even(vw), H = even(vh);
  const video = { x: 0, y: 0, w: W, h: H, crop: false };
  const base = canvas(W, H);
  const g = base.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  const size = Math.max(16, Math.round(Math.min(W, H) * 0.036));
  const pad = Math.round(size * 0.9);
  const over = (ctx) => {
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.shadowColor = 'rgba(0, 0, 0, .65)';
    ctx.shadowBlur = size * 0.35;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'right';
    ctx.font = `700 ${size}px ${SANS}`;
    ctx.fillStyle = '#fff';
    ctx.fillText(SITE, W - pad, H - pad);
    if (logo) {
      const w = ctx.measureText(SITE).width, l = Math.round(size * 1.35);
      ctx.shadowBlur = 0;
      ctx.drawImage(logo, W - pad - w - l - size * 0.35, H - pad - l * 0.8, l, l);
    }
    ctx.restore();
  };
  return { W, H, base, video, bps: Math.max(2_500_000, Math.round(W * H * 6)), over, clock: () => {} };
}

/* 16:9: the picture on the left, in a 4:3 box (WIDE_ASPECT): the part chosen
   in the player fills it, or without one the whole picture is fitted in (a 4:3
   camera fills it exactly, anything else gets bars), and a panel down the right
   with the name, the clock, the cube and the scramble, and where to find it. */
function wideLayout(vw, vh, info, c, logo) {
  const W = 1920, H = 1080, P = 480, X = W - P + 40, IN = P - 80;
  const video = { x: 0, y: 0, w: W - P, h: H, crop: false };
  const base = canvas(W, H);
  const g = base.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, W - P, H);
  const grad = g.createLinearGradient(W - P, 0, W, H);
  grad.addColorStop(0, c.bg2 || '#12102a');
  grad.addColorStop(1, c.bg || '#07070c');
  g.fillStyle = grad;
  g.fillRect(W - P, 0, P, H);
  const bloom = g.createRadialGradient(W - P * 0.2, H * 0.1, 0, W - P * 0.2, H * 0.1, P);
  bloom.addColorStop(0, hex(c.accent, 0.28));
  bloom.addColorStop(1, hex(c.accent, 0));
  g.fillStyle = bloom;
  g.fillRect(W - P, 0, P, H);
  g.fillStyle = c.accent;
  g.fillRect(W - P, 0, 5, H);

  // The name, as on the share card.
  g.textBaseline = 'middle';
  g.textAlign = 'left';
  if (logo) g.drawImage(logo, X, 52, 56, 56);
  g.font = `800 34px ${SANS}`;
  g.fillStyle = c.text;
  g.fillText('TAGDA', X + 72, 80);
  g.fillStyle = c.accent2;
  g.fillText(' TIMER', X + 72 + g.measureText('TAGDA').width, 80);
  g.textBaseline = 'alphabetic';
  g.fillStyle = hex(c.text, 0.6);
  g.font = `500 22px ${SANS}`;
  g.fillText(info.event, X, 152);
  g.fillText(info.when, X, 182);

  let y = 440;
  if (paintCube(g, c, info, X, y, IN, 290)) y += 290 + 26;
  if (info.scramble) paintScramble(g, c, y, info.scramble, { x: X, width: IN, maxLines: info.n ? 4 : 8, size: 22 });

  g.strokeStyle = hex(c.text, 0.12);
  g.lineWidth = 2;
  g.beginPath(); g.moveTo(X, H - 112); g.lineTo(X + IN, H - 112); g.stroke();
  g.font = `700 26px ${SANS}`;
  g.fillStyle = hex(c.text, 0.8);
  g.fillText(SITE, X, H - 66);
  g.fillStyle = c.accent2;
  g.fillText(INSTA, X, H - 30);

  const clock = { x: X - 4, labelY: 262, digitsY: 386, max: IN + 4, size: 132, label: 24 };
  return { W, H, base, video, bps: 7_000_000, clock: (ctx, k) => paintClock(ctx, c, k, clock) };
}

/* Draw one frame of the export: the layout's still parts, the picture (the
   chosen square, the middle, or all of it), what goes over the picture, and
   the clock for media time `ms`. `draw(sx, sy, sw, sh, dx, dy, dw, dh)` puts
   the source's pixels on the canvas, whichever kind of source it is. */
function paintFrame(g, L, crop, draw, sw, sh, clock) {
  g.drawImage(L.base, 0, 0);
  const v = L.video;
  if (v.r) { g.save(); rr(g, v.x, v.y, v.w, v.h, v.r); g.clip(); }
  if (crop) {
    // The part chosen in the player, as fractions of the picture, already the box's shape.
    draw(crop.x * sw, crop.y * sh, crop.w * sw, crop.h * sh, v.x, v.y, v.w, v.h);
  } else if (v.crop) {
    // Fill the box, trimming whichever way the picture is too long: the middle stays.
    const k = Math.max(v.w / sw, v.h / sh);
    const cw = v.w / k, ch = v.h / k;
    draw((sw - cw) / 2, (sh - ch) / 2, cw, ch, v.x, v.y, v.w, v.h);
  } else {
    const k = Math.min(v.w / sw, v.h / sh);
    const dw = sw * k, dh = sh * k;
    draw(0, 0, sw, sh, v.x + (v.w - dw) / 2, v.y + (v.h - dh) / 2, dw, dh);
  }
  if (v.r) g.restore();
  L.over?.(g);
  L.clock(g, clock);
}

/* The quick way: decode, draw and encode as fast as the machine allows, with
   WebCodecs, into an MP4 (H.264) or, failing that, a WebM. */
/* Mediabunny remembers what it found an encoder able to do for the rest of
   the page's life, failures included, and on Firefox it finds out with a real
   test encode, which can fail once under load. One bad test would then mean
   no MP4 until a reload. Registering an encoder (this one never offers to do
   anything) is its public way to forget. */
function forgetEncoderTests() {
  MB.registerEncoder(class extends MB.CustomVideoEncoder { static supports() { return false; } });
}

/** The export's encoder: H.264 for an MP4 if this browser has one, asking twice before taking a no. */
async function exportEncoder(w, h, bps, fresh) {
  if (fresh) forgetEncoderTests();
  const enc = await encoder(w, h, undefined, bps);
  if (enc?.codec === 'avc' || fresh) return enc;
  forgetEncoderTests();
  return encoder(w, h, undefined, bps);
}

/* The export's sound. In an MP4, AAC where the browser can encode it (what
   iPhones and Instagram's upload checks are happiest with), else Opus; in a
   WebM, Opus. Null when the clip is silent; { discard } when nothing here
   can make either, and the video goes out without it. */
async function exportAudio(inp, mp4) {
  const track = await inp.getPrimaryAudioTrack().catch(() => null);
  if (!track) return null;
  const codec = await MB.getFirstEncodableAudioCodec(mp4 ? ['aac', 'opus'] : ['opus'], {
    numberOfChannels: track.numberOfChannels, sampleRate: track.sampleRate, bitrate: 96_000,
  });
  if (!codec) return { discard: true };
  return { codec, bitrate: 96_000 };
}

async function viaWebCodecs({ blob, L, crop, clockFor, onProgress, signal }, fresh = false) {
  const enc = await exportEncoder(L.W, L.H, L.bps, fresh);
  if (!enc) throw new Error(t('no video encoder for {w}x{h}', { w: L.W, h: L.H }));
  const out = canvas(L.W, L.H);
  const g = out.getContext('2d');
  const output = new MB.Output({ format: enc.format, target: new MB.BufferTarget() });
  const inp = input(blob);
  const audio = await exportAudio(inp, enc.ext === 'mp4');
  const conv = await MB.Conversion.init({
    input: inp, output,
    video: {
      codec: enc.codec, frameRate: 30, keyFrameInterval: 1, bitrate: L.bps,
      processedWidth: L.W, processedHeight: L.H,
      process: (sample) => {
        paintFrame(g, L, crop, (...a) => sample.draw(g, ...a), sample.displayWidth, sample.displayHeight,
          clockFor(sample.timestamp * 1000));
        return out;
      },
    },
    audio: audio || { discard: true },
  });
  if (!conv.isValid) {
    throw new Error(t('the clip could not be converted ({why})', { why: conv.discardedTracks.map(d => d.reason).join(', ') || '?' }));
  }
  await run(conv, signal, onProgress);
  if (!output.target.buffer?.byteLength) throw new Error(t('the encoder produced nothing'));
  return {
    blob: new Blob([output.target.buffer], { type: enc.mime }), ext: enc.ext, mime: enc.mime,
    // A clip with sound whose sound did not make it: the player says so.
    silent: !!audio && !conv.utilizedTracks.some(tr => tr.isAudioTrack()),
  };
}

/* The way that always works: play the clip once, at normal speed, drawing
   every frame onto the canvas, and record the canvas with MediaRecorder.
   Slower (it takes as long as the clip) and an MP4 only where the browser
   records MP4 (Chrome, Safari; Firefox makes a WebM), but it needs nothing
   beyond what filming the clip already needed. */
async function viaRecorder({ blob, L, crop, clockFor, onProgress, signal, sound }) {
  const types = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  const avTypes = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1,opus', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus'];
  const can = (m) => globalThis.MediaRecorder?.isTypeSupported?.(m);
  const mime = types.find(can);
  if (!mime) throw new Error(t('this browser cannot record video'));
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  // In the page (a detached video is not always decoded), but out of sight.
  Object.assign(v.style, { position: 'fixed', left: '0', top: '0', width: '2px', height: '2px', opacity: '0.01', pointerEvents: 'none' });
  const url = URL.createObjectURL(blob);
  v.src = url;
  document.body.append(v);
  let mr = null, stream = null, ac = null, heard = false;
  try {
    await new Promise((res, rej) => {
      v.onloadeddata = res;
      v.onerror = () => rej(new Error(t('the clip would not play')));
    });
    const out = canvas(L.W, L.H);
    const g = out.getContext('2d');
    const draw = (...a) => g.drawImage(v, ...a);
    const frame = () => paintFrame(g, L, crop, draw, v.videoWidth, v.videoHeight, clockFor(v.currentTime * 1000));
    frame();
    stream = out.captureStream(30);
    /* The clip's sound, taken from the video through Web Audio and into the
       recording. Once a media element feeds an audio graph it plays only
       through that graph, and this one never reaches the speakers, so
       unmuting it here is silent. */
    const avMime = sound ? avTypes.find(can) : null;
    if (avMime) {
      try {
        ac = new AudioContext();
        const dest = ac.createMediaStreamDestination();
        ac.createMediaElementSource(v).connect(dest);
        v.muted = false;
        ac.resume().catch(() => {});
        stream.addTrack(dest.stream.getAudioTracks()[0]);
        heard = true;
      } catch (err) {
        console.warn('[replay] no sound in the live recording', err);
        v.muted = true;
      }
    }
    mr = new MediaRecorder(stream, heard
      ? { mimeType: avMime, videoBitsPerSecond: L.bps, audioBitsPerSecond: 96_000 }
      : { mimeType: mime, videoBitsPerSecond: L.bps });
    const chunks = [];
    mr.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
    const stopped = new Promise((res) => { mr.onstop = res; });
    mr.start();
    const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : null;
    // Every animation frame, not every video frame: the clock has to move
    // smoothly even where the camera's own frames were few and far between.
    await new Promise((res, rej) => {
      const tick = () => {
        if (signal?.aborted) return rej(new DOMException('Cancelled', 'AbortError'));
        frame();
        if (dur) onProgress?.(Math.min(0.99, v.currentTime / dur));
        if (v.ended) return res();
        requestAnimationFrame(tick);
      };
      v.onended = () => { frame(); setTimeout(res, 120); };
      signal?.addEventListener('abort', () => rej(new DOMException('Cancelled', 'AbortError')));
      // Unmuted, a play() the browser will not allow without a fresh click: silent instead.
      v.play().catch((err) => {
        if (v.muted || err?.name !== 'NotAllowedError') throw err;
        v.muted = true;
        heard = false;
        return v.play();
      }).then(tick, rej);
    });
    mr.stop();
    await stopped;
    const type = mr.mimeType || mime;
    const made = new Blob(chunks, { type });
    // A recorder that never saw a frame still writes a header: that is not a video.
    if (made.size < 4096) throw new Error(t('nothing was recorded'));
    return { blob: made, ext: /mp4/.test(type) ? 'mp4' : 'webm', mime: type, silent: !!sound && !heard };
  } finally {
    if (mr && mr.state !== 'inactive') mr.stop();
    stream?.getTracks().forEach(tr => tr.stop());
    ac?.close().catch(() => {});
    v.pause();
    v.removeAttribute('src');
    v.load();
    v.remove();
    URL.revokeObjectURL(url);
  }
}

/**
 * The downloadable video. `meta` and `blob` are the stored clip, `solve` the
 * solve it belongs to (its penalty now, its scramble), `crop` the Reel's
 * square as fractions of the picture, `adj` this camera's clock delay in ms.
 * Tries WebCodecs first and falls back to recording it live, so a browser
 * whose encoder will not start still gets a file. Resolves
 * { blob, ext, mime, live, silent } (silent: the clip had sound and the file
 * does not); rejects with AbortError when `signal` fires.
 */
export async function exportVideo({ blob, meta, solve, layout = 'reel', crop = null, adj = 0, prec = 2, onProgress, signal }) {
  await fontsReady();
  const c = themeColors();
  const logo = await logoImage();
  let vw = meta.w || 640, vh = meta.h || 480;
  try {
    const track = await input(blob).getPrimaryVideoTrack();
    if (track?.displayWidth) { vw = track.displayWidth; vh = track.displayHeight; }
  } catch { /* the live route reads the size from the video itself */ }
  const timeMs = solve?.timeMs ?? meta.timeMs;
  const pen = solve?.penalty || 'none';
  const ev = solve?.event ? eventOf(solve.event) : null;
  const scramble = (solve?.scramble || '').replace(/\s+/g, ' ').trim();
  const when = [fmtDate(meta.at), meta.pb ? t('personal best') : ''].filter(Boolean).join('  ·  ');
  const info = {
    kicker: ev?.short || t('REPLAY'),
    event: ev?.name || '',
    when,
    line: [ev?.name, when].filter(Boolean).join('  ·  '),
    scramble,
    // A net only for a cube, and only for one scramble (a relay has several).
    n: scramble && !solve?.relay?.length ? cubeSizeFor(solve?.event || '333') : 0,
  };
  const L = (layout === 'wide' ? wideLayout : layout === 'clean' ? cleanLayout : reelLayout)(vw, vh, info, c, logo);
  const clockFor = (ms) => clockAt(meta, ms - adj, { timeMs, pen, prec });
  const job = { blob, L, crop, clockFor, onProgress, signal, sound: !!meta.sound };

  /* Firefox's encoder can fall over now and then, under load; a second go a
     moment later, with its tests run afresh, usually works, and costs a couple
     of seconds where recording it live costs the length of the clip. */
  let why;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return { ...(await viaWebCodecs(job, attempt > 0)), live: false };
    } catch (err) {
      if (err?.name === 'AbortError' || signal?.aborted) throw err;
      why = err;
      console.warn(`[replay] WebCodecs export failed (try ${attempt + 1})`, err);
      if (attempt === 0) { onProgress?.(0); await new Promise(r => setTimeout(r, 1500)); }
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    }
  }
  console.warn('[replay] recording it live instead');
  try {
    onProgress?.(0);
    return { ...(await viaRecorder(job)), live: true };
  } catch (err) {
    if (err?.name === 'AbortError' || signal?.aborted) throw err;
    throw new Error(`${why?.message || why}; ${err?.message || err}`);
  }
}
