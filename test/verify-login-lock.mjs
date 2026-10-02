/**
 * 控制端登录限速验证：防暴力猜口令。
 *
 * 场景：6 位口令只有 100 万种组合，课堂码又公开挂在大屏上，不限制的话
 * 学生能脚本穷举顶进控制端。本测试验证：连续错误口令会进入冷却、冷却期内
 * 即便口令正确也被拒、冷却结束才放行。
 *
 * 运行：先启动服务（npm start），再 `node test/verify-login-lock.mjs`。
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

  // 1. 建一个带固定口令的课堂
  console.log('[1] 创建课堂');
  const room = await fetch(`${BASE}/api/room`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '限速测试', rows: 6, cols: 8, frontRows: 2, teacherPass: '123456' }),
  }).then((r) => r.json());
  check('创建课堂成功', !!room.code, JSON.stringify(room));
  check('口令按指定值生效', room.pass === '123456', room.pass);
  const { code } = room;

  // 2. 连续用错误口令试探
  console.log('[2] 连续错误口令');
  const s = await connect();
  let lockedAt = -1;
  for (let i = 1; i <= 4; i++) {
    const r = await emit(s, 'control:join', { code, pass: '000000' });
    if (r.locked) { lockedAt = i; console.log(`  第 ${i} 次触发冷却：${r.msg}`); break; }
    check(`第 ${i} 次错误口令被拒绝`, r.ok === false);
  }
  check('连续失败后进入冷却', lockedAt >= 3, `lockedAt=${lockedAt}`);

  // 3. 冷却期内，即使口令正确也被拒（否则限速形同虚设）
  console.log('[3] 冷却期内正确口令也被拒');
  const correct = await emit(s, 'control:join', { code, pass: '123456' });
  check('正确口令在冷却期内被锁', correct.ok === false && correct.locked === true, JSON.stringify(correct));

  // 4. 冷却结束后，正确口令放行
  console.log('[4] 冷却结束后放行（等待约 6 秒）');
  await wait(6000);
  const ok = await emit(s, 'control:join', { code, pass: '123456' });
  check('冷却结束后正确口令进入', ok.ok === true, JSON.stringify(ok));

  s.close();
  console.log(`\n============== 结果：${pass} 通过 / ${fail} 失败 ==============`);
  process.exit(fail ? 1 : 0);
})();
