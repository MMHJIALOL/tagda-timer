import { t } from './i18n.js';
/* ===========================================================
   Tagda Timer — the move pad (phones)

   Typing moves on a phone keyboard is miserable: letters and the prime key
   live on different layers, autocorrect wants to help, and the keyboard
   covers the cube you are typing about. The pad is three rows of big keys
   instead:

     R U F L D B           a face key lands the move at once
     M E S x y z           slices and rotations (a WCA-only pad leaves out M E S)
     ′  2  w  ⌫  [Done]    change the last move, delete it, or finish

   ′, 2 and w change the move already on the line rather than waiting for the
   next one: R, then ′, is R'. Pressing ′ again takes it back to R; 2 makes it
   a double, and w makes it wide (stored as Rw, the way the cube draws it).

   The pad knows nothing about what the moves are for. Whoever owns it says
   what the last move is and what to do with a new one, which is what lets the
   reconstruction and the Cross + 1 check share it.
   =========================================================== */

import { el } from './util.js';

const FACES = ['R', 'U', 'F', 'L', 'D', 'B'];
const SLICES = ['M', 'E', 'S'];
const ROTATIONS = ['x', 'y', 'z'];

const TOKEN = /^([URFDLBMESxyz])(w?)(2|')?$/;

/** A move as its parts, or null if the pad does not know how to change it. */
function split(tok) {
  const m = TOKEN.exec(String(tok || '').trim());
  return m ? { letter: m[1], wide: !!m[2], suffix: m[3] || '' } : null;
}
const join = ({ letter, wide, suffix }) => `${letter}${wide ? 'w' : ''}${suffix}`;

/** R → R', R' → R, R2 → R'. */
export function primeOf(tok) {
  const p = split(tok);
  if (!p) return null;
  return join({ ...p, suffix: p.suffix === "'" ? '' : "'" });
}

/** R → R2, R' → R2, R2 → R. */
export function doubleOf(tok) {
  const p = split(tok);
  if (!p) return null;
  return join({ ...p, suffix: p.suffix === '2' ? '' : '2' });
}

/** R → Rw and back. Slices and rotations have no wide form. */
export function wideOf(tok) {
  const p = split(tok);
  if (!p || !FACES.includes(p.letter)) return null;
  return join({ ...p, wide: !p.wide });
}

const BACKSPACE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5.5h10.5a1.5 1.5 0 011.5 1.5v10a1.5 1.5 0 01-1.5 1.5H9L3 12z"/><path d="M12 9.5l5 5M17 9.5l-5 5"/></svg>';

/**
 * Build a pad.
 *   notation     'full' (M E S x y z) or 'wca' (x y z only)
 *   action       the label on the wide key ("Done", "Check")
 *   onAction     the wide key, or Enter
 *   last         () => the last move on the line, or ''
 *   push         (move) => add a move
 *   replaceLast  (move) => swap the last move for this one
 *   pop          () => remove the last move
 * Returns { el, show, hide, isOpen, handleKey, attachField, setAction }.
 */
export function createMovePad({
  notation = 'full', action = t('Done'),
  onAction = () => {}, last = () => '', push = () => {}, replaceLast = () => {}, pop = () => {},
} = {}) {
  const modify = (fn) => {
    const cur = last();
    const next = cur ? fn(cur) : null;
    if (next) replaceLast(next);
    else nudge();
  };

  const key = (label, run, { cls = '', aria = null, html = null } = {}) => {
    const b = el('button', {
      type: 'button', class: `mp-key ${cls}`.trim(), 'aria-label': aria,
      ...(html ? { html } : { text: label }),
    });
    // Keep the focus where it was (a hardware keyboard may be typing into a
    // field), and act on the tap itself.
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', (e) => { e.preventDefault(); run(); });
    return b;
  };

  const second = notation === 'wca' ? ROTATIONS : [...SLICES, ...ROTATIONS];
  let actionKey;
  const root = el('div', { class: 'mp', role: 'group', 'aria-label': t('Move pad'), hidden: true },
    el('div', { class: 'mp-row mp-faces' },
      ...FACES.map(f => key(f, () => push(f), { cls: 'face' }))),
    el('div', { class: 'mp-row mp-slices' },
      ...second.map(f => key(f, () => push(f), { cls: 'slice' }))),
    el('div', { class: 'mp-row mp-mods' },
      key('′', () => modify(primeOf), { cls: 'mod', aria: t('Prime: turn the last move the other way') }),
      key('2', () => modify(doubleOf), { cls: 'mod', aria: t('Make the last move a double') }),
      key('w', () => modify(wideOf), { cls: 'mod', aria: t('Make the last move wide') }),
      key('', () => (last() ? pop() : nudge()), { cls: 'mod back', aria: t('Delete the last move'), html: BACKSPACE_ICON }),
      actionKey = key(action, () => onAction(), { cls: 'go' })),
  );
  // How many keys share each of the first two rows (three on a WCA-only pad).
  for (const row of root.querySelectorAll('.mp-faces, .mp-slices')) row.style.setProperty('--n', row.children.length);

  /* Nothing to change: a short shake says the key was heard. */
  function nudge() {
    root.classList.remove('mp-nudge');
    void root.offsetWidth;
    root.classList.add('mp-nudge');
  }

  /**
   * The same pad on a hardware keyboard: letters are faces whatever the case
   * (no shift between you and a move, as in the desktop box), ' and 2 and w
   * change the last move, Backspace deletes it, Enter is the action key.
   * Returns true when the key was the pad's.
   */
  function handleKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    const k = e.key;
    if (k === 'Enter') { onAction(); return true; }
    if (k === 'Backspace') { if (last()) pop(); else nudge(); return true; }
    if (k === "'" || k === '’' || k === '′') { modify(primeOf); return true; }
    if (k === '2') { modify(doubleOf); return true; }
    if (k === 'w' || k === 'W') { modify(wideOf); return true; }
    if (k.length !== 1) return false;
    const up = k.toUpperCase();
    if (FACES.includes(up)) { push(up); return true; }
    if (notation !== 'wca' && SLICES.includes(up)) { push(up); return true; }
    if (ROTATIONS.includes(k.toLowerCase())) { push(k.toLowerCase()); return true; }
    return false;
  }

  return {
    el: root,
    isOpen: () => !root.hidden,
    show() {
      if (!root.hidden) return;
      root.hidden = false;
      root.classList.remove('mp-in');
      void root.offsetWidth;
      root.classList.add('mp-in');
    },
    hide() { root.hidden = true; },
    handleKey,
    setAction(label) { actionKey.textContent = label; },
    /**
     * A field that shows the line but never brings up the phone's keyboard:
     * read-only, so a tap on it is only a tap. A hardware keyboard still types
     * into it, through the pad.
     */
    attachField(input) {
      input.readOnly = true;
      input.setAttribute('inputmode', 'none');
      input.addEventListener('keydown', (e) => {
        if (handleKey(e)) { e.preventDefault(); e.stopPropagation(); }
      });
    },
  };
}
