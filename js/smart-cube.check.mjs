import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { JSDOM } from 'jsdom';
import { indexedDB, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';
import { SOLVED, turnState, scrambleState, SmartStream, timeline, qtm, phases, rangeStats, tpsWindows, validateCapture, checkpoints, seekState, mergeCaptureEdits } from './smart-cube-core.js';
import { fromFacelets, facelets, SOLVED as CUBE_SOLVED, applyAlg } from './cube3.js';
import { faceletsFor } from './cubenet.js';
import { cubeTimestampLinearFit } from '../vendor/gan/gan-3.0.2.js';

const inverse = alg => alg.trim().split(/\s+/).reverse().map(m=>m.endsWith('2')?m:m.endsWith("'")?m[0]:m+"'").join(' ');
const makeCapture = (alg = 'R U F', options = {}) => {
  const moves = inverse(alg).split(' ').map((move,index)=>({move,serial:index,epoch:1,cubeTimestamp:1000+index*100,localTimestamp:2000+index*100,receivedMonotonic:2000+index*100}));
  return {id:'capture',solveId:'capture',schemaVersion:1,initialFacelets:scrambleState(alg),scrambleVerified:true,completeness:'complete',annotations:[],qualityIssues:[],context:{sessionId:'s',scramble:alg},connections:[{epoch:1}],analysisConfig:{profile:'cfop'}, ...timeline(moves,cubeTimestampLinearFit),...options};
};
test('URFDLB decoder, all turn amounts, scrambled states, long simulator parity', () => {
  let alg = '', f = SOLVED;
  for (let i=0;i<180;i++) {
    const move = 'URFDLB'[i*7%6]+['',"'",'2'][Math.floor(i/6)%3]; alg += ' '+move; f=turnState(f,move);
    const expected=faceletsFor(alg,3);
    assert.equal(f,[...'URFDLB'].flatMap(face=>expected[face].flat()).join(''));
    assert.equal(facelets(fromFacelets(f)).join(''),f);
  }
  assert.equal(turnState(scrambleState('R'),"R'"),SOLVED);
  assert.throws(()=>fromFacelets('U'.repeat(54)));
  const invalid=[...SOLVED]; [invalid[5],invalid[10]]=[invalid[10],invalid[5]]; assert.throws(()=>fromFacelets(invalid));
});
test('production browser clock fitter preserves evidence, pauses and fallback quality', () => {
  const c=makeCapture(); const copy=structuredClone(c.moves); const fit=timeline(c.moves,cubeTimestampLinearFit);
  assert.deepEqual(c.moves,copy); assert.equal(fit.timingMethod,'cube-clock-fit'); assert.equal(fit.measuredDurationMs,200);
  for (const patch of [{cubeTimestamp:null},{cubeTimestamp:-100},{localTimestamp:null},{cubeTimestamp:1000}]) {
    const raw=structuredClone(c.moves); Object.assign(raw[1],patch); assert.equal(timeline(raw,cubeTimestampLinearFit).timingQuality,'estimated');
  }
  const paused=makeCapture();paused.moves[2].timeMs=3200;paused.measuredDurationMs=3200;
  assert.equal(rangeStats(paused,1,2).spanMs,3100);assert.equal(rangeStats(paused,1,2).entryGapMs,100);
  assert.equal(rangeStats(paused,1,1).tps,null);
  assert.ok(tpsWindows(paused).some(w=>w.atMs===2000&&w.tps===0));
  assert.equal(qtm([{move:'R'},{move:"R'"},{move:'U2'}]),4);
});
test('sequence wrapping, duplicate provenance, late snapshots, gaps and epochs', () => {
  const accepted=[],issues=[]; const s=new SmartStream({epoch:1,onMove:m=>accepted.push(m),onIssue:r=>issues.push(r)});
  s.ingest({type:'MOVE',serial:254,move:'R'},1);assert.equal(s.state,null);
  s.ingest({type:'FACELETS',serial:254,facelets:SOLVED},2);
  s.ingest({type:'MOVE',serial:255,move:'R'},3);s.ingest({type:'MOVE',serial:255,move:'R'},4);
  s.ingest({type:'MOVE',serial:0,move:'U'},5);
  s.ingest({type:'FACELETS',serial:255,facelets:scrambleState('R')},6);
  assert.equal(s.state,scrambleState('R U'));assert.equal(accepted.length,2);assert.equal(s.raw.filter(e=>e.type==='MOVE').length,4);
  s.ingest({type:'MOVE',serial:2,move:'F'},7);assert.equal(s.state,null);assert.equal(issues.length,1);
  const fresh=new SmartStream({epoch:2});fresh.ingest({type:'FACELETS',serial:0,facelets:scrambleState('F')},8);assert.equal(fresh.state,scrambleState('F'));
});
test('200 complete captures validate and deterministic bounded seeks match the original engine', () => {
  for(let n=0;n<200;n++) {
    const alg=Array.from({length:30},(_,i)=>'URFDLB'[(i+n)%6]+['',"'",'2'][(n+i)%3]).join(' '),c=makeCapture(alg),points=checkpoints(c);
    validateCapture(c);
    let state=c.initialFacelets;
    assert.equal(seekState(c,-1,points),state);
    c.moves.forEach((m,i)=>{state=turnState(state,m.move);assert.equal(seekState(c,i,points),state);});
    assert.equal(state,SOLVED);assert.equal(phases(c).reduce((sum,p)=>sum+p.durationMs,0),c.measuredDurationMs);
  }
  const c=makeCapture();c.moves.push({move:'U',timeMs:300});c.measuredDurationMs=300;assert.throws(()=>validateCapture(c));
  assert.deepEqual(phases(makeCapture('R U F',{analysisConfig:{profile:'unknown'}})),[]);
  const skip=phases(makeCapture('U'));assert.equal(skip[0].durationMs,0);
  for(const f of 'URFDLB')assert.equal(phases(makeCapture(),f).reduce((s,p)=>s+p.durationMs,0),200);
});

test('atomic capture + solve, failed-write recovery, native backup, annotation and deletion',async()=> {
  const dom=new JSDOM('',{url:'https://localhost'});globalThis.localStorage=dom.window.localStorage;globalThis.window=dom.window;globalThis.indexedDB=indexedDB;globalThis.IDBKeyRange=IDBKeyRange;
  const db=await import('./db.js'),capture=makeCapture(),solve={id:capture.id,sessionId:'s',event:'333',timeMs:200,createdAt:Date.now(),smartCube:{captureId:capture.id}};
  await db.Sessions.put({id:'s',createdAt:Date.now(),event:'333'});
  let writes=0;db.onWrite('smartCube',()=>writes++);
  const original=IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put=function(value,...args){const req=original.call(this,value,...args);if(this.name==='smartCubeCaptures')req.addEventListener('success',()=>this.transaction.abort());return req;};
  await assert.rejects(db.Solves.put(solve,capture));assert.equal(writes,0);
  assert.equal(await db.wrap((await db.tx('solves')).get(solve.id)),undefined);
  assert.equal(await db.wrap((await db.tx('smartCubeCaptures')).get(solve.id)),undefined);
  assert.equal((await db.SmartCaptures.get(solve.id)).moves.length,3);
  assert.equal(db.exportRecovery().smartCubeCaptures.length,1);
  IDBObjectStore.prototype.put=original;await db.retryLocalWrites();assert.equal(writes,1);assert.equal(db.getLocalStatus().unsaved,0);
  const annotated=await db.SmartCaptures.annotate(solve.id,{annotations:[{label:'test',startIndex:0,endIndex:1}]});assert.equal(annotated.revision,1);assert.deepEqual(annotated.moves,capture.moves);
  const backup=await db.exportAll();assert.equal(backup.smartCubeCaptures.length,1);
  await db.importAll(backup,{merge:false});assert.equal((await db.SmartCaptures.get(solve.id)).annotations[0].label,'test');
  await db.Solves.del(solve.id);assert.equal(await db.SmartCaptures.get(solve.id),undefined);assert.equal(await db.Tombstones.has('solves',solve.id),true);
  await assert.rejects(db.importAll({...backup,smartCubeCaptures:[]}));
  dom.window.close();
});


test('annotation conflicts merge without modifying original evidence; exact PLL suffixes establish additive boundaries', async()=> {
  const a=makeCapture(),b=structuredClone(a);a.annotations=[{id:'a',label:'a'}];b.annotations=[{id:'b',label:'b'}];a.revision=b.revision=1;
  const merged=mergeCaptureEdits(a,b);assert.equal(merged.annotations.length,2);assert.equal(merged.revision,2);assert.deepEqual(merged.moves,a.moves);
  b.moves[0].localTimestamp=99;assert.throws(()=>mergeCaptureEdits(a,b));
  const {lastLayerLandmarks}=await import('./smart-cube-algorithms.js');
  const alg="R U R' U' R' F R2 U' R' U' R U R' F'",c=makeCapture(inverse(alg));
  c.analysisConfig={profile:'cfop',crossFace:'D'};
  const landmarks=lastLayerLandmarks(c);assert.equal(landmarks.PLL?.startIndex,0);assert.ok(landmarks.PLL.caseIds.includes('T'));
  c.analysisConfig.lastLayerLandmarks=landmarks;
  const rows=phases(c);assert.equal(rows[0].durationMs,0);assert.equal(rows[1].durationMs,0);assert.equal(rows[2].durationMs,0);assert.equal(rows[3].durationMs,c.measuredDurationMs);
});


test('scramble guidance follows half turns in either direction and undoes wrong turns', async () => {
  const { ScrambleGuide } = await import('./smart-cube-scramble.js');
  const guide = new ScrambleGuide("R U2 F' D2");
  let state = SOLVED;
  guide.synchronize(state);
  const move = turn => {
    const before = state;
    state = turnState(state, turn);
    guide.observe(turn, before, state);
  };
  move('R');
  assert.equal(guide.completed, 1);
  move("U'");
  assert.equal(guide.partial, true);
  assert.equal(guide.nextTurn, "U'");
  assert.deepEqual(guide.corrections, []);
  move("U'");
  assert.equal(guide.completed, 2);
  move('B');
  move('L');
  assert.deepEqual(guide.corrections, ["L'", "B'"]);
  move("L'");
  assert.deepEqual(guide.corrections, ["B'"]);
  move("B'");
  assert.equal(guide.completed, 2);
  assert.deepEqual(guide.corrections, []);
  move("F'");
  move('D');
  assert.equal(guide.partial, true);
  move('D');
  assert.equal(guide.matched, true);
  assert.equal(guide.completed, 4);
});

test('every correction restores a real scramble prefix and unknown snapshots reset the route', async () => {
  const { ScrambleGuide } = await import('./smart-cube-scramble.js');
  const prefix = scrambleState('R U');
  for (const turns of ['F', "F R U B L D", "F F", "B L R U2 D' F2"]) {
    const guide = new ScrambleGuide('R U F2 L D');
    guide.synchronize(prefix);
    let state = prefix;
    for (const turn of turns.split(' ')) {
      const after = turnState(state, turn);
      guide.observe(turn, state, after);
      state = after;
    }
    for (const correction of guide.corrections) state = turnState(state, correction);
    assert.ok(guide.positions.has(state));
  }
  const guide = new ScrambleGuide('R U F2');
  guide.synchronize(scrambleState('L B D'));
  assert.equal(guide.anchored, false);
  assert.deepEqual(guide.corrections, []);
  guide.synchronize(SOLVED);
  assert.equal(guide.anchored, true);
  assert.equal(guide.completed, 0);
  const recovery = new ScrambleGuide("D' B' L'", scrambleState('L B D'));
  assert.equal(recovery.target, SOLVED);
});

test('completed scramble tokens are green without changing copied notation', async () => {
  const { ScrambleGuide, highlightScramble } = await import('./smart-cube-scramble.js');
  const dom = new JSDOM('<p id="scramble">R U2 F</p>');
  const originalDocument = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const host = document.getElementById('scramble');
    const guide = new ScrambleGuide('R U2 F');
    guide.synchronize(scrambleState('R U'));
    highlightScramble(host, guide, true);
    assert.equal(host.textContent, 'R U2 F');
    assert.equal(host.querySelectorAll('.is-done').length, 1);
    assert.equal(host.querySelector('.is-partial').textContent, 'U2');
    highlightScramble(host, guide, false);
    assert.equal(host.querySelectorAll('.is-done').length, 0);
    assert.equal(host.textContent, 'R U2 F');
  } finally {
    globalThis.document = originalDocument;
    dom.window.close();
  }
});

test('demo preserves standard scramble notation while simulating every reported quarter turn', async () => {
  const { makeDemoScenario, makeSampleCapture } = await import('./smart-cube-demo-fixture.js');
  const scramble = "R U2 F' D2 L B2 R2 U' F2 D B' L2 U R' F D' L B U2 R2";
  const scenario = makeDemoScenario(scramble);
  assert.equal(scenario.scramble, scramble);
  assert.ok(scenario.preparation.length > scramble.split(' ').length);
  assert.equal(scenario.moves.at(-1).timeMs, 11220);
  const capture = makeSampleCapture('demo', cubeTimestampLinearFit, scenario);
  assert.equal(capture.context.scramble, scramble);
  assert.equal(capture.moves.length, scenario.moves.length);
  assert.equal(seekState(capture, capture.moves.length - 1), SOLVED);
  assert.equal(capture.measuredDurationMs, 11220);
  assert.equal(capture.analysisConfig.phaseBoundaries, undefined);
});
