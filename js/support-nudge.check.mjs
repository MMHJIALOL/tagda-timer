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
async function visit(store, { now = 100 * DAY, solves = 2, config = {}, blocked = false, returningVisitor = true } = {}) {
  const dom = new JSDOM('<body></body>', { pretendToBeVisual: true });
  const { document, EventTarget, Event, CustomEvent } = dom.window;
  const timer = new EventTarget();
  const pending = [];
  const settings = { ...Object.fromEntries(Object.entries(CONFIG.support.keys).map(([key, spec]) => [key, spec.def])), ...config };
  const context = vm.createContext({
    document, timer, EventTarget, Event, Date: class extends Date { static now() { return now; } },
    returningVisitor,
    KV: { get: async (key, fallback) => store.get(key) ?? fallback, set: async (key, value) => store.set(key, value) },
    Solves: { count: async () => solves },
    getConfig: (_, key) => settings[key],
    timerIdle: () => true, modalOpen: () => blocked, announcementShowing: () => false,
    setTimeout: (fn, delay) => pending.push({ fn, at: now + delay }), t: text => text, app: {}, openPanel: () => {},
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
  vm.runInContext(`${source}\nwireSupportNudge(returningVisitor);`, context);
  await new Promise(resolve => setImmediate(resolve));
  const advance = ms => {
    const target = now + ms;
    for (;;) {
      pending.sort((a, b) => a.at - b.at);
      if (!pending.length || pending[0].at > target) break;
      const next = pending.shift(); now = next.at; next.fn();
    }
    now = target;
  };
  return {
    stop() { vm.runInContext("supportSolves.dispatchEvent(new Event('solve'))", context); advance(2000); },
    advance,
    unblock() { blocked = false; },
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
  assert.equal(store.get('coffeeNudgeAt'), 100 * DAY + 2000);
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

const campaignStart = Date.parse('2026-11-17T00:00:00+05:30');
const campaignEnd = Date.parse('2026-11-19T00:00:00+05:30');
const campaignKey = 'coffeeCampaign20261117Seen';

test('campaign lasts exactly 48 hours and bypasses solves, frequency and recent dismissal once', async () => {
  assert.equal(campaignEnd - campaignStart, 48 * 60 * 60 * 1000);
  const store = new Map([['coffeeAsked', true], ['coffeeNudgeAt', campaignStart - 1000], ['coffeeVisitsSinceAsk', 0]]);
  let page = await visit(store, { now: campaignStart, solves: 0 });
  assert.equal(page.card, null);
  page.advance(2000); assert.ok(page.card);
  assert.equal(store.get(campaignKey), true);
  assert.equal(store.get('coffeeNudgeAt'), campaignStart - 1000);
  assert.equal(store.get('coffeeVisitsSinceAsk'), 1);
  page.card.querySelector('.cam-hint-x').click();
  page.advance(4000); assert.equal(page.card, null); page.close();
  page = await visit(store, { now: campaignStart + DAY, solves: 0 });
  page.advance(4000); page.stop(); assert.equal(page.card, null); page.close();
});

test('campaign excludes first-time visitors even after two solves', async () => {
  const store = new Map();
  const page = await visit(store, { now: campaignStart, solves: 0, returningVisitor: false });
  page.advance(2000); assert.equal(page.card, null);
  page.stop(); page.stop(); assert.equal(page.card, null);
  assert.equal(store.has(campaignKey), false); page.close();
});

test('campaign retries when blocked without prematurely consuming its one appearance', async () => {
  const store = new Map();
  const page = await visit(store, { now: campaignStart, solves: 0, blocked: true });
  page.advance(4000); assert.equal(page.card, null);
  assert.equal(store.has(campaignKey), false);
  page.unblock(); page.advance(2000); assert.ok(page.card);
  page.start(); assert.equal(page.card, null);
  page.stop(); assert.equal(page.card, null); page.close();
});

test('campaign expires in an open tab and ordinary solve-triggered reminders resume', async () => {
  const store = new Map();
  const page = await visit(store, { now: campaignEnd - 3000, solves: 2 });
  page.advance(2000); assert.ok(page.card);
  page.advance(1000); assert.equal(page.card, null);
  assert.equal(store.has('coffeeAsked'), false);
  page.stop(); assert.ok(page.card);
  assert.equal(store.get('coffeeAsked'), true); page.close();
});

test('before the campaign and at its end the original rules apply', async () => {
  for (const now of [campaignStart - 10000, campaignEnd]) {
    const store = new Map();
    const page = await visit(store, { now, solves: 0, returningVisitor: false });
    page.advance(2000); assert.equal(page.card, null);
    page.stop(); assert.equal(page.card, null);
    page.stop(); assert.ok(page.card);
    assert.equal(store.has(campaignKey), false); page.close();
  }
});
