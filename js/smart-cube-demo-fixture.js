import { SOLVED, turnState, scrambleState, timeline, validateCapture } from './smart-cube-core.js';
import { inverseTurns } from './smart-cube-scramble.js';

const quarterTurns = moves => moves.flatMap(move => move.endsWith('2') ? [move[0], move[0]] : [move]);

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
  return validateCapture({id,solveId:id,schemaVersion:1,revision:0,simulated:true,ownerUid:null,
    createdAt:Date.now(),initialFacelets:scenario.initialFacelets,scrambleVerified:true,completeness:'complete',penalty:'none',inspectionMs:1500,
    timingConvention:'first-turn-to-final-turn',...timeline(raw,fit),timingQuality:'simulated',
    connections:[{epoch:1,deviceModel:'Simulated GAN · demo'}],rawEvents:raw,
    analysisConfig:structuredClone(scenario.analysisConfig),annotations:structuredClone(scenario.annotations),qualityIssues:[],analysisVersion:1,
    context:{sessionId,event:'333',mode:'wca',scramble:scenario.scramble,inspection:true,ownerUid:null,allowed:true},
  });
}
