/**
 * 大屏视觉验证脚本（DOM 几何断言，替代肉眼看图）
 *
 * 思路：切到某个状态后，不只检查"元素存在"，而是检查：
 *   - 激活的视图是不是预期的那一个
 *   - 元素数量对不对
 *   - 几何位置对不对（词云不重叠、柱状图高度与票数成正比、座位图不溢出容器）
 *   - 视觉属性对不对（字号随频次变化、弹幕动画已挂上、canvas 真的画了像素）
 *
 * 用法：node test/verify-visual.mjs [state...]  省略则跑全部
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOM = JSON.parse(fs.readFileSync(path.join(HERE, 'demo-room.json'), 'utf8')).code;
const STEP_FILE = path.join(HERE, 'step.txt');
const CHROME = process.env.CHROME || 'C:\\Users\\17790\\.agent-browser\\browsers\\chrome-152.0.7977.64\\chrome.exe';
const BASE = 'http://localhost:3000';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* 每个状态：先要经历的步骤序列 + 就绪条件（在页面里求值） */
const PLAN = {
  idle: { steps: ['idle'], ready: `v('view-idle') && q('#idle-avatars > *').length > 0` },
  poll: { steps: ['poll'], ready: `v('view-poll') && q('#poll-bars .bar').length === 5 && num('#poll-bars .bar-num') === 12` },
  word: { steps: ['word'], ready: `v('view-word') && q('#word-cloud .wc-word').length >= 10 && q('#danmaku-layer .dm-item').length > 0` },
  wheel: { steps: ['wheel'], ready: `v('view-wheel') && q('#wheel-list li').length === 8` },
  wheelspin: { steps: ['wheel', 'wheelspin'], ready: `el('#wheel-result').classList.contains('show') && txt('#wr-name').length > 0` },
  buzz: { steps: ['buzz'], ready: `v('view-buzz') && q('#buzz-podium > *').length === 3` },
  seat: { steps: ['seat'], ready: `v('view-seat') && q('#seat-map .seat').length === 48` },
  group: { steps: ['group'], ready: `v('view-group') && q('#group-grid .group-card').length === 5` },
};

/* 页面里注入的小工具 */
const HELPERS = `
  const q = (s) => Array.from(document.querySelectorAll(s));
  const el = (s) => document.querySelector(s);
  const txt = (s) => (el(s)?.textContent || '').trim();
  const num = (s) => q(s).reduce((a, e) => a + (Number(e.textContent) || 0), 0);
  const v = (id) => !!document.querySelector('.view.active#' + id);
`;

let pass = 0; let fail = 0; const failures = [];
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('   ✓', label); } else {
    fail++; failures.push(label + (extra ? ` — ${extra}` : ''));
    console.log('   ✗', label, extra ? `— ${extra}` : '');
  }
}

/** 等到元素位置连续两次采样完全一致（动画结束）再断言，避免测到过渡中间态 */
async function waitStable(page, selector, timeout = 9000) {
  await page.evaluate((s) => { window.__sig = null; window.__sel = s; }, selector);
  try {
    await page.waitForFunction(() => {
      const sig = Array.from(document.querySelectorAll(window.__sel))
        .map((e) => {
          const b = e.getBoundingClientRect();
          return `${Math.round(b.left)},${Math.round(b.top)},${Math.round(b.width)}`;
        }).join('|');
      const stable = sig === window.__sig;
      window.__sig = sig;
      return stable && sig.length > 0;
    }, { timeout, polling: 350 });
  } catch { /* 超时就按当前状态断言 */ }
}

