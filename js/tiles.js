/* ===========================================================
   Tagda Timer — dockable tiles

   Drag a panel by its grip and the three places it can live light up:
   the left rail, the right rail, and the bar across the bottom. Drop it
   on one and it clicks into that container the way a window snaps to the
   edge of a screen; drop it anywhere else and it stays exactly where you
   let go, floating.

   Deliberately not a grid engine. Three docks plus free-floating is the
   whole model, which is why a drop can never land somewhere that has no
   sensible layout — the rails already know how to stack panels and the
   bottom bar already knows how to lay them out in a row.
   =========================================================== */

import { $, el } from './util.js';

/** Which panels take part, and the element each one is. */
const SEL = {
  times:   '#panel-times',
  stats:   '#panel-stats',
  spotify: '#panel-spotify',
  race:    '#panel-race',
};
export const TILE_IDS = Object.keys(SEL);

/** Where each one starts out, before anyone drags anything. */
export const DEFAULT_TILES = {
  times:   { dock: 'left',  pos: null, w: null },
  stats:   { dock: 'right', pos: null, w: null },
  spotify: { dock: 'left',  pos: null, w: null },
  race:    { dock: 'right', pos: null, w: null },
};

const HOST = {
  left:   '#sidebar',
  right:  '#sidebar-right',
  bottom: '#dock-bottom',
  float:  '#tile-float-layer',
};

/** Stacking order inside a rail, so two tiles in one column keep a sane order. */
/* Race goes first wherever it lands: while a room is open it is the thing you
   are actually watching, and it is the only panel here that disappears again
   when you are done with it. */
const ORDER = ['race', 'times', 'spotify', 'stats'];

const ZONE_LABEL = { left: 'left rail', right: 'right rail', bottom: 'bottom bar' };

/**
 * Where each tile is allowed to live.
 *
 * The solve list is not in the bottom bar's list on purpose: a list you scroll
 * vertically, laid on its side in a 150px strip, showed one solve at a time and
 * asked you to scroll sideways for the rest. The two things that genuinely read
 * as a bar across the bottom — a row of figures and a player — can go there.
 */
const ALLOWED = {
  times:   ['left', 'right', 'float'],
  stats:   ['left', 'right', 'bottom', 'float'],
  spotify: ['left', 'right', 'bottom', 'float'],
  /* Out of the bottom bar for the same reason the solve list is: a column of
     one row per racer laid on its side in a 150px strip shows one racer. */
  race:    ['left', 'right', 'float'],
};

const allows = (id, dock) => (ALLOWED[id] || []).includes(dock);

/* The snap system is a pointer-and-space affair: below the mobile breakpoint
   the rails are two short tiles wedged under the timer and there is no room to
   drop anything anywhere. The grips are hidden by CSS at the same width. */
export const tilesEnabled = () => innerWidth > 860;

const cfgOf = (settings, id) => ({ ...DEFAULT_TILES[id], ...(settings.tiles?.[id] || {}) });

/**
 * Keep a box reachable rather than keep it wholly on screen.
 *
 * Forcing the whole panel to stay inside the viewport is what made a tall
 * times list impossible to drag to the bottom of the screen: the panel stopped
 * moving the moment its foot hit the bottom edge, the cursor ran away from the
 * grip, and the bottom bar could never be reached at all. A window manager
 * lets you push a window off the edge — behind the taskbar, past the side —
 * and only guarantees that enough of it stays put to grab it again. Same here:
 * the grip lives on the top edge, so the top edge is what must stay visible.
 */
const KEEP_X = 90;   // px of the tile that must remain on screen horizontally
const GRIP_ROOM = 14; // the grip sits above the tile's top edge

function clampBox(x, y, w, h) {
  return {
    x: Math.min(Math.max(KEEP_X - w, x), innerWidth - KEEP_X),
    // Down is free — that is the whole point — but the top edge, and with it
    // the grip, may never leave the screen or the tile becomes unmovable.
    y: Math.min(Math.max(GRIP_ROOM, y), innerHeight - 34),
  };
}

/* ---------------------------------------------------------
   Placement
   --------------------------------------------------------- */

/** Put `node` into `host`, at its place in ORDER rather than at the end. */
function insertOrdered(host, node, id) {
  if (node.parentElement === host) return;
  const rank = ORDER.indexOf(id);
  const after = [...host.children].find(c => ORDER.indexOf(c.dataset.tile) > rank);
  if (after) host.insertBefore(node, after);
  else host.append(node);
}

/**
 * Write every tile's dock and position onto the DOM.
 *
 * Idempotent, and deliberately reparents only when the parent is actually
 * wrong: moving #panel-times would otherwise reset the solve list's scroll
 * position on every unrelated settings change.
 */
