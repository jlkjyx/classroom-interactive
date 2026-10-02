/**
 * 教师控制端「点击是否真的生效」全流程验证
 *
 * 与 verify-visual.mjs 的分工：
 *   verify-visual  —— 大屏呈现得对不对（几何、布局、动画）
 *   verify-control —— 控制端按下去有没有用（真实点击 + 大屏联动校验）
 *
 * 做法：Node 侧用 socket.io-client 造 12 个"虚拟同学"，
 * 浏览器里同时开着控制端和大屏，教师每点一个按钮，
 * 就同时断言「控制端自己变了」和「大屏收到了」。
 * 只验一边是不够的——控制端可以自嗨，大屏可以没收到。
 *
 * 用法：node test/verify-control.mjs   （需先启动服务 npm start）
 */
import puppeteer from 'puppeteer-core';
import { io } from 'socket.io-client';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME
  || 'C:\\Users\\17790\\.agent-browser\\browsers\\chrome-152.0.7977.64\\chrome.exe';
const BASE = process.env.BASE || 'http://localhost:3000';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0; let fail = 0;
const failed = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('   ✓', name); }
  else { fail++; failed.push(name); console.log('   ✗', name, extra ? `→ ${extra}` : ''); }
}

/** 轮询直到条件成立（返回真值即通过，false/undefined 继续等） */
async function until(fn, ms = 5000, gap = 120) {
  const t0 = Date.now();
  for (;;) {
    let v = false;
    try { v = await fn(); } catch { v = false; }
    if (v) return v;
    if (Date.now() - t0 > ms) return false;
    await wait(gap);
  }
}

/* ==================== 造数据：12 名虚拟同学 ==================== */

const NAMES = ['张明远', '李思彤', '王雨桐', '赵子涵', '孙佳怡', '周浩然',
  '吴欣妍', '郑博文', '冯诗涵', '陈嘉树', '褚一诺', '卫子墨'];
const AVATARS = ['🦊', '🐼', '🐯', '🐨', '🐸', '🐵', '🐧', '🐙', '🦁', '🐷', '🐮', '🐔'];

const connect = () => new Promise((res, rej) => {
  const s = io(BASE, { transports: ['websocket'] });
  s.on('connect', () => res(s));
  s.on('connect_error', rej);
});
const emit = (s, ev, d = {}) => new Promise((res) => {
  const t = setTimeout(() => res({ ok: false, __timeout: true }), 4000);
  s.emit(ev, d, (r) => { clearTimeout(t); res(r || { ok: true }); });
});

console.log('\n[0] 准备课堂数据');
const room = await fetch(`${BASE}/api/room`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ title: '数据整理与清洗实训 · 第 1 讲', rows: 6, cols: 8, frontRows: 2 }),
}).then((r) => r.json());
check('课堂创建成功', !!room.code && !!room.token, JSON.stringify(room));
console.log(`   课堂码 ${room.code}`);

const stus = [];
for (let i = 0; i < NAMES.length; i++) {
  const s = await connect();
  const r = await emit(s, 'student:join', { code: room.code, nickname: NAMES[i], avatar: AVATARS[i] });
  stus.push({ sock: s, id: r.studentId, name: NAMES[i] });
}
check('12 名同学加入成功', stus.length === 12 && stus.every((s) => s.id),
  `${stus.filter((s) => s.id).length}/12`);

// 座位布局：0~7 号坐第 1-2 排（i%2），8~11 号坐第 4-6 排
for (let i = 0; i < 8; i++) await emit(stus[i].sock, 'student:seat', { row: i % 2, col: i });
for (let i = 8; i < 12; i++) await emit(stus[i].sock, 'student:seat', { row: 3 + ((i - 8) % 3), col: i - 8 });
// 8 号挪到第 3 排 —— 后面把「前排定义」改成 3 排时，他会从后排变成前排，用来验证 frontRows 真的生效
await emit(stus[8].sock, 'student:seat', { row: 2, col: 0 });
await emit(stus[0].sock, 'student:hand', { up: true });
await emit(stus[3].sock, 'student:hand', { up: true });
await wait(400);

/* ==================== 开两个浏览器页：控制端 + 大屏 ==================== */

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  protocolTimeout: 30000, // 卡住时快速失败，别 hang 满 3 分钟
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars',
    '--autoplay-policy=no-user-gesture-required'],
  defaultViewport: { width: 1600, height: 980 },
});

const errors = { control: [], wall: [], mob: [] };
async function openPage(which, url, { seed, viewport } = {}) {
  const page = await browser.newPage();
  await page.setCacheEnabled(false);
  page.on('pageerror', (e) => errors[which].push(String(e.message)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors[which].push(m.text());
  });
  if (viewport) await page.setViewport(viewport);
  if (seed) {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.evaluate((pairs) => {
      for (const [k, v] of pairs) localStorage.setItem(k, JSON.stringify(v));
    }, seed);
  }
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
  return page;
}

const ctl = await openPage('control', `${BASE}/c?room=${room.code}`, {
  seed: [[`tok_${room.code}`, room.token], ['last_room', room.code]],
});
const wall = await openPage('wall', `${BASE}/w?room=${room.code}`, {
  viewport: { width: 1920, height: 1080 },
});

/* ---------- 小工具 ---------- */

const cEval = (fn, ...a) => ctl.evaluate(fn, ...a);
const wEval = (fn, ...a) => wall.evaluate(fn, ...a);

/**
 * 真实点击，并顺带做命中测试。
 *
 * 不用 page.click：它内部靠 IntersectionObserver 判断元素是否可见，
 * 而 headless 下非前台标签页不产出帧，观察器永远不回调，
 * 于是 Runtime.callFunctionOn 会一直挂到超时（实测卡满 180s）。
 * 这里改成自己 scrollIntoView + elementFromPoint 命中测试，
 * 既避开了帧依赖，又保留了"按钮被透明遮罩挡住"这类真实缺陷的检出能力。
 */
async function realClick(page, sel) {
  const r = await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return { ok: false, why: '元素不存在' };
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const b = el.getBoundingClientRect();
    if (b.width < 1 || b.height < 1) return { ok: false, why: `尺寸为 0（${b.width}×${b.height}），可能被隐藏` };
    const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    if (top !== el && !el.contains(top)) {
      return { ok: false, why: `被遮挡，实际命中 ${top ? top.tagName + '.' + (top.className || '') : 'null'}` };
    }
    el.click();
    return { ok: true };
  }, sel);
  if (!r.ok) throw new Error(`${sel} 点不动：${r.why}`);
  return r;
}

/** 切到某个功能面板 */
async function tab(name) {
  const r = await cEval((n) => {
    const b = document.querySelector(`.nav-i[data-tab="${n}"]`);
    if (!b) return false;
    b.click();
    return true;
  }, name);
  if (!r) throw new Error(`找不到面板按钮 ${name}`);
  await wait(200);
}

/** 把 "30s" / "2:05" 这类显示值还原成秒数，便于比较大小 */
function secs(t) {
  const m = /^(\d+):(\d+)$/.exec(t);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  return Number(String(t).replace('s', ''));
}

/** 点控制端按钮，返回点击产生的 toast 文本（toast 2.4s 后才消失，会串味，先清空再读） */
async function clickAndToast(sel) {
  await cEval(() => { const w = document.querySelector('.toast-wrap'); if (w) w.innerHTML = ''; });
  await realClick(ctl, sel);
  await wait(300);
  return cEval(() => {
    const w = document.querySelector('.toast-wrap');
    return w ? w.textContent.trim() : '';
  });
}

const wallView = () => wEval(() => document.body.dataset.view);
// 只取 .rscore b 的文本：排行榜现在一个格子里放两个数（总积分 + 本次课得分），
// 直接读 .rscore 的 textContent 会把 "24" 和 "8" 拼成 "248"。
const sumScores = () => cEval(() => [...document.querySelectorAll('#c-ranklist .rscore b')]
  .reduce((a, el) => a + (Number(el.textContent) || 0), 0));
const setVal = (sel, v) => cEval(([s, val]) => {
  const el = document.querySelector(s);
  if (!el) throw new Error('找不到元素 ' + s);
  el.value = val;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}, [sel, String(v)]);
