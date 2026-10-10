import { t } from './i18n.js';
import { CompetitionSets, Solves, KV, Tombstones, onWrite } from './db.js';
import { el, uid, fmt, fmtResult } from './util.js';
import { eventOf } from './events.js';
import { toast, confirmToast } from './toast.js';
import { enableReplay, replaySupported, replayOff, hasReplay, openReplay } from './replay.js';
import { getConfig } from './config.js';
import { competitionResult, competitionTime, validateCompetitionSize } from './competition-stats.js';
import { recordingBudget, startSetReplay, stopSetReplay, recoverSetReplay, loadSetReplay,
         setRecordingLive, mediaNow, cleanupCompetitionMedia } from './competition-replay.js';

let app, active = null, viewing = true, host = null, strip, dialogKind = '', dialogSetId = null;
let capture = { inspection: null, start: null }, generation = 0;
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('tagda-competition') : null;
export const competitionOpen = () => !!host;
export const competitionTiming = () => !!active && viewing && active.sessionId === app?.session?.id;
const compatible = () => {
  const ev = eventOf(app.settings.event);
  return !ev.relay && !ev.multi && !ev.fmc && !app.session.race && !app.session.virtual && !document.body.classList.contains('sotd') && !app.scramble?.race;
};
const button = (text, fn, cls = '') => el('button', { class: `ghost-btn ${cls}`, text, onclick: () => Promise.resolve().then(fn).catch(err => toast(err.message || t('Could not save changes'), { kind: 'bad' })) });
export function closeCompetition() { host?.close(); host?.remove(); host = null; dialogKind = ''; dialogSetId = null; }
function dialog(title, nodes) {
  closeCompetition();
  host = el('dialog', { class: 'competition-dialog', 'aria-label': title },
    el('header', {}, el('h2', { text: title }), button('Close', closeCompetition)), ...nodes);
  host.addEventListener('cancel', () => { closeCompetition(); });
  document.body.append(host); host.showModal();
}
export async function initCompetition(appRef, timer) {
  app = appRef;
  app.competitionSets = new Map();
  strip = el('div', { id: 'competition-strip', class: 'competition-strip', hidden: true, 'aria-live': 'polite' });
  document.querySelector('#timer-display').before(strip);
  app.openCompetition = openCompetitionSetup;
  app.competitionHistory = openCompetitionHistory;
  app.openCompetitionSet = openCompetitionSet;
  app.competitionTiming = competitionTiming;
  app.competitionRefresh = refreshCompetition;
  app.competitionContextChanged = async () => {
    if (active && active.sessionId !== app.session.id) { viewing = false; await endCapture(); }
    paintStrip();
  };
  timer.addEventListener('inspectstart', () => { if (competitionTiming()) { capture.inspection = mediaNow(active.id); capture.inspectionAt = Date.now(); } });
  timer.addEventListener('start', () => { if (competitionTiming()) { capture.start = mediaNow(active.id); capture.startAt = Date.now(); } });
  timer.addEventListener('cancel', () => { capture = { inspection: null, start: null }; });
  onWrite('solves', s => {
    if (s.competitionSetId) {
      channel?.postMessage({ type: 'penalty', id: s.competitionSetId });
      paintStrip();
      if (dialogKind === 'result' && dialogSetId === s.competitionSetId) openCompetitionSet(s.competitionSetId);
    }
  });
  onWrite('competition', ({ sets, deleted }) => {
    for (const c of sets || []) app.competitionSets.set(c.id, c);
    if (deleted) app.competitionSets.delete(deleted.id);
    channel?.postMessage({ type: 'sets' });
    if (deleted?.id === active?.id) { active = null; app.competitionRecordingMode = null; }
  });
  channel?.addEventListener('message', async () => { await Tombstones.refresh(); if (['idle','cooldown'].includes(timer.state)) { await app.reloadCompetitionSolves(); await refreshCompetition(); } });
  addEventListener('sync:remote', () => refreshCompetition());
  const saved = await KV.get('_competitionView', true); viewing = saved;
  await refreshCompetition({ boot: true });
  cleanupCompetitionMedia().catch(err => console.warn('[competition] pending media cleanup',err));
}
export async function refreshCompetition({ boot = false } = {}) {
  const mine = ++generation;
  const all = await CompetitionSets.all();
  if (mine !== generation) return;
  app.competitionSets = new Map(all.map(c => [c.id, c]));
  const was = active;
  active = all.find(c => c.status === 'active') || null;
  if (active) {
    const meta = await recoverSetReplay(active.id);
    if (meta && meta.status !== 'recording' && meta.status !== active.replayStatus && !setRecordingLive(active.id)) {
      active = await CompetitionSets.patch(active.id, { replayStatus: meta.status, replayReason: meta.reason });
    }
    if (viewing && active.sessionId === app.session.id) {
      app.settings.event = active.event; app.settings.mode = 'wca';
      app.competitionRecordingMode = active.recordingMode;
      if (active.currentScramble && (boot || (was && was.solveIds.length !== active.solveIds.length))) app.restoreCompetitionScramble?.(active.currentScramble);
    }
  } else {
    app.competitionRecordingMode = null;
    if (was && setRecordingLive(was.id)) await stopSetReplay(was.id, false);
  }
  paintStrip();
  if (!boot) app.redrawCompetition?.();
  if (!boot && dialogKind === 'result') {
    const id = dialogSetId;
    if (all.some(c => c.id === id)) await openCompetitionSet(id); else closeCompetition();
  }
}
function paintStrip() {
  if (!strip) return;
  const here = competitionTiming();
  strip.replaceChildren(); strip.hidden = !active || !here;
  if (!active || !here) { app.competitionRecordingMode = null; return; }
  app.competitionRecordingMode = here ? active.recordingMode : null;
  strip.append(button(`Ao${active.size} · ${t('Set {n}', { n: active.sequence })} · ${t('attempt {i}/{n}', { i: active.solveIds.length+1, n: active.size })}`, () => here ? openCompetitionSet(active.id) : resumeCompetition(active.id), 'competition-progress'),
    ...(here ? [button('Leave view', leaveCompetition)] : [button('Return to set', () => resumeCompetition(active.id))]));
  if (active.recordingMode === 'whole-set') strip.append(el('span', { class: `competition-record-state ${setRecordingLive(active.id) ? 'live' : ''}`, text:
    setRecordingLive(active.id) ? t('Recording') : t('Replay interrupted') }));
}
async function endCapture() {
  if (active && setRecordingLive(active.id)) await stopSetReplay(active.id, false);
}
export async function leaveCompetition() {
  await endCapture(); viewing = false; app.competitionRecordingMode = null; await KV.set('_competitionView', false); paintStrip(); closeCompetition();
}
export async function resumeCompetition(id) {
  const c = await CompetitionSets.get(id);
  if (!c || c.status !== 'active') return openCompetitionSet(id);
  closeCompetition(); active = c; viewing = false;
  if (app.session.id !== c.sessionId) await app.switchSession(c.sessionId);
  // Resume the original event, size and next scramble; no new session.
  await app.prepareCompetition(c.event);
  viewing = true; await KV.set('_competitionView',true);
  app.competitionRecordingMode = c.recordingMode;
  if (c.currentScramble) app.restoreCompetitionScramble(c.currentScramble);
  else await app.nextScramble({ clear: true });
  paintStrip();
}
export function rememberCompetitionScramble(scramble) {
  if (!competitionTiming() || !scramble?.scramble || scramble.race || scramble.hold) return;
  // Sequential patches cannot overwrite committed membership from another tab.
  const id = active.id; active.currentScramble = scramble;
  app.competitionScrambleSaved = CompetitionSets.patch(id, { currentScramble: scramble }, active.solveIds.length+1).catch(err => toast(err.message, {kind:'bad'}));
}
export async function recordCompetitionSolve(solve) {
  if (!competitionTiming()) return false;
  if (app.settings.mode !== 'wca' || solve.event !== active.event || solve.mode !== 'wca' || !compatible() || app.scramble?.official === false || app.custom.list.length > app.custom.pos) {
    throw new Error(t('Return to the set event and Random state mode'));
  }
  const id = active.id, expected = active.solveIds.length + 1;
  const stop = mediaNow(id);
  if (stop !== null) solve.competitionTiming = {
    inspection: capture.inspection, start: capture.start ?? Math.max(0,stop-solve.timeMs), stop,
  };
  solve.competitionRecordedAt = Date.now();
  solve.competitionStartedAt = capture.startAt ?? solve.competitionRecordedAt-solve.timeMs;
  solve.competitionInspectionAt = capture.inspectionAt ?? (solve.inspectionMs ? solve.competitionStartedAt-solve.inspectionMs : null);
  const updated = await CompetitionSets.record(id, solve, expected);
  capture = { inspection: null, start: null };
  if (updated.status === 'complete') {
    active = null; app.competitionRecordingMode = null;
    if (setRecordingLive(id)) await stopSetReplay(id);
    paintStrip();
    // The results open after main.js has redrawn the timer and saved the solve.
    setTimeout(() => openCompetitionSet(id), 0);
  } else { active = updated; paintStrip(); }
  return true;
}
export async function openCompetitionSetup(size = 5) {
  const unfinished = (await CompetitionSets.all()).find(c => c.status === 'active');
  // Switched off from the admin console (config/competition): a set under way can still be finished.
  if (!unfinished && !getConfig('competition', 'enabled')) {
    dialog(t('Competition Mode'), [el('p', { text: getConfig('competition', 'message') || t('Competition Mode is switched off for now') })]); return;
  }
  if (unfinished) {
    dialog(t('Unfinished Competition set'), [
      el('p', { text: t('Ao{n} · {done}/{n} attempts recorded', { n: unfinished.size, done: unfinished.solveIds.length }) }),
      button('Return to set', () => resumeCompetition(unfinished.id)),
      button('Discard entire set', () => deleteCompetition(unfinished.id), 'danger')]); return;
  }
  if (!compatible()) {
    dialog(t('Competition Mode'), [el('p', { text: t('Choose an ordinary timed event and a practice session before starting Competition Mode. Relay, FMC, Multi-Blind, race rooms and virtual sessions are not supported.') })]); return;
  }
  const event = app.settings.event, sessionId = app.session.id;
  const input = el('input', { id: 'competition-size', type: 'text', inputmode: 'numeric', value: String(size), 'aria-label': t('Number of attempts') });
  const canFilm = replaySupported() && !replayOff();
  const recording = el('select', { id: 'competition-recording', 'aria-label': t('Recording') },
    el('option', { value: 'per-solve', text: t('Per-solve replays (default)'), disabled: !canFilm }),
    el('option', { value: 'whole-set', text: t('Record entire AoX'), disabled: !canFilm }),
    el('option', { value: 'none', text: t('No replay') }));
  recording.value = app.settings.webcamReplay && canFilm ? 'per-solve' : 'none';
  const needsSwitch = app.settings.mode !== 'wca' || app.custom.list.length > app.custom.pos;
  const switchMode = el('input', { type: 'checkbox', id:'competition-switch' });
  const error = el('p', { class: 'competition-error', role: 'alert' });
  const attempts = el('p', { class: 'competition-note' });
  const start = button(t('Start Ao{n}',{n:size}), async () => {
    let n; try { n = validateCompetitionSize(input.value); } catch (err) { error.textContent=err.message; return; }
    if (needsSwitch && !switchMode.checked) { error.textContent=t('Select the explicit switch to Random state first.'); return; }
    if (app.session.id !== sessionId || app.settings.event !== event) { error.textContent=t('Session or event changed. Open setup again.'); return; }
    start.disabled=true;
    try {
      if (recording.value === 'whole-set') {
        const budget = await recordingBudget(n);
        if (budget.likelyFull && !await confirmToast(t('Estimated video may exceed local storage. Recording will stop at the limit while timing continues. Record anyway?'), t('Record anyway'), {timeout:15000})) return;
      }
      // Permission is only requested from this explicit Start action.
      if (recording.value !== 'none') {
        if (!await enableReplay()) { error.textContent=t('Camera unavailable. Choose No replay and start again.'); recording.value='none'; return; }
        app.setSetting('webcamReplay',true);
      }
      await app.prepareCompetition(event);
      if (!app.scramble?.scramble || app.scramble.official === false) { error.textContent = t('A Random state scramble is required. Wait for the scrambler and try again.'); return; }
      const all=await CompetitionSets.all();
      const deleted = Object.values(await KV.get('_competitionDeleted', {}));
      const sequence = [...all,...deleted].filter(x=>x.sessionId===sessionId && x.event===event).reduce((max,x)=>Math.max(max,x.sequence||0),0)+1;
      const c = { id:uid(), sessionId, event, size:n, sequence,
        status:'active', solveIds:[], recordingMode:recording.value, replayId:null,
        replayStatus:'none', createdAt:Date.now(), competitor: app.settings.displayName || app.settings.username || 'Cubing practice', currentScramble:app.scramble };
      await CompetitionSets.create(c); active=c; viewing=true; await KV.set('_competitionView',true);
      app.competitionRecordingMode=c.recordingMode;
      if (c.recordingMode==='whole-set') {
        try {
          const m = await startSetReplay(c, async meta => {
            await CompetitionSets.patch(c.id, { replayStatus:meta.status, replayReason:meta.reason, replayDurationMs:meta.durationMs, replayBytes:meta.bytes });
            if (active?.id===c.id) active=await CompetitionSets.get(c.id);
            paintStrip();
            if (meta.status!=='ready') toast(t('Full replay interrupted: {reason}. Timing continues.',{reason:meta.reason}),{kind:'bad',hold:true});
          });
          active=await CompetitionSets.patch(c.id,{ replayId:c.id,replayStatus:'recording',replayStartedAt:m.startedAt });
        } catch(err) {
          active=await CompetitionSets.patch(c.id,{replayStatus:'failed', replayReason:err.message});
          toast(t('Full replay unavailable. Timing continues without replay.'),{kind:'bad',hold:true});
        }
      }
      closeCompetition(); paintStrip(); app.redrawCompetition();
    } finally { start.disabled=false; }
  },'primary');
  const update = () => {
    try { const n=validateCompetitionSize(input.value); error.textContent=''; attempts.textContent=t('{n} attempts',{n}); start.textContent=t('Start Ao{n}',{n}); }
    catch(err) { attempts.textContent=''; error.textContent=err.message; }
  };
  input.addEventListener('input', update);
  dialog(t('Start Competition Mode'), [
    el('p',{class:'competition-event',text:`${eventOf(event).name} · ${app.session.name}`}),
    el('div',{class:'competition-chips'},button('Ao5',()=>{input.value='5';update();}),button('Ao12',()=>{input.value='12';update();}),button('Custom…',()=>{input.focus();input.select();})),
    el('label',{},t('Set size'),input),attempts,
    ...(needsSwitch ? [el('label',{},switchMode,t('Switch to Random state and stop using pasted scrambles for this set'))] : []),
    el('label',{},t('Recording'),recording),
    el('p',{class:'competition-note',text:t('Camera access is requested only when you start with replay. Entire AoX recording includes gaps, up to 30 minutes or 256 MiB; the set itself has no small size limit. Switching tabs or sleeping interrupts full replay. Videos stay on this device.')}),
    error,start]); update();
}
export async function deleteCompetition(id) {
  const c=await CompetitionSets.get(id); if(!c)return;
  if (!await confirmToast(t('Delete entire Ao{n}: {count} recorded attempts and all associated local replays? This cannot be undone.',{n:c.size,count:c.solveIds.length}),t('Delete entire average'),{timeout:15000}))return;
  if(setRecordingLive(id))await stopSetReplay(id,false);
  await CompetitionSets.delete(id);
  try { await cleanupCompetitionMedia(); } catch(err) { console.warn('[competition] media cleanup will retry at next startup',err); }
  if(active?.id===id)active=null;
  await app.reloadCompetitionSolves();
  closeCompetition();paintStrip();toast(t('Entire Competition average deleted'));
}
export async function openCompetitionHistory() {
  const sets=(await CompetitionSets.all()).filter(c=>c.status!=='discarded');
  const scope=el('select',{'aria-label':t('Filter Competition history')},el('option',{value:'session',text:t('Current session')}),el('option',{value:'event',text:t('Current event')}),el('option',{value:'all',text:t('All sets')}));
  const rows=el('div',{class:'competition-history'});
  let page=0;
  const render=async()=>{
    const filtered=sets.filter(c=>scope.value==='all'||(scope.value==='session'?c.sessionId===app.session.id:c.event===app.settings.event)).sort((a,b)=>(a.status==='active'?-1:0)-(b.status==='active'?-1:0)||b.createdAt-a.createdAt);
    rows.replaceChildren();
    for(const c of filtered.slice(page*20,page*20+20)){
      const ss=await CompetitionSets.members(c), r=competitionResult(c,ss);
      rows.append(button(`${eventOf(c.event).name} · Ao${c.size} · ${new Date(c.createdAt).toLocaleString()} · ${c.status==='active'?t('{done}/{n} attempts',{done:c.solveIds.length,n:c.size}):fmtResult(r.value)}`,()=>openCompetitionSet(c.id)));
    }
    if(!filtered.length)rows.append(el('p',{text:t('No Competition sets here yet')}));
    if(filtered.length>20)rows.append(el('div',{class:'competition-chips'},button('Previous',()=>{page=Math.max(0,page-1);return render();}),el('span',{text:`${page+1}/${Math.ceil(filtered.length/20)}`}),button('Next',()=>{page=Math.min(Math.ceil(filtered.length/20)-1,page+1);return render();})));
  };
  scope.addEventListener('change',()=>{page=0;render();});
  dialog(t('Competition history'),[scope,rows]);dialogKind='history';await render();
}
export async function openCompetitionSet(id, page=0) {
  const c=await CompetitionSets.get(id);if(!c||c.status==='discarded'){closeCompetition();return;}
  const ss=await CompetitionSets.members(c),r=competitionResult(c,ss);
  const name=el('input',{value:c.competitor||'Cubing practice',maxlength:120,'aria-label':t('Competitor')});
  name.addEventListener('change',()=>CompetitionSets.patch(c.id,{competitor:name.value.trim()||'Cubing practice'}));
  const rows=el('ol',{class:'competition-attempts',start:page*20+1});
  ss.slice(page*20,page*20+20).forEach((s,offset)=>{
    const i=page*20+offset;
    if(!s){rows.append(el('li',{text:t('Attempt is still syncing. Result unavailable until all attempts arrive.')}));return;}
    const pen=el('select',{'aria-label':t('Penalty for attempt {n}',{n:i+1})},...['none','+2','DNF'].map(p=>el('option',{value:p,text:p==='none'?t('No penalty'):p})));
    pen.value=s.penalty;
    pen.addEventListener('change',async()=>{
      s.penalty=pen.value;s.penaltyUpdatedAt=Date.now();await Solves.put(s);
      const liveSolve=app.solves.find(x=>x.id===s.id);if(liveSolve)Object.assign(liveSolve,s);
      app.redrawCompetition();await openCompetitionSet(id,page);
    });
    const details=el('details',{},el('summary',{text:t('Scramble and raw time')}),el('p',{class:'mono',text:s.scramble}),el('small',{text:t('Raw time: {time}',{time:fmt(s.timeMs)})}));
    rows.append(el('li',{class:r.trimmed.has(i)?'trimmed':''},el('div',{class:'competition-attempt-head'},el('strong',{text:r.trimmed.has(i)?`(${competitionTime(s)})`:competitionTime(s)}),pen),details,
      ...(c.recordingMode==='per-solve' && hasReplay(s.id) ? [button('Watch replay',()=>{closeCompetition();openReplay(s);})] : [])));
  });
  const nodes=[el('p',{class:'competition-event',text:`${eventOf(c.event).name} · ${t('Set {n}',{n:c.sequence})} · ${new Date(c.createdAt).toLocaleString()}`}),
    el('label',{},t('Competitor'),name),el('p',{class:'competition-final',text:c.status==='active'?t('{done}/{n} attempts recorded',{done:c.solveIds.length,n:c.size}):`${t('FINAL RESULT')}  ${fmtResult(r.value)}`}),
    el('p',{class:'competition-note',text:t('Competition practice · parentheses mark trimmed attempts. Penalty corrections keep the measured raw time. Individual attempts cannot be deleted.')}),rows];
  if(ss.length>20)nodes.push(el('div',{class:'competition-chips'},button('Previous',()=>openCompetitionSet(id,Math.max(0,page-1))),el('span',{text:`${page+1}/${Math.ceil(ss.length/20)}`}),button('Next',()=>openCompetitionSet(id,Math.min(Math.ceil(ss.length/20)-1,page+1)))));
  if(r.complete)nodes.push(button('Share score sheet',async()=>{await CompetitionSets.patch(c.id,{competitor:name.value.trim()||'Cubing practice'});closeCompetition();const {shareCompetitionCard}=await import('./sharedlg.js');await shareCompetitionCard(await CompetitionSets.get(id),await CompetitionSets.members(c));}));
  if(c.recordingMode==='whole-set'){
    const meta=await recoverSetReplay(id);
    nodes.push(el('p',{class:'competition-note',text:meta?`${meta.status==='ready'?t('Full replay'):t('Interrupted footage')} · ${fmt(meta.durationMs)} · ${(meta.bytes/1048576).toFixed(1)} MiB${meta.reason?' · '+meta.reason:''}`:t('Replay is stored on the original device, or no footage survived')}));
    if(meta?.bytes){
      if (!setRecordingLive(id)) nodes.push(button('Watch & save video',()=>watchSet(c,ss),'primary'));
    }
  }
  nodes.push(el('div',{class:'competition-chips'},
    ...(c.status==='active'?[button('Return to set',()=>resumeCompetition(c.id))]:[button(t('Start another Ao{n}',{n:c.size}),()=>openCompetitionSetup(c.size))]),
    button('Done',closeCompetition),button(c.status==='active'?'Discard entire set':'Delete entire average',()=>deleteCompetition(c.id),'danger')));
  dialog(`Ao${c.size} · ${t('Competition average')}`,nodes);dialogKind='result';dialogSetId=id;
}
async function watchSet(c,ss){
  const replay=await loadSetReplay(c.id);if(!replay)return;
  closeCompetition();
  const { openCompetitionPlayer } = await import('./replay-player.js');
  openCompetitionPlayer(c,ss,replay);
}
