/* ==========================================================
   词条屏蔽验证
   ----------------------------------------------------------
   大屏是教室里的公共屏幕，同学随手填的内容会直接投上去。
   这个脚本守住四件事：
     1. 屏蔽后，当前词云里所有同文本的条目都被撤下（不是只撤一条）
     2. 之后同学再提交同样内容会被拒收（加空格绕过也不行）
     3. 屏蔽名单跨重启保留（重启后开新一轮，同样内容仍进不来）
     4. 大屏端收到 word:hidden 后，本地已渲染的条目和正在飘的弹幕立刻消失
   任何一条失守，老师在课堂上就只能靠「清空」兜底，
   而「清空」的代价是全班的心血一起没——结果是老师干脆不敢开词云。
   ========================================================== */

import { io } from 'socket.io-client';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const PORT = 3111;
const BASE = `http://127.0.0.1:${PORT}`;
const DIR_A = 'data/rooms-wb-a';
const DIR_B = 'data/rooms-wb-b';
const CHROME = process.env.CHROME || 'C:\\Users\\17790\\.agent-browser\\browsers\\chrome-152.0.7977.64\\chrome.exe';

let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 连接工具：一律带硬超时，避免脚本静默挂死 ---------- */
function connect() {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { transports: ['websocket'] });
    const t = setTimeout(() => { s.close(); reject(new Error('连接超时')); }, 8000);
    s.on('connect', () => { clearTimeout(t); resolve(s); });
    s.on('connect_error', (e) => { clearTimeout(t); reject(e); });
  });
}

function emit(sock, ev, payload = {}) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ ok: false, msg: 'ack 超时' }), 8000);
    sock.emit(ev, payload, (res) => { clearTimeout(t); resolve(res || { ok: false }); });
  });
}

/* ---------- 起独立端口的服务 ---------- */
const procs = [];
function startServer(dir) {
  const p = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(PORT), ROOMS_DIR: dir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  p.stdout.on('data', (d) => log.push(d.toString()));
  p.stderr.on('data', (d) => log.push(d.toString()));
  procs.push(p);
  return { p, log };
}

function killAll() {
  for (const p of procs) { try { p.kill('SIGKILL'); } catch {} }
  procs.length = 0;
}

async function waitUp(logRef) {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) return true; } catch {}
    await sleep(250);
  }
  console.log('  服务日志：', (logRef ? logRef.join('') : '').slice(-400));
  return false;
}

async function newRoom(title) {
  const r = await (await fetch(`${BASE}/api/room`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  })).json();
  return r;
}

/** 建一套连接：控制端（发教师指令）+ 大屏（读状态） */
async function joinRoom(code, token) {
  const ctl = await connect();
  const cj = await emit(ctl, 'control:join', { code, token });
  const wall = await connect();
  const wj = await emit(wall, 'wall:join', { code });
  return { ctl, wall, ctlOk: cj && cj.ok, wallOk: wj && wj.ok, ctlMsg: cj && cj.msg, wallMsg: wj && wj.msg };
}

/** 从大屏视角读当前词云条目（wall:join 的 ack 带完整 state） */
async function wordItems(wall, code) {
  const r = await emit(wall, 'wall:join', { code });
  const a = r && r.state && r.state.activity;
  return (a && a.type === 'word' && a.items) || [];
}

let browser;

