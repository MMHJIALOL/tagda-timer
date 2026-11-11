const assert = require('node:assert/strict');
const { chromium } = require('@playwright/test');
const base = process.argv[2] || 'http://localhost:5186';
(async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const context = await browser.newContext({serviceWorkers:'block'});
    await context.addInitScript(() => {
      window.__cubeListeners = new Set(); window.__cubeSerial = 0; window.__cubeInitial = 'UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB';
      window.__cubeEmit = e => { for(const fn of [...window.__cubeListeners])fn(e); };
    });
    await context.route(/\/vendor\/gan\/gan-3\.0\.2\.js$/, r => r.fulfill({contentType:'application/javascript',body:`
      export { cubeTimestampLinearFit } from '/vendor/gan/gan-3.0.2.js?production';
      export function connectGanCube() { return Promise.resolve({deviceName:'Synthetic GAN',deviceMAC:'private',
        events$: {subscribe(fn){window.__cubeListeners.add(fn);return {unsubscribe(){window.__cubeListeners.delete(fn);}};}},
        async sendCubeCommand({type}) {if(type==='REQUEST_FACELETS')window.__cubeEmit({type:'FACELETS',serial:window.__cubeSerial,facelets:window.__cubeInitial});},
        async disconnect(){} }); }
    `}));
    await context.route('**/announcements.json*',r=>r.fulfill({body:'null'}));
    await context.route('**/config.json*',r=>r.fulfill({body:'null'}));
    const page = await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
    const started=Date.now();await page.goto(base);
    await page.waitForFunction(()=>window.tagdatimer?.scramble?.scramble,null,{timeout:60000});
    console.log('Startup to scramble:',Date.now()-started,'ms');
    await page.evaluate(async()=> {
      const app=window.tagdatimer;
      document.querySelectorAll('.an-dlg[open]').forEach(d=>d.dispatchEvent(new Event('cancel',{cancelable:true})));
      app.setSetting('inspection',true);app.setSetting('confirmShortSolves',false);app.setSetting('soundOnPB',false);
      const {scrambleState}=await import('/js/smart-cube-core.js');
      app.scramble.scramble='R U F';window.__cubeInitial=scrambleState('R U F');
      app.setSetting('inputMode','smart');
    });
    const connect=page.getByRole('button',{name:'Connect cube',exact:true});await connect.waitFor({timeout:10000}).catch(async e=>{await page.screenshot({path:'docs/smart-cube-debug.png'});console.log(await page.evaluate(()=>({errors:document.querySelector('#boot-error')?.textContent,input:document.body.dataset.input,wrap:document.querySelector('#smart-cube-wrap')?.outerHTML.slice(0,1000),zone:document.querySelector('#timer-zone')?.getBoundingClientRect().toJSON()})));console.log(errors);throw e;});await page.waitForFunction(()=>!document.querySelector('#smart-cube-wrap button').disabled);await connect.click();
    await page.waitForFunction(()=>document.querySelector('#smart-cube-wrap').dataset.attempt==='inspection');
    assert.deepEqual(await page.evaluate(()=>{
      const c=tagdatimer.smartCubeController();
      return {state:c.timer.state,moves:c.active.moves.length};
    }),{state:'inspecting',moves:0});
    await page.evaluate(()=> { for(const [i,move]of ["F'","U'","R'"].entries())window.__cubeEmit({type:'MOVE',serial:++window.__cubeSerial,move,cubeTimestamp:1000+i*100,localTimestamp:2000+i*100}); });
    await page.waitForFunction(()=>tagdatimer.solves.some(s=>s.smartCube));
    const saved = await page.evaluate(async()=> {const s=tagdatimer.solves.find(s=>s.smartCube);const db=await import('/js/db.js');return {s,c:await db.SmartCaptures.get(s.id)};});
    assert.equal(saved.c.moves.length,3);assert.equal(saved.s.timeMs,200);assert.equal(saved.c.completeness,'complete');
    console.log('PASS: real main input path, initial scrambled snapshot before command resolution, first turn to solved, atomic persistence');
    await page.locator('#history .t[role=button], .solve-chip .t[role=button], [role=listitem] .t[role=button]').first().click();
    await page.getByRole('dialog',{name:'Smart cube analysis'}).waitFor();await page.getByRole('button',{name:'Next turn',exact:true}).click();
    assert.match(await page.locator('.sa-readout > span').textContent(),/1\/3/);
    await page.getByRole('button',{name:'Next turn',exact:true}).click();await page.getByRole('button',{name:'Previous turn',exact:true}).click();
    assert.match(await page.locator('.sa-readout > span').textContent(),/1\/3/);
    await page.getByRole('combobox',{name:'Analysis profile'}).selectOption('cfop');
    await page.getByRole('button',{name:'Identify exact OLL / PLL algorithms',exact:true}).click();
    await page.getByText('No exact supported algorithm match. The observed moves remain available.',{exact:true}).waitFor();
    await page.getByRole('spinbutton',{name:'Last move',exact:true}).fill('1');
    await page.getByText('Scramble, timing & phase corrections',{exact:true}).click();
    await page.getByRole('button',{name:'Use selected end as phase boundary',exact:true}).click();
    await page.waitForFunction(async()=>((await(await import('/js/db.js')).SmartCaptures.get(tagdatimer.solves.find(s=>s.smartCube).id)).analysisConfig.phaseBoundaries||{}).Cross===1);
    await page.getByRole('combobox',{name:'Playback speed'}).selectOption('0.25');
    await page.getByRole('button',{name:'Restart',exact:true}).click();const replayStart=Date.now();await page.getByRole('button',{name:'Play',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.sa-readout > span').textContent.includes('3/3'));assert.ok(Date.now()-replayStart>=650);
    await page.getByRole('textbox',{name:'Range annotation'}).fill('Test range');await page.getByRole('button',{name:'Save annotation',exact:true}).click();
    await page.getByRole('tab',{name:'Segments',exact:true}).click();
    await page.getByRole('button',{name:/Test range:/}).waitFor();
    await page.getByRole('button',{name:'Close',exact:true}).click();
    await page.reload();await page.waitForFunction(()=>window.tagdatimer?.solves.some(s=>s.smartCube),null,{timeout:60000});
    await page.evaluate(()=>tagdatimer.openSmartAnalysis(tagdatimer.solves.find(s=>s.smartCube)));
    await page.getByRole('tab',{name:'Segments',exact:true}).click();
    await page.getByRole('button',{name:/Test range:/}).waitFor();await page.getByRole('button',{name:'Close',exact:true}).click();
    console.log('PASS: clickable time, seeking, annotations and replay after reload');
    const client=await context.newCDPSession(page);await client.send('HeapProfiler.collectGarbage');const heapBefore=(await client.send('Runtime.getHeapUsage')).usedSize;
    await page.evaluate(async()=>{for(let i=0;i<20;i++){await tagdatimer.openSmartAnalysis(tagdatimer.solves.find(s=>s.smartCube));document.querySelector('.smart-analysis').close();await new Promise(requestAnimationFrame);}});
    await client.send('HeapProfiler.collectGarbage');const heapAfter=(await client.send('Runtime.getHeapUsage')).usedSize;
    assert.equal(await page.locator('.smart-analysis').count(),0);
    assert.ok(heapAfter-heapBefore<5*1024*1024);console.log('PASS: 20 review open/close cycles, removed renderers; retained heap delta',Math.round((heapAfter-heapBefore)/1024),'KiB');

    await page.setViewportSize({width:390,height:844});
    await page.evaluate(()=>tagdatimer.openSmartAnalysis(tagdatimer.solves.find(s=>s.smartCube)));
    await page.getByRole('button',{name:'Next turn',exact:true}).waitFor();
    assert.ok(await page.locator('.sa-content').evaluate(d=>d.scrollWidth<=d.clientWidth+2));
    await page.getByRole('button',{name:'Close',exact:true}).click();

    await page.setViewportSize({width:1280,height:900});
    const guidance = await page.evaluate(async () => {
      const { SmartCubeController } = await import('/js/smart-cube.js');
      const { Timer } = await import('/js/timer.js');
      const { SOLVED, turnState, scrambleState } = await import('/js/smart-cube-core.js');
      const host = document.createElement('section');
      const scrambleHost = document.createElement('p');
      document.body.append(host, scrambleHost);
      let facelets = SOLVED, serial = 0, receive, saves = 0;
      const ctx = { sessionId:'guidance', event:'333', mode:'wca', scramble:'R U2 F', inspection:true, allowed:true };
      scrambleHost.textContent = ctx.scramble;
      const timer = new Timer({ inspection:true });
      const c = new SmartCubeController({ host, timer, scrambleHost, context:()=>ctx,
        save:async()=>{ saves++; }, notice:()=>{}, switchInput:()=>{} });
      c.protocol = { connectGanCube:async()=>({
        deviceName:'Guidance test',
        events$:{ subscribe(fn) { receive=fn; return { unsubscribe() { receive=null; } }; } },
        async sendCubeCommand({ type }) { if(type==='REQUEST_FACELETS') receive({type:'FACELETS',serial,facelets}); },
        async disconnect() {},
      }) };
      const turn = move => {
        if(move.endsWith('2')) { turn(move[0]); turn(move[0]); return; }
        facelets = turnState(facelets, move);
        receive({ type:'MOVE', move, serial:++serial, cubeTimestamp:serial*100, localTimestamp:serial*100+1000 });
      };
      try {
        c.sync(); await c.connect();
        turn('R'); turn("U'"); turn('B');
        const wrong = c.guide.completed===1 && c.guide.partial && c.guide.corrections.join(' ')==="B'"
          && host.dataset.correcting==='true' && timer.state==='idle'
          && scrambleHost.querySelectorAll('.is-done').length===1;
        turn("B'"); turn("U'"); turn('F');
        const corrected = c.attemptState==='inspection' && timer.state==='inspecting' && c.active.moves.length===0
          && scrambleHost.querySelectorAll('.is-done').length===3;
        await c.disconnect();
        facelets = scrambleState('L B D F2 R U'); serial = 0;
        ctx.scramble = 'R U F'; scrambleHost.textContent = ctx.scramble;
        c.sync(); await c.connect();
        const deadline = performance.now()+15000;
        while(!c.recoveryGuide && !c.guidanceError && performance.now()<deadline) await new Promise(r=>setTimeout(r,25));
        if(!c.recoveryGuide) throw new Error('Recovery solver did not return a route');
        const route = [...c.recoveryGuide.tokens];
        route.forEach(turn);
        const restored = facelets===SOLVED && c.guide.completed===0 && c.guide.anchored && timer.state==='idle';
        ['R','U','F'].forEach(turn);
        return { wrong, corrected, restored, ready:c.attemptState==='inspection' && timer.state==='inspecting' && c.active.moves.length===0, saves };
      } finally { c.dispose(); host.remove(); scrambleHost.remove(); }
    });
    assert.deepEqual(guidance,{wrong:true,corrected:true,restored:true,ready:true,saves:0});
    console.log('PASS: green scramble progress, half-turn mistakes, corrective moves, automatic inspection and worker recovery from an arbitrary cube');
    // Exercise lifecycle and timing independently of the main UI's next-scramble
    // worker, then measure coalesced event-to-visible latency in this browser.
    const soak = await page.evaluate(async()=> {
      const {SmartCubeController}=await import('/js/smart-cube.js'); const {Timer}=await import('/js/timer.js');
      const {scrambleState}=await import('/js/smart-cube-core.js');
      const host=document.createElement('section');document.body.append(host);let saves=0,last;
      const context={sessionId:'soak',event:'333',mode:'wca',scramble:'R U F',inspection:false,ownerUid:null,allowed:true};
      const controller=new SmartCubeController({host,timer:new Timer({inspection:false}),context:()=>context,
        save:async c=>{saves++;last=c;},notice:()=>{},switchInput:()=>{}});
      controller.protocol=await import('/vendor/gan/gan-3.0.2.js');
      for(let n=0;n<200;n++) {
        window.__cubeInitial=scrambleState(context.scramble);window.__cubeSerial=0;controller.sync();await controller.connect();
        for(const [i,move]of ["F'","U'","R'"].entries())window.__cubeEmit({type:'MOVE',serial:++window.__cubeSerial,move,cubeTimestamp:1000+i*100,localTimestamp:2000+i*100});
        await Promise.resolve();await controller.disconnect();
      }
      const latency=[];const {SmartStream,SOLVED}=await import('/js/smart-cube-core.js');let serial=0,applied=0;const stream=new SmartStream({epoch:99,onMove:()=>applied++,onState:s=>controller.preview.set(s)});stream.ingest({type:'FACELETS',serial:0,facelets:SOLVED});
      for(let batch=0;batch<30;batch++) {
        const start=performance.now();for(let i=0;i<20;i++)stream.ingest({type:'MOVE',serial:++serial%256,move:'URFDLB'[i%6],cubeTimestamp:serial*20,localTimestamp:serial*20});
        await new Promise(requestAnimationFrame);latency.push(performance.now()-start);
      }
      controller.dispose();host.remove();latency.sort((a,b)=>a-b);
      return {saves,applied,lastMoves:last.moves.length,listeners:window.__cubeListeners.size,p95:latency[Math.floor(latency.length*.95)]};
    });
    const boundaries = await page.evaluate(async()=> {
      const {SmartCubeController}=await import('/js/smart-cube.js'),{Timer}=await import('/js/timer.js'),{scrambleState}=await import('/js/smart-cube-core.js'),{KV}=await import('/js/db.js');
      let result; const records=[];const ctx={sessionId:'original',event:'333',mode:'wca',scramble:'R U F',inspection:true,allowed:true};
      const host=document.createElement('div');document.body.append(host);const timer=new Timer({inspection:true});
      const c=new SmartCubeController({host,timer,context:()=>ctx,save:async capture=>{result=capture;records.push(capture);},notice:()=>{},switchInput:()=>{}});
      c.protocol=await import('/vendor/gan/gan-3.0.2.js');c.sync();
      const connect=async()=>{window.__cubeInitial=scrambleState(ctx.scramble);window.__cubeSerial=0;await c.connect();};
      const move=(m,i=0,skip=1)=>window.__cubeEmit({type:'MOVE',serial:window.__cubeSerial+=skip,move:m,cubeTimestamp:100+i*100,localTimestamp:200+i*100});
      await connect();
      const automaticallyInspecting=c.attemptState==='inspection'&&timer.state==='inspecting'&&c.active.moves.length===0;
      const inspectStart=timer.inspectStart, captureId=c.active.id;
      window.__cubeEmit({type:'FACELETS',serial:window.__cubeSerial,facelets:window.__cubeInitial});
      c.sync();c.match();c.inspect();
      const startedOnce=timer.inspectStart===inspectStart&&c.active.id===captureId;
      timer.cancel();c.match();
      const cancelled=timer.state==='idle'&&!c.active&&c.attemptState==='scramble matched';
      c.armButton.click();
      const restarted=timer.state==='inspecting'&&c.active.id!==captureId;
      await c.disconnect();
      await connect();timer.inspectStart=performance.now()-16000;move("F'");move("U'",1);move("R'",2);await Promise.resolve();const plus2=result.penalty;
      await c.disconnect();await connect();timer.inspectStart=performance.now()-18000;move("F'");move("U'",1);move("R'",2);await Promise.resolve();const dnf=result.penalty;const before=records.length;
      window.__cubeEmit({type:'MOVE',serial:window.__cubeSerial,move:"R'",cubeTimestamp:300,localTimestamp:400});await Promise.resolve();const exactlyOnce=before===records.length;
      await c.disconnect();await connect();move("F'");await new Promise(r=>setTimeout(r,600));const checkpoint=await KV.get('smartCube.active');
      ctx.sessionId='changed';c.sync();await Promise.resolve();const frozen=result.context.sessionId==='original'&&result.completeness==='interrupted'&&checkpoint.moves.length===1;
      await c.disconnect();ctx.inspection=false;ctx.sessionId='original';c.sync();await connect();c.preview.set=()=>{throw new Error('Renderer crash');};move("F'");move("U'",1);move("R'",2);await Promise.resolve();const rendererIndependent=result.completeness==='complete'&&result.moves.length===3;
      window.__cubeEmit({type:'FACELETS',serial:window.__cubeSerial,facelets:scrambleState('R')});
      await new Promise(r=>setTimeout(r,50));const lateInvalidated=result.completeness==='interrupted'&&result.postSolveEvidence?.length===1;
      c.dispose();host.remove();await KV.del('smartCube.active');localStorage.removeItem('tagda:smartCube.active');
      return {automaticallyInspecting,startedOnce,cancelled,restarted,plus2,dnf,exactlyOnce,frozen,rendererIndependent,lateInvalidated};
    });
    assert.deepEqual(boundaries,{automaticallyInspecting:true,startedOnce:true,cancelled:true,restarted:true,plus2:'+2',dnf:'DNF',exactlyOnce:true,frozen:true,rendererIndependent:true,lateInvalidated:true});
    console.log('PASS: automatic inspection, repeated snapshots, cancellation/restart, +2/DNF, exactly-once completion, 500ms journal, frozen session, renderer isolation and late mismatch invalidation');
    assert.equal(soak.saves,200);assert.equal(soak.applied,600);assert.equal(soak.lastMoves,3);assert.equal(soak.listeners,0);assert.ok(soak.p95<100);
    console.log('PASS: 200 capture/connect/disconnect cycles; exact counts, no retained subscriptions; preview p95',soak.p95.toFixed(2),'ms');
    await page.evaluate(()=>{tagdatimer.setSetting('inspection',false);tagdatimer.setSetting('inputMode','timer');});await page.keyboard.press('Space');await page.waitForTimeout(100);await page.keyboard.press('Space');
    assert.equal(await page.evaluate(()=>document.body.classList.contains('timing')),false);
    assert.deepEqual(errors,[]);console.log('PASS: phone layout and keyboard fallback; no uncaught browser errors');
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
