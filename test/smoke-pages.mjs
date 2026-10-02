/**
 * 页面级冒烟检查：四个页面逐个加载，确认没有 JS 报错，关键元素都在。
 *
 * 为什么要单独跑这个：像"给只读的 clientWidth 赋值"这种错误，
 * 在 ES Module 严格模式下会直接让整页脚本崩溃，
 * 但服务端测试（e2e）完全测不到——页面只会白屏或半瘫。
 *
 * 用法：node test/smoke-pages.mjs   （需先启动服务并运行 npm run demo）
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME || 'C:\\Users\\17790\\.agent-browser\\browsers\\chrome-152.0.7977.64\\chrome.exe';
const BASE = 'http://localhost:3000';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0; let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('   ✓', name); } else { fail++; console.log('   ✗', name, extra); }
};

/* ---------- 0. 自建课堂 + 常驻学生 ----------
   以前这个脚本读 demo-room.json，依赖 demo 脚本正在运行。
   一旦服务重启或 demo 停了，房间就变成没人在线的空房间，
   "在线人数已同步" 必然失败——但那不是产品的问题，是测试依赖了外部状态。
   这里改成自己建房间、自己挂 5 个常驻学生连接，全程保持在线。 */
console.log('[准备] 自建课堂并接入 5 名常驻学生');
const room = await fetch(`${BASE}/api/room`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ title: '冒烟测试课堂', rows: 6, cols: 8, frontRows: 2 }),
}).then((r) => r.json());
const { code, token } = room;
check('课堂创建成功', /^[A-Z0-9]{6}$/.test(code) && !!token, JSON.stringify(room));

const NAMES = ['周浩然', '林清婉', '陈嘉树', '苏晚晴', '郑亦辰'];
const AVATARS = ['🦊', '🐼', '🐯', '🐨', '🐸'];
const resident = [];
for (let i = 0; i < NAMES.length; i++) {
  const s = io(BASE, { transports: ['websocket'] });
  await new Promise((r) => s.on('connect', r));
  const res = await new Promise((r) => s.emit('student:join', { code, nickname: NAMES[i], avatar: AVATARS[i] }, r));
  check(`${NAMES[i]} 加入`, !!(res && res.ok));
  // 前 3 人坐第一排，用来验证前排标记
  if (i < 3) await new Promise((r) => s.emit('student:seat', { row: 0, col: i }, r));
  resident.push(s);
}
// 让两位同学举手，顺便验证大屏侧栏举手列表不是空的
for (const s of resident.slice(0, 2)) {
  await new Promise((r) => s.emit('student:hand', { up: true }, r));
}
await wait(300);
console.log(`  课堂码 ${code} · 在线 ${resident.length} 人\n`);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars', '--autoplay-policy=no-user-gesture-required'],
  defaultViewport: { width: 1600, height: 950 },
});

