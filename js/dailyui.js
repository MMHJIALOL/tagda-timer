import { t } from './i18n.js';
/* ===========================================================
   Tagda Timer — Scramble of the Day: the window and the two boards

   Two things live here, and they are together because the second is drawn
   inside the first as well as inside the settings drawer.

   ---------------------------------------------------------
   1. The window
   ---------------------------------------------------------

   Pressing "Scramble of the Day" does not open a panel. It puts the app
   into a state — `body.sotd` — where everything that is not today's
   scramble and the timer is gone: topbar, both sidebars, the dock, the
   floating tiles. What is left is the scramble, the clock, and a slim bar
   saying which day it is and how long is left of it.

   It is built by SUBTRACTION rather than as a modal with its own timer, and
   that is the load-bearing decision in this file. A self-contained window
   would have needed its own copy of inspection, +2/DNF judging, the hold
   time, stackmat input and the minimum-solve prompt — five things that were
   already right in js/timer.js and main.js and would immediately have begun
   drifting from them. Worse, a solve done in that window would not have
   been a solve: it would not have landed in your session, your averages or
   your history, and "my daily attempt is missing from my stats" is a much
   worse bug than any amount of chrome on screen.

   So the window is a layout, and the solve underneath it is an ordinary
   solve that happens to be of today's scramble. Everything the daily
   challenge already did — arming the attempt, the server-timed window, the
   write-once result — is untouched by it.

   ---------------------------------------------------------
   2. The boards
   ---------------------------------------------------------

   Two of them, and they answer different questions on purpose:

     - the TIME board: who solved today's scramble fastest. Gated — you see
       nobody's time until you have submitted your own, which is a database
       rule and not a promise this file makes.
     - the COUNT board: who did the most solves today, of anything. Public,
       ungated, and honest about being unverifiable (see DAILY.md §5).

   Both render through the same row builder, so a name and a face look the
   same whichever board you found them on.
   =========================================================== */

import { el, fmt } from './util.js';
import { signIn } from './sync-auth.js';
import { toast, confirmToast, choiceToast } from './toast.js';
import { formatCountdown, safePhotoUrl, shiftDayId, cleanNote, NOTE_MAX_LEN, dayStartMs } from './daily-net.js';
import { RACE_EMOJI } from './raceapp.js';
import { isOwnerName, openOwnerCard } from './ownercard.js';
// Policy lives with the controller — see the comment on it there.
import { SHOW_COUNT_BOARD } from './daily.js';
import { canPlay, playButton, replayKept, keepDays, shareBox, bindReplays, dropClip } from './sotd-replays.js';
import { mountChat } from './sotd-chat.js';
import { knownFace, lookupFace } from './faces.js';

/* ---------------------------------------------------------
   A face, or the next best thing
   --------------------------------------------------------- */

/**
 * The avatar for a board row.
 *
 * Three tiers, because two of them are common: the Google account picture,
 * an initial on a tinted disc when there is no picture, and the same disc
 * blank if there is not even a usable name. The initial tier matters more
 * than it looks — a board of twelve identical grey circles is worse at the
 * one job an avatar has, which is letting you find your own row without
 * reading it.
 *
 * `referrerpolicy` is not decoration: Google's avatar CDN serves 403 for
 * requests carrying a referrer it does not know, which on a self-hosted
 * copy of this app means every face silently failing to load.
 *
 * The URL is re-checked here even though the rules already refuse a bad one,
 * because this is the last point before a stranger's string becomes a fetch
 * from the viewer's browser — and it is the only check that also covers rows
 * written before that rule existed. See safePhotoUrl.
 *
 * A picture the player uploaded beats the Google one (faces.js). `uid` is
 * whose row this is and `me` whether it is the viewer's own. Without them
 * the row keeps its Google picture.
 */
export function avatar(name, photo, { uid = null, me = false } = {}) {
  const initial = (String(name || '').trim()[0] || '').toUpperCase();
  const custom = knownFace(uid, me);
  const src = custom || safePhotoUrl(photo);
  const owner = isOwnerName(name);
  const ownerBits = owner
    ? { title: t('{name} — that’s the site owner, click for the card', { name }),
        onclick: (e) => { e.stopPropagation(); openOwnerCard(face); } }
    : {};
  let face;
  if (src) {
    face = el('img', {
      class: `db-face${owner ? ' owner' : ''}`, src, alt: '', loading: 'lazy',
      decoding: 'async', referrerpolicy: 'no-referrer', ...ownerBits,
    });
    // A broken image is a torn box with an alt cross in it. Fall back to the
    // Google picture or the initial instead, which is what this row would
    // have had anyway.
    face.addEventListener('error', () => face.replaceWith(avatar(name, custom ? photo : null)), { once: true });
  } else {
    face = el('span', {
      class: `db-face db-face-letter${owner ? ' owner' : ''}`, text: initial || '·', 'aria-hidden': 'true',
      ...ownerBits,
    });
  }
  /* Not asked about yet: draw what the row has, and swap when the answer is
     a picture and this face is still on screen. The board is redrawn from
     scratch often, and a redraw after the answer reads it from the cache. */
  if (custom === undefined) {
    lookupFace(uid).then(url => { if (url && face.isConnected) face.replaceWith(avatar(name, photo, { uid, me })); });
  }
  return face;
}

