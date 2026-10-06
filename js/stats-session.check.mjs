import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import * as stats from './stats.js';
import * as charts from './charts.js';
import * as util from './util.js';
import { t } from './i18n.js';
import { filterByCube } from './gear.js';

// Exercise the drawer with real statistics, DOM controls and SVG charts,
// without loading unrelated camera, audio and account integrations.
const source = readFileSync(new URL('./panels.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const buildSource = source.slice(source.indexOf('export function buildStats(app)'),
  source.indexOf('\n\n\n/*', source.indexOf('export function buildStats(app)'))).replace('export ', '');
const tick = () => new Promise(resolve => setImmediate(resolve));
const solve = (id, sessionId, createdAt, timeMs, extra = {}) =>
  ({ id, sessionId, createdAt, timeMs, penalty: 'none', scramble: 'R U', ...extra });

function mount() {
  const dom = new JSDOM('<div id="body"></div>');
  globalThis.document = dom.window.document;
  const body = document.getElementById('body');
  const sessions = [{ id: 'a', name: 'Current' }, { id: 'b', name: 'Practice' }, { id: 'empty', name: 'Empty' }];
  const current = [solve('a1', 'a', 20, 10000), solve('a2', 'a', 40, 12000, { penalty: '+2', cubeId: 'cube' })];
  const other = [solve('b1', 'b', 10, 8000, { cubeId: 'cube' }), solve('b2', 'b', 30, 9000, { penalty: 'DNF' })];
  const all = [...current, ...other];
  const rendered = {};
  let copied;
  const app = {
    session: sessions[0], sessions, solves: current, settings: {},
    allSolves: async () => all,
    copyToast: text => { copied = text; },
  };
  const db = { bySession: async id => all.filter(s => s.sessionId === id) };
  const bindings = {
    ...util, ...stats, ...charts, t, filterByCube, Solves: db,
    group: (title, ...kids) => util.el('div', { class: 'group' }, util.el('h3', { text: title }), ...kids),
    Gear: { all: async () => [{ id: 'cube', name: 'Cube' }] },
    GearLog: { byGear: async () => [] }, gearLabel: g => g.name, markersFor: () => [], LOG_KINDS: {},
    renderTrend: (host, list, ...args) => {
      rendered.trend = list;
      return charts.renderTrend(host, list, ...args);
    },
    renderHistogram: (host, list) => {
      rendered.histogram = list;
      return charts.renderHistogram(host, list);
    },
  };
  const buildStats = new Function(...Object.keys(bindings), `${buildSource}; return buildStats;`)(...Object.values(bindings));
  const dispose = buildStats(app)(body);
  const pick = label => body.querySelector(`select[aria-label="${label}"]`);
  const change = (label, value) => {
    const select = pick(label);
    select.value = value;
    select.dispatchEvent(new dom.window.Event('change'));
  };
  return { app, all, db, body, rendered, dispose, pick, change, copied: () => copied };
}

test('defaults to current session; all sessions update stats, charts and exports chronologically', async () => {
  const h = mount();
  await tick();
  assert.equal(h.pick('Statistics session').value, 'a');
  assert.deepEqual(h.rendered.trend.map(s => s.id), ['a1', 'a2']);
  h.change('Statistics session', '');
  await tick();
  assert.deepEqual(h.rendered.trend.map(s => s.id), ['b1', 'a1', 'b2', 'a2']);
  assert.deepEqual(h.rendered.histogram, h.rendered.trend);
  assert.equal(h.body.querySelector('.group h3').textContent, 'All sessions');
  const cells = [...h.body.querySelectorAll('.group .bs')];
  assert.equal(cells[0].querySelector('.bs-v').textContent, '4');
  assert.equal(cells[0].querySelector('.bs-sub').textContent, '1 DNF · 1 +2');
  [...h.body.querySelectorAll('button')].find(b => b.textContent === 'Copy selected stats').click();
  assert.match(h.copied(), /solves\/total: 3\/4/);
  assert.equal(h.app.session.id, 'a');
  assert.deepEqual(h.app.solves.map(s => s.id), ['a1', 'a2']);

  h.change('Cube', 'cube');
  await tick();
  assert.deepEqual(h.rendered.trend.map(s => s.id), ['b1', 'a2']);
  h.change('Statistics session', 'b');
  await tick();
  assert.equal(h.pick('Cube').value, 'cube');
  assert.deepEqual(h.rendered.trend.map(s => s.id), ['b1']);
  assert.deepEqual(h.rendered.histogram.map(s => s.id), ['b1', 'b2']);
  h.change('Statistics session', 'empty');
  await tick();
  assert.equal(h.rendered.trend.length, 0);
  assert.equal(h.rendered.histogram.length, 0);
  assert.equal(h.body.querySelector('.group .bs-v').textContent, '0');
  h.dispose();
});

test('mixed all-session results keep move counts separate from milliseconds', async () => {
  const h = mount();
  h.all.push(solve('fmc', 'b', 50, 600000, { fmcMoves: 28 }));
  h.change('Statistics session', '');
  await tick();
  assert.equal(h.pick('Result type').parentElement.hidden, false);
  assert.equal(h.rendered.histogram.length, 4);
  h.change('Result type', 'moves');
  await tick();
  assert.deepEqual(h.rendered.histogram.map(s => s.id), ['fmc']);
  assert.equal(h.body.querySelectorAll('.group .bs-v')[1].textContent, '28');
  h.dispose();
});

test('latest selection wins, loading errors retain data, and closed drawers ignore late loads', async () => {
  const h = mount();
  await tick();
  let resolveAll;
  h.app.allSolves = () => new Promise(resolve => { resolveAll = resolve; });
  h.change('Statistics session', '');
  const resolveOld = resolveAll;
  h.change('Statistics session', 'b');
  await tick();
  resolveOld(h.all);
  await tick();
  assert.equal(h.body.querySelector('.group h3').textContent, 'Practice');
  h.db.bySession = async () => { throw new Error('Test read failure'); };
  const warn = console.warn;
  console.warn = () => {};
  try {
    h.change('Statistics session', 'empty');
    await tick();
  } finally { console.warn = warn; }
  assert.equal(h.pick('Statistics session').value, 'b');
  assert.match(h.body.querySelector('[role="status"]').textContent, /Could not load/);
  h.change('Statistics session', '');
  const before = h.body.innerHTML;
  h.dispose();
  resolveAll(h.all);
  await tick();
  assert.equal(h.body.innerHTML, before);
});
