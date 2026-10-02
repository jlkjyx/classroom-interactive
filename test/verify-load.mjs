/**
 * 并发容量压测
 *
 * 为什么测这个：README 里写着「常规课堂（几十到 200 人）毫无压力」，
 * 但这句话从来没被验证过。如果它是错的，会在最糟的时刻暴露——真实课堂上。
 * 宁可现在测出来，把数字改对。
 *
 * 关注三个指标（老师真正能感知到的）：
 *   1. 全员加入要多久（上课前几分钟扫码进场，等太久就卡在门口）
 *   2. 最后一个人加入后，大屏多久看到全员在线（同步延迟）
 *   3. 一人投票，大屏多久更新（互动实时性）
 *
 * 教训（第一版在这里挂了 21 分钟才被杀掉，就是因为以下两点都没做）：
 *   - connect() 必须自带超时。socket.io-client 在连接既不成功也不报错时
 *     会永远悬着，外层 await 就再也不会返回，脚本静默卡死。
 *   - 必须分批打印进度。没有进度输出时，"慢"和"死"看起来一模一样。
 *
 * 用法：node test/verify-load.mjs [人数]   （默认 200）
 */
import { io } from 'socket.io-client';

const BASE = 'http://localhost:3000';
const N = Number(process.argv[2] || 200);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};
const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};

/** 连接并等待握手，带硬超时——不做这一步，卡住时脚本会永远不返回 */
function connect(ms = 8000) {
  return new Promise((res, rej) => {
    const s = io(BASE, { transports: ['websocket'], timeout: ms });
    const t = setTimeout(() => { s.close(); rej(new Error('connect timeout')); }, ms);
    s.on('connect', () => { clearTimeout(t); res(s); });
    s.on('connect_error', (e) => { clearTimeout(t); s.close(); rej(e); });
  });
}

/** 发事件并等 ack，带硬超时 */
function emit(s, ev, data = {}, ms = 8000) {
  return new Promise((res) => {
    const t = setTimeout(() => res({ ok: false, msg: 'timeout' }), ms);
    s.emit(ev, data, (r) => { clearTimeout(t); res(r || { ok: true }); });
  });
}