/* ---------------------------------------------------------
   The time board — who solved today's scramble fastest
   --------------------------------------------------------- */

const lockedBoard = (text = null) => el('div', { class: 'db-locked' },
  el('div', { class: 'db-locked-icon', text: t('🔒') }),
  el('div', { class: 'db-locked-text', text: text ||
    t('Submit today’s attempt to unlock the board and the chat. Nobody’s time is visible to you until you have sent your own — that is a database rule, not a setting.') }),
);

/** Why today's board is shut for somebody whose time an admin removed, or null for the usual reason. */
export function lockText(ctl) {
  if (ctl.status?.() === 'removed') {
    return t('An admin removed your time today, and it was your backup, so the board and the chat stay locked until the reset.');
  }
  if (ctl.removal) return t('An admin removed your time. Solve the backup scramble to get back on the board and into the chat.');
  return null;
}

/**
 * @param rows      what daily.js's ranked() returned
 * @param revealed  whether this viewer has earned the right to see times
 * @param replays   { dayKey, event, onGone }: put a ▶ on rows with a shared
 *                  replay (sotd-replays.js). Left out, there are none.
 * @param opts      { remove, locked }: the admin's × on every row (adminRemover),
 *                  and what the lock says instead of the usual (lockText).
 */
export function timeBoard(rows, revealed, replays = null, { remove = null, locked = null } = {}) {
  if (!revealed) return lockedBoard(locked);
  if (!rows.length) return el('div', { class: 'db-empty', text: t('Nobody has posted a time yet today.') });

  return el('div', { class: 'db-board' }, rows.map((r, i) => timeRow(r, i, replays, remove)));
}

/**
 * The third view of the board: everybody who shared a replay of this day's
 * attempt, in board order, each with a ▶. Gated exactly like the times, and
 * built from the same rows: the `replay` flag on each, nothing listed from
 * storage. Nothing is fetched until a ▶ is pressed.
 */
export function replaysBoard(rows, revealed, replays, { past = false, remove = null, locked = null } = {}) {
  if (!revealed) return lockedBoard(locked);
  if (!replayKept(replays.dayKey)) {
    return el('div', { class: 'db-empty', text: t('Replays are kept for {n} days.', { n: keepDays() }) });
  }
  const shared = rows.map((r, i) => [r, i]).filter(([r]) => canPlay(replays.dayKey, replays.event, r.uid, r.result));
  if (!shared.length) {
    return el('div', { class: 'db-empty', text: past
      ? t('Nobody shared a replay that day.')
      : t('Nobody has shared a replay yet today. Turn on webcam replay with the camera button, and yours can be the first.') });
  }
  return el('div', { class: 'db-board' }, shared.map(([r, i]) => timeRow(r, i, replays, remove)));
}

const timeText = (res) => (res.penalty === 'DNF' ? 'DNF' : fmt(res.timeMs) + (res.penalty === '+2' ? '+' : ''));

const DEL_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg>';

/**
 * The admin's × on a board row, or null for everybody else: takes that time
 * off the board after a confirm. On today's board the person gets the backup
 * scramble as a final attempt, unless the time was already on the backup.
 * The rules have the final say (firebase.rules.json, `removed/$uid`).
 *
 * @param dayKey  the board's day key
 * @param past    true on a past day's board, where there is no next attempt
 * @param onDone  after it lands, with the row: a past day's one-shot read has
 *                no listener to drop the row by itself
 */
