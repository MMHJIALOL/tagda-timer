// Color schemes are keyed by puzzle family; NxN shares one six-face scheme.
export const CUBE_COLORS = { U: '#ffffff', L: '#ff9900', F: '#00ff00', R: '#ff0000', B: '#2266ff', D: '#ffff00' };
export const COLOR_PUZZLES = {
  nxn: { label: 'NxN cubes', colors: CUBE_COLORS },
  fto: { label: 'FTO', colors: { U:'#ffffff', F:'#44ee00', R:'#ff0000', D:'#f4f400', BB:'#2266ff', L:'#8800dd', BL:'#ff8000', BR:'#888888' } },
  megaminx: { label: 'Megaminx', colors: { U:'#ffffff', F:'#008800', R:'#ff0000', C:'#e8d0a0', A:'#3399ff', L:'#8800dd', E:'#ff66cc', BF:'#99ff00', BR:'#0000ff', BL:'#f4f400', I:'#ff8000', D:'#888888' } },
  pyraminx: { label: 'Pyraminx', colors: { F:'#44ee00', D:'#f4f400', L:'#ff0000', R:'#2266ff' } },
  skewb: { label: 'Skewb', colors: { ...CUBE_COLORS, F:'#44ee00', D:'#f4f400', L:'#ff8000' } },
  square1: { label: 'Square-1', colors: { ...CUBE_COLORS, F:'#32cd32', L:'#ffa500', E:'#d8d8d8' } },
};
const DEFAULT_NET_COLORS = { U:'#ffffff', D:'#ffe100', F:'#00b04a', B:'#0051ba', R:'#ec0000', L:'#ff8b00' };
export const netColors = { ...DEFAULT_NET_COLORS };
export const colorFamily = id => /^([2-9]|\d{2})x\1x\1$/.test(id) ? 'nxn' : id;
export const validColor = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
let schemes = {};
let signature = '';
const listeners = new Set();
export function onPuzzleColorsChanged(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function customColors(id) {
  const family = colorFamily(id);
  return schemes[family] ? { ...COLOR_PUZZLES[family].colors, ...schemes[family] } : null;
}
export function updatePuzzleColors(settings) {
  const next = {};
  for (const [id, def] of Object.entries(COLOR_PUZZLES)) {
    const source = settings.puzzleColors?.[id] ?? (id === 'nxn' ? settings.cubeColors : null);
    for (const face of Object.keys(def.colors)) if (validColor(source?.[face])) (next[id] ||= {})[face] = source[face];
  }
  const key = JSON.stringify(next);
  if (key === signature) return;
  schemes = next; signature = key;
  Object.assign(netColors, next.nxn ? { ...CUBE_COLORS, ...next.nxn } : DEFAULT_NET_COLORS);
  for (const fn of listeners) fn();
}

// Adapter for the pinned cubing.js bundle. Keep geometry and sticker identities
// intact: recolor the solved source before cubing.js applies any moves.
let installed;
export function installPuzzleColors() {
  return installed ||= import('../vendor/cubing/chunks/chunk-BI4EPFJB.js').then(({ f: puzzles }) => {
    for (const [id, loader] of Object.entries(puzzles)) {
      if (!COLOR_PUZZLES[colorFamily(id)]) continue;
      const originalPG = loader.pg?.bind(loader);
      if (originalPG) loader.pg = async () => {
        const pg = await originalPG();
        return new Proxy(pg, { get(target, key) {
          if (key === 'get3d') return options => {
            const data = target.get3d(options), colors = customColors(id);
            if (colors) for (const sticker of data.stickers) {
              const face = data.faces[sticker.face].name;
              if (colors[face]) sticker.color = colors[face];
            }
            return data;
          };
          const value = target[key];
          return typeof value === 'function' ? value.bind(target) : value;
        } });
      };
      for (const method of ['svg', 'llSVG']) {
        if (!loader[method]) continue;
        const original = loader[method].bind(loader);
        loader[method] = async (...args) => {
          const svg = await original(...args), colors = customColors(id);
          if (!colors) return svg;
          const defaults = originalPG ? (await originalPG()).colors : COLOR_PUZZLES[colorFamily(id)].colors;
          const byColor = Object.fromEntries(Object.entries(defaults).map(([face, value]) => [value.toLowerCase(), face]));
          Object.assign(byColor, { white:'U', yellow:'D', red: id === 'pyraminx' ? 'L' : 'R', orange:'L', limegreen:'F', '#26f':id === 'pyraminx' ? 'R' : 'B', '#d8d8d8':'E', ...(id === 'fto' ? { '#aaaaaa':'BR' } : {}) });
          return svg.replace(/(fill:\s*)(#[0-9a-f]+|[a-z]+)/gi, (all, prefix, value) => {
            const color = colors[byColor[value.toLowerCase()]];
            return color ? prefix + color : all;
          });
        };
      }
    }
  });
}

/** Solved net, using the same face colors as the scramble renderer. */
export async function puzzleColorPreview(family) {
  await installPuzzleColors();
  const { f: puzzles } = await import('../vendor/cubing/chunks/chunk-BI4EPFJB.js');
  return puzzles[family === 'nxn' ? '3x3x3' : family].svg();
}
