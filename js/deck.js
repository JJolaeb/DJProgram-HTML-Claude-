'use strict';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

class Deck {
  constructor(id, ctx, out) {
    this.id = id;
    this.ctx = ctx;
    this.track = null;
    this.buffer = null;
    this.reversed = null;
    this.source = null;
    this.srcGain = null;

    this.playing = false;
    this.offset = 0;
    this.startCtx = 0;

    this.pitch = 0;
    this.pitchRange = 0.08;
    this.bend = 0;
    this.rate = 1;

    this.cue = 0;
    this.hotcues = [null, null, null, null];
    this.preview = false;
    this.loop = { active: false, start: 0, end: 0 };
    this.loopIn = null;

    this.bpm = 0;
    this.grid = 0;
    this.sync = false;
    this.quantize = true;
    this.vinyl = true;
    this.fx = { type: 'echo', beats: 0.5, on: false, amount: 0.5 };

    this.onEnd = null;

    const c = ctx;
    this.input = c.createGain();
    this.eqLow = c.createBiquadFilter();
    this.eqLow.type = 'lowshelf';
    this.eqLow.frequency.value = 250;
    this.eqMid = c.createBiquadFilter();
    this.eqMid.type = 'peaking';
    this.eqMid.frequency.value = 1200;
    this.eqMid.Q.value = 0.7;
    this.eqHigh = c.createBiquadFilter();
    this.eqHigh.type = 'highshelf';
    this.eqHigh.frequency.value = 4000;
    this.lpf = c.createBiquadFilter();
    this.lpf.type = 'lowpass';
    this.lpf.frequency.value = 22000;
    this.lpf.Q.value = 1;
    this.hpf = c.createBiquadFilter();
    this.hpf.type = 'highpass';
    this.hpf.frequency.value = 10;
    this.hpf.Q.value = 1;
    this.post = c.createGain();
    this.fader = c.createGain();
    this.xf = c.createGain();
    this.analyser = c.createAnalyser();
    this.analyser.fftSize = 1024;

    this.input.connect(this.eqLow);
    this.eqLow.connect(this.eqMid);
    this.eqMid.connect(this.eqHigh);
    this.eqHigh.connect(this.lpf);
    this.lpf.connect(this.hpf);
    this.hpf.connect(this.post);
    this.post.connect(this.fader);
    this.post.connect(this.analyser);
    this.fader.connect(this.xf);
    this.xf.connect(out);

    this._buildFx();
  }

  _buildFx() {
    const c = this.ctx;
    this.fxWet = c.createGain();
    this.fxWet.gain.value = this.fx.amount;
    this.fxWet.connect(this.fader);

    // Echo
    this.echoIn = c.createGain();
    this.echoIn.gain.value = 0;
    this.echoDelay = c.createDelay(5);
    this.echoDelay.delayTime.value = 0.25;
    this.echoFb = c.createGain();
    this.echoFb.gain.value = 0.45;
    this.echoTone = c.createBiquadFilter();
    this.echoTone.type = 'lowpass';
    this.echoTone.frequency.value = 3500;
    this.post.connect(this.echoIn);
    this.echoIn.connect(this.echoDelay);
    this.echoDelay.connect(this.echoTone);
    this.echoTone.connect(this.echoFb);
    this.echoFb.connect(this.echoDelay);
    this.echoDelay.connect(this.fxWet);

    // Reverb
    this.revIn = c.createGain();
    this.revIn.gain.value = 0;
    this.reverb = c.createConvolver();
    this.reverb.buffer = Deck.impulse(c, 3.2);
    this.post.connect(this.revIn);
    this.revIn.connect(this.reverb);
    this.reverb.connect(this.fxWet);

    // Flanger
    this.flIn = c.createGain();
    this.flIn.gain.value = 0;
    this.flDelay = c.createDelay(0.05);
    this.flDelay.delayTime.value = 0.004;
    this.flFb = c.createGain();
    this.flFb.gain.value = 0.65;
    this.flLfo = c.createOscillator();
    this.flLfo.type = 'triangle';
    this.flLfo.frequency.value = 0.25;
    this.flDepth = c.createGain();
    this.flDepth.gain.value = 0.0032;
    this.flLfo.connect(this.flDepth);
    this.flDepth.connect(this.flDelay.delayTime);
    this.flLfo.start();
    this.post.connect(this.flIn);
    this.flIn.connect(this.flDelay);
    this.flDelay.connect(this.flFb);
    this.flFb.connect(this.flDelay);
    this.flDelay.connect(this.fxWet);
  }