const setChecked = (sel, v) => cEval(([s, val]) => {
  const el = document.querySelector(s);
  if (!el) throw new Error('找不到元素 ' + s);
  el.checked = val;
}, [sel, !!v]);
const setSelect = (sel, v) => cEval(([s, val]) => {
  const el = document.querySelector(s);
  if (!el) throw new Error('找不到元素 ' + s);
  el.value = val;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}, [sel, String(v)]);

/* 每一节独立 try/catch：一个按钮点不动，不能把后面几十条断言全带走 */
async function section(title, body) {
  console.log(`\n${title}`);
  try { await body(); } catch (e) {
    check(`${title} 执行中断`, false, e.message);
  }
}

/* ==================== 1. 进入控制台 ==================== */

await section('[1] 进入控制台', async () => {
  const restored = await cEval(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent || '').includes('回到上次的课堂'));
    if (b) { b.click(); return true; }
    return false;
  });
  check('识别到「回到上次的课堂」入口', restored);
  const ok = await until(() => cEval((c) => !document.querySelector('#console').classList.contains('hidden')
    && document.querySelector('#c-code').textContent.trim() === c, room.code), 6000);
  check('已进入控制台且课堂码正确', ok, await cEval(() => document.querySelector('#c-code').textContent));
  check('顶栏在线人数 = 12', await until(() => cEval(() => document.querySelector('#c-online').textContent === '12')),
    await cEval(() => document.querySelector('#c-online').textContent));
  check('大屏同步在线人数 = 12', await until(() => wEval(() => document.querySelector('#w-online').textContent === '12')),
    await wEval(() => document.querySelector('#w-online').textContent));
  check('大屏侧栏已有举手同学', await until(() => wEval(() => document.querySelectorAll('#hands-list > *').length === 2)),
    await wEval(() => document.querySelectorAll('#hands-list > *').length + ' 个'));
});

/* ==================== 2. 投票 / 随堂小测 ==================== */

await section('[2] 投票 / 随堂小测', async () => {
  await tab('poll');
  await setVal('#p-question', '下面哪一项不属于数据清洗的常规步骤？');
  await setVal('#p-options', '缺失值处理\n重复值删除\n数据可视化\n格式统一');
  await setSelect('#p-correct', '2');
  const toast1 = await clickAndToast('#p-start');
  check('点击「发布」有反馈 toast', /投票已发布/.test(toast1), toast1);

  check('控制端渲染出 4 条实时结果', await until(() => cEval(() => document.querySelectorAll('#p-bars .mb').length === 4)),
    await cEval(() => document.querySelectorAll('#p-bars .mb').length + ' 条'));
  check('大屏切到投票视图', await until(() => wallView().then((v) => v === 'poll')), await wallView());
  check('大屏题面与教师输入一致',
    await until(() => wEval(() => document.querySelector('#poll-question').textContent.includes('不属于数据清洗'))));
  check('大屏渲染 4 根柱子', await until(() => wEval(() => document.querySelectorAll('#poll-bars .bar').length === 4)),
    await wEval(() => document.querySelectorAll('#poll-bars .bar').length + ' 根'));
  check('大屏标记为「随堂小测」', await wEval(() => document.querySelector('#poll-badge').textContent.includes('小测')),
    await wEval(() => document.querySelector('#poll-badge').textContent));

  // 12 人投票：8 人选 C(2)，2 人选 B(1)，2 人选 A(0)
  const VOTES = [2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 0, 0];
  for (let i = 0; i < VOTES.length; i++) await emit(stus[i].sock, 'student:vote', { indexes: [VOTES[i]] });
  await wait(600);

  check('大屏柱子数字随投票上升（C=8）',
    await until(() => wEval(() => Number(document.querySelectorAll('#poll-bars .bar-num')[2].textContent) === 8)),
    await wEval(() => [...document.querySelectorAll('#poll-bars .bar-num')].map((e) => e.textContent).join('/')));
  check('控制端作答进度 = 12 / 12',
    await until(() => cEval(() => document.querySelector('#p-count').textContent.replace(/\s/g, '') === '12/12')),
    await cEval(() => document.querySelector('#p-count').textContent));
  check('大屏进度条文案同步',
    await until(() => wEval(() => document.querySelector('#pp-text').textContent.includes('12 / 12'))),
    await wEval(() => document.querySelector('#pp-text').textContent));

  const toast2 = await clickAndToast('#p-reveal');
  check('点击「公布答案」有反馈', /已公布答案/.test(toast2), toast2);
  check('大屏高亮正确项（第 3 根）',
    await until(() => wEval(() => {
      const bars = document.querySelectorAll('#poll-bars .bar');
      return bars.length === 4 && bars[2].classList.contains('correct') && !bars[0].classList.contains('correct');
    })),
    await wEval(() => [...document.querySelectorAll('#poll-bars .bar')].map((b) => b.className).join(' | ')));

  await clickAndToast('#p-stop');
  check('点击「结束」后大屏离开投票视图', await until(() => wallView().then((v) => v !== 'poll')), await wallView());
});

/* ==================== 3. 词云 / 弹幕 ==================== */

await section('[3] 词云 / 弹幕', async () => {
  await tab('word');
  await setVal('#w-prompt', '用一个词形容你眼中的「数据清洗」');
  const toast1 = await clickAndToast('#w-start');
  check('点击「开始收集」有反馈', /开始收集/.test(toast1), toast1);
  check('大屏切到词云视图', await until(() => wallView().then((v) => v === 'word')), await wallView());
  check('大屏提示语与教师输入一致',
    await until(() => wEval(() => document.querySelector('#word-prompt').textContent.includes('数据清洗'))));

  const WORDS = ['繁琐', '繁琐', '繁琐', '重要', '重复劳动', '有成就感', '耐心', '细心', '繁琐', '数据质量', '有意思', '要动脑'];
  for (let i = 0; i < WORDS.length; i++) {
    await emit(stus[i].sock, 'student:word', { text: WORDS[i] });
    await wait(160);
  }
  await wait(700);

  check('控制端词条数 = 12 条',
    await until(() => cEval(() => document.querySelector('#w-count').textContent.includes('12'))),
    await cEval(() => document.querySelector('#w-count').textContent));
  check('控制端词频合并（"繁琐"×4）',
    await cEval(() => [...document.querySelectorAll('#w-chips .wchip')].some((e) => /繁琐/.test(e.textContent) && /×4/.test(e.textContent))),
    await cEval(() => [...document.querySelectorAll('#w-chips .wchip')].map((e) => e.textContent).join(' ')));
  check('大屏词云已渲染词条', await until(() => wEval(() => document.querySelectorAll('#word-cloud .wc-word').length >= 9)),
    await wEval(() => document.querySelectorAll('#word-cloud .wc-word').length + ' 个'));
  check('大屏弹幕在飞', await until(() => wEval(() => document.querySelectorAll('#danmaku-layer .dm-item').length > 0)),
    await wEval(() => document.querySelectorAll('#danmaku-layer .dm-item').length + ' 条'));
  check('大屏参与人数统计正确',
    await until(() => wEval(() => document.querySelector('#word-people').textContent === '12')),
    await wEval(() => document.querySelector('#word-people').textContent));

  await clickAndToast('#w-clear');
  check('点击「清空」后控制端词条归零',
    await until(() => cEval(() => document.querySelectorAll('#w-chips .wchip').length === 0)),
    await cEval(() => document.querySelectorAll('#w-chips .wchip').length + ' 个'));
  await clickAndToast('#w-stop');
  check('点击「结束」后大屏离开词云视图', await until(() => wallView().then((v) => v !== 'word')), await wallView());
});

/* ==================== 4. 提问大转盘 ==================== */

