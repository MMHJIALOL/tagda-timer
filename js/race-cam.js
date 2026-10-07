import { t } from './i18n.js';
/* ===========================================================
   Tagda Timer — cam and mic in a random 1v1 (RACE.md §9)

   Opt-in, both ways:
     sending   — your camera and your mic are separate switches, both off
                 until you turn them on, and off again the moment you leave;
     receiving — the other side's video stays covered and their sound muted
                 until you press Show, so nobody's camera reaches you unasked.

   The media goes peer to peer (WebRTC). The database only carries the call's
   setup, under rooms/<id>/rtc/<uid>:

     media           { cam, mic }   what that player is sending right now
     desc            { sid, type, sdp }   the offer, or the answer to one
     ice/<sid>/<id>  connection candidates for that attempt

   One side always offers — the lower uid — so there is no glare to resolve.
   The call carries one audio and one video transceiver from the start, and
   turning a camera on or off is replaceTrack on its sender: no renegotiation,
   so the switch is instant and nothing about the call has to be redone. A
   connection that fails is retried from scratch by the offerer with a new
   sid; anything still in flight for the old one is ignored.

   Where the network allows, the media goes straight between the two players.
   Two players behind strict NATs can't reach each other that way, so each
   attempt first asks the Worker for TURN relay credentials (worker.js /turn)
   and falls back to STUN alone if it has none.
   =========================================================== */

import { el } from './util.js';
import { toast } from './toast.js';
import { RTC_ICE_SERVERS, CAM_VIDEO, CAM_MAX_BITRATE, CAM_RETRIES } from './raceapp.js';

const sidOf = () => Math.random().toString(36).slice(2, 12);
const denied = (err) => /permission/i.test(String(err?.code || err?.message || err));

const ICON = {
  cam: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6.5" width="12.5" height="11" rx="2.5"/><path d="M15.5 10.5l5-3v9l-5-3z"/></svg>',
  camOff: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6.5" width="12.5" height="11" rx="2.5"/><path d="M15.5 10.5l5-3v9l-5-3z"/><path d="M3 3l18 18"/></svg>',
  mic: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0013 0M12 17.5V21"/></svg>',
  micOff: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0013 0M12 17.5V21"/><path d="M3 3l18 18"/></svg>',
  eyeOff: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12s3.5-6.5 9-6.5S21 12 21 12s-3.5 6.5-9 6.5S3 12 3 12z"/><circle cx="12" cy="12" r="2.6"/><path d="M4 4l16 16"/></svg>',
};

export class DuelCam {
  /** @param {import('./race.js').Race} race */
  constructor(race) {
    this.race = race;
    this.net = race.net;
    this.app = race.app;
    this.opp = null;               // { uid, name }
    this.role = null;              // 'offer' | 'answer'
    this.local = { cam: null, mic: null };   // MediaStreamTracks we send
    this.remoteMedia = { cam: false, mic: false };
    this.revealed = false;         // the viewer's own opt-in to see and hear them
    this.pc = null;
    this.sid = null;
    this.dialing = null;           // the sid whose call is waiting for ICE servers
    this.ice = null;               // { list, until } from the Worker, for this 1v1
    this.tx = null;                // { audio, video } transceivers
    this.pendingIce = [];
    this.tries = 0;
    this.state = 'idle';           // idle | connecting | live | failed | rules
    this.busy = { cam: false, mic: false };
    this._unsubs = [];
    this._iceUnsub = null;
    this._retryTimer = 0;
    this.node = null;
  }

  /* ---------------- lifecycle ---------------- */

  /** Bind to an opponent. Idempotent: called on every snapshot of the 1v1. */
  start(opp) {
    if (this.opp?.uid === opp.uid) { this.opp.name = opp.name; return; }
    this.stop({ keepUi: true });
    this.opp = { ...opp };
    this.ice = null;
    this.role = String(this.race.uid) < String(opp.uid) ? 'offer' : 'answer';
    this._unsubs.push(
      this.net.rtcOn(opp.uid, 'media', (v) => {
        this.remoteMedia = { cam: !!v?.cam, mic: !!v?.mic };
        this._maybeConnect();
        this._draw();
      }),
      this.net.rtcOn(opp.uid, 'desc', (d) => this._onDesc(d)),
    );
    this._draw();
  }