export function applyTiles(settings) {
  for (const id of TILE_IDS) {
    const node = $(SEL[id]);
    if (!node) continue;
    node.dataset.tile = id;

    const cfg = cfgOf(settings, id);
    /* A dock this tile may no longer use falls back to where it started —
       which is what carries anyone who had already dragged the solve list into
       the bottom bar back out of it. */
    const wanted = allows(id, cfg.dock) ? cfg.dock : DEFAULT_TILES[id].dock;
    const dock = tilesEnabled() ? wanted : DEFAULT_TILES[id].dock;
    node.dataset.dock = dock;

    if (dock === 'float') {
      const host = $(HOST.float);
      if (host && node.parentElement !== host) host.append(node);
      node.classList.add('tile-float');
      if (cfg.w) node.style.width = `${cfg.w}px`;
      const r = node.getBoundingClientRect();
      const p = cfg.pos || { x: innerWidth / 2 - r.width / 2, y: innerHeight / 2 - r.height / 2 };
      const c = clampBox(p.x, p.y, r.width || cfg.w || 240, r.height || 160);
      node.style.left = `${c.x}px`;
      node.style.top = `${c.y}px`;
    } else {
      const host = $(HOST[dock]);
      if (host) {
        insertOrdered(host, node, id);
        /* Belt and braces. applyTheme hides a rail with nothing in it by
           writing display:none on the rail itself, and a tile dropped into a
           rail in that state would be inside a hidden box with nothing left to
           re-open it. A container that now holds something is, by definition,
           not empty. */
        if (host.style.display === 'none') host.style.display = '';
      }
      node.classList.remove('tile-float');
      node.style.left = node.style.top = '';
      node.style.width = '';
    }
  }
  measureLayout();
}

/* ---------------------------------------------------------
   Snap zones
   --------------------------------------------------------- */

/** The drop targets this tile may use, measured against the live stage. */
/**
 * The strip between the two rails, which is both where the bottom-bar snap
 * preview is drawn and where the bar itself ends up.
 *
 * One definition on purpose. The dock used to span the whole viewport while
 * the preview promised the space between the rails, so a bar dropped there
 * ran on underneath the rail panels and the scramble preview — it did not land
 * where the outline said it would.
 */
function bottomZone() {
  const stage = $('#stage');
  if (!stage) return null;
  const s = stage.getBoundingClientRect();

  /* Measured off the rails themselves rather than recomputed from
     --sidebar-w. The two can disagree — the grid caps a rail at 200px below
     1080px wide while the variable still says 236, and a wide sidebar setting
     on a narrow window goes the other way and would have put the bar's edge
     *inside* the rail. A rail that is switched off has no rect and gives its
     side away, which is right: there is nothing there to avoid. */
  const shown = (n) => n && getComputedStyle(n).display !== 'none';
  const left = $('#sidebar'), right = $('#sidebar-right');
  const x1 = (shown(left) ? left.getBoundingClientRect().right : s.left) + 12;
  const x2 = (shown(right) ? right.getBoundingClientRect().left : s.right) - 12;
  const w = x2 - x1;
  if (w <= 260) return null;
  return { x: x1, w };
}

function zoneRects(id) {
  const stage = $('#stage');
  if (!stage) return [];
  const s = stage.getBoundingClientRect();
  const declared = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w')) || 236;
  const railW = Math.max(150, Math.min(declared, s.width * 0.3));
  const barH = 132;
  const bottom = bottomZone();
  return [
    { id: 'left',  x: s.left, y: s.top, w: railW, h: s.height },
    { id: 'right', x: s.right - railW, y: s.top, w: railW, h: s.height },
    ...(bottom ? [{ id: 'bottom', x: bottom.x, y: innerHeight - barH - 14, w: bottom.w, h: barH }] : []),
  ].filter(zone => allows(id, zone.id));
}

