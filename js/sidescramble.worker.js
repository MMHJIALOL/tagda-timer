/* Square-1 scrambles off the page -- see js/scramble.js. A warm-up message
   only builds the tables, so the first real request is quick. */
import { sq1Scramble } from './sidescramble.js';

self.onmessage = ({ data }) => {
  const scramble = sq1Scramble();
  if (!data.warm) self.postMessage({ id: data.id, scramble });
};
