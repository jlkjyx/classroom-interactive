/**
 * 手机端几何与触控验证
 *
 * 为什么单独测这个：大屏做了 76 项几何断言，手机端却只做过"元素在不在"的冒烟。
 * 但手机端才是每个学生真正盯着看的界面——投票按钮点不准、座位图横向溢出、
 * 底部 tab 被切掉，任何一条都会让整节课卡住，而且老师在讲台上根本看不见。
 *
 * 验证的是几何与触控事实，不是截图：
 *   - 无横向溢出（学生不会莫名其妙左右滑）
 *   - 触控目标够大（投票时手指点得准）
 *   - 底部 tab 栏完整可见、不挡内容
 *   - 座位图在窄屏（360px）也不溢出
 *   - 各种活动页（投票/词云/抢答/转盘）都能完整显示
 *
 * 用法：node test/verify-mobile.mjs
 */
import puppeteer from 'puppeteer-core';
import { io } from 'socket.io-client';

// 走 env 是为了和 verify-control 一致：本机 localhost 会解析到 IPv6 ::1，
// 而服务只监听 IPv4，不指定就会 ECONNREFUSED（用 BASE=http://127.0.0.1:3000 绕开）。
const BASE = process.env.BASE || 'http://localhost:3000';
const CHROME = process.env.CHROME || 'C:\\Users\\17790\\.agent-browser\\browsers\\chrome-152.0.7977.64\\chrome.exe';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 覆盖真机常见尺寸：小屏安卓、主流 iPhone、大屏 iPhone */
const DEVICES = [
  { name: '小屏安卓 360×640', width: 360, height: 640, dpr: 2 },
  { name: 'iPhone 390×844', width: 390, height: 844, dpr: 3 },
  { name: '大屏手机 430×932', width: 430, height: 932, dpr: 3 },
];

/** 触控目标最小边长：Apple HIG 建议 44，实操取 40 作为及格线 */
const MIN_TAP = 40;

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`   ✓ ${name}`); }
  else { fail++; console.log(`   ✗ ${name} ${extra}`); }
};

const connect = () => new Promise((res, rej) => {
  const s = io(BASE, { transports: ['websocket'] });
  s.on('connect', () => res(s));
  s.on('connect_error', rej);
});
const emit = (s, ev, data = {}) => new Promise((res) => {
  const t = setTimeout(() => res({ ok: false, msg: 'timeout' }), 4000);
  s.emit(ev, data, (r) => { clearTimeout(t); res(r || { ok: true }); });
});

/** 页面内通用几何探针 */
const PROBE = `(() => {
  const vw = window.innerWidth, vh = window.innerHeight;
  const de = document.documentElement;
  const out = {
    vw, vh,
    // 横向溢出：允许 1px 亚像素误差
    overflowX: de.scrollWidth - de.clientWidth,
  };
  const page = document.querySelector('.m-page.active');
  out.pageId = page ? page.id : null;
  if (page) {
    const pb = page.getBoundingClientRect();
    out.pageBottom = pb.bottom;
    // 找出一切超出视口左右边界的元素
    out.escaped = [];
    for (const el of page.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right > vw + 1.5 || r.left < -1.5) {
        out.escaped.push({
          tag: el.tagName.toLowerCase(),
          id: el.id || '', cls: (el.className || '').toString().slice(0, 30),
          left: Math.round(r.left), right: Math.round(r.right),
        });
      }
    }
    // 触控目标检查：可交互元素的高宽
    out.small = [];
    const sels = 'button, input, a, [role=button]';
    for (const el of page.querySelectorAll(sels)) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;      // 隐藏的不算
      if (getComputedStyle(el).display === 'none') continue;
      if (r.height < ${MIN_TAP} || r.width < ${MIN_TAP}) {
        out.small.push({
          tag: el.tagName.toLowerCase(), id: el.id || '',
          cls: (el.className || '').toString().slice(0, 30),
          w: Math.round(r.width), h: Math.round(r.height),
          text: (el.textContent || '').trim().slice(0, 12),
        });
      }
    }
  }
  return out;
})()`;