const inRect = (x, y, r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

/**
 * Publish how much of the bottom of the screen the bar is occupying.
 *
 * The rails, the creator chip and the scramble preview are all anchored down
 * there and would otherwise be buried under it. Measured rather than guessed:
 * the bar is 148px tall with the statistics panel in it and about 64 with just
 * the player, and a constant would be wrong for every combination but one.
 */
function measureDock() {
  const root = document.documentElement;
  const dock = document.getElementById('dock-bottom');
  const occupied = !!(dock && dock.children.length);
  const h = occupied ? Math.round(dock.getBoundingClientRect().height) : 0;
  root.style.setProperty('--dock-h', h ? `${h + 22}px` : '0px');

  // Where the bar sits, from the same measurement the snap outline is drawn
  // from, so the two can never disagree.
  const z = bottomZone();
  if (z) {
    root.style.setProperty('--dock-x', `${Math.round(z.x)}px`);
    root.style.setProperty('--dock-w', `${Math.round(z.w)}px`);
  } else {
    root.style.removeProperty('--dock-x');
    root.style.removeProperty('--dock-w');
  }

  /* Who actually has to get out of the bar's way.
   *
   * The bar spans the strip *between* the rails, so on a normal desktop layout
   * the answer is nobody: the rails, the credit chip and the scramble preview
   * are all outside it. Reserving room for it regardless is what shoved
   * everything in the left rail upwards the moment anything was docked in the
   * middle. Only something the bar is genuinely in front of pays — which is
   * still the right answer when a rail is switched off and the bar widens into
   * that corner, and on a phone where it spans the whole screen.
   *
   * Only the horizontal overlap is tested, and nothing here can change that:
   * these reservations move things vertically. So this cannot feed itself. */
  const d = occupied ? dock.getBoundingClientRect() : null;
  const need = d ? Math.max(0, Math.round(innerHeight - d.top + 10)) : 0;
  const inFrontOf = (id) => {
    if (!d) return 0;
    const n = document.getElementById(id);
    if (!n || n.hidden || getComputedStyle(n).display === 'none') return 0;
    const q = n.getBoundingClientRect();
    if (q.width <= 2) return 0;
    return (d.right <= q.left || d.left >= q.right) ? 0 : need;
  };
  root.style.setProperty('--dock-clear-left',  `${inFrontOf('sidebar')}px`);
  root.style.setProperty('--dock-clear-right', `${inFrontOf('sidebar-right')}px`);
  root.style.setProperty('--dock-clear-chip',  `${inFrontOf('creator-chip')}px`);
  root.style.setProperty('--dock-clear-cube',  `${inFrontOf('panel-cube')}px`);
}

/**
 * Measure the credit chip, so the left rail can stop above it.
 *
 * The chip is pinned to the bottom-left corner on top of that rail, and it
 * moves up when the bottom bar is occupied — so the room it needs is not the
 * constant the stylesheet used to assume, and a panel ending a few pixels low
 * ran straight into it.
 */
function measureChip() {
  const chip = document.getElementById('creator-chip');
  const root = document.documentElement;
  root.style.setProperty('--chip-h-left', '0px');
  root.style.setProperty('--chip-h-right', '0px');
  if (!chip || getComputedStyle(chip).display === 'none') return;

  const r = chip.getBoundingClientRect();
  const need = `${Math.max(0, Math.round(innerHeight - r.top + 10))}px`;
  // Only the rail the chip is actually parked in front of pays for it — and
  // which one that is changes, because the chip swaps corners when the
  // scramble preview takes the one it usually sits in.
  const side = (r.left + r.width / 2) < innerWidth / 2 ? 'left' : 'right';
  root.style.setProperty(side === 'left' ? '--chip-h-left' : '--chip-h-right', need);
}

/**
 * Put the scramble preview on whichever side of the screen is free.
 *
 * The previous answer was to make the rail stop short of the preview, which
 * permanently cost the solve list a chunk of its height whether or not the two
 * were anywhere near each other. This costs nothing until they actually
 * collide: the preview stays in its usual bottom-right corner, and only if a
 * panel is genuinely in that corner does it hop to the other side — and only
 * if that side is clear.
 *
 * Left alone entirely once the preview has been dragged somewhere by hand:
 * that is a position the user chose, and moving it would be overruling them.
 */
function placePreview() {
  const cube = document.getElementById('panel-cube');
  if (!cube) return;
  if (cube.dataset.placed === 'true' || getComputedStyle(cube).display === 'none') {
    cube.removeAttribute('data-side');
    return;
  }

  const r = cube.getBoundingClientRect();
  const w = Math.round(r.width), h = Math.round(r.height);
  if (!w || !h) return;

  // Its vertical band is fixed by the stylesheet (it sits above the bottom
  // bar); only the horizontal side is in question here.
  const top = r.top, bottom = r.bottom;
  const margin = innerWidth <= 860 ? 10 : 18;

  /* Panels only. The credit chip is not an obstacle — it is a 28px link that
     moves to the opposite corner (see components.css), and treating it as one
     meant the left-hand corner always looked occupied and the preview never
     moved anywhere. */
  const boxes = ['panel-times', 'panel-stats', 'panel-spotify', 'panel-race']
    .map(id => document.getElementById(id))
    .filter(n => n && !n.hidden && getComputedStyle(n).display !== 'none' && n.dataset.dock !== 'bottom')
    .map(n => n.getBoundingClientRect())
    .filter(q => q.width > 2 && q.height > 2 && q.bottom > top && q.top < bottom);

  const clashes = (x) => boxes.some(q => !(x + w <= q.left || x >= q.right));

  const rightX = innerWidth - margin - w;
  const leftX = margin;
  const rightBlocked = clashes(rightX);
  const leftBlocked = clashes(leftX);

  // Right is where it lives; left is the escape hatch, taken only when the
  // usual corner is occupied and the other one is not.
  const side = (rightBlocked && !leftBlocked) ? 'left' : 'right';
  if (side === 'left') cube.dataset.side = 'left';
  else cube.removeAttribute('data-side');

  /* Both corners occupied — a panel in each rail, both long enough to reach
     down here. There is nowhere left to move to, so this is the one case where
     the rail gives way instead, exactly as far as the preview's own top edge.
     It costs that rail some height, which is why it is the last resort rather
     than the standing arrangement. */
  const root = document.documentElement;
  root.style.setProperty('--cube-clear-left', '0px');
  root.style.setProperty('--cube-clear-right', '0px');
  if (rightBlocked && leftBlocked) {
    root.style.setProperty(side === 'left' ? '--cube-clear-left' : '--cube-clear-right',
      `${Math.max(0, Math.round(innerHeight - r.top + 10))}px`);
  }
}

let settleFrame = 0;
let settleTimeout = 0;

/**
 * Everything anchored to an edge, re-measured together.
 *
 * Measured three times on purpose: now, on the next frame, and once the
 * transitions have run. A ResizeObserver only fires when a box changes *size*,
 * and the preview moving — a settings reset putting it back in its corner, a
 * rail appearing and shifting the columns, the statistics panel finishing its
 * collapse — changes only its position. Nothing else would ever come back to
 * correct a reading taken mid-transition, so this comes back itself.
 */
export function measureLayout() {
  // placePreview first: it can push the credit chip up, and measureChip has to
  // read where the chip ended up, not where it was.
  const pass = () => { measureDock(); placePreview(); measureChip(); };
  pass();
  cancelAnimationFrame(settleFrame);
  clearTimeout(settleTimeout);
  settleFrame = requestAnimationFrame(pass);
  settleTimeout = setTimeout(pass, 360);
}

function paintZones(rects) {
  const host = $('#snap-zones');
  if (!host) return;
  host.innerHTML = '';
  for (const r of rects) {
    host.append(el('div', {
      class: 'snap-zone',
      dataset: { zone: r.id },
      style: { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` },
    }, el('span', { class: 'snap-tag', text: ZONE_LABEL[r.id] })));
  }
  host.hidden = false;
}

function clearZones() {
  const host = $('#snap-zones');
  if (!host) return;
  host.hidden = true;
  host.innerHTML = '';
}

function highlight(zoneId) {
  for (const z of document.querySelectorAll('.snap-zone')) {
    z.classList.toggle('on', z.dataset.zone === zoneId);
  }
}

/* ---------------------------------------------------------
   Drag
   --------------------------------------------------------- */

/**
 * @param {object} opts
 * @param {object} opts.settings  live settings object
 * @param {(id, cfg) => void} opts.save  record and persist one tile's placement
 * @param {() => void} [opts.onPlaced]  run once the DOM has been rearranged
 */
export function initTiles({ settings, save, onPlaced }) {
  const layer = $('#tile-float-layer');
  if (!layer) return;

  let drag = null;
  let settleTimer = null;

  const onDown = (e) => {
    if (!e.isPrimary || e.button !== 0 || !tilesEnabled()) return;
    const grip = e.target.closest('.tile-grip');
    if (!grip) return;
    const node = grip.closest('[data-tile]');
    if (!node) return;

    const r = node.getBoundingClientRect();
    const id = node.dataset.tile;
    drag = {
      node,
      id,
      startX: e.clientX,
      startY: e.clientY,
      offX: e.clientX - r.left,
      offY: e.clientY - r.top,
      w: r.width,
      h: r.height,
      rects: zoneRects(id),
      zone: null,
      moved: false,
    };
    /* Deliberately NO setPointerCapture. The grip lives inside the panel, and
       anything that moves the panel in the DOM drops the capture the grip is
       holding — which arrives as `lostpointercapture` in the middle of the
       drag and, if you treat that as the end of it, ends the drag an event
       early and at the wrong place. move/up are listened for on `document`
       anyway, which is where a mouse sends them regardless, and a touch
       pointer is implicitly captured to the grip and still bubbles here. */
    e.preventDefault();
  };

  /**
   * Pick the panel up: into the float layer, and under the cursor.
   *
   * The float layer is deliberately a plain `position: fixed; inset: 0` box
   * hanging directly off #app, with no transform or filter of its own. That
   * matters more than it looks: a transformed ancestor becomes the containing
   * block for every fixed-position descendant, so a tile left inside the
   * bottom bar (which used to be centred with a translate) resolved the
   * viewport coordinates written onto it against the *bar* and shot off to the
   * side of the screen. Moving it somewhere known makes the coordinates mean
   * what they say, wherever it was dragged from.
   *
   * Reparenting mid-drag is only safe because nothing captures the pointer any
   * more — see onDown.
   */
  const lift = () => {
    const { node, w } = drag;
    // Freeze the width it had in its rail: in the float layer there is nothing
    // to take a width from, and a panel that collapses the instant you pick it
    // up gives you nothing to aim with.
    node.style.width = `${w}px`;
    node.classList.add('tile-float', 'tile-dragging');
    /* Moving a node to a new parent restarts every CSS animation inside it, and
       the solve list gives each chip a 380ms entry fade — so picking the times
       panel up made its whole list blink. Off for the duration of the move. */
    document.body.classList.add('tiles-moving');
    layer.append(node);
    paintZones(drag.rects);
  };

  const onMove = (e) => {
    if (!drag) return;
    if (e.buttons === 0) { onUp(e); return; }
    if (!drag.moved) {
      // A few pixels of slop, so a plain click on a grip is not a drag that
      // rehomes the panel a hair from where it started.
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 4) return;
      drag.moved = true;
      lift();
    }
    const c = clampBox(e.clientX - drag.offX, e.clientY - drag.offY, drag.w, drag.h);
    drag.node.style.left = `${c.x}px`;
    drag.node.style.top = `${c.y}px`;

    const hit = drag.rects.find(r => inRect(e.clientX, e.clientY, r));
    drag.zone = hit ? hit.id : null;
    highlight(drag.zone);
  };

  const onUp = (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    d.node.classList.remove('tile-dragging');
    clearZones();

    if (!d.moved) { document.body.classList.remove('tiles-moving'); return; }

    const cfg = cfgOf(settings, d.id);
    if (d.zone) {
      cfg.dock = d.zone;
      cfg.pos = null;
      /* Every dock sizes its own children, the bottom bar included. Carrying
         the width the tile happened to have while in the air across to it just
         meant a strip as narrow as whichever rail it came from. */
      cfg.w = null;
    } else {
      const r = d.node.getBoundingClientRect();
      cfg.dock = 'float';
      cfg.pos = { x: Math.round(r.left), y: Math.round(r.top) };
      cfg.w = Math.round(d.w);
    }
    /* Order is load-bearing, and getting it wrong is what made a dropped panel
       disappear: `onPlaced` re-measures which rails have anything in them, so
       it has to run *after* applyTiles has moved the panel out of the float
       layer and back into its rail. Run first, it saw an empty rail, hid the
       column, and then the panel was inserted into something already display:
       none — invisible until the next reload. */
    save(d.id, cfg);
    applyTiles(settings);
    onPlaced?.();
    /* A timer rather than requestAnimationFrame: rAF does not run at all in a
       backgrounded tab, so a drop followed by a tab switch would leave the
       class -- and with it the suppressed animation -- on forever. Long enough
       to outlast the 380ms entry animation it exists to swallow. */
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => document.body.classList.remove('tiles-moving'), 450);
  };

  document.addEventListener('pointerdown', onDown);
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
  document.addEventListener('pointercancel', onUp);
  /* No `lostpointercapture` handler: nothing here captures a pointer any more,
     and treating that event as the end of a drag is precisely the bug this
     file used to have. A pointerup that happens outside the window is caught
     by the `buttons === 0` check in onMove, and by these two. */
  addEventListener('blur', (e) => { if (drag) onUp(e); });
  document.addEventListener('visibilitychange', (e) => { if (document.hidden && drag) onUp(e); });

  // A resize can strand a floating tile off screen, and it changes whether the
  // whole system is available at all.
  addEventListener('resize', () => { applyTiles(settings); measureLayout(); });

  /* The bar's height also changes without any tile moving — expanding the
     statistics panel is the obvious one — so watch the box itself rather than
     only writing the variable when something is dropped. */
  const dock = $('#dock-bottom');
  const cube = $('#panel-cube');
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(measureLayout);
    if (dock) ro.observe(dock);
    if (cube) ro.observe(cube);
  }

  applyTiles(settings);
}
