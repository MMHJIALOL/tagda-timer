import { t } from './i18n.js';
import { SmartStream, SOLVED, SCHEMA, MAX_MOVES, MAX_RAW, MAX_BYTES, scrambleState, timeline, validateCapture } from './smart-cube-core.js';
import { SmartPreview, faceletsTransformation } from './smart-cube-preview.js';
import { ScrambleGuide, highlightScramble } from './smart-cube-scramble.js';
import { KV, Solves, SmartCaptures, hasUnsavedLocalChange } from './db.js';

const JOURNAL = 'smartCube.active';
const text = (node, value) => { node.textContent = t(value); };
const button = (label, fn) => { const b = document.createElement('button'); b.type = 'button'; text(b, label); b.onclick = fn; return b; };
export class SmartCubeController {
  constructor({ host, timer, context, save, notice, switchInput, scrambleHost = null, preferences = () => ({}), openSettings = () => {} }) {
    Object.assign(this, { host, timer, context, save, notice, scrambleHost, preferences, switchInput });
    this.epoch = 0; this.connectionState = navigator.bluetooth && isSecureContext ? 'disconnected' : 'unsupported'; this.attemptState = 'idle';
    this.allowed = false; this.active = null; this.connection = null; this.protocol = null; this.journalLock = Promise.resolve();
    host.classList.add('smart-live');
    const header=document.createElement('div');header.className='smart-live-header';
    this.status=document.createElement('span');this.status.role='status';this.status.className='smart-connection';this.status.setAttribute('aria-live','polite');
    this.connectButton=button('Connect cube',()=>this.connection?this.disconnect():this.connect());this.connectButton.className='smart-live-connect';
    this.settingsButton=button('Cube settings',openSettings);
    this.settingsButton.className='smart-device-settings';
    this.settingsButton.title=t('Cube settings');this.settingsButton.setAttribute('aria-label',t('Cube settings'));
    this.settingsButton.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z"/><circle cx="12" cy="12" r="3"/></svg>';
    header.append(this.status,this.connectButton,this.settingsButton);
    const previewHost=document.createElement('div');previewHost.className='smart-live-cube';this.preview=new SmartPreview(previewHost);
    this.message=document.createElement('p');this.message.className='smart-live-message';
    this.progress=document.createElement('div');this.progress.className='smart-scramble-progress';this.progress.innerHTML='<span></span>';
    this.armButton=button('Start inspection',()=>this.inspect());this.armButton.className='smart-arm';
    this.cancelButton=button('Interrupt attempt',()=>this.interrupt('Interrupted by user'));this.cancelButton.className='smart-interrupt';
    this.guidanceBox = document.createElement('div');
    this.guidanceBox.className = 'smart-guide-correction';
    this.guidanceBox.hidden = true;
    this.guidanceBox.setAttribute('role', 'status');
    this.guidanceTitle = document.createElement('span');
    this.guidanceTitle.className = 'smart-guide-title';
    this.guidanceMove = document.createElement('strong');
    this.guidanceMove.className = 'smart-guide-turn';
    this.guidanceTail = document.createElement('span');
    this.guidanceTail.className = 'smart-guide-tail';
    this.guidanceBox.append(this.guidanceTitle, this.guidanceMove, this.guidanceTail);
    const footer=document.createElement('div');footer.className='smart-live-footer';footer.append(this.guidanceBox,this.message,this.progress,this.armButton,this.cancelButton);
    this.recovery=document.createElement('div');this.recovery.className='smart-recovery';
    host.append(header,previewHost,footer,this.recovery);
    this.checkpointTimer = setInterval(() => { if (this.active?.moves.length) this.checkpoint(); this.sync(); }, 500);
    this.onPageHide = () => { if (this.active?.moves.length) this.emergency(); };
    window.addEventListener('pagehide', this.onPageHide);
    this.onVisibility = () => { if (!document.hidden) { if (this.active) void this.requestState(); this.render(); } };
    this.onFreeze = () => this.interrupt('Browser suspended during attempt');
    document.addEventListener('freeze',this.onFreeze);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.onTimerCancel = () => { if (this.active) { this.interrupt('Timer reset during attempt'); this.match(false); this.render(); } };
    this.timer.addEventListener('cancel',this.onTimerCancel);
    this.configurePreview();
    this.preview.set(null);
    void this.restore(); this.render();
  }
  configurePreview() {
    const settings = this.preferences();
    this.preview.hints(settings.smartCubeHints !== false);
    this.preview.net(!!settings.smartCubeNet || matchMedia('(prefers-reduced-motion: reduce)').matches);
  }
  async calibrate() {
    if (!this.connection || !window.confirm(t('Physically solve the cube first. Confirm that all six faces are solved before resetting its internal state.'))) return;
    this.interrupt('Cube calibration');
    this.lastCapture = null;
    this.stream.state = null;
    this.stream.serial = null;
    this.stream.history.clear();
    this.stream.moveHistory.clear();
    this.stream.positions.clear();
    this.connectionState = 'reading initial state';
    try {
      await this.connection.sendCubeCommand({ type:'REQUEST_RESET' });
      await this.requestState();
    } catch (error) { this.notice(error.message); }
    this.render();
  }
  sync() {
    const next = this.context();
    const key = JSON.stringify([next.sessionId, next.event, next.mode, next.scramble, next.inspection, next.allowed, next.ownerUid]);
    if (key !== this.contextKey) {
      if (this.active) this.interrupt('Input, session, event, scramble or settings changed');
      this.contextKey = key; this.frozen = structuredClone(next); this.allowed = next.allowed;
      this.target = next.allowed && next.scramble ? scrambleState(next.scramble) : null;
      this.guide = this.target ? new ScrambleGuide(next.scramble) : null;
      this.recoveryGuide = null;
      this.guidanceError = false;
      this.attemptState = this.target ? 'scrambling' : 'idle';
      this.match();
    }
    this.render();
  }
  match(autoInspect = true) {
    if (this.active || this.attemptState === 'finalising' || !this.allowed || !this.stream?.state || !this.target) return;
    this.guide?.synchronize(this.stream.state);
    if (this.guide?.anchored) this.recoveryGuide = null;
    else void this.planGuidance();
    const wasMatched = this.attemptState === 'scramble matched';
    this.attemptState = this.stream.state === this.target ? (this.frozen.inspection ? 'scramble matched' : 'armed') : 'scrambling';
    // State notifications may repeat; only entering the matched state starts inspection.
    // A cancelled inspection stays ready until another turn or an explicit restart.
    if (autoInspect && !wasMatched && this.attemptState === 'scramble matched') this.inspect();
  }
  async planGuidance() {
    if (!this.guide || this.guide.anchored || this.recoveryGuide || this.guidancePlanning || this.active || !this.allowed || !this.stream?.state) return;
    const guide = this.guide;
    const state = this.stream.state;
    const epoch = this.epoch;
    this.guidancePlanning = true;
    this.guidanceError = false;
    try {
      const [{ f: puzzles }, { c: solve333 }] = await Promise.all([
        import('../vendor/cubing/chunks/chunk-BI4EPFJB.js'),
        import('../vendor/cubing/chunks/chunk-JHPJDX35.js'),
      ]);
      const puzzle = await puzzles['3x3x3'].kpuzzle();
      const pattern = puzzle.defaultPattern().applyTransformation(faceletsTransformation(puzzle, state));
      const solution = await solve333(pattern);
      if (epoch !== this.epoch || guide !== this.guide || !this.allowed || this.active || state !== this.stream?.state) return;
      const recovery = new ScrambleGuide(solution.toString(), state);
      if (recovery.target !== SOLVED) throw new Error('Guidance did not restore solved state');
      recovery.synchronize(state);
      this.recoveryGuide = recovery;
    } catch {
      if (epoch === this.epoch && guide === this.guide) this.guidanceError = true;
    } finally {
      this.guidancePlanning = false;
      const superseded = epoch !== this.epoch || guide !== this.guide || state !== this.stream?.state;
      if (superseded) void this.planGuidance();
      this.render();
    }
  }
  inspect() {
    if (this.attemptState !== 'scramble matched' || !this.allowed || this.timer.state !== 'idle' || !this.timer.inspectionEnabled) return;
    this.begin(); this.attemptState = 'inspection'; this.timer.startInspection(); this.render();
  }
  begin(initial = this.stream.state, at = performance.now()) {
    this.active = { id: crypto.randomUUID(), solveId: '', schemaVersion: SCHEMA, revision: 0,
      ownerUid: this.frozen.ownerUid || null, createdAt: Date.now(), createdMonotonic: at, context: structuredClone(this.frozen),
      initialFacelets: initial, scrambleVerified: initial === this.target,
      timingConvention: 'first-turn-to-final-turn', connections: [{ epoch: this.epoch, deviceModel: this.deviceName || 'GAN', hardware: this.hardware || {} }],
      moves: [], rawEvents: [], qualityIssues: [], annotations: [], analysisConfig: { profile: 'unknown', crossFace: 'D', pauseThresholdMs: 500 }, analysisVersion: 1 };
    this.active.solveId = this.active.id;
  }
  async connect() {
    if (!this.protocol || this.connectionState === 'requesting permission') return;
    const epoch = ++this.epoch; this.connectionState = 'requesting permission'; this.render();
    try {
      // No await before this call: requestDevice retains click activation.
      const pending = this.protocol.connectGanCube(async (device, fallback) => {
        if (epoch !== this.epoch) return null;
        this.connectionState='connecting';this.render();
        if (!fallback) return null;
        const value = window.prompt(t('Enter the Bluetooth address printed on your cube (used locally only):'));
        if (!value) return null;
        if (!/^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(value.trim())) throw new Error(t('Invalid Bluetooth address'));
        return value.trim();
      });
      const conn = await pending;
      if (epoch !== this.epoch) { await conn.disconnect(); return; }
      this.connection = conn; this.deviceName = conn.deviceName; this.hardware = null;
      this.connectionState = 'reading initial state';
      this.stream = new SmartStream({ epoch, onMove: (raw, before, after) => this.move(raw, before, after),
        onState: state => { this.connectionState = 'connected'; try { this.preview.set(state); } catch { if (!this.previewFailed) this.notice(t('Preview unavailable; capture continues.')); this.previewFailed = true; } this.match(); this.render(); },
        onIssue: (reason,evidence) => {
          this.interrupt(reason);
          this.guide?.synchronize(null);
          this.recoveryGuide = null;
          const position = this.stream.positions.get(evidence?.serial), last=this.lastCapture;
          if (last?.completeness === 'complete' && last.connections[0].epoch === this.stream.epoch && /disagrees|mismatch/i.test(reason) && position >= last.moves[0]?.position && position <= last.moves.at(-1)?.position) void this.invalidateLast(reason,evidence);
          this.notice(t(reason)); void this.requestState();
        } });
      this.subscription = conn.events$.subscribe(event => {
        if (epoch !== this.epoch) return;
        this.lastReceived = performance.now();
        if (event.type === 'DISCONNECT') { void this.disconnect('Bluetooth disconnected'); return; }
        if (this.active && event.type !== 'GYRO') {
          this.active.rawCount = (this.active.rawCount || 0) + 1;
          this.active.rawBytes = (this.active.rawBytes || 0) + JSON.stringify(event).length + 100;
          if (this.active.rawCount >= MAX_RAW - 1 || this.active.rawBytes > MAX_BYTES * .4) this.interrupt('Capture evidence limit reached');
        }
        if (event.type === 'HARDWARE') this.hardware = structuredClone(event);
        if (event.type === 'BATTERY') this.battery = event.batteryLevel;
        this.stream.ingest(event);
      });
      // Subscribe before ANY command: FACELETS can precede command resolution.
      await conn.sendCubeCommand({ type: 'REQUEST_FACELETS' });
      for (const type of ['REQUEST_HARDWARE','REQUEST_BATTERY']) { if (epoch === this.epoch) await conn.sendCubeCommand({ type }); }
      if (epoch === this.epoch && !this.stream.state) { this.connectionState = 'initial state missing'; this.render(); }
    } catch (error) {
      if (epoch !== this.epoch) return;
      await this.disconnect();
      this.connectionState = error.name === 'NotFoundError' ? 'chooser cancelled' : error.name === 'NotAllowedError' || error.name === 'SecurityError' ? 'permission denied' : 'connection error';
      this.notice(`${t(this.connectionState)}: ${error.message}`); this.render();
    }
  }
  async requestState() {
    if (this.requestPending) return;
    this.requestPending = true;
    const epoch = this.epoch;
    try { await Promise.resolve(); if (epoch === this.epoch) await this.connection?.sendCubeCommand({ type: 'REQUEST_FACELETS' }); }
    catch (e) { this.notice(t('Could not read cube state. Reconnect and retry.')); }
    finally { this.requestPending = false; }
  }
  async disconnect(reason = 'Cube disconnected') {
    this.interrupt(reason); ++this.epoch;
    this.subscription?.unsubscribe(); this.subscription = null;
    const conn = this.connection; this.connection = null; this.stream = null;
    this.connectionState = 'disconnected';
    this.guide?.synchronize(null);
    this.recoveryGuide = null;
    try { this.preview.set(null); } catch {} this.render();
    try { await conn?.disconnect(); } catch { /* Already disconnected. */ }
  }
  move(raw, before, after) {
    this.preview.turn?.(raw.move,before,after);
    this.sync();
    if (!this.allowed) return;
    if (!this.active && this.attemptState !== 'armed') {
      this.guide?.observe(raw.move, before, after);
      this.recoveryGuide?.observe(raw.move, before, after);
      if (this.guide?.anchored) this.recoveryGuide = null;
    }
    if (this.attemptState === 'scramble matched') { this.match(); return; } // a cancelled inspection waits for a new scramble or an explicit restart
    if (this.attemptState === 'armed' && !this.active) { this.begin(before, raw.receivedMonotonic); }
    if (!this.active) return;
    if (!this.active.moves.length) {
      this.active.initialFacelets = before; this.active.penalty = 'none';
      this.timer.start(raw.receivedMonotonic); this.attemptState = 'running';
      this.active.inspectionMs = this.timer.inspectElapsed;
      this.active.penalty = this.timer.pendingPenalty || 'none';
    }
    this.active.moves.push({ ...raw, index: this.active.moves.length });
    this.active.moveBytes = (this.active.moveBytes || 0) + JSON.stringify(raw).length;
    if (this.active.moves.length >= MAX_MOVES || this.active.moveBytes > MAX_BYTES / 2) { this.interrupt('Capture limit reached'); return; }
    if (after === SOLVED) void this.finish('complete');
  }
  checkpoint() {
    if (!this.active) return;
    const value = structuredClone(this.active);
    value.rawEvents = this.stream.raw.filter(e => e.receivedMonotonic >= this.active.createdMonotonic);
    this.emergency(value);
    this.pendingJournal = value;
    if (this.journalWriting) return;
    this.journalWriting = true;
    this.journalLock = this.journalLock.catch(() => {}).then(async () => {
      while (this.pendingJournal) { const latest = this.pendingJournal; this.pendingJournal = null; await KV.set(JOURNAL, latest); }
    }).catch(() => this.notice(t('Active capture is unsaved. Export recovery before closing.'))).finally(() => { this.journalWriting = false; });
  }
  emergency(value = this.active) { try { localStorage.setItem('tagda:smartCube.active', JSON.stringify(value)); } catch { this.notice(t('Active capture is unsaved. Export recovery before closing.')); } }
  interrupt(reason) {
    if (!this.active) { this.attemptState = 'idle'; return; }
    this.active.qualityIssues.push(reason);
    if (this.active.moves.length) void this.finish('interrupted');
    else { this.active = null; this.timer.reset(); this.attemptState = 'idle'; }
  }
  async finish(completeness) {
    const active = this.active; if (!active) return;
    this.active = null; this.attemptState = 'finalising'; this.timer.reset();
    const capture = { ...active, ...timeline(active.moves, this.protocol?.cubeTimestampLinearFit), completeness, rawEvents: this.stream?.raw.filter(e => e.receivedMonotonic >= active.createdMonotonic) || active.rawEvents, endedAt: Date.now() };
    if (completeness !== 'complete') capture.penalty = 'DNF';
    try { validateCapture(capture); } catch(e) { this.notice(e.message); this.showRecovery(capture); this.emergency(capture); return; }
    // Stage evidence before the central solve path. Stable ID survives retries.
    this.emergency(capture);
    try {
      this.lastCapture = capture; this.saveTask = this.save(capture);
      await this.saveTask;
      const saved = await Solves.get(capture.id);
      if (!saved || hasUnsavedLocalChange('solves', capture.id)) throw new Error(t('Solve could not be saved'));
      this.attemptState = completeness === 'complete' ? 'saved' : 'interrupted';
      this.journalLock = this.journalLock.catch(() => {}).then(() => KV.del(JOURNAL)); await this.journalLock;
      localStorage.removeItem('tagda:smartCube.active');
    } catch (e) { this.notice(e.message); this.showRecovery(capture); }
    this.render();
  }
  async invalidateLast(reason,evidence) {
    const original=this.lastCapture;
    this.lastCapture={...original,completeness:'interrupted'};
    await this.saveTask?.catch(()=>{});
    const latest=await SmartCaptures.get(original.id) || original;
    const capture={...latest,completeness:'interrupted',penalty:'DNF',revision:(latest.revision||0)+1,qualityIssues:[...(latest.qualityIssues||[]),reason],postSolveEvidence:[evidence]};
    this.lastCapture=capture;
    try { await this.save(capture);this.attemptState='interrupted';this.render(); } catch(e) { this.emergency(capture);this.showRecovery(capture);this.notice(e.message); }
  }
  showRecovery(capture) {
    this.recovery.replaceChildren(document.createTextNode(t('Recovered interrupted or unsaved capture.')),
      button('Retry saving', async () => { try { await this.save(capture); this.recovery.replaceChildren(); await KV.del(JOURNAL); localStorage.removeItem('tagda:smartCube.active'); } catch(e) { this.notice(e.message); } }),
      button('Export capture', () => { const a = document.createElement('a'); const url = URL.createObjectURL(new Blob([JSON.stringify(capture, null, 2)], { type:'application/json' })); a.href = url; a.download = `smart-cube-${capture.id}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }));
  }
  async restore() {
    try {
      const db = await KV.get(JOURNAL), emergency = JSON.parse(localStorage.getItem('tagda:smartCube.active') || 'null');
      const raw = emergency || db;
      if (!raw || await Solves.get(raw.id)) return;
      const capture = { ...raw, ...timeline(raw.moves, null), completeness: 'interrupted', penalty: 'DNF', qualityIssues: [...raw.qualityIssues, 'Recovered after reload; hardware interval unknown'] };
      this.showRecovery(capture);
    } catch (e) { this.notice(t('Recovery could not be read. Export local data before clearing storage.')); }
  }
  async load() {
    try { this.protocol = await import('../vendor/gan/gan-3.0.2.js'); this.render(); }
    catch { this.notice(t('Bluetooth code could not load. Check the connection and retry.')); }
  }
  render() {
    if(document.hidden)return;
    this.host.dataset.attempt=this.attemptState;this.host.dataset.connected=String(!!this.connection);
    const connected=this.connectionState==='connected';
    const label=connected?(this.deviceName?.includes('Simulated')?'Demo cube':this.deviceName||'GAN connected'):t(this.connectionState);
    this.status.textContent=`${label}${connected&&this.battery!=null?` · ${this.battery}%`:''}`;
    this.status.classList.toggle('on',connected);
    text(this.connectButton,this.connection?'Disconnect':'Connect cube');
    this.connectButton.disabled=!this.protocol||this.connectionState==='unsupported'||['requesting permission','connecting'].includes(this.connectionState);
    this.settingsButton.hidden=!connected;
    if (this.reportedConnection !== connected) {
      this.reportedConnection = connected;
      this.host.dispatchEvent(new CustomEvent('smart-cube-connection-change', { bubbles:true, detail:{connected} }));
    }
    this.armButton.disabled=this.attemptState!=='scramble matched'||!this.allowed;this.armButton.hidden=this.armButton.disabled;
    this.cancelButton.disabled=!this.active;this.cancelButton.hidden=!this.active;
    highlightScramble(this.scrambleHost, this.guide, this.allowed && !!this.guide);
    const completed = this.guide?.anchored ? this.guide.completed : 0;
    const moveCount = this.guide?.tokens.length || 0;
    const fraction = completed + (this.guide?.partial ? 0.5 : 0);
    this.progress.firstElementChild.style.width = `${moveCount ? fraction / moveCount * 100 : 0}%`;
    let correction = this.guide?.corrections || [];
    let restoring = false;
    if (!correction.length && this.recoveryGuide) {
      restoring = true;
      correction = this.recoveryGuide.corrections;
      if (!correction.length) {
        correction = this.recoveryGuide.tokens.slice(this.recoveryGuide.completed);
        if (this.recoveryGuide.partial) correction[0] = this.recoveryGuide.nextTurn;
      }
    }
    const fixing = connected && this.allowed && !this.active && this.attemptState === 'scrambling' && correction.length > 0;
    this.host.dataset.correcting = String(!!fixing);
    this.guidanceBox.hidden = !fixing;
    if (fixing) {
      this.guidanceTitle.textContent = t(restoring ? 'Restore starting position' : 'Wrong turn · do this to fix it');
      this.guidanceMove.textContent = correction[0];
      const remaining = correction.slice(1, 7).join(' ');
      this.guidanceTail.textContent = remaining ? `${t('then')} ${remaining}${correction.length > 7 ? ' …' : ''}` : t('then continue the highlighted scramble');
    }
    this.progress.hidden=!connected||!this.allowed||this.attemptState!=='scrambling';
    this.message.textContent=!this.allowed?t('Smart cube timing supports standard 3×3 practice only. Switch input in Cube settings.'):
      this.connectionState==='unsupported'?t('Bluetooth is unavailable here. Use Chrome or Edge, or switch input in Cube settings.'):
      !this.connection?t('Connect your cube to begin'):
      this.attemptState==='running'?t('Recording every turn'):
      this.attemptState==='inspection'?t('First turn starts the timer'):
      ['armed','scramble matched'].includes(this.attemptState)?t('Scramble matched · ready to solve'):
      this.attemptState==='saved'?t('Solve saved · click the time to analyse'):
      fixing ? t('Follow the correction above') :
      this.guidancePlanning ? t('Finding a route from your current position…') :
      this.guide && !this.guide.anchored ? t('Return the cube to solved to begin guided scrambling') :
      `${t('Follow the scramble')} · ${completed}/${moveCount}`;
  }
  dispose() { highlightScramble(this.scrambleHost, this.guide, false); this.timer.removeEventListener('cancel',this.onTimerCancel); clearInterval(this.checkpointTimer); window.removeEventListener('pagehide',this.onPageHide); document.removeEventListener('visibilitychange',this.onVisibility); document.removeEventListener('freeze',this.onFreeze); void this.disconnect(); this.preview.dispose(); }
}
