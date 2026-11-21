import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { Subject } from 'rxjs';
import { JSDOM } from 'jsdom';
import { GyroDiagnostics, GYRO_TEST_MS, GYRO_HOLD_START_MS, relativeQuaternion, orientationMatrix } from '../tools/smart-cube-worker/gyro-test.mjs';
import { applyTurn, validFacelets } from './gan-facelets.js';
import { Carry4State, patchGanCarry4Connection, CARRY4_WAIT_MS } from './gan-carry4.js';
import { SOLVED, SmartStream, turnState, ganCubeInfo } from './smart-cube-core.js';
import { fromFacelets } from './cube3.js';

const { outputFiles } = await build({ entryPoints:['node_modules/gan-web-bluetooth/src/gan-cube-protocol.ts'], bundle:true, write:false, format:'esm', platform:'node' });
const { GanGen4ProtocolDriver } = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));
const fixture = JSON.parse(await readFile(new URL('../tools/fixtures/smart-cube/gan-icarry4.json', import.meta.url)));

// Reconstruct documented Gen4 messages from decoded fields. These are synthetic
// decoder inputs, not a claim that the reports included raw Bluetooth packets.
function packet(event) {
  const bytes = new Uint8Array(20);
  const word = (start, count, value) => {
    for (let i=0; i<count; i++) {
      const bit = start+i, set = value >> (count-1-i) & 1;
      bytes[bit>>3] |= set << (7-(bit&7));
    }
  };
  if (event.type === 'MOVE') {
    bytes[0]=1;bytes[1]=7;
    new DataView(bytes.buffer).setUint32(2, event.cubeTimestamp || 1000, true);
    new DataView(bytes.buffer).setUint16(6, event.serial, true);
    const face = 'URFDLB'.indexOf(event.move[0]);
    word(64,2,event.move.endsWith("'")?1:0);word(66,6,[2,32,8,1,16,4][face]);
  } else {
    bytes[0]=0xED;bytes[1]=14;
    new DataView(bytes.buffer).setUint16(2,event.serial ?? 0,true);
    const cubies = fromFacelets(event.facelets);
    const s = event.state || {CP:[...cubies.slice(0,8)],CO:[...cubies.slice(8,16)],EP:[...cubies.slice(16,28)],EO:[...cubies.slice(28)]};
    for(let i=0;i<7;i++){word(32+i*3,3,s.CP[i]);word(53+i*2,2,s.CO[i]);}
    for(let i=0;i<11;i++){word(69+i*4,4,s.EP[i]);word(113+i,1,s.EO[i]);}
  }
  return bytes;
}
function connection(name='GANic4_TEST') {
  const events = [], writes = [];
  let reportTime = null;
  let disconnected=0;
  const conn={ deviceName:name, driver:new GanGen4ProtocolDriver(), events$:new Subject(),
    async sendCommandMessage(message){writes.push([...message]);},
    async disconnect(){disconnected++;this.events$.next({type:'DISCONNECT'});}
  };
  conn.events$.subscribe(e=>events.push(e));
  patchGanCarry4Connection(conn,{clock:()=>reportTime ?? performance.now(),schedule:()=>0,cancel:()=>{}});
  return { conn, events, writes, get disconnected(){return disconnected;},
    async send(e){ reportTime=e.at ?? null;const result=await conn.driver.handleStateEvent(conn,packet(e));for(const event of result)conn.events$.next(event); },
    cleanup(){conn.events$.next({type:'DISCONNECT'});}
  };
}

test('only actual GANic4 advertisements receive this adapter and model label',()=>{
  for(const name of ['GANi4_TEST','GANicE2_TEST','GAN12uiM']){
    const value={deviceName:name};assert.equal(patchGanCarry4Connection(value),value);
  }
  assert.equal(ganCubeInfo({},'GANic4_D48A').name,'GAN i Carry 4');
  assert.equal(ganCubeInfo({},'GANi4_D48A').name,'GAN i4');
});

test('Gen4 decoder bootstraps at the first live counter, verifies state, and reconnects at high counters',async()=>{
  for(const serial of [4,199,255,256,700]){
    const c=connection();
    try {
      await c.send({type:'FACELETS',serial:0,facelets:SOLVED});
      await c.send({type:'MOVE',serial,move:'R'});
      assert.equal(c.events.filter(e=>e.type==='MOVE').length,0,'no timing before independent state verification');
      await c.send({type:'FACELETS',serial:0,facelets:turnState(SOLVED,'R')});
      const moves=c.events.filter(e=>e.type==='MOVE');
      assert.equal(moves.length,1);assert.equal(moves[0].serial,serial&255);
      assert.equal(c.writes.length,0,'never request pre-connection history from zero');
      assert.equal(c.events.filter(e=>e.type==='FACELETS').at(-1).serial,serial&255);
      assert.equal(c.events.filter(e=>e.type==='FACELETS').at(-1).originalSerial,0);
    } finally {c.cleanup();}
  }
});

