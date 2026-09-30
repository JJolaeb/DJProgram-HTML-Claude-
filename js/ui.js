'use strict';

// 회전 노브: 위/아래 드래그, 휠, 더블클릭 리셋
const Knob = {
  create(host, { label, min = 0, max = 1, value = 0, def = value, fmt, onChange, cls = '' }) {
    const el = document.createElement('div');
    el.className = 'knob ' + cls;
    el.innerHTML = `<div class="knob-dial"><div class="knob-ind"></div></div><div class="knob-label">${label}</div>`;
    host.appendChild(el);
    const dial = el.querySelector('.knob-dial');
    let v = value;

    const api = {
      el,
      get value() { return v; },
      set(nv, fire = true) {
        v = clamp(nv, min, max);
        const n = (v - min) / (max - min);
        dial.style.setProperty('--rot', (n * 270 - 135).toFixed(1) + 'deg');
        el.classList.toggle('centered', Math.abs(v - def) < 1e-6);
        el.title = `${label}: ${fmt ? fmt(v) : v.toFixed(2)} (더블클릭 = 리셋)`;
        if (fire && onChange) onChange(v);
      },
      reset() { api.set(def); },
    };

    dial.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      dial.setPointerCapture(e.pointerId);
      let y = e.clientY;
      const move = (ev) => {
        const dy = y - ev.clientY;
        y = ev.clientY;
        api.set(v + (dy * (max - min)) / (ev.shiftKey ? 900 : 180));
      };
      const up = () => {
        dial.removeEventListener('pointermove', move);
        dial.removeEventListener('pointerup', up);
        dial.removeEventListener('pointercancel', up);
      };
      dial.addEventListener('pointermove', move);
      dial.addEventListener('pointerup', up);
      dial.addEventListener('pointercancel', up);
    });
    dial.addEventListener('dblclick', () => api.reset());
    dial.addEventListener('wheel', (e) => {
      e.preventDefault();
      api.set(v - Math.sign(e.deltaY) * (max - min) / 40);
    }, { passive: false });

    api.set(value);
    return api;
  },
};

// 선형 페이더 (세로/가로)
const Fader = {
  create(el, { min = 0, max = 1, value = 0, def = value, vertical = true, invert = false, onChange, title = '' }) {
    el.classList.add('fader', vertical ? 'vertical' : 'horizontal');
    el.innerHTML = '<div class="fader-track"></div><div class="fader-center"></div><div class="fader-cap"></div>';
    el.title = title ? `${title} (더블클릭 = 리셋)` : '';
    const cap = el.querySelector('.fader-cap');
    let v = value;

    const toPos = (val) => {
      const n = (val - min) / (max - min);
      return vertical ? (invert ? n : 1 - n) : n;
    };
    const fromPos = (p) => {
      const n = vertical ? (invert ? p : 1 - p) : p;
      return min + n * (max - min);
    };

    const api = {
      el,
      get value() { return v; },
      set(nv, fire = true) {
        v = clamp(nv, min, max);
        el.style.setProperty('--p', toPos(v).toFixed(4));
        if (fire && onChange) onChange(v);
      },
      reset() { api.set(def); },
    };

    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      const rect = el.getBoundingClientRect();
      const capRect = cap.getBoundingClientRect();
      const capSize = vertical ? capRect.height : capRect.width;
      const onCap = e.target === cap;
      const grab = onCap
        ? (vertical ? e.clientY - (capRect.top + capSize / 2) : e.clientX - (capRect.left + capSize / 2))
        : 0;
      const place = (ev) => {
        const span = (vertical ? rect.height : rect.width) - capSize;
        const c = vertical ? ev.clientY - rect.top : ev.clientX - rect.left;
        const p = clamp((c - grab - capSize / 2) / span, 0, 1);
        api.set(fromPos(p));
      };
      if (!onCap) place(e);
      const up = () => {
        el.removeEventListener('pointermove', place);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
      };
      el.addEventListener('pointermove', place);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
    el.addEventListener('dblclick', () => api.reset());
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const step = (max - min) / 100;
      const dir = -Math.sign(e.deltaY) * (vertical && invert ? -1 : 1);
      api.set(v + dir * step);
    }, { passive: false });

    api.set(value, false);
    return api;
  },
};

// 캔버스를 CSS 크기 × devicePixelRatio 로 맞춤
function fitCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    return true;
  }
  return false;
}

function fmtTime(t, tenths = true) {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const base = `${m}:${String(s).padStart(2, '0')}`;
  return tenths ? `${base}.${Math.floor((t * 10) % 10)}` : base;
}

function toast(msg, ms = 2200) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), ms);
}
