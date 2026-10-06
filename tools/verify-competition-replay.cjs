// Disposable browser data only. Start serve.py, then run this check with Playwright available.
const assert=require('node:assert/strict');
const{chromium}=require(process.env.TAGDA_PLAYWRIGHT_PATH || 'playwright');
(async()=>{const b=await chromium.launch({headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
async function boot(p){await p.goto('http://localhost:5184');await p.waitForFunction(()=>tagdatimer?.scramble?.scramble);}
async function start(p,mode='none'){await p.evaluate(()=>tagdatimer.openCompetition());await p.locator('#competition-recording').selectOption(mode);await p.getByRole('button',{name:'Start Ao5',exact:true}).click();await p.waitForFunction(()=>!document.querySelector('dialog.competition-dialog'));}
for(const scenario of ['duration','bytes','quota','disconnect','hidden']){
 const c=await b.newContext();const p=await c.newPage();const errors=[];p.on('pageerror',e=>errors.push(e.message));await boot(p);
 await p.evaluate(async scenario=>{
  const{SET_REPLAY_LIMITS}=await import('/js/competition-replay.js');
  if(scenario==='duration')SET_REPLAY_LIMITS.durationMs=800;
  if(scenario==='bytes')SET_REPLAY_LIMITS.bytes=4096;
  if(scenario==='quota'){
   const factory=indexedDB.open.bind(indexedDB);indexedDB.open=(...args)=>{const q=factory(...args);q.addEventListener('success',()=>{const d=q.result;if(d.name==='tagdatimer-competition-media'){const transaction=d.transaction.bind(d);d.transaction=(...aa)=>{const tr=transaction(...aa);const os=tr.objectStore.bind(tr);tr.objectStore=n=>{const store=os(n);if(n==='chunks')store.put=()=>{throw new DOMException('quota test','QuotaExceededError');};return store;};return tr;};}});return q;};
  }
  if(scenario==='disconnect'){const gum=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=async constraints=>{const stream=await gum(constraints);window.qaStream=stream;return stream;};}
 },scenario);
 await start(p,'whole-set');
 if(scenario==='disconnect')await p.evaluate(()=>qaStream.getVideoTracks()[0].dispatchEvent(new Event('ended')));
 if(scenario==='hidden')await p.evaluate(()=>{Object.defineProperty(document,'hidden',{value:true,configurable:true});document.dispatchEvent(new Event('visibilitychange'));});
 await p.waitForTimeout(scenario==='quota'||scenario==='bytes'?2600:1500);
 const state=await p.evaluate(async()=>{const{CompetitionSets}=await import('/js/db.js');return (await CompetitionSets.all()).find(x=>x.status==='active');});
 assert.equal(state.replayStatus,'interrupted',scenario);
 await p.evaluate(()=>tagdatimer.recordSolve({timeMs:14000}));
 assert.equal(await p.evaluate(()=>tagdatimer.solves.length),1);
 assert.equal(errors.length,0);console.log(scenario,state.replayStatus,state.replayReason);await c.close();
}
const c=await b.newContext();const p=await c.newPage();await boot(p);await p.evaluate(()=>{window.requests=0;navigator.mediaDevices.getUserMedia=async()=>{requests++;throw new DOMException('denied','NotAllowedError');};});await p.evaluate(()=>tagdatimer.openCompetition());assert.equal(await p.evaluate(()=>requests),0);await p.locator('#competition-recording').selectOption('whole-set');await p.getByRole('button',{name:'Start Ao5',exact:true}).click();await p.waitForTimeout(500);assert.match(await p.locator('.competition-error').innerText(),/Camera unavailable/);await p.getByRole('button',{name:'Start Ao5',exact:true}).click();await p.waitForFunction(()=>!document.querySelector('dialog.competition-dialog'));await p.evaluate(()=>tagdatimer.recordSolve({timeMs:13000}));assert.equal(await p.evaluate(()=>tagdatimer.solves.length),1);console.log('denied permission: timing continues; setup requests zero cameras');await c.close();await b.close();})().catch(e=>{console.error(e);process.exit(1)});
