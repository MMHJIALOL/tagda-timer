// GANic4 firmware 1.0 sends useful facelets with an unusable (always zero)
// snapshot counter. Keep its raw evidence, and infer snapshot positions only
// when their physical state matches an actually observed turn history.
import { applyTurn as turnState } from './gan-facelets.js';

export const isGanCarry4 = name => /^GANic4(?:_|$)/i.test(name || '');
export const CARRY4_PATCH = 'carry4-state-sync-1';
export const CARRY4_WAIT_MS = 3000;

export class Carry4State {
  constructor(emit, { schedule = setTimeout, cancel = clearTimeout, clock = () => performance.now(), onReset = () => {} } = {}) {
    Object.assign(this, { emit, schedule, cancel, clock, onReset });
    this.history = []; this.pending = new Map(); this.queued = [];
  }
  dispose() { this.cancel(this.timer); this.timer = null; }
  reset(snapshot = null) {
    this.dispose(); this.snapshot = snapshot; this.state = null; this.serial = null;
    this.history = []; this.pending.clear(); this.queued = []; this.ready = false;
    this.publishedSerial = null;
    this.started = null; this.onReset();
  }
  normalized(snapshot, serial) {
    return { ...snapshot, serial, originalSerial: snapshot.serial,
      snapshotSequence: 'inferred-from-state', protocolPatch: CARRY4_PATCH };
  }
  remember(serial, state) {
    this.history.push({ serial, state });
    if (this.history.length > 96) this.history.shift();
  }
  publish(event) {
    if (event.type === 'MOVE' || (event.type === 'FACELETS' && this.publishedSerial == null)) this.publishedSerial = event.serial;
    this.emit(event);
  }
  drain() {
    const queued = this.queued; this.queued = [];
    for (const event of queued) this.publish(event);
  }
  uncertain(snapshot, reason = 'Cube state mismatch') {
    const event = { type: 'STATE_UNCERTAIN', reason, serial: this.publishedSerial ?? this.serial,
      expected: this.state, facelets: snapshot?.facelets, originalSnapshot: snapshot,
      protocolPatch: CARRY4_PATCH };
    this.reset(snapshot);
    this.emit(event);
  }
  armDeadline(now) {
    this.dispose();
    const deadlines = [...this.pending.values()].map(p => p.deadline);
    if (!this.ready && this.started != null) deadlines.push(this.started + CARRY4_WAIT_MS);
    if (deadlines.length) this.timer = this.schedule(() => this.expire(), Math.max(0, Math.min(...deadlines) - now));
  }
  expire(now = this.clock()) {
    if ((!this.ready && this.started != null && now >= this.started + CARRY4_WAIT_MS)
      || [...this.pending.values()].some(p => now >= p.deadline)) {
      this.uncertain([...this.pending.values()].at(-1)?.event || this.snapshot);
    } else this.armDeadline(now);
  }
  accept(event, now = this.clock()) {
    this.expire(now);
    if (event.type === 'FACELETS') {
      this.snapshot = structuredClone(event);
      if (this.state == null) return; // Need a real move to establish the counter.
      if (!this.ready) {
        // Do not expose an initial state or enable timing until a later snapshot
        // independently confirms the bootstrap turns. A wake turn + undo works.
        if (event.facelets !== this.state) return;
        this.ready = true;
        this.drain();
      }
      const match = this.history.findLast(p => p.state === event.facelets);
      if (match) {
        const normalized = this.normalized(event, match.serial);
        if (this.pending.size) this.queued.push(normalized); else this.publish(normalized);
      }
      else {
        const previous = this.pending.get(event.facelets);
        this.pending.set(event.facelets, { event: structuredClone(event), deadline: previous?.deadline ?? now + CARRY4_WAIT_MS });
        if (this.pending.size > 16) { this.uncertain(event); return; }
      }
      this.armDeadline(now);
      return;
    }
    if (event.type !== 'MOVE') { this.emit(event); return; }
    const serial = event.serial & 255;
    const move = { ...event, serial, originalSerial: event.serial, protocolPatch: CARRY4_PATCH };
    if (this.state == null) {
      // History before the first live notification is not part of this connection.
      if (!this.snapshot || event.cubeTimestamp == null || event.localTimestamp == null) return;
      this.state = this.snapshot.facelets; this.serial = (serial - 1) & 255;
      this.remember(this.serial, this.state);
      this.queued.push(this.normalized(this.snapshot, this.serial));
      this.started = now;
    }
    if (serial === this.serial) return;
    if (((serial - this.serial) & 255) !== 1) {
      this.uncertain(this.snapshot, 'Missing or out-of-order turns'); return;
    }
    try { this.state = turnState(this.state, move.move); }
    catch { this.uncertain(this.snapshot, 'Invalid cube state or turn'); return; }
    this.serial = serial; this.remember(serial, this.state);
    // Hold turns behind an unconfirmed snapshot. A possibly solved turn cannot
    // finish a timer while contradictory or ahead-of-turn evidence is pending.
    if (this.ready && !this.pending.size) this.publish(move); else this.queued.push(move);
    for (const [facelets, pending] of this.pending) {
      const match = this.history.findLast(p => p.state === facelets);
      if (match) { this.pending.delete(facelets); this.queued.push(this.normalized(pending.event, match.serial)); }
    }
    if (this.ready && !this.pending.size) this.drain();
    if (this.queued.length > 128) { this.uncertain(this.snapshot, 'Unconfirmed cube turn history'); return; }
    this.armDeadline(now);
  }
}

