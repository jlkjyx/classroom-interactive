/**
 * 老快照升级验证：服务器上已经在跑的课堂，快照里没有新版本才有的字段。
 *
 * 为什么单独测这个：这次一口气加了 sessionNo（第几课）、questionBank（题库）、
 * wordBlock（屏蔽词）和 settings.scoreRules（可调分值）。用户的课堂是**已经在
 * 上课的**，data/rooms/*.json 里存的全是旧格式快照。升级代码后服务一重启就要
 * 把这些文件读回来——任何一个新字段没做兜底，就是启动即崩溃，而此时教室里
 * 可能正坐着几十个学生。
 *
 * 分两段：
 *   A. 纯内存：直接 import Room，把一个"旧版 toJSON 产物"喂给 fromJSON，
 *      逐字段验证降级；再验证升级后落盘（toJSON）是新格式。
 *   B. 真实链路：把旧格式快照写进一个临时数据目录，起一个真实服务实例
 *      （独立端口 + DATA_DIR 隔离，不碰真实课堂数据），走 socket 验证
 *      控制端拿到的 sessionNo / questionBank 正确，且能正常开新的一课。
 *
 * 用法：node test/verify-legacy-snapshot.mjs
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';
import { Room } from '../server/state.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PORT = Number(process.env.TEST_PORT || 3110);
const BASE = `http://127.0.0.1:${PORT}`;
const NODE = process.execPath;
const TMP_DIR = path.join(HERE, '.legacy-tmp');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};

/* ------------------------------------------------------------------ */
/* A. 纯内存：旧格式快照的字段降级                                      */
/* ------------------------------------------------------------------ */

/**
 * 模拟"上一版服务端写下的快照"：没有 sessionNo / questionBank / wordBlock，
 * settings 里也没有 scoreRules —— 这是用户服务器上现存的真实形态。
 */
function legacySnapshot() {
  return {
    code: 'OLD123',
    title: '数据整理与清洗实训 · 上学期',
    teacherToken: 'a1b2c3d4e5f6',
    teacherPass: '135790',
    createdAt: 1756000000000,
    seatMap: { rows: 6, cols: 8, frontRows: 2, backRows: 2 },
    settings: {
      allowDanmaku: true,
      allowBuzz: true,
      allowMultiVote: false,
      maxWordLen: 20,
      // 故意不写 scoreRules：旧快照里没有这个字段
    },
    students: [
      {
        id: 1, nickname: '张三', avatar: '🦊', color: '#ff7a59',
        seat: { row: 0, col: 1 }, score: 17, joinedAt: 1756000000000,
        stats: { votes: 3, correct: 2, words: 1, danmaku: 0, buzz: 1, cheers: 0, picked: 2 },
      },
      {
        id: 2, nickname: '李四', avatar: '🐼', color: '#4bb3fd',
        seat: { row: 4, col: 3 }, score: 9, joinedAt: 1756000000100,
        stats: { votes: 2, correct: 0, words: 0, danmaku: 1, buzz: 0, cheers: 0, picked: 0 },
      },
    ],
    history: [{ type: 'poll', question: '上学期的一道题' }],
    log: [{ ts: 1756000000000, text: '课堂创建', kind: 'sys' }],
    nextIdVal: 3,
    // 注意：没有 sessionNo / questionBank / wordBlock / activity / groups
  };
}

console.log('\n▶ 老快照升级验证\n');
console.log('[A] 旧格式快照读入（纯内存）');

const legacy = legacySnapshot();
let r;
try {
  r = Room.fromJSON(legacy);
  check('fromJSON 不抛异常（旧快照能被读回来）', true);
} catch (e) {
  check('fromJSON 不抛异常（旧快照能被读回来）', false, e.message);
  console.log(`\n  旧快照直接读崩了，后面的断言没有意义：${e.stack}\n`);
  process.exit(1);
}

check('课次默认为第 1 课（旧快照没有 sessionNo）', r.sessionNo === 1, String(r.sessionNo));
check('题库默认为空数组而不是 undefined',
  Array.isArray(r.questionBank) && r.questionBank.length === 0, JSON.stringify(r.questionBank));
check('屏蔽词表默认为空数组', Array.isArray(r.wordBlock) && r.wordBlock.length === 0);
check('学生名单读回来了（2 人）', r.students.size === 2, String(r.students.size));

const zhang = r.students.get(1);
check('老学生的积分保留（张三 17 分）', zhang && zhang.score === 17, zhang && String(zhang.score));
check('老学生的座位保留（1排2座）',
  zhang && zhang.seat && zhang.seat.row === 0 && zhang.seat.col === 1,
  JSON.stringify(zhang && zhang.seat));

