/**
 * 崩溃恢复验证：课上服务突然挂掉（不是优雅退出），重启后课堂还在不在？
 *
 * 为什么单独测这个：真实的崩溃是 SIGKILL / 断电 / OOM，不会给你机会跑收尾逻辑。
 * 而落盘是 2 秒防抖的，如果最后一次操作后 2 秒内挂掉，那次操作就是丢的。
 * 这个风险在自动化测试里很容易被忽略，因为所有测试都是优雅关进程。
 *
 * 做法：独立端口起一个实例 → 造数据 → SIGKILL 强杀 → 重启 → 断言数据还在。
 *
 * 用法：node test/verify-restart.mjs
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PORT = Number(process.env.TEST_PORT || 3100);
const BASE = `http://127.0.0.1:${PORT}`;
const NODE = process.execPath;
const roomFile = (code) => path.join(ROOT, 'data', 'rooms', `${code}.json`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};

/** 起一个服务实例，等它 healthz 通了再返回 */
async function startServer() {
  const p = spawn(NODE, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stderr.on('data', (d) => {
    const s = String(d);
    if (/EADDRINUSE/.test(s)) console.error('  端口被占用:', PORT);
  });
  for (let i = 0; i < 60; i++) {
    await wait(250);
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) return p;
    } catch { /* 还没起来 */ }
  }
  p.kill('SIGKILL');
  throw new Error(`服务未能在 ${PORT} 端口启动`);
}

const connect = () => new Promise((res, rej) => {
  const s = io(BASE, { transports: ['websocket'] });
  s.on('connect', () => res(s));
  s.on('connect_error', rej);
});
const emit = (s, ev, data = {}) => new Promise((res) => {
  const t = setTimeout(() => res({ ok: false, msg: 'timeout' }), 4000);
  s.emit(ev, data, (r) => { clearTimeout(t); res(r || { ok: true }); });
});

const STOP = async (p) => new Promise((res) => {
  if (!p || p.exitCode !== null) return res();
  p.once('exit', res);
  p.kill('SIGKILL');        // 强杀：不留任何收尾机会
  setTimeout(() => { try { p.kill('SIGKILL'); } catch {} res(); }, 3000);
});

/**
 * 解析导出 CSV。字段一律带引号（"4"），直接 Number('"4"') 会得到 NaN
 * ——曾经因为这个，积分断言实际在拿 null 和 null 比，恒真却什么都没测到。
 */
function parseCsv(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const cells = line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
    rows.push(cells);
  }
  const head = rows.shift() || [];
  const idx = (name) => head.indexOf(name);
  // 累计总积分（跨节保留的，长期成绩）；本次得分（本次课）是另一列。
  const iName = idx('昵称'), iScore = idx('累计总积分'), iSeat = idx('座位'), iFront = idx('是否前排');
  const byName = {};
  for (const r of rows) {
    if (!r[iName]) continue;
    byName[r[iName]] = {
      score: Number(r[iScore]),
      seat: r[iSeat] || '',
      front: (r[iFront] || '').includes('是'),
    };
  }
  return byName;
}

