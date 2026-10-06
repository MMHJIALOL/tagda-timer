import { el } from './util.js';
import { t } from './i18n.js';

const normalize = value => String(value || '').normalize('NFD')
  .replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// Attach related words to specific options, so a broad synonym does not
// accidentally make every option in its section match.
const ALIASES = [
  ['WCA inspection', 'countdown preparation warmup pre solve 15 seconds penalty'],
  ['Callouts', 'sound audio voice beep warning alert inspection countdown sonido voz pitido aviso'],
  ['Where times come from', 'input manual entry typing keyboard spacebar hardware stackmat microphone aux virtual cube'],
  ['Hold time', 'start delay press release spacebar sensitivity wait activation'],
  ['Decimals', 'precision digits decimal places milliseconds rounding accuracy digitos milisegundos'],
  ['Hide time while solving', 'hide clock invisible running display distraction'],
  ['While running', 'hide time clock invisible running display seconds distraction'],
  ['Show start hint', 'instructions help spacebar start text'],
  ['Scrambles only', 'hide timer practice scramble generator'],
  ['Show BPA / WPA', 'best worst possible average prediction ao5'],
  ['Focus mode', 'zen distraction minimal fade concentration'],
  ['Pace ghost', 'progress speed target personal best race comparison'],
  ['Pace reference', 'target benchmark personal best average ao5'],
  ['Start with the mouse', 'click pointer input mouse touch'],
  ['Confirm misfires', 'accidental short solves confirmation mistakes'],
  ['Misfire threshold', 'accidental short solves minimum time sensitivity mistakes'],
  ['Sound on PB', 'audio beep chime alert celebration record personal best sonido pitido aviso'],
  ['Metronome', 'rhythm beat audio sound tempo bpm practice sonido ritmo'],
  ['Metronome speed', 'rhythm beat tempo bpm frequency'],
  ['Metronome window', 'floating rhythm beat widget practice'],
  ['Multiphase splits', 'stages laps split key phases cross f2l oll pll breakdown'],
  ['New cases per sitting', 'learn training spaced repetition new algorithms session limit'],
  ['Counts as slow', 'learn training difficulty threshold spaced repetition'],
  ['Attempt length', 'fmc fewest moves duration time limit minutes'],
  ['Cubes per attempt', 'multi blind mbld mbf number count puzzles'],
  ['Buffers, orientation, letters', 'bld blindfold blindsolving speffz scheme memo execution edges corners'],
  ['Letter pairs', 'bld blindfold memory memo dictionary words images commutators algorithms'],
  ['Data Health', 'storage saved save sync cloud offline pending retry backup export health datos almacenamiento sincronizacion'],
  ['Backup', 'download export save restore data json archive copia seguridad exportar guardar'],
  ['Import solves', 'upload restore backup migrate transfer cstimer cubedesk data copia seguridad importar restaurar'],
  ['Session as CSV', 'download export spreadsheet excel data'],
  ['Interface language', 'translation locale english spanish espanol idioma'],
  ['Account', 'cloud sync login sign in sign out google profile devices email'],
  ['Restore defaults', 'reset factory original settings start over'],
  ['Theme, background and layout', 'appearance theme dark light mode colors colours wallpaper background font typography size layout animation motion panels'],
  ['Theme', 'appearance dark light mode colors colours palette presets'],
  ['Background', 'wallpaper backdrop'],
  ['Source', 'wallpaper background image photo video animated solid gradient shader'],
  ['Auto contrast', 'readability automatic light dark text'],
  ['Dim', 'brightness darkness opacity wallpaper background'],
  ['Blur', 'soften background wallpaper'],
  ['Saturation', 'color colour intensity vivid background'],
  ['Font', 'typeface typography text style digits'],
  ['Fonts', 'typeface typography text style digits'],
  ['Timer digits', 'clock font typeface typography'],
  ['Interface', 'ui font typeface typography menus'],
  ['Glass', 'blur frosted liquid transparency panels'],
  ['Weight', 'bold thin font thickness'],
  ['Size', 'scale bigger smaller zoom clock digits'],
  ['Glow', 'shine neon clock digits'],
  ['Scramble', 'scramble text font size scale'],
  ['Scramble preview', 'cube diagram visualization display size scale'],
  ['Sidebar width', 'panel rail size layout'],
  ['Stats text', 'statistics font size scale averages'],
  ['Solve list', 'history times font size scale'],
  ['Preview position', 'cube move location reset angle rotation'],
  ['Panel style', 'cards widgets flat layout transparency'],
  ['Statistics panel', 'stats averages show hide widget'],
  ['Times strip', 'history solve list show hide panel'],
  ['Hint facelets', 'ghost hidden stickers cube faces'],
  ['Yellow on top', 'cube orientation white cross trainer'],
  ['Density', 'spacing compact comfortable spacious layout'],
  ['Motion', 'animation reduce disable movement accessibility'],
  ['Reduce effects', 'performance graphics animation slow accessibility'],
  ['Panel layout', 'reset widgets location position dock rails'],
  ['Theme file', 'appearance import export share save colors colours'],
  ['Edge buffer', 'blind bld shoot sticker speffz'],
  ['Corner buffer', 'blind bld shoot sticker speffz'],
  ['Orientation', 'cube rotation hold faces'],
  ['Letter scheme', 'alphabet speffz stickers letters blind bld'],
  ['Memo / execution split', 'memorization execution phases blind bld'],
  ['Pair dictionary', 'letter pairs words images commutators algorithms memory'],
  ['Webcam replay', 'camera film record video recordings playback'],
  ['Record sound', 'audio microphone mic volume sonido'],
  ['Microphone', 'audio sound input mic sonido'],
  ['Keyboard shortcuts', 'hotkeys keys keybindings commands help'],
  ['Command palette', 'search actions commands shortcuts ctrl k'],
];

