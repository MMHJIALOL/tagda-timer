import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

const base=process.argv[2]||'http://127.0.0.1:5422', expectStock=process.argv.includes('--stock');
const {outputFiles}=await build({entryPoints:['tools/fixtures/smart-cube/gan-carry4-ble.mjs'],bundle:true,write:false,format:'iife',platform:'browser',
  plugins:[{name:'translations',setup(b){b.onLoad({filter:/[/\\]js[/\\]i18n\.js$/},()=>({contents:'export const t=x=>x;',loader:'js'}));}}]});
const browser=await chromium.launch({headless:true});
try{
  const context=await browser.newContext({serviceWorkers:'block'});
  await context.addInitScript({content:outputFiles[0].text});
  await context.route('**/announcements.json*',r=>r.fulfill({body:'null'}));
  await context.route('**/config.json*',r=>r.fulfill({body:'null'}));
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);await page.waitForFunction(()=>window.tagdatimer?.scramble?.scramble,null,{timeout:60000});
  await page.evaluate(()=>{
    document.querySelectorAll('.an-dlg[open]').forEach(d=>d.dispatchEvent(new Event('cancel',{cancelable:true})));
    window.__carry4Initial='UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB';
    window.__carry4HistoryReplies=true;document.querySelector('#btn-settings').click();
  });
  await page.waitForFunction(()=>!document.querySelector('.smart-device-connect')?.disabled);
  await page.locator('#drawer-body .smart-device-row').getByRole('button',{name:'Connect cube',exact:true}).click();
  const states=[];
  for(const move of ['R',"R'"]){
    await page.evaluate(m=>window.__carry4Turn(m),move);await page.waitForTimeout(100);
    states.push(await page.evaluate(()=>({state:tagdatimer.smartCubeController().connectionState,
      disconnects:window.__carry4Disconnects,historyRequests:window.__carry4Writes,
      patch:tagdatimer.smartCubeController().connection?.protocolPatch||null})));
  }
  console.log(JSON.stringify({base,expectStock,afterTurns:states,errors}));
  if(expectStock){
    assert.equal(states[0].disconnects,0);
    assert.ok(states[0].historyRequests>0);
    assert.ok(states[1].disconnects>0,'stock bundle must reproduce the second-turn disconnect');
    console.log('PASS: reproduced the stock main-site bundle disconnect on turn two after its spurious history request');
  }else{
    assert.ok(states.every(s=>s.disconnects===0&&s.historyRequests===0&&s.patch==='carry4-state-sync-2'));
    assert.equal(states.at(-1).state,'connected');assert.deepEqual(errors,[]);
    console.log('PASS: the shipped i Carry 4 bundle stays connected on both turns without requesting pre-connection history');
  }
}finally{await browser.close();}
