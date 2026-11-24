import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

const base=process.argv[2] || 'http://127.0.0.1:5410';
const {outputFiles}=await build({entryPoints:['tools/fixtures/smart-cube/gan-carry4-ble.mjs'],bundle:true,write:false,format:'iife',platform:'browser',minify:true,
plugins:[{name:'test-translations',setup(b){b.onLoad({filter:/[/\\]js[/\\]i18n\.js$/},()=>({contents:'export const t=x=>x;',loader:'js'}));}}]});

const browser=await chromium.launch({headless:true});
try{
  const context=await browser.newContext({serviceWorkers:'block',viewport:{width:390,height:844}});
  await context.addInitScript({content:outputFiles[0].text});
  await context.route('**/announcements.json*',r=>r.fulfill({body:'null'}));
  await context.route('**/config.json*',r=>r.fulfill({body:'null'}));
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);
  await page.waitForFunction(()=>window.tagdatimer?.scramble?.scramble,null,{timeout:60000});
  await page.evaluate(async()=>{
    document.querySelectorAll('.an-dlg[open]').forEach(d=>d.dispatchEvent(new Event('cancel',{cancelable:true})));
    const app=tagdatimer,core=await import('/js/smart-cube-core.js');
    app.setSetting('inspection',true);app.setSetting('confirmShortSolves',false);app.setSetting('soundOnPB',false);
    app.scramble.scramble='R U F';window.__carry4Initial=core.scrambleState('R U F');
  });
  // The phone menu dispatches this same existing Settings button action.
  await page.evaluate(()=>document.querySelector('#btn-settings').click());
  const row=page.locator('#drawer-body .smart-device-row');
  await page.waitForFunction(()=>!document.querySelector('.smart-device-connect')?.disabled);
  await row.getByRole('button',{name:'Connect cube',exact:true}).click();
  await row.getByText('Make one slow turn and undo it, then wait for the cube state',{exact:true}).waitFor();
  assert.equal(await row.locator('.smart-device-name').textContent(),'GAN i Carry 4');
  assert.notEqual(await page.evaluate(()=>tagdatimer.settings.inputMode),'smart');
  for(const move of ['R',"R'"]){
    await page.evaluate(m=>window.__carry4Turn(m),move);await page.waitForTimeout(100);
    assert.equal(await page.evaluate(()=>window.__carry4Disconnects),0,'Neither setup turn may disconnect the cube');
  }
  await row.getByText('Connected',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>tagdatimer.settings.inputMode),'smart');
  assert.equal(await page.evaluate(()=>tagdatimer.solves.filter(s=>s.smartCube).length),0,'setup turns cannot save a false solve');
  await row.getByRole('button',{name:'Configure',exact:true}).click();
  await page.getByText('i Carry 4 · Early support. Check that the preview matches your cube before solving.',{exact:true}).waitFor();
  // Calibration remains an explicit physical-solved confirmation.
  page.once('dialog',dialog=>dialog.dismiss());
  await page.getByRole('button',{name:'Calibrate solved cube',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.__carry4Commands.includes('REQUEST_RESET')),false);
  for(const move of ["F'","U'","R'"]){await page.waitForTimeout(100);await page.evaluate(m=>window.__carry4Turn(m),move);}
  await page.waitForFunction(()=>tagdatimer.solves.some(s=>s.smartCube));
  const captured=await page.evaluate(async()=>{
    const solve=tagdatimer.solves.find(s=>s.smartCube),db=await import('/js/db.js'),core=await import('/js/smart-cube-core.js');
    const capture=await db.SmartCaptures.get(solve.id);core.validateCapture(capture);
    return {solve,capture};
  });
  assert.equal(captured.capture.completeness,'complete');
  assert.deepEqual(captured.capture.moves.map(m=>m.move),["F'","U'","R'"]);
  assert.deepEqual(captured.capture.moves.map(m=>m.serial),[254,255,0]);
  assert.ok(captured.capture.moves.every(m=>!m.connectionSetup));
  assert.equal(captured.capture.connections[0].deviceModel,'GAN i Carry 4');
  assert.equal(captured.solve.timeMs,captured.capture.measuredDurationMs);
  assert.equal(await page.evaluate(()=>window.__carry4Writes),0);
  assert.equal(await page.evaluate(()=>window.__carry4Activation),true);
  assert.equal(await page.evaluate(()=>window.__carry4Disconnects),0);
  await page.evaluate(()=>tagdatimer.disconnectSmartCube());
  assert.equal(await page.evaluate(()=>tagdatimer.settings.inputMode),'timer');
  await page.reload();await page.waitForFunction(()=>tagdatimer?.solves.some(s=>s.smartCube),null,{timeout:60000});
  await page.evaluate(()=>tagdatimer.openSmartAnalysis(tagdatimer.solves.find(s=>s.smartCube)));
  await page.getByRole('dialog',{name:'Smart cube analysis'}).waitFor();
  await page.getByRole('button',{name:'Next turn',exact:true}).click();
  assert.match(await page.locator('.sa-readout > span').textContent(),/1\/3/);
  assert.deepEqual(errors,[]);
  console.log('PASS: shipped GAN bundle through encrypted BLE transport, both setup turns stay connected, Settings pairing, setup exclusion, inspection, exact capture, model, calibration, keyboard fallback, persistence and replay');
}finally{await browser.close();}