  /** Everything off and forgotten: tracks stopped, call closed, our node removed. */
  stop({ keepUi = false } = {}) {
    clearTimeout(this._retryTimer);
    this._unsubs.forEach(u => u());
    this._unsubs = [];
    this._closePc();
    for (const k of ['cam', 'mic']) { this.local[k]?.stop(); this.local[k] = null; }
    const had = this.opp;
    this.opp = null;
    this.remoteMedia = { cam: false, mic: false };
    this.revealed = false;
    this.tries = 0;
    this.state = 'idle';
    if (had) this.net.rtcClear?.();
    if (!keepUi) this._draw();
  }

  _closePc() {
    this._iceUnsub?.();
    this._iceUnsub = null;
    if (this.pc) {
      this.pc.onicecandidate = this.pc.ontrack = this.pc.onconnectionstatechange = null;
      this.pc.close();
    }
    this.pc = null;
    this.sid = null;
    this.dialing = null;
    this.tx = null;
    this.pendingIce = [];
    this.remoteStream = null;
    const v = this.node?.querySelector('.cam-remote');
    if (v) v.srcObject = null;
  }

  /* ---------------- the switches ---------------- */

  async toggle(kind) {
    if (!this.opp || this.busy[kind]) return;
    this.busy[kind] = true;
    this._draw();
    try {
      if (this.local[kind]) {
        this.local[kind].stop();
        this.local[kind] = null;
      } else {
        const track = await this._open(kind);
        if (!track) return;
        // Left the 1v1 while the permission prompt was up.
        if (!this.opp) { track.stop(); return; }
        this.local[kind] = track;
        /* The rules first, before anything is sent: on rules from before
           this feature the write is refused, and the camera goes straight
           back off rather than sitting there lit for nobody. */
        this.net.rtcArm?.();
      }
      try {
        await this.net.rtcSet('media', { cam: !!this.local.cam, mic: !!this.local.mic });
      } catch (err) {
        if (!denied(err)) throw err;
        for (const k of ['cam', 'mic']) { this.local[k]?.stop(); this.local[k] = null; }
        this.state = 'rules';
        toast(t('Cam and mic need the newer database rules — publish firebase.rules.json.'), { kind: 'bad', long: true });
        return;
      }
      await this._applyTracks();
      this._maybeConnect();
    } catch (err) {
      console.warn('[cam]', kind, err?.name || err);
      toast(this._openError(kind, err), { kind: 'bad', long: true });
    } finally {
      this.busy[kind] = false;
      this._draw();
    }
  }