  static impulse(ctx, sec) {
    const len = Math.floor(ctx.sampleRate * sec);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.5);
    }
    return buf;
  }

  get duration() { return this.buffer ? this.buffer.duration : 0; }
  get loaded() { return !!this.buffer; }
  get beatLen() { return this.bpm ? 60 / this.bpm : 0.5; }
  get effectiveBpm() { return this.bpm * this.rate; }

  load(track) {
    this.stop();
    this.track = track;
    this.buffer = track.buffer;
    this.reversed = null;
    this.bpm = track.bpm || 0;
    this.grid = track.grid || 0;
    this.cue = this.bpm && this.grid < 2 ? this.grid : 0;
    this.offset = this.cue;
    this.hotcues = [null, null, null, null];
    this.loop = { active: false, start: 0, end: 0 };
    this.loopIn = null;
    this.sync = false;
    this._updateFx();
  }

  position() {
    if (!this.buffer) return 0;
    if (!this.playing) return this.offset;
    let p = this.offset + (this.ctx.currentTime - this.startCtx) * this.rate;
    const L = this.loop;
    if (L.active && p >= L.end) p = L.start + ((p - L.start) % (L.end - L.start));
    return Math.min(p, this.duration);
  }

  _rebase() {
    this.offset = this.position();
    this.startCtx = this.ctx.currentTime;
  }

  _start() {
    this._stopSource();
    const c = this.ctx;
    const s = c.createBufferSource();
    s.buffer = this.buffer;
    s.playbackRate.value = this.rate;
    if (this.loop.active) {
      s.loop = true;
      s.loopStart = this.loop.start;
      s.loopEnd = this.loop.end;
    }
    const g = c.createGain();
    const now = c.currentTime;
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(1, now + 0.006);
    s.connect(g);
    g.connect(this.input);
    const at = clamp(this.offset, 0, Math.max(0, this.duration - 0.001));
    s.start(now, at);
    this.offset = at;
    this.startCtx = now;
    s.onended = () => {
      if (this.source !== s) return;
      this.source = null;
      this.playing = false;
      this.offset = this.duration;
      if (this.onEnd) this.onEnd(this);
    };
    this.source = s;
    this.srcGain = g;
  }

  _stopSource() {
    if (!this.source) return;
    const s = this.source, g = this.srcGain;
    this.source = null;
    this.srcGain = null;
    s.onended = null;
    const now = this.ctx.currentTime;
    g.gain.cancelScheduledValues(now);
    g.gain.setValueAtTime(g.gain.value, now);
    g.gain.linearRampToValueAtTime(0, now + 0.01);
    try { s.stop(now + 0.012); } catch (e) { /* 이미 정지 */ }
    setTimeout(() => { s.disconnect(); g.disconnect(); }, 60);
  }

  play() {
    if (!this.buffer || this.playing) return;
    if (this.offset >= this.duration - 0.01) this.offset = 0;
    this.playing = true;
    this._start();
  }

  pause() {
    if (!this.playing) return;
    this.offset = this.position();
    this.playing = false;
    this._stopSource();
  }

  stop() {
    this.pause();
    this.preview = false;
  }

  toggle() {
    if (this.preview) { this.preview = false; return; }
    this.playing ? this.pause() : this.play();
  }

  seek(t) {
    if (!this.buffer) return;
    t = clamp(t, 0, this.duration - 0.001);
    const L = this.loop;
    if (L.active && (t < L.start - 0.001 || t >= L.end)) this.exitLoop();
    this.offset = t;
    if (this.playing) this._start();
  }

  // 비트그리드에 맞춰 스냅
  snap(t) {
    if (!this.quantize || !this.bpm) return t;
    const bl = this.beatLen;
    return this.grid + Math.round((t - this.grid) / bl) * bl;
  }

  // ---------- 템포 ----------
  _applyRate() {
    const r = (1 + this.pitch) * (1 + this.bend);
    if (Math.abs(r - this.rate) < 1e-7) return;
    if (this.playing) this._rebase();
    this.rate = r;
    if (this.source) this.source.playbackRate.setValueAtTime(r, this.ctx.currentTime);
    this._updateFx();
  }

  setPitch(p) {
    this.pitch = clamp(p, -0.5, 0.5);
    this._applyRate();
  }

  setBend(b) {
    this.bend = b;
    this._applyRate();
  }

  beatPhase(pos = this.position()) {
    if (!this.bpm) return null;
    const x = (pos - this.grid) / this.beatLen;
    return x - Math.floor(x);
  }

  targetPitchFor(master) {
    if (!this.bpm || !master.bpm) return null;
    let ratio = master.effectiveBpm / this.bpm;
    while (ratio > 1.5) ratio /= 2;
    while (ratio < 0.7) ratio *= 2;
    return ratio - 1;
  }

  syncTo(master, alignPhase = true) {
    const p = this.targetPitchFor(master);
    if (p === null) return false;
    if (Math.abs(p) > this.pitchRange) {
      this.pitchRange = Math.abs(p) <= 0.16 ? 0.16 : 0.5;
    }
    this.setPitch(p);
    if (alignPhase && this.playing && master.playing) {
      const pm = master.beatPhase();
      const pt = this.beatPhase();
      let d = pm - pt;
      if (d > 0.5) d -= 1;
      if (d < -0.5) d += 1;
      if (Math.abs(d) > 0.01) this.seek(this.position() + d * this.beatLen);
    }
    return true;
  }

  // ---------- CUE / 핫큐 ----------
  cueDown() {
    if (!this.buffer) return;
    if (this.playing) {
      this.pause();
      this.seek(this.cue);
      return;
    }
    const p = this.position();
    if (Math.abs(p - this.cue) < 0.03) {
      this.preview = true;
      this.play();
    } else {
      this.cue = this.snap(p);
      if (this.cue < 0) this.cue = 0;
      this.seek(this.cue);
    }
  }

  cueUp() {
    if (!this.preview) return;
    this.preview = false;
    this.pause();
    this.seek(this.cue);
  }

  hotcue(i) {
    if (!this.buffer) return;
    if (this.hotcues[i] == null) {
      this.hotcues[i] = Math.max(0, this.snap(this.position()));
    } else {
      this.seek(this.hotcues[i]);
      if (!this.playing) this.play();
    }
  }

  clearHotcue(i) { this.hotcues[i] = null; }

  // ---------- 루프 ----------
  setLoop(start, end) {
    if (!this.buffer) return;
    start = Math.max(0, start);
    end = Math.min(end, this.duration);
    if (end - start < 0.01) return;
    if (this.playing) this._rebase();
    const p = this.position();
    this.loop = { active: true, start, end };
    if (this.source) {
      this.source.loop = true;
      this.source.loopStart = start;
      this.source.loopEnd = end;
    }
    if (p >= end || p < start - this.beatLen * 0.5) this.seek(start);
  }

  exitLoop() {
    if (!this.loop.active) return;
    if (this.playing) this._rebase();
    this.loop.active = false;
    if (this.source) this.source.loop = false;
  }

  autoLoop(beats) {
    if (!this.buffer) return;
    const L = this.loop;
    const len = beats * this.beatLen;
    if (L.active && Math.abs(L.end - L.start - len) < 0.001) { this.exitLoop(); return; }
    let start = L.active ? L.start : this.snap(this.position());
    if (start < 0) start += this.beatLen;
    this.setLoop(start, start + len);
  }

  setLoopIn() {
    this.loopIn = Math.max(0, this.snap(this.position()));
  }

  setLoopOut() {
    if (this.loopIn == null) return;
    const out = this.snap(this.position());
    if (out > this.loopIn + 0.01) this.setLoop(this.loopIn, out);
  }

  loopResize(f) {
    const L = this.loop;
    if (!L.active) return;
    const len = (L.end - L.start) * f;
    if (len < 0.02) return;
    this.setLoop(L.start, L.start + len);
  }

  beatJump(beats) {
    if (!this.buffer) return;
    const d = beats * this.beatLen;
    if (this.loop.active) {
      const L = this.loop;
      const p = this.position();
      this.exitLoop();
      this.setLoop(L.start + d, L.end + d);
      this.seek(p + d);
      return;
    }
    this.seek(this.position() + d);
  }

  // ---------- 믹서 ----------
  setEq(band, db) {
    const node = band === 'low' ? this.eqLow : band === 'mid' ? this.eqMid : this.eqHigh;
    const v = db <= -25 ? -45 : db;
    node.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01);
  }

  setTrim(db) { this.input.gain.setTargetAtTime(Math.pow(10, db / 20), this.ctx.currentTime, 0.01); }
  setFader(v) { this.fader.gain.setTargetAtTime(v * v, this.ctx.currentTime, 0.008); }
  setXf(v) { this.xf.gain.setTargetAtTime(v, this.ctx.currentTime, 0.008); }

  // -1 = 로우패스, 0 = 오프, +1 = 하이패스
  setFilter(v) {
    const now = this.ctx.currentTime;
    let lp = 22000, hp = 10;
    if (v < -0.02) lp = 20000 * Math.pow(150 / 20000, -v);
    else if (v > 0.02) hp = 20 * Math.pow(8000 / 20, v);
    this.lpf.frequency.setTargetAtTime(lp, now, 0.015);
    this.hpf.frequency.setTargetAtTime(hp, now, 0.015);
    const q = Math.abs(v) > 0.02 ? 1 + Math.abs(v) * 4 : 0.7;
    this.lpf.Q.setTargetAtTime(q, now, 0.02);
    this.hpf.Q.setTargetAtTime(q, now, 0.02);
  }

  setFx(patch) {
    Object.assign(this.fx, patch);
    this._updateFx();
  }

  _updateFx() {
    const { type, on, amount, beats } = this.fx;
    const now = this.ctx.currentTime;
    const set = (param, v) => param.setTargetAtTime(v, now, 0.015);
    set(this.echoIn.gain, on && type === 'echo' ? 1 : 0);
    set(this.revIn.gain, on && type === 'reverb' ? 1 : 0);
    set(this.flIn.gain, on && type === 'flanger' ? 1 : 0);
    set(this.fxWet.gain, amount * (type === 'reverb' ? 1.4 : 1));
    const beat = this.bpm ? 60 / (this.bpm * this.rate) : 0.5;
    set(this.echoDelay.delayTime, Math.min(4.9, beat * beats));
    this.flLfo.frequency.setValueAtTime(1 / Math.max(0.2, beat * beats * 8), now);
  }

  // ---------- 스크래치 (바이닐 모드) ----------
  scratchGrain(from, to, dtSec) {
    if (!this.buffer || dtSec <= 0) return;
    const speed = (to - from) / dtSec;
    const abs = Math.abs(speed);
    if (abs < 0.05) return;
    const c = this.ctx;
    const fwd = speed > 0;
    let buf = this.buffer;
    let at = from;
    if (!fwd) {
      if (!this.reversed) this.reversed = Deck.reverseBuffer(c, this.buffer);
      buf = this.reversed;
      at = this.duration - from;
    }
    if (at < 0 || at >= this.duration) return;
    const s = c.createBufferSource();
    s.buffer = buf;
    s.playbackRate.value = clamp(abs, 0.1, 4);
    const g = c.createGain();
    const now = c.currentTime;
    const len = Math.max(0.03, Math.min(0.09, dtSec * 1.6));
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.9, now + 0.004);
    g.gain.setValueAtTime(0.9, now + len - 0.008);
    g.gain.linearRampToValueAtTime(0, now + len);
    s.connect(g);
    g.connect(this.input);
    s.start(now, at);
    s.stop(now + len + 0.005);
    s.onended = () => { s.disconnect(); g.disconnect(); };
  }

  static reverseBuffer(ctx, buf) {
    const r = ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const src = buf.getChannelData(ch);
      const dst = r.getChannelData(ch);
      const n = src.length;
      for (let i = 0; i < n; i++) dst[i] = src[n - 1 - i];
    }
    return r;
  }
}
