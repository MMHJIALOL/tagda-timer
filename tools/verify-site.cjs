// Run with serve.py on localhost. Fresh browser contexts; no production writes.
// TAGDA_PLAYWRIGHT_PATH can point at an existing Playwright install.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const playwright = require(process.env.TAGDA_PLAYWRIGHT_PATH || 'playwright');
const url = process.env.TAGDA_QA_URL || 'http://localhost:5186';
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(url)) throw new Error('Local QA only');
const results=[];
async function check(name, fn) {
 try { await fn();results.push({name,pass:true});console.log('PASS',name); }
 catch(e) {results.push({name,pass:false,error:e.message});console.log('FAIL',name,e.message);}
}
const section=process.argv[2] || 'all';
const sections=['layout','timer','tools','network','extras','settings'];
if(section==='all') {
 const {spawnSync}=require('node:child_process');let failed=false;
 for(const name of sections) {
  const run=spawnSync(process.execPath,[__filename,name],{stdio:'inherit',env:process.env});
  if(run.status!==0)failed=true;
 }
 process.exit(failed?1:0);
}
if(!sections.includes(section))throw new Error(`Unknown section: ${section}`);
const runs=s=>section==='all'||section===s;
(async()=>{
 await fs.mkdir('audit-qa',{recursive:true});
 const name=process.env.TAGDA_BROWSER || 'chrome';
 const browser=await (playwright[name] || playwright.chromium).launch({...(playwright[name]?{}:{channel:name}),headless:true});
 const context=await browser.newContext({viewport:{width:1280,height:800},hasTouch:true,serviceWorkers:'block'});
 // Authenticated SOTD is covered with an injected transport below; this suite
 // must never register racers, send chat, or post results to the hosted project.
 await context.route(/https:\/\/.*(?:firebase|googleapis|gstatic|tagdatimer\.me)/,r=>r.abort());
 await context.addInitScript(()=>{
   localStorage.setItem('tdt-ann',JSON.stringify({'random-1v1':{v:2,answer:'dismissed',shows:3},'webcam-replay':{v:1,answer:'dismissed',shows:3},feedback:{v:1,answer:'dismissed',shows:1}}));
 });
 const page=await context.newPage(),errors=[],navigationCancellations=[];
 let reloadInProgress=false,cancelledWorker=null;
 page.on('requestfailed',r=>{
  if(reloadInProgress && r.url().endsWith('/vendor/cubing/chunks/search-worker-entry.js')
     && r.failure()?.errorText==='Load request cancelled')cancelledWorker={url:r.url(),at:Date.now()};
 });
 page.on('pageerror',e=>{
  // WebKit reports a worker ErrorEvent when navigation cancels its request,
  // even though cubing catches the rejected initialization. Keep this observed
  // unload diagnostic separate; errors on a live page still fail the suite.
  if(name==='webkit' && reloadInProgress && cancelledWorker && Date.now()-cancelledWorker.at<1000
     && e.message===`Cannot load ${cancelledWorker.url} due to access control checks.`) {
   navigationCancellations.push(e.stack || e.message);
   console.log('DIAGNOSTIC WebKit cancelled an outgoing page worker during reload');
  } else {
   errors.push(e.stack || e.message);
   if(e.message.includes('search-worker-entry.js'))console.log('WORKER_DIAGNOSTIC',JSON.stringify({message:e.message,reloadInProgress,cancelledWorker}));
  }
 });
 const reload=async()=>{reloadInProgress=true;cancelledWorker=null;try{await page.reload();}finally{reloadInProgress=false;}};
 page.on('console',m=>{if(m.type()==='warning'&&/^\[(cube|xp1|recon)\]/.test(m.text())) console.log('WARN',m.text());});
 const watchdog=setTimeout(()=>browser.close(),300000);
 const boot=async p=>{await p.goto(url);await p.waitForFunction(()=>window.tagdatimer?.scramble?.scramble,null,{timeout:90000});await p.evaluate(()=>tagdatimer.setSetting('bgMode','solid'));};
 const screenshot=async label=>page.screenshot({path:`audit-qa/${name}-${label}.png`});
 try {
  await boot(page);
  if(runs('layout')) {
   await check('Preview and expanded stats reach a stable layout at short desktop heights',async()=>{
    for(const width of [900,1024,1280]) {
     await page.setViewportSize({width,height:600});await page.evaluate(async()=>{tagdatimer.expandStats();(await import('/js/tiles.js')).measureLayout();});await page.waitForTimeout(1000);
     const samples=[];
     for(let i=0;i<12;i++) {
      samples.push(await page.evaluate(async()=>{
       (await import('/js/tiles.js')).measureLayout();
       const r=document.querySelector('#panel-cube').getBoundingClientRect(),s=document.querySelector('#panel-stats').getBoundingClientRect();
       return [r.x,r.y,s.x,s.y,s.height,document.documentElement.style.getPropertyValue('--cube-clear-right')].map(x=>typeof x==='number'?Math.round(x):x);
      }));await page.waitForTimeout(80);
     }
     assert.equal(new Set(samples.map(JSON.stringify)).size,1,`${width}: ${JSON.stringify(samples)}`);
     await screenshot(`verified-preview-${width}`);
    }
   });
   await check('Hidden or manually placed preview releases reserved rail space',async()=>{
    await page.evaluate(async()=>{document.querySelector('#panel-cube').dataset.placed='true';(await import('/js/tiles.js')).measureLayout();});
    await page.waitForTimeout(450);
    assert.equal(await page.evaluate(()=>document.documentElement.style.getPropertyValue('--cube-clear-right')),'0px');
    await page.evaluate(()=>document.querySelector('#panel-cube').removeAttribute('data-placed'));
   });
   await check('Landscape expanded stats keep readable figures without overlapping the clock',async()=>{
    await page.setViewportSize({width:844,height:390});await page.evaluate(()=>tagdatimer.expandStats());await page.waitForTimeout(500);
    const g=await page.evaluate(()=>({stats:document.querySelector('#panel-stats').getBoundingClientRect().toJSON(),time:document.querySelector('#timer-display').getBoundingClientRect().toJSON(),peek:getComputedStyle(document.querySelector('.stats-peek')).display}));
    assert.notEqual(g.peek,'none');assert(g.stats.y>=g.time.bottom,JSON.stringify(g));assert(g.stats.bottom<=390,JSON.stringify(g));await screenshot('verified-landscape');
   });
   await check('Phone DNF averages remain DNF, while empty averages remain unavailable',async()=>{
    await page.setViewportSize({width:390,height:844});
    await page.evaluate(async()=>{for(let i=0;i<5;i++)await tagdatimer.recordSolve({timeMs:10000+i*1000,penalty:i>=3?'DNF':'none'});});
    await page.locator('.ph-tab[data-tab="times"]').click();
    assert.equal(await page.locator('.ph-card-v').nth(0).innerText(),'DNF');assert.equal(await page.locator('.ph-card-v').nth(1).innerText(),'—');await screenshot('verified-phone-dnf');
   });
   await check('Phone tabs, statistics drawer and session sheet stay inside narrow viewports',async()=>{
    for(const [width,height] of [[320,568],[390,844],[640,960]]){
     await page.setViewportSize({width,height});
     for(const tab of ['times','train','more','timer']){
      await page.locator(`.ph-tab[data-tab="${tab}"]`).click();
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width);
     }
     await page.locator('#ph-context').click();assert(await page.locator('.sheet').last().isVisible());await page.keyboard.press('Escape');await page.waitForTimeout(350);
    }
   });
  }
  if(runs('timer')) {
   await page.setViewportSize({width:390,height:844});
   await check('Typed times preserve values, penalties, original scramble and reload persistence',async()=>{
    await page.evaluate(()=>{tagdatimer.setSetting('inputMode','manual');tagdatimer.setCustomScrambles(['R U','F D','L B','R2 U2','F2 D2','L2 B2']);});
    for(const [input,ms,penalty] of [['12.34',12340,'none'],['1:05.67',65670,'none'],['1234',12340,'none'],['12.34+2',12340,'+2'],['DNF',0,'DNF']]){
     const before=await page.evaluate(()=>{window.qaPreviousScramble=tagdatimer.scramble;return {n:tagdatimer.solves.length,scramble:tagdatimer.scramble.scramble};});
     await page.locator('#manual-input').fill(input);await page.locator('#manual-input').press('Enter');
     await page.waitForFunction(n=>tagdatimer.solves.length===n+1 && tagdatimer.scramble!==window.qaPreviousScramble,before.n);
     const s=await page.evaluate(()=>tagdatimer.solves.at(-1));assert.equal(s.timeMs,ms);assert.equal(s.penalty,penalty);assert.equal(s.scramble,before.scramble);
    }
    const n=await page.evaluate(()=>tagdatimer.solves.length);await reload();await page.waitForFunction(()=>window.tagdatimer?.scramble?.scramble,null,{timeout:90000});assert.equal(await page.evaluate(()=>tagdatimer.solves.length),n);
    await page.evaluate(()=>tagdatimer.clearCustomScrambles());
   });
   await check('Invalid typed times cannot create solves',async()=>{
    const n=await page.evaluate(()=>tagdatimer.solves.length);
    for(const s of ['oops','-3','1:99.9']){await page.locator('#manual-input').fill(s);await page.locator('#manual-input').press('Enter');}
    assert.equal(await page.evaluate(()=>tagdatimer.solves.length),n);
   });
   await check('Keyboard inspection cancels; timed solves save once',async()=>{
    await page.evaluate(()=>{tagdatimer.setSetting('inputMode','timer');tagdatimer.setSetting('inspection',true);tagdatimer.setSetting('holdTime',0);document.activeElement.blur();});
    await page.keyboard.press('Space');await page.waitForFunction(()=>document.body.classList.contains('inspecting'));
    await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.body.classList.contains('inspecting'));
    await page.evaluate(()=>tagdatimer.setSetting('inspection',false));const n=await page.evaluate(()=>tagdatimer.solves.length);
    await page.keyboard.press('Space');await page.waitForFunction(()=>document.body.classList.contains('timing'));await page.waitForTimeout(150);await page.keyboard.press('Space');await page.waitForFunction(n=>tagdatimer.solves.length===n+1,n);
   });
   await check('Phone touch starts inspection, cancels, and records one solve per start/stop',async()=>{
    await page.setViewportSize({width:390,height:844});
    await page.evaluate(()=>{tagdatimer.setSetting('inspection',true);document.activeElement.blur();});
    await page.locator('#timer-display').tap();await page.waitForFunction(()=>document.body.classList.contains('inspecting'));
    await page.locator('#inspect-cancel').tap();await page.waitForFunction(()=>!document.body.classList.contains('inspecting'));
    await page.evaluate(()=>tagdatimer.setSetting('inspection',false));
    const before=await page.evaluate(()=>tagdatimer.solves.length);
    await page.locator('#timer-display').tap();await page.waitForFunction(()=>document.body.classList.contains('timing'));
    await page.waitForTimeout(150);await page.locator('#timer-display').tap();await page.waitForFunction(n=>tagdatimer.solves.length===n+1,before);
    await page.waitForSelector('.coffee-nudge');
    const rects=await page.evaluate(()=>({card:document.querySelector('.coffee-nudge').getBoundingClientRect().toJSON(),dock:document.querySelector('#ph-dock').getBoundingClientRect().toJSON()}));
    assert(rects.card.bottom<=rects.dock.top,JSON.stringify(rects));
    await page.evaluate(async()=>{(await import('/js/toast.js')).toast('Solve saved',{hold:true});});
    for(const [width,height] of [[320,568],[390,844]]) {
     await page.setViewportSize({width,height});await page.waitForTimeout(450);
     const r=await page.evaluate(()=>({toast:document.querySelector('#toasts').getBoundingClientRect().toJSON(),card:document.querySelector('.coffee-nudge').getBoundingClientRect().toJSON()}));
     assert(r.toast.height>0 && r.toast.bottom<=r.card.top,JSON.stringify(r));
    }
    await screenshot('verified-support-dock');
    await page.locator('.ph-tab[data-tab="times"]').tap();assert(!await page.evaluate(()=>document.body.classList.contains('timing')));
    await page.locator('.ph-tab[data-tab="timer"]').tap();
   });
   await check('Events, previews and trainer sessions switch without losing solves',async()=>{
    for(const event of ['222','444','555','666','777','333oh','333bf','444bf','555bf','clock','minx','pyram','skewb','sq1','fto','333']) {
     await page.evaluate(e=>{window.qaPreviousScramble=tagdatimer.scramble;return tagdatimer.setEvent(e);},event);
     await page.waitForFunction(()=>tagdatimer.scramble!==window.qaPreviousScramble && !!tagdatimer.scramble?.scramble,null,{timeout:90000});
     assert.equal(await page.evaluate(()=>tagdatimer.settings.event),event);
    }
    for(const mode of ['pll','oll','f2l','wca']){await page.evaluate(m=>{window.qaPreviousScramble=tagdatimer.scramble;return tagdatimer.setMode(m);},mode);await page.waitForFunction(()=>tagdatimer.scramble!==window.qaPreviousScramble && !!tagdatimer.scramble?.scramble,null,{timeout:90000});}
   });
  }
  if(runs('tools')) {
   await check('Rapid Cross + 1 opens create one workbench and one cube',async()=>{
    await page.setViewportSize({width:390,height:844});
    const count=await page.evaluate(async()=>{const m=await import('/js/xplus1.js');await Promise.all([m.openXp1({scramble:'R U'}),m.openXp1({scramble:'R U'})]);await new Promise(r=>setTimeout(r,400));return {hosts:document.querySelectorAll('#xp1').length,players:document.querySelectorAll('#xp1 twisty-player').length};});
    await page.evaluate(async()=>{(await import('/js/xplus1.js')).closeXp1();});assert.equal(count.hosts,1);assert(count.players<=1);
   });
   await check('Cross + 1 plan, answer, checking line, resizing and reopening',async()=>{
    await page.evaluate(async()=>{await (await import('/js/xplus1.js')).openXp1({scramble:'R U'});});
    await page.locator('.xp-ph-skip').click();await page.getByRole('button',{name:'Check my line',exact:true}).click();
    await page.locator('#xp1 .mp-key.face').filter({hasText:/^U$/}).click();
    await page.locator('#xp1 .mp-key[aria-label="Prime: turn the last move the other way"]').click();
    await page.locator('#xp1 .mp-key.face').filter({hasText:/^R$/}).click();
    await page.locator('#xp1 .mp-key[aria-label="Prime: turn the last move the other way"]').click();
    assert.equal(await page.locator('#xp-ph-planned').inputValue(),"U' R'");
    for(const [width,height] of [[320,568],[844,390],[820,1180],[1280,800],[390,844]]){await page.setViewportSize({width,height});await page.waitForTimeout(250);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width);}
    await page.evaluate(async()=>{(await import('/js/xplus1.js')).closeXp1();});
    assert(!await page.locator('#xp1').isVisible());
   });
   await check('Concurrent reconstruction opens reuse one cube renderer',async()=>{
    const c=await page.evaluate(async()=>{const m=await import('/js/recon.js');await Promise.all([m.openRecon({scramble:'R U'}),m.openRecon({scramble:'R U'})]);return document.querySelectorAll('#recon twisty-player').length;});assert.equal(c,1);
   });
   await check('Pasted lowercase wide turns retain their meaning in both trainers',async()=>{
    await page.setViewportSize({width:1280,height:800});
    await page.evaluate(async()=>{await (await import('/js/recon.js')).openRecon({scramble:'R U'});});
    await page.locator('input[aria-label="Add moves"]').fill("r U r'");
    assert.equal(await page.locator('input[aria-label="Add moves"]').inputValue(),"r U r'");
    await page.locator('input[aria-label="Add moves"]').press('Space');
    assert(await page.locator('#recon').innerText().then(s=>s.includes("r")));
    await page.evaluate(async()=>{(await import('/js/recon.js')).closeRecon();await (await import('/js/xplus1.js')).openXp1({scramble:'R U'});});
    await page.locator('input[aria-label="Scramble to drill"]').fill("r U r'");
    await page.locator('input[aria-label="Scramble to drill"]').press('Enter');
    assert.equal(await page.locator('input[aria-label="Scramble to drill"]').inputValue(),"r U r'");
    await page.evaluate(async()=>{(await import('/js/xplus1.js')).closeXp1();});
   });
   await check('Reconstruction solved line, undo, replay and viewport changes',async()=>{
    await page.evaluate(async()=>{await (await import('/js/recon.js')).openRecon({scramble:'R U',moves:"U' R'"});});
    await page.setViewportSize({width:390,height:844});
    await page.getByRole('button',{name:'Replay the whole solve',exact:true}).click();
    assert(await page.locator('.rc-ph-replay').isVisible());
    await page.getByRole('button',{name:'One move forward',exact:true}).click();
    await page.getByRole('button',{name:'Jump to the end',exact:true}).click();
    await page.evaluate(async()=>{(await import('/js/recon.js')).closeRecon();await (await import('/js/recon.js')).openRecon({scramble:'R U',moves:"U' R'"});});
    assert.equal(await page.locator('.rc-ph-step').allTextContents().then(x=>x.join(' ')),"U' R'");
    await page.getByRole('button',{name:'Undo the last move',exact:true}).click();
    assert.equal(await page.locator('.rc-ph-step').allTextContents().then(x=>x.join(' ')),"U'");
    for(const [width,height] of [[320,568],[390,844],[844,390],[820,1180],[1280,800]]){await page.setViewportSize({width,height});await page.waitForTimeout(250);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width);await screenshot(`verified-recon-${width}`);}
    await page.evaluate(async()=>{(await import('/js/recon.js')).closeRecon();});assert(!await page.locator('#recon').isVisible());
   });
   await check('Failed 3D loads show one fallback and recover when the player becomes available',async()=>{
    const probe=await context.newPage();
    await probe.route(/(?:\/vendor\/cubing\/cubing\/twisty\.js$|https:\/\/cdn\.cubing\.net\/)/,r=>r.abort());
    try {
     await boot(probe);
     await probe.evaluate(async()=>{const m=await import('/js/recon.js');await m.openRecon({scramble:'R U'});m.closeRecon();await m.openRecon({scramble:'R U'});});
     assert.equal(await probe.locator('#recon .rc-nocube').count(),1);
     await probe.evaluate(async()=>{(await import('/js/recon.js')).closeRecon();await (await import('/js/xplus1.js')).openXp1({scramble:'R U'});});
     await probe.setViewportSize({width:1280,height:800});
     await probe.locator('#xp1 [data-view="3d"]').click();await probe.waitForTimeout(200);
     await probe.locator('#xp1 [data-view="3d"]').click();await probe.waitForTimeout(200);
     assert.equal(await probe.locator('#xp1 .xp-nocube').count(),1);
     // Another module can recover the shared custom element after an earlier
     // workbench load failed. Use the real vendored module on a fresh URL.
     await probe.evaluate(async()=>{await import('/vendor/cubing/cubing/twisty.js?qa-recovery');});
     await probe.locator('#xp1 [data-view="3d"]').click();await probe.waitForSelector('#xp1 twisty-player');
     assert.equal(await probe.locator('#xp1 .xp-nocube').count(),0);
     await probe.evaluate(async()=>{(await import('/js/xplus1.js')).closeXp1();await (await import('/js/recon.js')).openRecon({scramble:'R U'});});
     assert.equal(await probe.locator('#recon twisty-player').count(),1);assert.equal(await probe.locator('#recon .rc-nocube').count(),0);
    } finally {await probe.close();}
   });
  }
  if(runs('network')) {
   await check('Generator failures cannot mark fallback scrambles or sets as official',async()=>{
    const isolated=await browser.newContext({serviceWorkers:'block'}),probe=await isolated.newPage();
    await isolated.route(/https:\/\/.*(?:firebase|googleapis|gstatic|tagdatimer\.me)/,r=>r.abort());
    await probe.route('**/vendor/cubing/cubing/scramble.js',r=>r.fulfill({contentType:'text/javascript',body:'export async function randomScrambleForEvent(){throw new Error("Injected worker failure")}'}));
    try {
     await boot(probe);
     const results=await probe.evaluate(async()=>{
      const {generate}=await import('/js/scramble.js');
      return Promise.all([generate('333','wca'),generate('333mbf','wca',{multiCount:2}),generate('custom','wca',{relay:['222','333']})]);
     });
     for(const result of results){assert(result.scramble.length>0);assert.equal(result.official,false);}
     assert.equal(results[1].parts.length,2);assert.equal(results[2].parts.length,2);
     assert(await probe.locator('#scramble-text').getAttribute('title').then(t=>t.includes('not competition legal')));
    } finally {await isolated.close();}
   });
   await check('Race result still submits when the progress update fails',async()=>{
    const r=await page.evaluate(async()=>{
     const {Race}=await import('/js/race.js'),{scrambleHash}=await import('/js/race-net.js');
     const race=new Race({settings:{}});race.uid='qa';race.snap={roomId:'QA',meta:{phase:'racing'},round:{no:1,info:{hash:scrambleHash('R U')}}};
     let sent=0;race.net={target:()=>({roomId:'QA',round:1,uid:'qa'}),setProgress:async()=>{throw Error('offline-progress');},submitResult:async()=>{sent++;},unlockResults(){}};
     race._retry=fn=>fn();race._serveScramble=()=>{};race._syncPanel=()=>{};race._looksSuspect=()=>false;
     let error=null;try{await race.onSolveRecorded({id:'qa',scramble:'R U',timeMs:12340,penalty:'none'});}catch(e){error=e.message;}return {sent,error};
    });assert.equal(r.sent,1);assert.equal(r.error,null);
   });
   await check('SOTD refuses a timer start until the own-result check finishes',async()=>{
    const r=await page.evaluate(async()=>{
     const {Daily}=await import('/js/daily.js');const d=new Daily({settings:{event:'333'}});
     d.engaged=true;d.snap={signedIn:true,scramble:'R U',dayId:'2026-10-10'};d._resultChecked=false;d.submittedToday=false;
     const before=d.locked();d._resultChecked=true;d.attempting=true;return {before,after:d.locked()};
    });assert.equal(r.before,true);assert.equal(r.after,false);
   });
   await check('Race submission retries stay on the completed round; leaving cancels them',async()=>{
    const r=await page.evaluate(async()=>{
     const {Race}=await import('/js/race.js'),{scrambleHash}=await import('/js/race-net.js');
     const answers=[];
     for(const leave of [false,true]) {
      const race=new Race({settings:{}});race.uid='qa';race.snap={roomId:'QA',meta:{phase:'racing'},round:{no:1,info:{hash:scrambleHash('R U')}}};
      const sent=[];race.net={setProgress:async()=>{race.snap=leave?{roomId:'OTHER'}:{...race.snap,round:{no:2}};},submitResult:async(result,n)=>sent.push(n),unlockResults(){throw Error('Do not unlock a different round');}};
      race._retry=fn=>fn();race._serveScramble=()=>{};race._syncPanel=()=>{};race._looksSuspect=()=>false;
      await race.onSolveRecorded({id:'qa',scramble:'R U',timeMs:12340,penalty:'none'});answers.push(sent);
     }return answers;
    });assert.deepEqual(r,[[1],[]]);
   });
   await check('Firebase transport addresses the pinned round without making network requests',async()=>{
    const paths=await page.evaluate(async()=>{
     const {createTransport}=await import('/js/race-net.js');const net=createTransport('firebase'),paths=[];
     net.snap={roomId:'QA',uid:'qa',round:{no:2}};net._sdk={ref:(_,p)=>p,update:async p=>paths.push(p),set:async p=>paths.push(p),serverTimestamp:()=>0};
     await net.setProgress({status:'done'},1);await net.submitResult({timeMs:12000},1);return paths;
    });assert.deepEqual(paths,['rooms/QA/rounds/1/progress/qa','rooms/QA/rounds/1/results/qa']);
   });
   await check('SOTD progress failure preserves the result and its original submission target',async()=>{
    const r=await page.evaluate(async()=>{
     const {Daily}=await import('/js/daily.js');const d=new Daily({settings:{event:'333'},solves:[]});
     const at={dayKey:'123',event:'333',uid:'qa'};let submitted=null;
     d.snap={signedIn:true,scramble:'R U',dayId:'2026-10-10'};d.attempting=true;
     d.net={target:()=>at,setProgress:async()=>{throw Error('progress failure');},submitResult:async(result,target)=>{submitted={result,target};},unlockResults(){}};
     d._changed=()=>{};d._retry=fn=>fn();d._name=()=> 'QA';d._looksSuspect=()=>false;d._noteAttempt=()=>{};
     await d.onSolveRecorded({id:'qa',scramble:'R U',timeMs:12340,penalty:'none'});return submitted;
    });assert.equal(r.result.timeMs,12340);assert.deepEqual(r.target,{dayKey:'123',event:'333',uid:'qa'});
   });
   await check('Local race: two peers, shared scramble, result privacy, penalty and leave',async()=>{
    await page.evaluate(async()=>{tagdatimer.setSetting('racePrefer','local');window.qaRace=(await tagdatimer.raceModule()).getRace(tagdatimer);await qaRace.join('AUDITCHECK',{name:'QA One'});});
    const peer=await context.newPage();await boot(peer);
    try {
     await peer.evaluate(async()=>{tagdatimer.setSetting('racePrefer','local');window.qaRace=(await tagdatimer.raceModule()).getRace(tagdatimer);await qaRace.join('AUDITCHECK',{name:'QA Two'});});
     await page.evaluate(()=>qaRace._start());await page.waitForFunction(()=>qaRace.round?.info?.scramble,null,{timeout:90000});await peer.waitForFunction(()=>qaRace.round?.info?.scramble,null,{timeout:90000});
     assert.equal(await page.evaluate(()=>qaRace.round.info.scramble),await peer.evaluate(()=>qaRace.round.info.scramble));
     await page.evaluate(()=>tagdatimer.recordSolve({timeMs:12000}));await page.waitForFunction(()=>qaRace.submittedRound===qaRace.round.no);
     assert.equal(await peer.evaluate(()=>Object.keys(qaRace.round.results).length),0);
     await peer.evaluate(()=>tagdatimer.recordSolve({timeMs:14000}));await page.waitForFunction(()=>Object.keys(qaRace.round.results).length===2);
     assert.equal(await page.evaluate(()=>Object.keys(qaRace.round.results).length),2);
     await page.evaluate(async()=>{const s=tagdatimer.solves.at(-1);s.penalty='+2';await qaRace.onPenalty(s);});
     await peer.waitForFunction(()=>Object.values(qaRace.round.results).some(s=>s.penalty==='+2'));
    } finally {await peer.evaluate(()=>qaRace?.leave());await peer.close();await page.evaluate(()=>qaRace.leave());}
   });
   await check('Local random 1v1 matches two peers, starts a round and leaves cleanly',async()=>{
    const peer=await context.newPage();await boot(peer);
    try {
     await peer.evaluate(async()=>{tagdatimer.setSetting('racePrefer','local');window.qaRace=(await tagdatimer.raceModule()).getRace(tagdatimer);await qaRace.findMatch();});
     await page.evaluate(()=>qaRace.findMatch());
     await page.waitForFunction(()=>qaRace.inRoom && qaRace.snap.meta.kind==='duel',null,{timeout:20000});
     await peer.waitForFunction(()=>qaRace.inRoom && qaRace.snap.meta.kind==='duel',null,{timeout:20000});
     assert.equal(await page.evaluate(()=>qaRace.snap.roomId),await peer.evaluate(()=>qaRace.snap.roomId));
     await page.setViewportSize({width:390,height:844});await screenshot('verified-duel-phone');
    }finally{await peer.evaluate(()=>qaRace?.leave());await peer.close();await page.evaluate(()=>qaRace.leave());}
   });
  }
  if(runs('extras')) {
   await check('SOTD signed-out UI remains navigable across phone, tablet and desktop',async()=>{
    await page.evaluate(async()=>{
     const {Daily}=await import('/js/daily.js');const d=new Daily(tagdatimer);d.snap={signedIn:false,scramble:null,dayId:'2026-10-10'};
     window.qaDaily=d;(await import('/js/dailyui.js')).openSotd(tagdatimer,d,{onExit:()=>{}});
    });
    for(const [width,height] of [[320,568],[390,844],[820,1180],[1280,800],[844,390]]) {
     await page.setViewportSize({width,height});await page.waitForTimeout(1100);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width);
     assert(!await page.locator('#scramble-tools').isVisible());
     assert(!await page.locator('#timer-avgs').isVisible());
     if(width<861){
      const r=await page.evaluate(()=>({board:document.querySelector('#sotd-board').getBoundingClientRect().toJSON(),core:document.querySelector('#timer-core').getBoundingClientRect().toJSON()}));
      assert(r.board.height>40 && r.board.top>=r.core.bottom+8,JSON.stringify(r));
      await page.locator('.sotd-signin button').scrollIntoViewIfNeeded();
      const sign=await page.locator('.sotd-signin button').boundingBox();assert(sign.y>=0 && sign.y+sign.height<=height);
     }
     await screenshot(`verified-sotd-${width}`);
    }
    await page.evaluate(async()=>{(await import('/js/dailyui.js')).closeSotd();});assert(!await page.evaluate(()=>document.body.classList.contains('sotd')));
   });
   await check('Settings, appearance, stats and gear drawers open and close at phone/tablet widths',async()=>{
    for(const width of [390,820,1280]) {
     await page.setViewportSize({width,height:844});
     for(const id of ['btn-settings','btn-theme','btn-stats','btn-gear']) {
      await page.evaluate(id=>document.getElementById(id).click(),id);await page.waitForSelector('#drawer:not([hidden])');
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width);await page.keyboard.press('Escape');await page.waitForTimeout(300);
     }
    }
   });
   await check('Custom scrambles are recorded in order and survive reload',async()=>{
    await page.evaluate(()=>tagdatimer.setCustomScrambles("R U\nF D\nL B"));
    await page.waitForFunction(()=>tagdatimer.scramble?.scramble==='R U');
    await page.evaluate(()=>tagdatimer.recordSolve({timeMs:12000}));await page.waitForFunction(()=>tagdatimer.scramble?.scramble==='F D');
    assert.equal(await page.evaluate(()=>tagdatimer.solves.at(-1).scramble),'R U');
    await reload();await page.waitForFunction(()=>tagdatimer?.scramble?.scramble==='F D');
    await page.evaluate(()=>tagdatimer.recordSolve({timeMs:13000}));await page.waitForFunction(()=>tagdatimer.scramble?.scramble==='L B');
    await reload();await page.waitForFunction(()=>tagdatimer?.scramble?.scramble==='L B');
    await page.evaluate(()=>tagdatimer.setCustomScrambles(['B2 D2'],{append:true}));
    assert.equal(await page.evaluate(()=>tagdatimer.scramble.scramble),'L B');
    await page.evaluate(()=>tagdatimer.recordSolve({timeMs:14000}));await page.waitForFunction(()=>tagdatimer.scramble?.scramble==='B2 D2');
    await page.evaluate(()=>tagdatimer.recordSolve({timeMs:14000}));await page.waitForFunction(()=>!tagdatimer.scramble?.custom);
    await reload();await page.waitForFunction(()=>tagdatimer?.scramble?.scramble && !tagdatimer.scramble.custom);
    await page.evaluate(()=>tagdatimer.clearCustomScrambles());
   });
   await check('Relay builds, records ordered splits and switches back to an ordinary session',async()=>{
    const old=await page.evaluate(()=>tagdatimer.session.id);
    await page.evaluate(()=>tagdatimer.startRelay(['222','333']));await page.waitForFunction(()=>tagdatimer.scramble?.parts?.length===2,null,{timeout:60000});
    await page.evaluate(()=>tagdatimer.recordSolve({timeMs:20000,splits:[8000]}));
    const r=await page.evaluate(()=>tagdatimer.solves.at(-1).relay);assert.deepEqual(r.map(x=>x.event),['222','333']);assert.deepEqual(r.map(x=>x.splitMs),[8000,12000]);
    await page.evaluate(id=>tagdatimer.switchSession(id),old);
   });
   await check('A delayed FMC import cannot reopen the workspace after an event switch',async()=>{
    const isolated=await browser.newContext({serviceWorkers:'block'}),probe=await isolated.newPage();
    await isolated.route(/https:\/\/.*(?:firebase|googleapis|gstatic|tagdatimer\.me)/,r=>r.abort());
    let release,requested;const loaded=new Promise(r=>requested=r),gate=new Promise(r=>release=r);
    await probe.route('**/js/fmcmode.js',async route=>{requested();await gate;await route.continue();});
    try {
     await boot(probe);
     const request=probe.waitForRequest('**/js/fmcmode.js',{timeout:15000});
     await probe.evaluate(()=>tagdatimer.setEvent('333fm'));await request;await loaded;
     await probe.evaluate(()=>tagdatimer.setEvent('333'));release();
     await probe.evaluate(async()=>{await import('/js/fmcmode.js');});await probe.waitForTimeout(300);
     assert(!await probe.evaluate(()=>document.body.classList.contains('fmc')));
    } finally {release();await isolated.close();}
   });
   await check('An outstanding FMC restore cannot restart a hidden workspace',async()=>{
    const state=await page.evaluate(async()=>{
     const {Fmc}=await import('/js/fmcmode.js');const f=new Fmc(tagdatimer);let release;
     f.restore=()=>new Promise(r=>release=r);const pending=f.sync(true);await f.sync(false);release();await pending;
     const result={hidden:f.host.hidden,active:document.body.classList.contains('fmc-attempting'),timer:f._tick};f.host.remove();return result;
    });assert.deepEqual(state,{hidden:true,active:false,timer:null});
   });
   await check('FMC workspace opens on phones and a solved attempt records its move count',async()=>{
    await page.evaluate(()=>tagdatimer.setEvent('333fm'));await page.waitForFunction(()=>document.body.classList.contains('fmc'),null,{timeout:60000});
    await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.body.classList.contains('fmc')));await screenshot('verified-fmc-phone');
    await page.evaluate(()=>tagdatimer.setCustomScrambles(['R U']));
    await page.getByRole('button',{name:'Start attempt',exact:true}).click();
    await page.locator('#fmc-solution').fill("U' R'");assert.equal(await page.locator('#fmc-state').innerText(),'solved');
    const before=await page.evaluate(()=>tagdatimer.solves.length);await page.locator('#fmc-submit').click();
    await page.waitForFunction(n=>tagdatimer.solves.length===n+1,before);assert.equal(await page.evaluate(()=>tagdatimer.solves.at(-1).fmcMoves),2);
    await page.evaluate(()=>tagdatimer.clearCustomScrambles());
    await page.evaluate(()=>tagdatimer.setEvent('333'));
   });
   await check('Algorithm library opens and renders without uncaught errors',async()=>{
    const alg=await context.newPage(),issues=[];alg.on('pageerror',e=>issues.push(e.message));
    try {await alg.goto(url+'/algs.html');await alg.waitForTimeout(4000);assert((await alg.locator('body').innerText()).includes('PLL'));assert.deepEqual(issues,[]);}finally{await alg.close();}
   });
   await check('Timed/FMC statistics, history and details keep their units in a mixed session',async()=>{
    await page.evaluate(async()=>{
     await tagdatimer.setEvent('333');
     for(const timeMs of [10000,12000,14000,16000,18000])await tagdatimer.recordSolve({timeMs});
     await tagdatimer.setEvent('333fm');
     for(const fmcMoves of [24,25,26])await tagdatimer.recordSolve({timeMs:600000,fmcMoves});
    });
    await page.setViewportSize({width:390,height:844});await page.locator('.ph-tab[data-tab="times"]').click();
    assert.equal(await page.locator('.ph-card-v').first().innerText(),'25');
    const bestIndex=await page.evaluate(()=>{
     const solves=tagdatimer.statsSolves(),best=Math.min(...solves.map(s=>s.fmcMoves));
     return tagdatimer.solves.indexOf(solves.findLast(s=>s.fmcMoves===best))+1;
    });
    assert.equal(await page.locator('.ph-card').nth(2).locator('.ph-card-sub').innerText(),`solve ${bestIndex}`);
    const fmcMean=await page.evaluate(()=>tagdatimer.statsSolves().reduce((s,x)=>s+x.fmcMoves,0)/tagdatimer.statsSolves().length);
    assert.equal(await page.locator('#s-mean').innerText(),String(Math.round(fmcMean*100)/100));
    await page.evaluate(()=>tagdatimer.setEvent('333'));
    const mean=await page.evaluate(()=>tagdatimer.statsSolves().reduce((s,x)=>s+x.timeMs,0)/tagdatimer.statsSolves().length);
    const displayed=(Math.floor(mean/10)/100).toFixed(2);
    assert.equal(await page.locator('.ph-card-v').nth(3).innerText(),displayed);
    await page.setViewportSize({width:1280,height:800});await page.evaluate(()=>tagdatimer.expandStats());await page.locator('#s-mean').click();
    assert.equal(await page.locator('.sd-value').innerText(),displayed);
    assert.equal(await page.locator('.sd-list').innerText().then(s=>s.includes('600.00')),false);await page.keyboard.press('Escape');
   });
  }
  if(runs('settings')) {
   await check('An older local settings commit cannot revert a newer event or theme',async()=>{
    const value=await page.evaluate(async()=>{
     const {KV}=await import('/js/db.js'),{saveSettings}=await import('/js/theme.js');
     const original=KV.update;let release;const gate=new Promise(r=>release=r);
     KV.update=async(...args)=>{await gate;return original.apply(KV,args);};
     try {
      const first=saveSettings(tagdatimer.settings,{immediate:true});
      await tagdatimer.setEvent('777');tagdatimer.setSetting('theme','ice');
      release();await first;
      return {event:tagdatimer.settings.event,theme:tagdatimer.settings.theme};
     }finally{release();KV.update=original;}
    });assert.deepEqual(value,{event:'777',theme:'ice'});
   });
   await check('Rapid event changes settle on the latest selection without page errors',async()=>{
    for(let i=0;i<3;i++) {
     await page.evaluate(async()=>{await Promise.all(['222','444','333fm','333'].map(e=>tagdatimer.setEvent(e)));});
     await page.waitForFunction(()=>tagdatimer.settings.event==='333' && !document.body.classList.contains('fmc') && !!tagdatimer.scramble?.scramble);
    }
    await page.waitForTimeout(500);assert.equal(await page.evaluate(()=>tagdatimer.settings.event),'333');
   });
   await check('Virtual cube keyboard solves work after changing puzzle size',async()=>{
    await page.evaluate(()=>{tagdatimer.setSetting('inspection',false);tagdatimer.setSetting('inputMode','virtual');document.activeElement.blur();});
    await page.waitForFunction(()=>tagdatimer.session.virtual && document.querySelector('#vcube-holder twisty-player'));
    for(const event of ['333','222']) {
     await page.evaluate(e=>tagdatimer.setEvent(e),event);
     await page.evaluate(()=>tagdatimer.setCustomScrambles(['R U']));
     const n=await page.evaluate(()=>tagdatimer.solves.length);
     await page.keyboard.press('KeyF');await page.keyboard.press('KeyK');
     await page.waitForFunction(n=>tagdatimer.solves.length===n+1,n);
     assert.equal(await page.evaluate(()=>tagdatimer.solves.at(-1).scramble),'R U');
     assert.equal(await page.locator('#vcube-holder twisty-player').getAttribute('hint-facelets'),'none');
     assert.equal(await page.locator('#vcube-holder twisty-player').getAttribute('tempo-scale'),'4');
    }
    await page.evaluate(()=>{tagdatimer.clearCustomScrambles();tagdatimer.setSetting('inputMode','timer');});
    await page.waitForFunction(()=>!tagdatimer.session.virtual);
   });
  }
  await check('No unexpected page errors',()=>assert.deepEqual(errors,[]));
 } finally {
  clearTimeout(watchdog);await browser.close();
  await fs.writeFile(`audit-qa/results-${name}-${section}.json`,JSON.stringify(results,null,2));
  await fs.writeFile(`audit-qa/diagnostics-${name}-${section}.json`,JSON.stringify({navigationCancellations},null,2));
 }
 console.log(`${results.filter(r=>r.pass).length}/${results.length} checks passed`);if(results.some(r=>!r.pass))process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1;});
