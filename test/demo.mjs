/**
 * 演示数据脚本：建一个房间，加入 14 个同学并选座，
 * 然后按 test/step.txt 的内容切换大屏状态，方便逐状态截图。
 * 用法：node test/demo.mjs
 */
import { io } from 'socket.io-client';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'http://localhost:3000';
const STEP_FILE = path.join(HERE, 'step.txt');
const OUT_FILE = path.join(HERE, 'demo-room.json');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const connect = () => new Promise((res, rej) => { const s = io(BASE, { transports: ['websocket'] }); s.on('connect', () => res(s)); s.on('connect_error', rej); });
const emit = (s, ev, d = {}) => new Promise((res) => { const t = setTimeout(() => res({ ok: false }), 4000); s.emit(ev, d, (r) => { clearTimeout(t); res(r || { ok: true }); }); });

const NAMES = ['张明远', '李思彤', '王雨桐', '赵子涵', '孙佳怡', '周浩然', '吴欣妍', '郑博文',
  '冯诗涵', '陈嘉树', '褚一诺', '卫子墨', '蒋雨泽', '沈梦琪'];
const AVATARS = ['🦊', '🐼', '🐯', '🐨', '🐸', '🐵', '🐧', '🐙', '🦁', '🐷', '🐮', '🐔', '🐳', '🦄'];
const WORDS = ['繁琐', '繁琐', '繁琐', '重要', '重复劳动', '有成就感', '耐心', '细心', '繁琐',
  '数据质量', '有意思', '要动脑', '像侦探', '基础'];
const VOTES = [2, 2, 2, 2, 2, 2, 0, 1, 2, 2, 3, 2, 2, 2];

(async () => {
  const room = await fetch(`${BASE}/api/room`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '数据整理与清洗实训 · 第 1 讲', rows: 6, cols: 8, frontRows: 2 }),
  }).then((r) => r.json());

  fs.writeFileSync(OUT_FILE, JSON.stringify(room, null, 2));
  console.log('房间已创建:', room.code);

  const ctl = await connect();
  await emit(ctl, 'control:join', { code: room.code, token: room.token });

  const stus = [];
  for (let i = 0; i < NAMES.length; i++) {
    const s = await connect();
    const r = await emit(s, 'student:join', { code: room.code, nickname: NAMES[i], avatar: AVATARS[i] });
    stus.push({ sock: s, id: r.studentId, name: NAMES[i] });
  }
  // 前 8 人坐前排（1-2 排），后 6 人坐后排
  for (let i = 0; i < stus.length; i++) {
    const row = i < 8 ? i % 2 : 3 + (i % 3);
    await emit(stus[i].sock, 'student:seat', { row, col: i % 8 });
  }
  await wait(400);

  // 举手 + 喝彩
  await emit(stus[0].sock, 'student:hand', { up: true });
  await emit(stus[3].sock, 'student:hand', { up: true });
  await emit(stus[6].sock, 'student:hand', { up: true });

  fs.writeFileSync(STEP_FILE, 'idle');
  let step = 'idle';

  async function apply(next) {
    if (next === step) return;
    step = next;
    console.log('  → 切换到', next);
    if (next === 'idle') {
      await emit(ctl, 'poll:stop', {}); await emit(ctl, 'word:stop', {});
      await emit(ctl, 'buzz:stop', {}); await emit(ctl, 'wheel:close', {});
      await emit(ctl, 'group:clear', {}); await emit(ctl, 'wall:show', { view: null });
    }
    if (next === 'poll') {
      await emit(ctl, 'poll:start', {
        question: '下面哪一项不属于数据清洗的常规步骤？',
        options: ['缺失值处理', '重复值删除', '数据可视化', '格式统一', '异常值识别'],
        correct: 2, quiz: true,
      });
      for (let i = 0; i < 12; i++) await emit(stus[i].sock, 'student:vote', { indexes: [VOTES[i]] });
    }
    if (next === 'word') {
      await emit(ctl, 'word:start', { prompt: '用一个词形容你眼中的「数据清洗」', mode: 'both' });
      for (let i = 0; i < WORDS.length; i++) {
        await emit(stus[i].sock, 'student:word', { text: WORDS[i] });
        await wait(220);
      }
    }
    if (next === 'wheel') {
      await emit(ctl, 'wheel:open', { pool: 'online', count: 8, title: '今天谁来回答？' });
    }
    if (next === 'wheelspin') {
      await emit(ctl, 'wheel:spin', {});
      setTimeout(() => fs.writeFileSync(STEP_FILE, 'wheelspin'), 10);
    }
    if (next === 'buzz') {
      await emit(ctl, 'buzz:start', { prompt: 'Power Query 在哪一个选项卡里？' });
      for (let i = 0; i < 3; i++) { await emit(stus[i].sock, 'student:buzz', {}); await wait(350); }
    }
    if (next === 'seat') {
      await emit(ctl, 'wall:show', { view: 'seat' });
    }
    if (next === 'group') {
      await emit(ctl, 'group:make', { count: 5, mode: 'front' });
    }
  }

  console.log('就绪。修改 test/step.txt 可切换状态：idle | poll | word | wheel | wheelspin | buzz | seat | group');
  while (true) {
    await wait(600);
    let cur;
    try { cur = fs.readFileSync(STEP_FILE, 'utf8').trim(); } catch { cur = 'idle'; }
    if (cur === 'wheelspin' && step !== 'wheelspin') await apply(cur);
    else if (cur !== 'wheelspin') await apply(cur);
  }
})();