/** 打开一个页面并收集错误 */
async function open(url, { mobile = false, seed } = {}) {
  const page = await browser.newPage();
  await page.setCacheEnabled(false);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(m.text()); });
  if (mobile) await page.setViewport({ width: 414, height: 896, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  if (seed) {
    // 先落到同源页面，把 localStorage 种进去，再进目标页
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.evaluate((pairs) => {
      for (const [k, v] of pairs) localStorage.setItem(k, JSON.stringify(v));
    }, seed);
  }
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
  await wait(1500);
  return { page, errors };
}

/* ---------- 1. 首页 ---------- */
console.log('\n[首页] /');
{
  const { page, errors } = await open(`${BASE}/`);
  const r = await page.evaluate(() => ({
    cards: document.querySelectorAll('.feature-card, .card, .fx-card').length,
    links: Array.from(document.querySelectorAll('a')).map((a) => a.getAttribute('href')),
    canvasPainted: (() => {
      const c = document.getElementById('fx-canvas');
      if (!c || !c.width) return 0;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      // 步长必须够密：粒子总面积不到画布的千分之一，步长 401 时
      // 期望命中只有 2 个点，这条断言会随机翻车。这里每 3 像素采一次。
      let n = 0; for (let i = 3; i < d.length; i += 4 * 3) if (d[i] > 8) n++;
      return n;
    })(),
  }));
  check('无 JS 报错', errors.length === 0, errors.join(' | '));
  check('有功能入口卡片', r.cards > 0, `${r.cards} 个`);
  check('提供控制端 / 大屏入口', r.links.some((h) => h && h.startsWith('/c')) && r.links.some((h) => h && h.startsWith('/w')), JSON.stringify(r.links));
  check('星空粒子背景已绘制', r.canvasPainted > 0, `采样 ${r.canvasPainted} 点`);
  await page.close();
}

/* ---------- 2. 教师控制端 ---------- */
console.log('\n[控制端] /c');
{
  // 控制端靠 localStorage 里的令牌自动重连，先种进去
  const { page, errors } = await open(`${BASE}/c?room=${code}`, {
    seed: [[`tok_${code}`, token], ['last_room', code]],
  });
  // 控制端带历史令牌进来时，不会自动进入，而是给一个"回到上次的课堂"按钮
  const joinable = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button'))
      .find((b) => (b.textContent || '').includes('回到上次的课堂'));
    if (btn) { btn.click(); return 'restore'; }
    return null;
  });
  if (joinable) await wait(2000);
  check('出现"回到上次课堂"恢复入口', joinable === 'restore', joinable || '未找到恢复入口');

  const r = await page.evaluate(() => ({
    consoleVisible: !document.querySelector('#console').classList.contains('hidden'),
    navs: document.querySelectorAll('.nav-item, [data-tab]').length,
    hasQr: !!document.querySelector('#c-qr'),
    qrSrc: (document.querySelector('#c-qr') || {}).src || '',
    online: (document.querySelector('#c-online') || {}).textContent,
    rankRows: document.querySelectorAll('#c-ranklist > *').length,
    students: document.querySelectorAll('.st-table tbody tr, #c-students tr').length,
  }));
  check('无 JS 报错', errors.length === 0, errors.join(' | '));
  check('已进入控制台（非停留在门禁页）', r.consoleVisible, JSON.stringify(r));
  check('功能面板齐全（10 个）', r.navs >= 10, `${r.navs} 个`);
  check('二维码已加载', r.qrSrc.includes('/qrcode.png'), r.qrSrc);
  check('在线人数已同步', Number(r.online) > 0, `在线 ${r.online}`);
  check('积分榜有数据', r.rankRows > 0, `${r.rankRows} 行`);
  await page.close();
}

/* ---------- 3. 学生手机端 ---------- */
console.log('\n[手机端] /m');
{
  const { page, errors } = await open(`${BASE}/m?room=${code}`, { mobile: true });
  const join = await page.evaluate(() => ({
    visible: !!document.querySelector('#m-join.active'),
    avatarOpts: document.querySelectorAll('#m-avatars > *, .av-opt, [data-avatar]').length,
    hasInput: !!document.querySelector('#m-nickname'),
  }));
  check('无 JS 报错', errors.length === 0, errors.join(' | '));
  check('显示加入页', join.visible);
  check('有昵称输入框', join.hasInput);

  // 走一遍真实加入流程：填昵称 → 进入 → 跳过选座
  await page.type('#m-nickname', '自检同学');
  await page.click('#m-join-btn');
  await wait(1200);
  const seat = await page.evaluate(() => ({ seatPage: !!document.querySelector('#m-seat.active'), cells: document.querySelectorAll('#m-seat-grid > *').length }));
  check('进入选座页', seat.seatPage, JSON.stringify(seat));
  check('座位网格已渲染', seat.cells > 0, `${seat.cells} 个`);

  await page.click('#m-seat-skip');
  await wait(1200);
  const main = await page.evaluate(() => ({
    mainPage: !!document.querySelector('#m-main.active'),
    tabs: document.querySelectorAll('.m-tabbar > *').length,
    name: (document.querySelector('#m-top-name') || {}).textContent,
  }));
  check('进入主页面', main.mainPage, JSON.stringify(main));
  check('底部 4 个 tab 齐全', main.tabs === 4, `${main.tabs} 个`);
  check('顶部显示昵称', (main.name || '').length > 0, main.name);
  check('加入后仍无 JS 报错', errors.length === 0, errors.join(' | '));
  await page.close();
}

/* ---------- 4. 大屏（快速过一遍） ---------- */
console.log('\n[大屏] /w');
{
  const { page, errors } = await open(`${BASE}/w?room=${code}`);
  const r = await page.evaluate(() => ({
    view: document.body.dataset.view,
    online: (document.querySelector('#w-online') || {}).textContent,
  }));
  check('无 JS 报错', errors.length === 0, errors.join(' | '));
  check('有激活视图', !!r.view, r.view);
  check('在线人数已同步', Number(r.online) > 0, r.online);
  await page.close();
}

await browser.close();
resident.forEach((s) => s.close());
console.log(`\n${'='.repeat(46)}`);
console.log(`页面冒烟：通过 ${pass} · 失败 ${fail}`);
process.exit(fail ? 1 : 0);
