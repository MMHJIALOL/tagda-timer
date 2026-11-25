export const AVG_MIN = 3;
export const AVG_MAX = 1000;
export const HIST_AVG_DEFAULTS = [5, 12];
export const STATS_AVG_DEFAULTS = [5, 12, 50, 100, 1000];

export function averageSizes(value, defaults, limit = defaults.length) {
  const source = Array.isArray(value) ? value : defaults;
  return [...new Set(source.map(Number).filter(n =>
    Number.isInteger(n) && n >= AVG_MIN && n <= AVG_MAX))].slice(0, limit);
}

export const historyAverages = settings => averageSizes(settings?.histAvgCols, HIST_AVG_DEFAULTS, 3);
export const statisticsAverages = settings => {
  const saved = averageSizes(settings?.statsAvgCols, STATS_AVG_DEFAULTS);
  // Keep the four sidebar slots and the additional Statistics drawer slot.
  return [...saved, ...STATS_AVG_DEFAULTS.filter(n => !saved.includes(n))].slice(0, 5);
};

export const recordAverages = settings => [...new Set([
  5, 12, ...historyAverages(settings), ...statisticsAverages(settings),
])].sort((a, b) => a - b);
