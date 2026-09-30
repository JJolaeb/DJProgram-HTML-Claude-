'use strict';

// 파형 해상도 (초당 bin 수)
const WF_RATE = 150;

const Analysis = (() => {
  // 트랙 분석: 파형(전체/저역 피크) + BPM + 비트그리드 오프셋
  async function analyze(buffer) {
    const sr = buffer.sampleRate;
    const len = buffer.length;

    // 킥 검출용 저역 통과 렌더
    const off = new OfflineAudioContext(1, len, sr);
    const src = off.createBufferSource();
    src.buffer = buffer;
    const f1 = off.createBiquadFilter();
    f1.type = 'lowpass';
    f1.frequency.value = 150;
    const f2 = off.createBiquadFilter();
    f2.type = 'lowpass';
    f2.frequency.value = 150;
    src.connect(f1);
    f1.connect(f2);
    f2.connect(off.destination);
    src.start(0);
    const low = (await off.startRendering()).getChannelData(0);

    const chs = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) chs.push(buffer.getChannelData(c));
    const nch = chs.length;
    const inv = 1 / nch;

    const binLen = sr / WF_RATE;
    const nb = Math.ceil(len / binLen);
    const peak = new Float32Array(nb);
    const lowPk = new Float32Array(nb);

    const HOP = 256;
    const nf = Math.floor(len / HOP);
    const eLow = new Float32Array(nf);
    const eFull = new Float32Array(nf);

    let b = 0, nextB = binLen, pk = 0, lp = 0;
    for (let i = 0; i < len; i++) {
      let m = 0;
      for (let c = 0; c < nch; c++) m += chs[c][i];
      m *= inv;
      const l = low[i];
      const am = m < 0 ? -m : m;
      const al = l < 0 ? -l : l;
      if (i >= nextB) {
        peak[b] = pk; lowPk[b] = lp;
        b++; nextB += binLen; pk = 0; lp = 0;
      }
      if (am > pk) pk = am;
      if (al > lp) lp = al;
      const f = (i / HOP) | 0;
      if (f < nf) { eLow[f] += l * l; eFull[f] += m * m; }
    }
    if (b < nb) { peak[b] = pk; lowPk[b] = lp; }

    let mx = 0;
    for (let i = 0; i < nb; i++) if (peak[i] > mx) mx = peak[i];
    if (mx > 0) {
      const k = 1 / mx;
      for (let i = 0; i < nb; i++) { peak[i] *= k; lowPk[i] = Math.min(1, lowPk[i] * k); }
    }

    const { bpm, grid } = detectBpm(eLow, eFull, sr / HOP);
    return { peak, low: lowPk, bpm, grid };
  }

  // 온셋 엔벨로프 자기상관 → 콤 필터로 정밀화
  function detectBpm(eLow, eFull, fr) {
    const n = eLow.length;
    if (n < fr * 6) return { bpm: 0, grid: 0 };

    const raw = new Float32Array(n);
    let pl = 0, pf = 0, sl = 0, sf = 0;
    const lo = new Float32Array(n), fu = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const l = Math.log1p(eLow[i] * 1000);
      const f = Math.log1p(eFull[i] * 1000);
      lo[i] = Math.max(0, l - pl);
      fu[i] = Math.max(0, f - pf);
      pl = l; pf = f;
      sl += lo[i]; sf += fu[i];
    }
    sl = sl ? n / sl : 0;
    sf = sf ? n / sf : 0;
    for (let i = 0; i < n; i++) raw[i] = lo[i] * sl + 0.5 * fu[i] * sf;

    // 약간 스무딩해서 프레임 오차 허용
    const on = new Float32Array(n);
    for (let i = 2; i < n - 2; i++) {
      on[i] = (raw[i - 2] + 2 * raw[i - 1] + 3 * raw[i] + 2 * raw[i + 1] + raw[i + 2]) / 9;
    }

    // 분석 구간: 곡 중앙 최대 100초
    const segLen = Math.min(n, Math.round(fr * 100));
    const start = Math.max(0, Math.floor((n - segLen) / 2));
    const seg = on.subarray(start, start + segLen);
    let mean = 0;
    for (let i = 0; i < segLen; i++) mean += seg[i];
    mean /= segLen;
    const o = new Float32Array(segLen);
    for (let i = 0; i < segLen; i++) o[i] = seg[i] - mean;

    const minLag = Math.floor(fr * 60 / 190);
    const maxLag = Math.min(segLen - 1, Math.ceil(fr * 60 / 65));
    let bestLag = 0, bestScore = -Infinity;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let s = 0;
      const cnt = segLen - lag;
      for (let i = 0; i < cnt; i++) s += o[i] * o[i + lag];
      s /= cnt;
      if (s <= 0) continue;
      const bpm = 60 * fr / lag;
      const w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 125), 2));
      const score = s * w;
      if (score > bestScore) { bestScore = score; bestLag = lag; }
    }
    if (!bestLag) return { bpm: 0, grid: 0 };

    let est = 60 * fr / bestLag;
    while (est < 78) est *= 2;
    while (est >= 176) est /= 2;

    // 콤 필터로 템포/위상 정밀 탐색
    let best = -Infinity, bestBpm = est, bestPhase = 0;
    for (let bpm = est - 2; bpm <= est + 2; bpm += 0.02) {
      const P = 60 * fr / bpm;
      const beats = Math.floor((segLen - P) / P);
      if (beats < 4) continue;
      const pMax = Math.floor(P);
      for (let ph = 0; ph < pMax; ph++) {
        let s = 0;
        for (let k = 0; k < beats; k++) s += seg[Math.round(ph + k * P)];
        if (s > best) { best = s; bestBpm = bpm; bestPhase = ph; }
      }
    }

    let bpm = bestBpm;
    if (Math.abs(bpm - Math.round(bpm)) < 0.07) bpm = Math.round(bpm);
    bpm = Math.round(bpm * 100) / 100;
    const beatSec = 60 / bpm;
    const phaseSec = (start + bestPhase + 0.5) / fr;
    const grid = ((phaseSec % beatSec) + beatSec) % beatSec;
    return { bpm, grid };
  }

  return { analyze, detectBpm };
})();

