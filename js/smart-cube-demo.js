// Loaded only by the localhost-only demo entry in main.js. Real Bluetooth is
// replaced at the controller boundary; capture, timer, storage and review are real.
import { SOLVED, turnState } from './smart-cube-core.js';
import { makeDemoScenario, makeSampleCapture } from './smart-cube-demo-fixture.js';
import { generate } from './scramble.js';
import { cubeTimestampLinearFit } from '../vendor/gan/gan-3.0.2.js';

export async function mountSmartCubeDemo({app,loadSmartCube,showScramble}) {
  if(!['localhost','127.0.0.1'].includes(location.hostname))return;
  document.title='Tagda Timer · simulated smart cube';
  let busy=false,generation=0,lastSolve=null,facelets=SOLVED,serial=0;
  let scenario = makeDemoScenario((await generate('333', 'wca')).scramble);
  const listeners=new Set();
  const emit=e=>{for(const fn of [...listeners])fn(e);};
  const publish=text=>{
    window.parent.postMessage({type:'smart-cube-demo-status',text,busy,ready:!!lastSolve},location.origin);
  };
  const device = {
    deviceName:'Simulated GAN · demo',
    events$:{subscribe(fn){listeners.add(fn);return {unsubscribe:()=>listeners.delete(fn)};}},
    async sendCubeCommand({type}) {
      if(type==='REQUEST_FACELETS')emit({type:'FACELETS',serial,facelets});
      if(type==='REQUEST_BATTERY')emit({type:'BATTERY',batteryLevel:87});
      if(type==='REQUEST_HARDWARE')emit({type:'HARDWARE',hardwareName:'Simulated GAN',softwareVersion:'demo'});
      if(type==='REQUEST_RESET'){facelets=SOLVED;emit({type:'FACELETS',serial,facelets});}
    },
    async disconnect(){},
  };
  const turn=(move,clock=performance.now())=>{
    facelets=turnState(facelets,move);
    emit({type:'MOVE',move,serial:++serial%256,cubeTimestamp:clock,localTimestamp:clock+1000,simulated:true});
    if(serial%8===0)emit({type:'FACELETS',serial:serial%256,facelets});
  };
  for(const [key,value] of Object.entries({inspection:true,callouts:'off',confirmShortSolves:false,soundOnPB:false,focusMode:false}))await app.setSetting(key,value);
  await app.setSetting('inputMode','smart');
  const controller=await loadSmartCube();
  const save=controller.save;
  controller.save=async capture=>{
    capture.simulated=true;capture.timingQuality='simulated';capture.ownerUid=null;
    capture.analysisConfig=structuredClone(scenario.analysisConfig);
    capture.annotations=structuredClone(scenario.annotations.filter(note => note.endIndex < capture.moves.length));
    await save(capture);lastSolve=app.solves.find(s=>s.id===capture.id);
    if(!busy&&window.smartCubeDemo)publish('Example ready. Watch a solve, or open the saved analysis.');
  };
  controller.protocol={connectGanCube:()=>Promise.resolve(device),cubeTimestampLinearFit};
  controller.connectionState='disconnected';controller.render();
  const scramble=()=>showScramble({scramble:scenario.scramble,caseId:null,caseName:null});
  const wait=(ms,token)=>new Promise(resolve=>setTimeout(()=>resolve(token===generation),Math.max(0,ms)));
  const run=async({withMistake=false}={})=>{
    if(busy)return;
    const token=++generation;busy=true;publish('Connecting a simulated GAN cube…');
    try {
      document.querySelector('.smart-analysis[open]')?.close();
      if(app.settings.event!=='333')await app.setEvent('333');
      if(app.settings.mode!=='wca')await app.setMode('wca');
      await app.setSetting('inspection',true);await app.setSetting('inputMode','smart');
      scenario = makeDemoScenario((await generate('333', 'wca')).scramble);
      if (token !== generation) return;
      await controller.disconnect();facelets=SOLVED;serial=0;scramble();controller.sync();
      await controller.connect();
      for(const [i,move]of scenario.preparation.entries()) {
        if(!await wait(75,token))return;
        publish(`Applying the scramble · ${i+1}/${scenario.preparation.length} turns`);turn(move);
        if (withMistake && i === 4) {
          const wrongTurn = [...'BLDFRU'].find(face => !controller.guide.positions.has(turnState(facelets, face)));
          turn(wrongTurn);
          publish('Wrong turn inserted. Follow the highlighted correction under the cube.');
          if (!await wait(2600, token)) return;
          while (controller.guide.corrections.length) {
            const correction = controller.guide.corrections[0];
            turn(correction);
            if (!await wait(650, token)) return;
          }
          publish('Correction complete. The green scramble progress is preserved.');
          if (!await wait(900, token)) return;
        }
      }
      if(controller.attemptState!=='scramble matched')throw new Error('Demo scramble did not match');
      publish('Scramble verified. Starting inspection…');controller.inspect();
      if(!await wait(1500,token))return;
      const start=performance.now();
      for(const [i,m]of scenario.moves.entries()) {
        if(!await wait(start+m.timeMs-performance.now(),token))return;
        publish(`Solving · move ${i+1}/${scenario.moves.length}`);turn(m.move,10000+m.timeMs);
      }
      emit({type:'FACELETS',serial:serial%256,facelets});
      await controller.saveTask;
      if(token===generation){busy=false;publish('Solve saved. Click its time or open analysis.');}
    } catch(e) {if(token===generation){busy=false;publish(`Demo paused: ${e.message}`);}}
  };
  const stop=()=>{
    ++generation;busy=false;controller.interrupt('Simulation stopped by user');publish('Simulation stopped. You can run it again or review the sample.');
  };
  const review=()=>{if(lastSolve)void app.openSmartAnalysis(lastSolve);};
  window.addEventListener('message',e=>{
    if(e.origin!==location.origin||e.source!==window.parent)return;
    if(e.data?.type==='smart-cube-demo-run')void run();
    if(e.data?.type==='smart-cube-demo-mistake')void run({withMistake:true});
    if(e.data?.type==='smart-cube-demo-stop')stop();
    if(e.data?.type==='smart-cube-demo-review')review();
  });
  // One instant example makes the UI explorable without waiting for playback.
  const existing=app.solves.findLast(s=>s.smartCube?.source==='simulation'&&s.smartCube.completeness==='complete'&&s.scramble?.includes('2')&&s.scramble.trim().split(/\s+/).length<=30);
  if(existing)lastSolve=existing;
  else await controller.save(makeSampleCapture(app.session.id,cubeTimestampLinearFit,scenario));
  facelets=SOLVED;serial=0;scramble();controller.sync();await controller.connect();
  publish('Example ready. Watch a solve, or open the saved analysis.');
  window.smartCubeDemo={run,stop,review,controller,get lastSolve(){return lastSolve;},get scenario(){return scenario;}};
}
