const assert=require('node:assert/strict');
const {chromium}=require('@playwright/test');
(async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    const context=await browser.newContext();
    const page=await context.newPage();await page.goto(process.argv[2]||'http://localhost:5186');
    await page.waitForFunction(()=>window.tagdatimer?.scramble?.scramble,null,{timeout:60000});
    await page.evaluate(()=>navigator.serviceWorker.ready);
    await page.waitForFunction(()=>navigator.serviceWorker.controller);
    const cached=await page.evaluate(async()=>{
      const cache=await caches.open('tagda-v9');
      return !!await cache.match('/vendor/gan/gan-3.0.2.js')&&!!await cache.match('/js/smart-cube.js')&&!!await cache.match('/js/smart-cube-scramble.js');
    });assert.equal(cached,true);
    await context.setOffline(true);await page.reload();
    await page.waitForFunction(()=>window.tagdatimer?.scramble?.scramble,null,{timeout:60000});
    await page.evaluate(()=>tagdatimer.setSetting('inputMode','smart'));
    await page.waitForFunction(()=>document.querySelector('#smart-cube-wrap button')&&!document.querySelector('#smart-cube-wrap button').disabled);
    assert.ok(await page.getByRole('button',{name:'Connect cube',exact:true}).count());
    await page.evaluate(async()=>{
      const {SmartCubeController}=await import('/js/smart-cube.js'),{Timer}=await import('/js/timer.js'),core=await import('/js/smart-cube-core.js'),db=await import('/js/db.js');
      const host=document.createElement('div');document.body.append(host);let done,serial=0,facelets=core.scrambleState('L B D F2 R U');
      const c=new SmartCubeController({host,timer:new Timer({inspection:false}),context:()=>({sessionId:'offline',event:'333',mode:'wca',scramble:'R U F',inspection:false,allowed:true}),
        save:async capture=>{await db.Solves.put({id:capture.id,sessionId:'offline',event:'333',timeMs:capture.measuredDurationMs,createdAt:Date.now(),smartCube:{captureId:capture.id}},capture);done=capture;},notice:()=>{},switchInput:()=>{}});
      const protocol=await import('/vendor/gan/gan-3.0.2.js');let receive;
      c.protocol={cubeTimestampLinearFit:protocol.cubeTimestampLinearFit,connectGanCube:()=>Promise.resolve({deviceName:'Synthetic GAN',events$:{subscribe(fn){receive=fn;return {unsubscribe(){}};}},sendCubeCommand:async({type})=>{if(type==='REQUEST_FACELETS')receive({type:'FACELETS',serial,facelets});},disconnect:async()=>{}})};
      const turn=move=>{
        if(move.endsWith('2')){turn(move[0]);turn(move[0]);return;}
        facelets=core.turnState(facelets,move);
        receive({type:'MOVE',serial:++serial,move,cubeTimestamp:serial*100,localTimestamp:200+serial*100});
      };
      c.sync();await c.connect();
      for(let i=0;i<300&&!c.recoveryGuide&&!c.guidanceError;i++)await new Promise(r=>setTimeout(r,50));
      if(!c.recoveryGuide)throw new Error('Offline recovery guidance unavailable');
      [...c.recoveryGuide.tokens].forEach(turn);
      if(facelets!==core.SOLVED)throw new Error('Offline recovery did not restore the cube');
      ['R','U','F',"F'","U'","R'"].forEach(turn);
      for(let i=0;i<30&&!done;i++)await new Promise(r=>setTimeout(r,50));
      if(!done||!(await db.SmartCaptures.get(done.id)))throw new Error('Offline capture failed');
      c.dispose();host.remove();
    });
    console.log('PASS: first-load service-worker assets, offline reload, arbitrary-state scramble guidance and offline atomic solve/capture recording');
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