await section('[4] 提问大转盘', async () => {
  await tab('wheel');
  await setVal('#wh-count', '8');
  await setSelect('#wh-pool', 'online');
  await clickAndToast('#wh-spin');
  check('大屏切到转盘视图', await until(() => wallView().then((v) => v === 'wheel')), await wallView());
  check('大屏候选名单 8 人', await until(() => wEval(() => document.querySelectorAll('#wheel-list li').length === 8)),
    await wEval(() => document.querySelectorAll('#wheel-list li').length + ' 人'));
  check('控制端同步显示候选', await until(() => cEval(() => document.querySelectorAll('#wh-cands .cand').length === 8)),
    await cEval(() => document.querySelectorAll('#wh-cands .cand').length + ' 人'));

  // 转盘动画 5s，控制端结果延迟 5.1s 显示
  const spun = await until(() => wEval(() => document.querySelector('#wheel-result').classList.contains('show')
    && document.querySelector('#wr-name').textContent.trim().length > 0), 12000);
  check('大屏转出中奖同学', spun, await wEval(() => document.querySelector('#wr-name').textContent));
  const cName = await until(() => cEval(() => {
    const t = document.querySelector('#wh-name').textContent.trim();
    return t && t !== '尚未开始' && t !== '转动中…' ? t : false;
  }), 12000);
  check('控制端显示中奖结果', !!cName, await cEval(() => document.querySelector('#wh-name').textContent));
  const wName = await wEval(() => document.querySelector('#wr-name').textContent.trim());
  check('两端中奖结果一致', !!cName && cName === wName, `控制端「${cName}」 vs 大屏「${wName}」`);
  check('被点名的同学记为已抽中（候选标记为 picked）',
    await until(() => cEval(() => document.querySelectorAll('#wh-cands .cand.picked').length === 1)),
    await cEval(() => document.querySelectorAll('#wh-cands .cand.picked').length + ' 个'));

  await clickAndToast('#wh-close');
  check('点击「关闭转盘」后大屏离开转盘', await until(() => wallView().then((v) => v !== 'wheel')), await wallView());

  // 关键需求（鼓励前排）：候选池设为「仅前排同学」时，抽到的必须全是前排的人
  // 此刻前排定义仍是前 2 排，坐前排的正好是 NAMES[0..7] 这 8 人
  await setSelect('#wh-pool', 'front');
  await clickAndToast('#wh-refresh');
  const candsOk = await until(async () => {
    const names = await cEval(() => [...document.querySelectorAll('#wh-cands .cand')]
      .map((e) => e.textContent.trim().split(/\s+/).pop()));
    const frontSet = NAMES.slice(0, 8);
    return names.length === 8 && names.every((n) => frontSet.includes(n)) ? names : false;
  }, 6000);
  check('候选池「仅前排同学」抽到的 8 人全是前排', !!candsOk,
    `实际候选：${(await cEval(() => [...document.querySelectorAll('#wh-cands .cand')].map((e) => e.textContent.trim()))).join(' ')}`);
  await clickAndToast('#wh-close');
  await wait(400);
});

/* ==================== 5. 抢答 ==================== */

await section('[5] 抢答', async () => {
  await tab('buzz');
  // 先把当前累计积分记一下，等下判定加分才能看出"本次 +N / 总 +N"的变化
  const scoreBefore = await sumScores();
  await setVal('#b-prompt', 'Power Query 在 Excel 的哪个选项卡里？');
  await clickAndToast('#b-start');
  check('大屏切到抢答视图', await until(() => wallView().then((v) => v === 'buzz')), await wallView());
  check('大屏题面与教师输入一致',
    await until(() => wEval(() => document.querySelector('#buzz-q').textContent.includes('Power Query'))),
    await wEval(() => document.querySelector('#buzz-q').textContent));

  await emit(stus[5].sock, 'student:buzz', {}); await wait(300);
  await emit(stus[2].sock, 'student:buzz', {}); await wait(300);
  await emit(stus[9].sock, 'student:buzz', {}); await wait(600);

  check('控制端列出 3 名抢答同学',
    await until(() => cEval(() => document.querySelectorAll('#b-list .bz-row').length === 3)),
    await cEval(() => document.querySelectorAll('#b-list .bz-row').length + ' 行'));
  check('第一名是第一个抢到的同学（周浩然）',
    await cEval(() => (document.querySelectorAll('#b-list .bzn')[0] || {}).textContent === '周浩然'),
    await cEval(() => (document.querySelectorAll('#b-list .bzn')[0] || {}).textContent));
  check('大屏领奖台 3 个位置全部有人',
    await until(() => wEval(() => document.querySelectorAll('#buzz-podium .buzz-slot:not(.empty)').length === 3)),
    await wEval(() => document.querySelectorAll('#buzz-podium .buzz-slot:not(.empty)').length + ' 个'));
  check('大屏领奖台名次排列为 2 / 1 / 3',
    await wEval(() => [...document.querySelectorAll('#buzz-podium .bz-rank')].map((e) => e.textContent).join('') === '213'),
    await wEval(() => [...document.querySelectorAll('#buzz-podium .bz-rank')].map((e) => e.textContent).join('')));

  // 2026-09-04 修订：抢答本身**不再自动加分**。下面是验证
  //   1) 三人都抢到了，但 0.5s 内总积分应当完全没动
  //   2) 控制端每行有「答对/答错/0 分」三个按钮
  //   3) 大屏领奖台上没老师判定时显示「待老师判定」
  await wait(500);
  check('抢答后自动加分取消：0.5s 后总积分仍为原数',
    (await sumScores()) === scoreBefore,
    `原 ${scoreBefore} → 现 ${await sumScores()}`);
  check('控制端抢答列表行内出现「答对/答错/0 分」三个按钮',
    await cEval(() => {
      const row = document.querySelector('#b-list .bz-row');
      return row && row.querySelectorAll('.bz-btn').length === 3
        && row.querySelector('.bz-btn.ok') && row.querySelector('.bz-btn.ng') && row.querySelector('.bz-btn.zero');
    }),
    await cEval(() => {
      const row = document.querySelector('#b-list .bz-row');
      return row ? [...row.querySelectorAll('.bz-btn')].map((b) => b.textContent).join('|') : 'no row';
    }));
  check('大屏领奖台未判定时显示「待老师判定」',
    await wEval(() => [...document.querySelectorAll('#buzz-podium .bz-score')].every((el) => /待老师判定|^\+\d+\s*分$|^\-\d+\s*分$/.test(el.textContent.trim()))),
    await wEval(() => [...document.querySelectorAll('#buzz-podium .bz-score')].map((el) => el.textContent).join('|')));

  // 模拟老师判定：第 1 名答对 +5、第 2 名答错 -2、第 3 名 0 分
  await realClick(ctl, '#b-list .bz-row:nth-child(1) .bz-btn.ok');
  await wait(200);
  await realClick(ctl, '#b-list .bz-row:nth-child(2) .bz-btn.ng');
  await wait(200);
  await realClick(ctl, '#b-list .bz-row:nth-child(3) .bz-btn.zero');
  await wait(400);
  const expectedDelta = 5 + (-2) + 0;
  check('老师判定后总积分恰好变化 +3',
    await until(async () => (await sumScores()) === scoreBefore + expectedDelta),
    `原 ${scoreBefore} + 期望 ${expectedDelta} → 现 ${await sumScores()}`);
  // 大屏同步刷新成具体分值
  check('大屏领奖台分值从「待老师判定」刷成具体数',
    await until(() => wEval(() => [...document.querySelectorAll('#buzz-podium .bz-score')]
      .some((el) => /\+5 分|\-2 分|\+0 分/.test(el.textContent.trim())))),
    await wEval(() => [...document.querySelectorAll('#buzz-podium .bz-score')].map((el) => el.textContent).join('|')));

  await clickAndToast('#b-reset');
  check('点击「重置」后控制端榜单清空',
    await until(() => cEval(() => document.querySelectorAll('#b-list .bz-row').length === 0)),
    await cEval(() => document.querySelectorAll('#b-list .bz-row').length + ' 行'));
  check('重置后大屏领奖台回到虚位以待',
    await until(() => wEval(() => document.querySelectorAll('#buzz-podium .buzz-slot.empty').length === 3)));
  await clickAndToast('#b-stop');
  check('点击「结束」后大屏离开抢答', await until(() => wallView().then((v) => v !== 'buzz')), await wallView());
});

/* ==================== 6. 座位与前排激励 ==================== */