/* 分值降级：settings 里没有 scoreRules，必须回落到常量而不是 NaN */
console.log('\n[A2] 分值读取降级（旧快照没有 settings.scoreRules）');
check('前排加分回落到默认 3 分', r.scoreRule('seatFront') === 3, String(r.scoreRule('seatFront')));
check('前排奖励按钮分值回落到默认 2 分', r.scoreRule('frontReward') === 2, String(r.scoreRule('frontReward')));
check('抢答第一名回落到默认 5 分', r.scoreRule('buzz1') === 5, String(r.scoreRule('buzz1')));
check('答对回落到默认 2 分', r.scoreRule('voteCorrect') === 2, String(r.scoreRule('voteCorrect')));
check('抢答判定答对回落到默认 5 分', r.scoreRule('buzzCorrect') === 5, String(r.scoreRule('buzzCorrect')));
check('抢答判定答错回落到默认 -2 分', r.scoreRule('buzzWrong') === -2, String(r.scoreRule('buzzWrong')));
check('转盘答对回落到默认 3 分', r.scoreRule('wheelCorrect') === 3, String(r.scoreRule('wheelCorrect')));
check('转盘答错回落到默认 0 分', r.scoreRule('wheelWrong') === 0, String(r.scoreRule('wheelWrong')));
check('所有分值都是有限数字（没有 NaN 漏出去）',
  ['join', 'seatFront', 'seatBack', 'vote', 'voteCorrect', 'word', 'danmaku', 'buzz1', 'buzz2', 'buzz3', 'handPicked', 'cheer', 'frontReward',
   'buzzCorrect', 'buzzWrong', 'wheelCorrect', 'wheelWrong']
    .every((k) => Number.isFinite(r.scoreRule(k))));

/* 新功能在老房间上要能直接用 */
console.log('\n[A3] 新功能在老房间上立即可用');
const before = { score: zhang.score, seat: { ...zhang.seat } };
const no = r.newSession();
check('老房间能开新的一课，课次变 2', no === 2 && r.sessionNo === 2, `${no}/${r.sessionNo}`);
check('开新一课后积分保留（这是"继承"的意义）', r.students.get(1).score === before.score,
  `${r.students.get(1).score} vs ${before.score}`);
// 2026-09 新需求：座位每节课会变（按小组坐 / 换教室），新一课要清空而不是保留
check('开新一课后座位清空（教室座位每节课可能变）', r.students.get(1).seat == null);
check('开新一课后本次得分清零、总积分保留',
  r.students.get(1).sessionScore === 0 && r.students.get(1).score === before.score);
check('开新一课后活动记录清空', r.history.length === 0);
check('开新一课后分组清空', r.groups.length === 0);

r.startPoll({ question: '老房间发起的投票', options: ['甲', '乙'] });
check('老房间能正常发起投票', !!r.activity && r.activity.type === 'poll');
const paused = r.pauseActivity();
check('老房间能暂停活动', !!paused && r.activity.paused === true && r.activity.open === false,
  JSON.stringify({ paused: !!paused, open: r.activity && r.activity.open }));
const resumed = r.resumeActivity();
check('老房间能恢复活动', !!resumed && r.activity.open === true && !r.activity.paused);

/* 升级后落盘必须是新格式，否则下次启动又会走一遍降级 */
console.log('\n[A4] 升级后落盘（toJSON 必须带新字段）');
const out = r.toJSON();
check('toJSON 带 sessionNo', out.sessionNo === 2, String(out.sessionNo));
check('toJSON 带 questionBank（数组）', Array.isArray(out.questionBank));
check('toJSON 带 wordBlock（数组）', Array.isArray(out.wordBlock));
check('toJSON 的 settings 带 scoreRules', !!(out.settings && out.settings.scoreRules),
  JSON.stringify(out.settings && Object.keys(out.settings)));

const r2 = Room.fromJSON(out);
check('toJSON → fromJSON 往返后课次不丢', r2.sessionNo === 2, String(r2.sessionNo));
check('往返后积分不丢', r2.students.get(1).score === before.score,
  String(r2.students.get(1) && r2.students.get(1).score));
check('往返后分值仍是数字（不是 undefined）', r2.scoreRule('seatFront') === 3, String(r2.scoreRule('seatFront')));

/* ------------------------------------------------------------------ */
/* B. 真实链路：临时数据目录 + 独立端口起一个真实服务                    */
/* ------------------------------------------------------------------ */

console.log('\n[B] 真实服务加载旧快照（DATA_DIR 隔离，不碰真实课堂数据）');