  /** The device picked for webcam replays, if any; otherwise the browser's own choice. */
  async _open(kind) {
    const S = this.app.settings;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('unsupported');
    if (kind === 'cam') {
      const id = S.webcamDevice;
      const s = await navigator.mediaDevices.getUserMedia({
        video: { ...CAM_VIDEO, ...(id ? { deviceId: { ideal: id } } : {}) }, audio: false,
      });
      return s.getVideoTracks()[0] || null;
    }
    const id = S.webcamMic;
    const s = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...(id ? { deviceId: { ideal: id } } : {}) },
      video: false,
    });
    return s.getAudioTracks()[0] || null;
  }

  _openError(kind, err) {
    const name = err?.name || err?.message;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return kind === 'cam' ? t('The camera is blocked — allow it from the address bar, then try again.')
        : t('The microphone is blocked — allow it from the address bar, then try again.');
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      return kind === 'cam' ? t('No camera found.') : t('No microphone found.');
    }
    if (name === 'NotReadableError') {
      return kind === 'cam' ? t('The camera is in use by another app.') : t('The microphone is in use by another app.');
    }
    if (name === 'unsupported') return t('This browser cannot share a camera or microphone.');
    return kind === 'cam' ? t('Could not turn the camera on.') : t('Could not turn the microphone on.');
  }

  /** What we send, onto the call's senders: a track, or nothing. */
  async _applyTracks() {
    if (!this.tx) return;
    await Promise.all([
      this.tx.audio?.sender.replaceTrack(this.local.mic || null),
      this.tx.video?.sender.replaceTrack(this.local.cam || null),
    ].filter(Boolean)).catch(err => console.warn('[cam] replaceTrack', err));
    const vs = this.tx.video?.sender;
    if (vs && this.local.cam) {
      try {
        const p = vs.getParameters();
        if (p.encodings?.length) {
          p.encodings[0].maxBitrate = CAM_MAX_BITRATE;
          await vs.setParameters(p);
        }
      } catch { /* a browser that will not cap it sends at its own rate */ }
    }
    this._drawSelf();
  }

  /* ---------------- the call ---------------- */

  /** A call is needed once either side sends anything; the offerer starts it. */
  _maybeConnect() {
    if (!this.opp || this.pc || this.dialing || this.state === 'rules') return;
    const wanted = this.local.cam || this.local.mic || this.remoteMedia.cam || this.remoteMedia.mic;
    if (!wanted) return;
    if (this.role === 'offer') this._offer();
    else { this.state = 'connecting'; this._draw(); }
  }

  /**
   * STUN plus, when the Worker hands them out, TURN relay credentials. Asked
   * once per 1v1 and kept until shortly before they expire; anything going
   * wrong (no Worker locally, the secrets unset) means STUN alone.
   */
  async _iceServers() {
    if (!this.ice || this.ice.until < Date.now()) {
      const got = await this.net.rtcIceServers?.().catch((err) => {
        console.warn('[cam] turn', err?.message || err);
        return null;
      });
      this.ice = got
        ? { list: got.list, until: Date.now() + Math.max(0, got.ttl - 600) * 1000 }
        : { list: [], until: Date.now() + 60_000 };
    }
    return [...RTC_ICE_SERVERS, ...this.ice.list];
  }

  /** The servers for attempt `sid`, or null when that attempt was dropped while we waited. */
  async _dial(sid) {
    this._closePc();
    this.dialing = sid;
    this.state = 'connecting';
    this._draw();
    const servers = await this._iceServers();
    if (this.dialing !== sid || !this.opp) return null;
    this.dialing = null;
    return servers;
  }

  _newPc(sid, iceServers) {
    const pc = new RTCPeerConnection({ iceServers });
    this.pc = pc;
    this.sid = sid;
    this.remoteStream = new MediaStream();
    const v = this.node?.querySelector('.cam-remote');
    if (v) v.srcObject = this.remoteStream;

    pc.onicecandidate = (e) => {
      if (!e.candidate || this.sid !== sid) return;
      const c = e.candidate.toJSON();
      // Firebase stores no nulls, and the rules want strings where there is anything.
      const out = { candidate: c.candidate };
      if (c.sdpMid != null) out.sdpMid = String(c.sdpMid);
      if (c.sdpMLineIndex != null) out.sdpMLineIndex = c.sdpMLineIndex;
      if (c.usernameFragment) out.usernameFragment = c.usernameFragment;
      this.net.rtcPush(`ice/${sid}`, out).catch(() => {});
    };
    pc.ontrack = (e) => {
      if (this.sid !== sid) return;
      this.remoteStream.addTrack(e.track);
      this._draw();
    };
    pc.onconnectionstatechange = () => {
      if (this.sid !== sid) return;
      const s = pc.connectionState;
      if (s === 'connected') { this.state = 'live'; this.tries = 0; }
      else if (s === 'failed') this._failed();
      else if (s === 'connecting' || s === 'new') this.state = 'connecting';
      this._draw();
    };
    this._iceUnsub = this.net.rtcOnAdded(this.opp.uid, `ice/${sid}`, (c) => this._addIce(sid, c));
    return pc;
  }

  async _offer() {
    const sid = sidOf();
    const servers = await this._dial(sid);
    if (!servers) return;
    const pc = this._newPc(sid, servers);
    this.tx = {
      audio: pc.addTransceiver('audio', { direction: 'sendrecv' }),
      video: pc.addTransceiver('video', { direction: 'sendrecv' }),
    };
    await this._applyTracks();
    try {
      const offer = await pc.createOffer();
      if (this.sid !== sid) return;
      await pc.setLocalDescription(offer);
      await this.net.rtcSet('desc', { sid, type: 'offer', sdp: offer.sdp });
    } catch (err) {
      console.warn('[cam] offer', err);
      if (denied(err)) { this.state = 'rules'; this._closePc(); }
    }
    this._draw();
  }

  async _onDesc(d) {
    if (!d || !this.opp) return;
    if (this.role === 'answer' && d.type === 'offer' && d.sid !== this.sid && d.sid !== this.dialing) {
      const servers = await this._dial(d.sid);
      if (!servers) return;
      const pc = this._newPc(d.sid, servers);
      try {
        await pc.setRemoteDescription({ type: 'offer', sdp: d.sdp });
        if (this.sid !== d.sid) return;
        this.tx = {};
        for (const tr of pc.getTransceivers()) {
          const kind = tr.receiver.track?.kind;
          if (kind !== 'audio' && kind !== 'video') continue;
          tr.direction = 'sendrecv';
          this.tx[kind] = tr;
        }
        await this._applyTracks();
        const answer = await pc.createAnswer();
        if (this.sid !== d.sid) return;
        await pc.setLocalDescription(answer);
        await this.net.rtcSet('desc', { sid: d.sid, type: 'answer', sdp: answer.sdp });
        this._flushIce();
      } catch (err) {
        console.warn('[cam] answer', err);
        if (denied(err)) { this.state = 'rules'; this._closePc(); }
      }
      this._draw();
      return;
    }
    if (this.role === 'offer' && d.type === 'answer' && d.sid === this.sid
        && this.pc?.signalingState === 'have-local-offer') {
      try {
        await this.pc.setRemoteDescription({ type: 'answer', sdp: d.sdp });
        this._flushIce();
      } catch (err) { console.warn('[cam] remote answer', err); }
    }
  }

  /** Candidates can arrive before the description they belong to; held until it lands. */
  _addIce(sid, c) {
    if (sid !== this.sid || !this.pc || !c?.candidate) return;
    if (!this.pc.remoteDescription) { this.pendingIce.push(c); return; }
    this.pc.addIceCandidate(c).catch(err => console.warn('[cam] candidate', err?.name || err));
  }

  _flushIce() {
    const list = this.pendingIce;
    this.pendingIce = [];
    for (const c of list) this.pc?.addIceCandidate(c).catch(() => {});
  }

  /** Try again from scratch, a few times; after that, say it cannot connect. */
  _failed() {
    if (this.tries >= CAM_RETRIES) { this.state = 'failed'; this._draw(); return; }
    this.tries += 1;
    this.state = 'connecting';
    if (this.role !== 'offer') return;      // the offerer restarts; we follow its new offer
    clearTimeout(this._retryTimer);
    this._retryTimer = setTimeout(() => { if (this.opp) this._offer(); }, 1200);
  }

  retry() {
    this.tries = 0;
    this.state = 'idle';
    this._closePc();
    this._maybeConnect();
    this._draw();
  }

  /* ---------------- the tile ---------------- */

  /** Build once into the race panel's .race-cam; from then on only _draw touches it. */
  mount(host) {
    if (this.node === host) return;
    this.node = host;
    host.innerHTML = '';
    const stage = el('div', { class: 'cam-stage' });
    const remote = el('video', { class: 'cam-remote', autoplay: true, playsInline: true });
    remote.muted = true;
    remote.setAttribute('playsinline', '');
    const self = el('video', { class: 'cam-self', autoplay: true, playsInline: true, title: t('You') });
    self.muted = true;
    self.setAttribute('playsinline', '');
    const cover = el('div', { class: 'cam-cover' });
    const status = el('div', { class: 'cam-status', role: 'status' });
    const hide = el('button', { class: 'cam-hide', type: 'button', html: ICON.eyeOff,
      title: t('Hide their cam and mute them'), 'aria-label': t('Hide their cam and mute them'),
      onclick: () => this._reveal(false) });
    stage.append(remote, cover, self, status, hide);

    const bar = el('div', { class: 'cam-bar' });
    for (const kind of ['cam', 'mic']) {
      bar.append(el('button', { class: 'cam-btn', type: 'button', dataset: { kind },
        onclick: () => this.toggle(kind) }));
    }
    host.append(stage, bar);
    if (this.remoteStream) remote.srcObject = this.remoteStream;
    this._drawSelf();
    this._draw();
  }

  _reveal(on) {
    this.revealed = on;
    const v = this.node?.querySelector('.cam-remote');
    if (v) {
      v.muted = !on;
      // A click is the gesture that lets sound play; ask for it while we have one.
      if (on) v.play?.().catch(() => {});
    }
    this._draw();
  }

  _drawSelf() {
    const v = this.node?.querySelector('.cam-self');
    if (!v) return;
    const track = this.local.cam;
    if (track) {
      if (v.srcObject?.getVideoTracks?.()[0] !== track) v.srcObject = new MediaStream([track]);
    } else v.srcObject = null;
    v.hidden = !track;
  }

  _draw() {
    const host = this.node;
    if (!host) return;
    const name = this.opp?.name || t('Your opponent');
    const theirs = this.remoteMedia.cam || this.remoteMedia.mic;
    const mine = !!(this.local.cam || this.local.mic);
    const any = theirs || mine;
    host.dataset.on = String(!!any);
    host.dataset.revealed = String(this.revealed && theirs);
    host.dataset.remoteCam = String(this.remoteMedia.cam);

    /* ---- the stage ---- */
    const stage = host.querySelector('.cam-stage');
    stage.hidden = !any;
    const cover = host.querySelector('.cam-cover');
    cover.innerHTML = '';
    if (theirs && !this.revealed) {
      const what = this.remoteMedia.cam && this.remoteMedia.mic ? t('{name} turned on their cam and mic', { name })
        : this.remoteMedia.cam ? t('{name} turned on their cam', { name }) : t('{name} turned on their mic', { name });
      cover.append(
        el('div', { class: 'cam-cover-text', text: what }),
        el('button', { class: 'btn primary cam-show', type: 'button', text: t('Show'), onclick: () => this._reveal(true) }),
      );
    } else if (!theirs) {
      cover.append(el('div', { class: 'cam-cover-text dim', text: t('{name}’s cam is off', { name }) }));
    } else if (!this.remoteMedia.cam) {
      cover.append(el('div', { class: 'cam-cover-text', html: `${ICON.mic}<span></span>` }));
      cover.querySelector('span').textContent = t('{name} — mic only', { name });
    }
    cover.hidden = !!(theirs && this.revealed && this.remoteMedia.cam);
    host.querySelector('.cam-hide').hidden = !(theirs && this.revealed);

    const status = host.querySelector('.cam-status');
    const st = this.state === 'failed' ? t('Couldn’t connect — your networks may block a direct connection.')
      : this.state === 'rules' ? t('Needs the newer database rules.')
      : this.state === 'connecting' && any ? t('Connecting…') : '';
    status.textContent = st;
    status.hidden = !st;
    if (this.state === 'failed') {
      status.append(' ', el('button', { class: 'cam-retry', type: 'button', text: t('Retry'), onclick: () => this.retry() }));
    }

    /* ---- the switches ---- */
    for (const btn of host.querySelectorAll('.cam-btn')) {
      const kind = btn.dataset.kind;
      const on = !!this.local[kind];
      btn.setAttribute('aria-pressed', String(on));
      btn.disabled = this.busy[kind];
      btn.dataset.on = String(on);
      const label = kind === 'cam' ? (on ? t('Cam on') : t('Cam off')) : (on ? t('Mic on') : t('Mic off'));
      // The opt-in, said where you decide it: off until pressed, and theirs stays covered until Show.
      btn.title = kind === 'cam'
        ? (on ? t('Stop sending your camera') : t('Send your camera to your opponent — off until you press this. Theirs stays covered until you press Show.'))
        : (on ? t('Stop sending your microphone') : t('Send your microphone to your opponent — off until you press this. Theirs stays muted until you press Show.'));
      btn.innerHTML = (kind === 'cam' ? (on ? ICON.cam : ICON.camOff) : (on ? ICON.mic : ICON.micOff)) + '<span></span>';
      btn.querySelector('span').textContent = label;
    }
  }
}