// gan-web-bluetooth 3.0.2 exposes the connection's driver. Apply this narrow
// compatibility adapter before any read command; other models keep that driver.
export function patchGanCarry4Connection(connection, { diagnostics = false, clock, schedule, cancel } = {}) {
  if (!isGanCarry4(connection.deviceName)) return connection;
  const driver = connection.driver;
  if (!driver?.handleStateEvent || !Array.isArray(driver.moveBuffer)) throw new Error('i Carry 4 protocol adapter requires gan-web-bluetooth 3.0.2.');
  const handle = driver.handleStateEvent.bind(driver);
  const command = driver.createCommandMessage.bind(driver);
  let firstLive = true, latestLiveSerial = null, packets = 0;
  const stream = new Carry4State(event => connection.events$.next(event), {
    clock, schedule, cancel,
    onReset: () => { firstLive = true; latestLiveSerial = null; driver.moveBuffer = []; }
  });
  // A zero snapshot counter must never request history from an unrelated cycle.
  driver.checkIfMoveMissed = async () => {};
  driver.handleStateEvent = async (conn, message) => {
    if (diagnostics && packets++ < 256) connection.events$.next({
      type: 'PROTOCOL_PACKET', protocolPatch: CARRY4_PATCH, timestamp: performance.now(),
      // Decrypted cube notifications contain turns/state, never the MAC or keys.
      bytes: Array.from(message)
    });
    if (message[0] === 0x01 && message.length >= 9 && driver.lastSerial !== -1) {
      latestLiveSerial = (message[6] | message[7] << 8) & 255;
      if (firstLive) {
        driver.lastSerial = (latestLiveSerial - 1) & 255;
        driver.moveBuffer = []; firstLive = false;
      }
    }
    const events = await handle(conn, message);
    if (message[0] === 0xED && latestLiveSerial != null) driver.serial = latestLiveSerial;
    for (const event of events) stream.accept(event);
    return []; // Emitted through the same Subject, after state reconciliation.
  };
  driver.createCommandMessage = request => {
    if (request.type === 'REQUEST_RESET') {
      stream.reset(); driver.lastSerial = -1; driver.serial = -1;
    }
    return command(request);
  };
  const cleanup = connection.events$.subscribe(event => {
    if (event.type === 'DISCONNECT') { stream.dispose(); cleanup.unsubscribe(); }
  });
  connection.protocolPatch = CARRY4_PATCH;
  return connection;
}