async function assertState(page, name) {
  console.log(`\n[${name}] 断言`);
  const r = await page.evaluate(`(() => { ${HELPERS}\n const R = {};
    const stage = document.getElementById('wall').getBoundingClientRect();

    /* ---------- 通用：舞台尺寸 & 溢出 ---------- */
    R.stage = { w: Math.round(stage.width), h: Math.round(stage.height) };
    R.scroll = {
      x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      y: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    };
    R.activeViews = q('.view.active').length;
    const av = el('.view.active'); R.activeId = av ? av.id : null;

    /* ---------- 词云：重叠 / 越界 / 字号映射 ---------- */
    const words = q('#word-cloud .wc-word');
    R.words = words.length;
    if (words.length) {
      const box = el('#word-cloud').getBoundingClientRect();
      const rects = words.map((w) => {
        const b = w.getBoundingClientRect();
        return { b, size: parseFloat(getComputedStyle(w).fontSize), text: w.textContent.replace(/\\d+$/, '').trim() };
      });
      // 越界
      R.wcOut = rects.filter((r) => r.b.left < box.left - 2 || r.b.right > box.right + 2
        || r.b.top < box.top - 2 || r.b.bottom > box.bottom + 2).length;
      // 两两重叠（超过较小者面积 25% 才算真重叠，容忍描边/行高误差）
      let overlaps = 0; let worst = 0;
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i].b; const c = rects[j].b;
          const ow = Math.min(a.right, c.right) - Math.max(a.left, c.left);
          const oh = Math.min(a.bottom, c.bottom) - Math.max(a.top, c.top);
          if (ow > 0 && oh > 0) {
            const area = ow * oh;
            const small = Math.min(a.width * a.height, c.width * c.height);
            if (area / small > 0.25) { overlaps++; worst = Math.max(worst, area / small); }
          }
        }
      }
      R.wcOverlap = overlaps; R.wcWorst = Math.round(worst * 100);
      R.wcSizes = [...new Set(rects.map((r) => Math.round(r.size)))].sort((a, b) => a - b);
      // 最高频的词应当字号最大
      let top = rects[0]; for (const r of rects) if (r.size > top.size) top = r;
      R.wcTopWord = top.text; R.wcTopSize = Math.round(top.size);
      let low = rects[0]; for (const r of rects) if (r.size < low.size) low = r;
      R.wcLowSize = Math.round(low.size);
    }

    /* ---------- 弹幕：动画是否挂上 ---------- */
    const dms = q('#danmaku-layer .dm-item');
    R.danmaku = dms.length;
    if (dms.length) {
      const cs = getComputedStyle(dms[0]);
      R.dmAnim = cs.animationName; R.dmDur = cs.animationDuration;
      R.dmInLayer = dms.every((d) => {
        const b = d.getBoundingClientRect(); const lb = el('#danmaku-layer').getBoundingClientRect();
        return b.top >= lb.top - 60 && b.bottom <= lb.bottom + 60;
      });
    }

    /* ---------- 柱状图：高度是否与票数成正比 ---------- */
    const bars = q('#poll-bars .bar');
    R.bars = bars.length;
    if (bars.length) {
      R.barData = bars.map((b) => ({
        n: Number(b.querySelector('.bar-num').textContent) || 0,
        h: Math.round(b.querySelector('.bar-fill').getBoundingClientRect().height),
        label: b.querySelector('.bar-label').textContent.trim(),
      }));
      const track = Math.round(bars[0].querySelector('.bar-track').getBoundingClientRect().height);
      R.track = track;
      R.barOverflow = R.barData.filter((d) => d.h > track + 2).length;
      // 线性度：n>0 的柱子，h/n 应当接近同一个比例
      const ratios = R.barData.filter((d) => d.n > 0).map((d) => d.h / d.n);
      R.barLin = ratios.length > 1 ? Math.round((Math.max(...ratios) - Math.min(...ratios)) / Math.max(...ratios) * 100) : 0;
      const pb = el('#poll-bars').getBoundingClientRect();
      R.barOut = bars.filter((b) => {
        const x = b.getBoundingClientRect();
        return x.left < pb.left - 2 || x.right > pb.right + 2 || x.bottom > pb.bottom + 2;
      }).length;
    }

    /* ---------- 转盘：canvas 真的画了东西 ---------- */
    const cv = el('#wheel-canvas');
    if (cv && cv.width) {
      const ctx = cv.getContext('2d');
      const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
      let painted = 0; const seen = new Set();
      for (let i = 0; i < d.length; i += 4 * 97) {
        if (d[i + 3] > 10) { painted++; seen.add((d[i] >> 4) + ',' + (d[i + 1] >> 4) + ',' + (d[i + 2] >> 4)); }
      }
      R.wheelPainted = painted; R.wheelColors = seen.size;
      R.wheelBox = { w: Math.round(cv.getBoundingClientRect().width), h: Math.round(cv.getBoundingClientRect().height) };
    }
    R.wheelCands = q('#wheel-list li').length;
    R.wheelHit = q('#wheel-list li.hit').length;
    R.wheelResult = el('#wheel-result') ? el('#wheel-result').classList.contains('show') : false;
    R.wheelName = txt('#wr-name');

    /* ---------- 座位图 ---------- */
    const seats = q('#seat-map .seat');
    R.seats = seats.length;
    if (seats.length) {
      const box = el('#seat-map').getBoundingClientRect();
      R.seatOut = seats.filter((s) => {
        const b = s.getBoundingClientRect();
        return b.left < box.left - 2 || b.right > box.right + 2 || b.top < box.top - 2 || b.bottom > box.bottom + 2;
      }).length;
      R.seatSize = Math.round(seats[0].getBoundingClientRect().width);
      R.seatTaken = q('#seat-map .seat.taken').length;
      R.seatFront = q('#seat-map .seat.front').length;
      R.seatStar = q('#seat-map .seat-star').length;
    }
    R.frontRate = txt('#sr-num');

    /* ---------- 分组 ---------- */
    const gs = q('#group-grid .group-card');
    R.groups = gs.length;
    if (gs.length) {
      R.groupMembers = q('#group-grid .group-members > *').length;
      const box = el('#group-grid').getBoundingClientRect();
      R.groupOut = gs.filter((g) => {
        const b = g.getBoundingClientRect();
        return b.left < box.left - 2 || b.right > box.right + 2 || b.bottom > box.bottom + 2;
      }).length;
    }

    /* ---------- 抢答领奖台 ---------- */
    R.podium = q('#buzz-podium > *').length;
    if (R.podium) {
      const slots = q('#buzz-podium > *');
      const hs = slots.map((e) => Math.round(e.getBoundingClientRect().height));
      R.podiumHeights = hs;
      R.podiumLabels = slots.map((e) => (e.querySelector('.bz-rank')?.textContent || '').trim());
      // 标准领奖台排布：2 号在左、1 号居中、3 号在右，因此中间最高、右边最矮
      R.podiumDesc = hs[1] > hs[0] && hs[0] > hs[2];
    }

    /* ---------- 待机：二维码 / 头像墙 / 课堂码 ---------- */
    const qr = el('#w-qr-big');
    R.qr = qr ? { src: (qr.getAttribute('src') || '').slice(0, 40), nw: qr.naturalWidth, w: Math.round(qr.getBoundingClientRect().width) } : null;
    R.avatars = q('#idle-avatars > *').length;
    if (R.avatars) {
      const box = el('#idle-avatars').getBoundingClientRect();
      R.avatarOut = q('#idle-avatars > *').filter((a) => {
        const b = a.getBoundingClientRect();
        return b.right > box.right + 2 || b.bottom > box.bottom + 2 || b.left < box.left - 2;
      }).length;
    }
    R.code = txt('#w-code-big'); R.online = txt('#w-online');
    R.rank = q('#rank-list > *').length;
    return R;
  })()`);

  /* ---- 通用断言 ---- */
  ok(r.activeViews === 1, '有且仅有一个激活视图', `实际 ${r.activeViews} 个（${r.activeId}）`);
  ok(r.scroll.x <= 1 && r.scroll.y <= 1, '页面无滚动溢出', `x=${r.scroll.x} y=${r.scroll.y}`);
  ok(Math.abs(r.stage.w - 1920) <= 2 && Math.abs(r.stage.h - 1080) <= 2, '舞台保持 1920×1080 定尺', `${r.stage.w}×${r.stage.h}`);

  /* ---- 按状态断言 ---- */
  if (name === 'idle') {
    ok(r.activeId === 'view-idle', '激活 view-idle', r.activeId);
    ok(r.qr && r.qr.nw > 0 && r.qr.w > 100, '大二维码已加载且够大', JSON.stringify(r.qr));
    ok(r.avatars === 14, '头像墙显示全部 14 位同学', `实际 ${r.avatars}`);
    ok(r.avatarOut === 0, '头像未溢出容器', `${r.avatarOut} 个溢出`);
    ok(r.code === ROOM, '课堂码正确', `${r.code} vs ${ROOM}`);
    ok(r.online === '14', '在线人数为 14', r.online);
    ok(r.rank > 0, '积分榜有内容', `${r.rank} 行`);
  }
  if (name === 'poll') {
    ok(r.activeId === 'view-poll', '激活 view-poll', r.activeId);
    ok(r.bars === 5, '5 根柱子（5 个选项）', `实际 ${r.bars}`);
    ok(r.barData.reduce((a, b) => a + b.n, 0) === 12, '票数合计 12', String(r.barData.reduce((a, b) => a + b.n, 0)));
    ok(r.barLin <= 8, '柱高与票数成正比（误差<8%）', `线性偏差 ${r.barLin}%，数据 ${JSON.stringify(r.barData)}`);
    ok(r.barOverflow === 0, '柱子未超出轨道高度', `${r.barOverflow} 根溢出`);
    ok(r.barOut === 0, '柱子未溢出容器', `${r.barOut} 根溢出`);
    ok(r.barData.every((b) => b.label.length > 2), '每个选项都有文字标签');
  }
  if (name === 'word') {
    ok(r.activeId === 'view-word', '激活 view-word', r.activeId);
    ok(r.words >= 10, '词云节点数 ≥10', `实际 ${r.words}`);
    ok(r.wcOut === 0, '词语全部在词云容器内', `${r.wcOut} 个越界`);
    ok(r.wcOverlap === 0, '词语之间无重叠', `${r.wcOverlap} 对重叠（最大 ${r.wcWorst}%）`);
    ok(r.wcSizes.length >= 3, '字号至少 3 档（频次映射生效）', `字号档位 ${JSON.stringify(r.wcSizes)}`);
    // 字号按 sqrt(freq/max) 映射：4 次 -> 132px，1 次 -> 80px，比值 1.65
    ok(r.wcTopWord === '繁琐' && r.wcTopSize > r.wcLowSize * 1.5,
      '最高频词「繁琐」字号最大且明显更大', `top=${r.wcTopWord}(${r.wcTopSize}px) min=${r.wcLowSize}px 比值=${(r.wcTopSize / r.wcLowSize).toFixed(2)}`);
    ok(r.danmaku > 0, '弹幕节点已生成', `${r.danmaku} 条`);
    ok(r.dmAnim && r.dmAnim !== 'none', '弹幕已挂飞入动画', r.dmAnim);
    ok(parseFloat(r.dmDur) > 1, '弹幕动画时长合理', r.dmDur);
    ok(r.dmInLayer === true, '弹幕轨道在弹幕层内');
  }
  if (name === 'wheel' || name === 'wheelspin') {
    ok(r.activeId === 'view-wheel', '激活 view-wheel', r.activeId);
    ok(r.wheelBox && r.wheelBox.w > 400 && r.wheelBox.h > 400, '转盘画布尺寸足够大', JSON.stringify(r.wheelBox));
    ok(r.wheelPainted > 100, '转盘已绘制像素', `采样到 ${r.wheelPainted} 个不透明点`);
    ok(r.wheelColors >= 4, '转盘扇区有多种颜色', `${r.wheelColors} 种色块`);
    ok(r.wheelCands === 8, '候选列表 8 人', `实际 ${r.wheelCands}`);
  }
  if (name === 'wheelspin') {
    ok(r.wheelResult === true, '中奖卡已弹出');
    ok(r.wheelName.length > 0, '中奖者有名字', r.wheelName);
    ok(r.wheelHit === 1, '候选列表高亮唯一中奖者', `${r.wheelHit} 个高亮`);
  }
  if (name === 'buzz') {
    ok(r.activeId === 'view-buzz', '激活 view-buzz', r.activeId);
    ok(r.podium === 3, '领奖台 3 个位置', `实际 ${r.podium}`);
    ok(r.podiumDesc === true, '领奖台 2-1-3 排布且中间最高', `高度 ${JSON.stringify(r.podiumHeights)}`);
    ok(r.podiumLabels.join('/') === '2/1/3', '排名标签按 2/1/3 排布', r.podiumLabels.join('/'));
  }
  if (name === 'seat') {
    ok(r.activeId === 'view-seat', '激活 view-seat', r.activeId);
    ok(r.seats === 48, '座位图 6×8=48 个座位', `实际 ${r.seats}`);
    ok(r.seatOut === 0, '座位未溢出容器', `${r.seatOut} 个溢出`);
    ok(r.seatSize >= 26, '座位尺寸自适应且不过小', `${r.seatSize}px`);
    ok(r.seatTaken === 14, '14 个座位被占用', `实际 ${r.seatTaken}`);
    ok(r.seatStar === 16, '前排 2 排 16 个座位带★标记', `实际 ${r.seatStar}`);
    ok(r.frontRate.includes('57'), '前排就坐率约 57%（8/14）', r.frontRate);
  }
  if (name === 'group') {
    ok(r.activeId === 'view-group', '激活 view-group', r.activeId);
    ok(r.groups === 5, '分成 5 组', `实际 ${r.groups}`);
    ok(r.groupMembers === 14, '14 人全部被分组（无遗漏）', `实际 ${r.groupMembers}`);
    ok(r.groupOut === 0, '分组卡片未溢出容器', `${r.groupOut} 个溢出`);
  }
  return r;
}