await section('[6] 座位与前排激励', async () => {
  await tab('seat');
  check('座位预览已渲染 6×8', await until(() => cEval(() => document.querySelectorAll('#s-preview .c-seat').length === 48)),
    await cEval(() => document.querySelectorAll('#s-preview .c-seat').length + ' 座'));
  check('前排（2 排）共 16 座', await cEval(() => document.querySelectorAll('#s-preview .c-seat.front').length === 16),
    await cEval(() => document.querySelectorAll('#s-preview .c-seat.front').length + ' 座'));

  // 改成 8 排 × 8 座、前排定义改为前 3 排 —— 坐第 3 排的冯诗涵应从后排变成前排
  await setVal('#s-rows', '8');
  await setVal('#s-cols', '8');
  await setVal('#s-front', '3');
  const before = await cEval(() => document.querySelector('#fr-text').textContent);
  const toast1 = await clickAndToast('#s-apply');
  check('点击「应用」有反馈', /座位表已更新/.test(toast1), toast1);
  check('座位预览变为 8×8 = 64 座',
    await until(() => cEval(() => document.querySelectorAll('#s-preview .c-seat').length === 64)),
    await cEval(() => document.querySelectorAll('#s-preview .c-seat').length + ' 座'));
  check('前排座位变为 3×8 = 24 座',
    await cEval(() => document.querySelectorAll('#s-preview .c-seat.front').length === 24),
    await cEval(() => document.querySelectorAll('#s-preview .c-seat.front').length + ' 座'));
  const after = await until(() => cEval(() => {
    const t = document.querySelector('#fr-text').textContent;
    return t.includes('9 / 12') ? t : false;
  }), 5000);
  check('前排定义生效：第 3 排的冯诗涵被计入前排（8 → 9）', !!after,
    `应用前「${before}」 应用后「${await cEval(() => document.querySelector('#fr-text').textContent)}」`);

  const toast2 = await clickAndToast('#s-show');
  check('点击「大屏显示座位图」有反馈', /座位图/.test(toast2), toast2);
  check('大屏切到座位图视图', await until(() => wallView().then((v) => v === 'seat')), await wallView());
  check('大屏座位图 64 座', await until(() => wEval(() => document.querySelectorAll('#seat-map .seat').length === 64)),
    await wEval(() => document.querySelectorAll('#seat-map .seat').length + ' 座'));
  check('大屏标出 24 个前排座位',
    await wEval(() => document.querySelectorAll('#seat-map .seat.front').length === 24),
    await wEval(() => document.querySelectorAll('#seat-map .seat.front').length + ' 座'));

  // 前排加分
  const s0 = await sumScores();
  const toast3 = await clickAndToast('#s-reward');
  check('点击「给前排加分」有反馈', /\+2 分/.test(toast3), toast3);
  check('提示的人数与前排人数一致（9 位）', /已给 9 位/.test(toast3), toast3);
  const gained = await until(async () => {
    const d = await sumScores() - s0;
    return d === 18 ? d : false;
  }, 5000);
  check('9 位前排同学各 +2，总分恰好 +18', gained === 18, `实际 +${await sumScores() - s0}（基准 ${s0}）`);
});

/* ==================== 7. 随机分组 ==================== */

await section('[7] 随机分组', async () => {
  await tab('group');
  await setVal('#g-count', '4');
  await setSelect('#g-mode', 'front');
  const toast1 = await clickAndToast('#g-make');
  check('点击「分组」有反馈', /已分成 4 组/.test(toast1), toast1);
  check('控制端预览 4 张分组卡',
    await until(() => cEval(() => document.querySelectorAll('#g-preview .gp-card').length === 4)),
    await cEval(() => document.querySelectorAll('#g-preview .gp-card').length + ' 张'));
  check('12 人被分完（各组人数合计 12）',
    await cEval(() => [...document.querySelectorAll('#g-preview .gp-card h5')]
      .reduce((a, h) => a + (Number((h.textContent.match(/(\d+) 人/) || [])[1]) || 0), 0) === 12),
    await cEval(() => [...document.querySelectorAll('#g-preview .gp-card h5')].map((h) => h.textContent).join(' / ')));
  check('大屏同步显示 4 张分组卡',
    await until(() => wEval(() => document.querySelectorAll('#group-grid .group-card').length === 4)),
    await wEval(() => document.querySelectorAll('#group-grid .group-card').length + ' 张'));
  check('大屏自动切到分组视图', await until(() => wallView().then((v) => v === 'group')), await wallView());

  const toast2 = await clickAndToast('#g-clear');
  check('点击「清空」有反馈', /已清空/.test(toast2), toast2);
  check('清空后控制端预览为空',
    await until(() => cEval(() => document.querySelectorAll('#g-preview .gp-card').length === 0)),
    await cEval(() => document.querySelectorAll('#g-preview .gp-card').length + ' 张'));
  check('清空后大屏回到待机', await until(() => wallView().then((v) => v === 'idle')), await wallView());
});

/* ==================== 8. 计时器 ==================== */

await section('[8] 计时器', async () => {
  await tab('timer');
  await realClick(ctl, '[data-sec="30"]');
  await wait(500);
  // fmtTime 对不足 1 分钟显示成 "30s"，满 1 分钟才显示 "2:05"，两种都要认
  const t1 = await cEval(() => document.querySelector('#t-display').textContent);
  check('点击「30 秒」后控制端计时开始', secs(t1) >= 28 && secs(t1) <= 30, t1);
  check('大屏底栏出现计时器', await until(() => wEval(() => document.querySelector('#wb-timer').classList.contains('show'))));

  await realClick(ctl, '#t-pause');
  await wait(400);
  const p1 = await cEval(() => document.querySelector('#t-display').textContent);
  await wait(1600);
  const p2 = await cEval(() => document.querySelector('#t-display').textContent);
  check('点击「暂停」后计时冻结', p1 === p2 && secs(p1) > 0, `${p1} → ${p2}`);

  await realClick(ctl, '#t-resume');
  await wait(1600);
  const r1 = await cEval(() => document.querySelector('#t-display').textContent);
  check('点击「继续」后计时恢复走字', secs(r1) < secs(p2), `${p2} → ${r1}`);

  await realClick(ctl, '#t-reset');
  await wait(600);
  check('点击「归零」后控制端显示 0', secs(await cEval(() => document.querySelector('#t-display').textContent)) === 0,
    await cEval(() => document.querySelector('#t-display').textContent));
  check('归零后大屏计时器隐藏',
    await until(() => wEval(() => !document.querySelector('#wb-timer').classList.contains('show'))));
});

/* ==================== 9. 特效与提示 ==================== */

await section('[9] 特效与提示', async () => {
  await tab('fx');
  await realClick(ctl, '.fx-btn[data-fx="celebrate"]');
  check('点击特效按钮后大屏炸出文字',
    await until(() => wEval(() => document.querySelectorAll('#effect-layer .effect-text').length > 0)),
    await wEval(() => document.querySelectorAll('#effect-layer .effect-text').length + ' 个'));

  await setVal('#fx-text', '请大家打开 Excel');
  await clickAndToast('#fx-msg');
  check('点击「设为底栏提示语」后大屏底栏更新',
    await until(() => wEval(() => document.querySelector('#wb-msg').textContent.includes('打开 Excel'))),
    await wEval(() => document.querySelector('#wb-msg').textContent));

  await realClick(ctl, '[data-view="seat"]');
  check('点击「大屏视图切换 → 座位图」生效', await until(() => wallView().then((v) => v === 'seat')), await wallView());
  await realClick(ctl, '[data-view="idle"]');
  check('切回「待机二维码」生效', await until(() => wallView().then((v) => v === 'idle')), await wallView());
  check('待机页显示的课堂码正确',
    await wEval((c) => document.querySelector('#w-code-big').textContent.trim() === c, room.code),
    await wEval(() => document.querySelector('#w-code-big').textContent));
});

/* ==================== 10. 学生与积分 ==================== */