export function adminRemover(ctl, { dayKey, past = false, onDone = null } = {}) {
  if (!ctl.admin || !dayKey) return null;
  const event = ctl.eventId;
  return async (r) => {
    const res = r.result || {};
    const vars = { name: res.name || 'Cuber', time: timeText(res) };
    const msg = past
      ? (r.isMe ? t('Remove your {time} from that day’s board?', vars) : t('Remove {name}’s {time} from that day’s board?', vars))
      : res.backup
        ? (r.isMe ? t('Remove your {time}? It was your backup, so that’s it for you today.', vars)
                  : t('Remove {name}’s {time}? It was their backup, so that’s it for them today.', vars))
        : (r.isMe ? t('Remove your {time}? You get the backup scramble as a final attempt.', vars)
                  : t('Remove {name}’s {time}? They get the backup scramble as a final attempt.', vars));
    /* Somebody else's time may also be a ban (bans/, ADMIN.md): never the
       default, and never offered for your own row. */
    const how = r.isMe
      ? ((await confirmToast(msg, t('Remove'), { timeout: 10000 })) ? 'remove' : null)
      : await choiceToast(msg, [{ label: t('Remove'), value: 'remove' }, { label: t('Remove and ban'), value: 'ban' }],
        { timeout: 10000 });
    if (!how) return;
    try {
      await ctl.removeResult(r, dayKey, event);
    } catch (err) {
      console.warn('[daily] remove refused', err?.code || err);
      toast(/permission.denied/i.test(String(err?.code || err?.message || err))
        ? t('The board refused that — firebase.rules.json needs publishing first')
        : t('Couldn’t remove that time, try again'), { kind: 'bad', long: true });
      return;
    }
    // The clip goes too: nobody can reach it without the row, and deletes are free.
    if (res.replay === true) dropClip({ dayKey, event, uid: r.uid });
    toast(r.isMe ? t('Removed your time') : t('Removed {name}’s time', vars));
    onDone?.(r);
    if (how !== 'ban') return;
    try {
      await ctl.banUser({ uid: r.uid, name: res.name || '', reason: `Scramble of the Day time ${timeText(res)} (${event}, ${new Date(Number(dayKey) + 19800000).toISOString().slice(0, 10)})` });
      toast(t('{name} is banned from the boards, chats and replays', vars), { long: true });
    } catch (err) {
      console.warn('[daily] ban refused', err?.code || err);
      toast(t('The database refused the ban — firebase.rules.json needs publishing first'), { kind: 'bad', long: true });
    }
  };
}

/** The admin's "remove and ban" for a shared replay's player, or null for everybody else (bans/, ADMIN.md). */
function replayBan(ctl, event) {
  if (!ctl.admin) return null;
  return async ({ uid, name }) => {
    try {
      await ctl.banUser({ uid, name, reason: `Shared replay (${event})` });
      toast(t('{name} is banned from the boards, chats and replays', { name: name || 'Cuber' }), { long: true });
      return true;
    } catch (err) {
      console.warn('[daily] ban refused', err?.code || err);
      toast(t('The database refused the ban — firebase.rules.json needs publishing first'), { kind: 'bad', long: true });
      return false;
    }
  };
}

/** Report somebody's shared replay to the admins, for everybody but an admin (reports/, ADMIN.md §6). */
function replayReport(ctl, dayKey, event) {
  if (ctl.admin || !dayKey) return null;
  return async ({ uid, name }) => {
    try {
      const out = await ctl.reportReplay({ dayKey, event, uid, name });
      if (out) toast(out === 'already' ? t('You have already reported that') : t('Reported. An admin will look at it.'));
      return !!out;
    } catch (err) {
      console.warn('[daily] report refused', err?.code || err);
      toast(t('Couldn’t send the report'), { kind: 'bad' });
      return false;
    }
  };
}

function timeRow(r, i, replays = null, remove = null) {
  const res = r.result || {};
  const shown = timeText(res);
  const owner = isOwnerName(res.name);
  const face = avatar(res.name, res.photo, { uid: r.uid, me: r.isMe });
  const nameEl = el('span', {
    class: `db-name${owner ? ' owner-shine' : ''}`, text: res.name || 'Cuber',
    title: owner ? t('{name} — that’s the site owner, click for the card', { name: res.name }) : '',
  });
  if (owner) nameEl.addEventListener('click', (e) => { e.stopPropagation(); openOwnerCard(nameEl); });
  return el('div', { class: 'db-row', dataset: { me: String(r.isMe), rank: String(i + 1) } },
    el('span', { class: 'db-rank', text: String(i + 1) }),
    face,
    /* Name and note share one grid cell, stacked. A sixth column for the note
       would have taken the width off the name on a phone, and the note is the
       thing you can afford to lose the tail of — the name is not. */
    el('div', { class: 'db-who' },
      nameEl,
      res.note ? el('span', { class: 'db-note', text: res.note, title: res.note }) : null),
    (res.suspect || r.clockOff)
      ? el('span', { class: 'db-flag', text: '⚑', title: r.clockOff
          ? 'The submitted time is shorter than the window the server timed it in'
          : 'Far faster than this player’s own recent average' })
      : null,
    el('span', { class: 'db-time' },
      /* First in the cell, so the times still line up down the right on a
         board where some rows have a ▶ and some do not. */
      remove ? el('button', {
        class: 'db-del', type: 'button', html: DEL_SVG,
        title: t('Remove this time (admin)'), 'aria-label': t('Remove this time'),
        onclick: (e) => { e.stopPropagation(); remove(r); },
        // Space on a focused × is not the timer's.
        onkeydown: (e) => e.stopPropagation(),
      }) : null,
      document.createTextNode(shown),
      /* Ranked like any other time; the tag only says which scramble it was. */
      res.backup ? el('span', { class: 'db-flag db-backup', text: t('backup'),
        title: t('Solved on the backup scramble after a misfire') }) : null,
      /* Inside the time's cell rather than a column of its own: the grid's
         other optional cell (the ⚑) would shift a sixth column about. */
      replays && canPlay(replays.dayKey, replays.event, r.uid, res)
        ? playButton({ dayKey: replays.dayKey, event: replays.event, uid: r.uid, result: res, onGone: replays.onGone, onBan: replays.onBan, onReport: replays.onReport })
        : null),
  );
}

