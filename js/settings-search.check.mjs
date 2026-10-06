import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { matchesSetting, mountSettingsSearch } from './settings-search.js';

test('related words, prefixes, plurals and typos find specific options', () => {
  for (const [query, label] of [
    ['precision', 'Decimals'], ['precison', 'Decimals'], ['decimal places', 'Decimals'],
    ['inspeciton', 'WCA inspection'], ['countdown', 'WCA inspection'],
    ['sounds', 'Sound on PB'], ['rhythm', 'Metronome'], ['start delay', 'Hold time'],
    ['factory reset', 'Restore defaults'], ['spreadsheet', 'Session as CSV'],
    ['wallpaper', 'Theme, background and layout'], ['FONT', 'Font'],
    ['saturat', 'Saturation'], ['espáñol', 'Interface language'],
  ]) assert.ok(matchesSetting(query, { label }), `${query} should find ${label}`);
});

test('all meaningful query words must match, with section context', () => {
  assert.ok(matchesSetting('change my timer precision', { label: 'Decimals', section: 'Timer' }));
  assert.ok(matchesSetting('cloud login', { label: 'Name', section: 'Account' }));
  assert.equal(matchesSetting('precision backup', { label: 'Decimals', section: 'Timer' }), false);
  assert.equal(matchesSetting('zzzxxyy', { label: 'Hold time', section: 'Timer' }), false);
  assert.equal(matchesSetting('pb', { label: 'Backup', section: 'Data' }), false);
  assert.ok(matchesSetting('  ', { label: 'Decimals' }));
});

test('filter keeps real controls and listeners, clears, and handles changing content', async () => {
  const dom = new JSDOM('<div id="body"></div>');
  globalThis.document = dom.window.document;
  globalThis.MutationObserver = dom.window.MutationObserver;
  const body = document.getElementById('body');
  body.innerHTML = `<div class="group"><h3>Timer</h3>
    <div class="row"><div class="lbl"><span>Decimals</span></div><button>0.000</button></div>
    <div class="row"><div class="lbl"><span>Hold time</span></div><button>Instant</button></div>
    <div class="hint-note">Help text</div></div>
    <div class="group"><h3>Background</h3><div class="group" id="dynamic">
    <div class="row"><div class="lbl"><span>Blur</span></div><input type="range"></div>
    </div></div>`;
  const originalButton = body.querySelector('button');
  let clicks = 0;
  originalButton.addEventListener('click', () => clicks++);
  let lastQuery;
  mountSettingsSearch(body, { query: 'precison', onQuery: value => { lastQuery = value; } });
  const input = body.querySelector('input[type="search"]');
  const search = value => { input.value = value; input.dispatchEvent(new dom.window.Event('input')); };
  const visibleRows = () => [...body.querySelectorAll('.row')].filter(row => !row.closest('[hidden], .settings-search-hidden'));
  assert.equal(visibleRows().length, 1);
  assert.equal(body.querySelector('.settings-search-status').textContent, '1 matching option');
  assert.equal(visibleRows()[0].querySelector('button'), originalButton);
  originalButton.click();
  assert.equal(clicks, 1);
  input.focus();
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(document.activeElement, originalButton);
  search('zzzxxyy');
  assert.equal(body.querySelector('.settings-search-empty').hidden, false);
  assert.equal(visibleRows().length, 0);
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(input.value, '');
  assert.equal(visibleRows().length, 3);
  assert.equal(body.querySelector('.hint-note').classList.contains('settings-search-hidden'), false);
  // Wrappers used by new settings must filter each row independently.
  const extra = document.createElement('div');
  extra.innerHTML = '<div class="row"><div class="lbl"><span>Misfire threshold</span></div><input type="range"></div><div class="row" hidden><div class="lbl"><span>Microphone</span></div><select></select></div>';
  body.querySelector('.settings-content > .group').append(extra);
  search('threshold');
  assert.equal(visibleRows().length, 1);
  search('');
  assert.equal(extra.lastChild.hidden, true, 'clearing cannot reveal a feature-hidden row');
  search('microphone');
  assert.equal(visibleRows().length, 0);
  extra.lastChild.hidden = false;
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(visibleRows().length, 1, 'feature visibility changes reapply the query');
  search('brightness');
  body.querySelector('#dynamic').innerHTML = '<div class="row"><div class="lbl"><span>Dim</span></div><input type="range"></div>';
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(visibleRows().length, 1);
  assert.equal(visibleRows()[0].querySelector('span').textContent, 'Dim');
  body.querySelector('.settings-search-clear').click();
  assert.equal(lastQuery, '');
  assert.equal(document.activeElement, input);
  body.replaceChildren();
  await new Promise(resolve => setTimeout(resolve, 0));
  dom.window.close();
  delete globalThis.document;
  delete globalThis.MutationObserver;
});