await section('[10] 学生与积分', async () => {
  await tab('students');
  check('学生表列出 12 人',
    await until(() => cEval(() => document.querySelectorAll('#st-table .st-row').length === 12)),
    await cEval(() => document.querySelectorAll('#st-table .st-row').length + ' 行'));
  check('前排同学带 ★ 标记（9 人）',
    await cEval(() => document.querySelectorAll('#st-table .st-seat.front').length === 9),
    await cEval(() => document.querySelectorAll('#st-table .st-seat.front').length + ' 人'));

  await setVal('#st-search', '张明远');
  await wait(300);
  check('搜索框按昵称过滤生效',
    await until(() => cEval(() => document.querySelectorAll('#st-table .st-row').length === 1)),
    await cEval(() => document.querySelectorAll('#st-table .st-row').length + ' 行'));
  await setVal('#st-search', '');
  await setSelect('#st-filter', 'front');
  await wait(300);
  check('筛选「仅前排」生效（9 人）',
    await until(() => cEval(() => document.querySelectorAll('#st-table .st-row').length === 9)),
    await cEval(() => document.querySelectorAll('#st-table .st-row').length + ' 行'));
  await setSelect('#st-filter', 'all');
  await wait(300);

  const s0 = await sumScores();
  await realClick(ctl, '#st-table [data-act="add"]');
  const gained1 = await until(async () => {
    const d = await sumScores() - s0;
    return d === 1 ? d : false;
  }, 5000);
  check('点击某行「+1」该生积分 +1', gained1 === 1, `实际 +${await sumScores() - s0}`);

  await realClick(ctl, '#st-table [data-act="sub"]');
  // 注意：until 靠真值判断，这里要回到"差值为 0"，必须返回真值哨兵，不能返回 0
  const gained2 = await until(async () => {
    const d = await sumScores() - s0;
    return d === 0 ? 'ok' : false;
  }, 5000);
  check('点击「-1」积分扣回', gained2 === 'ok', `当前差值 ${await sumScores() - s0}`);

  const toastAll = await clickAndToast('#st-reward-all');
  check('点击「全员 +1」有反馈', /12 人/.test(toastAll), toastAll);
  const gained3 = await until(async () => {
    const d = await sumScores() - s0;
    return d === 12 ? d : false;
  }, 5000);
  check('全员 +1 后总分恰好 +12', gained3 === 12, `实际 +${await sumScores() - s0}`);

  // 导出 CSV：既要按钮真的发起请求，也要内容正确
  const hits = [];
  const onReq = (r) => { if (r.url().includes('export.csv')) hits.push(r.url()); };
  ctl.on('request', onReq);
  await realClick(ctl, '#btn-export');
  check('点击「导出积分」发起了 CSV 请求', await until(() => hits.length > 0, 4000), `${hits.length} 次`);
  ctl.off('request', onReq);

  const csv = await fetch(`${BASE}/api/room/${room.code}/export.csv`).then((r) => r.text());
  const lines = csv.replace(/^﻿/, '').trim().split('\r\n');
  check('CSV 含表头且每名同学一行', lines.length === 13, `${lines.length} 行`);
  check('CSV 记录了前排标记', /"是"/.test(csv) && /"否"/.test(csv));
  check('CSV 记录了座位', /\d+排\d+座/.test(csv), lines[1]);
});

/* ==================== 11. 设置 ==================== */

await section('[11] 设置', async () => {
  await tab('settings');
  await setVal('#set-title', '数据整理与清洗实训 · 第 2 讲');
  await setVal('#set-maxlen', '30');
  await setChecked('#set-danmaku', false);
  const toast = await clickAndToast('#set-save');
  check('点击「保存设置」有反馈', /设置已保存/.test(toast), toast);
  check('控制端标题更新', await until(() => cEval(() => document.querySelector('#c-title').textContent.includes('第 2 讲'))),
    await cEval(() => document.querySelector('#c-title').textContent));
  check('大屏标题同步更新', await until(() => wEval(() => document.querySelector('#w-title').textContent.includes('第 2 讲'))),
    await wEval(() => document.querySelector('#w-title').textContent));

  await tab('settings');
  check('设置项回填正确（字数 30）', await cEval(() => document.querySelector('#set-maxlen').value === '30'),
    await cEval(() => document.querySelector('#set-maxlen').value));
  check('弹幕开关回填为关闭', await cEval(() => document.querySelector('#set-danmaku').checked === false));

  // 关掉弹幕后，大屏不该再飞弹幕（词云照旧）
  await tab('word');
  await clickAndToast('#w-start');
  await wait(300);
  await emit(stus[0].sock, 'student:word', { text: '关弹幕测试' });
  await wait(1200);
  check('关闭「允许弹幕」后大屏不再飞弹幕',
    await wEval(() => document.querySelectorAll('#danmaku-layer .dm-item').length === 0),
    await wEval(() => document.querySelectorAll('#danmaku-layer .dm-item').length + ' 条'));
  check('关闭弹幕不影响词云继续收集',
    await until(() => cEval(() => document.querySelectorAll('#w-chips .wchip').length > 0)),
    await cEval(() => document.querySelectorAll('#w-chips .wchip').length + ' 个'));
  await clickAndToast('#w-stop');

  // 「允许抢答」开关：关掉之后教师点开始要被明确拒绝，而不是静默无反应
  await tab('settings');
  await setChecked('#set-buzz', false);
  await clickAndToast('#set-save');
  await tab('buzz');
  const tBuzz = await clickAndToast('#b-start');
  check('关闭「允许抢答」后教师点开始被明确拒绝', /关闭/.test(tBuzz), tBuzz);
  check('被拒绝时大屏没有切到抢答', (await wallView()) !== 'buzz', await wallView());

  // 「允许多选」开关：关着的时候，就算教师勾了多选也得降级成单选
  await tab('poll');
  await setVal('#p-question', '多选开关测试');
  await setVal('#p-options', '甲\n乙\n丙');
  await setSelect('#p-multi', '1');
  await clickAndToast('#p-start');
  await emit(stus[0].sock, 'student:vote', { indexes: [0, 1] });
  await wait(600);
  check('「允许多选」关闭时，一人投两项只记第一项',
    await until(() => wEval(() => {
      const n = [...document.querySelectorAll('#poll-bars .bar-num')].map((e) => Number(e.textContent));
      return n[0] === 1 && n[1] === 0 && n[2] === 0;
    })),
    await wEval(() => [...document.querySelectorAll('#poll-bars .bar-num')].map((e) => e.textContent).join('/')));
  await clickAndToast('#p-stop');
  await wait(300);

  await tab('settings');
  await setChecked('#set-multivote', true);
  await setChecked('#set-buzz', true);
  await setChecked('#set-danmaku', true);
  await clickAndToast('#set-save');
  await tab('poll');
  await setVal('#p-question', '多选开关测试');
  await setVal('#p-options', '甲\n乙\n丙');
  await setSelect('#p-multi', '1');
  await clickAndToast('#p-start');
  await emit(stus[1].sock, 'student:vote', { indexes: [0, 1] });
  await wait(600);
  check('打开「允许多选」后，一人投两项两项都计数',
    await until(() => wEval(() => {
      const n = [...document.querySelectorAll('#poll-bars .bar-num')].map((e) => Number(e.textContent));
      return n[0] === 1 && n[1] === 1 && n[2] === 0;
    })),
    await wEval(() => [...document.querySelectorAll('#poll-bars .bar-num')].map((e) => e.textContent).join('/')));
  await clickAndToast('#p-stop');
  await wait(300);

  await realClick(ctl, '#c-clearhands');
  check('点击侧栏「清空」后举手归零',
    await until(() => cEval(() => document.querySelector('#c-handcount').textContent === '0')),
    await cEval(() => document.querySelector('#c-handcount').textContent));
  check('大屏举手列表同步清空',
    await until(() => wEval(() => document.querySelectorAll('#hands-list > *').length === 0)),
    await wEval(() => document.querySelectorAll('#hands-list > *').length + ' 个'));
});

/* ==================== 12. 互动题库 ==================== */

