const assert = require('node:assert/strict');
const { chromium } = require('@playwright/test');

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.addInitScript(() => {
      window.micRequests = [];
      window.micTracks = [];
      window.testMics = [
        { kind: 'audioinput', deviceId: 'built-in', label: 'Built-in microphone' },
        { kind: 'audioinput', deviceId: 'usb', label: 'USB timer input' },
      ];
      navigator.mediaDevices.enumerateDevices = async () => window.testMics;
      const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async constraints => {
        window.micRequests.push(constraints);
        const audio = { ...constraints.audio };
        delete audio.deviceId; // Chromium's fake device stands in for either physical input.
        const stream = await capture({ audio });
        window.micTracks.push(...stream.getTracks());
        return stream;
      };
    });
    const page = await context.newPage();
    await page.goto(process.argv[2] || 'http://127.0.0.1:5188');
    await page.waitForFunction(() => window.tagdatimer?.scramble?.scramble, null, { timeout: 60000 });
    await page.evaluate(async () => {
      const app = window.tagdatimer;
      app.setSetting('inputMode', 'stackmat');
      const { openDrawer, buildSettings } = await import('/js/panels.js');
      openDrawer('Settings', buildSettings(app));
    });
    const pick = page.getByRole('combobox', { name: 'Stackmat input', exact: true });
    await page.waitForFunction(() => window.micTracks.length === 1);
    await pick.selectOption('usb');
    await page.waitForFunction(() => window.micTracks.length === 2);
    assert.equal(await page.evaluate(() => micRequests.at(-1).audio.deviceId.exact), 'usb');
    assert.equal(await page.evaluate(() => micTracks[0].readyState), 'ended');
    assert.equal(await page.evaluate(() => tagdatimer.settings.stackmatMic), 'usb');
    await page.evaluate(() => {
      testMics.push({ kind: 'audioinput', deviceId: 'new', label: 'New microphone' });
      navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
    });
    await page.waitForFunction(() => document.querySelector('select[aria-label="Stackmat input"] option[value="new"]'));
    assert.equal(await pick.inputValue(), 'usb');
    await pick.selectOption('');
    await page.waitForFunction(() => window.micTracks.length === 3);
    assert.equal(await page.evaluate(() => 'deviceId' in micRequests.at(-1).audio), false);
    await page.evaluate(() => tagdatimer.setSetting('inputMode', 'timer'));
    assert.equal(await page.evaluate(() => micTracks.every(t => t.readyState === 'ended')), true);
    console.log('PASS: microphone selector, saved choice, exact input constraints, reconnect cleanup, device changes, default input, stop');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