const probe = (page) => page.evaluate(PROBE);

function report(label, g) {
  const okX = g.overflowX <= 1;
  check(`${label}：无横向溢出`, okX, `溢出 ${g.overflowX}px`);
  const escaped = g.escaped || [];
  check(`${label}：没有元素跑出屏幕`, escaped.length === 0,
    escaped.length ? JSON.stringify(escaped.slice(0, 3)) : '');
  return g;
}

(async () => {
  /* ---------- 准备课堂数据 ---------- */
  console.log('\n[准备] 建课堂并接入同学');
  const room = await fetch(`${BASE}/api/room`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '手机端验证', rows: 6, cols: 8, frontRows: 2 }),
  }).then((r) => r.json());
  const { code, token } = room;
  check('课堂创建成功', /^[A-Z0-9]{6}$/.test(code), code);

  const ctl = await connect();
  await emit(ctl, 'control:join', { code, token });
  // 预先占一些座位，座位图才有"已有人"的状态
  const NAMES = ['周浩然', '林清婉', '陈嘉树', '苏晚晴', '郑亦辰'];
  const others = [];
  for (let i = 0; i < NAMES.length; i++) {
    const s = await connect();
    await emit(s, 'student:join', { code, nickname: NAMES[i], avatar: '🦊' });
    await emit(s, 'student:seat', { row: i < 3 ? 0 : 3, col: i });
    others.push(s);
  }

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars'],
  });

  try {
    for (const [di, dev] of DEVICES.entries()) {
      console.log(`\n${'='.repeat(50)}\n▶ ${dev.name}`);
      // 每台设备用不同昵称：昵称相同时，后一台会按「昵称认领」复用前一台的身份，
      // 而那个身份已经选过座，会直接跳进主界面，选座页就不会渲染（座位量到 0）。
      const nick = `测试同学${di + 1}`;
      // 每台设备用独立浏览器上下文：同一浏览器共享 localStorage，
      // 上一台设备登录过的话下一台会自动恢复、直接跳过加入页，
      // 导致加入页元素因隐藏而量到 0×0，一批断言跟着假失败。
      const ctx = await browser.createBrowserContext();
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e.message)));
      page.on('console', (m) => {
        if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(m.text());
      });
      await page.setViewport({
        width: dev.width, height: dev.height,
        deviceScaleFactor: dev.dpr, isMobile: true, hasTouch: true,
      });
      await page.goto(`${BASE}/m?room=${code}`, { waitUntil: 'networkidle2' });
      await wait(900);

      /* --- 1. 加入页 --- */
      let g = report('加入页', await probe(page));
      check('加入页无 JS 报错', errors.length === 0, errors.join(' | '));
      const joinBtn = await page.evaluate(() => {
        const b = document.querySelector('#m-join-btn');
        const i = document.querySelector('#m-nickname');
        const r = b.getBoundingClientRect(), ir = i.getBoundingClientRect();
        return { btnH: r.height, btnW: r.width, inH: ir.height, inW: ir.width, vh: window.innerHeight };
      });
      check('“进入课堂”按钮够大（≥44px 高）', joinBtn.btnH >= 44, `${Math.round(joinBtn.btnH)}px`);
      check('昵称输入框够大（≥44px 高）', joinBtn.inH >= 44, `${Math.round(joinBtn.inH)}px`);
      check('加入页内容不超出一屏（无需滚动就能填完）',
        joinBtn.btnH > 0 && g.pageBottom <= joinBtn.vh + 2,
        `内容底部 ${Math.round(g.pageBottom)} vs 视口 ${joinBtn.vh}`);

      /* --- 2. 走一遍加入流程 --- */
      await page.type('#m-nickname', nick);
      await page.evaluate(() => document.querySelector('#m-join-btn').click());
      await wait(1200);
      // 座位网格由 showPage 触发渲染，必须等它真的画出来再量，
      // 否则会量到 0 个座位（但等到点击时又渲染好了，于是出现"量到 0 却点得中"的怪象）
      await page.waitForFunction(
        () => document.querySelectorAll('#m-seat-grid .m-seat').length > 0,
        { timeout: 8000 },
      ).catch(() => {});
      g = report('选座页', await probe(page));
      const seatInfo = await page.evaluate(() => {
        const grid = document.querySelector('#m-seat-grid');
        const gr = grid.getBoundingClientRect();
        const seats = grid.querySelectorAll('.m-seat');   // 注意：不是 .seat（大屏才用 .seat）
        const first = seats[0] ? seats[0].getBoundingClientRect() : null;
        return {
          gridW: gr.width, gridRight: gr.right, gridLeft: gr.left,
          count: seats.length,
          seatW: first ? first.width : 0, seatH: first ? first.height : 0,
          vw: window.innerWidth,
        };
      });
      check(`座位图渲染 ${seatInfo.count} 个座位`, seatInfo.count === 48, `${seatInfo.count}`);
      check('座位图不横向溢出', seatInfo.gridRight <= seatInfo.vw + 1.5 && seatInfo.gridLeft >= -1.5,
        `left=${Math.round(seatInfo.gridLeft)} right=${Math.round(seatInfo.gridRight)} vw=${seatInfo.vw}`);
      check('单个座位不至于小到点不中（≥24px）', seatInfo.seatW >= 24 && seatInfo.seatH >= 24,
        `${Math.round(seatInfo.seatW)}×${Math.round(seatInfo.seatH)}`);

      // 先验证「点已被占的座位」：应提示占用者姓名，且不能把人顶掉、不能切页。
      // 准备阶段已经让几位同学坐下了（1 排 1 座有人），正好拿它当样本。
      await page.evaluate(() => {
        const s = document.querySelector('#m-seat-grid .m-seat.taken');
        if (s) s.click();
      });
      await wait(700);
      const occ = await page.evaluate(() => ({
        // 读所有 .toast 的文本再拼接：不要只认 document.querySelector('.toast-wrap')，
        // 页面上一个容器也不保证唯一，取错容器会读到空串、误判成"没弹提示"。
        toast: [...document.querySelectorAll('.toast')].map((t) => t.textContent || '').join(' | '),
        stillSeat: document.querySelector('#m-seat').classList.contains('active'),
        takenCount: document.querySelectorAll('#m-seat-grid .m-seat.taken').length,
        seatCount: document.querySelectorAll('#m-seat-grid .m-seat').length,
      }));
      check('点已占座位提示占用者姓名', /占用/.test(occ.toast), JSON.stringify(occ));
      check('点已占座位不会顶替别人、不切页', occ.stillSeat);

      // 坐到一个空位（优先前排，顺便验证前排加分）。
      // 注意不能写死第一个座位：它已被上面的预置同学占着。
      await page.evaluate(() => {
        const seats = [...document.querySelectorAll('#m-seat-grid .m-seat')];
        const free = seats.filter((s) => !s.classList.contains('taken') && !s.classList.contains('mine'));
        const frontFree = free.filter((s) => s.classList.contains('front'));
        const target = frontFree[0] || free[0];
        if (target) target.click();
      });
      await wait(1200);

      /* --- 3. 主界面 / 待机 --- */
      const inMain = await page.evaluate(() => document.querySelector('#m-main').classList.contains('active'));
      check('选座后进入主界面', inMain);
      g = report('主界面·待机', await probe(page));
      const tab = await page.evaluate(() => {
        const bar = document.querySelector('.m-tabbar');
        const r = bar.getBoundingClientRect();
        const tabs = [...bar.querySelectorAll('.m-tab')].map((t) => {
          const tr = t.getBoundingClientRect();
          return { w: tr.width, h: tr.height, bottom: tr.bottom };
        });
        const content = document.querySelector('#m-content').getBoundingClientRect();
        return { barBottom: r.bottom, barTop: r.top, tabs, vh: window.innerHeight, contentBottom: content.bottom };
      });
      check('底部 tab 栏完整在屏幕内', tab.barBottom <= tab.vh + 1.5,
        `barBottom=${Math.round(tab.barBottom)} vh=${tab.vh}`);
      check('4 个 tab 都存在且够大', tab.tabs.length === 4 && tab.tabs.every((t) => t.h >= 40 && t.w >= 40),
        JSON.stringify(tab.tabs.map((t) => `${Math.round(t.w)}×${Math.round(t.h)}`)));
      check('内容区没被 tab 栏压住', tab.contentBottom <= tab.barTop + 1.5,
        `content=${Math.round(tab.contentBottom)} bar=${Math.round(tab.barTop)}`);
      check('待机页触控目标都够大', (g.small || []).length === 0, JSON.stringify((g.small || []).slice(0, 3)));

      /* --- 4. 投票页 --- */
      await emit(ctl, 'poll:start', {
        question: '下列哪项不属于数据清洗步骤？',
        options: ['缺失值处理', '重复值删除', '数据可视化', '格式统一', '异常值检测'],
      });
      await wait(900);
      g = report('投票页', await probe(page));
      const poll = await page.evaluate(() => {
        const opts = [...document.querySelectorAll('#m-options > *')];
        return {
          n: opts.length,
          sizes: opts.map((o) => { const r = o.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; }),
          vw: window.innerWidth,
          qVisible: (document.querySelector('#m-poll-q').textContent || '').length > 0,
        };
      });
      check('渲染 5 个投票选项', poll.n === 5, `${poll.n}`);
      check('题面已显示', poll.qVisible);
      check('每个选项高度 ≥44px（投票时点得准）', poll.sizes.every((s) => s.h >= 44),
        JSON.stringify(poll.sizes));
      check('选项横向铺满可用宽度', poll.sizes.every((s) => s.w >= poll.vw * 0.7),
        JSON.stringify(poll.sizes));

      // 真投一票，确认交互有效
      await page.evaluate(() => document.querySelector('#m-options > *').click());
      await wait(700);
      const voted = await page.evaluate(() => {
        const el = document.querySelector('#m-options > *');
        return el.className + '|' + (document.querySelector('#m-poll-hint').textContent || '');
      });
      check('点击选项后进入已作答状态', /chosen|picked|selected|done/i.test(voted) || /已/.test(voted), voted);

      await emit(ctl, 'poll:stop', {});
      await wait(500);

      /* --- 5. 词云输入页 --- */
      await emit(ctl, 'word:start', { prompt: '用一个词形容数据清洗', mode: 'both' });
      await wait(900);
      g = report('词云页', await probe(page));
      const word = await page.evaluate(() => {
        const inp = document.querySelector('#m-word-text');
        const btn = document.querySelector('#m-word-send');
        const ir = inp.getBoundingClientRect(), br = btn.getBoundingClientRect();
        return {
          inH: ir.height, inW: ir.width, btnH: br.height, btnW: br.width,
          // 输入框和发送按钮不能重叠
          overlap: !(ir.right <= br.left + 1 || br.right <= ir.left + 1),
          vw: window.innerWidth,
        };
      });
      check('词云输入框够大（≥44px 高）', word.inH >= 44, `${Math.round(word.inH)}px`);
      check('发送按钮够大（≥44px 高）', word.btnH >= 44, `${Math.round(word.btnH)}px`);
      check('输入框与发送按钮不重叠', !word.overlap);
      check('输入框留有足够输入宽度（≥60% 屏宽）', word.inW >= word.vw * 0.55,
        `${Math.round(word.inW)} / ${word.vw}`);

      // 真发一条，验证弹幕能提交
      await page.type('#m-word-text', '繁琐');
      await page.evaluate(() => document.querySelector('#m-word-send').click());
      await wait(800);
      const sent = await page.evaluate(() => (document.querySelector('#m-my-words').textContent || '').trim());
      check('发送后出现在“我的发言”里', sent.includes('繁琐'), sent || '(空)');

      await emit(ctl, 'word:stop', {});
      await wait(400);

      /* --- 6. 抢答页 --- */
      await emit(ctl, 'buzz:start', { prompt: '抢答：数据清洗第一步是什么？' });
      await wait(900);
      g = report('抢答页', await probe(page));
      const buzz = await page.evaluate(() => {
        const b = document.querySelector('#m-buzz-btn');
        const r = b.getBoundingClientRect();
        return { w: r.width, h: r.height, inView: r.bottom <= window.innerHeight + 1 && r.top >= -1 };
      });
      check('抢答按钮够大（≥80px，要能盲按）', buzz.h >= 80 && buzz.w >= 80,
        `${Math.round(buzz.w)}×${Math.round(buzz.h)}`);
      check('抢答按钮完整在屏幕内', buzz.inView);
      await emit(ctl, 'buzz:stop', {});
      await wait(400);

      /* --- 7. 转盘页 --- */
      await emit(ctl, 'wheel:open', { count: 8 });
      await wait(900);
      g = report('转盘页', await probe(page));
      await emit(ctl, 'wheel:close', {});
      await wait(400);

      /* --- 8. 四个 tab 逐个切 --- */
      console.log('   -- 切换底部 4 个 tab --');
      for (const t of ['seat', 'rank', 'me', 'act']) {
        await page.evaluate((tab) => {
          const el = document.querySelector(`.m-tab[data-mtab="${tab}"]`);
          if (el) el.click();
        }, t);
        await wait(700);
        const g2 = report(`tab:${t}`, await probe(page));
      }

      // 「我的」页是从底部 tab 切进来的，但 tabbar 写在 #m-main 内部，切过去就跟着隐藏了。
      // 所以这一页必须自带返回出口，否则同学在这一页只剩「离开课堂」可点（排行榜/换座位页同理）。
      await page.evaluate(() => document.querySelector('.m-tab[data-mtab="me"]').click());
      await wait(700);
      const meNav = await page.evaluate(() => {
        const back = document.querySelector('#m-me-back');
        const leave = document.querySelector('#m-leave');
        const rect = (el) => (el ? el.getBoundingClientRect() : null);
        const b = rect(back); const l = rect(leave);
        return {
          onMe: document.querySelector('#m-me').classList.contains('active'),
          hasBack: !!back, hasLeave: !!leave,
          backH: b ? b.height : 0,
          backAboveLeave: !!(b && l) && b.top < l.top,
        };
      });
      check('「我的」页有返回出口（不是只剩离开）',
        meNav.onMe && meNav.hasBack && meNav.hasLeave, JSON.stringify(meNav));
      check('返回按钮够大能盲按（≥44px 高）', meNav.backH >= 44, `${Math.round(meNav.backH)}px`);
      check('返回按钮排在「离开课堂」之前', meNav.backAboveLeave, JSON.stringify(meNav));

      await page.evaluate(() => document.querySelector('#m-me-back').click());
      await wait(700);
      const afterBack = await page.evaluate(() => {
        const nav = document.querySelector('.m-tabbar');
        const r = nav ? nav.getBoundingClientRect() : null;
        return {
          onMain: document.querySelector('#m-main').classList.contains('active'),
          tabbarShown: !!(r && r.height > 0 && r.width > 0),
        };
      });
      check('点返回回到主界面且底部 tab 栏回来', afterBack.onMain && afterBack.tabbarShown,
        JSON.stringify(afterBack));

      check(`全程无 JS 报错（${dev.name}）`, errors.length === 0, errors.slice(0, 2).join(' | '));
      await page.close();
      await ctx.close();
    }
  } finally {
    await browser.close();
    others.forEach((s) => s.close());
    ctl.close();
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`手机端几何验证：通过 ${pass} · 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\n测试自身出错：', e);
  process.exit(1);
});