await section('[12] 互动题库（课前录题，课堂一键发布）', async () => {
  await tab('bank');
  check('题库面板能切过去', await cEval(() => {
    const p = document.querySelector('.tab-pane[data-pane="bank"]');
    return !!p && p.classList.contains('active');
  }));

  // 选项不足 2 个：服务端要拒（前端拦不住直接发事件的人，服务端才是底线）
  await setSelect('#qb-type', 'poll');
  await setVal('#qb-question', '只有一项的题');
  await setVal('#qb-options', '只有我一个');
  const t1 = await clickAndToast('#qb-add');
  check('题库：选项不足 2 个被拒绝', /2 个/.test(t1), t1);

  await setVal('#qb-question', '题库一键发布测试');
  await setVal('#qb-options', '甲\n乙\n丙');
  const t2 = await clickAndToast('#qb-add');
  check('题库：录入成功有反馈', /已加入题库/.test(t2), t2);
  check('题库列表出现题目',
    await until(() => cEval(() => document.querySelectorAll('#qb-list .qb-item').length === 1)),
    await cEval(() => document.querySelectorAll('#qb-list .qb-item').length + ' 条'));
  check('录入后输入框已清空，方便接着录下一题',
    await cEval(() => document.querySelector('#qb-question').value === ''),
    await cEval(() => document.querySelector('#qb-question').value));

  // 一键发布：不用重抄一遍题干选项，大屏直接就是这道题
  await cEval(() => {
    const b = document.querySelector('#qb-list [data-act="send"]');
    if (b) b.click();
  });
  await wait(700);
  check('一键发布后大屏进入投票', await until(async () => (await wallView()) === 'poll'), await wallView());
  check('大屏题干与题库内容一致',
    await until(() => wEval(() => (document.querySelector('#poll-question') || {}).textContent === '题库一键发布测试')),
    await wEval(() => (document.querySelector('#poll-question') || {}).textContent));
  check('大屏显示 3 个选项（甲/乙/丙）',
    await until(() => wEval(() => document.querySelectorAll('#poll-bars .bar').length === 3)),
    await wEval(() => document.querySelectorAll('#poll-bars .bar').length + ' 个'));
  check('大屏选项文字与题库一致',
    await wEval(() => [...document.querySelectorAll('#poll-bars .bar-label')].map((e) => e.textContent.trim()).join('|')),
    '甲|乙|丙');
  check('发布后控制端自动切到投票面板看结果',
    await cEval(() => {
      const p = document.querySelector('.tab-pane[data-pane="poll"]');
      return !!p && p.classList.contains('active');
    }));
  // 2026-09-09 修复：从题库发布后，控制端投票面板的题干和选项必须自动回填，
  // 否则老师切回面板会以为「题目推出去了但选项没填上去」。
  check('发布后控制端题干已回填',
    await until(() => cEval(() => document.querySelector('#p-question').value === '题库一键发布测试')),
    await cEval(() => document.querySelector('#p-question').value));
  check('发布后控制端选项已回填（甲/乙/丙）',
    await until(() => cEval(() => document.querySelector('#p-options').value === '甲\n乙\n丙')),
    await cEval(() => JSON.stringify(document.querySelector('#p-options').value)));
});

/* ==================== 12b. 题库跨课堂共享（导入 JSON） ==================== */

await section('[12b] 题库跨课堂共享：导入另一个班级的题库 JSON', async () => {
  // 造一份「导出格式」的样例文件：4 条合法（投票/小测/词云/抢答）+ 1 条非法（选项不足）
  const fs = await import('node:fs');
  const samplePath = path.join(HERE, '_sample_bank.json');
  const sample = {
    app: 'classroom-interactive', kind: 'question-bank', version: 1,
    items: [
      { id: 'imp-1', type: 'poll', question: '导入题·数据清洗第一步', options: ['数据审查', '直接删除', '建模', '画图'], correct: null, multi: false },
      { id: 'imp-2', type: 'quiz', question: '导入题·主键特征', options: ['唯一', '可空', '重复'], correct: 0, multi: false },
      { id: 'imp-3', type: 'word', question: '导入题·用一个词形容数据清洗', options: [], correct: null, multi: false },
      { id: 'imp-4', type: 'buzz', question: '导入题·删除重复值在哪个选项卡', options: [], correct: null, multi: false },
      { type: 'poll', question: '导入题·选项不足应被忽略', options: ['只有一个'], correct: null, multi: false },
    ],
  };
  fs.writeFileSync(samplePath, JSON.stringify(sample, null, 2));

  const before = await cEval(() => document.querySelectorAll('#qb-list .qb-item').length);
  const input = await ctl.$('#qb-import-file');
  await input.uploadFile(samplePath);
  const grew = await until(async () => {
    const n = await cEval(() => document.querySelectorAll('#qb-list .qb-item').length);
    return n > before;
  }, 6000);
  check('导入后题库题目数增加', grew,
    `before=${before} after=${await cEval(() => document.querySelectorAll('#qb-list .qb-item').length)}`);

  const classes = await cEval(() => [...document.querySelectorAll('#qb-list .qb-type')]
    .map((e) => e.className).join(' '));
  check('导入覆盖投票/小测/词云/抢答四类',
    /t-poll/.test(classes) && /t-quiz/.test(classes) && /t-word/.test(classes) && /t-buzz/.test(classes),
    classes);

  check('非法题（选项不足）被忽略、不进题库',
    await cEval(() => ![...document.querySelectorAll('#qb-list .qb-q')]
      .some((e) => /选项不足应被忽略/.test(e.textContent))),
    await cEval(() => [...document.querySelectorAll('#qb-list .qb-q')].map((e) => e.textContent).join(' | ')));

  // 幂等：同一文件再导入一次，合法题按 id 去重不应重复
  await input.uploadFile(samplePath);
  await wait(800);
  const after2 = await cEval(() => document.querySelectorAll('#qb-list .qb-item').length);
  check('重复导入同一文件不重复（按 id 去重）', after2 === before + 4,
    `期望 ${before + 4}，实际 ${after2}`);

  fs.unlinkSync(samplePath);
});

/* ==================== 13. 暂停 / 继续 ==================== */

await section('[13] 暂停与继续（看结果，但不结束）', async () => {
  // 接着上一节一键发布的那道题用
  const bars = () => wEval(() => [...document.querySelectorAll('#poll-bars .bar-num')]
    .map((e) => Number(e.textContent) || 0));

  await emit(stus[0].sock, 'student:vote', { indexes: [0] });
  await wait(500);
  check('暂停前：学生投票成功了', (await bars())[0] === 1, (await bars()).join('/'));

  const tp = await clickAndToast('#p-pause');
  check('点击「暂停」有反馈', /暂停/.test(tp), tp);
  check('暂停按钮变成「继续」',
    await until(() => cEval(() => /继续/.test(document.querySelector('#p-pause').textContent))),
    await cEval(() => document.querySelector('#p-pause').textContent.trim()));

  // 关键：暂停≠结束。结果必须还挂在大屏上，这正是加暂停键的原因。
  check('暂停后大屏仍停留在投票视图', await until(async () => (await wallView()) === 'poll'), await wallView());
  check('暂停后大屏结果还在（票数未清零）',
    await until(async () => (await bars())[0] === 1), (await bars()).join('/'));
  check('大屏提示已暂停',
    await until(() => wEval(() => /暂停/.test(document.querySelector('#poll-hint').textContent))),
    await wEval(() => document.querySelector('#poll-hint').textContent));

  const r = await emit(stus[1].sock, 'student:vote', { indexes: [1] });
  check('暂停期间学生投票被拒', r && r.ok === false, JSON.stringify(r));
  check('拒绝文案说明是暂停而不是结束', /暂停/.test((r && r.msg) || ''), (r && r.msg) || '');
  await wait(400);
  check('暂停期间的票数没有变化', (await bars())[1] === 0, (await bars()).join('/'));

  const tr = await clickAndToast('#p-pause');
  check('点击「继续」有反馈', /继续|恢复/.test(tr), tr);
  const r2 = await emit(stus[1].sock, 'student:vote', { indexes: [1] });
  check('继续后学生可以正常投票', r2 && r2.ok === true, JSON.stringify(r2));
  check('继续后票数累加', await until(async () => (await bars())[1] === 1), (await bars()).join('/'));

  // 结束仍然照旧：活动收掉，大屏离开投票
  await clickAndToast('#p-stop');
  await wait(600);
  check('点结束之后大屏离开投票视图', await until(async () => (await wallView()) !== 'poll'), await wallView());

  // 词云的暂停键走的是同一条链路，抽一道验一次就够
  await tab('word');
  await clickAndToast('#w-start');
  await wait(400);
  const tw = await clickAndToast('#w-pause');
  check('词云也有暂停键', /暂停/.test(tw), tw);
  // 只发一次：重复发会污染后面的断言，也会让失败信息对不上号
  const wRes = await emit(stus[0].sock, 'student:word', { text: '暂停后发言' });
  check('词云暂停后学生发言被拒',
    wRes && wRes.ok === false && /暂停/.test(wRes.msg || ''), JSON.stringify(wRes));
  await clickAndToast('#w-stop');
  await wait(400);
});

/* ==================== 14. 多节课：开始新的一课 ==================== */