test('zero-counter snapshots cannot provoke false recovery and buffer disconnects during long turning',async()=>{
  const c=connection();let state=SOLVED;
  try {
    await c.send({type:'FACELETS',facelets:state});
    for(let serial=200;serial<800;serial++){
      const move=serial%2?'R\'':'R';state=turnState(state,move);
      await c.send({type:'MOVE',serial,move});
      await c.send({type:'FACELETS',facelets:state});
    }
    assert.equal(c.events.filter(e=>e.type==='MOVE').length,600);
    assert.equal(c.events.filter(e=>e.type==='STATE_UNCERTAIN').length,0);
    assert.equal(c.disconnected,0);assert.equal(c.writes.length,0);
  } finally {c.cleanup();}
});

test('real lost turns still request move history after the bootstrap',async()=>{
  const c=connection();
  try{
    await c.send({type:'FACELETS',facelets:SOLVED});
    await c.send({type:'MOVE',serial:4,move:'R'});
    await c.send({type:'FACELETS',facelets:turnState(SOLVED,'R')});
    await c.send({type:'MOVE',serial:6,move:'U'});
    assert.equal(c.writes.at(-1)[0],0xD1);
    assert.equal(c.events.filter(e=>e.type==='MOVE').length,1,'unrecovered turns cannot fabricate a solve');
    // Gen4 history packs two turns per byte, newest first, with odd alignment.
    const history=new Uint8Array(20);history.set([0xD1,2,5,0xA0]); // serial 5 U', serial 4 D
    // U' followed by U returns the cube to its pre-gap state; both must survive.
    const recovered=await c.conn.driver.handleStateEvent(c.conn,history);
    for(const e of recovered)c.conn.events$.next(e);
    assert.deepEqual(c.events.filter(e=>e.type==='MOVE').map(e=>e.serial),[4,5,6]);
    assert.equal(c.events.find(e=>e.type==='MOVE'&&e.serial===5).localTimestamp,null);
  }finally{c.cleanup();}
});

