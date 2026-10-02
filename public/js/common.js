/* ==========================================================
   公共库：连接层 / 提示 / 存储 / 粒子背景 / 音效
   ========================================================== */

/* ---------- 本地存储 ---------- */
export const ls = {
  get(k, def = null) {
    try { const v = localStorage.getItem(k); return v === null ? def : JSON.parse(v); }
    catch { return def; }
  },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

/* ---------- 工具 ---------- */
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
}

export function fmtClock(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function qs(name) {
  return new URLSearchParams(location.search).get(name);
}

/* ---------- Toast ---------- */
let toastWrap = null;
/**
 * 取（或建）toast 容器。
 *
 * 必须先查页面上已有的 `.toast-wrap` 再考虑新建：mobile.html 里就静态写了一个
 * 空的容器，直接 createElement 会挂上第二个，于是页面上同时存在两个
 * `.toast-wrap`——提示照常显示（新建的那个挂在 body 末尾、层级更高），
 * 但所有按 `querySelector('.toast-wrap')` 取文本的代码（含自动化测试）
 * 都会命中前面那个永远为空的，看起来就像"提示根本没弹出来"。
 */
function toastContainer() {
  if (toastWrap && toastWrap.isConnected) return toastWrap;
  toastWrap = document.querySelector('.toast-wrap');
  if (!toastWrap) {
    toastWrap = document.createElement('div');
    toastWrap.className = 'toast-wrap';
    document.body.appendChild(toastWrap);
  }
  return toastWrap;
}
/**
 * 轻提示。
 * @param {string} msg
 * @param {string} kind   '' | 'ok' | 'warn'
 * @param {number} ms
 * @param {{label:string, onClick:Function}|null} action  可选的操作按钮（如「撤销」）
 *
 * 带 action 时请把 ms 调长一些：老师正在讲课时不会盯着屏幕角落，
 * 2.4 秒就消失的撤销按钮等于没有。
 */
export function toast(msg, kind = '', ms = 2400, action = null) {
  const wrap = toastContainer();
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  if (action && action.label) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-act';
    btn.textContent = action.label;
    btn.onclick = () => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 320);
      try { action.onClick && action.onClick(); } catch (e) { console.error(e); }
    };
    el.appendChild(btn);
  }
  wrap.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 320);
  }, ms);
}

/* ---------- 网络层 ---------- */
export class Net {
  constructor() {
    this.socket = null;
    this.handlers = new Map();
    this.connected = false;
  }

  connect() {
    if (this.socket) return this.socket;
    const socket = (this.socket = window.io({ transports: ['websocket', 'polling'], upgrade: true }));

    socket.on('connect', () => {
      this.connected = true;
      this._fire('__connect');
      if (this.onReconnect && this._wasDown) {
        this._wasDown = false;
        this.onReconnect();
      }
    });
    socket.on('disconnect', () => {
      this.connected = false;
      this._wasDown = true;
      this._fire('__disconnect');
    });
    socket.on('connect_error', (e) => this._fire('__error', e));

    for (const evt of this.handlers.keys()) {
      if (evt.startsWith('__')) continue;
      socket.on(evt, (payload) => this._fire(evt, payload));
    }
    return socket;
  }

  /** 注册事件；必须在 connect 之前调用 */
  on(evt, fn) {
    if (!this.handlers.has(evt)) this.handlers.set(evt, []);
    this.handlers.get(evt).push(fn);
    if (this.socket && !evt.startsWith('__')) {
      this.socket.on(evt, (payload) => this._fire(evt, payload));
    }
    return this;
  }

  _fire(evt, payload) {
    const list = this.handlers.get(evt);
    if (!list) return;
    for (const fn of list) {
      try { fn(payload); } catch (e) { console.error(`[net:${evt}]`, e); }
    }
  }

  emit(evt, payload, ack) {
    if (!this.socket) return;
    if (typeof ack === 'function') this.socket.emit(evt, payload, ack);
    else this.socket.emit(evt, payload);
  }
}

