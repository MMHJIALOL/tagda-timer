import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { presetSettings, savePreset, restorePreset } from './settings-presets.js';
import { buildSettingsPresets } from './settings-presets-ui.js';

const defaults = { inspection: true, precision: 2, theme: 'nebula', tiles: null,
  keybinds: {}, event: '333', sessionId: null, spotifyClientId: '', settingsPresets: {} };

test('snapshots are independent and exclude session, account and preset metadata', () => {
  const source = { ...defaults, tiles: { timer: { w: 300 } }, sessionId: 'mine',
    spotifyClientId: 'private', inspectionUpdatedAt: 123, settingsPresets: { previous: {} } };
  const snapshot = presetSettings(source, defaults);
  source.tiles.timer.w = 900;
  assert.equal(snapshot.tiles.timer.w, 300);
  for (const key of ['sessionId', 'spotifyClientId', 'event', 'settingsPresets', 'inspectionUpdatedAt']) {
    assert.equal(key in snapshot, false);
  }
});

test('save, update and restore preserve current context and Firebase-omitted defaults', () => {
  const source = { ...defaults, inspection: false, precision: 3, theme: 'carbon' };
  source.settingsPresets = savePreset(source, defaults, ' Practice ', 'one');
  source.precision = 1;
  source.sessionId = 'current';
  source.spotifyClientId = 'current-app';
  const restored = restorePreset(source, defaults, 'one');
  assert.equal(restored.precision, 3);
  assert.equal(restored.inspection, false);
  assert.equal(restored.sessionId, 'current');
  assert.equal(restored.spotifyClientId, 'current-app');
  assert.equal(restored.settingsPresets, source.settingsPresets);
  source.settingsPresets = savePreset(source, defaults, 'Practice', 'one');
  assert.equal(restorePreset(source, defaults, 'one').precision, 1);
  delete source.settingsPresets.one.settings.tiles;
  delete source.settingsPresets.one.settings.keybinds;
  assert.equal(restorePreset(source, defaults, 'one').tiles, null);
  assert.deepEqual(restorePreset(source, defaults, 'one').keybinds, {});
});

test('empty, long, duplicate and missing presets fail clearly', () => {
  const source = { ...defaults };
  for (const name of ['', '   ', 'x'.repeat(61)]) assert.throws(() => savePreset(source, defaults, name, 'one'));
  source.settingsPresets = savePreset(source, defaults, 'Practice', 'one');
  assert.throws(() => savePreset(source, defaults, ' practice ', 'two'), /already exists/);
  assert.throws(() => restorePreset(source, defaults, 'missing'), /no longer available/);
});

test('controls save, update, apply and delete; failed saves remain visible and roll back', async () => {
  const dom = new JSDOM('<body></body>');
  globalThis.document = dom.window.document;
  const app = { settings: structuredClone(defaults), persist: async () => {},
    applySettingsPreset: async id => { app.applied = id; } };
  const section = buildSettingsPresets(app, defaults);
  document.body.append(section);
  const submit = async name => {
    section.querySelector('input').value = name;
    section.querySelector('form').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
  };
  const click = async text => {
    [...section.querySelectorAll('button')].find(b => b.textContent === text).click();
    await new Promise(resolve => setTimeout(resolve, 0));
  };
  await submit('<b>Practice</b>');
  const id = Object.keys(app.settings.settingsPresets)[0];
  assert.ok(id);
  assert.equal(section.querySelector('b'), null);
  app.settings.precision = 3;
  await click('Update');
  assert.equal(app.settings.settingsPresets[id].settings.precision, 3);
  await click('Apply');
  assert.equal(app.applied, id);
  await click('Delete');
  assert.deepEqual(app.settings.settingsPresets, {});
  app.persist = async () => { throw new Error('Storage unavailable'); };
  await submit('Failed');
  assert.deepEqual(app.settings.settingsPresets, {});
  assert.equal(section.querySelector('[role=status]').textContent, 'Storage unavailable');
  assert.equal(section.querySelector('button').disabled, false);
  dom.window.close();
});
