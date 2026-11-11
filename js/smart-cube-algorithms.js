import { OLL, PLL } from './algs.js';
import { OLL_ALGS, PLL_ALGS } from './algsets.js';
import { parse, applyAlg, SOLVED, IDENTITY_FRAME, fromFacelets, analyse } from './cube3.js';

// Exact face-turn alternatives only. Slices/wides are not inferred from sensors.
function quarters(alg) {
  const tokens = parse(alg); if (!tokens) return null;
  let frame = IDENTITY_FRAME; const out = [];
  for (const token of tokens) {
    const { letter, amount, wide } = token;
    if ('xyz'.includes(letter)) { frame = applyAlg(SOLVED,letter+(amount===2?'2':amount===3?"'":''),frame).frame; continue; }
    if (wide || !'URFDLB'.includes(letter)) return null;
    const f = frame[letter];
    out.push(...(amount === 2 ? [f,f] : [f+(amount===3?"'":'')]));
  }
  return out.join(' ');
}
export function matchAlgorithms(capture, phaseRows) {
  const result = [];
  for (const phase of phaseRows.filter(p=>['OLL','PLL'].includes(p.name) && p.endIndex>=p.startIndex)) {
    const observed = capture.moves.slice(phase.startIndex,phase.endIndex+1).map(m=>m.move).join(' '), target = quarters(observed);
    const entries = phase.name === 'OLL' ? OLL : PLL, extra = phase.name === 'OLL' ? OLL_ALGS : PLL_ALGS;
    const ids = new Set();
    for (const entry of entries) for (const alg of [entry.alg,...(extra[entry.id] || extra[Number(entry.name)] || [])]) {
      for (const pre of ['', 'U', "U'", 'U2']) for (const post of ['', 'U', "U'", 'U2']) {
        if (quarters(`${pre} ${alg} ${post}`) === target) ids.add(entry.id || entry.name);
      }
    }
    if (ids.size) result.push({phase:phase.name,startIndex:phase.startIndex,endIndex:phase.endIndex,caseIds:[...ids],observed,method:'exact face-turn alternative with AUF',referenceVersion:'tagda-algsets-v102',confidence:ids.size===1?'exact':'ambiguous'});
  }
  return result;
}

// Recognised complete LL suffixes establish boundaries without requiring F2L
// stickers to stay home during every intermediate turn of a valid algorithm.
export function lastLayerLandmarks(capture) {
  if (capture.analysisConfig?.profile !== 'cfop' || (capture.analysisConfig.crossFace || 'D') !== 'D') return {};
  const states = [fromFacelets(capture.initialFacelets)];
  for (const m of capture.moves) states.push(applyAlg(states.at(-1),m.move).state);
  const find = (kind,end) => {
    const entries=kind==='PLL'?PLL:OLL,extra=kind==='PLL'?PLL_ALGS:OLL_ALGS, candidates=[];
    const alternatives=new Map();
    for(const e of entries) for(const alg of [e.alg,...(extra[e.id]||extra[Number(e.name)]||[])]) {
      for(const pre of ['', 'U', "U'", 'U2']) for(const post of ['', 'U', "U'", 'U2']) {
        const q=quarters(`${pre} ${alg} ${post}`);if(!q)continue;
        if(!alternatives.has(q))alternatives.set(q,new Set());alternatives.get(q).add(e.id||e.name);
      }
    }
    for(let start=Math.max(0,end-40);start<end;start++) {
      const a=analyse(states[start],'D');if(kind==='PLL'?!a.oll||a.solved:!a.f2l||a.oll)continue;
      const observed=capture.moves.slice(start,end).map(m=>m.move).join(' '),ids=alternatives.get(quarters(observed));
      if(ids)candidates.push({startIndex:start,endIndex:end-1,caseIds:[...ids],observed,method:'exact face-turn suffix with AUF',referenceVersion:'tagda-algsets-v102',confidence:ids.size===1?'exact':'ambiguous'});
    }
    // Different plausible starts (often AUF allocation) remain ambiguous.
    return candidates.length===1?candidates[0]:null;
  };
  const pll=find('PLL',capture.moves.length),oll=find('OLL',pll?.startIndex??capture.moves.length);
  return { ...(pll?{PLL:pll}:{}),...(oll?{OLL:oll}:{}) };
}