async function main() {
  console.log('\n============== 词条屏蔽验证 ==============\n');

  /* ---------- [1] 建课堂，收词条 ---------- */
  console.log('[1] 建课堂与提交词条');
  const s1 = startServer(DIR_A);
  if (!await waitUp(s1.log)) throw new Error('服务未能启动');

  const room = await newRoom('词条屏蔽测试');
  check('课堂创建成功', !!room.code, JSON.stringify(room));

  const { ctl, wall, ctlOk, ctlMsg, wallOk } = await joinRoom(room.code, room.token);
  check('控制端加入', ctlOk === true, ctlMsg || '');
  check('大屏加入', wallOk === true);

  const stu = [];
  for (let i = 0; i < 3; i++) {
    const s = await connect();
    const r = await emit(s, 'student:join', { code: room.code, nickname: `同学${i + 1}`, avatar: '🙂' });
    check(`学生 ${i + 1} 加入`, r && r.ok === true, JSON.stringify(r));
    stu.push(s);
  }

  // 教师指令必须走控制端连接：requireTeacher 会校验 view === 'control'
  const started = await emit(ctl, 'word:start', { prompt: '随便说一个词', mode: 'both' });
  check('词云活动开始', started && started.ok === true, JSON.stringify(started));

  // 两人交了同一个词「无聊」，另有两条正常内容
  for (const [idx, text] of [[0, '无聊'], [1, '无聊'], [2, '有意思'], [0, '数据清洗']]) {
    const r = await emit(stu[idx], 'student:word', { text });
    check(`「${text}」提交成功`, r && r.ok === true, JSON.stringify(r));
  }

  let items = await wordItems(wall, room.code);
  check('服务端已收到 4 条', items.length === 4, `实际 ${items.length} 条`);

  /* ---------- [2] 屏蔽 ---------- */
  console.log('\n[2] 屏蔽「无聊」');
  const hidden = await emit(ctl, 'word:hide', { text: '无聊' });
  check('屏蔽接口成功', hidden && hidden.ok === true, JSON.stringify(hidden));
  check('撤下条数 = 2（不是只撤一条）', hidden.removed === 2, `实际 ${hidden && hidden.removed}`);

  items = await wordItems(wall, room.code);
  check('服务端只剩 2 条', items.length === 2, `实际 ${items.length} 条`);
  check('「无聊」已全部消失', !items.some((i) => i.text === '无聊'), JSON.stringify(items.map((i) => i.text)));
  check('正常词条未被误伤',
    items.some((i) => i.text === '有意思') && items.some((i) => i.text === '数据清洗'),
    JSON.stringify(items.map((i) => i.text)));

  /* ---------- [3] 屏蔽后重复提交必须被拒 ---------- */
  console.log('\n[3] 屏蔽后重复提交应被拒收');
  const again = await emit(stu[2], 'student:word', { text: '无聊' });
  check('原样提交被拒', again && again.ok === false, JSON.stringify(again));
  check('拒绝理由提到屏蔽', /屏蔽/.test((again && again.msg) || ''), JSON.stringify(again));

  const bypass = await emit(stu[2], 'student:word', { text: '  无聊  ' });
  check('加空格绕过被拒', bypass && bypass.ok === false, JSON.stringify(bypass));

  const stillOk = await emit(stu[2], 'student:word', { text: '完全正常' });
  check('其他内容不受影响', stillOk && stillOk.ok === true, JSON.stringify(stillOk));

  const emptyHide = await emit(ctl, 'word:hide', { text: '   ' });
  check('空内容屏蔽被拒', emptyHide && emptyHide.ok === false, JSON.stringify(emptyHide));

  /* ---------- [4] 屏蔽名单跨重启保留 ---------- */
  console.log('\n[4] 屏蔽名单持久化（重启后开新一轮仍生效）');
  await sleep(2400);                 // 等防抖落盘（2s）
  killAll();
  await sleep(600);

  const s2 = startServer(DIR_A);     // 同一个目录：读回刚才的快照
  if (!await waitUp(s2.log)) throw new Error('重启后服务未能启动');
  check('重启后服务可用', true);

  const { ctl: ctl2, wall: wall2 } = await joinRoom(room.code, room.token);
  check('重启后控制端令牌仍有效', await emit(ctl2, 'word:start', { prompt: '第二轮', mode: 'both' }).then((r) => r && r.ok === true));

  const st2 = await connect();
  await emit(st2, 'student:join', { code: room.code, nickname: '同学9', avatar: '🦊' });
  const blocked = await emit(st2, 'student:word', { text: '无聊' });
  // 注意：这里断言的必须是「因为被屏蔽而拒绝」，而不是「因为没有活动」。
  // 上面已经开了新一轮，所以不存在活动为空的干扰；再核对理由进一步排除误判。
  check('重启后再交「无聊」仍被拒', blocked && blocked.ok === false, JSON.stringify(blocked));
  check('拒绝理由仍是屏蔽（非活动未开始）', /屏蔽/.test((blocked && blocked.msg) || ''), JSON.stringify(blocked));
  const ok2 = await emit(st2, 'student:word', { text: '重启后的正常内容' });
  check('重启后其他内容正常提交', ok2 && ok2.ok === true, JSON.stringify(ok2));

  /* ---------- [5] 大屏端实时撤下 ---------- */
  console.log('\n[5] 大屏端实时撤下（含正在飘的弹幕）');
  killAll();
  await sleep(600);
  const s3 = startServer(DIR_B);
  if (!await waitUp(s3.log)) throw new Error('前端验证用服务未能启动');

  const room2 = await newRoom('大屏撤下测试');
  const { ctl: ctl3 } = await joinRoom(room2.code, room2.token);
  await emit(ctl3, 'word:start', { prompt: '说点什么', mode: 'both' });

  browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars'],
  });
  const page = await browser.newPage();
  await page.setCacheEnabled(false);   // 避免复用旧版前端代码
  await page.setViewport({ width: 1600, height: 900 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}/w?room=${room2.code}`, { waitUntil: 'networkidle2', timeout: 25000 });
  await sleep(1500);

  const student = await connect();
  await emit(student, 'student:join', { code: room2.code, nickname: '小明', avatar: '🐱' });
  for (const t of ['不合适内容', '正常内容']) {
    await emit(student, 'student:word', { text: t });
    await sleep(400);
  }

  const cntBefore = await page.evaluate(() => Number(document.querySelector('#word-count')?.textContent || '0'));
  check('大屏已渲染 2 条', cntBefore === 2, `实际 ${cntBefore}`);

  const dmBefore = await page.evaluate(() =>
    [...document.querySelectorAll('.dm-item .dm-text')].map((e) => e.textContent));
  check('弹幕已飘出', dmBefore.length >= 1, JSON.stringify(dmBefore));

  // 老师在控制端点了屏蔽
  const h2 = await emit(ctl3, 'word:hide', { text: '不合适内容' });
  check('屏蔽成功', h2 && h2.ok === true, JSON.stringify(h2));
  await sleep(1000);

  const cntAfter = await page.evaluate(() => Number(document.querySelector('#word-count')?.textContent || '0'));
  check('大屏计数已减到 1', cntAfter === 1, `实际 ${cntAfter}`);

  const dmAfter = await page.evaluate(() =>
    [...document.querySelectorAll('.dm-item .dm-text')].map((e) => e.textContent));
  check('飘着的弹幕里已无该内容', !dmAfter.includes('不合适内容'), JSON.stringify(dmAfter));

  const cloudTexts = await page.evaluate(() =>
    [...document.querySelectorAll('#word-cloud .wc-word')].map((e) => e.textContent));
  check('词云节点里已无该内容', !cloudTexts.some((t) => (t || '').includes('不合适内容')), JSON.stringify(cloudTexts));
  check('词云里仍保留正常内容', cloudTexts.some((t) => (t || '').includes('正常内容')), JSON.stringify(cloudTexts));

  check('页面无 JS 报错', errors.length === 0, errors.join(' / '));

  /* ---------- [6] 控制端点词条的真实点击链路 ---------- */
  console.log('\n[6] 控制端点词条撤下（真实浏览器点击）');
  const page2 = await browser.newPage();
  await page2.setViewport({ width: 1440, height: 900 });
  const errors2 = [];
  page2.on('pageerror', (e) => errors2.push(e.message));
  // 控制端靠 localStorage 恢复会话，必须在页面脚本执行前把令牌放进去
  await page2.evaluateOnNewDocument((c, t) => {
    localStorage.setItem('last_room', JSON.stringify(c));
    localStorage.setItem(`tok_${c}`, JSON.stringify(t));
  }, room2.code, room2.token);
  await page2.goto(`${BASE}/c?room=${room2.code}`, { waitUntil: 'networkidle2', timeout: 25000 });

  // 门控页会出现「回到上次的课堂」按钮，点它进控制台
  await page2.waitForFunction(
    () => [...document.querySelectorAll('.gate-form button')].some((b) => b.textContent.includes('回到上次的课堂')),
    { timeout: 10000 },
  );
  await page2.evaluate(() => {
    [...document.querySelectorAll('.gate-form button')].find((b) => b.textContent.includes('回到上次的课堂')).click();
  });
  await page2.waitForFunction(
    () => document.querySelector('#gate')?.classList.contains('hidden') === true,
    { timeout: 10000 },
  );
  check('已进入控制台', await page2.evaluate(() =>
    document.querySelector('#console') && !document.querySelector('#console').classList.contains('hidden')));

  // 切到词云面板
  await page2.evaluate(() => document.querySelector('.nav-i[data-tab="word"]')?.click());
  await sleep(400);
  check('词云面板已激活', await page2.evaluate(() =>
    document.querySelector('.tab-pane[data-pane="word"]')?.classList.contains('active') === true));

  // 开新一轮，让同学提交两条
  await page2.evaluate(() => document.querySelector('#w-start')?.click());
  await sleep(900);
  const stu2 = await connect();
  await emit(stu2, 'student:join', { code: room2.code, nickname: '小红', avatar: '🐰' });
  for (const t of ['跑题内容', '贴合内容']) {
    await emit(stu2, 'student:word', { text: t });
    await sleep(400);
  }

  await page2.waitForFunction(
    () => document.querySelectorAll('#w-chips .wchip').length >= 2,
    { timeout: 10000 },
  ).catch(() => {});
  const chips = await page2.evaluate(() =>
    [...document.querySelectorAll('#w-chips .wchip')].map((c) => c.dataset.t));
  check('控制端列出 2 个词条', chips.length === 2, JSON.stringify(chips));
  check('词条带 data-t 属性（可点）', chips.includes('跑题内容'), JSON.stringify(chips));

  // 真机点击「跑题内容」
  await page2.evaluate(() => {
    [...document.querySelectorAll('#w-chips .wchip')].find((c) => c.dataset.t === '跑题内容')?.click();
  });
  await sleep(1200);

  const chipsAfter = await page2.evaluate(() =>
    [...document.querySelectorAll('#w-chips .wchip')].map((c) => c.dataset.t));
  check('被点的词条已从面板消失', !chipsAfter.includes('跑题内容'), JSON.stringify(chipsAfter));
  check('另一条仍在（未被连带清空）', chipsAfter.includes('贴合内容'), JSON.stringify(chipsAfter));

  const toastInfo = await page2.evaluate(() => {
    const t = document.querySelector('.toast');
    return t ? { text: t.textContent, hasAct: !!t.querySelector('.toast-act'), act: t.querySelector('.toast-act')?.textContent } : null;
  });
  check('出现了提示条', !!toastInfo, JSON.stringify(toastInfo));
  check('提示条带「撤销屏蔽」按钮',
    !!toastInfo && toastInfo.hasAct && /撤销/.test(toastInfo.act || ''), JSON.stringify(toastInfo));

  const blockedNow = await emit(stu2, 'student:word', { text: '跑题内容' });
  check('屏蔽后重复提交被拒', blockedNow && blockedNow.ok === false, JSON.stringify(blockedNow));

  // 点「撤销屏蔽」，同学应能重新提交
  await page2.evaluate(() => document.querySelector('.toast .toast-act')?.click());
  await sleep(900);
  const resubmit = await emit(stu2, 'student:word', { text: '跑题内容' });
  check('撤销后可以重新提交', resubmit && resubmit.ok === true, JSON.stringify(resubmit));

  check('控制端页面无 JS 报错', errors2.length === 0, errors2.join(' / '));

  /* ---------- 汇总 ---------- */
  console.log(`\n============== 结果：${pass} 通过 / ${fail} 失败 ==============\n`);
}

main()
  .catch((e) => { console.error('\n运行出错：', e.stack || e.message); fail++; })
  .finally(async () => {
    try { if (browser) await browser.close(); } catch {}
    killAll();
    for (const d of [DIR_A, DIR_B]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }
    process.exit(fail > 0 ? 1 : 0);
  });
