const assert = require('node:assert/strict');
const { chromium } = require('@playwright/test');
const base = process.argv[2] || 'http://127.0.0.1:5388';

(async () => {
  const browser = await chromium.launch({ headless:true });
  try {
    const context = await browser.newContext({ serviceWorkers:'block', viewport:{width:1440,height:1000} });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'bluetooth', { configurable:true, value:{} });
      window.__cubeListeners = new Set();
      window.__cubeCancel = false;
      window.__cubeConnects = 0;
      window.__cubeStatusListeners = new Set();
      const add = document.addEventListener.bind(document), remove = document.removeEventListener.bind(document);
      document.addEventListener = (type, listener, options) => {
        if (type === 'smart-cube-status-change') window.__cubeStatusListeners.add(listener);
        return add(type, listener, options);
      };
      document.removeEventListener = (type, listener, options) => {
        if (type === 'smart-cube-status-change') window.__cubeStatusListeners.delete(listener);
        return remove(type, listener, options);
      };
    });
    await context.route(/\/vendor\/gan\/gan-3\.0\.2\.js$/, route => route.fulfill({
      contentType:'application/javascript', body:`
        export { cubeTimestampLinearFit } from '/vendor/gan/gan-3.0.2.js?production';
        export function connectGanCube() {
          window.__cubeConnects++;
          window.__cubeActivation = navigator.userActivation.isActive;
          window.__cubeInputAtChooser = tagdatimer.settings.inputMode;
          if (window.__cubeCancel) return Promise.reject(new DOMException('No device selected', 'NotFoundError'));
          const emit = event => { for (const listener of window.__cubeListeners) listener(event); };
          return Promise.resolve({ deviceName:'GANi4',
            events$:{subscribe(listener){ window.__cubeListeners.add(listener); return {unsubscribe(){window.__cubeListeners.delete(listener);}}; }},
            async sendCubeCommand({type}) {
              if(type==='REQUEST_FACELETS') {
                const initial = () => emit({type:'FACELETS',serial:0,facelets:'UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB'});
                if(window.__cubeDelay) setTimeout(initial,80); else initial();
              }
              if(type==='REQUEST_BATTERY') emit({type:'BATTERY',batteryLevel:84});
            }, async disconnect() {}
          });
        }
      `,
    }));
    await context.route('**/announcements.json*', route => route.fulfill({body:'null'}));
    await context.route('**/config.json*', route => route.fulfill({body:'null'}));
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    await page.waitForFunction(() => window.tagdatimer?.scramble?.scramble, null, {timeout:60000});
    await page.evaluate(() => {
      document.querySelectorAll('.an-dlg[open]').forEach(dialog => dialog.dispatchEvent(new Event('cancel',{cancelable:true})));
      tagdatimer.setSetting('bgMode','solid');
    });
    const row = page.locator('#drawer-body .smart-device-row');
    const connect = row.getByRole('button',{name:'Connect cube',exact:true});

    await page.locator('#btn-settings').click();
    await connect.waitFor();
    await page.waitForFunction(() => !document.querySelector('.smart-device-connect')?.disabled);
    assert.equal(await page.getByRole('button',{name:'Smart cube (GAN)',exact:true}).count(),0);
    assert.equal(await page.evaluate(() => tagdatimer.settings.inputMode || 'timer'),'timer');
    await page.getByRole('searchbox',{name:'Search settings'}).fill('pair GAN');
    assert.equal(await row.isVisible(),true);
    await page.getByRole('button',{name:'Clear settings search'}).click();
    await page.evaluate(() => { window.__cubeCancel=true; });
    await connect.click();
    await row.getByText('Pairing cancelled. You can try again.',{exact:true}).waitFor();
    assert.equal(await page.evaluate(() => tagdatimer.settings.inputMode || 'timer'),'timer');
    assert.equal(await page.evaluate(() => window.__cubeActivation),true);
    await page.evaluate(() => { window.__cubeCancel=false; window.__cubeDelay=true; });
    await connect.click();
    await row.getByText('Connected',{exact:true}).waitFor();
    await row.getByText('84% battery · Smart cube input',{exact:true}).waitFor();
    assert.equal(await page.evaluate(() => window.__cubeInputAtChooser || 'timer'),'timer');
    assert.equal(await page.evaluate(() => tagdatimer.settings.inputMode),'smart');
    assert.equal(await page.getByRole('button',{name:'Keyboard',exact:true}).evaluate(button => button.classList.contains('on')),false);
    assert.equal(await row.locator('.smart-device-name').textContent(),'GAN i4');
    await page.evaluate(() => { window.__cubeDelay=false; });
    await page.screenshot({path:'docs/smart-cube-connection-settings.png'});
    console.log('PASS: distinct searchable Bluetooth row, live chooser activation, cancellation keeps keyboard, pairing switches input and shows model/battery');

    await page.locator('#drawer-close').click();
    await page.locator('#btn-gear').click();
    await row.getByText('Connected',{exact:true}).waitFor();
    assert.equal(await page.locator('#drawer-title').textContent(),'Your cubes');
    await row.getByRole('button',{name:'Disconnect',exact:true}).click();
    await connect.waitFor();
    assert.equal(await page.evaluate(() => tagdatimer.settings.inputMode),'timer');
    await connect.click();
    await row.getByText('Connected',{exact:true}).waitFor();
    await page.locator('#drawer-close').click();
    await page.locator('#btn-settings').click();
    await row.getByText('Connected',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Keyboard',exact:true}).click();
    await row.getByRole('button',{name:'Use cube',exact:true}).click();
    assert.equal(await page.evaluate(() => tagdatimer.settings.inputMode),'smart');
    await row.getByRole('button',{name:'Configure',exact:true}).click();
    await page.getByRole('slider',{name:'Cube size',exact:true}).waitFor();
    console.log('PASS: Your cubes shares the connection, disconnect restores keyboard, Use cube resumes connected input, device settings still open');
    assert.equal(await page.evaluate(() => window.__cubeStatusListeners.size),0);
    await page.evaluate(async () => {
      const panels = await import('/js/panels.js');
      for (let i=0;i<8;i++) {
        panels.openDrawer('Your cubes', panels.buildGear(tagdatimer));
        panels.closeDrawer();
        panels.openDrawer('Settings', panels.buildSettings(tagdatimer));
        panels.closeDrawer();
      }
      await Promise.resolve();
    });
    assert.equal(await page.evaluate(() => window.__cubeStatusListeners.size),0);
    assert.equal(await page.locator('#drawer-body .smart-device-row').count(),0);
    console.log('PASS: repeated panel changes dispose connection subscriptions and cancel stale gear rendering');

    for (const width of [390,320]) {
      const phone = await context.newPage();
      phone.on('pageerror', error => errors.push(error.message));
      await phone.setViewportSize({width,height:844});
      await phone.goto(base);
      await phone.waitForFunction(() => window.tagdatimer?.scramble?.scramble,null,{timeout:60000});
      await phone.evaluate(async () => {
        document.querySelectorAll('.an-dlg[open]').forEach(dialog => dialog.dispatchEvent(new Event('cancel',{cancelable:true})));
        const panels = await import('/js/panels.js');
        panels.openDrawer('Settings', panels.buildSettings(tagdatimer));
      });
      const phoneRow = phone.locator('#drawer-body .smart-device-row');
      await phone.waitForFunction(() => !document.querySelector('.smart-device-connect')?.disabled);
      await phoneRow.getByRole('button',{name:'Connect cube',exact:true}).click();
      await phoneRow.getByText('Connected',{exact:true}).waitFor();
      await phoneRow.scrollIntoViewIfNeeded();
      const fits = await phoneRow.evaluate(element => {
        const r=element.getBoundingClientRect();
        return r.left>=0 && r.right<=innerWidth && element.scrollWidth<=element.clientWidth;
      });
      assert.equal(fits,true,`connection row fits at ${width}px`);
      if (width === 390) await phone.screenshot({path:'docs/smart-cube-connection-settings-phone.png'});
      await phone.close();
    }
    assert.deepEqual(errors,[]);
    console.log('PASS: connected row fits 390px and 320px phones; no browser errors');

    const unsupported = await browser.newContext({serviceWorkers:'block'});
    await unsupported.addInitScript(() => Object.defineProperty(navigator,'bluetooth',{configurable:true,value:undefined}));
    const noBluetooth = await unsupported.newPage();
    await noBluetooth.goto(base);
    await noBluetooth.waitForFunction(() => window.tagdatimer?.scramble?.scramble,null,{timeout:60000});
    await noBluetooth.evaluate(async () => {
      document.querySelectorAll('.an-dlg[open]').forEach(dialog => dialog.dispatchEvent(new Event('cancel',{cancelable:true})));
      const panels=await import('/js/panels.js'); panels.openDrawer('Settings',panels.buildSettings(tagdatimer));
    });
    const unavailable=noBluetooth.locator('.smart-device-row');
    await unavailable.getByText('Bluetooth unavailable',{exact:true}).waitFor();
    assert.equal(await unavailable.getByRole('button',{name:'Connect cube',exact:true}).isDisabled(),true);
    console.log('PASS: unsupported browser explains Bluetooth availability and disables pairing');
    await unsupported.close();
    await context.close();
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });
