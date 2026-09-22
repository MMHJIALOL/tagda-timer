import { t } from './i18n.js';
/* ===========================================================
   Tagda Timer — Stackmat / aux timer input

   A Stackmat (SpeedStack Gen2/Gen3, and the many clones) sends its
   display over the 3.5 mm jack as a 1200-baud serial stream. Plug the
   jack into the microphone socket and this decodes it: no driver, no
   extension, just the audio the browser already lets us have.

   Packet, once decoded from the bit stream:

     <status> <1 digit minutes> <2 digits seconds> <3 digits ms | 2 digits cs>
     <checksum> <CR/LF>

   with checksum = 64 + (sum of the digits). The status byte varies
   between firmware revisions, so the run/stop logic below is driven by
   the *time* rather than by the letter — that behaviour is identical on
   every unit ever shipped, which the letters are not.
   =========================================================== */

const BAUD = 1200;
const HEADERS = ' ACILRSTG';           // every status byte any revision sends

/**
 * Decodes a stream of audio samples into Stackmat packets.
 * Deliberately free of any browser API so it can be reasoned about — and
 * tested — on its own.
 */
export class StackmatDecoder {
  constructor(sampleRate, onPacket) {
    this.spb = sampleRate / BAUD;       // samples per bit
    this.onPacket = onPacket;
    this.polarity = 1;                  // flipped automatically if nothing decodes
    this.reset();
  }

  reset() {
    // Last quarter-bit of raw samples, for the edge detector in push().
    this.hist = new Float32Array(Math.max(1, Math.round(this.spb / 4)));
    this.hi = 0;
    this.peak = 0.02;
    this.prev = 1;
    this.bytes = [];
    this.sinceGood = 0;
    this.buf = [];                      // pending samples for one frame
    this.frameAt = -1;
    // Diagnostics only (?smdebug): how loud the line is, how many serial
    // frames and packets came out of it, and the last raw bytes seen.
    this.level = 0;
    this.frames = 0;
    this.packets = 0;
    this.seen = [];
  }

  /** Feed one block of mono samples. */
  push(block) {
    const { spb } = this;
    for (let i = 0; i < block.length; i++) {
      // Slice on edges, not levels. Sound-card inputs are AC-coupled, so a run
      // of equal bits sags back toward zero and a level slicer loses it —
      // how far depends on the card's cutoff, which is why the old slicer
      // worked on some machines and not others. The step across a transition
      // survives coupling intact, so compare each sample with the one a
      // quarter-bit earlier and hold the level between edges.
      const raw = block[i];
      const r = Math.abs(raw);
      this.level = r > this.level ? r : this.level * 0.99995;
      const v =(raw - this.hist[this.hi]) * this.polarity;
      this.hist[this.hi] = raw;
      this.hi = (this.hi + 1) % this.hist.length;
      const a = Math.abs(v);
      this.peak = a > this.peak ? a : this.peak * 0.99995;

      // Threshold scaled to the edge envelope, so any input gain works. The
      // floor is tiny on purpose: some timers (QiYi through a 2.5→3.5 mm
      // adapter) arrive only a few thousandths of full scale, and noise that
      // slips through is harmless because the checksum rejects it.
      const gate = Math.max(0.0005, this.peak * 0.4);
      const bit = v > gate ? 1 : v < -gate ? 0 : this.prev;

      if (this.frameAt < 0) {
        // Idle: wait for the falling edge that opens a start bit.
        if (this.prev === 1 && bit === 0) { this.frameAt = 0; this.buf.length = 0; }
      }
      this.prev = bit;

      if (this.frameAt >= 0) {
        this.buf.push(bit);
        this.frameAt++;
        // One start bit + 8 data + 1 stop = 10 bit times.
        if (this.frameAt >= Math.ceil(spb * 10)) this._frame();
      }
    }

    // A second with nothing checksumming — the jack is probably wired the other
    // way round on this machine, which is common enough that guessing is worth
    // it. spb * BAUD is exactly the sample rate, so this is one second.
    this.sinceGood += block.length;
    if (this.sinceGood > this.spb * BAUD) {
      this.polarity = -this.polarity;
      this.sinceGood = 0;
      this.bytes.length = 0;
    }
  }

  _frame() {
    const { spb, buf } = this;
    const at = (k) => buf[Math.round(spb * (k + 0.5))] ?? 1;
    this.frameAt = -1;

    // Data bits are least-significant first; the stop bit must be high or this
    // was noise that happened to look like an edge.
    if (at(9) !== 1) return;
    let byte = 0;
    for (let k = 0; k < 8; k++) if (at(k + 1)) byte |= 1 << k;

    this.frames++;
    this.seen.push(byte);
    if (this.seen.length > 12) this.seen.shift();
    this.bytes.push(byte);
    if (this.bytes.length > 16) this.bytes.shift();
    this._scan();
  }

  /**
   * Look for a valid packet anywhere in the rolling byte window.
   *
   * Scanning rather than assuming a fixed frame length is what makes this
   * work across revisions: Gen2 closes with LF, Gen3 with CR LF, some clones
   * send neither, and every one of them still satisfies the checksum.
   */
  _scan() {
    const b = this.bytes;
    for (let i = 0; i < b.length; i++) {
      const status = String.fromCharCode(b[i]);
      if (!HEADERS.includes(status)) continue;
      // Gen3+ sends six digits (m ss mmm); Gen2, QiYi and many clones send
      // five (m ss cc). The checksum byte is always >= 64, so it can never be
      // mistaken for a digit and the two lengths cannot both match.
      for (const n of [6, 5]) {
        if (i + n + 2 > b.length) continue;
        let sum = 0, ok = true;
        const digits = [];
        for (let k = 1; k <= n; k++) {
          const d = b[i + k] - 48;
          if (d < 0 || d > 9) { ok = false; break; }
          digits.push(d);
          sum += d;
        }
        if (!ok || b[i + n + 1] !== ((sum + 64) & 0xff)) continue;

        const frac = n === 6 ? digits[3] * 100 + digits[4] * 10 + digits[5]
                             : (digits[3] * 10 + digits[4]) * 10;
        const ms = digits[0] * 60000 + (digits[1] * 10 + digits[2]) * 1000 + frac;
        this.bytes = b.slice(i + n + 2);
        this.sinceGood = 0;
        this.packets++;
        this.onPacket({ status, timeMs: ms });
        return;
      }
    }
  }
}

/* ---------------------------------------------------------
   Audio plumbing
   --------------------------------------------------------- */

// An AudioWorklet keeps the sampling off the main thread. It is built from a
// blob so there is no extra file to ship or to keep in sync.
const WORKLET = `
class TapProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(new Float32Array(ch));
    return true;
  }
}
registerProcessor('tdt-tap', TapProcessor);
`;

/**
 * A live Stackmat connection.
 *
 * Emits:
 *   'time'   {timeMs}            — the display changed while running
 *   'solve'  {timeMs}            — the hand came off and the time settled
 *   'ready'  {}                  — the timer was reset to zero
 *   'state'  {status, hands}     — status byte, for the indicator
 *   'signal' {ok}                — whether packets are arriving at all
 */
export class Stackmat extends EventTarget {
  constructor() {
    super();
    this.ctx = null;
    this.stream = null;
    this.node = null;
    this.running = false;
    this.lastTime = 0;
    this.lastChange = 0;
    this.armed = false;         // a run is in progress and not yet recorded
    this.signal = false;
    this._watch = null;
  }

  get active() { return !!this.ctx; }

