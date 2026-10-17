/* Random-state subset scrambles off the page -- see js/subsets.js. */
import { subsetScramble } from './subsets.js';

self.onmessage = async ({ data }) => {
  try {
    self.postMessage({ id: data.id, scramble: await subsetScramble(data.kind) });
  } catch (err) {
    self.postMessage({ id: data.id, error: err.message });
  }
};
