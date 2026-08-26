/* ===========================================================
   Tagda Timer — small shared helpers
   =========================================================== */

export const $  = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(kid));
  }
  return n;
}

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;

/* ---------- time formatting ---------- */

/** WCA display: truncate to hundredths, mm:ss.hh past a minute. */
export function fmt(ms, { showMs = false } = {}) {
  if (ms === null || ms === undefined || !isFinite(ms)) return 'DNF';
  const neg = ms < 0; ms = Math.abs(ms);
  const cs = Math.floor(ms / 10);
  const totalSec = Math.floor(cs / 100);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const frac = showMs
    ? String(Math.floor(ms % 1000)).padStart(3, '0')
    : String(cs % 100).padStart(2, '0');
  let out;
  if (h)      out = `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${frac}`;
  else if (m) out = `${m}:${String(s).padStart(2,'0')}.${frac}`;
  else        out = `${s}.${frac}`;
  return (neg ? '-' : '') + out;
}

/** Running display — same shape but no leading-zero padding on seconds. */
export function fmtLive(ms, precision = 2) {
  if (ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  const frac = precision === 3
    ? String(Math.floor(ms % 1000)).padStart(3, '0')
    : String(Math.floor((ms % 1000) / 10)).padStart(2, '0');
  return m ? `${m}:${String(s).padStart(2,'0')}.${frac}` : `${s}.${frac}`;
}

export function fmtDate(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
         d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export const dayKey = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
};

/* ---------- misc ---------- */

export function debounce(fn, ms = 200) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/**
 * Copy to the clipboard. Resolves to whether it actually worked, and never
 * rejects.
 *
 * The async clipboard API refuses in more situations than you would guess — an
 * unfocused window, a denied permission, anything not on a secure origin — and
 * every caller here was firing a "Copied" toast off an ignored promise, so a
 * refusal produced an unhandled rejection and a message claiming success.
 * The old textarea route still works in most of those cases, so try it before
 * admitting defeat.
 */
export async function copy(text) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch { /* fall through to the legacy route */ }
  }
  try {
    const ta = el('textarea', { style: { position: 'fixed', top: '0', left: '0', opacity: '0' } });
    ta.value = text;
    document.body.append(ta);
    ta.focus(); ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return !!ok;
  } catch {
    return false;
  }
}

export function download(name, content, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = el('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Invert a move sequence: "R U R'" -> "R U' R'" */
export function invert(alg) {
  return alg.trim().split(/\s+/).filter(Boolean).reverse().map(m => {
    if (m.endsWith("'")) return m.slice(0, -1);
    if (m.endsWith('2')) return m;
    return m + "'";
  }).join(' ');
}

/** Collapse trivially redundant adjacent moves on the same face. */
export function tidy(alg) {
  const toks = alg.trim().split(/\s+/).filter(Boolean);
  const out = [];
  const amt = m => m.endsWith("'") ? 3 : m.endsWith('2') ? 2 : 1;
  const face = m => m.replace(/['2]$/, '');
  const build = (f, a) => a === 0 ? null : f + (a === 1 ? '' : a === 2 ? '2' : "'");
  for (const t of toks) {
    if (out.length && face(out.at(-1)) === face(t)) {
      const a = (amt(out.pop()) + amt(t)) % 4;
      const b = build(face(t), a);
      if (b) out.push(b);
    } else out.push(t);
  }
  return out.join(' ');
}

/* ---------- CSV ---------- */
export function toCSV(rows) {
  const esc = v => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map(r => r.map(esc).join(',')).join('\n');
}
