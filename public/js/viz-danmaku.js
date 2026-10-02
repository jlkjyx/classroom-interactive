/* ==========================================================
   弹幕引擎 · 多轨道调度 + 冲入式飞入动画
   ========================================================== */

const TRACK_H = 74;        // 单条轨道高度 px
const BASE_SPEED = 190;    // 匀速段速度 px/s
const ENTER_BOOST = 2.4;   // 飞入段速度倍率

export class Danmaku {
  constructor(container, opts = {}) {
    this.el = container;
    this.trackH = opts.trackH || TRACK_H;
    this.speed = opts.speed || BASE_SPEED;
    this.enterBoost = opts.enterBoost || ENTER_BOOST;
    this.tracks = [];
    this.enabled = true;
    this.el.style.position = 'absolute';
    this.el.style.inset = '0';
    this.el.style.overflow = 'hidden';
    this.el.style.pointerEvents = 'none';
    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  _resize() {
    const h = this.el.clientHeight || window.innerHeight;
    const n = Math.max(3, Math.floor((h - 140) / this.trackH));
    this.trackCount = n;
    this.topOffset = 110;
    if (this.tracks.length !== n) {
      this.tracks = Array.from({ length: n }, (_, i) => this.tracks[i] || { freeAt: 0 });
      this.tracks.length = n;
    }
  }

  clear() {
    this.el.innerHTML = '';
    this.tracks.forEach((t) => (t.freeAt = 0));
  }

  /**
   * 发射一条弹幕
   * @param {{text:string, avatar?:string, color?:string, nickname?:string}} item
   */
  push(item, opts = {}) {
    if (!this.enabled) return null;
    const text = (item.text || '').trim();
    if (!text) return null;

    const el = document.createElement('div');
    el.className = 'dm-item' + (opts.big ? ' dm-big' : '');
    const color = item.color || '#22d3ee';
    el.style.setProperty('--dm-color', color);
    el.innerHTML = `
      <span class="dm-avatar">${item.avatar || '🙂'}</span>
      <span class="dm-text"></span>
      ${item.nickname ? `<span class="dm-nick"></span>` : ''}
    `;
    el.querySelector('.dm-text').textContent = text;
    if (item.nickname) el.querySelector('.dm-nick').textContent = item.nickname;

    this.el.appendChild(el);

    const w = el.offsetWidth || 160;
    const dist = (this.el.clientWidth || window.innerWidth) + w + 60;
    const duration = (dist / this.speed) * (1 + Math.random() * 0.25);

    // 轨道调度：选最早空闲且不与前一条追尾的轨道
    const now = performance.now();
    let idx = 0;
    let best = Infinity;
    for (let i = 0; i < this.trackCount; i++) {
      if (this.tracks[i].freeAt < best) { best = this.tracks[i].freeAt; idx = i; }
    }
    const startAt = Math.max(0, this.tracks[idx].freeAt - now);
    this.tracks[idx].freeAt = now + startAt + ((w + 90) / this.speed) * 1000;

    const top = this.topOffset + idx * this.trackH;
    el.style.top = top + 'px';
    el.style.left = '100%';
    el.style.animationDuration = duration + 's';
    el.style.animationDelay = startAt / 1000 + 's';
    el.classList.add('dm-fly');

    const total = (startAt / 1000 + duration) * 1000 + 200;
    setTimeout(() => el.remove(), total);
    return el;
  }

  /**
   * 撤下所有文本命中的弹幕。
   * 老师在控制端屏蔽某条内容时，大屏上正在飘的必须立刻消失——
   * 等它自己飘完这几秒，全班早就看见了。
   */
  removeByText(text) {
    const t = String(text || '').trim().toLowerCase();
    if (!t) return 0;
    const hit = [...this.el.querySelectorAll('.dm-item')].filter(
      (el) => (el.querySelector('.dm-text')?.textContent || '').trim().toLowerCase() === t,
    );
    hit.forEach((el) => el.remove());
    return hit.length;
  }

  burst(items) {
    items.forEach((it, i) => setTimeout(() => this.push(it), i * 90));
  }

  setEnabled(v) {
    this.enabled = !!v;
    this.el.style.display = v ? '' : 'none';
  }
}
