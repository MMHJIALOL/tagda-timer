import { t } from './i18n.js';
/* ===========================================================
   Tagda Timer — webcam replay: the player

   A modal over everything: the clip, the clock in its own bar under it (never
   over the cube), a scrubber with the inspection and the solve marked on it,
   frame stepping, 0.25x/0.5x/1x, sound on and off for a clip that has it
   (muted until you unmute once; then remembered, webcamUnmute), and two menus: ⋯ (keep forever, clock delay,
   delete) and Save video, made by replay-media.js: a Reel (after you choose
   the square of the picture it shows, remembered per camera), a 16:9 with a
   panel beside the picture, or the clip as filmed with only a watermark.

   Two ways in: openPlayer, a solve's clip on this device, and
   openSharedPlayer, somebody's shared Scramble of the Day clip
   (sotd-replays.js), which is the same player without the parts that are
   only yours to use (keep, delete, clock delay, Save video).

   Every seek goes through seekTo(), which keeps one in flight and only the
   newest waiting: a burst of arrow presses or a dragged scrubber used to pile
   seeks onto a decoder that was still busy with the last one, and the picture
   stuttered behind the clock.

   Frame times come from the clip itself: stored with it once it is converted
   (replay.js), or read out of the recorder's WebM before then (webmFrames).
   Browsers disagree about which time a paused frame is at, and webcam frames
   do not come evenly, so the file is the only thing that knows.
   =========================================================== */

import { el, fmt, fmtDate, clamp } from './util.js';
import { toast } from './toast.js';
import { loadClip, forgetReplay, clockAt, cameraName, replaySettings, setReplaySetting,
         setPinned, deleteClip, holdFinish, TAIL_MS } from './replay.js';
import { eventOf } from './events.js';
import { competitionClockAt } from './competition-stats.js';

/**
 * Frame times, in seconds, of the blocks in a WebM file. Just enough EBML to
 * walk MediaRecorder's own output: the containers on the way to a block are
 * entered, everything else is skipped by its size, and a size of "unknown"
 * (a live recording's Segment and Clusters) is fine because those are entered.
 */
export function webmFrames(buf) {
  const b = new Uint8Array(buf);
  const uint = (p, n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + b[p + i]; return v; };
  const vint = (p, id) => {
    const first = b[p];
    if (!first || p >= b.length) return null;
    let len = 1, mask = 0x80;
    while (!(first & mask)) { len++; mask >>= 1; }
    if (p + len > b.length) return null;
    let v = id ? first : first & (mask - 1);
    let ones = (first & (mask - 1)) === mask - 1;
    for (let i = 1; i < len; i++) { v = v * 256 + b[p + i]; if (b[p + i] !== 0xff) ones = false; }
    return { v, len, unknown: !id && ones };
  };
  // Segment, Info, Cluster, BlockGroup, and Tracks and TrackEntry: a clip with
  // sound has audio blocks too, and only the video track's are frames.
  const ENTER = new Set([0x18538067, 0x1549A966, 0x1F43B675, 0xA0, 0x1654AE6B, 0xAE]);
  const out = [];
  let scale = 1e6, cluster = 0, p = 0, video = 0, entry = null;
  while (p < b.length) {
    const id = vint(p, true); if (!id) break;
    const size = vint(p + id.len, false); if (!size) break;
    const body = p + id.len + size.len;
    if (id.v === 0xAE) entry = {};
    if (ENTER.has(id.v)) { p = body; continue; }
    if (size.unknown || body + size.v > b.length) break;
    if (id.v === 0x2AD7B1) scale = uint(body, size.v);                  // TimecodeScale, ns a tick
    else if (id.v === 0xE7) cluster = uint(body, size.v);               // Cluster Timecode
    else if (entry && (id.v === 0xD7 || id.v === 0x83)) {              // TrackNumber, TrackType (1 is video)
      entry[id.v === 0xD7 ? 'num' : 'type'] = uint(body, size.v);
      if (entry.type === 1 && entry.num && !video) video = entry.num;
    } else if (id.v === 0xA3 || id.v === 0xA1) {                        // SimpleBlock, Block
      const tn = vint(body, false);
      if (!tn) break;
      if (video && tn.v !== video) { p = body + size.v; continue; }
      let rel = uint(body + tn.len, 2);
      if (rel & 0x8000) rel -= 0x10000;
      out.push((cluster + rel) * scale / 1e9);
    }
    p = body + size.v;
  }
  return out.sort((x, y) => x - y);
}

const ICON = {
  play: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke="none"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M8 5h3v14H8zM13 5h3v14h-3z" fill="currentColor" stroke="none"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>',
  fwd: '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>',
  start: '<svg viewBox="0 0 24 24"><path d="M7 5v14"/><path d="M18 6l-7 6 7 6"/></svg>',
  save: '<svg viewBox="0 0 24 24"><path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M5 19h14"/></svg>',
  more: '<svg viewBox="0 0 24 24"><circle cx="5.5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.6" fill="currentColor" stroke="none"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  sound: '<svg viewBox="0 0 24 24"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor" stroke="none"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a7.8 7.8 0 0 1 0 11"/></svg>',
  muted: '<svg viewBox="0 0 24 24"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor" stroke="none"/><path d="M16 9.5l5 5M21 9.5l-5 5"/></svg>',
};

let dlg = null;

const SUFFIX = { reel: 'reel', wide: '16x9', clean: 'original' };
const fileName = (final, m, solve, layout, ext) => [
  'tagda', final.replace(/[:.]/g, '-'), solve?.event ? eventOf(solve.event).short : '',
  new Date(m.at).toISOString().slice(0, 10), SUFFIX[layout] || layout,
].filter(Boolean).join('-').replace(/[^\w.-]+/g, '') + `.${ext}`;

function saveFile(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: name, style: { display: 'none' } });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Play a solve's clip. `solve` may be the solve itself, which is preferred:
 * its penalty is read now, so a +2 added after the fact shows at the stop.
 */
export async function openPlayer(solve) {
  const id = typeof solve === 'string' ? solve : solve?.id;
  if (!id) return;
  dlg?.close();
  const got = await loadClip(id).catch((err) => { console.warn('[replay] load', err); return null; });
  if (!got) { forgetReplay(id); toast(t('That replay is gone')); return; }
  const sv = typeof solve === 'object' ? solve : null;
  const camName = got.meta.cam || '';
  show({
    id, m: got.meta, blob: got.blob, sv, timeMs: sv?.timeMs ?? got.meta.timeMs, pen: sv?.penalty || 'none',
    camName, adj: (replaySettings().webcamSync || {})[camName] || 0,
  });
}

/**
 * Somebody's shared Scramble of the Day clip (sotd-replays.js): `meta` is the
 * Worker's, with the uploader's own clock delay in it (`adj`). Under their
 * name, and with nothing to keep, delete, line up or save, because it is not
 * yours. `onRemove` (admins only) takes it down for everyone; it resolves
 * whether it did, and is asked about inside the player first.
 */
export function openSharedPlayer({ blob, meta, timeMs, penalty = 'none', name = '', onRemove = null }) {
  dlg?.close();
  show({
    id: null, m: meta, blob, sv: null, timeMs: timeMs ?? meta.timeMs, pen: penalty || 'none',
    camName: '', adj: Number(meta.adj) || 0, shared: { name, onRemove },
  });
}

export function openCompetitionPlayer(set, solves, replay) {
  dlg?.close();
  const timed = solves.filter(s => s?.competitionTiming);
  show({ id: set.id, m: { ...replay.meta, start: timed[0]?.competitionTiming.start ?? 0,
    stop: timed.at(-1)?.competitionTiming.stop ?? replay.meta.durationMs }, blob: replay.blob,
    sv: null, timeMs: replay.meta.durationMs, pen: 'none', camName: '', adj: 0,
    competition: { set, solves } });
}