// 临时目录必须清空重建：残留的旧文件会让这一轮测的其实是上一轮的数据
fs.rmSync(TMP_DIR, { recursive: true, force: true });
fs.mkdirSync(path.join(TMP_DIR, 'rooms'), { recursive: true });
fs.writeFileSync(
  path.join(TMP_DIR, 'rooms', 'OLD123.json'),
  JSON.stringify(legacySnapshot(), null, 2),
  'utf8',
);

const connect = () => new Promise((res, rej) => {
  const s = io(BASE, { transports: ['websocket'] });
  s.on('connect', () => res(s));
  s.on('connect_error', rej);
});
const emit = (s, ev, data = {}) => new Promise((res) => {
  const t = setTimeout(() => res({ ok: false, msg: 'timeout' }), 4000);
  s.emit(ev, data, (ack) => { clearTimeout(t); res(ack || { ok: true }); });
});
/** 等一帧服务端推来的 state（带硬超时，别让测试永远悬着） */
const nextState = (s, ms = 4000) => new Promise((res) => {
  const t = setTimeout(() => res(null), ms);
  s.once('state', (st) => { clearTimeout(t); res(st); });
});

let server = null;
try {
  server = spawn(NODE, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: TMP_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  server.stderr.on('data', (d) => { err += String(d); });

  let up = false;
  for (let i = 0; i < 60; i++) {
    await wait(250);
    try {
      const h = await fetch(`${BASE}/healthz`).then((x) => x.json());
      if (h.ok) { up = true; break; }
    } catch { /* 还没起来 */ }
  }
  if (!up) throw new Error(`服务未能在 ${PORT} 端口启动\n${err}`);

  const health = await fetch(`${BASE}/healthz`).then((x) => x.json());
  check('临时实例持久化可用（persistent=true）', health.persistent === true, JSON.stringify(health));

  const ctl = await connect();
  const joined = await emit(ctl, 'control:join', { code: 'OLD123', token: 'a1b2c3d4e5f6' });
  check('用旧快照里的令牌能进控制端', joined && joined.ok === true, JSON.stringify(joined));

  const st1 = await nextState(ctl);
  check('服务端推来的 state 不是 null', !!st1);
  check('控制端看到第 1 课（旧快照没有课次）', st1 && st1.sessionNo === 1, String(st1 && st1.sessionNo));
  check('控制端看到空题库（不是 undefined）',
    st1 && Array.isArray(st1.questionBank) && st1.questionBank.length === 0,
    JSON.stringify(st1 && st1.questionBank));
  check('控制端拿到分值规则', !!(st1 && st1.settings && st1.settings.scoreRules),
    JSON.stringify(st1 && st1.settings && Object.keys(st1.settings)));
  // 控制端视图里学生列表叫 students，排行榜叫 leaderboard，没有 rank 这个字段
  check('老学生的积分在控制端可见（张三 17 分）',
    !!(st1 && st1.students && st1.students.some((x) => x.nickname === '张三' && x.score === 17)),
    JSON.stringify(st1 && st1.students && st1.students.map((x) => `${x.nickname}:${x.score}`)));

  const ns = await emit(ctl, 'room:newSession', {});
  check('真实链路上能开新的一课', ns && ns.ok === true && ns.sessionNo === 2, JSON.stringify(ns));
  const st2 = await nextState(ctl);
  check('开课后控制端课次同步为 2', st2 && st2.sessionNo === 2, String(st2 && st2.sessionNo));
  check('开课后积分仍然在（继承生效）',
    !!(st2 && st2.students && st2.students.some((x) => x.nickname === '张三' && x.score === 17)),
    JSON.stringify(st2 && st2.students && st2.students.map((x) => `${x.nickname}:${x.score}`)));

  // 题库在老房间上也能用：加一题再读回来
  const added = await emit(ctl, 'bank:add', {
    type: 'poll', question: '老房间新增的题', options: ['甲', '乙'],
  });
  check('老房间能往题库加题', added && added.ok === true, JSON.stringify(added && added.msg));
  const st3 = await nextState(ctl);
  check('题库内容同步回控制端',
    !!(st3 && st3.questionBank && st3.questionBank.some((q) => q.question === '老房间新增的题')),
    JSON.stringify(st3 && st3.questionBank && st3.questionBank.map((q) => q.question)));

  ctl.close();
} catch (e) {
  check('真实链路这一段执行完毕', false, e.message);
} finally {
  if (server) {
    server.kill('SIGKILL');
    await new Promise((res) => setTimeout(res, 400));
  }
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
}

console.log(`\n${'='.repeat(46)}`);
console.log(`  通过 ${pass} · 失败 ${fail}`);
console.log(`${'='.repeat(46)}\n`);
process.exit(fail ? 1 : 0);