function aliasesFor(label) {
  const key = normalize(label);
  return ALIASES.filter(([name]) => key === normalize(name) || key === normalize(t(name)))
    .map(([, words]) => words).join(' ');
}

// Damerau-Levenshtein catches substitutions, missing letters and swaps
// (e.g. "inspeciton"). Short queries stay strict to avoid noisy results.
function distance(a, b) {
  const rows = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) rows[i][0] = i;
  for (let j = 0; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
      }
    }
  }
  return rows[a.length][b.length];
}

const FILLER = new Set(['a', 'an', 'the', 'to', 'of', 'for', 'my', 'please', 'change', 'setting', 'settings']);

export function matchesSetting(query, { label = '', section = '', text = '' }) {
  const terms = normalize(query).split(' ').filter(word => word && !FILLER.has(word));
  const hay = normalize([label, section, text, aliasesFor(label), aliasesFor(section)].join(' '));
  const words = hay.split(' ');
  return terms.every(term => words.some(word => {
    if (word === term || (term.length >= 3 && word.startsWith(term))) return true;
    // Plurals, without making a one-letter query fuzzy.
    if (term.length > 3 && term.endsWith('s') && word === term.slice(0, -1)) return true;
    const limit = term.length >= 7 ? 2 : term.length >= 4 ? 1 : 0;
    return limit > 0 && Math.abs(word.length - term.length) <= limit && distance(term, word) <= limit;
  }));
}

export function mountSettingsSearch(body, { query = '', onQuery = () => {} } = {}) {
  const content = el('div', { class: 'settings-content' });
  content.append(...body.childNodes);
  const input = el('input', {
    class: 'inp settings-search-input', type: 'search', value: query,
    placeholder: 'Search settings…', 'aria-label': 'Search settings',
    autocomplete: 'off', spellcheck: 'false', 'aria-controls': 'settings-search-content',
  });
  content.id = 'settings-search-content';
  const icon = el('button', {
    class: 'settings-search-icon', type: 'button', title: 'Search settings',
    'aria-label': 'Focus settings search', onclick: () => input.focus(),
    html: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>',
  });
  const clear = el('button', {
    class: 'settings-search-clear', type: 'button', text: 'Clear', 'aria-label': 'Clear settings search',
    onclick: () => { input.value = ''; apply(); input.focus(); },
  });
  const status = el('div', { class: 'settings-search-status', role: 'status', 'aria-live': 'polite' });
  const toolbar = el('div', { class: 'settings-search' },
    el('div', { class: 'settings-search-field' }, icon, input, clear), status);
  const empty = el('div', { class: 'settings-search-empty', hidden: true },
    el('strong', { text: 'No settings found' }),
    el('span', { text: 'Try a related word, like “sound”, “precision” or “backup”.' }));
  body.append(toolbar, empty, content);

  function filterGroup(group, parentTitle = '') {
    const heading = group.querySelector(':scope > h3');
    const title = [parentTitle, heading?.textContent].filter(Boolean).join(' ');
    let count = 0;
    for (const child of group.children) {
      if (child === heading) continue;
      // Feature controls own `hidden` (e.g. a microphone row only when sound
      // is enabled). Search uses a separate class and never overrides it.
      if (child.hidden) continue;
      if (child.classList.contains('group') || (!child.classList.contains('row') && child.querySelector('.row, .group'))) {
        count += filterGroup(child, title);
      } else if (child.classList.contains('hint-note')) {
        child.classList.toggle('settings-search-hidden', !!input.value.trim());
      } else {
        const label = child.dataset.searchLabel || child.querySelector(':scope > .lbl > span')?.textContent || heading?.textContent;
        const matches = matchesSetting(input.value, { label, section: title, text: child.textContent });
        child.classList.toggle('settings-search-hidden', !matches);
        if (matches) count++;
      }
    }
    group.classList.toggle('settings-search-hidden', count === 0);
    return count;
  }

  function apply() {
    const active = !!input.value.trim();
    let count = 0;
    for (const child of content.children) {
      if (child.classList.contains('group')) count += filterGroup(child);
      else if (child.classList.contains('hint-note')) child.classList.toggle('settings-search-hidden', active);
    }
    clear.hidden = !active;
    empty.hidden = !active || count > 0;
    status.textContent = active
      ? (count === 1 ? t('1 matching option') : t('{n} matching options', { n: count }))
      : t('Search by name or related words');
    onQuery(input.value);
  }

  input.addEventListener('input', () => { apply(); body.scrollTop = 0; });
  input.addEventListener('keydown', event => {
    if (event.key === 'Escape' && input.value) {
      event.preventDefault(); event.stopPropagation();
      input.value = ''; apply();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      [...content.querySelectorAll('.row :is(button, input, select, a)')]
        .find(control => !control.disabled && !control.closest('[hidden], .settings-search-hidden') && control.type !== 'hidden')?.focus();
    }
  });

  // Account labels and background controls can arrive/change after mounting.
  // Observe content and feature-owned visibility, not our filter classes.
  const observer = new MutationObserver(() => {
    if (body.contains(content)) apply();
    else observer.disconnect();
  });
  observer.observe(content, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden'] });
  // The drawer body is reused. Disconnect when this panel is replaced.
  const lifetime = new MutationObserver(() => {
    if (!body.contains(content)) { observer.disconnect(); lifetime.disconnect(); }
  });
  lifetime.observe(body, { childList: true });
  apply();
}