/* ---------------------------------------------------------
   The one-line note
   --------------------------------------------------------- */

/**
 * Say one line about your solve, shown on your own row.
 *
 * Only drawn once you have submitted, because the note is a field of the
 * result and there is no row to hang it on before that.
 *
 * Save-on-blur as well as on submit: this is a single field with no
 * surrounding form to give Enter an obvious meaning, and a note that
 * silently vanishes because you clicked away instead of pressing Enter is
 * the one failure mode worth spending eight lines to avoid.
 */
function noteComposer(ctl) {
  let current = ctl.myNote;

  const input = el('input', {
    class: 'db-note-input', type: 'text', autocomplete: 'off',
    maxlength: String(NOTE_MAX_LEN), value: current,
    placeholder: t('Say one line about it…'), 'aria-label': t('Your note on today’s solve'),
  });

  const save = async () => {
    const body = cleanNote(input.value);
    // Nothing to write, and nothing to tell anybody about.
    if (body === cleanNote(current)) return;
    current = body;
    input.value = body;
    if (await ctl.setNote(body)) toast(body ? t('Note saved') : t('Note removed'));
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    /* Escape puts back what was there rather than clearing it — clearing is
       what the empty field already means, and it deletes the note. */
    if (e.key === 'Escape') { e.preventDefault(); input.value = current; input.blur(); }
    // The window is under an app that treats the spacebar as the timer.
    e.stopPropagation();
  });
  input.addEventListener('keyup', (e) => e.stopPropagation());
  input.addEventListener('blur', save);

  const tray = el('div', { class: 'db-emoji', hidden: true },
    RACE_EMOJI.map(ch => el('button', {
      class: 'db-emoji-btn', type: 'button', text: ch, title: ch,
      /* mousedown, not click: a click on the tray blurs the field first, and
         the blur handler saves — so by the time click fired the emoji would
         be going into a field that had already been written without it.
         preventDefault keeps the focus where it is. */
      onmousedown: (e) => {
        e.preventDefault();
        const at = input.selectionStart ?? input.value.length;
        const to = input.selectionEnd ?? at;
        input.value = (input.value.slice(0, at) + ch + input.value.slice(to)).slice(0, NOTE_MAX_LEN);
        const caret = Math.min(at + ch.length, input.value.length);
        input.setSelectionRange(caret, caret);
        input.focus();
      },
    })));

  const emojiBtn = el('button', {
    class: 'db-note-emoji', type: 'button', title: t('Emoji'), text: t('🙂'),
    'aria-label': 'Emoji', 'aria-expanded': 'false',
    onmousedown: (e) => e.preventDefault(),
    onclick: () => {
      tray.hidden = !tray.hidden;
      emojiBtn.setAttribute('aria-expanded', String(!tray.hidden));
    },
  });

  const box = el('div', { class: 'db-note-box' },
    el('div', { class: 'db-note-row' }, input, emojiBtn),
    tray,
  );

  /* Built once and kept, because the board around it is redrawn from
     scratch every time anybody's result or progress lands — and a text field
     replaced mid-sentence loses what you typed and the caret with it. The
     server's copy is only adopted while the field is not being used. */
  box.refresh = () => {
    // Banned (bans/, ADMIN.md): the rules refuse the note, so the field says so rather than taking one.
    input.disabled = ctl.banned;
    input.placeholder = ctl.banned ? t('Notes are off for this account') : t('Say one line about it…');
    const live = ctl.myNote;
    if (live === current) return;
    current = live;
    if (document.activeElement !== input) input.value = live;
  };
  return box;
}

