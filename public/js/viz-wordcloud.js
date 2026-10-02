/* ==========================================================
   词云引擎 · 螺旋布局 + 矩形碰撞检测 + 增量平滑动画
   ========================================================== */

const GAP_X = 12;   // 词与词之间的水平留白
const GAP_Y = 6;    // 词与词之间的垂直留白

export class WordCloud {
  constructor(container, opts = {}) {
    this.el = container;
    this.minSize = opts.minSize || 26;
    this.maxSize = opts.maxSize || 120;
    this.aspect = opts.aspect || 1.55;   // 横向拉伸，更贴合宽屏
    this.nodes = new Map();              // text -> {el, freq, color, w, h}
    this.placed = [];                    // 已占用矩形
    this.measure = document.createElement('canvas').getContext('2d');
    this.onAdd = opts.onAdd || null;
    this._dirty = false;
    this._raf = null;

    this.el.style.position = 'relative';
    window.addEventListener('resize', () => this.relayout());
  }

  clear() {
    for (const { el } of this.nodes.values()) el.remove();
    this.nodes.clear();
    this.placed = [];
  }

  /** 全量设置：items = [{text, color, avatar, nickname}] */
  setWords(items) {
    const freq = new Map();
    const meta = new Map();
    for (const it of items) {
      const t = (it.text || '').trim();
      if (!t) continue;
      freq.set(t, (freq.get(t) || 0) + 1);
      if (!meta.has(t)) meta.set(t, { color: it.color, avatar: it.avatar, nickname: it.nickname });
    }
    // 移除已消失的词
    for (const [t, node] of this.nodes) {
      if (!freq.has(t)) { node.el.remove(); this.nodes.delete(t); }
    }
    const max = Math.max(1, ...freq.values());
    let added = 0;
    for (const [t, f] of freq) {
      const size = this._sizeFor(f, max);
      const m = meta.get(t) || {};
      if (this.nodes.has(t)) {
        const node = this.nodes.get(t);
        if (node.freq !== f) {
          node.freq = f;
          node.size = size;
          this._styleNode(node, size);
          this._bump(node);
        }
      } else {
        const node = this._createNode(t, f, size, m);
        this.nodes.set(t, node);
        added++;
      }
    }
    this.relayout();
    if (added && this.onAdd) this.onAdd(added);
    return added;
  }

  _sizeFor(freq, max) {
    const t = Math.sqrt(freq / max);
    return Math.round(this.minSize + (this.maxSize - this.minSize) * t);
  }

  _createNode(text, freq, size, meta) {
    const el = document.createElement('div');
    el.className = 'wc-word anim-pop';
    el.textContent = text;
    const color = meta.color || this._randColor();
    el.style.setProperty('--wc-color', color);
    el.style.fontSize = size + 'px';
    if (meta.avatar) el.dataset.avatar = meta.avatar;
    this.el.appendChild(el);
    const node = { el, text, freq, size, color, w: 0, h: 0, x: 0, y: 0 };
    this._styleNode(node, size);
    return node;
  }

  _styleNode(node, size) {
    const { el } = node;
    el.style.fontSize = size + 'px';
    // 频率 >=2 时显示计数角标
    if (node.freq > 1) {
      if (!node.badge) {
        node.badge = document.createElement('i');
        node.badge.className = 'wc-badge';
        el.appendChild(node.badge);
      }
      node.badge.textContent = node.freq;
      el.classList.add('has-badge');
    }
    // 直接量 DOM 真实尺寸：canvas 度量依赖字体串与渲染字体一致，很容易算小导致压字。
    // 临时关掉过渡，保证拿到的是目标字号下的尺寸而不是动画中间值。
    const prevTrans = el.style.transition;
    el.style.transition = 'none';
    el.style.fontSize = size + 'px';
    node.w = Math.ceil(el.offsetWidth) + GAP_X;
    node.h = Math.ceil(el.offsetHeight) + GAP_Y;
    el.style.transition = prevTrans;
  }

  _bump(node) {
    // 重放入场动画：频次增加时让词再"弹"一下
    node.el.classList.remove('anim-pop');
    void node.el.offsetWidth;
    node.el.classList.add('anim-pop');
  }

  _randColor() {
    const pal = ['#22d3ee', '#a78bfa', '#f472b6', '#fbbf24', '#34d399', '#4c8dff', '#fb923c'];
    return pal[Math.floor(Math.random() * pal.length)];
  }

  /** 螺旋布局：按频次从大到小放置 */
  relayout() {
    const W = this.el.clientWidth;
    const H = this.el.clientHeight;
    if (!W || !H) return;
    const cx = W / 2;
    const cy = H / 2;

    const list = [...this.nodes.values()].sort((a, b) => b.freq - a.freq || b.size - a.size);
    this.placed = [];

    for (const node of list) {
      // 频次最高的放中心
      const pos = this._findSpot(node, cx, cy, W, H, list.indexOf(node) === 0);
      node.x = pos.x;
      node.y = pos.y;
      // 用 left/top 定位：transform 要留给入场 / 脉冲动画，
      // 否则 pop-in 的 fill-mode:both 会把定位 transform 永久覆盖成 scale(1)，词全堆到左上角
      if (!node.placedOnce) {
        node.el.style.transition = 'none';
        node.el.style.left = `${pos.x}px`;
        node.el.style.top = `${pos.y}px`;
        void node.el.offsetWidth;      // 强制回流，避免首次出现时从左上角滑入
        node.el.style.transition = '';
        node.placedOnce = true;
      } else {
        node.el.style.left = `${pos.x}px`;
        node.el.style.top = `${pos.y}px`;
      }
      node.el.style.zIndex = String(1000 - Math.round(node.freq * 10));
      this.placed.push({ x: pos.x, y: pos.y, w: node.w, h: node.h });
    }
  }

  _findSpot(node, cx, cy, W, H, forceCenter) {
    if (forceCenter) return { x: cx - node.w / 2, y: cy - node.h / 2 };
    let theta = Math.random() * Math.PI * 2;
    const step = 0.32;
    for (let i = 0; i < 2600; i++) {
      const r = 6 + 3.2 * theta;
      const x = cx + r * Math.cos(theta) * this.aspect - node.w / 2;
      const y = cy + r * Math.sin(theta) * 0.82 - node.h / 2;
      if (x < 6 || y < 6 || x + node.w > W - 6 || y + node.h > H - 6) {
        theta += step;
        continue;
      }
      if (!this._hits(x, y, node.w, node.h)) return { x, y };
      theta += step;
    }
    // 兜底：随机放在可视区
    return {
      x: Math.max(6, Math.random() * Math.max(1, W - node.w - 12)),
      y: Math.max(6, Math.random() * Math.max(1, H - node.h - 12)),
    };
  }

  _hits(x, y, w, h) {
    for (const p of this.placed) {
      if (x < p.x + p.w && x + w > p.x && y < p.y + p.h && y + h > p.y) return true;
    }
    return false;
  }

  /** 词频 Top N，供排行榜复用 */
  top(n = 8) {
    return [...this.nodes.values()]
      .sort((a, b) => b.freq - a.freq)
      .slice(0, n)
      .map((n2) => ({ text: n2.text, freq: n2.freq, color: n2.color }));
  }

  destroy() { this.clear(); }
}