// 바로 믹스해볼 수 있는 데모 트랙 합성기
const Demo = (() => {
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

  async function make({ bpm, bars, chords, roots, seed = 1 }) {
    const sr = 44100;
    const beat = 60 / bpm;
    const dur = bars * 4 * beat;
    const ctx = new OfflineAudioContext(2, Math.ceil(dur * sr), sr);

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.ratio.value = 4;
    const master = ctx.createGain();
    master.gain.value = 0.8;
    master.connect(comp);
    comp.connect(ctx.destination);

    // 스테레오 딜레이 (코드 스탭용)
    const dly = ctx.createDelay(2);
    dly.delayTime.value = beat * 0.75;
    const dfb = ctx.createGain();
    dfb.gain.value = 0.35;
    const dwet = ctx.createGain();
    dwet.gain.value = 0.3;
    const pan = ctx.createStereoPanner();
    pan.pan.value = 0.5;
    dly.connect(dfb); dfb.connect(dly); dly.connect(pan); pan.connect(dwet); dwet.connect(master);

    let rnd = seed;
    const rand = () => { rnd = (rnd * 16807) % 2147483647; return rnd / 2147483647; };
    const noise = ctx.createBuffer(1, sr, sr);
    const nd = noise.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = rand() * 2 - 1;

    function kick(t) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.setValueAtTime(160, t);
      o.frequency.exponentialRampToValueAtTime(45, t + 0.11);
      g.gain.setValueAtTime(1, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.42);
      o.connect(g); g.connect(master);
      o.start(t); o.stop(t + 0.45);
    }
    function hat(t, v, decay = 0.05, freq = 7500) {
      const s = ctx.createBufferSource();
      s.buffer = noise;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(v, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + decay);
      s.connect(hp); hp.connect(g); g.connect(master);
      s.start(t, rand() * 0.5); s.stop(t + decay + 0.01);
    }
    function clap(t) {
      const s = ctx.createBufferSource();
      s.buffer = noise;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1300;
      bp.Q.value = 1.2;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      [0, 0.012, 0.024].forEach((d) => {
        g.gain.setValueAtTime(0.7, t + d);
        g.gain.exponentialRampToValueAtTime(0.1, t + d + 0.011);
      });
      g.gain.setValueAtTime(0.6, t + 0.036);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
      s.connect(bp); bp.connect(g); g.connect(master);
      s.start(t, rand() * 0.5); s.stop(t + 0.22);
    }
    function bass(t, midi, len) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = mtof(midi);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 6;
      lp.frequency.setValueAtTime(900, t);
      lp.frequency.exponentialRampToValueAtTime(180, t + len);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.32, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.001, t + len);
      o.connect(lp); lp.connect(g); g.connect(master);
      o.start(t); o.stop(t + len + 0.02);
    }
    function stab(t, notes, len, vol = 0.07) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(3200, t);
      lp.frequency.exponentialRampToValueAtTime(600, t + len);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, t + len);
      lp.connect(g); g.connect(master); g.connect(dly);
      notes.forEach((m) => {
        [-6, 6].forEach((det) => {
          const o = ctx.createOscillator();
          o.type = 'sawtooth';
          o.frequency.value = mtof(m);
          o.detune.value = det;
          o.connect(lp);
          o.start(t); o.stop(t + len + 0.02);
        });
      });
    }
    function pad(t, notes, len) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(400, t);
      lp.frequency.linearRampToValueAtTime(2400, t + len);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.05, t + len * 0.4);
      g.gain.linearRampToValueAtTime(0.0001, t + len);
      lp.connect(g); g.connect(master); g.connect(dly);
      notes.forEach((m) => {
        [-10, 0, 10].forEach((det) => {
          const o = ctx.createOscillator();
          o.type = 'sawtooth';
          o.frequency.value = mtof(m);
          o.detune.value = det;
          o.connect(lp);
          o.start(t); o.stop(t + len + 0.02);
        });
      });
    }

    const stabPattern = [0.5, 1.5, 2.75, 3.5];
    const breakA = Math.floor(bars / 2), breakB = breakA + 8;
    for (let bar = 0; bar < bars; bar++) {
      const bt = bar * 4 * beat;
      const ci = bar % chords.length;
      const inBreak = bar >= breakA && bar < breakB;
      const outro = bar >= bars - 8;
      for (let q = 0; q < 4; q++) {
        const t = bt + q * beat;
        if (!inBreak) kick(t);
        if (bar >= 4 && !inBreak) hat(t + beat / 2, 0.35, 0.06);
        if (bar >= 8 && !inBreak && (q === 1 || q === 3)) clap(t);
        if (bar >= 16 && !outro) {
          for (let s = 0; s < 4; s++) if (s !== 2) hat(t + (s * beat) / 4, 0.08, 0.025, 9000);
        }
        if (bar >= 8 && !inBreak && !outro) {
          bass(t + beat / 2, roots[ci], beat * 0.45);
          if (q === 3) bass(t + beat * 0.75, roots[ci] + 12, beat * 0.2);
        }
      }
      if (inBreak) pad(bt, chords[ci], 4 * beat);
      if (bar >= 16 && !inBreak && !outro) {
        stabPattern.forEach((p) => stab(bt + p * beat, chords[ci], beat * 0.4));
      }
    }
    return ctx.startRendering();
  }

  const presets = [
    {
      title: 'Sunset Groove', artist: 'PowerDJ Demo', bpm: 124, bars: 48, seed: 7,
      chords: [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]],
      roots: [33, 29, 36, 31],
    },
    {
      title: 'Night Drive', artist: 'PowerDJ Demo', bpm: 128, bars: 48, seed: 13,
      chords: [[62, 65, 69], [58, 62, 65], [53, 57, 60], [60, 64, 67]],
      roots: [38, 34, 29, 36],
    },
  ];

  return { make, presets };
})();