/* ---------------------------------------------------------
   Walking back through the days
   ---------------------------------------------------------

   The board is drawn in two places — the window and the settings drawer —
   so the picker is one object used by both rather than two copies of the
   same cache. It owns three things that are easy to get subtly wrong and
   worth getting wrong only once:

     - which day is being looked at, held OUT of the caller's render
       function. Both callers redraw on every controller change (a countdown
       tick, somebody else's time landing), so a picked day stored inside a
       render would snap back to today a second after it was picked;
     - the one fetched day, cached. Without that, each of those redraws
       fires another read of the same node;
     - dropping a read that lands after the picker has moved on, so a slow
       day never draws itself under the wrong heading.

   Today is `null` rather than its own date, which is what makes flipping
   forward to it resume the LIVE board instead of freezing a snapshot of it
   taken on the way past.
   --------------------------------------------------------- */

/** @param redraw  what the caller does to put a new board on screen */
export function dayHistory(ctl, redraw) {
  let day = null;
  let got = null;
  /** The read in flight, so a redraw mid-fetch does not start a second one. */
  let pending = null;

  const load = (dayId, eventId) => {
    const key = `${dayId}|${eventId}`;
    if (pending === key) return;
    pending = key;
    ctl.pastBoard(dayId, eventId).then(
      r => { got = r; },
      err => {
        console.warn('[daily] past board read failed', err);
        got = { dayId, eventId, rows: [], denied: false, error: true };
      },
    ).then(() => {
      if (pending === key) pending = null;
      if (day === dayId && ctl.eventId === eventId) redraw();
    });
  };

  return {
    /** The day being looked at, or null while that is today. */
    get day() { return day; },

    /** The board for the picked day, started on the first look at it. `mode`: 'times' or 'replays'. */
    view(eventId, mode = 'times') {
      // Only a read of exactly this day AND event is usable — the window and
      // the panel both let the event change underneath this picker.
      const cur = (got && got.dayId === day && got.eventId === eventId) ? got : null;
      if (!cur) load(day, eventId);
      const dayKey = String(dayStartMs(day));
      // A one-shot read has no listener to drop a removed row, so it is dropped here.
      const remove = adminRemover(ctl, { dayKey, past: true, onDone: (r) => {
        if (cur) cur.rows = cur.rows.filter(x => x.uid !== r.uid);
        redraw();
      } });
      return pastView(cur, mode, { dayKey, event: eventId, onGone: redraw, onBan: replayBan(ctl, eventId), onReport: replayReport(ctl, dayKey, eventId) }, remove);
    },

    /** The ‹ · › control itself. `today` is the live day id, or null before it loads. */
    nav(today) {
      const shown = day || today;
      return el('div', { class: 'daily-daynav' },
        el('button', {
          class: 'btn', text: '‹', title: t('The day before'),
          'aria-label': t('The day before'), disabled: !shown,
          onclick: () => { day = shiftDayId(shown, -1); redraw(); },
        }),
        el('span', { class: 'daily-daynav-day', text: day ? shown : 'Today' }),
        el('button', {
          // Today is the far end in this direction: there is no board for a
          // day that has not happened, and the rules would refuse one anyway.
          class: 'btn', text: '›', title: t('The day after'),
          'aria-label': t('The day after'), disabled: !day,
          onclick: () => {
            const to = shiftDayId(shown, 1);
            day = (today && to >= today) ? null : to;
            redraw();
          },
        }),
      );
    },
  };
}

/**
 * What a past day looks like before, during and after it fails.
 *
 * The locked case is not an error and is deliberately not worded as one: the
 * rules let you read a day's results only if you have a row in that day —
 * the same "send your own time first" bargain today's board makes, which for
 * a day already over simply cannot be met any more.
 */
function pastView(got, mode = 'times', replays = null, remove = null) {
  if (!got) return el('div', { class: 'db-empty', text: t('Loading that day’s board…') });
  if (got.error) {
    return el('div', { class: 'db-empty', text:
      t('Could not read that day’s board — check your connection.') });
  }
  if (got.denied) {
    return el('div', { class: 'db-locked' },
      el('div', { class: 'db-locked-icon', text: t('🔒') }),
      el('div', { class: 'db-locked-text', text:
        t('You did not submit an attempt for this event that day, so its board stays locked. The reveal rule applies to every day, not just today.') }));
  }
  if (mode === 'replays' && replays) return replaysBoard(got.rows, true, replays, { past: true, remove });
  return timeBoard(got.rows, true, replays, { remove });
}

/* ---------------------------------------------------------
   The count board — who did the most solves today
   --------------------------------------------------------- */

