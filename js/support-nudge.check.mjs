import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { CONFIG } from './config-table.js';

// Exercise the actual app wiring with persisted storage across simulated visits.
const main = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
const source = main.slice(main.indexOf("const COFFEE_KEY ="), main.indexOf('/**\n * Fills over', main.indexOf("const COFFEE_KEY =")));
const DAY = 86_400_000;
async function visit(store, { now = 100 * DAY, solves = 2, config = {}, blocked = false } = {}) {
  const dom = new JSDOM('<body></body>', { pretendToBeVisual: true });
  const { document, EventTarget, Event, CustomEvent } = dom.window;
  const timer = new EventTarget();
  const pending = [];
  const settings = { ...Object.fromEntries(Object.entries(CONFIG.support.keys).map(([key, spec]) => [key, spec.def])), ...config };
  const context = vm.createContext({
    document, timer, EventTarget, Event, Date: { now: () => now },
    KV: { get: async (key, fallback) => store.get(key) ?? fallback, set: async (key, value) => store.set(key, value) },
    Solves: { count: async () => solves },
    getConfig: (_, key) => settings[key],
    timerIdle: () => true, modalOpen: () => blocked, announcementShowing: () => false,
    setTimeout: fn => pending.push(fn), t: text => text, app: {}, openPanel: () => {},
    el: (tag, attrs, ...children) => {
      const node = document.createElement(tag);
      for (const [key, value] of Object.entries(attrs)) {
        if (key === 'text') node.textContent = value;
        else if (key === 'html') node.innerHTML = value;
        else if (key === 'onclick') node.onclick = value;
        else node.setAttribute(key, value);
      }
      node.append(...children);
      return node;
    },
  });
  vm.runInContext(`${source}\nwireSupportNudge();`, context);
  await new Promise(resolve => setImmediate(resolve));
  return {
    stop() { vm.runInContext("supportSolves.dispatchEvent(new Event('solve'))", context); pending.splice(0).forEach(fn => fn()); },
    start() { timer.dispatchEvent(new CustomEvent('state', { detail: { state: 'running' } })); },
    get card() { return document.querySelector('.coffee-nudge'); },
    close() { dom.window.close(); },
  };
}

test('new user is asked after the second saved solve; exactly the 10th subsequent visit repeats', async () => {
  const store = new Map();
  let page = await visit(store, { solves: 0 });
  assert.equal(page.card, null);
  page.stop(); assert.equal(page.card, null);
  page.stop(); assert.ok(page.card);
  page.card.querySelector('.cam-hint-x').click();
  page.stop(); assert.equal(page.card, null); page.close();
  for (let i = 1; i <= 10; i++) {
    page = await visit(store, { now: 131 * DAY });
    page.stop();
    assert.equal(!!page.card, i === 10, `returning visit ${i}`);
    page.close();
  }
  assert.equal(store.get('coffeeVisitsSinceAsk'), 0);
});

test('quiet period and blocked UI preserve a due reminder', async () => {
  const store = new Map([['coffeeAsked', true], ['coffeeNudgeAt', 90 * DAY], ['coffeeVisitsSinceAsk', 9]]);
  let page = await visit(store);
  page.stop(); assert.equal(page.card, null); page.close();
  assert.equal(store.get('coffeeVisitsSinceAsk'), 10);
  page = await visit(store, { now: 121 * DAY, blocked: true });
  page.stop(); assert.equal(page.card, null); page.close();
  page = await visit(store, { now: 121 * DAY, config: { shows: 2 } });
  page.stop(); assert.ok(page.card);
  page.start(); assert.equal(page.card, null);
  page.stop(); assert.ok(page.card);
  page.start(); page.stop(); assert.equal(page.card, null);
  page.close();
});

test('one saved solve survives a reload; ignoring the card starts the quiet period', async () => {
  const store = new Map();
  let page = await visit(store, { solves: 1 });
  assert.equal(page.card, null);
  page.stop(); assert.ok(page.card);
  assert.equal(store.get('coffeeNudgeAt'), 100 * DAY);
  page.start(); page.stop(); assert.equal(page.card, null);
  page.close();
  store.set('coffeeVisitsSinceAsk', 9);
  page = await visit(store, { now: 113 * DAY });
  page.stop(); assert.equal(page.card, null); page.close();
  page = await visit(store, { now: 114 * DAY });
  page.stop(); assert.ok(page.card); page.close();
});

test('existing users migrate, configured frequency works, disabled reminders stay hidden', async () => {
  for (const [config, expected] of [[{ oddsPct: 50 }, true], [{ oddsPct: 0 }, false], [{ enabled: false }, false], [{ shows: 0 }, false]]) {
    const store = new Map([['coffeeAsked', true]]);
    let page = await visit(store, { config });
    page.stop(); assert.equal(page.card, null); page.close();
    page = await visit(store, { config });
    page.stop(); assert.equal(!!page.card, expected); page.close();
  }
});
