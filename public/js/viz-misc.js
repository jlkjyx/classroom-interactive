/* ==========================================================
   投票柱状图 / 座位热力图 / 庆祝粒子特效
   ========================================================== */

const LETTERS = 'ABCDEFGHIJKL';
const BAR_COLORS = [
  ['#22d3ee', '#0891b2'],
  ['#a78bfa', '#6d28d9'],
  ['#f472b6', '#be185d'],
  ['#fbbf24', '#d97706'],
  ['#34d399', '#047857'],
  ['#4c8dff', '#1d4ed8'],
  ['#fb923c', '#c2410c'],
  ['#2dd4bf', '#0f766e'],
];

/* ---------------- 投票柱状图 ---------------- */

export class BarChart {
  constructor(container, opts = {}) {
    this.el = container;
    this.el.className = 'bars';
    this.bars = [];
    this.onCountChange = opts.onCountChange || null;
  }

  setData({ options = [], totalVotes = 0, onlineCount = 0, multi = false }) {
    // 首次或选项数量变化时重建
    if (this.bars.length !== options.length) {
      this.el.innerHTML = '';
      this.bars = options.map((o, i) => this._createBar(o.text, i, options.length));
    }
    const max = Math.max(1, ...options.map((o) => o.count));
    options.forEach((o, i) => {
      const b = this.bars[i];
      if (!b) return;
      if (b.label !== o.text) { b.label = o.text; b.labelEl.textContent = `${LETTERS[i]}. ${o.text}`; }
      const pct = max ? (o.count / max) * 100 : 0;
      b.fill.style.height = `${Math.max(o.count > 0 ? 3 : 0, pct)}%`;
      if (b.count !== o.count) {
        b.count = o.count;
        this._rollNumber(b.numEl, o.count);
        b.wrap.classList.remove('pulse');
        void b.wrap.offsetWidth;
        b.wrap.classList.add('pulse');
        if (this.onCountChange) this.onCountChange(i, o.count);
      }
      const rate = onlineCount ? Math.round((o.count / onlineCount) * 100) : 0;
      b.pctEl.textContent = `${rate}%`;
    });
    this.el.dataset.total = totalVotes;
  }

  _createBar(text, i, total) {
    const [c1, c2] = BAR_COLORS[i % BAR_COLORS.length];
    const wrap = document.createElement('div');
    wrap.className = 'bar';
    wrap.style.setProperty('--c1', c1);
    wrap.style.setProperty('--c2', c2);
    wrap.style.animationDelay = `${i * 70}ms`;
    wrap.innerHTML = `
      <div class="bar-head">
        <span class="bar-num">0</span>
        <span class="bar-pct">0%</span>
      </div>
      <div class="bar-track">
        <div class="bar-fill"><span class="bar-shine"></span></div>
      </div>
      <div class="bar-label"></div>
    `;
    const labelEl = wrap.querySelector('.bar-label');
    labelEl.textContent = `${LETTERS[i]}. ${text}`;
    this.el.appendChild(wrap);
    return {
      wrap,
      label: text,
      labelEl,
      fill: wrap.querySelector('.bar-fill'),
      numEl: wrap.querySelector('.bar-num'),
      pctEl: wrap.querySelector('.bar-pct'),
      count: 0,
    };
  }

  _rollNumber(el, to) {
    const from = Number(el.textContent) || 0;
    if (from === to) { el.textContent = to; return; }
    const dur = 460;
    const t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      el.textContent = Math.round(from + (to - from) * e);
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /** 揭晓正确答案 */
  reveal(correctIndex) {
    this.bars.forEach((b, i) => {
      b.wrap.classList.remove('correct', 'wrong', 'dim');
      if (correctIndex === null || correctIndex === undefined || correctIndex < 0) return;
      if (i === correctIndex) b.wrap.classList.add('correct');
      else b.wrap.classList.add('dim');
    });
  }

  reset() {
    this.el.innerHTML = '';
    this.bars = [];
  }
}

/* ---------------- 座位热力图 ---------------- */

export class SeatMap {
  constructor(container) {
    this.el = container;
    this.el.className = 'seatmap';
  }

