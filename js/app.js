'use strict';

(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  const COLORS = {
    A: { full: '#7fd8ff', low: '#1a78ff' },
    B: { full: '#ffc38a', low: '#ff5a1a' },
  };
  const HOTCUE_COLORS = ['#ff3b5c', '#ffb020', '#2ee57a', '#8f6bff'];
  const ZOOMS = [3, 4, 6, 8, 12, 16, 24, 32];

  // ---------------- 오디오 엔진 ----------------
  const ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });

  const masterIn = ctx.createGain();
  const masterVol = ctx.createGain();
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -1;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.12;
  masterIn.connect(masterVol);
  masterVol.connect(limiter);
  limiter.connect(ctx.destination);

  const recDest = ctx.createMediaStreamDestination();
  limiter.connect(recDest);

  const splitter = ctx.createChannelSplitter(2);
  limiter.connect(splitter);
  const anL = ctx.createAnalyser();
  const anR = ctx.createAnalyser();
  anL.fftSize = anR.fftSize = 1024;
  splitter.connect(anL, 0);
  splitter.connect(anR, 1);

  const samplerBus = ctx.createGain();
  samplerBus.gain.value = 0.7;
  samplerBus.connect(masterIn);

  const decks = { A: new Deck('A', ctx, masterIn), B: new Deck('B', ctx, masterIn) };
  const other = (d) => (d === decks.A ? decks.B : decks.A);

  const engineState = $('#engineState');
  const resume = () => {
    if (ctx.state !== 'running') ctx.resume();
  };
  ctx.onstatechange = () => {
    const ok = ctx.state === 'running';
    engineState.textContent = ok ? `● ENGINE ${Math.round(ctx.sampleRate / 100) / 10}kHz` : '오디오 대기 중 — 아무 곳이나 클릭하세요';
    engineState.classList.toggle('ok', ok);
  };
  document.addEventListener('pointerdown', resume, true);
  document.addEventListener('keydown', resume, true);

  // ---------------- 상태 ----------------
  const library = [];
  let nextId = 1;
  let zoomIdx = 3;
  let sortKey = null, sortDir = 1;

  // ---------------- 덱 UI ----------------
  const ui = {};

  function buildDeck(deck) {
    const root = $('#deck' + deck.id);
    root.appendChild($('#deckTpl').content.cloneNode(true));
    const q = (s) => $(s, root);
    const u = {
      deck, root,
      title: q('.deck-title'), artist: q('.deck-artist'), bpm: q('.bpm-val'),
      elapsed: q('.t-elapsed'), remain: q('.t-remain'), pitchVal: q('.pitch-val'),
      overview: q('canvas.overview'), ovBase: null,
      platter: q('.platter'), disc: q('.platter-disc'),
      leds: $$('.beat-leds i', root),
      hc: $$('[data-act="hc"]', root),
      loopBtns: $$('[data-act="loop"]', root),
      play: q('[data-act="play"]'), cue: q('[data-act="cue"]'), sync: q('[data-act="sync"]'),
      tap: q('[data-act="tap"]'), fxOn: q('[data-act="fxon"]'),
      vinyl: q('[data-act="vinyl"]'), quant: q('[data-act="quant"]'),
      loopIn: q('[data-act="loopin"]'),
      range: q('.pitch-range'),
      zoom: $(`.zoomwave[data-deck="${deck.id}"] canvas`),
      taps: [],
      last: {},
    };
    u.ovCtx = u.overview.getContext('2d');
    u.zoomCtx = u.zoom.getContext('2d');
    q('.deck-letter').textContent = deck.id;
    ui[deck.id] = u;

    u.pitch = Fader.create(q('.pitch-fader'), {
      min: -1, max: 1, value: 0, def: 0, invert: true, title: '피치',
      onChange: (v) => {
        deck.sync = false;
        deck.setPitch(v * deck.pitchRange);
        refresh(deck);
      },
    });
    u.range.addEventListener('change', () => {
      deck.pitchRange = parseFloat(u.range.value);
      deck.setPitch(clamp(deck.pitch, -deck.pitchRange, deck.pitchRange));
      refresh(deck);
    });

    // FX
    const fxType = q('.fx-type'), fxBeats = q('.fx-beats');
    fxType.addEventListener('change', () => deck.setFx({ type: fxType.value }));
    fxBeats.addEventListener('change', () => deck.setFx({ beats: parseFloat(fxBeats.value) }));
    u.fxKnob = Knob.create(q('.fx-knob'), {
      label: 'WET', min: 0, max: 1, value: 0.5, def: 0.5,
      fmt: (v) => Math.round(v * 100) + '%',
      onChange: (v) => deck.setFx({ amount: v }),
    });

    // 클릭 액션
    root.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      switch (act) {
        case 'play': deck.toggle(); break;
        case 'sync': toggleSync(deck); break;
        case 'tap': tap(deck); break;
        case 'hc':
          if (e.shiftKey) deck.clearHotcue(+b.dataset.i);
          else deck.hotcue(+b.dataset.i);
          break;
        case 'loop': deck.autoLoop(+b.dataset.beats); break;
        case 'loophalf': deck.loopResize(0.5); break;
        case 'loopdouble': deck.loopResize(2); break;
        case 'loopin': deck.setLoopIn(); break;
        case 'loopout': deck.setLoopOut(); break;
        case 'loopexit': deck.exitLoop(); deck.loopIn = null; break;
        case 'jump': deck.beatJump(+b.dataset.beats); break;
        case 'fxon': deck.setFx({ on: !deck.fx.on }); break;
        case 'vinyl': deck.vinyl = !deck.vinyl; break;
        case 'quant': deck.quantize = !deck.quantize; break;
        default: return;
      }
      refresh(deck);
    });
    root.addEventListener('contextmenu', (e) => {
      const b = e.target.closest('button[data-act="hc"]');
      if (!b) return;
      e.preventDefault();
      deck.clearHotcue(+b.dataset.i);
      refresh(deck);
    });

    // 누르고 있는 버튼 (CUE, 벤드)
    const hold = (sel, down, up) => {
      const b = q(sel);
      b.addEventListener('pointerdown', (e) => {
        b.setPointerCapture(e.pointerId);
        down();
        refresh(deck);
      });
      const release = () => { up(); refresh(deck); };
      b.addEventListener('pointerup', release);
      b.addEventListener('pointercancel', release);
    };
    hold('[data-act="cue"]', () => deck.cueDown(), () => deck.cueUp());
    hold('[data-act="bend-"]', () => deck.setBend(-0.04), () => deck.setBend(0));
    hold('[data-act="bend+"]', () => deck.setBend(0.04), () => deck.setBend(0));

    // 오버뷰 클릭 탐색
    u.overview.addEventListener('pointerdown', (e) => {
      if (!deck.loaded) return;
      const r = u.overview.getBoundingClientRect();
      deck.seek(((e.clientX - r.left) / r.width) * deck.duration);
    });

    bindPlatter(u);
    bindZoomScrub(u);
    bindDrop(root, deck);

    deck.onEnd = () => refresh(deck);
    refresh(deck);
  }

  // 플래터: 바이닐 모드 = 스크래치, 아니면 피치 벤드 (정지 시 탐색)
  function bindPlatter(u) {
    const deck = u.deck;
    const SEC_PER_REV = 1.8;
    let drag = null;
    const angle = (e) => {
      const r = u.platter.getBoundingClientRect();
      return Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2));
    };
    u.platter.addEventListener('pointerdown', (e) => {
      if (!deck.loaded) return;
      e.preventDefault();
      u.platter.setPointerCapture(e.pointerId);
      const scratch = deck.vinyl || !deck.playing;
      drag = { a: angle(e), t: performance.now(), scratch, wasPlaying: deck.playing, vel: 0 };
      if (scratch && deck.playing) {
        deck.pause();
        deck.preview = false;
      }
      u.platter.classList.add('touch');
    });
    u.platter.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const a = angle(e);
      let da = a - drag.a;
      if (da > Math.PI) da -= 2 * Math.PI;
      if (da < -Math.PI) da += 2 * Math.PI;
      drag.a = a;
      const now = performance.now();
      const dt = Math.max(1, now - drag.t) / 1000;
      drag.t = now;
      const dPos = (da / (2 * Math.PI)) * SEC_PER_REV;
      if (drag.scratch) {
        const from = deck.offset;
        const to = clamp(from + dPos, 0, deck.duration - 0.001);
        deck.offset = to;
        deck.scratchGrain(from, to, dt);
      } else {
        drag.vel = drag.vel * 0.6 + (dPos / dt) * 0.4;
        deck.setBend(clamp(drag.vel * 0.25, -0.3, 0.3));
      }
    });
    const end = () => {
      if (!drag) return;
      if (drag.scratch && drag.wasPlaying) deck.play();
      if (!drag.scratch) deck.setBend(0);
      drag = null;
      u.platter.classList.remove('touch');
      refresh(deck);
    };
    u.platter.addEventListener('pointerup', end);
    u.platter.addEventListener('pointercancel', end);
  }

  function bindZoomScrub(u) {
    const deck = u.deck;
    let drag = null;
    u.zoom.addEventListener('pointerdown', (e) => {
      if (!deck.loaded) return;
      u.zoom.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, pos: deck.position(), wasPlaying: deck.playing };
      deck.pause();
    });
    u.zoom.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const pps = u.zoom.clientWidth / ZOOMS[zoomIdx];
      deck.offset = clamp(drag.pos - (e.clientX - drag.x) / pps, 0, deck.duration - 0.001);
    });
    const end = () => {
      if (!drag) return;
      if (drag.wasPlaying) deck.play();
      drag = null;
      refresh(deck);
    };
    u.zoom.addEventListener('pointerup', end);
    u.zoom.addEventListener('pointercancel', end);
    u.zoom.addEventListener('wheel', (e) => {
      e.preventDefault();
      setZoom(zoomIdx + (e.deltaY > 0 ? 1 : -1));
    }, { passive: false });
  }

  function bindDrop(el, deck) {
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      el.classList.add('drop-hover');
    });
    el.addEventListener('dragleave', (e) => {
      if (!el.contains(e.relatedTarget)) el.classList.remove('drop-hover');
    });
    el.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove('drop-hover');
      const id = e.dataTransfer.getData('text/x-powerdj-track');
      if (id) {
        const t = library.find((x) => x.id === +id);
        if (t) loadToDeck(t, deck);
        return;
      }
      const files = Array.from(e.dataTransfer.files).filter(isAudio);
      if (!files.length) return;
      const tracks = await addFiles(files);
      if (tracks[0]) loadToDeck(tracks[0], deck);
    });
  }

  function toggleSync(deck) {
    if (deck.sync) {
      deck.sync = false;
      return;
    }
    const m = other(deck);
    if (!deck.bpm || !m.bpm) {
      toast('두 덱 모두 BPM이 있어야 SYNC 할 수 있습니다');
      return;
    }
    deck.syncTo(m, true);
    deck.sync = true;
    const u = ui[deck.id];
    u.range.value = String(deck.pitchRange);
    u.pitch.set(deck.pitch / deck.pitchRange, false);
  }

  function tap(deck) {
    if (!deck.loaded) return;
    const u = ui[deck.id];
    const now = performance.now();
    if (u.taps.length && now - u.taps[u.taps.length - 1] > 2000) u.taps = [];
    u.taps.push(now);
    if (u.taps.length > 8) u.taps.shift();
    if (u.taps.length >= 4) {
      const iv = (u.taps[u.taps.length - 1] - u.taps[0]) / (u.taps.length - 1);
      const eff = 60000 / iv;
      deck.bpm = Math.round((eff / deck.rate) * 100) / 100;
      deck.grid = deck.position() % deck.beatLen;
      deck.track.bpm = deck.bpm;
      deck.track.grid = deck.grid;
      deck._updateFx();
      renderLibrary();
    }
  }

  function loadToDeck(track, deck) {
    if (track.status !== 'ready') {
      toast('아직 분석 중입니다…');
      return;
    }
    if (deck.playing) {
      toast(`DECK ${deck.id} 재생 중에는 로드할 수 없습니다`);
      return;
    }
    deck.load(track);
    track.played = true;
    const u = ui[deck.id];
    u.title.textContent = track.title;
    u.artist.textContent = track.artist || '—';
    u.ovBase = null;
    renderLibrary();
    refresh(deck);
    toast(`DECK ${deck.id} ← ${track.title}`);
  }

  // 버튼 점등 등 정적 상태 갱신
  function refresh(deck) {
    const u = ui[deck.id];
    u.play.classList.toggle('on', deck.playing);
    u.cue.classList.toggle('on', deck.loaded && !deck.playing);
    u.sync.classList.toggle('on', deck.sync);
    u.fxOn.classList.toggle('on', deck.fx.on);
    u.vinyl.classList.toggle('on', deck.vinyl);
    u.quant.classList.toggle('on', deck.quantize);
    u.loopIn.classList.toggle('on', deck.loopIn != null && !deck.loop.active);
    u.hc.forEach((b, i) => {
      const set = deck.hotcues[i] != null;
      b.classList.toggle('set', set);
      b.style.setProperty('--hc', HOTCUE_COLORS[i]);
      b.title = set ? `핫큐 ${i + 1}: ${fmtTime(deck.hotcues[i])} (우클릭 = 삭제)` : `핫큐 ${i + 1} 설정`;
    });
    const L = deck.loop;
    const beats = L.active ? (L.end - L.start) / deck.beatLen : 0;
    u.loopBtns.forEach((b) => b.classList.toggle('on', L.active && Math.abs(beats - +b.dataset.beats) < 0.01));
    u.root.classList.toggle('looping', L.active);
    u.root.classList.toggle('loaded', deck.loaded);
  }

  // ---------------- 믹서 ----------------
  const mixer = {};
  function buildChannel(deck) {
    const ch = $(`.channel[data-deck="${deck.id}"]`);
    const k = $('.knobs', ch);
    const dbFmt = (v) => (v <= -25 ? 'KILL' : (v > 0 ? '+' : '') + v.toFixed(1) + ' dB');
    // EQ 노브: 중앙 = 0dB, 왼쪽 끝 = KILL(-26dB 이하), 오른쪽 끝 = +6dB
    const eqDb = (v) => (v < 0 ? v * 26 : v * 6);
    const eqKnob = (host, label, band) => Knob.create(host, {
      label, min: -1, max: 1, value: 0,
      fmt: (v) => dbFmt(eqDb(v)),
      onChange: (v) => deck.setEq(band, eqDb(v)),
    });
    const m = {
      trim: Knob.create(k, { label: 'TRIM', min: -12, max: 12, value: 0, fmt: dbFmt, onChange: (v) => deck.setTrim(v) }),
      high: eqKnob(k, 'HI', 'high'),
      mid: eqKnob(k, 'MID', 'mid'),
      low: eqKnob(k, 'LOW', 'low'),
      filter: Knob.create(k, {
        label: 'FILTER', min: -1, max: 1, value: 0, cls: 'filter',
        fmt: (v) => (Math.abs(v) < 0.02 ? 'OFF' : v < 0 ? 'LPF ' + Math.round(-v * 100) + '%' : 'HPF ' + Math.round(v * 100) + '%'),
        onChange: (v) => deck.setFilter(v),
      }),
    };
    m.fader = Fader.create($('.ch-fader', ch), {
      min: 0, max: 1, value: 0.85, def: 0.85, title: `채널 ${deck.id} 볼륨`,
      onChange: (v) => deck.setFader(v),
    });
    deck.setFader(0.85);
    m.vu = $('.vu .vu-cover', ch);
    m.level = 0;
    mixer[deck.id] = m;
  }

  function xfGains(x, curve) {
    if (curve === 'cut') return [x > 0.94 ? (1 - x) / 0.06 : 1, x < 0.06 ? x / 0.06 : 1];
    if (curve === 'dipless') return [Math.min(1, 2 * (1 - x)), Math.min(1, 2 * x)];
    return [Math.cos((x * Math.PI) / 2), Math.sin((x * Math.PI) / 2)];
  }
  const xfCurve = $('#xfCurve');
  const applyXf = () => {
    const [a, b] = xfGains(xfader.value, xfCurve.value);
    decks.A.setXf(a);
    decks.B.setXf(b);
  };
  const xfader = Fader.create($('#xfader'), {
    min: 0, max: 1, value: 0.5, def: 0.5, vertical: false, title: '크로스페이더',
    onChange: applyXf,
  });
  xfCurve.addEventListener('change', applyXf);

  const masterKnob = Knob.create($('.master-knob'), {
    label: 'MASTER', min: 0, max: 1.2, value: 0.9, def: 0.9, cls: 'big',
    fmt: (v) => Math.round(v * 100) + '%',
    onChange: (v) => masterVol.gain.setTargetAtTime(v * v, ctx.currentTime, 0.01),
  });
  masterKnob.set(0.9);

  const vuMaster = { L: $('#vuL .vu-cover'), R: $('#vuR .vu-cover'), lL: 0, lR: 0 };
  const tdBuf = new Float32Array(1024);
  function meter(an) {
    an.getFloatTimeDomainData(tdBuf);
    let pk = 0;
    for (let i = 0; i < tdBuf.length; i++) {
      const a = Math.abs(tdBuf[i]);
      if (a > pk) pk = a;
    }
    const db = 20 * Math.log10(pk + 1e-9);
    return clamp((db + 48) / 48, 0, 1);
  }
  const setVu = (el, lvl) => { el.style.height = ((1 - lvl) * 100).toFixed(1) + '%'; };

  // ---------------- 파형 렌더링 ----------------
  function setZoom(i) {
    zoomIdx = clamp(i, 0, ZOOMS.length - 1);
  }
  $('#zoomIn').addEventListener('click', () => setZoom(zoomIdx - 1));
  $('#zoomOut').addEventListener('click', () => setZoom(zoomIdx + 1));

  function buildOverviewBase(u) {
    const c = u.overview;
    const w = c.width, h = c.height;
    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const g = off.getContext('2d');
    const { peak, low } = u.deck.track.wf;
    const n = peak.length;
    const mid = h / 2;
    const col = COLORS[u.deck.id];
    const layer = (arr, color) => {
      g.fillStyle = color;
      g.beginPath();
      for (let x = 0; x < w; x++) {
        const b0 = Math.floor((x * n) / w);
        const b1 = Math.max(b0 + 1, Math.floor(((x + 1) * n) / w));
        let p = 0;
        for (let b = b0; b < b1 && b < n; b++) if (arr[b] > p) p = arr[b];
        const hh = p * mid * 0.95;
        g.rect(x, mid - hh, 1, hh * 2);
      }
      g.fill();
    };
    layer(peak, col.full);
    layer(low, col.low);
    u.ovBase = off;
  }

  function drawOverview(u, pos) {
    const c = u.overview;
    if (fitCanvas(c)) u.ovBase = null;
    const g = u.ovCtx;
    const w = c.width, h = c.height;
    g.clearRect(0, 0, w, h);
    const deck = u.deck;
    if (!deck.loaded) return;
    if (!u.ovBase) buildOverviewBase(u);
    g.drawImage(u.ovBase, 0, 0);
    const dur = deck.duration;
    const px = (pos / dur) * w;
    g.fillStyle = 'rgba(6,8,12,0.55)';
    g.fillRect(0, 0, px, h);
    if (deck.loop.active) {
      const x0 = (deck.loop.start / dur) * w, x1 = (deck.loop.end / dur) * w;
      g.fillStyle = 'rgba(46,229,122,0.3)';
      g.fillRect(x0, 0, Math.max(2, x1 - x0), h);
    }
    const mark = (t, color) => {
      const x = Math.round((t / dur) * w);
      g.fillStyle = color;
      g.fillRect(x - 1, 0, 2, h);
      g.beginPath();
      g.moveTo(x - 5, 0); g.lineTo(x + 5, 0); g.lineTo(x, 7);
      g.fill();
    };
    mark(deck.cue, '#ffffff');
    deck.hotcues.forEach((t, i) => t != null && mark(t, HOTCUE_COLORS[i]));
    g.fillStyle = '#fff';
    g.fillRect(Math.round(px) - 1, 0, 2, h);
  }

  function drawZoom(u, pos) {
    const c = u.zoom;
    fitCanvas(c);
    const g = u.zoomCtx;
    const w = c.width, h = c.height;
    g.clearRect(0, 0, w, h);
    const deck = u.deck;
    const cx = Math.round(w * 0.5);
    if (!deck.loaded) {
      g.fillStyle = 'rgba(255,255,255,0.25)';
      g.fillRect(cx - 1, 0, 2, h);
      return;
    }
    const dur = deck.duration;
    const pps = w / ZOOMS[zoomIdx];
    const t0 = pos - cx / pps;
    const t1 = pos + (w - cx) / pps;
    const mid = h / 2;

    // 루프 영역
    if (deck.loop.active) {
      const x0 = (deck.loop.start - pos) * pps + cx;
      const x1 = (deck.loop.end - pos) * pps + cx;
      g.fillStyle = 'rgba(46,229,122,0.16)';
      g.fillRect(x0, 0, x1 - x0, h);
    }

    // 비트그리드
    if (deck.bpm) {
      const bl = 60 / deck.bpm;
      for (let k = Math.ceil((t0 - deck.grid) / bl); ; k++) {
        const t = deck.grid + k * bl;
        if (t > t1) break;
        if (t < 0) continue;
        const x = Math.round((t - pos) * pps + cx);
        const down = ((k % 4) + 4) % 4 === 0;
        g.fillStyle = down ? 'rgba(255,255,255,0.42)' : 'rgba(255,255,255,0.13)';
        g.fillRect(x, 0, down ? 2 : 1, h);
      }
    }

    const { peak, low } = deck.track.wf;
    const n = peak.length;
    const binsPerPx = WF_RATE / pps;
    const col = COLORS[deck.id];
    const layer = (arr, color) => {
      g.fillStyle = color;
      g.beginPath();
      for (let x = 0; x < w; x++) {
        const t = pos + (x - cx) / pps;
        if (t < 0 || t >= dur) continue;
        const b0 = Math.floor(t * WF_RATE);
        let p = arr[b0] || 0;
        if (binsPerPx > 1) {
          const b1 = Math.min(n, b0 + Math.ceil(binsPerPx));
          for (let b = b0 + 1; b < b1; b++) if (arr[b] > p) p = arr[b];
        }
        const hh = p * mid * 0.92;
        g.rect(x, mid - hh, 1, hh * 2);
      }
      g.fill();
    };
    layer(peak, col.full);
    layer(low, col.low);

    // 지나간 부분 어둡게
    g.fillStyle = 'rgba(6,8,12,0.35)';
    g.fillRect(0, 0, cx, h);

    // 큐 포인트
    const cueMark = (t, color, label) => {
      if (t < t0 || t > t1) return;
      const x = Math.round((t - pos) * pps + cx);
      g.fillStyle = color;
      g.fillRect(x - 1, 0, 2, h);
      g.fillRect(x, 0, 16, 14);
      g.fillStyle = '#000';
      g.font = `bold ${Math.round(11 * (w / c.clientWidth))}px system-ui`;
      g.fillText(label, x + 4, 11 * (h / c.clientHeight));
    };
    cueMark(deck.cue, '#ffffff', 'C');
    deck.hotcues.forEach((t, i) => t != null && cueMark(t, HOTCUE_COLORS[i], String(i + 1)));
    if (deck.loopIn != null && !deck.loop.active) cueMark(deck.loopIn, '#2ee57a', 'I');

    // 플레이헤드
    g.fillStyle = '#ff2d55';
    g.fillRect(cx - 1, 0, 3, h);
  }

  // ---------------- 프레임 루프 ----------------
  function frame() {
    for (const id of ['A', 'B']) {
      const deck = decks[id];
      const u = ui[id];
      const m = other(deck);

      // SYNC 잠금: 상대 덱 템포 따라가기
      if (deck.sync && deck.bpm && m.bpm) {
        const p = deck.targetPitchFor(m);
        if (p !== null && Math.abs(p - deck.pitch) > 1e-5) {
          deck.setPitch(p);
          if (Math.abs(p) > deck.pitchRange) {
            deck.pitchRange = Math.abs(p) <= 0.16 ? 0.16 : 0.5;
            u.range.value = String(deck.pitchRange);
          }
          u.pitch.set(deck.pitch / deck.pitchRange, false);
        }
      }

      const pos = deck.position();
      const dur = deck.duration;
      const L = u.last;

      const el = fmtTime(pos);
      if (L.el !== el) { u.elapsed.textContent = el; L.el = el; }
      const rm = '-' + fmtTime(Math.max(0, dur - pos));
      if (L.rm !== rm) { u.remain.textContent = rm; L.rm = rm; }
      const warn = deck.loaded && deck.playing && dur - pos < 30;
      if (L.warn !== warn) { u.remain.classList.toggle('warn', warn); L.warn = warn; }

      const bpmTxt = deck.bpm ? deck.effectiveBpm.toFixed(1) : '---.-';
      if (L.bpm !== bpmTxt) { u.bpm.textContent = bpmTxt; L.bpm = bpmTxt; }
      const pct = deck.pitch * 100;
      const pTxt = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
      if (L.p !== pTxt) { u.pitchVal.textContent = pTxt; L.p = pTxt; }

      const rot = ((pos * 0.5556 * 360) % 360).toFixed(1);
      if (L.rot !== rot) { u.disc.style.setProperty('--rot', rot + 'deg'); L.rot = rot; }

      let beat = -1;
      if (deck.loaded && deck.bpm) {
        const k = Math.floor((pos - deck.grid) / deck.beatLen);
        beat = ((k % 4) + 4) % 4;
      }
      if (L.beat !== beat) {
        u.leds.forEach((led, i) => led.classList.toggle('on', i === beat));
        L.beat = beat;
      }
      if (L.playing !== deck.playing) { refresh(deck); L.playing = deck.playing; }

      drawOverview(u, pos);
      drawZoom(u, pos);

      const mx = mixer[id];
      mx.level = Math.max(meter(deck.analyser), mx.level - 0.025);
      setVu(mx.vu, mx.level);
    }
    vuMaster.lL = Math.max(meter(anL), vuMaster.lL - 0.025);
    vuMaster.lR = Math.max(meter(anR), vuMaster.lR - 0.025);
    setVu(vuMaster.L, vuMaster.lL);
    setVu(vuMaster.R, vuMaster.lR);

    requestAnimationFrame(frame);
  }

  // ---------------- 라이브러리 ----------------
  const libBody = $('#libBody');
  const libSearch = $('#libSearch');
  const isAudio = (f) => f.type.startsWith('audio/') || /\.(mp3|wav|ogg|oga|m4a|aac|flac|webm|opus)$/i.test(f.name);

  function parseName(name) {
    const base = name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim();
    const i = base.indexOf(' - ');
    if (i > 0) return { artist: base.slice(0, i).trim(), title: base.slice(i + 3).trim() };
    return { artist: '', title: base };
  }

  function addTrack(meta) {
    const t = { id: nextId++, status: 'loading', bpm: 0, grid: 0, duration: 0, played: false, ...meta };
    library.push(t);
    renderLibrary();
    return t;
  }

  async function finishTrack(t, buffer) {
    t.buffer = buffer;
    t.duration = buffer.duration;
    t.status = 'analyzing';
    renderLibrary();
    const res = await Analysis.analyze(buffer);
    t.wf = { peak: res.peak, low: res.low };
    t.bpm = res.bpm;
    t.grid = res.grid;
    t.status = 'ready';
    renderLibrary();
  }

  async function addFiles(files) {
    const tracks = files.map((f) => addTrack({ ...parseName(f.name), file: f }));
    for (const t of tracks) {
      try {
        const data = await t.file.arrayBuffer();
        const buf = await ctx.decodeAudioData(data);
        await finishTrack(t, buf);
      } catch (err) {
        console.error(err);
        t.status = 'error';
        renderLibrary();
        toast(`디코딩 실패: ${t.title}`);
      }
    }
    return tracks.filter((t) => t.status === 'ready');
  }

  function renderLibrary() {
    const q = libSearch.value.trim().toLowerCase();
    let rows = library.filter((t) =>
      !q || t.title.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q) || String(Math.round(t.bpm)).includes(q));
    if (sortKey) {
      rows = rows.slice().sort((a, b) => {
        const x = a[sortKey], y = b[sortKey];
        return (typeof x === 'string' ? x.localeCompare(y) : x - y) * sortDir;
      });
    }
    $$('th[data-sort]').forEach((th) => {
      th.classList.toggle('sorted', th.dataset.sort === sortKey);
      th.dataset.dir = sortDir > 0 ? '▲' : '▼';
    });
    const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    libBody.innerHTML = rows.map((t, i) => {
      const onA = decks.A.track === t, onB = decks.B.track === t;
      const status = t.status === 'ready' ? (t.bpm ? t.bpm.toFixed(1) : '—')
        : t.status === 'error' ? '<span class="err">오류</span>' : '<span class="busy">분석 중</span>';
      return `<tr draggable="${t.status === 'ready'}" data-id="${t.id}" class="${t.played ? 'played' : ''}">
        <td class="c-num">${i + 1}</td>
        <td class="c-title">${onA ? '<i class="tag a">A</i>' : ''}${onB ? '<i class="tag b">B</i>' : ''}${esc(t.title)}</td>
        <td class="c-artist">${esc(t.artist || '')}</td>
        <td class="c-bpm">${status}</td>
        <td class="c-dur">${t.duration ? fmtTime(t.duration, false) : ''}</td>
        <td class="c-load"><button data-load="A" class="ld a">A</button><button data-load="B" class="ld b">B</button></td>
      </tr>`;
    }).join('');
    $('#library').classList.toggle('empty', library.length === 0);
  }

  libSearch.addEventListener('input', renderLibrary);
  $$('th[data-sort]').forEach((th) => th.addEventListener('click', () => {
    const k = th.dataset.sort;
    if (sortKey === k) sortDir = -sortDir;
    else { sortKey = k; sortDir = 1; }
    renderLibrary();
  }));
  libBody.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-load]');
    if (!b) return;
    const t = library.find((x) => x.id === +b.closest('tr').dataset.id);
    if (t) loadToDeck(t, decks[b.dataset.load]);
  });
  libBody.addEventListener('dblclick', (e) => {
    const tr = e.target.closest('tr');
    if (!tr || e.target.closest('button')) return;
    const t = library.find((x) => x.id === +tr.dataset.id);
    if (!t) return;
    loadToDeck(t, !decks.A.playing ? decks.A : decks.B);
  });
  libBody.addEventListener('dragstart', (e) => {
    const tr = e.target.closest('tr');
    if (!tr) return;
    e.dataTransfer.setData('text/x-powerdj-track', tr.dataset.id);
    e.dataTransfer.effectAllowed = 'copy';
  });

  $('#fileInput').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files).filter(isAudio);
    e.target.value = '';
    if (files.length) await addFiles(files);
  });

  // 창 어디든 파일 드롭 → 라이브러리에 추가
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files || []).filter(isAudio);
    if (files.length) addFiles(files);
  });

  async function loadDemos() {
    for (const p of Demo.presets) {
      const t = addTrack({ title: p.title, artist: p.artist });
      try {
        const buf = await Demo.make(p);
        await finishTrack(t, buf);
      } catch (err) {
        console.error(err);
        t.status = 'error';
        renderLibrary();
      }
    }
    const [a, b] = library;
    if (a && a.status === 'ready' && !decks.A.loaded) loadToDeck(a, decks.A);
    if (b && b.status === 'ready' && !decks.B.loaded) loadToDeck(b, decks.B);
  }

  // ---------------- 샘플러 ----------------
  const Sampler = {
    horn(t) {
      const blasts = [[0, 0.1], [0.14, 0.1], [0.28, 0.1], [0.42, 0.55]];
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1400;
      bp.Q.value = 0.8;
      const g = ctx.createGain();
      g.gain.value = 0;
      bp.connect(g); g.connect(samplerBus);
      blasts.forEach(([s, d]) => {
        g.gain.setValueAtTime(0, t + s);
        g.gain.linearRampToValueAtTime(0.5, t + s + 0.01);
        g.gain.setValueAtTime(0.5, t + s + d - 0.02);
        g.gain.linearRampToValueAtTime(0, t + s + d);
      });
      [466, 470, 932, 587].forEach((f) => {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(f, t);
        o.frequency.linearRampToValueAtTime(f * 0.97, t + 1);
        o.connect(bp);
        o.start(t); o.stop(t + 1.05);
      });
    },
    siren(t) {
      const o = ctx.createOscillator();
      o.type = 'square';
      const lfo = ctx.createOscillator();
      lfo.type = 'triangle';
      lfo.frequency.value = 2.5;
      const depth = ctx.createGain();
      depth.gain.value = 350;
      o.frequency.value = 900;
      lfo.connect(depth); depth.connect(o.frequency);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 2500;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.18, t + 0.05);
      g.gain.setValueAtTime(0.18, t + 1.8);
      g.gain.linearRampToValueAtTime(0, t + 2.2);
      o.connect(lp); lp.connect(g); g.connect(samplerBus);
      o.start(t); lfo.start(t);
      o.stop(t + 2.25); lfo.stop(t + 2.25);
    },
    laser(t) {
      for (let i = 0; i < 3; i++) {
        const s = t + i * 0.16;
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(3200, s);
        o.frequency.exponentialRampToValueAtTime(120, s + 0.28);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.25, s);
        g.gain.exponentialRampToValueAtTime(0.001, s + 0.3);
        o.connect(g); g.connect(samplerBus);
        o.start(s); o.stop(s + 0.32);
      }
    },
    drop(t) {
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(140, t);
      o.frequency.exponentialRampToValueAtTime(28, t + 1.6);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.9, t);
      g.gain.setValueAtTime(0.9, t + 1.2);
      g.gain.exponentialRampToValueAtTime(0.001, t + 2);
      o.connect(g); g.connect(samplerBus);
      o.start(t); o.stop(t + 2.05);
    },
  };
  function playSample(name, btn) {
    resume();
    Sampler[name](ctx.currentTime + 0.01);
    const b = btn || $(`.pad[data-sample="${name}"]`);
    b.classList.add('hit');
    setTimeout(() => b.classList.remove('hit'), 150);
  }
  $$('.pad').forEach((b) => b.addEventListener('pointerdown', () => playSample(b.dataset.sample, b)));
  Knob.create($('.sampler-vol'), {
    label: 'VOL', min: 0, max: 1, value: 0.7, def: 0.7,
    fmt: (v) => Math.round(v * 100) + '%',
    onChange: (v) => samplerBus.gain.setTargetAtTime(v, ctx.currentTime, 0.01),
  });

  // ---------------- 녹음 ----------------
  let recorder = null, recChunks = [], recStart = 0, recTimer = 0;
  const btnRec = $('#btnRec'), recTime = $('#recTime');
  btnRec.addEventListener('click', () => {
    if (recorder) {
      recorder.stop();
      return;
    }
    if (typeof MediaRecorder === 'undefined') {
      toast('이 브라우저는 녹음을 지원하지 않습니다');
      return;
    }
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
      .find((m) => MediaRecorder.isTypeSupported(m)) || '';
    recorder = new MediaRecorder(recDest.stream, mime ? { mimeType: mime } : undefined);
    recChunks = [];
    recorder.ondataavailable = (e) => e.data.size && recChunks.push(e.data);
    recorder.onstop = () => {
      const type = recorder.mimeType || 'audio/webm';
      const blob = new Blob(recChunks, { type });
      const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `powerdj-mix-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.${ext}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      recorder = null;
      clearInterval(recTimer);
      btnRec.classList.remove('on');
      toast('녹음 파일을 저장했습니다');
    };
    recorder.start(1000);
    recStart = performance.now();
    btnRec.classList.add('on');
    recTimer = setInterval(() => { recTime.textContent = fmtTime((performance.now() - recStart) / 1000, false).padStart(5, '0'); }, 250);
    toast('● 녹음 시작');
  });

  // ---------------- 도움말 ----------------
  const modal = $('#helpModal');
  $('#btnHelp').addEventListener('click', () => { modal.hidden = false; });
  $('#helpClose').addEventListener('click', () => { modal.hidden = true; });
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.hidden = true; });

  // ---------------- 키보드 ----------------
  const KEYMAP = {
    q: ['A', 'play'], w: ['A', 'cue'], e: ['A', 'sync'], a: ['A', 'loop4'], z: ['A', 'bend-'], x: ['A', 'bend+'],
    p: ['B', 'play'], o: ['B', 'cue'], i: ['B', 'sync'], l: ['B', 'loop4'], n: ['B', 'bend-'], m: ['B', 'bend+'],
    Digit1: ['A', 'hc', 0], Digit2: ['A', 'hc', 1], Digit3: ['A', 'hc', 2], Digit4: ['A', 'hc', 3],
    Digit7: ['B', 'hc', 0], Digit8: ['B', 'hc', 1], Digit9: ['B', 'hc', 2], Digit0: ['B', 'hc', 3],
  };
  const SAMPLE_KEYS = { g: 'horn', h: 'siren', j: 'laser', k: 'drop' };

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape') { modal.hidden = true; return; }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      xfader.set(xfader.value + (e.key === 'ArrowLeft' ? -0.05 : 0.05));
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); xfader.set(0.5); return; }
    if (e.repeat) return;
    const key = e.key.toLowerCase();
    if (SAMPLE_KEYS[key]) { playSample(SAMPLE_KEYS[key]); return; }
    const map = KEYMAP[e.code.startsWith('Digit') ? e.code : key];
    if (!map) return;
    e.preventDefault();
    const [id, act, arg] = map;
    const deck = decks[id];
    switch (act) {
      case 'play': deck.toggle(); break;
      case 'cue': deck.cueDown(); break;
      case 'sync': toggleSync(deck); break;
      case 'loop4': deck.autoLoop(4); break;
      case 'bend-': deck.setBend(-0.04); break;
      case 'bend+': deck.setBend(0.04); break;
      case 'hc': e.shiftKey ? deck.clearHotcue(arg) : deck.hotcue(arg); break;
    }
    refresh(deck);
  });
  document.addEventListener('keyup', (e) => {
    const map = KEYMAP[e.code.startsWith('Digit') ? e.code : e.key.toLowerCase()];
    if (!map) return;
    const [id, act] = map;
    const deck = decks[id];
    if (act === 'cue') deck.cueUp();
    if (act === 'bend-' || act === 'bend+') deck.setBend(0);
    refresh(deck);
  });

  // ---------------- 시작 ----------------
  buildDeck(decks.A);
  buildDeck(decks.B);
  buildChannel(decks.A);
  buildChannel(decks.B);
  applyXf();
  renderLibrary();
  requestAnimationFrame(frame);
  loadDemos();

  // 디버깅/테스트용
  window.PowerDJ = { ctx, decks, library, addFiles, loadToDeck };
})();
