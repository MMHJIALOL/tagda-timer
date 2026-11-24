import { el } from './util.js';
import { t } from './i18n.js';
import { buildVirtualCubeViewBar } from './vcube-toolbar.js';
import { VIRTUAL_DEFAULTS, VIRTUAL_MOVES, VIRTUAL_ORIENTATIONS,
  virtualKeymap, remapVirtualMove, keyName, canBindKey, virtualView } from './vcube-settings.js';

export function buildVirtualCubeControls(app, { group, row, select }, section = 'view') {
  const S = app.settings;
  const set = (key, value) => app.setSetting(key, value);
  const refreshView = () => {
    viewBar?.sync();
    preset.value = cameraPreset();
  };
  const cameraPreset = () => {
    const v = virtualView(S);
    return Object.keys(presets).find(k => v.latitude === presets[k].latitude && v.longitude === presets[k].longitude) || 'custom';
  };
  const presets = {
    urf: { latitude: 35, longitude: 30 }, uf: { latitude: 45, longitude: 0 },
    front: { latitude: 0, longitude: 0 }, top: { latitude: 85, longitude: 0 },
  };
  const preset = select([
    { value: 'urf', label: 'URF · three faces' }, { value: 'uf', label: 'UF · top and front' },
    { value: 'front', label: 'Front · straight on' }, { value: 'top', label: 'Top · overhead' },
    { value: 'custom', label: 'Custom angle' },
  ], cameraPreset(), value => {
    if (!presets[value]) return;
    set('virtualCamera', { ...presets[value] });
    refreshView();
  });
  preset.setAttribute('aria-label', t('Virtual cube view'));
  const viewBar = section === 'view' ? buildVirtualCubeViewBar({
    settings: () => app.settings, setSetting: set, onChange: () => { preset.value = cameraPreset(); },
  }) : null;
  const orientation = select(VIRTUAL_ORIENTATIONS, S.virtualOrientation ?? 'auto', value => set('virtualOrientation', value));
  orientation.setAttribute('aria-label', t('Starting orientation'));
  const capture = el('button', { class: 'ghost-btn', type: 'button', text: 'Use current view', onclick: async () => {
    capture.disabled = true;
    try { await app.captureVirtualView?.(); refreshView(); }
    finally { capture.disabled = false; }
  } });
  const resetView = el('button', { class: 'ghost-btn', type: 'button', text: 'Reset view', onclick: () => {
    set('virtualCamera', { ...VIRTUAL_DEFAULTS.virtualCamera });
    set('virtualSize', VIRTUAL_DEFAULTS.virtualSize);
    set('virtualTilt', VIRTUAL_DEFAULTS.virtualTilt);
    refreshView();
  } });

  const bindings = el('div', { class: 'vcube-bindings' });
  const status = el('p', { class: 'vcube-help vcube-binding-status', role: 'status', 'aria-live': 'polite' });
  const layout = select([
    { value: 'qwerty', label: 'csTimer · QWERTY' }, { value: 'dvorak', label: 'Dvorak' },
    { value: 'colemak', label: 'Colemak' }, { value: 'custom', label: 'Custom bindings' },
  ], S.virtualBindings ? 'custom' : S.virtualLayout || 'qwerty', value => {
    if (value === 'custom') return;
    set('virtualLayout', value);
    set('virtualBindings', null);
    status.textContent = '';
    drawBindings();
  });
  layout.setAttribute('aria-label', t('Virtual cube keyboard layout'));
  function drawBindings() {
    const map = virtualKeymap(S);
    bindings.replaceChildren(...VIRTUAL_MOVES.map(move => {
      const names = Object.keys(map).filter(code => map[code] === move).map(keyName);
      const label = () => names.join(' / ') || t('Unbound');
      let listening = false;
      const button = el('button', {
        class: 'vcube-key ghost-btn', type: 'button', text: label(),
        'aria-label': `Remap ${move}`, 'aria-pressed': 'false',
        onclick: () => { listening = true; button.textContent = t('Press a key…'); button.setAttribute('aria-pressed', 'true'); },
        onblur: () => { listening = false; button.textContent = label(); button.setAttribute('aria-pressed', 'false'); },
        onkeydown: event => {
          if (!listening || event.code === 'Tab') return;
          event.preventDefault(); event.stopImmediatePropagation();
          if (event.repeat) return;
          if (event.code === 'Escape') { button.blur(); return; }
          if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
          const clear = event.code === 'Backspace' || event.code === 'Delete';
          if (!clear && !canBindKey(event.code)) {
            status.textContent = t('Choose a letter, number, or punctuation key. Space, Esc and arrows keep their controls.');
            return;
          }
          const old = virtualKeymap(S), displaced = old[event.code];
          const hadKey = Object.values(old).includes(move);
          set('virtualBindings', remapVirtualMove(old, move, clear ? null : event.code));
          layout.value = 'custom';
          status.textContent = clear ? `${move}: ${t('unbound')}`
            : `${move}: ${keyName(event.code)}${displaced && displaced !== move ? ` · ${displaced}: ${hadKey ? t('swapped to previous key') : t('unbound')}` : ''}`;
          drawBindings();
          bindings.querySelector(`[aria-label="Remap ${move}"]`)?.focus();
        },
      });
      return el('div', { class: 'vcube-binding' }, el('span', { text: move }), button);
    }));
  }
  drawBindings();
  const resetKeys = el('button', { class: 'ghost-btn', type: 'button', text: 'Reset keys', onclick: () => {
    set('virtualLayout', 'qwerty'); set('virtualBindings', null);
    layout.value = 'qwerty'; status.textContent = ''; drawBindings();
  } });

  const panel = section === 'view'
    ? group(t('Adjust view'),
        el('p', { class: 'vcube-help', text: 'Choose a control below and use the slider. Changes apply live and save automatically.' }),
        viewBar.element,
        row(t('View preset'), preset),
        row(t('Camera controls'), el('div', { class: 'vcube-actions' }, capture, resetView), t('drag the cube or use arrow keys while solving to change the view')))
    : group(t('Cube settings'),
        row(t('Starting orientation'), orientation, t('top and front faces before scrambling; changing this resets an idle cube, or applies to the next scramble during a solve')),
        row(t('Virtual cube keyboard layout'), layout),
        el('p', { class: 'vcube-help', text: 'Click a key, then press its replacement. Occupied keys swap moves. Backspace removes a binding; Esc cancels. Labels show QWERTY physical positions. Space starts inspection; Esc resets the cube.' }),
        bindings, status,
        row(t('Keyboard controls'), resetKeys));
  panel.classList.add('vcube-settings');
  return panel;
}