(async () => {
  console.log(`\n▶ 崩溃恢复验证（端口 ${PORT}）\n`);
  let srv = await startServer();
  const created = [];

  try {
    /* ---------- 1. 建课堂、造数据 ---------- */
    console.log('[1] 建立课堂并造数据');
    const room = await fetch(`${BASE}/api/room`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '崩溃恢复测试', rows: 6, cols: 8, frontRows: 2 }),
    }).then((r) => r.json());
    const { code, token } = room;
    created.push(code);
    check('课堂创建成功', /^[A-Z0-9]{6}$/.test(code), code);

    const NAMES = ['周浩然', '林清婉', '陈嘉树', '苏晚晴', '郑亦辰'];
    const socks = [];
    const ids = [];
    for (let i = 0; i < NAMES.length; i++) {
      const s = await connect();
      const r = await emit(s, 'student:join', { code, nickname: NAMES[i], avatar: '🦊' });
      check(`${NAMES[i]} 加入`, !!(r && r.studentId));
      ids.push(r.studentId);
      // 前 3 人坐第一排（前排），后 2 人坐第五排
      await emit(s, 'student:seat', { row: i < 3 ? 0 : 4, col: i });
      socks.push(s);
    }

    const ctl = await connect();
    await emit(ctl, 'control:join', { code, token });

    // 投个票，让统计字段有内容
    await emit(ctl, 'poll:start', {
      question: '数据清洗的第一步？', options: ['去重', '建模', '可视化'], correct: 0, quiz: true,
    });
    await emit(socks[0], 'poll:vote', { index: 0 });
    await emit(socks[1], 'poll:vote', { index: 1 });
    // 手动加分，制造非默认积分
    await emit(ctl, 'score:adjust', { studentId: ids[0], delta: 7, reason: '测试' });
    await emit(ctl, 'score:adjust', { studentId: ids[1], delta: 5, reason: '测试' });

    const before = await fetch(`${BASE}/api/room/${code}`).then((r) => r.json());
    const csvBefore = await fetch(`${BASE}/api/room/${code}/export.csv`).then((r) => r.text());
    check('崩溃前在线 5 人', before.online === 5, `online=${before.online}`);
    const before1 = parseCsv(csvBefore);
    const scoreBefore = {};
    for (const [n, v] of Object.entries(before1)) scoreBefore[n] = v.score;
    check('崩溃前 5 人都在名单里', Object.keys(before1).length === 5, JSON.stringify(before1));
    check('崩溃前积分已生效且各不相同',
      new Set(Object.values(scoreBefore)).size >= 3 && Object.values(scoreBefore).every((v) => Number.isFinite(v)),
      JSON.stringify(scoreBefore));
    console.log(`     积分快照: ${JSON.stringify(scoreBefore)}`);

    /* ---------- 2. 强杀 ---------- */
    console.log('\n[2] SIGKILL 强杀（模拟断电 / OOM，不给收尾机会）');
    // 落盘是 2 秒防抖，这里等够，确保数据在盘上
    await wait(2500);
    socks.forEach((s) => s.close());
    ctl.close();
    await STOP(srv);
    check('进程已被强杀', srv.exitCode !== null || srv.signalCode !== null,
      `exit=${srv.exitCode} signal=${srv.signalCode}`);
    check('快照文件已落盘', fs.existsSync(roomFile(code)), roomFile(code));

    /* ---------- 3. 重启 ---------- */
    console.log('\n[3] 重启服务');
    srv = await startServer();
    const after = await fetch(`${BASE}/api/room/${code}`).then((r) => r.json());
    check('重启后课堂仍在', after && after.code === code, JSON.stringify(after));
    check('重启后名单人数不变', after.total === 5, `total=${after.total}`);
    check('重启后在线归零（连接是内存态）', after.online === 0, `online=${after.online}`);

    const csvAfter = await fetch(`${BASE}/api/room/${code}/export.csv`).then((r) => r.text());
    const after1 = parseCsv(csvAfter);
    const scoreAfter = {}, seatAfter = {}, frontAfter = {};
    for (const [n, v] of Object.entries(after1)) {
      scoreAfter[n] = v.score; seatAfter[n] = v.seat; frontAfter[n] = v.front;
    }
    console.log(`     重启后积分: ${JSON.stringify(scoreAfter)}`);
    check('积分全部保留（逐人比对）',
      NAMES.every((n) => scoreAfter[n] === scoreBefore[n]),
      `${JSON.stringify(scoreBefore)} vs ${JSON.stringify(scoreAfter)}`);
    check('座位全部保留', NAMES.every((n) => !!seatAfter[n]), JSON.stringify(seatAfter));
    check('前排标记保留（前 3 人）',
      NAMES.slice(0, 3).every((n) => frontAfter[n]) && NAMES.slice(3).every((n) => !frontAfter[n]),
      JSON.stringify(frontAfter));

    /* ---------- 4. 老学生重连 ---------- */
    console.log('\n[4] 老同学重新扫码进来，身份和积分认不认');
    const re = await connect();
    const rr = await emit(re, 'student:join', { code, nickname: NAMES[0], avatar: '🦊', studentId: ids[0] });
    check('凭 studentId 重连成功', !!(rr && rr.ok), JSON.stringify(rr));
    check('重连后仍是同一个人', rr && rr.studentId === ids[0], `${rr && rr.studentId} vs ${ids[0]}`);

    const after2 = await fetch(`${BASE}/api/room/${code}`).then((r) => r.json());
    check('重连后在线恢复为 1', after2.online === 1, `online=${after2.online}`);
    check('重连没有造成名单重复', after2.total === 5, `total=${after2.total}`);

    const csv2 = await fetch(`${BASE}/api/room/${code}/export.csv`).then((r) => r.text());
    const reconnected = parseCsv(csv2);
    const kept = reconnected[NAMES[0]] ? reconnected[NAMES[0]].score : null;
    check('重连后积分没被清零', kept === scoreBefore[NAMES[0]], `${kept} vs ${scoreBefore[NAMES[0]]}`);
    re.close();

    /* ---------- 5. 教师的令牌还认不认 ---------- */
    console.log('\n[5] 教师令牌与控制权');
    const ctl2 = await connect();
    const jr = await emit(ctl2, 'control:join', { code, token });
    check('重启后原令牌仍可接管控制台', !!(jr && jr.ok), JSON.stringify(jr));
    const ctlBad = await connect();
    const jrBad = await emit(ctlBad, 'control:join', { code, token: 'WRONGTOKEN' });
    check('错误令牌依然被拒绝', !(jrBad && jrBad.ok), JSON.stringify(jrBad));
    ctlBad.close();
    ctl2.close();

    /* ---------- 6. 换手机 / 清缓存后按昵称认领原身份 ---------- */
    console.log('\n[6] 学生换了手机，凭昵称能不能找回积分');
    // 郑亦辰（第 5 位）此时是离线状态。模拟他换了台手机：没有 studentId，只输昵称。
    const phone = await connect();
    const pr = await emit(phone, 'student:join', { code, nickname: NAMES[4], avatar: '🐼' });
    check('无 studentId 也能加入', !!(pr && pr.ok), JSON.stringify(pr));
    check('认领回了原来的身份（同一个 studentId）',
      pr && pr.studentId === ids[4], `${pr && pr.studentId} vs ${ids[4]}`);

    const csv3 = await fetch(`${BASE}/api/room/${code}/export.csv`).then((r) => r.text());
    const after3 = parseCsv(csv3);
    check('换机后积分没被清零', after3[NAMES[4]] && after3[NAMES[4]].score === scoreBefore[NAMES[4]],
      `${after3[NAMES[4]] && after3[NAMES[4]].score} vs ${scoreBefore[NAMES[4]]}`);
    check('换机后没有产生重名重复条目',
      Object.keys(after3).filter((n) => n === NAMES[4]).length === 1
      && Object.keys(after3).length === 5,
      JSON.stringify(Object.keys(after3)));

    // 关键边界：同名的人还在线时，不能让新人抢走他的身份
    console.log('\n[7] 同名但原主在线时，不能抢身份');
    const impostor = await connect();
    const ir = await emit(impostor, 'student:join', { code, nickname: NAMES[4], avatar: '🐸' });
    check('原主在线时另建新身份', ir && ir.studentId && ir.studentId !== ids[4],
      `${ir && ir.studentId} vs ${ids[4]}`);
    const info7 = await fetch(`${BASE}/api/room/${code}`).then((r) => r.json());
    check('总人数 +1（真的新建了）', info7.total === 6, `total=${info7.total}`);
    impostor.close();
    phone.close();
  } finally {
    /* ---------- 收尾 ---------- */
    await wait(2600);          // 等最后一次防抖落盘，避免删了又被写回
    await STOP(srv);
    for (const c of created) {
      const f = roomFile(c);
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    console.log(`\n  已清理测试房间：${created.join(', ') || '（无）'}`);
  }

  console.log(`\n${'='.repeat(46)}`);
  console.log(`崩溃恢复验证：通过 ${pass} · 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\n测试自身出错：', e);
  process.exit(1);
});
