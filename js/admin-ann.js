import { t } from './i18n.js';
/* ===========================================================
   Tagda Timer — the admin console's Announce tab (js/admin.js)

   Every announcement (announce.js: the database's, and the two built in),
   with what each is doing now and its numbers; an editor whose preview is
   drawn by the same code and stylesheet as the app (announce-ui.js,
   css/announce.css); End now; and Show again, which bumps the version so
   everybody who answered is asked once more.

   Every save is one update: announcements/<id> and its configLog entry
   (`path: 'ann/<id>'`), which the rules require of each other, the same
   chain as a setting's (ADMIN.md §12).
   =========================================================== */

import { el } from './util.js';
import { toast } from './toast.js';
import { allAnnouncements, isLive, ANN_STYLES, ANN_AUDIENCES, ANN_PANELS, ANN_ID, LIMITS, BUILT_IN } from './announce.js';
import { annNode } from './announce-ui.js';

const AUDIENCE = {
  everyone: 'Everyone', signedIn: 'Signed in', webcamOff: 'Camera off', notOpened: 'Has not opened that panel',
  newUsers: 'New (under 50 solves here)', returningUsers: 'Returning (50 solves or more)',
  testers: 'Testers (and admins)', admins: 'Admins only',
};
const STYLE = { popup: 'Popup', card: 'Card', pill: 'Pill' };
const PANEL = {
  camera: 'Webcam replay', sotd: 'Scramble of the Day', race: 'Race', stats: 'Statistics', appearance: 'Appearance',
  settings: 'Settings', spotify: 'Spotify', gear: 'Gear', about: 'About',
};

/** datetime-local's value for ms, in this phone's own time zone; '' for none. */
const toLocal = (ms) => {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fromLocal = (v) => (v ? new Date(v).getTime() || 0 : 0);

/**
 * @param ctx  { S, scheduleRender, raw, ago, who, openSheet, closeSheet, cfg(section, key) }
 */
export function createAnnounce(ctx) {
  const { S, raw, ago } = ctx;
  const A = { stored: {}, stats: {}, loaded: false, unsubs: [], draft: null };
  const sdk = () => S.sdk;
  const ref = (path) => sdk().ref(sdk().db, path);

  function start() {
    if (A.unsubs.length || !S.sdk) return;
    const { onValue } = sdk();
    A.unsubs.push(
      onValue(ref('announcements'), (s) => { A.stored = s.val() || {}; A.loaded = true; ctx.scheduleRender(); },
        () => { A.refused = true; A.loaded = true; ctx.scheduleRender(); }),
      onValue(ref('annStats'), (s) => { A.stats = s.val() || {}; ctx.scheduleRender(); }, () => {}),
    );
  }
  function stop() {
    for (const off of A.unsubs.splice(0)) off();
    Object.assign(A, { stored: {}, stats: {}, loaded: false, draft: null, refused: false });
  }

  const all = () => allAnnouncements(A.stored, ctx.cfg);
  const status = (a, now = Date.now()) => (isLive(a, now) ? 'live' : a.startAt > now ? 'scheduled' : 'ended');
  const STATUS = { live: () => t('Live'), scheduled: () => t('Scheduled'), ended: () => t('Ended') };

  function counts(a) {
    const rows = Object.values(A.stats?.[a.id]?.[a.version] || {});
    return {
      shown: rows.length,
      clicked: rows.filter(v => v === 'clicked').length,
      dismissed: rows.filter(v => v === 'dismissed').length,
    };
  }

  /* ---------------- writing ---------------- */

  /** The record as stored: every field the rules want, plus the log pointer. */
  function record(a, logId) {
    const S2 = sdk();
    const rec = {
      title: a.title, text: a.text || '', style: a.style, audience: a.audience,
      startAt: a.startAt || 0, maxShows: a.maxShows || 0, version: a.version || 1,
      log: logId, by: S.user.uid, updatedAt: S2.serverTimestamp(),
    };
    if (a.endAt) rec.endAt = a.endAt;
    if (a.reminder) rec.reminder = true;
    if (a.button) rec.button = { ...a.button };
    return rec;
  }

  async function write(id, a, action) {
    const S2 = sdk();
    const logId = S2.push(ref('configLog')).key;
    try {
      await S2.update(S2.ref(S2.db), {
        [`announcements/${id}`]: record(a, logId),
        [`configLog/${logId}`]: { uid: S.user.uid, at: S2.serverTimestamp(), path: `ann/${id}`, action, title: a.title },
      });
      return true;
    } catch (err) {
      console.warn('[admin] announcement refused', err?.code || err);
      toast(t('The database refused that'), { kind: 'bad', hold: true });
      return false;
    }
  }

  async function endNow(a) {
    if (await write(a.id, { ...a, endAt: Date.now() }, 'end')) toast(t('Ended. Nobody new will see it.'), { kind: 'good' });
  }

  async function showAgain(a) {
    // An ended one starts again for a week; set another end in the editor.
    const ended = a.endAt && a.endAt <= Date.now();
    const next = { ...a, version: (a.version || 1) + 1, endAt: ended ? Date.now() + 7 * 86_400_000 : a.endAt };
    if (await write(a.id, next, 'again')) toast(t('Version {v}: everybody in its audience sees it again.', { v: next.version }), { kind: 'good', long: true });
  }

  /* ---------------- views ---------------- */

  function view(sub) {
    start();
    if (A.refused) return [el('h1', { class: 'ac-h1', text: 'Announce' }), ctx.gate('Publish the rules first', 'Announcements need the firebase.rules.json from this version of the page.')];
    if (sub) return viewEditor(sub);
    const list = Object.values(all()).sort((x, y) => (y.startAt || 0) - (x.startAt || 0));
    return [
      el('h1', { class: 'ac-h1', text: 'Announce' }),
      el('p', { class: 'ac-sub', text: 'What people see in the timer: a popup, a card, or a pill on the main screen. Never during a solve, never over anything else, one at a time.' }),
      el('div', { class: 'ac-list' },
        el('a', { class: 'ac-btn primary ac-new', href: '#ann/new', text: 'New announcement' }),
        ...(A.loaded ? list.map(card) : [el('p', { class: 'ac-note', text: 'Loading…' })])),
    ];
  }

  function card(a) {
    const st = status(a);
    const c = counts(a);
    const when = [
      a.startAt ? t('from {when}', { when: new Date(a.startAt).toLocaleString() }) : null,
      a.endAt ? (st === 'ended' ? t('ended {when}', { when: ago(a.endAt) }) : t('until {when}', { when: new Date(a.endAt).toLocaleString() })) : t('no end'),
    ].filter(Boolean).join(' · ');
    return el('div', { class: 'ac-row ac-ann' },
      el('div', { class: 'ac-ann-head' },
        raw('b', { class: 'ac-label' }, a.title),
        el('span', { class: `ac-pill ac-${st}`, text: STATUS[st]() })),
      a.text ? raw('p', { class: 'ac-help' }, a.text) : null,
      el('div', { class: 'ac-facts' },
        el('span', { class: 'ac-pill', text: STYLE[a.style] }),
        el('span', { class: 'ac-pill', text: AUDIENCE[a.audience] }),
        a.builtIn ? el('span', { class: 'ac-pill', text: a.stored ? 'built in, edited' : 'built in' }) : null,
        raw('span', { class: 'ac-range' }, t('version {v}', { v: a.version }) + (a.maxShows ? ` · ${t('{n} shows each', { n: a.maxShows })}` : ''))),
      raw('span', { class: 'ac-entry-meta' }, when),
      raw('span', { class: 'ac-entry-meta' }, t('Shown {s} · clicked {c} · dismissed {d}', { s: c.shown, c: c.clicked, d: c.dismissed }) + ' · ' + t('counts signed-in users only')),
      el('div', { class: 'ac-entry-actions' },
        el('a', { class: 'ac-btn small', href: `#ann/${a.id}`, text: 'Edit' }),
        el('button', { class: 'ac-btn small', text: 'Preview', onclick: () => preview(a) }),
        st === 'live' ? el('button', { class: 'ac-btn small', text: 'End now', onclick: () => endNow(a) }) : null,
        el('button', { class: 'ac-btn small', text: 'Show again', onclick: () => showAgain(a) })));
  }

  function preview(a) {
    ctx.openSheet(
      el('h2', { class: 'ac-h2', text: t('{style}, as people see it', { style: t(STYLE[a.style]) }) }),
      el('div', { class: `ac-preview ac-preview-${a.style}` }, annNode(a, a.style, {}, { preview: true })),
      a.reminder ? el('p', { class: 'ac-sub', text: 'After Maybe later, this pill stays on the main screen until it is crossed out:' }) : null,
      a.reminder ? el('div', { class: 'ac-preview ac-preview-pill' }, annNode(a, 'pill', {}, { preview: true })) : null,
      el('div', { class: 'ac-sheet-actions' }, el('button', { class: 'ac-btn', text: 'Close', onclick: ctx.closeSheet })));
  }

  /** The editor: the draft lives in A.draft while the fields are typed into. */
  function viewEditor(id) {
    const isNew = id === 'new';
    const existing = isNew ? null : all()[id];
    if (!isNew && !existing) return [el('a', { class: 'ac-back', href: '#ann', text: '‹ Announce' }), el('p', { class: 'ac-note', text: 'No such announcement.' })];
    if (!A.draft || A.draft.key !== id) {
      const base = existing || { title: '', text: '', style: 'card', audience: 'everyone', startAt: 0, endAt: 0, maxShows: 3, version: 1, button: null };
      A.draft = { key: id, id: isNew ? '' : id, ...JSON.parse(JSON.stringify(base)) };
    }
    const d = A.draft;
    const previewBox = el('div', { class: 'ac-preview' });
    const errors = el('p', { class: 'ac-err' });
    const repaint = () => {
      const problems = check(d, isNew);
      errors.textContent = problems.join(' · ');
      save.disabled = problems.length > 0;
      const shown = { ...d, button: d.button?.label ? d.button : null, title: d.title || t('(a title)') };
      previewBox.className = `ac-preview ac-preview-${d.style}`;
      previewBox.replaceChildren(annNode(shown, d.style, {}, { preview: true }));
    };
    const field = (label, input, help) => el('label', { class: 'ac-field' },
      el('span', { class: 'ac-label', text: label }), input, help ? el('span', { class: 'ac-help', text: help }) : null);
    const text = (key, max, { area = false } = {}) => {
      const i = el(area ? 'textarea' : 'input', { class: 'ac-inp', maxlength: max, rows: area ? 3 : null, autocomplete: 'off' });
      i.value = d[key] || '';
      i.addEventListener('input', () => { d[key] = i.value; repaint(); });
      return i;
    };
    const select = (value, options, onPick) => {
      const s = el('select', { class: 'ac-inp' }, ...options.map(([v, label]) => raw('option', { value: v }, label)));
      s.value = value;
      s.addEventListener('change', () => { onPick(s.value); repaint(); });
      return s;
    };
    const idInput = el('input', { class: 'ac-inp', maxlength: 40, autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', placeholder: 'new-feature' });
    idInput.value = d.id;
    idInput.addEventListener('input', () => { d.id = idInput.value.trim(); repaint(); });

    const action = d.button?.action || 'none';
    const label = el('input', { class: 'ac-inp', maxlength: LIMITS.label, autocomplete: 'off' });
    label.value = d.button?.label || '';
    const link = el('input', { class: 'ac-inp', maxlength: LIMITS.target, autocomplete: 'off', inputmode: 'url', placeholder: 'https://' });
    link.value = d.button?.action === 'link' ? d.button.target : '';
    const panel = select(d.button?.action === 'panel' ? d.button.target : 'camera', ANN_PANELS.map(p => [p, t(PANEL[p])]), (v) => { setButton(); });
    const kind = select(action, [['none', t('No button')], ['link', t('Opens a link')], ['panel', t('Opens a panel')]], () => { setButton(); show(); });
    const setButton = () => {
      const k = kind.value;
      d.button = k === 'none' ? null : { label: label.value, action: k, target: k === 'link' ? link.value.trim() : panel.value };
    };
    label.addEventListener('input', () => { setButton(); repaint(); });
    link.addEventListener('input', () => { setButton(); repaint(); });
    const linkField = field(t('Link'), link);
    const panelField = field(t('Panel'), panel);
    const labelField = field(t('Button'), label);
    const show = () => {
      labelField.hidden = kind.value === 'none';
      linkField.hidden = kind.value !== 'link';
      panelField.hidden = kind.value !== 'panel';
    };
    show();

    const startI = el('input', { class: 'ac-inp', type: 'datetime-local' });
    startI.value = toLocal(d.startAt);
    startI.addEventListener('input', () => { d.startAt = fromLocal(startI.value); repaint(); });
    const endI = el('input', { class: 'ac-inp', type: 'datetime-local' });
    endI.value = toLocal(d.endAt);
    endI.addEventListener('input', () => { d.endAt = fromLocal(endI.value); repaint(); });
    const shows = el('input', { class: 'ac-inp', inputmode: 'numeric', autocomplete: 'off' });
    shows.value = String(d.maxShows || 0);
    shows.addEventListener('input', () => { d.maxShows = /^\d+$/.test(shows.value) ? Number(shows.value) : -1; repaint(); });
    const reminder = el('input', { type: 'checkbox' });
    reminder.checked = !!d.reminder;
    reminder.addEventListener('change', () => { d.reminder = reminder.checked; repaint(); });

    const save = el('button', { class: 'ac-btn primary', text: isNew ? 'Create' : 'Save' });
    save.addEventListener('click', async () => {
      setButton();
      if (check(d, isNew).length) return;
      const target = isNew ? d.id : id;
      save.disabled = true;
      if (await write(target, d, isNew ? 'create' : 'edit')) {
        A.draft = null;
        toast(isNew ? t('Created.') : t('Saved. People who answered the last version are not asked again; Show again does that.'), { kind: 'good', long: true });
        location.hash = '#ann';
      } else save.disabled = false;
    });

    const form = el('div', { class: 'ac-form' },
      el('div', { class: 'ac-row' },
        isNew ? field(t('Id'), idInput, t('Letters, digits and dashes. It cannot change later.')) : raw('span', { class: 'ac-uid' }, id),
        field(t('Title'), text('title', LIMITS.title)),
        field(t('Text'), text('text', LIMITS.text, { area: true })),
        field(t('What the button does'), kind), labelField, linkField, panelField),
      el('div', { class: 'ac-row' },
        field(t('Style'), select(d.style, ANN_STYLES.map(s => [s, t(STYLE[s])]), (v) => { d.style = v; })),
        field(t('Who sees it'), select(d.audience, ANN_AUDIENCES.map(a => [a, t(AUDIENCE[a])]), (v) => { d.audience = v; })),
        field(t('Starts'), startI, t('Empty: at once.')),
        field(t('Ends'), endI, t('Empty: no end.')),
        field(t('Shows per browser'), shows, t('Page loads it may appear on before it stops asking. 0: until answered.')),
        el('label', { class: 'ac-check' }, reminder, el('span', { text: t('A popup leaves a pill until crossed out (“Maybe later”)') }))),
      el('h2', { class: 'ac-h2 ac-gap', text: 'Preview' }),
      el('p', { class: 'ac-sub', text: 'Drawn by the same code and stylesheet as the timer, in its default theme.' }),
      previewBox, errors,
      el('div', { class: 'ac-sheet-actions' },
        el('a', { class: 'ac-btn', href: '#ann', text: 'Cancel', onclick: () => { A.draft = null; } }),
        save));
    repaint();
    return [el('a', { class: 'ac-back', href: '#ann', text: '‹ Announce' }),
      el('h1', { class: 'ac-h1', text: isNew ? 'New announcement' : 'Edit announcement' }), form];
  }

  /** What is wrong with a draft, in words; empty when it can be saved. */
  function check(d, isNew) {
    const out = [];
    if (isNew && !ANN_ID.test(d.id || '')) out.push(t('An id of letters, digits and dashes'));
    if (isNew && (A.stored[d.id] || BUILT_IN[d.id])) out.push(t('That id is taken'));
    if (!d.title?.trim()) out.push(t('A title'));
    if (d.button) {
      if (!d.button.label?.trim()) out.push(t('A label for the button'));
      if (d.button.action === 'link' && !/^https:\/\/[^\s]+$/.test(d.button.target || '')) out.push(t('A link starting https://'));
    }
    if (!(d.maxShows >= 0 && d.maxShows <= LIMITS.maxShows)) out.push(t('Shows from 0 to {n}', { n: LIMITS.maxShows }));
    if (d.endAt && d.endAt <= (d.startAt || 0)) out.push(t('An end after the start'));
    return out;
  }

  return { view, start, stop };
}
