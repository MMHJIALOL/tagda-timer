import { SOLVED, turnState, scrambleState, timeline, validateCapture, phases } from './smart-cube-core.js';
import { inverseTurns } from './smart-cube-scramble.js';
import { multiplyQuaternion } from './smart-cube-gyro.js';
import { lastLayerLandmarks, matchAlgorithms } from './smart-cube-algorithms.js';

const quarterTurns = moves => moves.flatMap(move => move.endsWith('2') ? [move[0], move[0]] : [move]);

export function demoOrientation(timeMs) {
  const angles=[.65*Math.sin(timeMs/1000),1.1*Math.sin(timeMs/1400),.45*Math.sin(timeMs/900)];
  const rotations=angles.map((angle,i)=>({x:i===0?Math.sin(angle/2):0,y:i===1?Math.sin(angle/2):0,z:i===2?Math.sin(angle/2):0,w:Math.cos(angle/2)}));
  return rotations.reduce(multiplyQuaternion);
}

export function makeShowcaseScenario() {
  // An authored, state-checked example: a cross, the last F2L pair, Sune and T.
  const sections=[['Cross',"F D R2 B'"],['F2L',"U' R U R' U"],['OLL',"R U R' U R U2 R'"],['PLL',"R U R' U' R' F R2 U' R' U' R U R' F'"]];
  const scenario=makeDemoScenario(inverseTurns(sections.flatMap(([,alg])=>alg.split(' '))).join(' '));
  let index=0;
  const phaseBoundaries={};
  scenario.annotations=sections.map(([name,alg])=>{
    const startIndex=index;index+=quarterTurns(alg.split(' ')).length;
    if(name!=='PLL')phaseBoundaries[name]=index;
    return {id:`showcase-${name}`,label:name==='OLL'?'Sune · OLL 27':name==='PLL'?'T-perm':name,startIndex,endIndex:index-1};
  });
  scenario.analysisConfig={...scenario.analysisConfig,phaseBoundaries,boundarySource:'scripted-demo'};
  const capture={moves:scenario.moves,initialFacelets:scenario.initialFacelets,analysisConfig:scenario.analysisConfig,completeness:'complete',measuredDurationMs:11220};
  const landmarks=lastLayerLandmarks(capture);
  scenario.analysisConfig.lastLayerLandmarks=landmarks;
  scenario.analysisConfig.algorithmMatches=matchAlgorithms(capture,phases(capture));
  scenario.showcase=true;
  return scenario;
}

// Keep the scrambler's original notation. Only the simulated Bluetooth stream
// expands half turns into the quarter turns reported by a real cube.
export function makeDemoScenario(scramble) {
  const tokens = scramble.trim().split(/\s+/);
  const preparation = quarterTurns(tokens);
  const execution = quarterTurns(inverseTurns(tokens));
  const pauses = [Math.floor(execution.length / 3), Math.floor(execution.length * 2 / 3)];
  let clock = 0;
  const moves = execution.map((move, index) => {
    if (index) clock += [210,190,250,170,230,205][index % 6] + (pauses.includes(index) ? 1000 : 0);
    return { move, timeMs:clock };
  });
  moves.forEach(move => { move.timeMs = Math.round(move.timeMs / clock * 11220); });
  const initialFacelets = scrambleState(scramble);
  let state = initialFacelets;
  moves.forEach(({move}, index) => {
    state = turnState(state, move);
    if (state === SOLVED && index !== moves.length - 1) throw new Error('Demo reaches solved early');
  });
  if (state !== SOLVED) throw new Error('Demo solution does not match the scramble');
  return {
    scramble, preparation, moves, initialFacelets,
    analysisConfig:{ profile:'cfop', crossFace:'D', pauseThresholdMs:500 },
    annotations:pauses.map(index => ({ id:`demo-pause-${index}`, label:'Simulated pause', startIndex:index-1, endIndex:index })),
  };
}

export function makeSampleCapture(sessionId,fit,scenario) {
  const id=crypto.randomUUID(),host=performance.now();
  const raw=scenario.moves.map((m,i)=>({type:'MOVE',move:m.move,epoch:1,serial:i+1,position:i+1,
    cubeTimestamp:1000+m.timeMs,localTimestamp:host+m.timeMs,receivedMonotonic:host+m.timeMs,
    receivedAt:Date.now()+m.timeMs,recovered:false,simulated:true}));
  const orientationSamples=Array.from({length:Math.floor(11220/100)+1},(_,i)=>({timeMs:i*100,receivedMonotonic:host+i*100,quaternion:demoOrientation(i*100)}));
  orientationSamples.push({timeMs:11220,receivedMonotonic:host+11220,quaternion:demoOrientation(11220)});
  return validateCapture({id,solveId:id,schemaVersion:1,revision:0,simulated:true,demoVersion:3,ownerUid:null,
    createdAt:Date.now(),initialFacelets:scenario.initialFacelets,scrambleVerified:true,completeness:'complete',penalty:'none',inspectionMs:1500,
    timingConvention:'first-turn-to-final-turn',...timeline(raw,fit),timingQuality:'simulated',
    connections:[{epoch:1,deviceModel:'Simulated GAN · demo',hardware:{gyroSupported:true}}],rawEvents:raw,
    orientation:{schemaVersion:1,reference:demoOrientation(0),timingQuality:'simulated',samples:orientationSamples},
    analysisConfig:structuredClone(scenario.analysisConfig),annotations:structuredClone(scenario.annotations),qualityIssues:[],analysisVersion:1,
    context:{sessionId,event:'333',mode:'wca',scramble:scenario.scramble,inspection:true,ownerUid:null,allowed:true},
  });
}