await section('[14] 多节课继承与清理', async () => {
  await tab('settings');
  const before = {
    scores: await sumScores(),
    online: await cEval(() => document.querySelector('#c-online').textContent),
  };

  // 「开始新的一课」走的是 window.confirm，测试里必须接管弹窗，否则页面会卡死
  const onDlg = (d) => d.accept();
  ctl.on('dialog', onDlg);
  const tn = await clickAndToast('#set-newsession');
  ctl.off('dialog', onDlg);

  check('开始新的一课有反馈', /第 2 课/.test(tn), tn);
  check('课次显示更新为第 2 课',
    await until(() => cEval(() => /第 2 课/.test(document.querySelector('#session-now').textContent))),
    await cEval(() => document.querySelector('#session-now').textContent));
  check('新一课保留了学生名单（在线人数不变）',
    await until(async () => (await cEval(() => document.querySelector('#c-online').textContent)) === before.online),
    `新 ${await cEval(() => document.querySelector('#c-online').textContent)} / 旧 ${before.online}`);
  check('新一课保留了累计积分（继承不清零）',
    await until(async () => (await sumScores()) === before.scores),
    `新 ${await sumScores()} / 旧 ${before.scores}`);
  check('新一课清掉了上一节的活动（大屏回到待机）',
    await until(async () => (await wallView()) === 'idle'), await wallView());
  check('新一课清掉了举手列表',
    await until(() => wEval(() => document.querySelectorAll('#hands-list > *').length === 0)),
    await wEval(() => document.querySelectorAll('#hands-list > *').length + ' 个'));
  // 2026-09 新需求：座位每节课会变，新一课应清空而不是保留
  check('新一课清掉了所有座位（教室座位每节课可能变）',
    await until(() => cEval(() => [...document.querySelectorAll('#st-table .st-seat')].every((el) => /未选座/.test(el.textContent)))),
    await cEval(() => [...document.querySelectorAll('#st-table .st-seat')].map((el) => el.textContent).join('|')));
  check('新一课清掉了本次得分（学生列表行里的"本次 N"都是 0）',
    await until(() => cEval(() => [...document.querySelectorAll('#st-table .st-score em')].every((el) => /本次 0/.test(el.textContent)))),
    await cEval(() => [...document.querySelectorAll('#st-table .st-score em')].map((el) => el.textContent).join('|')));
});

/* ==================== 14b. 改昵称 / 双分数显示（2026-09 新需求） ==================== */

await section('[14b] 改昵称 + 本次分/总积分分离显示', async () => {
  // 先让 0 号同学重新入座一下，前一节清掉了座位才有东西可看
  await emit(stus[0].sock, 'student:seat', { row: 0, col: 0 });
  await wait(200);
  await tab('students');

  // 学生列表每一行既有总积分 b 又有"本次 N"，不是拼接糊弄
  const row0 = await cEval(() => {
    const li = document.querySelector('#st-table .st-row');
    const sB = li && li.querySelector('.st-score b');
    const sEm = li && li.querySelector('.st-score em');
    return { total: sB && sB.textContent, sess: sEm && sEm.textContent };
  });
  check('学生行同时显示总积分（大数）和本次分（小字 em）',
    row0.total && /^\d+$/.test(row0.total) && row0.sess && /本次\s*\d+/.test(row0.sess),
    JSON.stringify(row0));

  // 排行榜也是双分数（控制端只显示裸数字，不带"本次"前缀，靠 title 提示详情）
  const rank0 = await cEval(() => {
    const li = document.querySelector('#c-ranklist li');
    const b = li && li.querySelector('.rscore b');
    const em = li && li.querySelector('.rscore em');
    return { total: b && b.textContent, sess: em && em.textContent };
  });
  check('排行榜每个名次都有"总积分 + 本次 X"两段（裸数字 em，不带前缀）',
    rank0.total && /^\d+$/.test(rank0.total) && rank0.sess && /^\d+$/.test(rank0.sess),
    JSON.stringify(rank0));

  // 改昵称：成功路径
  const renamedId = stus[0].id;
  const before = await cEval(([id]) => {
    const btn = document.querySelector(`#st-table [data-act="add"][data-id="${id}"]`);
    if (!btn) return null;
    const row = btn.closest('.st-row');
    return row && row.querySelector('.st-name') && row.querySelector('.st-name').textContent.trim();
  }, [renamedId]);
  const ack1 = await emit(stus[0].sock, 'student:rename', { nickname: '改名后甲' });
  check('student:rename 成功返回 ok', !!(ack1 && ack1.ok), JSON.stringify(ack1));
  check('student:rename 同步返回最新昵称',
    ack1 && ack1.nickname === '改名后甲', ack1 && ack1.nickname);

  await until(async () => {
    const n = await cEval(([id]) => {
      const btn = document.querySelector(`#st-table [data-act="add"][data-id="${id}"]`);
      if (!btn) return null;
      const row = btn.closest('.st-row');
      return row && row.querySelector('.st-name') && row.querySelector('.st-name').textContent.trim();
    }, [renamedId]);
    return /改名后甲/.test(n || '') ? 'ok' : false;
  }, 4000);
  const after = await cEval(([id]) => {
    const btn = document.querySelector(`#st-table [data-act="add"][data-id="${id}"]`);
    if (!btn) return null;
    const row = btn.closest('.st-row');
    return row && row.querySelector('.st-name') && row.querySelector('.st-name').textContent.trim();
  }, [renamedId]);
  check('控制端学生表实时刷新到新昵称', /改名后甲/.test(after || ''), `旧「${before}」新「${after}」`);

  // 空昵称 / 空白被拒
  const ack2 = await emit(stus[0].sock, 'student:rename', { nickname: '   ' });
  check('空昵称被拒绝', !(ack2 && ack2.ok), JSON.stringify(ack2));
  // 原昵称依旧在
  const stillThere = await cEval(([id]) => {
    const btn = document.querySelector(`#st-table [data-act="add"][data-id="${id}"]`);
    if (!btn) return null;
    const row = btn.closest('.st-row');
    return row && row.querySelector('.st-name') && row.querySelector('.st-name').textContent.trim();
  }, [renamedId]);
  check('空昵称被拒后原昵称不变', /改名后甲/.test(stillThere || ''), `当前「${stillThere}」`);

  // 与他人重名（不抢身份，但提示）
  const ack3 = await emit(stus[1].sock, 'student:rename', { nickname: '改名后甲' });
  check('与他人重名允许改但返回 clash 标志',
    !!(ack3 && ack3.ok) && ack3.clash === true, JSON.stringify(ack3));
  const totalAfter = await cEval(() => document.querySelectorAll('#st-table .st-row').length);
  check('重名没有合并成同一身份（仍是 12 行）', totalAfter === 12, `${totalAfter} 行`);

  // 改回原名清场
  await emit(stus[1].sock, 'student:rename', { nickname: NAMES[1] });
});

/* ==================== 15. 面板切换 ==================== */

await section('[15] 面板切换', async () => {
  const tabs = ['word', 'wheel', 'buzz', 'seat', 'group', 'timer', 'fx', 'students', 'settings', 'poll', 'bank'];
  let allOk = true; let bad = '';
  for (const name of tabs) {
    await tab(name);
    const ok = await cEval((n) => {
      const pane = document.querySelector(`.tab-pane[data-pane="${n}"]`);
      const nav = document.querySelector(`.nav-i[data-tab="${n}"]`);
      return !!pane && pane.classList.contains('active') && !!nav && nav.classList.contains('active');
    }, name);
    if (!ok) { allOk = false; bad = name; break; }
  }
  check(`${tabs.length} 个功能面板逐一点击都能切过去`, allOk, bad ? `卡在 ${bad}` : '');
});

/* ==================== 收尾 ==================== */

await section('[16] 全程无 JS 报错', async () => {
  check('控制端无 JS 报错', errors.control.length === 0, errors.control.slice(0, 3).join(' | '));
  check('大屏无 JS 报错', errors.wall.length === 0, errors.wall.slice(0, 3).join(' | '));
});

/* ==================== 17. 喝彩开关：学生端按钮联动 ==================== */
// 放在最后：这个测试会开一个真实手机页加入课堂（变成第 13 名同学），
// 而前面的 [14b] 断言「名单仍是 12 行」，挪到收尾才不会影响那些人数敏感的断言。

