import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';

const root=process.cwd(),oldFiles=new Map();
for(const name of ['sw.js','index.html','vendor/gan/gan-3.0.2.js','js/smart-cube.js','js/smart-cube-core.js','js/panels.js','js/version.js']){
  oldFiles.set(name,execFileSync('git',['show','dde5c1f:'+name],{encoding:'utf8',maxBuffer:2000000}));
}
let old=true;
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost'),name=url.pathname==='/'?'index.html':decodeURIComponent(url.pathname.slice(1));
  res.setHeader('Cache-Control','no-store');
  if(name==='cache-upgrade-qa'){res.setHeader('Content-Type','text/html');return res.end('<!doctype html><title>Cache upgrade QA</title>');}
  const file=path.resolve(root,name);
  if(!file.startsWith(root+path.sep)){res.statusCode=404;return res.end();}
  const types={'.js':'application/javascript','.mjs':'application/javascript','.html':'text/html','.css':'text/css','.json':'application/json','.wasm':'application/wasm'};
  res.setHeader('Content-Type',types[path.extname(file)]||'application/octet-stream');
  try{
    let body=old&&oldFiles.has(name)?oldFiles.get(name):fs.readFileSync(file);
    if(name==='sw.js')body=body.toString()+"\nself.addEventListener('message',e=>{if(e.data==='qa-cache')e.ports[0].postMessage(CACHE);});";
    res.end(body);
  }
  catch{res.statusCode=404;res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+server.address().port,browser=await chromium.launch({headless:true});
try{
  const page=await browser.newPage();await page.goto(base+'/cache-upgrade-qa');
  await page.evaluate(async()=>{
    localStorage.setItem('qa-preserve','existing settings');
    await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;
  });
  await page.waitForFunction(()=>navigator.serviceWorker.controller);
  const before=await page.evaluate(async()=>({keys:await caches.keys(),bundle:await(await fetch('/vendor/gan/gan-3.0.2.js')).text()}));
  assert.ok(before.keys.includes('tagda-v10'));assert.ok(!before.bundle.includes('carry4-state-sync-2'));
  old=false;
  await page.evaluate(async()=>{
    window.__qaControllerChanged=false;
    navigator.serviceWorker.addEventListener('controllerchange',()=>{window.__qaControllerChanged=true;},{once:true});
    const registration=await navigator.serviceWorker.getRegistration();await registration.update();
  });
  // Cache deletion happens during activation, before clients.claim(). Wait for
  // the new controller as well, so this fetch cannot race the retiring worker.
  await page.evaluate(async()=>{
    const deadline=Date.now()+30000;
    while(Date.now()<deadline){
      const channel=new MessageChannel();
      const value=await new Promise(resolve=>{
        channel.port1.onmessage=e=>resolve(e.data);
        navigator.serviceWorker.controller.postMessage('qa-cache',[channel.port2]);
      });
      if(value==='tagda-v12'&&navigator.serviceWorker.controller.state==='activated')return;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    throw new Error('The updated service worker did not claim this page');
  });
  // A running page can still have old modules in its JavaScript module map.
  // Exercise the normal reload that brings the app onto the new release.
  await page.reload();
  const after=await page.evaluate(async()=>({keys:await caches.keys(),bundle:await(await fetch('/vendor/gan/gan-3.0.2.js')).text(),settings:localStorage.getItem('qa-preserve')}));
  assert.ok(after.keys.includes('tagda-v12'));
  assert.ok(after.bundle.includes('carry4-state-sync-2'));assert.equal(after.settings,'existing settings');
  assert.ok(!after.keys.includes('tagda-v10'));
  console.log(JSON.stringify({oldCache:before.keys,newCache:after.keys,newBundleHasCarry4:true,settingsPreserved:true}));
  console.log('PASS: existing v181 service worker upgrades to v182, replaces the stock GAN bundle and preserves local settings');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
