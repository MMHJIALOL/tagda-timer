/* ===========================================================
   Tagda Timer — the share sheet

   Shows the rendered card, then the three things anyone actually wants
   to do with it: put it on the clipboard, save the PNG, or hand it to
   whatever the device shares with.
   =========================================================== */

import { el, download, fmt } from './util.js';
import { eff, DNF } from './stats.js';
import { toast } from './toast.js';
import {
  drawSolveCard, drawAverageCard, canvasBlob, shareText, socialLinks,
  SITE, SITE_URL, INSTA, INSTA_URL,
} from './sharecard.js';

let host = null;

export const shareOpen = () => !!host;

export function closeShare() {
  if (!host) return;
  host.remove();
  host = null;
  document.removeEventListener('keydown', onKey, true);
}

function onKey(e) {
  if (e.key === 'Escape') { e.stopPropagation(); closeShare(); }
}

/* Building SVG through el() would produce HTML elements, which never render
   inside an <svg>. These are small enough to hand-write. */
const svg = (html) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('class', 'sh-ico');
  s.innerHTML = html;
  return s;
};

const ICONS = {
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/>',
  save: '<path d="M12 3v12M7 11l5 5 5-5M4 20h16"/>',
  share: '<path d="M4 12v7a2 2 0 002 2h12a2 2 0 002-2v-7M12 3v13M8 7l4-4 4 4"/>',
};

/**
 * Open the sheet for an already-drawn canvas.
 * `filename` and `text` are what the save and the social links use.
 */
function present(canvas, { title, filename, text }) {
  closeShare();

  const stage = el('div', { class: 'sh-stage' });
  canvas.classList.add('sh-canvas');
  stage.append(canvas);

  const busy = (btn, fn) => async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    try { await fn(); } finally { btn.disabled = false; }
  };

  const copyBtn = el('button', { class: 'sh-act primary' }, svg(ICONS.copy), el('span', { text: 'Copy image' }));
  copyBtn.addEventListener('click', busy(copyBtn, async () => {
    const blob = await canvasBlob(canvas);
    // Only Chromium-family browsers put a PNG on the clipboard. Everywhere
    // else, say so rather than pretending it worked.
    if (!blob || !window.ClipboardItem || !navigator.clipboard?.write) {
      toast('This browser cannot copy images — use save instead', { kind: 'bad' });
      return;
    }
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast('Card copied to the clipboard', { kind: 'good' });
    } catch {
      toast('The clipboard was blocked — use save instead', { kind: 'bad' });
    }
  }));

  const saveBtn = el('button', { class: 'sh-act' }, svg(ICONS.save), el('span', { text: 'Save image' }));
  saveBtn.addEventListener('click', busy(saveBtn, async () => {
    const blob = await canvasBlob(canvas);
    if (!blob) { toast('Could not render the image', { kind: 'bad' }); return; }
    download(filename, blob, 'image/png');
    toast('Saved', { kind: 'good' });
  }));

  const shareBtn = el('button', { class: 'sh-act' }, svg(ICONS.share), el('span', { text: 'Share' }));
  shareBtn.addEventListener('click', busy(shareBtn, async () => {
    const blob = await canvasBlob(canvas);
    const file = blob ? new File([blob], filename, { type: 'image/png' }) : null;
    // The native sheet is the good path — it reaches Instagram, which has no
    // web share endpoint of its own. The links below are the fallback.
    if (file && navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], text, title: 'Tagda Timer' });
        return;
      } catch (err) {
        if (err?.name === 'AbortError') return;
      }
    }
    toast('No share sheet here — pick a network below, or save the image');
  }));

  const links = el('div', { class: 'sh-links' },
    ...socialLinks(text).map(l =>
      el('a', { class: 'sh-link', href: l.href, target: '_blank', rel: 'noopener noreferrer', text: l.name })),
  );

  const foot = el('div', { class: 'sh-foot' },
    el('a', { class: 'sh-cred', href: SITE_URL, target: '_blank', rel: 'noopener noreferrer', text: SITE }),
    el('span', { class: 'sh-dot', text: '·' }),
    el('a', { class: 'sh-cred insta', href: INSTA_URL, target: '_blank', rel: 'noopener noreferrer', text: INSTA }),
  );

  host = el('div', { class: 'sh-wrap' },
    el('div', { class: 'sh-scrim', onclick: closeShare }),
    el('div', { class: 'sh-box', role: 'dialog', 'aria-label': title },
      el('div', { class: 'sh-head' },
        el('h2', { text: title }),
        el('button', { class: 'icon-btn', title: 'Close (Esc)', onclick: closeShare },
          svg('<path d="M6 6l12 12M18 6L6 18"/>')),
      ),
      stage,
      el('div', { class: 'sh-acts' }, copyBtn, saveBtn, shareBtn),
      el('div', { class: 'sh-share-row' }, el('span', { class: 'sh-share-lbl', text: 'share to' }), links),
      foot,
    ),
  );
  document.body.append(host);
  document.addEventListener('keydown', onKey, true);
}

const stamp = (ts) => new Date(ts || Date.now()).toISOString().slice(0, 10);
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** One solve: time, scramble, and the scrambled cube. */
export async function shareSolve(solve, { index = null } = {}) {
  toast('Rendering card…');
  const canvas = await drawSolveCard(solve, { index });
  const value = eff(solve) === DNF ? 'DNF' : fmt(eff(solve));
  present(canvas, {
    title: 'Share this solve',
    filename: `tagda-solve-${stamp(solve.createdAt)}.png`,
    text: shareText('Single', value),
  });
}

/** An average: only the counting times and their scrambles, as asked. */
export async function shareAverage(solves, { label, value, trimmed } = {}) {
  if (!solves?.length) { toast('Nothing to share yet'); return; }
  toast('Rendering card…');
  const canvas = await drawAverageCard(solves, { label, value, trimmed });
  present(canvas, {
    title: `Share your ${label}`,
    filename: `tagda-${slug(label)}-${stamp(solves.at(-1).createdAt)}.png`,
    text: shareText(label, value),
  });
}