export function countBoard(rows) {
  if (!rows.length) {
    return el('div', { class: 'db-empty', text: t('No solves counted yet today. Yours would be the first.') });
  }
  return el('div', { class: 'db-board' }, rows.map((r, i) =>
    el('div', { class: 'db-row', dataset: { me: String(r.isMe), rank: String(i + 1) } },
      el('span', { class: 'db-rank', text: String(i + 1) }),
      avatar(r.name, r.photo, { uid: r.uid, me: r.isMe }),
      el('span', { class: 'db-name', text: r.name }),
      el('span', { class: 'db-time', text: String(r.n) }),
      el('span', { class: 'db-unit', text: r.n === 1 ? 'solve' : 'solves' }),
    )));
}

/* ---------------------------------------------------------
   Signing in, asked for where it is needed
   --------------------------------------------------------- */

/**
 * The window's own sign-in call to action.
 *
 * Pointing at the account icon in a top bar this window has deliberately
 * hidden was not a real instruction — it named a control that was not on
 * screen. The button that fixes the problem belongs next to the sentence
 * describing it, and it runs the same `signIn('google')` the settings panel
 * does; there is no second identity here.
 */
function signInPrompt() {
  return el('div', { class: 'sotd-signin' },
    el('div', { class: 'sotd-signin-text', text:
      t('Anyone can watch today’s board, but a time on it needs a name attached.') }),
    el('button', {
      class: 'btn primary full', text: t('Sign in with Google to take part'),
      onclick: async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        try { await signIn('google'); }
        catch (err) {
          // A popup you closed yourself is a decision, not a failure.
          if (err?.code !== 'auth/popup-closed-by-user') {
            console.warn('[daily] sign-in failed', err);
            toast('Could not sign in — check your connection and try again', { kind: 'bad' });
          }
          btn.disabled = false;
        }
      },
    }),
  );
}

/* ===========================================================
   The window
   =========================================================== */

/** What the bar says about where you are in the day's one attempt. */
const STATE_TEXT = {
  'signed-out': t('sign in to take part'),
  waiting: t('waiting for today’s scramble'),
  ready: t('this is today’s scramble — one attempt'),
  backup: t('backup scramble — final attempt'),
  done: t('attempt submitted'),
  removed: t('time removed — no attempts left today'),
};

/** The live window, or null. At most one is ever open. */
let open = null;

export function sotdOpen() { return !!open; }

/**
 * Enter the Scramble of the Day window.
 *
 * The bar and the board card are static markup in index.html, shown only by
 * the `sotd` class on <body> — not elements this function creates. That is
 * deliberate: the window is a LAYOUT, and a layout that only exists once
 * some JavaScript has run is one that can be half-applied. With the markup
 * already there, `body.sotd` is the entire state, which is also what makes
 * the window checkable from the outside without driving the whole feature.
 *
 * `ctl` is daily.js's controller; `onExit` runs after the window is gone, so
 * main.js decides what leaving means for an armed attempt without this file
 * having an opinion about it. `solving` answers "is the timer mid-solve right
 * now" — asked rather than inspected, because the timer is main.js's private
 * state and reaching into it from here would be reading a variable that is
 * not on `app` at all.
 */
export function openSotd(app, ctl, { onExit, solving = () => false } = {}) {
  if (open) return open;

  const bar = document.getElementById('sotd-bar');
  const board = document.getElementById('sotd-board');
  const dayNode = bar.querySelector('.sotd-day');
  const stateNode = bar.querySelector('.sotd-state');
  const countNode = bar.querySelector('.sotd-count');
  const exitBtn = document.getElementById('sotd-exit');

  /* The boards are ALWAYS on screen, which is a correction rather than a
     preference. Hiding the whole card until you had submitted meant a window
     whose entire subject is a leaderboard opened showing no leaderboard —
     and in the state where the time board is legitimately gated, that gate is
     the single most useful thing the window can say, because it explains why.
     The count board is public and needs no gate at all, so it was being
     withheld for no reason whatsoever. */
  /* Kept across renders — see the note on box.refresh in noteComposer. */
  let noteBox = null;
  const note = () => {
    noteBox ||= noteComposer(ctl);
    noteBox.refresh();
    return noteBox;
  };

  /* Shared replays (sotd-replays.js): the Share box under the note, kept
     across renders the same way, and which of the two views is up — the
     times, or the replays people shared. Held out here for the same reason
     the picker's day is: a redraw every second must not reset it. */
  bindReplays(ctl);
  let shareEl = null;
  const share = () => {
    shareEl ||= shareBox(ctl);
    shareEl.refresh();
    return shareEl;
  };
  /* The day's chat (sotd-chat.js): its own column down the right, built
     the first time it opens and then kept, like the note box. Below the
     timer's breakpoint there is no right-hand column to give it, so it takes
     the board's place instead, behind a Chat tab and a way back. */
  const chatHost = document.getElementById('sotd-chat');
  let chat = null;
  let chatShown = false;
  const chatView = (on) => document.body.classList.toggle('sotd-chat-view', !!on);
  /** Show, hide or refresh the chat; true when whether it is open changed. */
  const syncChat = () => {
    const on = ctl.chatOpen;
    if (on && !chat) {
      chat = mountChat(ctl, { avatar, onBack: () => chatView(false) });
      chatHost.append(chat.node);
    }
    chatHost.hidden = !on;
    if (!on) chatView(false);
    chat?.refresh();
    const changed = on !== chatShown;
    chatShown = on;
    return changed;
  };
  /* A message is no reason to redraw the board. Only the chat opening or
     closing is, for the narrow screen's Chat tab. */
  const onChat = () => { if (syncChat()) { renderBoard(); placeBoard(); } };

  let mode = 'times';
  const tab = (id, label) => el('button', {
    class: 'sotd-tab', type: 'button', role: 'tab', text: label,
    'aria-selected': String(mode === id),
    onclick: () => { if (mode !== id) { mode = id; renderBoard(); placeBoard(); } },
    // Space on a focused tab is not the timer's.
    onkeydown: (e) => e.stopPropagation(),
  });

  const renderBoard = () => {
    board.innerHTML = '';
    board.hidden = false;
    const today = ctl.snap?.dayId || null;
    const past = history.day;
    const rows = past ? [] : ctl.ranked();
    const dayKey = past ? String(dayStartMs(past)) : ctl.net?.target?.().dayKey;
    const replays = dayKey ? { dayKey, event: ctl.eventId, onGone: () => { renderBoard(); placeBoard(); }, onBan: replayBan(ctl, ctl.eventId), onReport: replayReport(ctl, dayKey, ctl.eventId) } : null;
    // Today's rows only: a past day's picker builds its own (it has to drop the row itself).
    const opts = { remove: past ? null : adminRemover(ctl, { dayKey }), locked: lockText(ctl) };
    const sharedN = replays ? rows.filter(r => r.result?.replay === true).length : 0;
    board.append(el('div', { class: 'sotd-board-card' },
      /* The heading and the picker share a row: the column is narrow and
         parked under the scramble, so a control on a line of its own costs
         the board a row of names to buy nothing. */
      el('div', { class: 'sotd-board-head' },
        /* The picker beside it is already showing the date, so the heading
           does not repeat it — it says only what kind of board this is. */
        el('div', { class: 'sotd-tabs', role: 'tablist', 'aria-label': t('Board') },
          tab('times', past ? t('Times') : t('Today’s times')),
          tab('replays', sharedN ? t('Replays · {n}', { n: sharedN }) : t('Replays')),
          /* Narrow screens only (the stylesheet hides it elsewhere, where the
             chat has a column of its own): swaps the board for the chat. */
          ctl.chatOpen ? el('button', {
            class: 'sotd-tab sotd-tab-chat', type: 'button', role: 'tab', 'aria-selected': 'false', text: t('Chat'),
            onclick: () => chatView(true),
            onkeydown: (e) => e.stopPropagation(),
          }) : null),
        history.nav(today)),
      /* Today is the LIVE board, off the running listeners and their reveal
         gate. A past day is a one-shot read that never touches them, so the
         bar above, the rollover check and an armed attempt all stay pointed
         at today however far back this has been walked. */
      past ? history.view(ctl.eventId, mode)
        : mode === 'replays' && replays ? replaysBoard(rows, ctl.revealed, replays, opts)
        : timeBoard(rows, ctl.revealed, replays, opts),
      /* Under the board rather than over it: the board is what the window is
         for, and the note is something you do once, after reading it. Today
         only — a past day's rows come from a one-shot read that the composer
         has no live copy of. */
      (!past && ctl.revealed) ? note() : null,
      (!past && ctl.revealed) ? share() : null,
      ctl.snap?.signedIn ? null : signInPrompt(),
      SHOW_COUNT_BOARD ? [
        el('h3', { class: 'sotd-h3-second' }, t('Most solves today'),
          el('span', { class: 'sotd-h3-note', text: t('any event · resets at midnight IST') })),
        countBoard(ctl.countBoard()),
      ] : null,
    ));
  };

  /* Declared after renderBoard because it calls it, and before onChange ever
     runs, which is the only thing that matters for the closure. */
  /* A past day's read can land after the window has closed, and renderBoard
     un-hides the card — so a slow fetch put the board back over the ordinary
     timer. Only the window that asked may draw. */
  const history = dayHistory(ctl, () => { if (open !== state) return; renderBoard(); placeBoard(); });

  const onChange = () => {
    dayNode.textContent = ctl.snap?.dayId || '—';
    /* What the window is currently doing, in the bar rather than in a toast:
       a toast about the state you are in disappears five seconds later and
       leaves you looking at a screen that no longer explains itself. */
    const st = ctl.status();
    stateNode.textContent = STATE_TEXT[st] || '';
    stateNode.dataset.state = st;
    syncChat();
    renderBoard();
    placeBoard();
  };

  /**
   * Park the column under the scramble rather than beside it.
   *
   * Measured rather than guessed at with a magic `top`, because the scramble
   * is one line or two depending on the event and the reader's own size
   * setting, and a constant that clears it today stops clearing it the first
   * time somebody opens this on a 5x5. Left to the stylesheet below the
   * timer's breakpoint, where the board is a bottom sheet and has no business
   * being positioned from up here.
   */
  const placeBoard = () => {
    const root = document.documentElement;
    if (window.innerWidth < 861) {
      root.style.removeProperty('--sotd-board-top');
      root.style.removeProperty('--sotd-chat-bottom');
      /* The chat's sheet grows with the room, and at the board's 46vh it
         reached up over the digits on a tall phone. Capped at the room below
         them instead, but never so short that it stops being a chat. */
      const digits = document.getElementById('timer-display')?.getBoundingClientRect();
      if (digits?.height) {
        root.style.setProperty('--sotd-chat-max', `${Math.max(220, Math.round(window.innerHeight - digits.bottom - 12))}px`);
      }
      return;
    }
    root.style.removeProperty('--sotd-chat-max');
    const zone = document.getElementById('scramble-zone');
    if (!zone) return;
    root.style.setProperty('--sotd-board-top', `${Math.round(zone.getBoundingClientRect().bottom + 14)}px`);
    /* The chat's column stops above the cube preview when the preview is in
       its way, which in its usual bottom-right corner it is. Measured rather
       than assumed: the preview can be resized, dragged or switched off. */
    const cube = document.getElementById('panel-cube');
    const r = cube?.getBoundingClientRect();
    const colLeft = window.innerWidth - 18 - board.getBoundingClientRect().width;
    const inWay = r && r.width > 2 && r.height > 2 && r.right > colLeft && r.top < window.innerHeight;
    if (inWay) root.style.setProperty('--sotd-chat-bottom', `${Math.round(window.innerHeight - r.top + 12)}px`);
    else root.style.removeProperty('--sotd-chat-bottom');
  };

  const tick = () => {
    placeBoard();
    if (!ctl.snap?.nextResetMs || !ctl.net) { countNode.textContent = '—'; return; }
    ctl.checkRollover();
    countNode.textContent = formatCountdown(ctl.snap.nextResetMs - ctl.net.serverNow());
  };

  const close = () => {
    if (open !== state) return;
    open = null;
    document.body.classList.remove('sotd');
    board.hidden = true;
    board.innerHTML = '';
    chat?.dispose();
    chat = null;
    chatShown = false;
    chatHost.hidden = true;
    chatHost.innerHTML = '';
    chatView(false);
    clearInterval(state.timer);
    document.documentElement.style.removeProperty('--sotd-board-top');
    document.documentElement.style.removeProperty('--sotd-chat-bottom');
    document.documentElement.style.removeProperty('--sotd-chat-max');
    window.removeEventListener('resize', placeBoard);
    shareEl?.dispose();
    ctl.removeEventListener('change', onChange);
    ctl.removeEventListener('chat', onChat);
    document.removeEventListener('keydown', onKey, true);
    exitBtn.removeEventListener('click', close);
    onExit?.();
  };

  /* Esc leaves, captured before the app's own handlers see it: while this
     window is up it is the outermost thing on screen, and Esc on the
     outermost thing means "close this", not whatever it meant underneath.
     Not while the timer is mid-solve, though — Esc is how you abandon a
     solve, and that has to keep working from in here. */
  const onKey = (e) => {
    if (e.key !== 'Escape' || solving()) return;
    /* Something open over the window has Esc first: the camera panel (a
       popover, closed by its own handler) or a replay player (a dialog). */
    if (document.querySelector('dialog[open]') || document.getElementById('popover')?.hidden === false) return;
    /* So does a text field: in the chat or the note, Esc means "stop typing
       here", and the field's own handler does that. Leaving the window from
       the middle of a sentence is not what anybody pressing it meant. */
    if (e.target?.closest?.('input, textarea')) return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };

  const state = { close, timer: 0 };
  document.addEventListener('keydown', onKey, true);
  exitBtn.addEventListener('click', close);
  ctl.addEventListener('change', onChange);
  ctl.addEventListener('chat', onChat);

  document.body.classList.add('sotd');
  window.addEventListener('resize', placeBoard);
  open = state;
  onChange();
  tick();
  state.timer = setInterval(tick, 1000);
  return state;
}

export function closeSotd() { open?.close(); }
