// Presets contain preferences, never navigation, account identity or other presets.
const EXCLUDED = new Set([
  'settingsPresets', 'settingsVersion', 'inspectionUpdatedAt',
  'event', 'mode', 'sessionId', 'returnSessionId', 'virtualReturnSession',
  'raceReturnSession', 'raceLastRoom', 'raceName', 'spotifyClientId', 'featuredReel',
  'albumThemes',
]);

export function presetSettings(settings, defaults) {
  return Object.fromEntries(Object.entries(defaults)
    .filter(([key]) => !EXCLUDED.has(key))
    .map(([key, fallback]) => [key, structuredClone(settings[key] ?? fallback)]));
}

export function savePreset(settings, defaults, name, id) {
  name = String(name || '').trim();
  if (!name || name.length > 60) throw new Error('Use a preset name between 1 and 60 characters.');
  const presets = settings.settingsPresets || {};
  if (Object.entries(presets).some(([key, value]) => key !== id && value?.name?.toLowerCase() === name.toLowerCase())) {
    throw new Error('A preset with that name already exists.');
  }
  return { ...presets, [id]: { name, settings: presetSettings(settings, defaults) } };
}

export function restorePreset(settings, defaults, id) {
  const preset = settings.settingsPresets?.[id];
  if (!preset?.settings) throw new Error('That preset is no longer available.');
  // Firebase omits nulls and empty collections. Fill those from the defaults.
  return { ...settings, ...presetSettings(preset.settings, defaults) };
}
