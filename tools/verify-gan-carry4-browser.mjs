import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

const fixture = JSON.parse(await readFile(new URL('./fixtures/smart-cube/gan-icarry4-raw.json', import.meta.url)));
const { outputFiles } = await build({
  stdin: { contents: `
    import { GanGen4ProtocolDriver } from './node_modules/gan-web-bluetooth/src/gan-cube-protocol.ts';
    import { patchGanCarry4Connection } from './js/gan-carry4.js';
    import { turnState, SOLVED, SmartStream } from './js/smart-cube-core.js';
    import { Subject } from 'rxjs';
    window.replayCarry4 = async sessions => {
      const results = [];
      for (const session of sessions) {
        let clock=0, conn, state, events=[], errors=[], writes=0, disconnects=0, snapshots=0, moves=0;
        function open() {
          state = new SmartStream({epoch:1,onIssue:r=>errors.push(r)});
          conn = {deviceName:'GANic4_TEST',driver:new GanGen4ProtocolDriver(),events$:new Subject(),
            async sendCommandMessage() {writes++;},
            async disconnect(){disconnects++;this.events$.next({type:'DISCONNECT'});}
          };
          conn.events$.subscribe(e=>{
            events.push(e);
            if(e.type==='FACELETS')snapshots++;
            if(e.type==='MOVE')moves++;
            if(['FACELETS','MOVE','STATE_UNCERTAIN'].includes(e.type))state.ingest(e,clock);
          });
          // Keep native Chrome timers: replacing them with Node or fake timers
          // would miss the receiver-binding failure that broke the real retest.
          patchGanCarry4Connection(conn,{clock:()=>clock,diagnostics:true});
        }
        for (const event of session.events) {
          clock=event.at;
          if(event.type==='CONNECTED') {conn?.events$.next({type:'DISCONNECT'});open();}
          if(event.type==='DISCONNECT')conn?.events$.next({type:'DISCONNECT'});
          if(event.bytes){
            const output=await conn.driver.handleStateEvent(conn,new Uint8Array(event.bytes));
            for(const decoded of output)conn.events$.next(decoded);
          }
        }
        conn?.events$.next({type:'DISCONNECT'});
        const hardware=events.filter(e=>e.type==='HARDWARE').at(-1);
        const moveEvents=events.filter(e=>e.type==='MOVE');
        const lastState=events.filter(e=>e.type==='FACELETS').at(-1)?.facelets;
        results.push({id:session.reportId,moves,snapshots,errors,writes,disconnects,
          hardware:hardware?.hardwareName,firmware:hardware?.softwareVersion,
          uncertain:events.filter(e=>e.type==='STATE_UNCERTAIN').length,
          originalCounters:[...new Set(events.filter(e=>e.type==='FACELETS').map(e=>e.originalSerial))],
          finalFacelets:lastState,finalSolved:lastState===SOLVED,
          sequences:moveEvents.map(e=>e.serial)});
      }
      return results;
    };
  `, resolveDir:process.cwd(), loader:'js' },
  bundle:true,write:false,format:'iife',platform:'browser',minify:true,
  // The fixture harness uses the main cube engine; translations are irrelevant.
  plugins:[{name:'test-translations',setup(b){b.onLoad({filter:/[/\\]js[/\\]i18n\.js$/},()=>({contents:'export const t=x=>x;',loader:'js'}));}}],
});

const browser=await chromium.launch({headless:true});
try {
  const page=await browser.newPage();
  const browserErrors=[];page.on('pageerror',e=>browserErrors.push(e.message));
  await page.addScriptTag({content:outputFiles[0].text});
  const results=await page.evaluate(sessions=>window.replayCarry4(sessions),fixture.sessions);
  console.log(JSON.stringify(results));
  assert.deepEqual(results.map(r=>r.moves),[6,14,20]);
  assert.ok(results.every(r=>r.hardware==='GANic4'&&r.firmware==='1.0'));
  assert.ok(results.every(r=>r.snapshots>0&&r.uncertain===0&&r.disconnects===0&&r.errors.length===0&&r.writes===0));
  assert.ok(results.every(r=>JSON.stringify(r.originalCounters)==='[0]'));
  assert.deepEqual(browserErrors,[]);
  console.log('PASS: all 40 real i Carry 4 turn packets, matching states, hardware info, native Chrome timers, and no invented history/disconnects');
} finally {await browser.close();}
