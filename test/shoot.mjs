/**
 * 大屏截图脚本：按状态出 1920×1080 大图，方便直接插进 PPT / 发给同事看。
 *
 * 关键点：必须先让浏览器连上大屏、再触发该状态，
 * 否则弹幕这类"实时事件"会在页面加载前就发完，截图里看不到飞行中的弹幕。
 *
 * 用法：node test/shoot.mjs [state...]
 *   state: idle | poll | word | wheel | wheelspin | buzz | seat | group
 *   省略则跑全部
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOM = JSON.parse(fs.readFileSync(path.join(HERE, 'demo-room.json'), 'utf8')).code;
const STEP_FILE = path.join(HERE, 'step.txt');
const OUT_DIR = path.join(HERE, '..', 'shots');
const CHROME = process.env.CHROME || 'C:\\Users\\17790\\.agent-browser\\browsers\\chrome-152.0.7977.64\\chrome.exe';
const BASE = 'http://localhost:3000';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 每个状态的就绪条件（在页面里求值） */
const READY = {
  idle: `v('view-idle') && q('#idle-avatars > *').length > 0`,
  poll: `v('view-poll') && q('#poll-bars .bar').length === 5 && num('#poll-bars .bar-num') === 12`,
  word: `v('view-word') && q('#word-cloud .wc-word').length >= 10 && q('#danmaku-layer .dm-item').length > 0`,
  wheel: `v('view-wheel') && q('#wheel-list li').length === 8`,
  wheelspin: `el('#wheel-result').classList.contains('show') && txt('#wr-name').length > 0`,
  buzz: `v('view-buzz') && q('#buzz-podium > *').length === 3`,
  seat: `v('view-seat') && q('#seat-map .seat').length === 48`,
  group: `v('view-group') && q('#group-grid .group-card').length === 5`,
};
const HELPERS = `
  const q = (s) => Array.from(document.querySelectorAll(s));
  const el = (s) => document.querySelector(s);
  const txt = (s) => (el(s)?.textContent || '').trim();
  const num = (s) => q(s).reduce((a, e) => a + (Number(e.textContent) || 0), 0);
  const v = (id) => !!document.querySelector('.view.active#' + id);
`;

/** 等元素位置连续两次采样一致，避免截到过渡动画的中间帧 */
async function waitStable(page, selector, timeout = 9000) {
  await page.evaluate((s) => { window.__sig = null; window.__sel = s; }, selector);
  await page.waitForFunction(() => {
    const sig = Array.from(document.querySelectorAll(window.__sel))
      .map((e) => { const b = e.getBoundingClientRect(); return `${Math.round(b.left)},${Math.round(b.top)},${Math.round(b.width)}`; })
      .join('|');
    const stable = sig === window.__sig;
    window.__sig = sig;
    return stable && sig.length > 0;
  }, { timeout, polling: 350 }).catch(() => {});
}

(async () => {
  const list = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(READY);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log('房间', ROOM, '  截图目录', OUT_DIR);

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars', '--autoplay-policy=no-user-gesture-required'],
    defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
  });
  const page = await browser.newPage();
  await page.setCacheEnabled(false);

  // 先回到待机并连上大屏
  fs.writeFileSync(STEP_FILE, 'idle');
  await page.goto(`${BASE}/w?room=${ROOM}`, { waitUntil: 'networkidle2', timeout: 20000 });
  await page.waitForFunction(`(() => { ${HELPERS} return Number(txt('#w-online')) > 0; })()`, { timeout: 10000 })
    .catch(() => console.log('  ! 等待学生上线超时'));
  console.log('大屏已连接');

  for (const state of list) {
    if (!READY[state]) { console.log('  跳过未知状态', state); continue; }
    // wheelspin 需要先开转盘再转
    for (const step of state === 'wheelspin' ? ['wheel', 'wheelspin'] : [state]) {
      fs.writeFileSync(STEP_FILE, step);
      await wait(step === 'wheelspin' ? 600 : 900);   // > demo 的 600ms 轮询周期
    }
    await page.waitForFunction(`(() => { ${HELPERS} return ${READY[state]}; })()`, { timeout: 25000, polling: 200 })
      .catch(() => console.log(`  ! [${state}] 等待就绪超时`));
    // 等动画收敛；转盘要等它转完（5s）再截中奖卡
    await wait(state === 'wheelspin' ? 1200 : 700);
    await waitStable(page, '.view.active *');
    const out = path.join(OUT_DIR, `大屏-${state}.png`);
    await page.screenshot({ path: out, fullPage: false });
    console.log('  已截图', path.basename(out), `(${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
    fs.writeFileSync(STEP_FILE, 'idle');
    await wait(1800);
  }

  await browser.close();
  console.log('\n完成，输出目录：', OUT_DIR);
})().catch((e) => { console.error(e); process.exit(1); });