/* ---------- 粒子背景 ---------- */
export class StarField {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.count = opts.count || 90;
    this.speed = opts.speed || 0.22;
    this.colors = opts.colors || ['#22d3ee', '#a78bfa', '#4c8dff', '#f472b6', '#fbbf24'];
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.particles = [];
    this.running = true;
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  resize() {
    const c = this.canvas;
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    c.width = this.w * this.dpr;
    c.height = this.h * this.dpr;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.particles = [];
    const n = Math.round((this.count * this.w * this.h) / (1920 * 1080));
    for (let i = 0; i < Math.max(30, n); i++) this.particles.push(this._make());
  }

  _make() {
    return {
      x: Math.random() * this.w,
      y: Math.random() * this.h,
      r: Math.random() * 2.1 + 0.5,
      vx: (Math.random() - 0.5) * this.speed,
      vy: -(Math.random() * this.speed + 0.06),
      a: Math.random() * 0.55 + 0.18,
      c: this.colors[Math.floor(Math.random() * this.colors.length)],
      tw: Math.random() * Math.PI * 2,
      tws: Math.random() * 0.02 + 0.006,
    };
  }

  _loop() {
    if (!this.running) return;
    const { ctx, w, h } = this;
    ctx.clearRect(0, 0, w, h);
    for (const p of this.particles) {
      p.x += p.vx;
      p.y += p.vy;
      p.tw += p.tws;
      if (p.y < -12) { p.y = h + 10; p.x = Math.random() * w; }
      if (p.x < -12) p.x = w + 10;
      if (p.x > w + 12) p.x = -10;
      const alpha = p.a * (0.55 + 0.45 * Math.sin(p.tw));
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = p.c;
      ctx.globalAlpha = alpha;
      ctx.shadowBlur = p.r * 5;
      ctx.shadowColor = p.c;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
    requestAnimationFrame(this._loop);
  }

  stop() { this.running = false; }
}

/* ---------- 音效（Web Audio 合成，无外部文件） ---------- */
export class Sfx {
  constructor() {
    this.ctx = null;
    this.enabled = ls.get('sfx_enabled', true);
  }

  _ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  toggle(v) {
    this.enabled = v === undefined ? !this.enabled : !!v;
    ls.set('sfx_enabled', this.enabled);
    return this.enabled;
  }

  tone({ freq = 660, dur = 0.14, type = 'sine', gain = 0.16, slide = 0, delay = 0 } = {}) {
    if (!this.enabled) return;
    const ctx = this._ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(60, freq + slide), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
  }

  click() { this.tone({ freq: 520, dur: 0.07, type: 'triangle', gain: 0.09 }); }
  pop() { this.tone({ freq: 720, dur: 0.11, type: 'sine', gain: 0.13, slide: 320 }); }
  success() {
    [523, 659, 784].forEach((f, i) => this.tone({ freq: f, dur: 0.16, type: 'sine', gain: 0.13, delay: i * 0.075 }));
  }
  fanfare() {
    [523, 659, 784, 1047].forEach((f, i) => this.tone({ freq: f, dur: 0.22, type: 'triangle', gain: 0.14, delay: i * 0.09 }));
  }
  tick() { this.tone({ freq: 880, dur: 0.045, type: 'square', gain: 0.05 }); }
  whoosh() {
    if (!this.enabled) return;
    const ctx = this._ensure();
    if (!ctx) return;
    const dur = 0.5;
    const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / data.length) ** 2;
    }
    const src = ctx.createBufferSource();
    const filt = ctx.createBiquadFilter();
    const g = ctx.createGain();
    src.buffer = buf;
    filt.type = 'bandpass';
    filt.frequency.setValueAtTime(400, ctx.currentTime);
    filt.frequency.exponentialRampToValueAtTime(2600, ctx.currentTime + dur);
    g.gain.value = 0.12;
    src.connect(filt).connect(g).connect(ctx.destination);
    src.start();
  }
  drumroll(seconds = 3) {
    if (!this.enabled) return;
    const ctx = this._ensure();
    if (!ctx) return;
    const n = Math.floor(seconds * 22);
    for (let i = 0; i < n; i++) {
      this.tone({ freq: 150 + Math.random() * 40, dur: 0.045, type: 'square', gain: 0.045 + (i / n) * 0.05, delay: i * (seconds / n) });
    }
  }
}

export const sfx = new Sfx();