function show({ id, m, blob, sv, timeMs, pen, camName, adj, shared = null, competition = null }) {
  const S = replaySettings();
  const url = URL.createObjectURL(blob);
  const prec = S.precision === 3 ? 3 : 2;
  const fps = clamp(m.fps || 30, 5, 120);
  const final = competition ? `Ao${competition.set.size} · ${t('Set {n}', { n: competition.set.sequence })}` : fmt(timeMs, { showMs: prec === 3 });
  // `adj`: ms this camera's picture runs behind the clock (the uploader's, for a shared clip).
  let pinned = !!m.pinned;
  const ac = new AbortController();               // every window listener, and an export, go with the player

  /* ---- the parts ---- */
  const video = el('video', { class: 'rp-video', playsinline: true, preload: 'auto', 'aria-label': t('Solve video') });
  video.muted = true;
  video.src = url;
  const stage = el('div', { class: 'rp-stage' }, video);

  const phaseEl = el('span', { class: 'rp-phase' });
  const timeEl = el('span', { class: 'rp-time', text: '—' });
  const penEl = el('span', { class: 'rp-pen' });
  const clock = el('div', { class: 'rp-clock' }, phaseEl, el('span', { class: 'rp-digits' }, timeEl, penEl));

  const seek = el('input', { type: 'range', class: 'rp-seek', min: 0, max: 1, step: 'any', value: 0, 'aria-label': t('Position in the video') });
  const marks = el('div', { class: 'rp-marks', 'aria-hidden': 'true' });
  const bar = el('div', { class: 'rp-bar' }, marks, seek);

  const btn = (icon, title, onclick, cls = '') => el('button', { class: `rp-btn ${cls}`, title, 'aria-label': title, html: ICON[icon], onclick });
  const playBtn = btn('play', t('Play / pause  (Space)'), () => togglePlay(), 'rp-play');
  playBtn.autofocus = true;
  const speeds = el('div', { class: 'chips rp-speeds' }, ...[0.25, 0.5, 1].map(rate => el('button', {
    class: `chip ${rate === 1 ? 'on' : ''}`, text: `${rate}×`, dataset: { rate },
    onclick: () => setRate(rate),
  })));
  // A shared clip has nothing under ⋯ but an admin's Remove.
  const moreBtn = competition || (shared && !shared.onRemove) ? null : btn('more', t('More'), () => openMenu(moreBtn, moreItems()), 'rp-more');
  // Only a clip filmed with sound has the button. It opens muted the first
  // time; unmuting is remembered for every replay after.
  const soundBtn = m.sound ? btn('muted', t('Sound on / off  (M)'), () => setMuted(!video.muted), 'rp-mute') : null;
  const setMuted = (muted, remember = true) => {
    video.muted = muted;
    if (!soundBtn) return;
    soundBtn.innerHTML = muted ? ICON.muted : ICON.sound;
    soundBtn.setAttribute('aria-pressed', String(!muted));
    if (remember && !!replaySettings().webcamUnmute === muted) setReplaySetting('webcamUnmute', !muted);
  };
  const saveBtn = shared ? null : el('button', {
    class: 'btn primary rp-save', html: `${ICON.save}<span>${t('Save video')}</span>`, title: t('Download as a video file'),
    onclick: () => openMenu(saveBtn, [
      { label: t('Reel  ·  9:16'), sub: competition ? t('Square video with the attempt clock below. For Instagram, TikTok, Shorts') : t('choose a square of the picture; the clock, the scrambled cube and the scramble go under it. For Instagram, TikTok, Shorts'), run: () => chooseCrop('reel') },
      { label: t('Landscape  ·  16:9'), sub: competition ? t('Video with the attempt clock in the side panel') : t('choose the part of the picture that fills the left, with the clock, the cube and the scramble in a panel beside it'), run: () => chooseCrop('wide') },
      { label: t('Original  ·  as filmed'), sub: t('just the video, with a small tagdatimer.me in the corner'), run: () => makeVideo('clean') },
    ]),
  });
  const controls = el('div', { class: 'rp-controls' },
    el('div', { class: 'rp-transport' },
      playBtn,
      btn('back', t('Previous frame  (←)'), () => step(-1)),
      btn('fwd', t('Next frame  (→)'), () => step(1)),
      btn('start', t('Jump to the start of the solve  (Home)'), () => jump(m.start)),
    ),
    speeds,
    el('div', { class: 'rp-extra' }, soundBtn, moreBtn, saveBtn),
  );

  // Clock delay, under ⋯: what used to be "Sync".
  const delayNote = el('span', { class: 'rp-sync-note' });
  const syncBox = shared || competition ? null : el('div', { class: 'rp-sync', hidden: true },
    el('p', { text: t('Clock ahead of your hands? Pause on the frame where your hand stops the timer (← and → step a frame) and press Stopped here. It is remembered for this camera.') }),
    el('div', { class: 'rp-sync-row' },
      el('button', { class: 'btn primary', text: t('Stopped here'), onclick: () => setAdj(shown * 1000 - m.stop) }),
      el('button', { class: 'ghost-btn sm', text: t('Reset'), onclick: () => setAdj(0) }),
      delayNote,
      el('button', { class: 'ghost-btn sm rp-sync-close', text: t('Done'), onclick: () => { syncBox.hidden = true; fit(); } })),
  );

  // Making a video: progress, then Share / Save.
  const exportBox = el('div', { class: 'rp-export', hidden: true });

  const pinChip = shared || competition ? null : el('span', { class: 'rp-pin', hidden: !pinned, text: m.pb ? t('PB · kept') : t('kept') });
  const head = el('div', { class: 'rp-head' },
    el('div', { class: 'rp-title' },
      el('b', { text: final + (pen === '+2' ? ' +2' : pen === 'DNF' ? ' DNF' : '') }),
      pinChip,
      competition && m.status !== 'ready' ? el('span', { class: 'rp-who', text: t('Interrupted footage') }) : null,
      shared ? el('span', { class: 'rp-who', text: shared.name || 'Cuber' }) : null,
      el('span', { text: [fmtDate(m.at), camName && cameraName(camName)].filter(Boolean).join(' · ') })),
    btn('close', t('Close  (Esc)'), () => d.close(), 'rp-close'),
  );

  const d = dlg = el('dialog', { class: 'replay-dlg', 'aria-label': t('Replay') },
    head, stage, clock, bar, controls, syncBox, exportBox);

  /* ---- frames ---- */
  let frames = Array.isArray(m.frames) && m.frames.length > 1 ? m.frames : null;
  const frameIndex = (sec) => {    // the frame on screen at `sec`: the last one at or before it
    if (sec < frames[0]) return 0;
    let lo = 0, hi = frames.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (frames[mid] <= sec + 1e-4) lo = mid; else hi = mid - 1; }
    return lo;
  };
  const snap = (sec) => (frames ? frames[frameIndex(sec)] : sec);
  if (!frames && /webm/.test(m.mime || blob.type) && blob.size < 128 * 1024 * 1024) {
    blob.arrayBuffer().then((buf) => {
      const f = webmFrames(buf);
      if (f.length < 2 || !d.isConnected) return;
      frames = f;
      seek.max = String(dur());
      paintMarks();
      render(video.paused ? video.currentTime : shown);
    }).catch(err => console.warn('[replay] could not read frame times', err));
  }

  /* ---- the clock ---- */
  let shown = 0;                  // media time of the frame on screen, in seconds
  let last = '';
  let dragging = false;
  const render = (sec) => {
    sec = snap(sec);
    shown = sec;
    const k = competition ? competitionClockAt(competition.set, competition.solves, sec * 1000) : clockAt(m, sec * 1000 - adj, { timeMs, pen, prec });
    const key = `${k.phase}|${k.text}|${k.kind}|${k.pen}`;
    if (key !== last) {
      last = key;
      phaseEl.textContent = k.phase;
      timeEl.textContent = k.text;
      penEl.textContent = k.pen || '';
      clock.className = `rp-clock ${k.kind === 'late' ? 'insp late' : k.kind}`;
    }
    if (!dragging) seek.value = String(sec);
  };

  const dur = () => (Number.isFinite(video.duration) && video.duration > 0 ? video.duration
    : frames ? frames.at(-1) + 1 / fps : competition ? m.durationMs / 1000 : (m.stop + TAIL_MS) / 1000);

  const paintMarks = () => {
    const D = dur() * 1000;
    const pct = (ms) => `${clamp((ms + adj) / D * 100, 0, 100)}%`;
    if (competition) {
      marks.replaceChildren(...competition.solves.filter(s => s?.competitionTiming).flatMap(s => {
        const k = s.competitionTiming;
        return [el('i', { class: 'rp-solve', style: { left: pct(k.start), width: `calc(${pct(k.stop)} - ${pct(k.start)})` } }),
          ...(k.inspection != null ? [el('i', { class: 'rp-mark insp', style: { left: pct(k.inspection) } })] : [])];
      }));
      return;
    }
    // Filtered: replaceChildren() would print a null as the word "null".
    marks.replaceChildren(...[
      el('i', { class: 'rp-solve', style: { left: pct(m.start), width: `calc(${pct(m.stop)} - ${pct(m.start)})` } }),
      m.insp != null ? el('i', { class: 'rp-mark insp', style: { left: pct(m.insp) } }) : null,
      ...(m.splits || []).map(s => el('i', { class: 'rp-mark split', style: { left: pct(m.start + s) } })),
    ].filter(Boolean));
  };

  /* requestVideoFrameCallback hands over the media time of the frame actually
     being shown while it plays, so the clock and the picture change together.
     Paused, 'seeked' says which frame is up. */
  const rvfc = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
  let vfc = 0, raf = 0, sawFrame = false;
  const onFrame = (now, md) => {
    sawFrame = true;
    if (!(frames && video.paused)) render(md.mediaTime);
    vfc = video.requestVideoFrameCallback(onFrame);
  };
  const loop = () => { render(video.currentTime); if (!video.paused) raf = requestAnimationFrame(loop); };
  if (rvfc) vfc = video.requestVideoFrameCallback(onFrame);
  video.addEventListener('play', () => { playBtn.innerHTML = ICON.pause; if (!rvfc) loop(); });
  video.addEventListener('pause', () => { playBtn.innerHTML = ICON.play; render(rvfc && sawFrame ? shown : video.currentTime); });
  video.addEventListener('ended', () => { playBtn.innerHTML = ICON.play; });

  /* ---- seeking: one at a time, newest wins ---- */
  let want = null;                // where to go once the seek in flight lands
  let aim = null;                 // where the last seek asked to go, until it lands
  const seekTo = (sec) => {
    sec = clamp(sec, 0, dur());
    aim = sec;
    if (video.seeking) { want = sec; return; }
    video.currentTime = sec;
  };
  video.addEventListener('seeking', () => { sawFrame = false; });
  video.addEventListener('seeked', () => {
    if (want != null) { const s = want; want = null; video.currentTime = s; return; }
    aim = null;
    if (frames && video.paused) { render(video.currentTime); return; }
    // A paused seek does present a frame, but not every browser reports it.
    setTimeout(() => { if (!sawFrame) render(video.currentTime); }, 150);
  });
  video.addEventListener('loadedmetadata', () => { seek.max = String(dur()); paintMarks(); fit(); render(0); });
  video.addEventListener('durationchange', () => { seek.max = String(dur()); paintMarks(); });
  video.addEventListener('error', () => {
    stage.replaceChildren(el('p', { class: 'rp-err', text: t('This browser cannot play this clip') }));
  });

  /* ---- controls ---- */
  seek.addEventListener('pointerdown', () => { dragging = true; });
  addEventListener('pointerup', () => { dragging = false; }, { signal: ac.signal });
  seek.addEventListener('input', () => { seekTo(+seek.value); render(+seek.value); });

  const togglePlay = () => {
    if (video.paused || video.ended) {
      if (video.ended || video.currentTime >= dur() - 0.05) seekTo(0);
      video.play().catch(() => {});
    } else video.pause();
  };
  /* A hair past the frame's own time, so rounding cannot land on the one
     before. Without frame times (an MP4 recorded by Safari, until it is
     converted), a frame's worth either way is the best that can be done. */
  const step = (n) => {
    video.pause();
    const from = aim ?? (rvfc && sawFrame ? shown : video.currentTime);
    if (frames) {
      const i = clamp(frameIndex(from) + n, 0, frames.length - 1);
      seekTo(frames[i] + 1e-4);
      render(frames[i]);
    } else {
      seekTo(from + n / fps + 0.001);
    }
  };
  /** The first frame at or after `ms` on the solve's clock. */
  const jump = (ms) => {
    const sec = (ms + adj) / 1000;
    if (!frames) return seekTo(sec);
    const i = frameIndex(sec);
    const at = frames[i] + 1e-4 < sec && i + 1 < frames.length ? frames[i + 1] : frames[i];
    seekTo(at + 1e-4);
  };
  const setRate = (rate) => {
    video.playbackRate = rate;
    for (const b of speeds.children) b.classList.toggle('on', +b.dataset.rate === rate);
  };
  const paintDelay = () => {
    const name = cameraName(camName) || t('this camera');
    delayNote.textContent = adj
      ? t('{camera}: clock moved {s} s', { camera: name, s: `${adj > 0 ? '+' : ''}${(adj / 1000).toFixed(2)}` })
      : t('No correction for {camera}', { camera: name });
  };
  const setAdj = (v) => {
    // Down, not to the nearest: the frame it was set on must read "stopped".
    adj = Math.floor(clamp(v, -2000, 2000));
    if (camName) setReplaySetting('webcamSync', { ...(replaySettings().webcamSync || {}), [camName]: adj });
    last = '';
    paintDelay();
    paintMarks();
    render(shown);
  };

  /* ---- menus, drawn inside the dialog (a page popover would sit under it) ---- */
  let menu = null;
  const closeMenu = () => { menu?.remove(); menu = null; };
  function openMenu(anchor, items) {
    if (menu) { const same = menu.anchor === anchor; closeMenu(); if (same) return; }
    const box = el('div', { class: 'rp-menu', role: 'menu' }, ...items.map(it => el('button', {
      class: `rp-menu-item ${it.danger ? 'danger' : ''}`, role: it.check == null ? 'menuitem' : 'menuitemcheckbox',
      'aria-checked': it.check == null ? null : String(!!it.check),
      onclick: (e) => { e.stopPropagation(); closeMenu(); it.run(); },
    },
      it.check == null ? null : el('span', { class: `rp-check ${it.check ? 'on' : ''}`, 'aria-hidden': 'true' }),
      el('span', { class: 'rp-menu-text' }, el('b', { text: it.label }), it.sub ? el('span', { text: it.sub }) : null))));
    box.anchor = anchor;
    d.append(box);
    const dr = d.getBoundingClientRect(), ar = anchor.getBoundingClientRect(), br = box.getBoundingClientRect();
    box.style.left = `${clamp(ar.right - br.width - dr.left + d.scrollLeft, 8, dr.width - br.width - 8)}px`;
    const above = ar.top - dr.top - br.height - 6;
    box.style.top = `${(above >= 8 ? above : ar.bottom - dr.top + 6) + d.scrollTop}px`;
    menu = box;
    box.querySelector('button')?.focus();
  }
  /* Questions and answers stay inside the player: a modal dialog makes the
     rest of the page inert, so a toast's buttons could not be pressed while it
     was up (and its text sat under the backdrop). */
  const ask = (text, yesLabel, yes) => {
    exportBox.replaceChildren(el('div', { class: 'rp-export-row' },
      el('span', { text }),
      el('button', { class: 'btn danger', text: yesLabel, onclick: yes }),
      el('button', { class: 'ghost-btn sm', text: t('Cancel'), onclick: () => { exportBox.hidden = true; fit(); } })));
    exportBox.hidden = false;
    fit();
  };
  const moreItems = () => shared ? [
    { label: t('Remove this replay'), sub: t('for everyone · admin'), danger: true, run: () => ask(
      t('Remove this replay for everyone?'), t('Remove'), async () => { if (await shared.onRemove()) d.close(); }) },
  ] : [
    { label: t('Keep forever'), sub: t('never deleted to make room'), check: pinned, run: async () => {
      pinned = !pinned;
      await setPinned(id, pinned);
      pinChip.textContent = m.pb ? t('PB · kept') : t('kept');
      pinChip.hidden = !pinned;
    } },
    { label: t('Clock delay…'), sub: t('line the clock up with your hands'), run: () => { syncBox.hidden = false; paintDelay(); fit(); } },
    { label: t('Delete this replay'), danger: true, run: () => ask(t('Delete this replay? The solve itself stays.'), t('Delete'), async () => {
      await deleteClip(id);
      d.close();
      toast(t('Replay deleted'));
    }) },
  ];

  /* ---- choosing the part of the picture a video shows ----
     A frame over the paused picture, the shape of the video's box (a square
     for the Reel, 4:3 for Landscape), dragged where the solve is and sized with
     the slider (or the wheel); outside it is dimmed. Play or scrub while it is
     up to check the hands stay inside. Kept per camera and per layout, as
     fractions of the picture, in webcamCrop, so the next one starts there. */
  let cropUI = null;
  const CROP = {
    reel: { aspect: 1, key: '', label: t('The square the reel shows'), hint: t('Drag the square over your solve. That is what the reel shows.'), make: t('Make the reel') },
    wide: { aspect: 4 / 3, key: '|wide', label: t('The part the video shows'), hint: t('Drag the frame over your solve. It fills the left of the video.'), make: t('Make the video') },
  };
  function endCrop() {
    if (!cropUI) return;
    cropUI.layer.remove();
    cropUI = null;
    stage.classList.remove('cropping');
    if (!making) { exportBox.hidden = true; fit(); }
  }
  function chooseCrop(layout) {
    if (cropUI || making) return;
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return makeVideo(layout);
    video.pause();
    const C = CROP[layout], A = C.aspect, cropKey = (camName || '_') + C.key;
    // S is the frame's height; at its largest it touches two edges of the picture.
    const side = Math.min(vh, vw / A);
    const saved = (replaySettings().webcamCrop || {})[cropKey];
    let S = side * clamp(saved?.s ?? 1, 0.3, 1);
    let X = saved ? saved.x * vw : (vw - S * A) / 2;
    let Y = saved ? saved.y * vh : (vh - S) / 2;
    const box = el('div', { class: 'rp-crop-box', role: 'group', 'aria-label': C.label });
    const layer = el('div', { class: 'rp-crop' }, box);
    stage.append(layer);
    stage.classList.add('cropping');
    // Where the picture really is inside the <video> box (object-fit: contain).
    const picture = () => {
      const r = video.getBoundingClientRect(), sr = stage.getBoundingClientRect();
      const k = Math.min(r.width / vw, r.height / vh);
      return { x: r.left - sr.left + (r.width - vw * k) / 2, y: r.top - sr.top + (r.height - vh * k) / 2, k };
    };
    const place = () => {
      if (!cropUI) return;
      S = clamp(S, side * 0.3, side);
      X = clamp(X, 0, vw - S * A);
      Y = clamp(Y, 0, vh - S);
      const p = picture();
      Object.assign(layer.style, { left: `${p.x}px`, top: `${p.y}px`, width: `${vw * p.k}px`, height: `${vh * p.k}px` });
      Object.assign(box.style, { left: `${X * p.k}px`, top: `${Y * p.k}px`, width: `${S * A * p.k}px`, height: `${S * p.k}px` });
      size.value = String(Math.round(S / side * 100));
    };
    const resize = (pct) => {
      const cx = X + S * A / 2, cy = Y + S / 2;
      S = side * clamp(pct, 30, 100) / 100;
      X = cx - S * A / 2;
      Y = cy - S / 2;
      place();
    };
    box.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { box.setPointerCapture(e.pointerId); } catch { /* moves still arrive while over the box */ }
      const k = picture().k, x0 = e.clientX, y0 = e.clientY, X0 = X, Y0 = Y;
      const move = (ev) => { X = X0 + (ev.clientX - x0) / k; Y = Y0 + (ev.clientY - y0) / k; place(); };
      /* The drag ends however the button comes up: on the box, anywhere else
         on the page, or with the capture lost. A capture left behind would
         swallow every click after it, "Make the reel" included. */
      const end = () => {
        box.removeEventListener('pointermove', move);
        box.removeEventListener('lostpointercapture', end);
        removeEventListener('pointerup', end, true);
        removeEventListener('pointercancel', end, true);
        try { if (box.hasPointerCapture(e.pointerId)) box.releasePointerCapture(e.pointerId); } catch { /* gone already */ }
      };
      box.addEventListener('pointermove', move);
      box.addEventListener('lostpointercapture', end);
      addEventListener('pointerup', end, true);
      addEventListener('pointercancel', end, true);
    });
    layer.addEventListener('wheel', (e) => { e.preventDefault(); resize(S / side * 100 - Math.sign(e.deltaY) * 5); }, { passive: false });
    const size = el('input', { type: 'range', min: 30, max: 100, step: 1, 'aria-label': t('Size of the square') });
    size.addEventListener('input', () => resize(+size.value));
    exportBox.replaceChildren(el('div', { class: 'rp-export-row rp-crop-row' }, ...[
      el('span', { text: C.hint }),
      el('label', { class: 'rp-crop-size' }, el('span', { text: t('Size') }), size),
      el('button', { class: 'ghost-btn sm', text: t('Middle'), onclick: () => { S = side; X = (vw - S * A) / 2; Y = (vh - S) / 2; place(); } }),
      // Landscape can also take the picture as it is, bars and all.
      layout === 'wide' ? el('button', { class: 'ghost-btn sm', text: t('Whole picture'), onclick: () => makeVideo('wide') }) : null,
      el('button', { class: 'ghost-btn sm', text: t('Cancel'), onclick: () => endCrop() }),
      el('button', { class: 'btn primary', text: C.make, onclick: () => {
        setReplaySetting('webcamCrop', { ...(replaySettings().webcamCrop || {}), [cropKey]: { x: X / vw, y: Y / vh, s: S / side } });
        makeVideo(layout, { x: X / vw, y: Y / vh, w: S * A / vw, h: S / vh });
      } })].filter(Boolean)));
    exportBox.hidden = false;
    cropUI = { layer, place };
    fit();
    requestAnimationFrame(place);
  }
  addEventListener('resize', () => cropUI?.place(), { signal: ac.signal });

  /* ---- Save video ---- */
  let making = null;              // the AbortController of an export under way
  async function makeVideo(layout, crop = null) {
    if (making) return;
    endCrop();
    const job = making = new AbortController();
    const release = holdFinish();
    const onClose = () => job.abort();
    ac.signal.addEventListener('abort', onClose);
    video.pause();
    saveBtn.disabled = true;
    const label = layout === 'reel' ? t('Making the reel…') : t('Making the video…');
    const pct = el('b', { text: '0%' });
    const fill = el('i');
    exportBox.replaceChildren(
      el('div', { class: 'rp-export-row' }, el('span', { text: label }), pct,
        el('button', { class: 'ghost-btn sm', text: t('Cancel'), onclick: () => job.abort() })),
      el('div', { class: 'rp-progress' }, fill));
    exportBox.hidden = false;
    fit();
    try {
      const mod = await import('./replay-media.js');
      const out = await mod.exportVideo({
        blob, meta: m, solve: sv, layout, crop, adj, prec, signal: job.signal, competition,
        onProgress: (p) => { pct.textContent = `${Math.round(p * 100)}%`; fill.style.width = `${p * 100}%`; },
      });
      const name = competition ? `tagda-Ao${competition.set.size}-set-${competition.set.sequence}${m.status === 'ready' ? '' : '-interrupted'}-${SUFFIX[layout]}.${out.ext}` : fileName(final, m, sv, layout, out.ext);
      const file = new File([out.blob], name, { type: out.mime });
      const mb = (out.blob.size / 1048576).toFixed(1);
      // A phone shares straight into Instagram or a chat; that needs a fresh tap.
      const share = navigator.canShare?.({ files: [file] }) && matchMedia('(pointer: coarse)').matches;
      exportBox.replaceChildren(el('div', { class: 'rp-export-row' },
        el('span', { text: (share ? t('Ready · {mb} MB', { mb }) : t('Saved {name} · {mb} MB', { name, mb }))
          + (out.ext === 'mp4' ? '' : ` · ${t('a WebM: this browser cannot make MP4s')}`)
          + (out.silent ? ` · ${t('no sound: this browser could not add it')}` : '') }),
        share ? el('button', { class: 'btn primary', text: t('Share'), onclick: () => navigator.share({ files: [file] }).catch(() => {}) }) : null,
        el('button', { class: 'ghost-btn sm', text: share ? t('Save') : t('Save again'), onclick: () => saveFile(out.blob, name) }),
        el('button', { class: 'ghost-btn sm', text: t('Done'), onclick: () => { exportBox.hidden = true; fit(); } })));
      if (!share) saveFile(out.blob, name);
      exportBox.dataset.done = layout;
    } catch (err) {
      if (err?.name === 'AbortError') { exportBox.hidden = true; }
      else {
        console.warn('[replay] export', err);
        exportBox.replaceChildren(el('div', { class: 'rp-export-row' },
          el('span', { text: t('Could not make the video: {err}', { err: err?.message || err?.name || '?' }) }),
          el('button', { class: 'ghost-btn sm', text: t('Done'), onclick: () => { exportBox.hidden = true; fit(); } })));
      }
    } finally {
      ac.signal.removeEventListener('abort', onClose);
      release();
      making = null;
      saveBtn.disabled = false;
      if (d.isConnected) fit();
    }
  }

  /* ---- fitting it on screen ----
     The clock and controls always show in full; the picture takes whatever
     height is left. A phone on its side gets them beside the picture instead. */
  const fit = () => {
    if (!d.isConnected) return;
    const side = innerWidth > innerHeight * 1.25 && innerHeight < 560;
    d.classList.toggle('rp-side', side);
    video.style.maxHeight = '';
    const room = innerHeight - 24 - (side ? head.offsetHeight + 24 : d.offsetHeight - stage.offsetHeight);
    video.style.maxHeight = `${Math.max(120, Math.floor(room))}px`;
    cropUI?.place();
  };
  addEventListener('resize', fit, { signal: ac.signal });

  d.addEventListener('keydown', (e) => {
    // The keys belong to the player while it is up, not to the shortcuts behind it.
    e.stopPropagation();
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (menu && e.key !== 'Escape') return;        // a menu's buttons take Enter and Tab as usual
    const k = e.key;
    if (k === ' ' || k === 'k' || k === 'K') { e.preventDefault(); togglePlay(); }
    else if (k === 'ArrowLeft' || k === ',') { e.preventDefault(); e.shiftKey ? jump(shown * 1000 - adj - 1000) : step(-1); }
    else if (k === 'ArrowRight' || k === '.') { e.preventDefault(); e.shiftKey ? jump(shown * 1000 - adj + 1000) : step(1); }
    else if ((k === 'm' || k === 'M') && soundBtn) { e.preventDefault(); setMuted(!video.muted); }
    else if (k === 'Home') { e.preventDefault(); jump(m.start); }
    else if (k === 'End') { e.preventDefault(); jump(m.stop); }
  });
  // Escape closes an open menu first, the player after.
  d.addEventListener('cancel', (e) => {
    if (menu) { e.preventDefault(); closeMenu(); }
    else if (cropUI) { e.preventDefault(); endCrop(); }
  });
  d.addEventListener('click', (e) => {
    if (menu && !menu.contains(e.target) && !menu.anchor.contains(e.target)) closeMenu();
    if (e.target !== d) return;
    // A click on the dimmed page around it closes it, as a popover would.
    const r = d.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close();
  });
  d.addEventListener('close', () => {
    ac.abort();
    if (vfc) video.cancelVideoFrameCallback?.(vfc);
    cancelAnimationFrame(raf);
    video.pause();
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
    d.remove();
    if (dlg === d) dlg = null;
  });

  document.body.append(d);
  d.showModal();
  if (!shared && !competition) paintDelay();
  fit();
  setMuted(!(m.sound && S.webcamUnmute), false);
  // Unmuted, a browser may refuse to start without a fresh click: then muted, as the first time.
  video.play().catch((err) => {
    if (video.muted || err?.name !== 'NotAllowedError') return;
    setMuted(true, false);
    video.play().catch(() => {});
  });
}
