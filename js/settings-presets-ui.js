import { el, uid } from './util.js';
import { t } from './i18n.js';
import { savePreset } from './settings-presets.js';

export function buildSettingsPresets(app, defaults) {
  const section = el('div', { class: 'group settings-presets' }, el('h3', { text: 'Settings presets' }));
  const name = el('input', { class: 'inp', type: 'text', maxlength: 60,
    placeholder: 'Preset name', 'aria-label': 'Preset name', style: { flex: '1', minWidth: '0' } });
  const status = el('div', { class: 'sub', role: 'status', 'aria-live': 'polite' });
  const list = el('div');
  let busy = false;
  const run = async action => {
    if (busy) return;
    busy = true;
    section.querySelectorAll('button').forEach(b => { b.disabled = true; });
    try { await action(); }
    catch (error) { status.textContent = t(error.message); }
    finally {
      busy = false;
      section.querySelectorAll('button').forEach(b => { b.disabled = false; });
    }
  };
  const persist = async presets => {
    const previous = app.settings.settingsPresets;
    app.settings.settingsPresets = presets;
    try { await app.persist({ immediate: true, throwOnError: true }); }
    catch (error) { app.settings.settingsPresets = previous; throw error; }
    render();
  };
  const render = () => {
    list.replaceChildren();
    for (const [id, preset] of Object.entries(app.settings.settingsPresets || {})) {
      if (!preset?.settings) continue;
      const label = el('span', { style: { overflowWrap: 'anywhere' } });
      label.textContent = preset.name;
      const button = (text, action) => el('button', { class: 'ghost-btn sm', type: 'button', text,
        'aria-label': `${t(text)} ${preset.name}`, onclick: () => run(action) });
      list.append(el('div', { class: 'row', style: { flexWrap: 'wrap', gap: '8px' } },
        el('div', { class: 'lbl' }, label),
        el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } },
          button('Apply', () => app.applySettingsPreset(id)),
          button('Update', async () => {
            await persist(savePreset(app.settings, defaults, preset.name, id));
            status.textContent = t('Preset updated.');
          }),
          button('Delete', async () => {
            const presets = { ...app.settings.settingsPresets };
            delete presets[id];
            await persist(presets);
            status.textContent = t('Preset deleted.');
          }))));
    }
  };
  const save = el('button', { class: 'btn', type: 'submit', text: 'Save current settings' });
  section.append(el('div', { class: 'hint-note', text:
    'Save timer, appearance and layout preferences. Applying reloads the page and keeps your current session and solves. Uploaded backgrounds stay on this device.' }),
    el('form', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px' }, onsubmit: event => {
      event.preventDefault();
      run(async () => {
        await persist(savePreset(app.settings, defaults, name.value, uid()));
        name.value = '';
        status.textContent = t('Preset saved.');
      });
    } }, name, save), status, list);
  render();
  return section;
}
