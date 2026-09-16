/* ===========================================================
   Tagda Timer — the owner's shine and profile card

   Whichever leaderboard or race room row carries the owner's raceName gets a
   gold shine (see .owner-shine, next to sotdShine in components.css) and
   opens this card on click — the same identity already shown in the About
   panel, reused rather than duplicated.

   The match is on raceName, a free-text field (see sync-ui.js's "the one
   username, shared everywhere"), so it is a cosmetic flex and not a security
   boundary: anyone can rename themselves to it and borrow the shine. That is
   fine for what this is. Locking it to the signed-in Google account instead
   would need a database-side isOwner flag and a firebase.rules.json change —
   worth doing only if the vanity ever turns into an impersonation complaint.
   =========================================================== */

import { el } from './util.js';
import { popover } from './popover.js';
import { IG_HANDLE, IG_PROFILE_URL, GH_HANDLE, GH_PROFILE, AVATAR, OWNER_NAME, OWNER_BIO } from './panels.js';

export function isOwnerName(name) {
  return String(name || '').trim().toLowerCase() === OWNER_NAME;
}

/** Opens the Discord-style card anchored to the row that was clicked. */
export function openOwnerCard(anchor) {
  const link = (label, href, handle) => el('a', {
    class: 'about-link', href, target: '_blank', rel: 'noopener noreferrer',
  },
    el('span', {}, el('b', { text: label }), el('span', { class: 'sub', text: '@' + handle })),
  );

  const card = el('div', { class: 'owner-card' },
    el('div', { class: 'about-hero' },
      el('img', { class: 'about-avatar', src: AVATAR, alt: 'Ishaan', width: 52, height: 52, loading: 'lazy', decoding: 'async' }),
      el('div', {},
        el('div', { class: 'about-name', text: 'Ishaan' }),
        el('div', { class: 'about-handle', text: 'site owner' }))),
    el('div', { class: 'about-bio', text: OWNER_BIO }),
    link('Instagram', IG_PROFILE_URL, IG_HANDLE),
    link('GitHub', GH_PROFILE, GH_HANDLE),
  );
  popover(anchor, [{ node: card }], { minWidth: 240 });
}
