import { t } from './i18n.js';
import { SmartCaptures, hasUnsavedLocalChange } from './db.js';
import { validateCapture, checkpoints, seekState, rangeStats, phases, qtm, tpsWindows } from './smart-cube-core.js';
import { SmartPreview } from './smart-cube-preview.js';
import { orientationAt } from './smart-cube-gyro.js';
import { fmt, download, copy } from './util.js';

let current=null,generation=0;
const n=(tag,text,cls)=>{const e=document.createElement(tag);if(text!=null)e.textContent=t(text);if(cls)e.className=cls;return e;};
const paths={play:'M9 5l11 7-11 7z',pause:'M8 5v14M16 5v14',previous:'M6 5v14M18 5L8 12l10 7z',next:'M18 5v14M6 5l10 7-10 7z',restart:'M4 9a8 8 0 1 1 0 6M4 3v6h6',close:'M6 6l12 12M18 6L6 18',copy:'M9 9h11v11H9zM15 9V4H4v11h5',download:'M12 3v12m-5-5l5 5 5-5M4 16v5h16v-5',cube:'M12 2l9 5v10l-9 5-9-5V7zM3 7l9 5 9-5M12 12v10',check:'M5 12l4 4L19 6'};
const icon=key=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[key]}"/></svg>`;
const btn=(label,fn,cls='sa-btn',glyph)=>{const e=n('button',glyph?null:label,cls);e.type='button';e.setAttribute('aria-label',t(label));e.title=t(label);if(glyph)e.innerHTML=icon(glyph);e.onclick=fn;return e;};
const seconds=ms=>(Math.max(0,ms)/1000).toFixed(3);
const field=(label,input)=>{const e=n('label',null,'sa-field');e.append(n('span',label),input);return e;};
const select=(label,items,value)=>{const e=n('select');e.setAttribute('aria-label',t(label));for(const [v,label]of items){const o=n('option',label);o.value=v;e.append(o);}e.value=value;return e;};
const phaseColor=name=>({Cross:'var(--sa-cross)',F2L:'var(--sa-f2l)',OLL:'var(--sa-oll)',PLL:'var(--sa-pll)'})[name]||'var(--accent)';