(async () => {
  const only = process.argv.slice(2);
  const list = only.length ? only : Object.keys(PLAN);
  console.log('房间', ROOM, ' 验证状态：', list.join(', '));

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars', '--autoplay-policy=no-user-gesture-required'],
    defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
  });
  const page = await browser.newPage();
  await page.setCacheEnabled(false); // 避免复用旧版前端代码
  page.on('pageerror', (e) => console.log('  [页面报错]', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.log('  [控制台错误]', m.text()); });

  await page.goto(`${BASE}/w?room=${ROOM}`, { waitUntil: 'networkidle2', timeout: 20000 });
  await page.waitForFunction(`(() => { ${HELPERS} return Number(txt('#w-online')) > 0; })()`, { timeout: 10000 })
    .catch(() => console.log('  ! 等待学生上线超时'));

  for (const name of list) {
    const plan = PLAN[name];
    if (!plan) { console.log('未知状态', name); continue; }
    for (const step of plan.steps) {
      fs.writeFileSync(STEP_FILE, step);
      // demo 每 600ms 轮询一次 step.txt，等待必须显著大于该周期，否则指令会被漏掉
      await wait(step === 'wheelspin' ? 600 : 900);
    }
    try {
      await page.waitForFunction(`(() => { ${HELPERS} return ${plan.ready}; })()`, { timeout: 25000, polling: 200 });
    } catch { console.log(`  ! [${name}] 等待就绪超时，仍继续断言`); }
    await wait(400);
    // 词云有 0.68s 的位移过渡，必须等位置稳定后再做几何断言
    if (name === 'word') await waitStable(page, '#word-cloud .wc-word');
    await assertState(page, name);
    fs.writeFileSync(STEP_FILE, 'idle');
    await wait(1800);   // 必须 > demo 的 600ms 轮询周期，确保回到 idle 后再进入下一个状态
  }

  await browser.close();
  console.log(`\n${'='.repeat(52)}`);
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  if (failures.length) { console.log('失败明细：'); failures.forEach((f) => console.log('  -', f)); }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