  /** One line saying where the chain breaks, for testers to screenshot. */
  debugLine() {
    const d = this.decoder;
    if (!this.ctx || !d) return 'smdebug: not started';
    const track = this.stream?.getAudioTracks()[0];
    const s = track?.getSettings?.() || {};
    const db = d.level > 0 ? (20 * Math.log10(d.level)).toFixed(0) : '-inf';
    const bytes = d.seen.map(b => b >= 32 && b < 127 ? String.fromCharCode(b) : `\\x${b.toString(16).padStart(2, '0')}`).join('');
    return `audio ${this.ctx.state} ${this.ctx.sampleRate}Hz · input "${track?.label || '?'}" ${track?.readyState || ''}` +
      ` agc=${s.autoGainControl} · level ${db} dB · frames ${d.frames} · packets ${d.packets}` +
      ` · pol ${d.polarity} · bytes [${bytes}]`;
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  async start() {
    if (this.ctx) return true;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error(t('This browser has no microphone access'));

    // Created before the permission prompt, while the click that got us here
    // still counts as a gesture. Chrome keeps a context made without one
    // suspended, and resume() then never settles — awaiting it hung start()
    // for good (the status stuck on "listening…", and re-selecting Stackmat
    // hit the early return above). So don't wait: resume on the next click
    // or key instead, which is all the browser is waiting for.
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    ctx.resume();
    if (ctx.state === 'suspended') {
      const wake = () => { if (this.ctx === ctx) ctx.resume(); };
      addEventListener('pointerdown', wake, { once: true, capture: true });
      addEventListener('keydown', wake, { once: true, capture: true });
    }

    // Every clean-up the browser applies to speech destroys a data signal.
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
      });
    } catch (err) {
      ctx.close();
      throw err;
    }

    this.ctx = ctx;
    const src = this.ctx.createMediaStreamSource(this.stream);
    const decoder = new StackmatDecoder(this.ctx.sampleRate, (p) => this._packet(p));
    this.decoder = decoder;

    let tapped = false;
    if (this.ctx.audioWorklet) {
      try {
        const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
        await this.ctx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
        this.node = new AudioWorkletNode(this.ctx, 'tdt-tap');
        this.node.port.onmessage = (e) => decoder.push(e.data);
        src.connect(this.node);
        // Worklets only run while connected to something downstream; a zero
        // gain keeps the mic out of the speakers.
        const mute = this.ctx.createGain();
        mute.gain.value = 0;
        this.node.connect(mute).connect(this.ctx.destination);
        tapped = true;
      } catch (err) {
        console.warn('[stackmat] worklet unavailable, falling back', err);
      }
    }
    if (!tapped) {
      // Deprecated, but it is the only route left on older Safari.
      this.node = this.ctx.createScriptProcessor(1024, 1, 1);
      this.node.onaudioprocess = (e) => decoder.push(e.inputBuffer.getChannelData(0));
      const mute = this.ctx.createGain();
      mute.gain.value = 0;
      src.connect(this.node);
      this.node.connect(mute).connect(this.ctx.destination);
    }

    // Say plainly whether anything is coming down the wire, so a wrong cable
    // or a muted input is obvious in a second instead of a session.
    this._watch = setInterval(() => {
      const ok = performance.now() - this.lastPacketAt < 900;
      if (ok !== this.signal) { this.signal = ok; this.emit('signal', { ok }); }
    }, 400);
    this.lastPacketAt = 0;
    return true;
  }

  stop() {
    clearInterval(this._watch);
    this._watch = null;
    try { this.node?.disconnect(); } catch { /* already gone */ }
    if (this.node) this.node.onaudioprocess = null;
    this.stream?.getTracks().forEach(t => t.stop());
    try { this.ctx?.close(); } catch { /* already closed */ }
    this.ctx = null; this.stream = null; this.node = null;
    this.signal = false; this.armed = false; this.running = false;
    this.emit('signal', { ok: false });
  }

  _packet({ status, timeMs }) {
    this.lastPacketAt = performance.now();
    const hands = status === 'A' || status === 'C' ? 'both'
                : status === 'L' ? 'left' : status === 'R' ? 'right' : '';
    this.emit('state', { status, hands });

    if (timeMs !== this.lastTime) {
      const wasZero = this.lastTime === 0;
      this.lastTime = timeMs;
      this.lastChange = this.lastPacketAt;

      if (timeMs === 0) {
        // Reset: the mat is ready for the next one.
        this.running = false;
        this.armed = false;
        this.emit('ready', {});
        return;
      }
      if (wasZero) this.running = true;
      if (this.running) { this.armed = true; this.emit('time', { timeMs }); }
      return;
    }

    // The number stopped moving: the solve is over. Guarded by `armed` so a
    // stationary display cannot record the same time again and again.
    if (this.armed && this.lastPacketAt - this.lastChange > 250 && timeMs > 0) {
      this.armed = false;
      this.running = false;
      this.emit('solve', { timeMs });
    }
  }
}