await section('[17] 喝彩开关：教师关闭后学生端按钮置灰，防刷屏', async () => {
  await tab('settings');
  check('喝彩开关默认开启', await cEval(() => document.querySelector('#set-cheer').checked === true));
  await setChecked('#set-cheer', false);
  await clickAndToast('#set-save');

  // 开一个真实学生手机页验证按钮真的被置灰（不是只靠服务端拦）
  // 注：boot 只在有历史 studentId 时才自动连 socket，新同学必须填昵称点「进入课堂」
  const mob = await openPage('mob', `${BASE}/m?room=${room.code}`, {
    viewport: { width: 390, height: 844 },
    seed: [[`nick_${room.code}`, '喝彩测试生'], [`av_${room.code}`, '🦊']],
  });
  const mEval = (fn, ...a) => mob.evaluate(fn, ...a);
  // 确保昵称已填（localStorage 回填），再点「进入课堂」建立连接并加入
  await mob.evaluate((n) => { const el = document.querySelector('#m-nickname'); if (el) el.value = n; }, '喝彩测试生');
  await realClick(mob, '#m-join-btn');
  check('关闭喝彩后学生端按钮置灰（.disabled）',
    await until(() => mEval(() => document.querySelector('#m-cheer-btn').classList.contains('disabled')), 8000),
    await mEval(() => document.querySelector('#m-cheer-btn').className));
  check('关闭喝彩后按钮文案变为「已关闭」',
    await mEval(() => document.querySelector('#m-cheer-btn').querySelector('b').textContent === '已关闭'),
    await mEval(() => document.querySelector('#m-cheer-btn').querySelector('b').textContent));
  // 关着时服务端也该拒：emit 回去是 ok:false，屏幕不会被刷
  const rOff = await emit(stus[0].sock, 'student:cheer', { kind: '👏' });
  check('关闭喝彩后学生发喝彩被服务端拒绝', rOff && rOff.ok === false, JSON.stringify(rOff));
  await mob.close();

  // 重新打开喝彩，按钮恢复可点，且能正常发出
  await tab('settings');
  await setChecked('#set-cheer', true);
  await clickAndToast('#set-save');
  await wait(300);
  const rOn = await emit(stus[0].sock, 'student:cheer', { kind: '🔥' });
  check('重新打开喝彩后学生喝彩恢复正常', rOn && rOn.ok === true, JSON.stringify(rOn));
});

/* ==================== 18. 题型与答案 ==================== */
// 三种题型（选择题 / 判断题 / 简答题）+ 答案可设可公布：
// 重点是「老师可以选择不公布」——答案只在点过公布之后才下发，结束本身不公布。

await section('[18] 题型：判断题 / 简答题，以及「可选择不公布答案」', async () => {
  /* --- 判断题 --- */
  await tab('poll');
  await setVal('#p-question', '判断题：数据清洗第一步通常是处理缺失值');
  await setSelect('#p-format', 'judge');
  check('切到判断题后隐藏手填选项（由服务端固定）',
    await cEval(() => document.querySelector('#p-only-choice').classList.contains('hidden')));
  check('判断题的正确答案只有「正确 / 错误」两项',
    await cEval(() => [...document.querySelectorAll('#p-correct option')]
      .map((o) => o.textContent).join('|') === '不设正确答案|A. 正确|B. 错误'),
    await cEval(() => [...document.querySelectorAll('#p-correct option')].map((o) => o.textContent).join('|')));

  await setSelect('#p-correct', '0');
  await clickAndToast('#p-start');
  check('大屏渲染判断题的 2 根柱子',
    await until(() => wEval(() => document.querySelectorAll('#poll-bars .bar').length === 2)),
    await wEval(() => document.querySelectorAll('#poll-bars .bar').length + ' 根'));
  await emit(stus[0].sock, 'student:vote', { indexes: [0] });
  await wait(400);

  // 未公布：答案条必须是隐藏的（这是"可以选择不公布"的关键）
  check('未点公布时大屏不显示答案',
    await wEval(() => document.querySelector('#poll-answer-ref').classList.contains('hidden')));
  await clickAndToast('#p-reveal');
  check('点「公布答案」后大屏显示正确答案',
    await until(() => wEval(() => {
      const el = document.querySelector('#poll-answer-ref');
      return !el.classList.contains('hidden') && /正确答案/.test(el.textContent);
    })),
    await wEval(() => document.querySelector('#poll-answer-ref').textContent));
  check('公布答案按钮变成「收起答案」',
    await cEval(() => /收起/.test(document.querySelector('#p-reveal').textContent)),
    await cEval(() => document.querySelector('#p-reveal').textContent));
  await clickAndToast('#p-reveal');
  check('再点一次可以收起答案',
    await until(() => wEval(() => document.querySelector('#poll-answer-ref').classList.contains('hidden'))));
  await clickAndToast('#p-stop');
  await wait(300);

  /* --- 简答题 --- */
  await tab('poll');
  await setVal('#p-question', '简答：数据清洗第一步你会做什么？');
  await setSelect('#p-format', 'text');
  check('切到简答题后隐藏选项与「正确答案」',
    await cEval(() => document.querySelector('#p-only-choice').classList.contains('hidden')
      && document.querySelector('#p-only-correct').classList.contains('hidden')));
  check('简答题显示参考答案输入框',
    await cEval(() => !document.querySelector('#p-only-answer').classList.contains('hidden')));
  await setVal('#p-answer', '先看缺失值，再查重复');
  await clickAndToast('#p-start');

  // 简答题必须走 student:answer，不能再用投票接口
  const rVote = await emit(stus[1].sock, 'student:vote', { indexes: [0] });
  check('简答题下用投票接口提交被拒', rVote && rVote.ok === false, JSON.stringify(rVote));
  const rAns = await emit(stus[1].sock, 'student:answer', { text: '先处理缺失值' });
  check('简答题：学生提交文字答案成功', rAns && rAns.ok === true, JSON.stringify(rAns));

  check('大屏答案墙出现该答案',
    await until(() => wEval(() => [...document.querySelectorAll('#poll-answers .ans-item')]
      .some((el) => el.textContent.includes('先处理缺失值')))),
    await wEval(() => document.querySelector('#poll-answers').textContent.slice(0, 60)));
  check('未公布时大屏不显示参考答案',
    await wEval(() => document.querySelector('#poll-answer-ref').classList.contains('hidden')));
  await clickAndToast('#p-reveal');
  check('公布后大屏显示参考答案',
    await until(() => wEval(() => {
      const el = document.querySelector('#poll-answer-ref');
      return !el.classList.contains('hidden') && el.textContent.includes('先看缺失值');
    })),
    await wEval(() => document.querySelector('#poll-answer-ref').textContent));
  await clickAndToast('#p-stop');
  await wait(300);

  /* --- 题库：抢答题也能带题型和答案 --- */
  await tab('bank');
  await setSelect('#qb-type', 'buzz');
  await setSelect('#qb-format', 'choice');
  await setVal('#qb-question', '抢答：Excel 删除重复值在哪个选项卡');
  await setVal('#qb-options', '数据\n开始\n公式');
  await setSelect('#qb-correct', '0');
  const tAdd = await clickAndToast('#qb-add');
  check('题库：抢答题可以录入并带答案', /已加入题库/.test(tAdd), tAdd);

  // 发布最后一道（刚录的抢答题）
  await cEval(() => {
    const btns = [...document.querySelectorAll('#qb-list [data-act="send"]')];
    if (btns.length) btns[btns.length - 1].click();
  });
  await wait(600);
  // 注意：wallView() 是 async，不能直接和字符串比（Promise === 'buzz' 恒 false）
  check('发布抢答题后大屏进入抢答',
    await until(() => wallView().then((v) => v === 'buzz')), await wallView());
  check('抢答把题目选项挂在大屏上（只抢不答，选项供全班看）',
    await until(() => wEval(() => document.querySelectorAll('#buzz-options .buzz-opt').length === 3)),
    await wEval(() => document.querySelectorAll('#buzz-options .buzz-opt').length + ' 个'));
  check('抢答未公布时大屏不显示答案',
    await wEval(() => document.querySelector('#buzz-answer-ref').classList.contains('hidden')));
  await tab('buzz');
  await clickAndToast('#b-reveal');
  check('抢答公布答案后大屏显示正确答案',
    await until(() => wEval(() => {
      const el = document.querySelector('#buzz-answer-ref');
      return !el.classList.contains('hidden') && /数据/.test(el.textContent);
    })),
    await wEval(() => document.querySelector('#buzz-answer-ref').textContent));
  await clickAndToast('#b-stop');
  await wait(300);

  // 收尾：把题型切回选择题，免得影响后续手工验证
  await tab('poll');
  await setSelect('#p-format', 'choice');
});

await browser.close();
for (const s of stus) s.sock.close();

console.log(`\n${'='.repeat(52)}`);
console.log(`控制端交互验证：通过 ${pass} · 失败 ${fail}`);
if (failed.length) console.log('失败项：\n  - ' + failed.join('\n  - '));
process.exit(fail ? 1 : 0);