function drawTPS(host,capture) {
  const windows=tpsWindows(capture,1000,Math.max(100,Math.ceil(capture.measuredDurationMs/1800))),peak=windows.reduce((max,w)=>Math.max(max,w.tps),1),width=600,height=110,pad=24;
  const pts=windows.map(w=>[pad+(w.atMs/Math.max(1,capture.measuredDurationMs))*(width-pad-10),height-18-w.tps/peak*(height-30)]);
  const line=pts.map(([x,y],i)=>`${i?'L':'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area=pts.length?`${line} L${pts.at(-1)[0]},${height-18} L${pad},${height-18} Z`:'';
  host.innerHTML=`<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${t('QTM turns per second over time')}"><defs><linearGradient id="sa-tps-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="currentColor" stop-opacity=".24"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs><path class="sa-chart-grid" d="M${pad} 24H590 M${pad} 58H590 M${pad} 92H590"/><path d="${area}" fill="url(#sa-tps-fill)"/><path d="${line}" fill="none" stroke="currentColor" stroke-width="2"/><text x="0" y="26">${peak.toFixed(0)}</text><text x="10" y="95">0</text><text x="${pad}" y="108">0s</text><text x="590" y="108" text-anchor="end">${(capture.measuredDurationMs/1000).toFixed(1)}s</text></svg>`;
  return Math.max(0,...windows.map(w=>w.tps));
}

export async function openSmartAnalysis(solve,{details,notice}) {
  current?.close();const gen=++generation,origin=document.activeElement;
  const dialog=n('dialog',null,'smart-analysis');dialog.setAttribute('aria-label',t('Smart cube analysis'));
  const header=n('header',null,'sa-header'),heading=n('div',null,'sa-heading'),mark=n('span',null,'sa-brand-mark');mark.innerHTML=icon('cube');
  const titles=n('div');titles.append(n('h2','Solve analysis'),n('p',`3×3 · ${new Date(solve.createdAt).toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'})}`));heading.append(mark,titles);
  const headerActions=n('div',null,'sa-header-actions');
  headerActions.append(btn('Solve details',()=>{dialog.close();details(origin?.isConnected?origin:document.querySelector('#time-main'));},'sa-btn sa-quiet'),btn('Close',()=>dialog.close(),'sa-icon-btn','close'));
  header.append(heading,headerActions);
  const status=n('div','Loading capture…','sa-quality');status.role='status';
  const content=n('div',null,'sa-content');
  const actionStatus=n('p',null,'sa-action-status');actionStatus.role='status';
  let statusTimer;
  const report=message=>{
    actionStatus.textContent=message;
    clearTimeout(statusTimer);
    statusTimer=setTimeout(()=>{actionStatus.textContent='';},4000);
  };dialog.append(header,content);content.append(status);document.body.append(dialog);dialog.showModal();current=dialog;
  let preview,raf=0,playing=false;
  dialog.addEventListener('close',()=>{playing=false;cancelAnimationFrame(raf);clearTimeout(statusTimer);preview?.dispose();dialog.remove();if(current===dialog)current=null;origin?.focus();},{once:true});
  try {
    let capture=await SmartCaptures.get(solve.id);
    if(!capture){status.textContent=t('Capture pending download. Connect to your account and retry.');const{downloadSmartCapture}=await import('./sync.js');capture=await downloadSmartCapture(solve.id);}
    if(gen!==generation||!dialog.open)return;
    if(!capture){content.append(btn('Retry download',()=>openSmartAnalysis(solve,{details,notice})));return;}
    if(navigator.onLine!==false){try{const{downloadSmartCapture}=await import('./sync.js');capture=await downloadSmartCapture(solve.id)||capture;}catch{}}
    if(gen!==generation||!dialog.open)return;
    validateCapture(capture);
    status.textContent=`${capture.simulated?t('Simulated example'):`${t(capture.completeness)} · ${t(capture.timingQuality)}`}${hasUnsavedLocalChange('solves',solve.id)?` · ${t('Unsaved')}`:''}`;
    status.classList.toggle('sa-warning',capture.completeness!=='complete');headerActions.prepend(status);
    content.append(n('div',status.textContent,'sa-quality-mobile'),actionStatus);
    const count=qtm(capture.moves),duration=capture.measuredDurationMs,gaps=capture.moves.map((m,i)=>m.timeMs-(capture.moves[i-1]?.timeMs||0));
    const metrics=n('div',null,'sa-metrics');
    const metric=(label,value,sub,cls='')=>{const e=n('div',null,`sa-metric ${cls}`);e.append(n('span',label,'sa-eyebrow'),n('strong',value),n('small',sub));return e;};
    metrics.append(metric('Execution time',fmt(duration),solve.penalty==='none'?t('First turn → solved'):t('Result')+': '+(solve.penalty==='DNF'?'DNF':fmt(duration+2000)),'sa-metric-time'),metric('Quarter turns',String(count),'QTM · '+capture.moves.length+' '+t('recorded moves')),metric('Turns per second',duration>0?(count*1000/duration).toFixed(2):'—','QTM TPS · '+t('excludes penalties')),metric('Longest pause',(Math.max(0,...gaps)/1000).toFixed(2)+'s',t('Measured inter-turn gap')));
    const workspace=n('div',null,'sa-workspace'),replay=n('section',null,'sa-replay'),right=n('section',null,'sa-breakdown');
    const replayTop=n('div',null,'sa-panel-top');replayTop.append(n('span','REPLAY','sa-eyebrow'));
    const viewMode=select('Cube view',[['3d','3D cube'],['net','Sticker net']],'3d');viewMode.className='sa-view-select';replayTop.append(viewMode);
    const stage=n('div',null,'sa-cube-stage');preview=new SmartPreview(stage);preview.set(capture.initialFacelets);viewMode.onchange=async()=>{await preview.net(viewMode.value==='net');viewMode.value=preview.root.classList.contains('smart-net')?'net':'3d';};
    const drag=n('span','Drag to rotate','sa-drag-hint');stage.append(drag);
    let orientationReference=capture.orientation?.reference;
    const gyroControl=n('label',null,'sa-gyro-control');
    if(capture.orientation?.samples.length){
      const follow=n('input');follow.type='checkbox';follow.checked=true;follow.setAttribute('aria-label',t('Replay gyroscope'));
      follow.onchange=()=>preview.gyro(follow.checked);
      gyroControl.append(follow,n('span','Replay gyroscope'),n('small',t('{n} samples · estimated alignment',{n:capture.orientation.samples.length})));
      const recenter=()=>{
        orientationReference=orientationAt(capture.orientation,atMs);
        preview.reset();preview.orientation(orientationReference,orientationReference);
      };
      gyroControl.append(btn('Re-centre gyro',recenter,'sa-btn sa-quiet'));
      dialog.addEventListener('smart-cube-recenter',recenter);
    }
    preview.ready.then(()=>{viewMode.value=preview.root.classList.contains('smart-net')?'net':'3d';});
    const controls=n('div',null,'sa-playback'),readout=n('div',null,'sa-readout'),position=n('output'),moveCounter=n('span');readout.append(position,moveCounter);
    let index=-1,atMs=0,speed=1,originTime=0,originMs=0,rangeAnchor=0;
    const points=checkpoints(capture),rows=[],slider=n('input',null,'sa-seek');slider.type='range';slider.min='0';slider.max=String(Math.max(duration,1));slider.step='1';slider.value='0';slider.setAttribute('aria-label',t('Replay timeline'));
    const markerBand=n('div',null,'sa-phase-track'),markers=n('div',null,'sa-alg-markers');
    let visibleState=capture.initialFacelets;
    const seek=(i,at=capture.moves[i]?.timeMs||0)=>{
      const previous=index;
      index=Math.max(-1,Math.min(i,capture.moves.length-1));
      atMs=at;slider.value=String(at);slider.style.setProperty('--sa-progress',`${duration?at/duration*100:0}%`);
      position.textContent=`${(at/1000).toFixed(2)} / ${(duration/1000).toFixed(2)}`;moveCounter.textContent=`${index+1}/${capture.moves.length} ${t('moves')}`;
      const orientation=orientationAt(capture.orientation,at);
      if(orientation)preview.orientation(orientation,orientationReference);
      if(index===previous)return;
      rows[previous]?.classList.remove('on');rows[index]?.classList.add('on');
      const state=seekState(capture,index,points);
      if(playing&&index===previous+1)preview.turn(capture.moves[index].move,visibleState,state);
      preview.set(state);visibleState=state;
      const row=rows[index];
      if(row&&!movePane.hidden){
        const bounds=movePane.getBoundingClientRect(),target=row.getBoundingClientRect();
        if(target.top<bounds.top+moveHead.offsetHeight)movePane.scrollTop+=target.top-bounds.top-moveHead.offsetHeight;
        else if(target.bottom>bounds.bottom)movePane.scrollTop+=target.bottom-bounds.bottom;
      }
    };
    const seekTime=at=>{let lo=0,hi=capture.moves.length;while(lo<hi){const mid=(lo+hi)>>>1;if(capture.moves[mid].timeMs<=at)lo=mid+1;else hi=mid;}seek(lo-1,at);};
    const stop=()=>{playing=false;cancelAnimationFrame(raf);play.innerHTML=icon('play');play.setAttribute('aria-label',t('Play'));play.title=t('Play');};
    const tick=now=>{if(!playing||!dialog.open)return;const at=Math.min(duration,originMs+(now-originTime)*speed);seekTime(at);if(at>=duration)stop();else raf=requestAnimationFrame(tick);};
    const play=btn('Play',()=>{if(playing)return stop();if(atMs>=duration)seek(-1,0);playing=true;originTime=performance.now();originMs=atMs;play.innerHTML=icon('pause');play.setAttribute('aria-label',t('Pause'));play.title=t('Pause');raf=requestAnimationFrame(tick);},'sa-play-btn','play');
    const speeds=select('Playback speed',[[.25,'0.25×'],[.5,'0.5×'],[1,'1×'],[2,'2×']],'1');speeds.onchange=()=>{speed=Number(speeds.value);originTime=performance.now();originMs=atMs;};
    const transport=n('div',null,'sa-transport');transport.append(btn('Restart',()=>{stop();seek(-1,0);},'sa-icon-btn','restart'),btn('Previous turn',()=>{stop();seek(index-1);},'sa-icon-btn','previous'),play,btn('Next turn',()=>{stop();seek(index+1);},'sa-icon-btn','next'));
    controls.append(readout,slider,markerBand,markers,transport,speeds);slider.oninput=()=>{stop();seekTime(Number(slider.value));};
    replay.append(replayTop,stage,gyroControl,controls);

    const tabs=n('div',null,'sa-tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label',t('Analysis sections'));
    const phasePane=n('div',null,'sa-tab-panel'),movePane=n('div',null,'sa-tab-panel sa-move-pane'),segmentPane=n('div',null,'sa-tab-panel sa-segment-pane');
    const panes={Phases:phasePane,Moves:movePane,Segments:segmentPane};
    for(const [label,pane]of Object.entries(panes)){
      const tab=btn(label,()=>{for(const t of tabs.children)t.setAttribute('aria-selected',String(t===tab));for(const p of Object.values(panes))p.hidden=p!==pane;},'sa-tab');tab.setAttribute('role','tab');tab.setAttribute('aria-selected',String(label==='Phases'));tab.id=`sa-tab-${label.toLowerCase()}`;pane.setAttribute('role','tabpanel');pane.setAttribute('aria-labelledby',tab.id);pane.hidden=label!=='Phases';tabs.append(tab);
    }
    const table=n('table',null,'sa-phase-table');table.innerHTML=`<thead><tr><th>${t('Phase')}</th><th>${t('Time')}</th><th>QTM</th><th>TPS</th></tr></thead>`;const tbody=n('tbody');table.append(tbody);
    const profile=select('Analysis profile',[['unknown','Unknown / other method'],['cfop','CFOP']],capture.analysisConfig?.profile||'unknown');
    const face=select('Cross face',[...'DURFLB'].map(f=>[f,`${f} ${t('cross')}`]),capture.analysisConfig?.crossFace||'D');
    const settings=n('div',null,'sa-phase-settings');settings.append(profile,face);
    const phaseNote=n('p',null,'sa-muted'),algorithmCards=n('div',null,'sa-algorithms');
    const identify=btn('Identify exact OLL / PLL algorithms',async()=>{
      identify.disabled=true;
      try{const{matchAlgorithms,lastLayerLandmarks}=await import('./smart-cube-algorithms.js');const landmarks=lastLayerLandmarks(capture);const next={...capture,analysisConfig:{...capture.analysisConfig,lastLayerLandmarks:landmarks}};const result=[...matchAlgorithms(next,phases(next,face.value)),...Object.entries(landmarks).map(([phase,r])=>({phase,...r}))];capture=await SmartCaptures.annotate(solve.id,{analysisConfig:{...next.analysisConfig,algorithmMatches:result}});updatePhases();if(!result.length)algorithmCards.append(n('p','No exact supported algorithm match. The observed moves remain available.','sa-muted'));}catch(e){report(e.message);}finally{identify.disabled=false;}
    },'sa-btn sa-identify');
    phasePane.append(settings,table,phaseNote,algorithmCards,identify);
    const moveHead=n('div',null,'sa-move-columns');moveHead.innerHTML=`<span>#</span><span>${t('Turn')}</span><span>${t('Time')}</span><span>${t('Gap')}</span>`;
    const moveList=n('div',null,'smart-moves');moveList.setAttribute('aria-label',t('Timed move list'));movePane.append(moveHead,moveList);
    capture.moves.forEach((m,i)=>{
      const row=btn(`${i+1}. ${m.move} · ${seconds(m.timeMs)} s · ${t('Gap')} ${seconds(gaps[i])} s${m.estimated?' · '+t('Estimated timing'):''}`,event=>{stop();seek(i);const lo=event.shiftKey?Math.min(rangeAnchor,i):i,hi=event.shiftKey?Math.max(rangeAnchor,i):i;if(!event.shiftKey)rangeAnchor=i;a.value=String(lo+1);b.value=String(hi+1);updateRange();},'sa-move');
      row.dataset.index=String(i);row.innerHTML=`<span class="sa-move-index">${i+1}</span><b>${m.move}</b><span>${m.estimated?'≈ ':''}${seconds(m.timeMs)}</span><span class="sa-gap">+${seconds(gaps[i])}</span>`;rows.push(row);moveList.append(row);
    });
    right.append(tabs,phasePane,movePane,segmentPane);workspace.append(replay,right);
    const chartPanel=n('section',null,'sa-tps-panel'),chartTop=n('div',null,'sa-panel-top'),chart=n('div',null,'sa-chart');const peak=drawTPS(chart,capture);
    chartTop.append(n('span','TURN SPEED','sa-eyebrow'),n('span',`${t('Peak')} ${peak.toFixed(1)} TPS · ${t('trailing 1-second window')}`,'sa-muted'));chartPanel.append(chartTop,chart);

    const range=n('section',null,'sa-range'),rangeHeading=n('div',null,'sa-range-heading');rangeHeading.append(n('h3','Inspect a move sequence'),n('span','Select a range, or Shift-click moves in the Moves tab.','sa-muted'));
    const a=n('input'),b=n('input');for(const [input,label,value]of [[a,'First move',1],[b,'Last move',capture.moves.length]]){input.type='number';input.min='1';input.max=String(capture.moves.length);input.value=String(value);input.setAttribute('aria-label',t(label));}
    const rangeValues=n('div',null,'sa-range-values'),rangeTimes=n('p',null,'sa-muted sa-range-times'),label=n('input');label.type='text';label.maxLength=100;label.placeholder=t('Name this move range');label.setAttribute('aria-label',t('Range annotation'));
    const selection=()=>{const lo=Math.max(0,Math.min(capture.moves.length-1,Number(a.value)-1));return[lo,Math.max(lo,Math.min(capture.moves.length-1,Number(b.value)-1))];};
    const updateRange=()=>{
      const [lo,hi]=selection(),r=rangeStats(capture,lo,hi);rangeValues.replaceChildren();
      rangeTimes.textContent=`${seconds(r.startMs)}s → ${seconds(r.endMs)}s`;
      for(const [name,value]of [['QTM',r.qtm],['Execution span',seconds(r.spanMs)+'s'],['Entry gap',seconds(r.entryGapMs)+'s'],['Range TPS',r.tps?.toFixed(2)||'—']]){const e=n('div');e.append(n('span',name),n('strong',String(value)));rangeValues.append(e);}
      rows.forEach((row,i)=>row.classList.toggle('in-range',i>=lo&&i<=hi));
    };
    a.oninput=b.oninput=updateRange;
    const saveAnnotation=btn('Save annotation',async()=>{
      if(!label.value.trim())return label.focus();if((capture.annotations?.length||0)>=100)return report(t('Annotation limit reached. Export before adding more.'));
      try{const[startIndex,endIndex]=selection();capture=await SmartCaptures.annotate(solve.id,{annotations:[...(capture.annotations||[]),{id:crypto.randomUUID(),label:label.value.trim(),startIndex,endIndex,createdAt:Date.now()}]});label.value='';paintAnnotations();report(t('Annotation saved'));}catch(e){report(e.message);}
    },'sa-btn sa-primary');
    const rangeForm=n('div',null,'sa-range-form');rangeForm.append(field('From move',a),field('To move',b),rangeValues);
    const annotationForm=n('div',null,'sa-annotation-form');annotationForm.append(label,saveAnnotation);
    range.append(rangeHeading,rangeForm,rangeTimes,annotationForm);
    const paintAnnotations=()=>{
      segmentPane.replaceChildren();
      if(!capture.annotations?.length)segmentPane.append(n('p','No saved segments yet. Select moves below to name a sequence.','sa-muted'));
      for(const ann of capture.annotations||[]){const r=rangeStats(capture,ann.startIndex,ann.endIndex),card=btn(`${ann.label}: ${ann.startIndex+1}–${ann.endIndex+1}`,()=>{a.value=String(ann.startIndex+1);b.value=String(ann.endIndex+1);updateRange();stop();seek(ann.endIndex);},'sa-segment');card.replaceChildren();card.append(n('strong',ann.label),n('span',`${ann.startIndex+1}–${ann.endIndex+1} · ${r.qtm} QTM`),n('b',seconds(r.spanMs)+'s'));segmentPane.append(card);}
    };
    const reconstruction=n('details',null,'sa-advanced');
    reconstruction.append(n('summary','Full reconstruction'));
    const notation=n('pre',null,'sa-reconstruction');
    reconstruction.append(notation);
    const advanced=n('details',null,'sa-advanced'),advancedTitle=n('summary','Scramble, timing & phase corrections');
    const advancedBody=n('div',null,'sa-advanced-body'),scramble=n('code',capture.context?.scramble||'','sa-scramble-code');
    const phaseChoice=select('Phase boundary',[['Cross','Cross'],['F2L','F2L'],['OLL','OLL']],'Cross');
    const correction=btn('Use selected end as phase boundary',async()=>{
      const[,end]=selection(),boundaries={...(capture.analysisConfig?.phaseBoundaries||{}),[phaseChoice.value]:end+1},ordered=['Cross','F2L','OLL'].map(p=>boundaries[p]).filter(Number.isInteger);
      if(ordered.some((v,i)=>i&&v<ordered[i-1]))return report(t('Phase boundaries must follow Cross, F2L, OLL order.'));
      try{capture=await SmartCaptures.annotate(solve.id,{analysisConfig:{...capture.analysisConfig,phaseBoundaries:boundaries,boundarySource:'user'}});updatePhases();}catch(e){report(e.message);}
    });
    const threshold=n('input');threshold.type='number';threshold.min='100';threshold.max='10000';threshold.step='100';threshold.value=String(capture.analysisConfig?.pauseThresholdMs||500);threshold.setAttribute('aria-label',t('Pause threshold (ms)'));
    const saveConfig=async()=>{try{capture=await SmartCaptures.annotate(solve.id,{analysisConfig:{...capture.analysisConfig,profile:profile.value,crossFace:face.value,lastLayerLandmarks:{},pauseThresholdMs:Math.max(100,Math.min(10000,Number(threshold.value)||500))}});updatePhases();}catch(e){report(e.message);}};
    profile.onchange=face.onchange=threshold.onchange=saveConfig;
    const corrections=n('div',null,'sa-corrections');corrections.append(field('Phase boundary',phaseChoice),correction,field('Pause threshold (ms)',threshold));
    advancedBody.append(scramble,n('p',`${t('Inspection')}: ${seconds(capture.inspectionMs||0)}s · ${t('Timing')}: ${capture.timingMethod} · ${t('Scramble verified')}: ${capture.scrambleVerified?t('Yes'):t('No')}`,'sa-muted'),n('p','Phase times include the gap before the first turn of each phase. Range execution measures first turn to last turn.','sa-muted'),corrections);
    if(capture.qualityIssues?.length)advancedBody.append(n('p',capture.qualityIssues.join(' · '),'sa-warning'));advanced.append(advancedTitle,advancedBody);
    const footer=n('footer',null,'sa-footer');footer.append(n('span',capture.simulated?'Simulated move data · not a hardware timing result':'Original turn evidence preserved','sa-muted'),btn('Copy reconstruction',async()=>report(t(await copy(capture.moves.map(m=>m.move).join(' '))?'Reconstruction copied':'Could not copy reconstruction')),'sa-btn sa-quiet'),btn('Export timed capture JSON',()=>download(`smart-cube-${solve.id}.json`,JSON.stringify(capture,null,2),'application/json'),'sa-btn sa-quiet'));

    function updatePhases(){
      const result=phases(capture,face.value);tbody.replaceChildren();markerBand.replaceChildren();markers.replaceChildren();algorithmCards.replaceChildren();
      notation.textContent=result.length?result.filter(p=>p.endIndex>=p.startIndex).map(p=>`// ${p.name}\n${capture.moves.slice(p.startIndex,p.endIndex+1).map(m=>m.move).join(' ')}`).join('\n\n'):capture.moves.map(m=>m.move).join(' ');
      phaseNote.textContent=result.length?t('Click a phase to jump to its final turn.'):t('Choose CFOP to see phase timings. Replay and range timing work for any method.');
      if(capture.analysisConfig?.boundarySource==='scripted-demo')phaseNote.textContent=t('Scripted demo phases, checked against the cube state. Click a phase to jump to its final turn.');
      for(const p of result){const tr=n('tr');tr.tabIndex=0;tr.style.setProperty('--phase-color',phaseColor(p.inferredPhase||p.name));const name=n('td'),dot=n('i',null,'sa-phase-dot');name.append(dot,n('span',p.name));const progress=n('span',null,'sa-phase-row-bar');progress.style.width=`${duration?p.durationMs/duration*100:0}%`;name.append(progress);tr.append(name,n('td',(p.durationMs/1000).toFixed(2)+'s'),n('td',String(p.qtm)),n('td',p.durationMs>0?(p.qtm*1000/p.durationMs).toFixed(2):'—'));tr.onclick=()=>{stop();seek(p.endIndex);};tr.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();tr.click();}};tbody.append(tr);
        const marker=btn(`${p.name} ${(p.endMs/1000).toFixed(2)} s`,()=>{stop();seek(p.endIndex);},'sa-phase-slice');marker.style.setProperty('--phase-color',phaseColor(p.inferredPhase||p.name));marker.style.flex=String(Math.max(.03,duration?p.durationMs/duration:0));marker.textContent=p.inferredPhase||p.name;markerBand.append(marker);
      }
      for(const r of capture.analysisConfig?.algorithmMatches||[]){const card=n('div',null,'sa-alg-card'),range=rangeStats(capture,r.startIndex,r.endIndex);card.append(n('strong',`${r.phase} · ${r.caseIds.join(' / ')}`),n('span',seconds(range.spanMs)+'s'),n('code',r.observed));algorithmCards.append(card);markers.append(btn(`${r.caseIds.join(' / ')} ${(range.startMs/1000).toFixed(2)} s`,()=>{stop();seek(r.startIndex);},'sa-alg-marker'));}
      rows.forEach((row,i)=>row.classList.toggle('smart-pause',gaps[i]>=Number(threshold.value)));
    }
    content.append(metrics,workspace,reconstruction,chartPanel,range,advanced,footer);updatePhases();updateRange();paintAnnotations();seek(-1,0);
  }catch(e){status.textContent=`${t('Replay unavailable')}: ${e.message}`;status.classList.add('sa-warning');}
}
