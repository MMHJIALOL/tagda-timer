import { t } from './i18n.js';
/* ===========================================================
   Tagda Timer — Scramble of the Day: the day's chat

   A room per event per day, down the right of the window, opposite the
   board. It opens at the same moment the board does — once your own time
   is in — because it is behind the same database rule: a room you could
   read before your attempt would be a way round the board's gate. Today's
   room only; at 00:00 IST the window moves to the new day's path, which is
   empty, and the old one is cleaned up later (daily-net.js, sweepOldChats).

   Built once per window and never rebuilt, for the reason race.js gives for
   its own chat: the board beside it is redrawn whenever anybody's progress
   changes, and a text field rebuilt between two keystrokes loses what you
   typed. Only the log is redrawn, and only on the controller's 'chat'
   event, never on 'change'.

   The look is race mode's chat (the same classes), with a face beside each
   name: these are Google accounts that are the same people every day, not
   race mode's throwaway nicknames.
   =========================================================== */

import { el } from './util.js';
import { toast, confirmToast, choiceToast } from './toast.js';
import { RACE_EMOJI, CHAT_MAX_LEN } from './raceapp.js';
import { cleanChat } from './race-net.js';
import { openOwnerCard, OWNER_UID } from './ownercard.js';
import { eventOf } from './events.js';

const EMOJI_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9 10h.01M15 10h.01M8.5 14.5a4.5 4.5 0 0 0 7 0"/></svg>';
const SEND_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h13M12 5l7 7-7 7"/></svg>';
const FLAG_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 21V4m0 0h10l-2 4 2 4H6"/></svg>';
const DEL_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg>';

