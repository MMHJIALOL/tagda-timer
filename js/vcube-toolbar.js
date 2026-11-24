import { el } from './util.js';
import { t } from './i18n.js';
import { virtualView } from './vcube-settings.js';

// Compact view controls live in the virtual cube's Settings panel.
export function buildVirtualCubeViewBar({ settings, setSetting, onChange = () => {} }) {
  const panel = el('div', { class: 'vcube-angle-bar', role: 'group', 'aria-label': 'Virtual cube view controls' });
  const axes = {
    angle: { label: 'Angle', aria: 'Cube viewing angle', key: 'longitude', min: -180, max: 180, unit: '°' },
    height: { label: 'Height', aria: 'Cube viewing height', key: 'latitude', min: -85, max: 85, unit: '°' },
    tilt: { label: 'Tilt', aria: 'Cube screen tilt', key: 'tilt', min: -180, max: 180, unit: '°' },
    size: { label: 'Size', aria: 'Cube display size', key: 'size', min: 50, max: 150, unit: '%' },
  };
  let active = 'angle';
  const output = el('output', { class: 'vcube-bar-value', for: 'vcube-angle-slider' });
  const input = el('input', { id: 'vcube-angle-slider', type: 'range', step: 1 });
  const tabs = el('div', { class: 'vcube-view-tabs', role: 'group', 'aria-label': 'View adjustment' });
  const read = () => {
    const v = virtualView(settings());
    return { ...v, size: Math.round(600 / v.distance) };
  };
  const sync = () => {
    const axis = axes[active];
    input.min = axis.min; input.max = axis.max;
    input.setAttribute('aria-label', t(axis.aria));
    const value = Math.round(read()[axis.key]);
    input.value = value;
    input.setAttribute('aria-valuetext', `${value}${axis.unit}`);
    output.textContent = `${value}${axis.unit}`;
    for (const button of tabs.children) button.setAttribute('aria-pressed', String(button.dataset.axis === active));
  };
  const change = value => {
    const key = axes[active].key;
    if (key === 'longitude' || key === 'latitude') {
      const v = read();
      setSetting('virtualCamera', { latitude: v.latitude, longitude: v.longitude, [key]: value });
    } else setSetting(key === 'tilt' ? 'virtualTilt' : 'virtualSize', value);
    sync();
    onChange();
  };
  for (const [id, axis] of Object.entries(axes)) tabs.append(el('button', {
    type: 'button', class: 'vcube-view-tab', text: axis.label, dataset: { axis: id },
    onclick: () => { active = id; sync(); },
  }));
  input.addEventListener('input', () => change(+input.value));
  const reset = el('button', { type: 'button', class: 'vcube-bar-reset', text: 'Reset', onclick: () => {
    const defaults = { angle: 30, height: 35, tilt: 0, size: 100 };
    change(defaults[active]);
  } });
  panel.append(tabs, el('div', { class: 'vcube-bar-range' }, input, output, reset));
  sync();
  return { element: panel, sync };
}