(async () => {
  console.log(`\n▶ 并发压测：${N} 人`);

  /* ---------- 建课堂 ---------- */
  const room = await fetch(`${BASE}/api/room`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: `压测${N}人`, rows: 12, cols: 12, frontRows: 3 }),
  }).then((r) => r.json());
  const { code, token } = room;
  check('课堂创建成功', /^[A-Z0-9]{6}$/.test(code), code);

  const ctl = await connect();
  await emit(ctl, 'control:join', { code, token });
  const wall = await connect();
  await emit(wall, 'wall:join', { code });

  // 服务端自己的内存基线：每个房间的数据都住在服务进程里，
  // 学生涨到几百人时，涨的是服务端的内存，不是压测客户端的。
  const memOf = async () => {
    const r = await fetch(`${BASE}/healthz`).then((x) => x.json()).catch(() => null);
    return r;
  };
  await memOf();

  /* ---------- 1. 全员加入 ---------- */
  console.log(`\n[1] ${N} 人陆续扫码进场`);
  const socks = [];
  const joinMs = [];
  const t0 = Date.now();
  let joinFail = 0;
  const BATCH = 20;
  for (let i = 0; i < N; i++) {
    const a = Date.now();
    try {
      const s = await connect();
      const r = await emit(s, 'student:join', { code, nickname: `同学${i + 1}`, avatar: '🦊' });
      if (!r || !r.studentId) { joinFail++; s.close(); } else socks.push(s);
      joinMs.push(Date.now() - a);
    } catch (e) {
      joinFail++; joinMs.push(Date.now() - a);
    }
    if ((i + 1) % BATCH === 0) {
      // 没有这行进度日志，脚本挂了 21 分钟我都看不出它是在慢慢跑还是已经死了
      console.log(`     ${i + 1}/${N} 已加入 · 累计 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      await wait(50);   // 每 20 人喘口气，模拟真实扫码节奏
    }
  }
  const totalJoin = Date.now() - t0;
  console.log(`     全员加入耗时 ${(totalJoin / 1000).toFixed(1)}s · 单次加入 p50=${pct(joinMs, 0.5)}ms p95=${pct(joinMs, 0.95)}ms max=${Math.max(...joinMs)}ms`);
  check(`${N} 人全部加入成功`, joinFail === 0, `失败 ${joinFail} 人`);
  check('单次加入 p95 在 1.5s 内（进门不卡）', pct(joinMs, 0.95) < 1500, `p95=${pct(joinMs, 0.95)}ms`);

  /* ---------- 2. 状态同步延迟 ---------- */
  console.log('\n[2] 大屏看到全员在线要多久');
  const tSync0 = Date.now();
  let online = 0;
  for (let i = 0; i < 100; i++) {
    const info = await fetch(`${BASE}/api/room/${code}`).then((r) => r.json());
    online = info.online;
    if (online >= N) break;
    await wait(100);
  }
  const syncMs = Date.now() - tSync0;
  check(`大屏在线数收敛到 ${N}`, online >= N, `online=${online}（耗时 ${syncMs}ms）`);
  check('同步延迟 < 2s', syncMs < 2000, `${syncMs}ms`);

  /* ---------- 3. 投票实时性 ---------- */
  console.log('\n[3] 全员投票，看大屏多久更新');
  await emit(ctl, 'poll:start', { question: '压测投票', options: ['A', 'B', 'C', 'D'] });
  await wait(300);

  let firstUpdate = null; let lastUpdate = null; let updates = 0;
  wall.on('poll:update', () => {
    const now = Date.now();
    if (firstUpdate === null) firstUpdate = now;
    lastUpdate = now;
    updates++;
  });

  const tv = Date.now();
  const voteMs = [];
  let voteFail = 0;
  for (let i = 0; i < socks.length; i++) {
    const a = Date.now();
    // 注意：事件名是 student:vote（不是 poll:vote），且参数是 indexes 数组（不是 index）。
    // 第一版写错了这两处，服务端根本没这个事件、也就永远不会回 ack，
    // 于是每个 await 都干等 8 秒超时——200 人就是 26 分钟，脚本看起来像死了。
    const r = await emit(socks[i], 'student:vote', { indexes: [i % 4] });
    if (!r || r.ok === false) voteFail++;
    voteMs.push(Date.now() - a);
    if ((i + 1) % 50 === 0) console.log(`     ${i + 1}/${socks.length} 已投票 · 累计 ${((Date.now() - tv) / 1000).toFixed(1)}s`);
  }
  const voteTotal = Date.now() - tv;
  await wait(1200);
  console.log(`     全员投票耗时 ${(voteTotal / 1000).toFixed(1)}s · 单次 p95=${pct(voteMs, 0.95)}ms max=${Math.max(...voteMs)}ms`);
  check(`投票全部被接受（${socks.length} 票）`, voteFail === 0, `被拒 ${voteFail} 票`);
  check('投票 p95 在 1s 内', pct(voteMs, 0.95) < 1000, `p95=${pct(voteMs, 0.95)}ms`);
  check('票数广播已触达大屏', updates > 0, `收到 ${updates} 次更新`);

  // 核对票数真的记进去了（不是只回了 ack）。
  // 不能查 /api/room/:code ——那个接口只给 online/total，不含活动数据。
  // 新开一个大屏连接，它的加入 ack 会带上完整活动状态。
  const probe = await connect();
  const wr = await emit(probe, 'wall:join', { code });
  const opts = (wr && wr.state && wr.state.activity && wr.state.activity.options) || [];
  const votes = opts.reduce((n, o) => n + (o.count || 0), 0);
  probe.close();
  check(`${N} 票全部入账`, votes === N, `实际 ${votes} 票 · 分布 ${opts.map((o) => o.count).join('/')}`);

  const csv = await fetch(`${BASE}/api/room/${code}/export.csv`).then((r) => r.text());
  const lines = csv.trim().split('\n').slice(1);
  check(`名单完整 ${N} 人`, lines.length === N, `${lines.length}`);

  /* ---------- 4. 资源占用 ---------- */
  console.log('\n[4] 资源占用');
  const mem = process.memoryUsage();
  const hz = await memOf();
  console.log(`     压测客户端 RSS ${(mem.rss / 1024 / 1024).toFixed(0)}MB（含 ${N} 个 socket，不代表服务端）`);
  if (hz) console.log(`     服务端在线房间数 ${hz.rooms} · 已运行 ${hz.uptime.toFixed(0)}s`);
  check('压测客户端自身没爆内存', mem.rss < 1024 * 1024 * 1024, `${(mem.rss / 1024 / 1024).toFixed(0)}MB`);

  /* ---------- 收尾 ---------- */
  await emit(ctl, 'poll:stop', {});
  socks.forEach((s) => s.close());
  wall.close();
  ctl.close();

  console.log(`\n${'='.repeat(46)}`);
  console.log(`${N} 人压测：通过 ${pass} · 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\n测试自身出错：', e);
  process.exit(1);
});