test('the real test-page UI completes two T-perms on the final F\' and saves the adapter evidence',async()=>{
  const html=await readFile(new URL('../tools/smart-cube-worker/public/index.html',import.meta.url),'utf8');
  const source=(await readFile(new URL('../tools/smart-cube-worker/app.mjs',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'');
  const dom=new JSDOM(html,{url:'https://example.test/smart-cube',runScripts:'outside-only',pretendToBeVisual:true});
  const {window}=dom,c=connection();let physical=SOLVED,serial=3,stored=null;
  c.conn.deviceMAC='local-only-address';
  c.conn.sendCubeCommand=async({type})=>{
    if(type==='REQUEST_FACELETS')await c.send({type:'FACELETS',serial:0,facelets:physical});
    if(type==='REQUEST_HARDWARE')c.conn.events$.next({type:'HARDWARE',hardwareName:'GANic4',softwareVersion:'1.0',gyroSupported:false});
  };
  c.conn.disconnect=async()=>{c.cleanup();};
  window.__deps={connectGanCube:async()=>c.conn,cubeTimestampLinearFit:moves=>moves.map((m,i)=>({...m,cubeTimestamp:i*200})),SOLVED,applyTurn,validFacelets,GyroDiagnostics,GYRO_TEST_MS,GYRO_HOLD_START_MS,relativeQuaternion,orientationMatrix};
  Object.defineProperty(window.navigator,'bluetooth',{value:{}});window.isSecureContext=true;
  window.setInterval=()=>0;window.AbortSignal=AbortSignal;
  window.fetch=async(path,options)=>{
    if(path.endsWith('/sessions'))return Response.json({id:'1'.repeat(32),token:'test',expiresAt:Date.now()+604800000});
    if(options?.method==='PUT')stored=JSON.parse(options.body);
    return Response.json({eventCount:stored?.events.length||0,savedAt:Date.now()});
  };
  const settle=async()=>{for(let i=0;i<5;i++)await new Promise(r=>setTimeout(r,10));};
  const click=id=>window.document.getElementById(id).click();
  async function turn(move){physical=turnState(physical,move);await c.send({type:'MOVE',serial:++serial,move,cubeTimestamp:1000+serial*200});await c.send({type:'FACELETS',serial:0,facelets:physical});}
  try{
    window.eval(`const {connectGanCube,cubeTimestampLinearFit,SOLVED,applyTurn,validFacelets,GyroDiagnostics,GYRO_TEST_MS,GYRO_HOLD_START_MS,relativeQuaternion,orientationMatrix}=window.__deps;\n${source}`);
    click('connect');await settle();
    assert.equal(window.document.getElementById('arm').disabled,true);
    await turn('R');await turn("R'");await settle();
    assert.match(window.document.getElementById('cube-state').textContent,/Solved/);
    const tperm="R U R' U' R' F R R U' R' U' R U R' F'".split(' ');
    for(const move of tperm)await turn(move);
    await settle();click('arm');
    for(const move of tperm)await turn(move);
    await settle();click('upload');await settle();
    assert.equal(stored.solves.length,1);assert.equal(stored.solves[0].status,'complete');
    assert.equal(stored.solves[0].moves.length,15);assert.equal(stored.solves[0].moves.at(-1).move,"F'");
    assert.equal(window.document.getElementById('timer-status').textContent,'Solved');
    assert.match(window.document.getElementById('cube-state').textContent,/Solved/);
    assert.equal(stored.events.filter(e=>e.type==='SEQUENCE_GAP').length,0);
    assert.ok(stored.events.some(e=>e.snapshotSequence==='inferred-from-state'&&e.originalSerial===0));
    assert.equal(JSON.stringify(stored).includes(c.conn.deviceMAC),false);
  }finally{c.cleanup();await settle();dom.window.close();}
});

test('ahead snapshots await turns, while contradictions have a fixed deadline and interrupt the stream',()=>{
  const events=[], issues=[];
  const state=new Carry4State(e=>events.push(e),{schedule:()=>0,cancel:()=>{}});
  state.accept({type:'FACELETS',serial:0,facelets:SOLVED},0);
  state.accept({type:'MOVE',serial:4,move:'R',cubeTimestamp:1,localTimestamp:1},1);
  state.accept({type:'FACELETS',serial:0,facelets:turnState(SOLVED,'R')},2);
  const ahead=turnState(turnState(SOLVED,'R'),'U');
  state.accept({type:'FACELETS',serial:0,facelets:ahead},10);
  state.accept({type:'MOVE',serial:5,move:'U',cubeTimestamp:2,localTimestamp:2},100);
  assert.equal(events.at(-1).facelets,ahead);assert.equal(events.at(-1).serial,5);
  state.accept({type:'FACELETS',serial:0,facelets:turnState(SOLVED,'F')},200);
  const published=events.filter(e=>e.type==='MOVE').length;
  state.accept({type:'MOVE',serial:6,move:"U'",cubeTimestamp:3,localTimestamp:3},250);
  state.accept({type:'MOVE',serial:7,move:"R'",cubeTimestamp:4,localTimestamp:4},300);
  assert.equal(events.filter(e=>e.type==='MOVE').length,published,'a solved turn cannot finish during a state contradiction');
  state.accept({type:'FACELETS',serial:0,facelets:turnState(SOLVED,'F')},200+CARRY4_WAIT_MS-1);
  state.expire(200+CARRY4_WAIT_MS);
  assert.equal(events.at(-1).type,'STATE_UNCERTAIN');
  const main=new SmartStream({epoch:1,onIssue:r=>issues.push(r)});
  main.ingest({type:'FACELETS',serial:4,facelets:SOLVED},0);
  main.ingest(events.at(-1),5000);
  assert.equal(main.state,null);assert.deepEqual(issues,['Cube state mismatch']);
});

test('all ten hardware reports exercise the adapter; the T-perm solves on F\' without an extra U',async()=>{
  let moves=0,snapshots=0,tperm=false;
  for(const session of fixture.sessions){
    let c=connection();
    try{
      for(const event of session.events){
        if(event.type==='CONNECTED'){c.cleanup();c=connection();}
        if(event.type==='DISCONNECT'){c.cleanup();continue;}
        if(event.type==='MOVE'){
          moves++;
          // Recovered notifications are driver outputs, not new radio moves.
          if(event.localTimestamp!=null&&event.cubeTimestamp!=null)await c.send(event);
        }
        if(event.type==='FACELETS'){snapshots++;await c.send(event);}
        if(session.reportId==='0c52542a4fbf4371991893959dfc2120'&&event.type==='MOVE'&&event.serial===33){
          let facelets=null;
          for(const output of c.events){
            if(output.type==='FACELETS')facelets=output.facelets;
            if(output.type==='MOVE')facelets=turnState(facelets,output.move);
          }
          assert.equal(facelets,SOLVED);tperm=true;
          assert.equal(c.events.filter(e=>e.type==='MOVE'&&e.serial<=3).length,0);
        }
      }
    }finally{c.cleanup();}
  }
  assert.equal(moves,651);assert.equal(snapshots,1614);assert.equal(tperm,true);
});