/** Same hash as race.js's, so a name is the same colour in both rooms. */
function hueOf(str) {
  let h = 0;
  for (let i = 0; i < String(str).length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h % 360;
}

const clock = (ms) => (ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');

/**
 * @param ctl     daily.js's controller
 * @param avatar  dailyui.js's face builder, passed in rather than imported:
 *                dailyui.js imports this file.
 * @param onBack  narrow screens only: show the board again (the chat takes
 *                the board's place there, see dailyui.js).
 */
export function mountChat(ctl, { avatar, onBack } = {}) {
  const log = el('div', { class: 'race-chat-log sc-log', role: 'log', 'aria-live': 'polite', 'aria-label': t('Today’s chat') });
  const input = el('input', {
    class: 'race-chat-input', type: 'text', autocomplete: 'off', maxlength: String(CHAT_MAX_LEN),
    placeholder: t('Say something…'), 'aria-label': t('Message today’s chat'),
  });
  const emojiBtn = el('button', {
    class: 'race-chat-emoji', type: 'button', title: t('Emoji'), 'aria-label': t('Emoji'),
    'aria-expanded': 'false', html: EMOJI_SVG,
    // Keep the focus in the field: the tray is a detour, not a destination.
    onmousedown: (e) => e.preventDefault(),
  });
  const tray = el('div', { class: 'race-emoji', hidden: true, role: 'group', 'aria-label': t('Emoji') },
    RACE_EMOJI.map(ch => el('button', {
      class: 'race-emoji-btn', type: 'button', title: ch,
      onmousedown: (e) => e.preventDefault(),
      onclick: () => {
        // At the caret, not appended: see race.js's tray.
        const at = input.selectionStart ?? input.value.length;
        const to = input.selectionEnd ?? at;
        input.value = (input.value.slice(0, at) + ch + input.value.slice(to)).slice(0, CHAT_MAX_LEN);
        const caret = Math.min(at + ch.length, input.value.length);
        input.setSelectionRange(caret, caret);
        input.focus();
      },
    }, ch)));
  const send = el('button', { class: 'race-chat-send', type: 'submit', title: t('Send'), 'aria-label': t('Send'), html: SEND_SVG });
  const form = el('form', { class: 'race-chat-form' }, emojiBtn, input, send);
  const sub = el('span', { class: 'sc-sub' });
  const back = el('button', {
    class: 'sc-back', type: 'button', text: t('‹ Board'), title: t('Back to the board'),
    onclick: () => onBack?.(),
    onkeydown: (e) => e.stopPropagation(),
  });
  /* In place of the box when this account cannot post: banned, or the chat
     switched off from the admin console (ADMIN.md). Reading carries on. */
  const blocked = el('div', { class: 'sc-blocked', role: 'status', hidden: true });
  const node = el('div', { class: 'sotd-chat-card' },
    el('div', { class: 'sc-head' }, back, el('h3', { class: 'sc-title', text: t('Chat') }), sub),
    log, tray, form, blocked);

  const setTray = (open) => {
    tray.hidden = !open;
    emojiBtn.setAttribute('aria-expanded', String(open));
  };
  emojiBtn.addEventListener('click', () => setTray(tray.hidden));
  const onDocClick = (e) => {
    if (!tray.hidden && !e.target.closest('.sotd-chat-card .race-emoji, .sotd-chat-card .race-chat-emoji')) setTray(false);
  };
  document.addEventListener('click', onDocClick);

  const submit = async () => {
    const body = cleanChat(input.value);
    if (!body) { input.value = ''; return; }
    /* Cleared before the write, put back only if it fails: people start the
       next message during the round trip (race.js does the same). */
    input.value = '';
    setTray(false);
    try {
      const out = await ctl.sendChat(body);
      if (out === 'slow') {
        input.value = body;
        toast(t('Slow down a little: one message every {s} seconds', { s: Math.round(ctl.chatGapMs / 100) / 10 }));
      } else if (out === 'closed') {
        input.value = body;
      }
    } catch (err) {
      input.value = body;
      const code = String(err?.code || err?.message || err || '');
      console.warn('[daily] chat message refused', code);
      // Refused is nearly always "rules from before the chat"; the other
      // causes (the day ended mid-sentence, a second tab sending too) read
      // the same to anybody who is not the site owner.
      toast(/permission.denied/i.test(code)
        ? t('The chat would not take that. If it keeps happening, the database rules need publishing.')
        : t('Could not send that, check your connection'), { kind: 'bad', long: true });
    }
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  input.addEventListener('keydown', (e) => {
    // The window is over an app that treats the spacebar as the timer, and
    // single letters as shortcuts.
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); setTray(false); input.blur(); return; }
    if (e.key !== 'Enter' || e.shiftKey) return;
    e.preventDefault();
    submit();
  });
  input.addEventListener('keyup', (e) => e.stopPropagation());

  const remove = async (m) => {
    const mine = m.uid === ctl.snap?.uid;
    const name = m.name || 'Cuber';
    // An admin on somebody else's message may also ban them (bans/, ADMIN.md); never the default.
    const how = mine || !ctl.admin
      ? ((await confirmToast(mine ? t('Delete your message?') : t('Delete {name}’s message?', { name }), t('Delete'))) ? 'delete' : null)
      : await choiceToast(t('Delete {name}’s message?', { name }),
        [{ label: t('Delete'), value: 'delete' }, { label: t('Delete and ban'), value: 'ban' }]);
    if (!how) return;
    try {
      await ctl.deleteChat(m.id);
      toast(t('Message deleted'));
    } catch (err) {
      console.warn('[daily] chat delete refused', err?.code || err);
      toast(t('Could not delete that message'), { kind: 'bad' });
      return;
    }
    if (how !== 'ban') return;
    try {
      await ctl.banUser({ uid: m.uid, name, reason: `Chat message: "${String(m.text || '').slice(0, 120)}"` });
      toast(t('{name} is banned from the boards, chats and replays', { name }), { long: true });
    } catch (err) {
      console.warn('[daily] ban refused', err?.code || err);
      toast(t('The database refused the ban — firebase.rules.json needs publishing first'), { kind: 'bad', long: true });
    }
  };

  const report = async (m) => {
    if (!(await confirmToast(t('Report {name}’s message to the admins?', { name: m.name || 'Cuber' }), t('Report')))) return;
    try {
      const out = await ctl.reportChat(m);
      if (out) toast(out === 'already' ? t('You have already reported that') : t('Reported. An admin will look at it.'));
    } catch (err) {
      console.warn('[daily] report refused', err?.code || err);
      toast(t('Couldn’t send the report'), { kind: 'bad' });
    }
  };

  /** The box, or why there is no box. */
  const posting = () => {
    const why = ctl.chatBlocked;
    form.hidden = !!why;
    blocked.hidden = !why;
    if (why) { blocked.textContent = why; setTray(false); }
  };

  let sig = null;
  const draw = () => {
    const { state, messages } = ctl.chat;
    const me = ctl.snap?.uid;
    const admin = ctl.admin;
    const next = `${state}|${me}|${admin}|${messages.map(m => `${m.id}:${m.at}`).join(',')}`;
    if (next === sig) return;
    sig = next;
    // Pinned to the newest message unless the reader has scrolled up.
    const pinned = log.scrollTop + log.clientHeight >= log.scrollHeight - 24;
    log.innerHTML = '';
    if (state === 'loading') {
      log.append(el('div', { class: 'race-chat-empty', text: t('Loading the chat…') }));
    } else if (!messages.length) {
      log.append(el('div', { class: 'race-chat-empty', text: t('Nothing said yet. Everyone here has done today’s scramble too.') }));
    } else {
      let lastUid = null;
      for (const m of messages) {
        const runOn = m.uid === lastUid;
        lastUid = m.uid;
        /* By uid, not by name as the board does (ownercard.js): the rules
           pin a message's uid to the account that sent it, and in a room
           anyone can type into, a name anyone can take is not good enough
           for the owner's badge. */
        const owner = m.uid === OWNER_UID;
        // textContent, not el()'s `text`: that one runs labels through the
        // translator, and a stranger's message is not a label.
        const text = el('span', { class: 'race-chat-text' });
        text.textContent = m.text || '';
        let who = null;
        if (!runOn) {
          who = el('div', { class: 'sc-meta' },
            el('b', { class: `race-chat-who${owner ? ' owner-shine' : ''}` }),
            el('span', { class: 'sc-time' }));
          who.firstChild.textContent = m.name || 'Cuber';
          who.lastChild.textContent = clock(m.at);
          if (owner) {
            who.firstChild.title = t('{name} — that’s the site owner, click for the card', { name: m.name || 'Cuber' });
            who.firstChild.addEventListener('click', (e) => { e.stopPropagation(); openOwnerCard(who.firstChild); });
          }
        }
        const canDelete = !!me && (m.uid === me || admin);
        // Somebody else's message, for everybody but an admin (who deletes): reports/, ADMIN.md §6.
        const canReport = !!me && m.uid !== me && !admin;
        const row = el('div', {
          class: `race-chat-msg sc-msg${runOn ? ' run-on' : ''}`,
          dataset: { me: String(m.uid === me) },
          title: m.at ? new Date(m.at).toLocaleString() : '',
        },
          runOn ? el('span', { class: 'sc-face-gap' }) : (avatar ? avatar(m.name, m.photo, { uid: m.uid, me: m.uid === me }) : el('span', { class: 'sc-face-gap' })),
          el('div', { class: 'sc-body' }, who, text),
          canReport ? el('button', {
            class: 'sc-del sc-report', type: 'button', html: FLAG_SVG,
            title: t('Report this message'), 'aria-label': t('Report this message'),
            onclick: () => report(m),
          }) : null,
          canDelete ? el('button', {
            class: 'sc-del', type: 'button', html: DEL_SVG,
            title: m.uid === me ? t('Delete your message') : t('Delete this message (admin)'),
            'aria-label': t('Delete message'),
            onclick: () => remove(m),
          }) : null,
        );
        row.style.setProperty('--av-h', String(hueOf(m.name || '')));
        log.append(row);
      }
    }
    if (pinned) log.scrollTop = log.scrollHeight;
  };

  /** Which event's room this is, kept current as the picker moves. */
  const head = () => {
    sub.textContent = t('{event} · today · clears at the reset', { event: eventOf(ctl.eventId).short });
  };

  const onChat = () => { head(); draw(); posting(); };
  ctl.addEventListener('chat', onChat);
  // A ban arrives with the board's snapshot, a switch with the settings.
  ctl.addEventListener('change', posting);
  addEventListener('tdt-config', posting);
  onChat();

  return {
    node,
    /** Called by the window on its own redraws: the event can change under it. */
    refresh: () => { head(); draw(); posting(); },
    dispose() {
      ctl.removeEventListener('chat', onChat);
      ctl.removeEventListener('change', posting);
      removeEventListener('tdt-config', posting);
      document.removeEventListener('click', onDocClick);
    },
  };
}
