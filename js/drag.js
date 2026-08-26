/* ===========================================================
   Tagda Timer — drag a floating widget around the screen

   Deliberately small: one element, pointer events, a persisted
   {x, y} in viewport pixels. No library, no grid, no snapping.
   =========================================================== */

/** Keep a box fully on screen, whatever the window has done since. */
function clamp(x, y, w, h, margin = 6) {
  const maxX = Math.max(margin, innerWidth - w - margin);
  const maxY = Math.max(margin, innerHeight - h - margin);
  return {
    x: Math.min(Math.max(margin, x), maxX),
    y: Math.min(Math.max(margin, y), maxY),
  };
}

/**
 * Make `node` draggable.
 *
 * @param {HTMLElement} node
 * @param {object} opts
 * @param {() => ({x:number,y:number}|null)} opts.get   current saved position
 * @param {(pos:{x:number,y:number}|null) => void} opts.set  persist a new one
 * @param {string} [opts.ignore]  selector for children that must stay clickable
 */
export function makeDraggable(node, { get, set, handle = null, ignore = 'button, a, input, select' }) {
  let startX = 0, startY = 0, originX = 0, originY = 0, dragging = false, moved = false;

  /** Write the saved position onto the element, re-clamped to this viewport. */
  const apply = () => {
    const pos = get();
    if (!pos) {
      node.removeAttribute('data-placed');
      node.style.left = node.style.top = '';
      return;
    }
    const r = node.getBoundingClientRect();
    const c = clamp(pos.x, pos.y, r.width, r.height);
    node.dataset.placed = 'true';
    node.style.left = `${c.x}px`;
    node.style.top = `${c.y}px`;
  };

  node.addEventListener('pointerdown', (e) => {
    // A drag must never swallow the controls living inside the widget.
    if (!e.isPrimary || e.button !== 0 || (ignore && e.target.closest(ignore))) return;
    // With a dedicated handle, everything else in the widget keeps its own
    // pointer behaviour — a 3D preview you cannot spin is worse than one you
    // cannot move.
    if (handle && !e.target.closest(handle)) return;
    const r = node.getBoundingClientRect();
    startX = e.clientX; startY = e.clientY;
    originX = r.left; originY = r.top;
    dragging = true; moved = false;
    // Capture can throw if the pointer has already ended. Letting that escape
    // would abandon the handler with `dragging` left true and no capture --
    // the widget then tracks the cursor on plain hover, which is the exact
    // failure this file already had once.
    try { node.setPointerCapture(e.pointerId); } catch { /* no live pointer */ }
    e.preventDefault();
  });

  node.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    // If the button came up somewhere we never heard about — released outside
    // the window, capture stolen by another element, a dropped pointerup — the
    // widget would otherwise follow the cursor on plain hover forever. `buttons`
    // is the ground truth for "is anything actually held down right now".
    if (e.buttons === 0) { end(e); return; }
    const dx = e.clientX - startX, dy = e.clientY - startY;
    // A few pixels of slop, so a plain click on the widget is not a 1px drag
    // that permanently pins it a hair off its resting corner.
    if (!moved && Math.hypot(dx, dy) < 4) return;
    if (!moved) { moved = true; node.classList.add('dragging'); }
    const r = node.getBoundingClientRect();
    const c = clamp(originX + dx, originY + dy, r.width, r.height);
    node.dataset.placed = 'true';
    node.style.left = `${c.x}px`;
    node.style.top = `${c.y}px`;
  });

  function end(e) {
    if (!dragging) return;
    dragging = false;
    node.classList.remove('dragging');
    try { node.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
    if (!moved) return;
    const r = node.getBoundingClientRect();
    set({ x: Math.round(r.left), y: Math.round(r.top) });
  }
  node.addEventListener('pointerup', end);
  node.addEventListener('pointercancel', end);
  // Losing capture without a pointerup is the other way a drag gets stuck on.
  node.addEventListener('lostpointercapture', end);

  // A window resize can strand a pinned widget off screen; pull it back.
  addEventListener('resize', apply);

  apply();
  return { apply, reset: () => { set(null); apply(); } };
}
