/* ===========================================================
   Tagda Timer — the phone layout switch

   Phones get their own layout; tablets and desktops keep the one they have.
   This is the one place the JavaScript asks which it is. The stylesheets ask
   the same question with the same query — css/phone.css is linked with it as
   its media attribute, and recon.css and xplus1.css wrap their phone rules in
   it — so if this number ever changes, it changes in all of them.

   Landscape phones are wider than this and keep the tablet layout, on purpose.
   =========================================================== */

export const PHONE_QUERY = '(max-width: 640px)';

const mq = typeof matchMedia === 'function' ? matchMedia(PHONE_QUERY) : null;

/** Is the phone layout the one on screen right now? */
export const isPhone = () => !!mq?.matches;

/** Call `fn(isPhone)` whenever the answer changes (a resize, a rotation). */
export function onPhoneChange(fn) {
  mq?.addEventListener?.('change', () => fn(mq.matches));
}
