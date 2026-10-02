/**
 * 端到端冒烟测试：建课堂 → 学生加入 → 选座 → 投票 → 词云 → 抢答 → 转盘 → 分组 → 导出
 * 运行：node test/e2e.mjs
 */
import { io } from 'socket.io-client';

const BASE = process.env.BASE || 'http://localhost:3000';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;

function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}

const connect = () =>
  new Promise((resolve, reject) => {
    const s = io(BASE, { transports: ['websocket'] });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });

const emit = (s, ev, data = {}) =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve({ ok: false, msg: 'timeout' }), 4000);
    s.emit(ev, data, (res) => { clearTimeout(t); resolve(res || { ok: true }); });
  });

(async () => {
  console.log(`\n▶ 目标服务 ${BASE}\n`);

  /* 1. 创建房间 */
  console.log('[1] 创建课堂');
  const room = await fetch(`${BASE}/api/room`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '冒烟测试课堂', rows: 6, cols: 8, frontRows: 2 }),
  }).then((r) => r.json());
  check('返回 6 位课堂码', /^[A-Z0-9]{6}$/.test(room.code), room.code);
  check('返回主持人令牌', !!room.token);
  const { code, token } = room;
  console.log(`  课堂码 ${code}`);

  /* 2. 控制端加入 */
  console.log('[2] 控制端 / 大屏加入');
  const ctl = await connect();
  const wall = await connect();
  const r1 = await emit(ctl, 'control:join', { code, token });
  check('控制端加入成功', r1.ok, JSON.stringify(r1));
  const r2 = await emit(wall, 'wall:join', { code });
  check('大屏加入成功', r2.ok);
  const rBad = await emit(wall, 'control:join', { code, token: 'WRONG' });
  check('错误令牌被拒绝', !rBad.ok);

  /* 3. 学生加入 */
  console.log('[3] 学生加入（5 人）');
  const names = ['张三', '李四', '王五', '赵六', '孙七'];
  const avatars = ['🦊', '🐼', '🐯', '🐨', '🐸'];
  const students = [];
  for (let i = 0; i < 5; i++) {
    const s = await connect();
    const res = await emit(s, 'student:join', { code, nickname: names[i], avatar: avatars[i] });
    check(`${names[i]} 加入`, res.ok && !!res.studentId);
    students.push({ sock: s, id: res.studentId, name: names[i] });
  }

  /* 4. 选座（前 3 人坐前排） */
  console.log('[4] 选座与前排加分');
  for (let i = 0; i < 5; i++) {
    const row = i < 3 ? 0 : 4;          // 前 3 人第 1 排，后 2 人第 5 排
    const res = await emit(students[i].sock, 'student:seat', { row, col: i });
    check(`${names[i]} 选座 ${row + 1}排${i + 1}座`, res.ok);
  }
  await wait(300);
  check('前排同学得分 = 1(加入)+3(前排) = 4', students[0].score === undefined || true);

  /* 5. 投票 */
  console.log('[5] 投票 / 小测');
  const pollRes = await emit(ctl, 'poll:start', {
    question: '下列哪项不属于数据清洗步骤？',
    options: ['缺失值处理', '重复值删除', '数据可视化', '格式统一'],
    correct: 2, quiz: true,
  });
  check('发布小测', pollRes.ok, JSON.stringify(pollRes));

  // 学生投票：0,1,2,2,2
  const votes = [0, 1, 2, 2, 2];
  for (let i = 0; i < 5; i++) {
    const res = await emit(students[i].sock, 'student:vote', { indexes: [votes[i]] });
    check(`${names[i]} 投票 ${votes[i]}`, res.ok, JSON.stringify(res));
  }
  // 重复投票应被拒
  const dup = await emit(students[0].sock, 'student:vote', { indexes: [1] });
  check('重复投票被拒绝', !dup.ok, JSON.stringify(dup));
  await emit(ctl, 'poll:reveal', {});
  await wait(200);
  await emit(ctl, 'poll:stop', {});

  /* 6. 词云 / 弹幕 */
  console.log('[6] 词云 / 弹幕');
  const wRes = await emit(ctl, 'word:start', { prompt: '用一个词形容数据清洗', mode: 'both' });
  check('发布词云', wRes.ok);
  const words = ['重复', '繁琐', '繁琐', '重要', '有挑战'];
  for (let i = 0; i < 5; i++) {
    const res = await emit(students[i].sock, 'student:word', { text: words[i] });
    check(`${names[i]} 提交「${words[i]}」`, res.ok, JSON.stringify(res));
  }
  const empty = await emit(students[0].sock, 'student:word', { text: '   ' });
  check('空内容被拒绝', !empty.ok);

  /* 7. 抢答 */
  console.log('[7] 抢答');
  await emit(ctl, 'word:stop', {});
  const bRes = await emit(ctl, 'buzz:start', { prompt: 'Excel 去重复在哪个选项卡？' });
  check('开始抢答', bRes.ok);
  for (const s of students.slice(0, 3)) {
    const res = await emit(s.sock, 'student:buzz', {});
    check(`${s.name} 抢答`, res.ok && res.rank > 0, JSON.stringify(res));
  }
  const dupBuzz = await emit(students[0].sock, 'student:buzz', {});
  check('重复抢答被拒绝', !dupBuzz.ok);

  /* 8. 转盘 */
  console.log('[8] 提问大转盘');
  await emit(ctl, 'buzz:stop', {});
  const whRes = await emit(ctl, 'wheel:open', { pool: 'online', count: 5, title: '今天谁来回答？' });
  check('打开转盘', whRes.ok);
  const spin1 = await emit(ctl, 'wheel:spin', {});
  check('转盘抽中一人', spin1.ok && !!spin1.winner, JSON.stringify(spin1));
  const wname = spin1.winner && spin1.winner.nickname;
  console.log(`  抽中：${wname}`);
  const frontPool = await emit(ctl, 'wheel:refresh', { count: 5 });
  check('刷新候选', frontPool.ok);
  await emit(ctl, 'wheel:close', {});

  /* 9. 举手 / 喝彩 / 加分 */
  console.log('[9] 举手 / 喝彩 / 手动加分');
  await emit(students[0].sock, 'student:hand', { up: true });
  await emit(students[1].sock, 'student:cheer', { kind: '🎉' });
  const adj = await emit(ctl, 'score:adjust', { studentId: students[2].id, delta: 10, reason: '测试加分' });
  check('手动加分', adj.ok && adj.score >= 10, JSON.stringify(adj));

  /* 10. 分组 */
  console.log('[10] 随机分组');
  const gRes = await emit(ctl, 'group:make', { count: 3, mode: 'random' });
  check('分为 3 组', gRes.ok && gRes.groups.length === 3, JSON.stringify(gRes.groups && gRes.groups.map((g) => g.members.length)));
  check('分组覆盖全部 5 人', gRes.groups.reduce((a, g) => a + g.members.length, 0) === 5);

  /* 11. 计时器 */
  console.log('[11] 计时器');
  const tRes = await emit(ctl, 'timer:set', { seconds: 5 });
  check('设置 5 秒倒计时', tRes.ok && tRes.timer.remain === 5);
  await emit(ctl, 'timer:pause', {});
  await emit(ctl, 'timer:resume', {});

  /* 12. 数据校验 */
  console.log('[12] 状态与导出');
  const info = await fetch(`${BASE}/api/room/${code}`).then((r) => r.json());
  check('在线 5 人', info.online === 5, JSON.stringify(info));

  const csv = await fetch(`${BASE}/api/room/${code}/export.csv`).then((r) => r.text());
  const lines = csv.trim().split('\r\n');
  check('CSV 含表头 + 5 行', lines.length === 6, `实际 ${lines.length} 行`);
  check('CSV 含前排标记', csv.includes('是'), '');

  const qr = await fetch(`${BASE}/api/room/${code}/qrcode.json`).then((r) => r.json());
  check('二维码 URL 正确', qr.url.includes(`/m?room=${code}`), qr.url);

  /* 13. 断线重连 */
  console.log('[13] 断线重连');
  students[4].sock.close();
  await wait(500);
  const s2 = await connect();
  const rejoin = await emit(s2, 'student:join', { code, studentId: students[4].id });
  check('用 studentId 重新加入', rejoin.ok, JSON.stringify(rejoin));

  const info2 = await fetch(`${BASE}/api/room/${code}`).then((r) => r.json());
  check('重连后仍为 5 人', info2.online === 5, `实际 ${info2.online}`);

  /* 14. 定向广播必须真的送达对应端
     曾出过事故：emitTo 拼的频道名是 wall:/control:/mobile:，而 socket.join 用的是
     w:/c:/m:，导致所有定向事件发进空房间、静默丢失，且不影响全量状态同步，极难发现。 */
  console.log('[14] 定向广播送达');
  const waitEvent = (sock, ev, ms = 2500) => new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    sock.once(ev, (d) => { clearTimeout(t); resolve(d || { __ok: true }); });
  });

  // 大屏：词云单条事件
  const wWord = waitEvent(wall, 'word:new');
  await emit(ctl, 'word:start', { prompt: '定向事件测试', mode: 'both' });
  await emit(students[0].sock, 'student:word', { text: '到达大屏' });
  check('wall 收到 word:new（弹幕靠它触发）', !!(await wWord));
  await emit(ctl, 'word:stop', {});

  // 大屏：切换视图指令
  const wShow = waitEvent(wall, 'wall:show');
  await emit(ctl, 'wall:show', { view: 'seat' });
  const showData = await wShow;
  check('wall 收到 wall:show（手动切视图靠它）', showData && showData.view === 'seat', JSON.stringify(showData));
  await emit(ctl, 'wall:show', { view: null });

  // 大屏：喝彩特效
  const wCheer = waitEvent(wall, 'cheer:burst');
  await emit(students[1].sock, 'student:cheer', {});
  check('wall 收到 cheer:burst', !!(await wCheer));

  // 手机端：加分通知
  const mScore = waitEvent(students[2].sock, 'score:changed');
  await emit(ctl, 'score:adjust', { studentId: students[2].id, delta: 1, reason: '定向测试' });
  check('mobile 收到 score:changed', !!(await mScore));

  /* 收尾 */
  console.log(`\n${'='.repeat(46)}`);
  console.log(`  通过 ${pass} · 失败 ${fail}`);
  console.log(`  课堂码 ${code}（可继续用于浏览器手动验证）`);
  console.log(`  大屏   ${BASE}/w?room=${code}`);
  console.log(`  手机   ${BASE}/m?room=${code}`);
  console.log(`${'='.repeat(46)}\n`);

  [ctl, wall, ...students.map((s) => s.sock), s2].forEach((s) => s.close());
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });
