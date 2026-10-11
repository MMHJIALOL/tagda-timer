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

   Round two (ADMIN.md §21): targeting on top of the audience (versions,
   phone or desktop, a language, signed in only), Spanish words, each
   version's funnel, Preview in the app (the real timer in a phone, tablet or
   desktop frame, saying whether a card found its button), and What's new
   (#news: changelog/, shown in the timer's About).
   =========================================================== */

import { el } from './util.js';
import { toast } from './toast.js';
import { allAnnouncements, isLive, ANN_STYLES, ANN_AUDIENCES, ANN_PANELS, ANN_ID, LIMITS, BUILT_IN, localized, normalise } from './announce.js';
import { annNode } from './announce-ui.js';
import { EMULATED } from './sync-auth.js';
import { APP_VERSION } from './version.js';

/** The frames Preview in the app offers: the real timer at that size. */
const DEVICES = { phone: [390, 844], tablet: [820, 1180], desktop: [1280, 800] };
/** Where the console leaves the draft for the frame (js/announcer.js PREVIEW_KEY: same origin, same browser). */
const PREVIEW_KEY = 'tdt-ann-preview';

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
  const A = { stored: {}, stats: {}, loaded: false, unsubs: [], draft: null, news: {}, newsLoaded: false, newsRefused: false, newsDraft: null };
  const sdk = () => S.sdk;
  const ref = (path) => sdk().ref(sdk().db, path);

  function start() {
    if (A.unsubs.length || !S.sdk) return;
    const { onValue } = sdk();
    A.unsubs.push(
      onValue(ref('announcements'), (s) => { A.stored = s.val() || {}; A.loaded = true; ctx.scheduleRender(); },
        () => { A.refused = true; A.loaded = true; ctx.scheduleRender(); }),
      onValue(ref('annStats'), (s) => { A.stats = s.val() || {}; ctx.scheduleRender(); }, () => {}),
      onValue(ref('changelog'), (s) => { A.news = s.val() || {}; A.newsLoaded = true; A.newsRefused = false; ctx.scheduleRender(); },
        () => { A.newsLoaded = true; A.newsRefused = true; ctx.scheduleRender(); }),
    );
  }
  function stop() {
    for (const off of A.unsubs.splice(0)) off();
    Object.assign(A, { stored: {}, stats: {}, loaded: false, draft: null, refused: false });
  }

  const all = () => allAnnouncements(A.stored, ctx.cfg);
  const status = (a, now = Date.now()) => (isLive(a, now) ? 'live' : a.startAt > now ? 'scheduled' : 'ended');
  const STATUS = { live: () => t('Live'), scheduled: () => t('Scheduled'), ended: () => t('Ended') };

  function counts(a, version = a.version) {
    const rows = Object.values(A.stats?.[a.id]?.[version] || {});
    return {
      shown: rows.length,
      clicked: rows.filter(v => v === 'clicked').length,
      dismissed: rows.filter(v => v === 'dismissed').length,
    };
  }

  /** Each version's funnel, newest first: shown, then what those people did. Signed-in people only (the stats). */
  function funnel(a) {
    const versions = Object.keys(A.stats?.[a.id] || {}).map(Number).filter(Boolean).sort((x, y) => y - x);
    if (!versions.length) return null;
    const bar = (n, of, cls) => el('span', { class: `ac-fbar ${cls}`, style: `width:${of ? Math.max(2, Math.round((n / of) * 100)) : 0}%` });
    return el('div', { class: 'ac-funnel' }, ...versions.slice(0, 4).map((v) => {
      const c = counts(a, v);
      const answered = c.clicked + c.dismissed;
      return el('div', { class: 'ac-funnel-row' },
        raw('span', { class: 'ac-funnel-v' }, `v${v}`),
        el('span', { class: 'ac-funnel-bars' }, bar(c.clicked, c.shown, 'clicked'), bar(c.dismissed, c.shown, 'dismissed'), bar(c.shown - answered, c.shown, 'open')),
        raw('span', { class: 'ac-funnel-n' }, t('{s} shown · {c} clicked · {d} dismissed', { s: c.shown, c: c.clicked, d: c.dismissed })));
    }));
  }

  /** What narrows it beyond the audience, as pills. */
  const targeting = (a) => [
    a.minVer || a.maxVer ? (a.minVer && a.maxVer ? t('versions {a}–{b}', { a: a.minVer, b: a.maxVer }) : a.minVer ? t('version {a} and later', { a: a.minVer }) : t('up to version {b}', { b: a.maxVer })) : null,
    a.platform === 'phone' ? t('phones') : a.platform === 'desktop' ? t('computers') : null,
    a.lang === 'es' ? t('Spanish only') : a.lang === 'en' ? t('English only') : null,
    a.signedInOnly ? t('signed in only') : null,
    a.es?.title || a.es?.text ? t('in Spanish too') : null,
  ].filter(Boolean).map(x => el('span', { class: 'ac-pill', text: x }));

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
    // Targeting and Spanish (ADMIN.md §21): only what is set, so an untargeted one saves as before.
    if (a.minVer) rec.minVer = a.minVer;
    if (a.maxVer) rec.maxVer = a.maxVer;
    if (a.platform) rec.platform = a.platform;
    if (a.lang) rec.lang = a.lang;
    if (a.signedInOnly) rec.signedInOnly = true;
    const es = Object.fromEntries(Object.entries(a.es || {}).filter(([k, v]) => ['title', 'text', 'label'].includes(k) && typeof v === 'string' && v.trim()));
    if (Object.keys(es).length) rec.es = es;
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

  /** Announcements, or What's new: two views of the tab. */
  const subnav = (on) => el('nav', { class: 'ac-subtabs', 'aria-label': t('Announce') },
    ...[['list', t('Announcements'), '#ann'], ['news', t('What’s new'), '#news']].map(([key, label, href]) => raw('a', {
      class: `ac-subtab${on === key ? ' on' : ''}`, href, 'aria-current': on === key ? 'page' : null }, label)));

  function view(sub) {
    start();
    if (A.refused) return [el('h1', { class: 'ac-h1', text: 'Announce' }), ctx.gate('Publish the rules first', 'Announcements need the firebase.rules.json from this version of the page.')];
    if (sub === ':news') return viewNews();
    if (sub) return viewEditor(sub);
    const list = Object.values(all()).sort((x, y) => (y.startAt || 0) - (x.startAt || 0));
    return [
      el('h1', { class: 'ac-h1', text: 'Announce' }),
      subnav('list'),
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
        ...targeting(a),
        raw('span', { class: 'ac-range' }, t('version {v}', { v: a.version }) + (a.maxShows ? ` · ${t('{n} shows each', { n: a.maxShows })}` : ''))),
      raw('span', { class: 'ac-entry-meta' }, when),
      funnel(a) || raw('span', { class: 'ac-entry-meta' }, t('Shown {s} · clicked {c} · dismissed {d}', { s: c.shown, c: c.clicked, d: c.dismissed })),
      raw('span', { class: 'ac-entry-meta' }, t('counts signed-in users only')),
      el('div', { class: 'ac-entry-actions' },
        el('a', { class: 'ac-btn small', href: `#ann/${a.id}`, text: 'Edit' }),
        el('button', { class: 'ac-btn small', text: 'Preview', onclick: () => preview(a) }),
        el('button', { class: 'ac-btn small', text: t('In the app…'), onclick: () => inApp(a) }),
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

  /**
   * Preview in the app: the real timer in a frame of a phone's, a tablet's or
   * a computer's size, showing this one at once (js/announcer.js, ?annPreview),
   * in English or Spanish. The frame says where it put it: a card whose button
   * is not on that screen sits in the corner, which is worth knowing first.
   */
  function inApp(a) {
    const P = { device: 'phone', lang: 'en' };
    const frameBox = el('div', { class: 'ac-frame-box' });
    const said = el('p', { class: 'ac-sub ac-frame-said', text: t('Loading the timer…') });
    let frame = null;
    const onMsg = (e) => {
      if (e.origin !== location.origin || !e.data?.annPreview || e.source !== frame?.contentWindow) return;
      const m = e.data.annPreview;
      const panel = m.panel ? t(PANEL[m.panel] || m.panel) : '';
      said.textContent = m.error ? t('The frame found no draft to show.')
        : m.shown === 'card' && m.panel ? (m.anchored ? t('A card pointing at the {panel} button.', { panel })
          : t('No {panel} button on this screen: the card sits in the corner instead.', { panel }))
          : t('Shown as a {style}.', { style: t(STYLE[m.shown] || m.shown).toLowerCase() });
      said.classList.toggle('ac-warn', !!(m.shown === 'card' && m.panel && !m.anchored));
    };
    addEventListener('message', onMsg);
    const load = () => {
      try { localStorage.setItem(PREVIEW_KEY, JSON.stringify(a)); } catch { /* a private window: nothing to show */ }
      const [w, h] = DEVICES[P.device];
      const room = Math.min(frameBox.clientWidth || 340, 560);
      const scale = Math.min(1, room / w);
      said.textContent = t('Loading the timer…');
      said.classList.remove('ac-warn');
      frame = el('iframe', { class: 'ac-frame', title: t('The timer, previewing'), src: `/index.html?annPreview=1&lang=${P.lang}${EMULATED ? '&emu=1' : ''}`,
        style: `width:${w}px;height:${h}px;transform:scale(${scale})` });
      frameBox.style.height = `${Math.round(h * scale)}px`;
      frameBox.replaceChildren(frame);
      chips();
    };
    const chipRow = el('div', { class: 'ac-chips' });
    const chips = () => chipRow.replaceChildren(
      ...Object.keys(DEVICES).map(d => el('button', { class: `ac-chip${P.device === d ? ' on' : ''}`, type: 'button', onclick: () => { P.device = d; load(); } },
        raw('span', {}, { phone: t('Phone'), tablet: t('Tablet'), desktop: t('Computer') }[d]))),
      ...['en', 'es'].map(l => el('button', { class: `ac-chip${P.lang === l ? ' on' : ''}`, type: 'button', onclick: () => { P.lang = l; load(); } },
        raw('span', {}, l === 'es' ? 'Español' : 'English'))));
    ctx.openSheet(
      el('h2', { class: 'ac-h2', text: t('In the app') }),
      chipRow, said, frameBox,
      el('div', { class: 'ac-sheet-actions' }, el('button', { class: 'ac-btn', text: 'Close', onclick: () => { removeEventListener('message', onMsg); ctx.closeSheet(); } })));
    requestAnimationFrame(load);
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
      const shown = localized({ ...d, button: d.button?.label ? d.button : null, title: d.title || t('(a title)') }, previewLang);
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

    // Targeting on top of the audience, and the Spanish words (ADMIN.md §21).
    const verInput = (key) => {
      const i = el('input', { class: 'ac-inp', inputmode: 'numeric', autocomplete: 'off', placeholder: t('any') });
      i.value = d[key] ? String(d[key]) : '';
      i.addEventListener('input', () => { d[key] = i.value.trim() === '' ? 0 : (/^\d+$/.test(i.value.trim()) ? Number(i.value.trim()) : -1); repaint(); });
      return i;
    };
    const signedOnly = el('input', { type: 'checkbox' });
    signedOnly.checked = !!d.signedInOnly;
    signedOnly.addEventListener('change', () => { d.signedInOnly = signedOnly.checked; repaint(); });
    d.es = d.es || {};
    const esText = (key, max, { area = false } = {}) => {
      const i = el(area ? 'textarea' : 'input', { class: 'ac-inp', maxlength: max, rows: area ? 3 : null, autocomplete: 'off', lang: 'es' });
      i.value = d.es[key] || '';
      i.addEventListener('input', () => { d.es[key] = i.value; repaint(); });
      return i;
    };
    let previewLang = 'en';
    const langChips = el('div', { class: 'ac-chips' });
    const paintLang = () => langChips.replaceChildren(...['en', 'es'].map(l => el('button', { class: `ac-chip${previewLang === l ? ' on' : ''}`, type: 'button',
      onclick: () => { previewLang = l; paintLang(); repaint(); } }, raw('span', {}, l === 'es' ? 'Español' : 'English'))));
    paintLang();

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
      el('div', { class: 'ac-row' },
        el('b', { text: t('Only some of them') }),
        el('p', { class: 'ac-help', text: t('On top of Who sees it. Empty is anybody.') }),
        field(t('From version'), verInput('minVer'), t('This version: {v}', { v: APP_VERSION })),
        field(t('Up to version'), verInput('maxVer')),
        field(t('On'), select(d.platform || '', [['', t('Phones and computers')], ['phone', t('Phones only')], ['desktop', t('Computers only')]], (v) => { d.platform = v; })),
        field(t('Language'), select(d.lang || '', [['', t('Any language')], ['en', t('English only')], ['es', t('Spanish only')]], (v) => { d.lang = v; })),
        el('label', { class: 'ac-check' }, signedOnly, el('span', { text: t('Signed in only') }))),
      el('div', { class: 'ac-row' },
        el('b', { text: t('In Spanish (optional)') }),
        el('p', { class: 'ac-help', text: t('For people using the timer in Spanish. Anything left empty shows in English.') }),
        field(t('Title'), esText('title', LIMITS.title)),
        field(t('Text'), esText('text', LIMITS.text, { area: true })),
        field(t('Button'), esText('label', LIMITS.label))),
      el('h2', { class: 'ac-h2 ac-gap', text: 'Preview' }),
      el('p', { class: 'ac-sub', text: 'Drawn by the same code and stylesheet as the timer, in its default theme.' }),
      langChips,
      previewBox, errors,
      el('button', { class: 'ac-btn small', type: 'button', text: t('In the app…'), onclick: () => { setButton(); const n = normalise(d); if (n) inApp(n); } }),
      el('div', { class: 'ac-sheet-actions' },
        el('a', { class: 'ac-btn', href: '#ann', text: 'Cancel', onclick: () => { A.draft = null; } }),
        save));
    repaint();
    return [el('a', { class: 'ac-back', href: '#ann', text: '‹ Announce' }),
      el('h1', { class: 'ac-h1', text: isNew ? 'New announcement' : 'Edit announcement' }), form];
  }

  /* ---------------- What's new (changelog/) ---------------- */

  /**
   * The timer's About shows these, newest first, with a dot on its button
   * while one is new to that device (js/news.js). A history, not a popup:
   * written once, edited if need be, rarely deleted.
   */
  function viewNews() {
    const head = [el('h1', { class: 'ac-h1', text: 'Announce' }), subnav('news')];
    if (A.newsRefused) return [...head, ctx.gate('Publish the rules first', 'What’s new needs the firebase.rules.json from this version of the page.')];
    const list = Object.entries(A.news || {}).sort((x, y) => (y[1]?.at || 0) - (x[1]?.at || 0));
    const d = A.newsDraft || (A.newsDraft = { id: null, title: '', text: '', ver: APP_VERSION, at: 0, es: { title: '', text: '' } });
    const field = (label, input, help) => el('label', { class: 'ac-field' },
      el('span', { class: 'ac-label', text: label }), input, help ? el('span', { class: 'ac-help', text: help }) : null);
    const input = (get, set, max, { area = false, numeric = false, lang = null } = {}) => {
      const i = el(area ? 'textarea' : 'input', { class: 'ac-inp', maxlength: max, rows: area ? 4 : null, autocomplete: 'off', inputmode: numeric ? 'numeric' : null, lang });
      i.value = get();
      i.addEventListener('input', () => { set(i.value); save.disabled = !d.title.trim() || !(d.ver >= 0); });
      return i;
    };
    const save = el('button', { class: 'ac-btn primary', text: d.id ? t('Save') : t('Add'), disabled: !d.title.trim() });
    save.addEventListener('click', async () => {
      save.disabled = true;
      const id = d.id || sdk().push(ref('changelog')).key;
      const rec = { at: d.at || Date.now(), title: d.title.trim().slice(0, 80), by: S.user.uid };
      if (d.text.trim()) rec.text = d.text.trim().slice(0, 600);
      if (d.ver > 0) rec.ver = d.ver;
      const es = {};
      if (d.es.title.trim()) es.title = d.es.title.trim().slice(0, 80);
      if (d.es.text.trim()) es.text = d.es.text.trim().slice(0, 600);
      if (Object.keys(es).length) rec.es = es;
      try {
        await sdk().set(ref(`changelog/${id}`), rec);
        A.newsDraft = null;
        toast(t('In What’s new. Timers show it next time they load.'), { kind: 'good' });
        ctx.scheduleRender();
      } catch (err) {
        console.warn('[admin] changelog refused', err?.code || err);
        toast(t('The database refused that'), { kind: 'bad', hold: true });
        save.disabled = false;
      }
    });
    const form = el('div', { class: 'ac-row' },
      el('b', { text: d.id ? t('Edit the entry') : t('A new entry') }),
      field(t('Title'), input(() => d.title, (v) => { d.title = v; }, 80)),
      field(t('Text'), input(() => d.text, (v) => { d.text = v; }, 600, { area: true }), t('Plain words; it keeps its line breaks.')),
      field(t('Version'), input(() => String(d.ver || ''), (v) => { d.ver = /^\d*$/.test(v.trim()) ? Number(v.trim() || 0) : -1; }, 6, { numeric: true }), t('The app version it came in. This one is {v}.', { v: APP_VERSION })),
      field(t('Spanish title (optional)'), input(() => d.es.title, (v) => { d.es.title = v; }, 80, { lang: 'es' })),
      field(t('Spanish text (optional)'), input(() => d.es.text, (v) => { d.es.text = v; }, 600, { area: true, lang: 'es' })),
      el('div', { class: 'ac-sheet-actions' },
        d.id ? el('button', { class: 'ac-btn', text: t('Cancel'), onclick: () => { A.newsDraft = null; ctx.scheduleRender(); } }) : null,
        save));
    const rows = !A.newsLoaded ? el('p', { class: 'ac-note', text: 'Loading…' })
      : !list.length ? el('p', { class: 'ac-note', text: 'Nothing yet. The first entry gives every timer’s About button a dot.' })
        : el('ol', { class: 'ac-log' }, ...list.map(([id, n]) => el('li', { class: 'ac-entry' },
          el('div', { class: 'ac-entry-main' },
            raw('b', {}, n.title || ''),
            n.text ? raw('span', { class: 'ac-reason' }, n.text) : null,
            raw('span', { class: 'ac-entry-meta' }, [new Date(n.at || 0).toLocaleDateString(), n.ver ? t('version {v}', { v: n.ver }) : null,
              n.es?.title ? t('in Spanish too') : null, n.by ? ctx.who(n.by) : null].filter(Boolean).join(' · '))),
          el('div', { class: 'ac-entry-actions' },
            el('button', { class: 'ac-btn small', text: t('Edit'), onclick: () => {
              A.newsDraft = { id, title: n.title || '', text: n.text || '', ver: n.ver || 0, at: n.at || Date.now(), es: { title: n.es?.title || '', text: n.es?.text || '' } };
              ctx.scheduleRender(); scrollTo(0, 0);
            } }),
            el('button', { class: 'ac-btn small danger', text: t('Delete'), onclick: () => askDeleteNews(id, n) })))));
    return [...head,
      el('p', { class: 'ac-sub', text: 'A short history of what changed, shown at the top of the timer’s About, newest first. Its button gets a dot until each device has seen the newest.' }),
      form, el('h2', { class: 'ac-h2 ac-gap', text: t('In What’s new') }), rows];
  }

  function askDeleteNews(id, n) {
    ctx.openSheet(
      el('h2', { class: 'ac-h2', text: t('Delete “{title}”?', { title: n.title || '' }) }),
      el('p', { class: 'ac-sub', text: t('It leaves What’s new on every timer the next time it loads.') }),
      el('div', { class: 'ac-sheet-actions' },
        el('button', { class: 'ac-btn', text: 'Back', onclick: ctx.closeSheet }),
        el('button', { class: 'ac-btn primary danger', text: t('Delete'), onclick: async () => {
          try { await sdk().remove(ref(`changelog/${id}`)); ctx.closeSheet(); toast(t('Deleted')); }
          catch (err) { console.warn('[admin] changelog delete refused', err?.code || err); toast(t('The database refused that'), { kind: 'bad', hold: true }); }
        } })));
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
    if (d.minVer < 0 || d.maxVer < 0) out.push(t('A version is a whole number'));
    if (d.minVer > 0 && d.maxVer > 0 && d.minVer > d.maxVer) out.push(t('From version up to a later one'));
    return out;
  }

  return { view, start, stop };
}