  render({ seatMap = { rows: 6, cols: 8, frontRows: 2 }, seats = [] }) {
    const { rows, cols, frontRows } = seatMap;
    const byKey = new Map();
    for (const s of seats) byKey.set(`${s.row}-${s.col}`, s);

    // 按舞台可用空间自适应座位尺寸，排数再多也不溢出
    const W = (this.el.clientWidth || 1200) - 60;
    const H = (this.el.clientHeight || 640) - 130;
    const gap = 12;
    const byW = (W - (cols - 1) * gap) / cols;
    const byH = (H - (rows - 1) * gap) / rows;
    const size = Math.max(26, Math.min(62, Math.floor(Math.min(byW, byH))));
    this.el.style.setProperty('--ss', size + 'px');
    this.el.style.setProperty('--cols', cols);

    let html = '<div class="seat-stage">';
    html += '<div class="podium">讲台</div>';
    html += '<div class="seat-grid">';
    for (let r = 0; r < rows; r++) {
      const isFront = r < frontRows;
      for (let c = 0; c < cols; c++) {
        const s = byKey.get(`${r}-${c}`);
        const cls = ['seat', isFront ? 'front' : '', s ? 'taken' : ''].join(' ');
        const style = s ? `style="--sc:${s.color}"` : '';
        html += `<div class="${cls}" ${style} data-r="${r}" data-c="${c}" title="${s ? `${r + 1}排${c + 1}座 · ${s.nickname}` : `${r + 1}排${c + 1}座`}">
          ${s ? `<span class="seat-avatar">${s.avatar}</span>` : ''}
          ${isFront ? '<span class="seat-star">★</span>' : ''}
        </div>`;
      }
    }
    html += '</div></div>';
    this.el.innerHTML = html;
  }
}

/* ---------------- 庆祝粒子 ---------------- */

export class Confetti {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.particles = [];
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.running = true;
    this._resize();
    window.addEventListener('resize', () => this._resize());
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  _resize() {
    const c = this.canvas;
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    c.width = this.w * this.dpr;
    c.height = this.h * this.dpr;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  _make(x, y, colors, spread = 1) {
    const a = Math.random() * Math.PI * 2;
    const v = (Math.random() * 11 + 5) * spread;
    return {
      x, y,
      vx: Math.cos(a) * v,
      vy: Math.sin(a) * v - 6,
      g: 0.26 + Math.random() * 0.16,
      size: Math.random() * 9 + 5,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.32,
      color: colors[Math.floor(Math.random() * colors.length)],
      life: 1,
      decay: 0.008 + Math.random() * 0.008,
      shape: Math.random() > 0.45 ? 'rect' : 'circle',
    };
  }

  burst({ x, y, count = 90, colors, spread = 1 } = {}) {
    const palette = colors || ['#22d3ee', '#a78bfa', '#f472b6', '#fbbf24', '#34d399', '#4c8dff', '#ffffff'];
    const cx = x ?? this.w / 2;
    const cy = y ?? this.h * 0.42;
    for (let i = 0; i < count; i++) this.particles.push(this._make(cx, cy, palette, spread));
    if (this.particles.length > 1400) this.particles.splice(0, this.particles.length - 1400);
  }

  /** 两侧礼炮 */
  cannons(count = 70) {
    const palette = ['#22d3ee', '#a78bfa', '#f472b6', '#fbbf24', '#34d399', '#ffffff'];
    for (let i = 0; i < count; i++) {
      const p = this._make(0, this.h * 0.92, palette, 1.5);
      p.vx = Math.abs(p.vx) * 1.1 + 3;
      p.vy = -(Math.random() * 15 + 9);
      this.particles.push(p);
    }
    for (let i = 0; i < count; i++) {
      const p = this._make(this.w, this.h * 0.92, palette, 1.5);
      p.vx = -Math.abs(p.vx) * 1.1 - 3;
      p.vy = -(Math.random() * 15 + 9);
      this.particles.push(p);
    }
  }

  /** 持续庆祝 */
  celebrate(ms = 3000) {
    const t0 = performance.now();
    const iv = setInterval(() => {
      this.burst({ x: Math.random() * this.w, y: this.h * (0.18 + Math.random() * 0.3), count: 34, spread: 1.15 });
      if (performance.now() - t0 > ms) clearInterval(iv);
    }, 260);
  }

  _loop() {
    if (!this.running) return;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.vy += p.g;
      p.vx *= 0.995;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      p.life -= p.decay;
      if (p.life <= 0 || p.y > this.h + 60) { this.particles.splice(i, 1); continue; }
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life));
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      if (p.shape === 'rect') ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.62);
      else { ctx.beginPath(); ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2); ctx.fill(); }
      ctx.restore();
    }
    requestAnimationFrame(this._loop);
  }
}
