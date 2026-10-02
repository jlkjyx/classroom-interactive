/* ==========================================================
   提问大转盘 · Canvas 绘制 + 多圈缓动旋转 + 中奖粒子
   ========================================================== */

const SEG_COLORS = [
  ['#22d3ee', '#0891b2'],
  ['#a78bfa', '#6d28d9'],
  ['#f472b6', '#be185d'],
  ['#fbbf24', '#d97706'],
  ['#34d399', '#047857'],
  ['#4c8dff', '#1d4ed8'],
  ['#fb923c', '#c2410c'],
  ['#c084fc', '#7e22ce'],
  ['#2dd4bf', '#0f766e'],
  ['#f87171', '#b91c1c'],
  ['#a3e635', '#4d7c0f'],
  ['#38bdf8', '#0369a1'],
];

export class Wheel {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.candidates = [];
    this.angle = 0;
    this.spinning = false;
    this.onSettle = opts.onSettle || null;
    this.onTick = opts.onTick || null;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this._resize();
    window.addEventListener('resize', () => { this._resize(); this.draw(); });
  }

  _resize() {
    const rect = this.canvas.getBoundingClientRect();
    const size = Math.min(rect.width, rect.height) || 620;
    this.size = size;
    this.canvas.width = size * this.dpr;
    this.canvas.height = size * this.dpr;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  setCandidates(list) {
    this.candidates = list || [];
    this.angle = this.angle % 360;
    this._applyTransform();
    this.draw();
  }

  /** 旋转到指定下标 */
  spin(index, { turns = 5, duration = 5000 } = {}) {
    if (this.spinning) return false;
    const n = Math.max(1, this.candidates.length);
    if (n === 1) {
      this.spinning = true;
      setTimeout(() => { this.spinning = false; this.onSettle && this.onSettle(0); }, 900);
      return true;
    }
    const seg = 360 / n;
    // 指针在顶部（-90°）。要让第 index 个扇区中心停在指针处
    const target = 360 - (index * seg + seg / 2);
    const cur = ((this.angle % 360) + 360) % 360;
    let delta = target - cur;
    while (delta < 0) delta += 360;
    const final = this.angle + turns * 360 + delta;

    this.spinning = true;
    this.canvas.style.transition = `transform ${duration}ms cubic-bezier(0.13, 0.72, 0.06, 1)`;
    this.canvas.style.transform = `rotate(${final}deg)`;
    this.angle = final;

    // 每经过一个扇区播一次 tick
    if (this.onTick) {
      const totalSeg = Math.round((turns * 360 + delta) / seg);
      // 用减速曲线近似排布 tick 音效：越靠后间隔越大
      if (this._tickTimers) this._tickTimers.forEach(clearTimeout);
      this._tickTimers = [];
      let acc = 0;
      const gaps = [];
      for (let i = 0; i < totalSeg; i++) {
        const k = i / totalSeg;
        const g = 46 + 420 * Math.pow(k, 3.1);
        gaps.push(g);
        acc += g;
      }
      const scale = duration / acc;
      let t = 0;
      for (let i = 0; i < totalSeg; i++) {
        t += gaps[i] * scale;
        this._tickTimers.push(setTimeout(() => this.onTick(i, totalSeg), t));
      }
    }

    clearTimeout(this._settleTimer);
    this._settleTimer = setTimeout(() => {
      this.spinning = false;
      this.onSettle && this.onSettle(index);
    }, duration + 120);
    return true;
  }

  _applyTransform() {
    this.canvas.style.transform = `rotate(${this.angle}deg)`;
    this.canvas.style.transition = 'none';
  }

  draw(highlightIndex = -1, resultIndex = -1) {
    const ctx = this.ctx;
    const S = this.size;
    const cx = S / 2;
    const cy = S / 2;
    const R = S / 2 - 14;
    const n = Math.max(1, this.candidates.length);
    const seg = (Math.PI * 2) / n;

    ctx.clearRect(0, 0, S, S);

    if (!this.candidates.length) {
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.04)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.lineWidth = 2;
      ctx.stroke();
      return;
    }

    for (let i = 0; i < n; i++) {
      const a0 = -Math.PI / 2 + i * seg;
      const a1 = a0 + seg;
      const [c1, c2] = SEG_COLORS[i % SEG_COLORS.length];
      const grad = ctx.createRadialGradient(cx, cy, R * 0.18, cx, cy, R);
      grad.addColorStop(0, c1);
      grad.addColorStop(1, c2);

      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, R, a0, a1);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.globalAlpha = resultIndex >= 0 && i !== resultIndex ? 0.34 : 1;
      ctx.fill();
      ctx.globalAlpha = 1;

      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.lineWidth = 2.5;
      ctx.stroke();

      if (i === resultIndex) {
        ctx.save();
        ctx.shadowColor = '#fff';
        ctx.shadowBlur = 26;
        ctx.strokeStyle = 'rgba(255,255,255,0.95)';
        ctx.lineWidth = 4;
        ctx.stroke();
        ctx.restore();
      }

      // 文字（头像 + 昵称）
      const mid = a0 + seg / 2;
      const tr = R * 0.72;
      ctx.save();
      ctx.translate(cx + Math.cos(mid) * tr, cy + Math.sin(mid) * tr);
      ctx.rotate(mid + Math.PI / 2);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      const c = this.candidates[i];
      const avatar = (c && c.avatar) || '🙂';
      const name = (c && c.nickname) || `同学${i + 1}`;
      const maxLen = n > 8 ? 5 : 7;
      const label = name.length > maxLen ? name.slice(0, maxLen) + '…' : name;

      ctx.shadowColor = 'rgba(0,0,0,0.45)';
      ctx.shadowBlur = 6;
      ctx.font = `${Math.round(S * 0.062)}px "PingFang SC","Microsoft YaHei",sans-serif`;
      ctx.fillStyle = '#ffffff';
      ctx.fillText(avatar, 0, -S * 0.035);
      ctx.font = `800 ${Math.round(S * 0.045)}px "PingFang SC","Microsoft YaHei",sans-serif`;
      ctx.fillText(label, 0, S * 0.03);
      ctx.restore();
    }

    // 中心圆盘
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.2, 0, Math.PI * 2);
    const cg = ctx.createLinearGradient(cx - R * 0.2, cy - R * 0.2, cx + R * 0.2, cy + R * 0.2);
    cg.addColorStop(0, '#1b2547');
    cg.addColorStop(1, '#0a1030');
    ctx.fillStyle = cg;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = `800 ${Math.round(S * 0.052)}px "PingFang SC",sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('谁', cx, cy - S * 0.02);
    ctx.fillText('来答', cx, cy + S * 0.032);

    // 外圈光环
    ctx.beginPath();
    ctx.arc(cx, cy, R + 6, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(34,211,238,0.35)';
    ctx.lineWidth = 6;
    ctx.shadowColor = '#22d3ee';
    ctx.shadowBlur = 22;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }
}
