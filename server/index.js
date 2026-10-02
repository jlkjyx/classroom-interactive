/**
 * 课堂实时互动系统 · 服务端
 * Express + Socket.IO，零数据库依赖，房间数据以 JSON 快照持久化。
 */
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import QRCode from 'qrcode';
import { Room, genRoomCode, AVATARS, COLORS, SCORE_RULES } from './state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
// 默认仍是项目下的 data/，行为与之前完全一致；允许 env 覆盖是为了让持久化类
// 的回归测试能在一个临时目录里跑，不去碰真实课堂的快照文件。
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const ROOMS_DIR = path.join(DATA_DIR, 'rooms');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_BASE = process.env.PUBLIC_BASE || ''; // 例如 https://class.example.com

/**
 * 数据目录可用性检查。
 *
 * 为什么必须容错：容器以非 root 用户（node，uid 1000）运行，而通过
 * bind mount 挂进来的宿主目录往往是 root 建的、权限 755。此时建子目录
 * 会直接抛 EACCES——如果不接住，进程会在启动阶段就崩掉，连首页都打不开，
 * 而报错信息（"EACCES: permission denied"）又离真正的病因（卷权限）很远，
 * 排查起来很费劲。
 *
 * 所以这里降级处理：目录不可写时打印醒目警告并继续以「纯内存模式」运行，
 * 课照样能上，只是重启后数据不保留。总比整个服务起不来强。
 */
let PERSISTENT = true;
function initDataDir() {
  try {
    fs.mkdirSync(ROOMS_DIR, { recursive: true });
  } catch (e) {
    PERSISTENT = false;
    console.error(`\n  [警告] 数据目录不可写，将以「纯内存模式」运行：${e.message}`);
    console.error(`         课堂可以正常上，但服务重启后积分/座位数据不保留。`);
    console.error(`         修复：把宿主目录属主改成容器用户，例如`);
    console.error(`           chown -R 1000:1000 ./data`);
    console.error(`         或改用 Docker 命名卷（自动匹配镜像内的属主）。\n`);
    return;
  }
  // mkdirSync 成功不代表能写：目录可能存在但只读，这里做一次真实的写探测
  try {
    const probe = path.join(ROOMS_DIR, '.write-probe');
    fs.writeFileSync(probe, 'ok', 'utf8');
    fs.unlinkSync(probe);
  } catch (e) {
    PERSISTENT = false;
    console.error(`\n  [警告] 数据目录只读，将以「纯内存模式」运行：${e.message}`);
    console.error(`         修复：chown -R 1000:1000 ./data 或改用 Docker 命名卷。\n`);
  }
}
initDataDir();

/* ---------------- 房间仓库 ---------------- */

const rooms = new Map(); // code -> Room

function roomFile(code) {
  return path.join(ROOMS_DIR, `${code}.json`);
}

function loadRooms() {
  if (!PERSISTENT) return;   // 目录不可写时 readdir 也会失败，没必要再刷一条错误
  try {
    for (const f of fs.readdirSync(ROOMS_DIR)) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(ROOMS_DIR, f), 'utf8'));
        const r = Room.fromJSON(raw);
        rooms.set(r.code, r);
      } catch (e) {
        console.warn('[load] 跳过损坏的房间文件', f, e.message);
      }
    }
    console.log(`[load] 已恢复 ${rooms.size} 个房间`);
  } catch (e) {
    console.warn('[load] 读取房间目录失败', e.message);
  }
}

const writeTimers = new Map();
function scheduleSave(room) {
  // 不可写时直接跳过：否则每次状态变化都会 2 秒后刷一条 EACCES，
  // 一节课下来日志能刷几千行，反而把真正的报错淹掉。
  if (!PERSISTENT || writeTimers.has(room.code)) return;
  writeTimers.set(
    room.code,
    setTimeout(() => {
      writeTimers.delete(room.code);
      try {
        fs.writeFileSync(roomFile(room.code), JSON.stringify(room.toJSON(), null, 2), 'utf8');
      } catch (e) {
        console.error('[save] 写入失败', room.code, e.message);
      }
    }, 2000)
  );
}

function createRoom(opts = {}) {
  let code;
  do {
    code = genRoomCode(6);
  } while (rooms.has(code));
  const room = new Room(code, {
    ...opts,
    teacherToken: genRoomCode(12),
    // 教师口令：6 位数字，好记好念，老师换设备/换浏览器时凭它进入控制端。
    // 没显式指定就自动生成；口令和 token 是两套独立凭证，任一匹配都可进。
    teacherPass: /^\d{6}$/.test(String(opts.teacherPass || '')) ? opts.teacherPass : String(Math.floor(100000 + Math.random() * 900000)),
  });
  rooms.set(code, room);
  bindRoom(room);
  room.touch('create');
  return room;
}

function getRoom(code) {
  return rooms.get(String(code || '').toUpperCase());
}

/* ---------------- Express ---------------- */

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: 15000,
  pingTimeout: 30000,
  maxHttpBufferSize: 1e6,
});

app.use(express.json({ limit: '2mb' }));
app.use(
  express.static(PUBLIC_DIR, {
    setHeaders(res) {
      res.setHeader('Cache-Control', 'no-cache');
    },
  })
);

/**
 * 推算对外的访问基址（决定二维码里的内容）。
 *
 * 经过 WAF / CDN / 反向代理时，X-Forwarded-Host 常被多级代理追加成
 * "a.com, b.com" 这样的逗号列表，取第一段才是客户端真正访问的地址；
 * 不 split 的话二维码会指向一长串乱七八糟的东西。
 */
function baseUrl(req) {
  if (PUBLIC_BASE) return PUBLIC_BASE.replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return `${proto}://${host}`;
}

/** 供 /healthz 诊断：二维码到底会指向哪儿、这个值是怎么来的 */
function baseUrlSource(req) {
  if (PUBLIC_BASE) return 'env';
  if (req.headers['x-forwarded-host']) return 'x-forwarded-host';
  return 'host';
}

// 创建课堂（控制端调用）
app.post('/api/room', (req, res) => {
  const { title, rows, cols, frontRows, teacherPass } = req.body || {};
  const room = createRoom({ title, rows, cols, frontRows, teacherPass });
  res.json({
    code: room.code,
    token: room.teacherToken,
    pass: room.teacherPass,
    title: room.title,
  });
});

// 房间简要信息
app.get('/api/room/:code', (req, res) => {
  const room = getRoom(req.params.code);
  if (!room) return res.status(404).json({ error: '课堂不存在' });
  res.json({
    code: room.code,
    title: room.title,
    online: room.onlineStudents().length,
    total: room.students.size,
    createdAt: room.createdAt,
  });
});

// 加入二维码（学生手机扫码）
app.get('/api/room/:code/qrcode.png', async (req, res) => {
  const room = getRoom(req.params.code);
  if (!room) return res.status(404).send('room not found');
  const url = `${baseUrl(req)}/m?room=${room.code}`;
  try {
    const buf = await QRCode.toBuffer(url, {
      width: 640,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#0B1020', light: '#FFFFFF' },
    });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    res.send(buf);
  } catch (e) {
    res.status(500).send('qrcode error');
  }
});

// 二维码数据（含 URL，便于前端自绘）
app.get('/api/room/:code/qrcode.json', async (req, res) => {
  const room = getRoom(req.params.code);
  if (!room) return res.status(404).json({ error: '课堂不存在' });
  const url = `${baseUrl(req)}/m?room=${room.code}`;
  const dataUrl = await QRCode.toDataURL(url, { width: 512, margin: 1, color: { dark: '#0B1020', light: '#FFFFFF' } });
  res.json({ url, dataUrl });
});

// 导出积分 CSV（Excel 可直接打开）
app.get('/api/room/:code/export.csv', (req, res) => {
  const room = getRoom(req.params.code);
  if (!room) return res.status(404).send('room not found');
  // 「本次得分」单独一列：老师登记平时分时往往既看这节课的表现，
  // 也要看整学期的累计，两个数混在一起就都没法用了。
  const rows = [
    ['排名', '昵称', '头像', '本次得分', '累计总积分', '座位', '是否前排', '投票次数', '答对次数', '发言次数', '抢答次数', '被点名次数', '加入时间'],
  ];
  [...room.students.values()]
    .sort((a, b) => b.score - a.score || a.joinedAt - b.joinedAt)
    .forEach((s, i) => {
      const front = room.isFrontSeat(s.seat);
      rows.push([
        i + 1,
        s.nickname,
        s.avatar,
        Number(s.sessionScore) || 0,
        s.score,
        s.seat ? `${s.seat.row + 1}排${s.seat.col + 1}座` : '未选座',
        front ? '是' : '否',
        s.stats.votes,
        s.stats.correct,
        s.stats.words,
        s.stats.buzz,
        s.stats.picked,
        new Date(s.joinedAt).toLocaleString('zh-CN'),
      ]);
    });
  const csv = '\uFEFF' + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="classroom-${room.code}.csv"`);
  res.send(csv);
});

// 导出活动记录 CSV（投票/词云明细）
app.get('/api/room/:code/export-activities.csv', (req, res) => {
  const room = getRoom(req.params.code);
  if (!room) return res.status(404).send('room not found');
  const rows = [['活动编号', '类型', '题目/提示', '开始时间', '明细']];
  const typeName = { poll: '投票', quiz: '小测', word: '词云/弹幕', buzz: '抢答', wheel: '转盘' };
  for (const a of room.history) {
    let detail = '';
    if (a.options) {
      detail = a.options.map((o, i) => `${String.fromCharCode(65 + i)}.${o.text}=${o.count}票`).join(' | ');
    } else if (a.items) {
      detail = a.items.map((i) => i.text).join(' | ');
    } else if (a.ranks) {
      detail = a.ranks.map((r, i) => `${i + 1}.${r.studentId}`).join(' | ');
    }
    rows.push([a.id, typeName[a.type] || a.type, a.question || a.prompt || a.title || '', new Date(a.startedAt).toLocaleString('zh-CN'), detail]);
  }
  const csv = '\uFEFF' + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="activities-${room.code}.csv"`);
  res.send(csv);
});

// 常量下发
app.get('/api/meta', (req, res) => {
  res.json({ avatars: AVATARS, colors: COLORS, scoreRules: SCORE_RULES });
});

// 房间列表（运维用，可用环境变量关闭）
app.get('/api/rooms', (req, res) => {
  if (process.env.DISABLE_ROOM_LIST === '1') return res.status(403).json({ error: 'disabled' });
  res.json(
    [...rooms.values()].map((r) => ({
      code: r.code,
      title: r.title,
      online: r.onlineStudents().length,
      total: r.students.size,
      createdAt: r.createdAt,
    }))
  );
});

// 短链：/c/CODE 控制端、/w/CODE 大屏、/m?room=CODE 学生端
app.get(['/m', '/join'], (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'mobile.html')));
app.get('/w', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'wall.html')));
app.get('/c', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'control.html')));

app.get('/healthz', (req, res) =>
  res.json({
    ok: true,
    rooms: rooms.size,
    uptime: process.uptime(),
    // 部署后第一眼该看这个：false 说明卷权限不对，数据只在内存里，
    // 重启就丢。Docker 里务必确认它是 true。
    persistent: PERSISTENT,
    publicBase: PUBLIC_BASE || null,
    // 二维码实际会用的地址，以及它是怎么推出来的。
    // 走 WAF/反代时这一项最关键：如果它不是学生该访问的那个 https 域名，
    // 扫码就打不开。source 为 x-forwarded-host / host 说明是猜的，
    // 只有 env 才是你明确指定的。
    qrBase: baseUrl(req),
    qrBaseSource: baseUrlSource(req),
  })
);

/* ---------------- Socket.IO ---------------- */

/** 记录每个 socket 的角色与房间 */
const conns = new Map(); // socketId -> {room, view, studentId}

const broadcastTimers = new Map();
function broadcast(room) {
  if (broadcastTimers.has(room.code)) return;
  broadcastTimers.set(
    room.code,
    setTimeout(() => {
      broadcastTimers.delete(room.code);
      flush(room);
    }, 60)
  );
}

const EMPTY = { control: 0, wall: 0, mobile: 0 };
function flush(room) {
  const c = io.sockets.adapter.rooms.get(`c:${room.code}`);
  const w = io.sockets.adapter.rooms.get(`w:${room.code}`);
  const m = io.sockets.adapter.rooms.get(`m:${room.code}`);
  if (c && c.size) io.to(`c:${room.code}`).emit('state', room.publicState('control'));
  if (w && w.size) io.to(`w:${room.code}`).emit('state', room.publicState('wall'));
  if (m && m.size) io.to(`m:${room.code}`).emit('state', room.publicState('mobile'));
}

function bindRoom(room) {
  room.on('change', () => {
    broadcast(room);
    scheduleSave(room);
  });
}

// 视图名 -> 频道前缀。必须与 socket.join 处保持一致（c: / w: / m:），
// 否则定向广播会发进一个没人加入的空房间，事件全部丢失。
const CH_PREFIX = { control: 'c', wall: 'w', mobile: 'm' };

function emitTo(room, view, event, payload) {
  const prefix = CH_PREFIX[view] || view;
  io.to(`${prefix}:${room.code}`).emit(event, payload);
}

function emitAll(room, event, payload) {
  io.to(`c:${room.code}`).emit(event, payload);
  io.to(`w:${room.code}`).emit(event, payload);
  io.to(`m:${room.code}`).emit(event, payload);
}

/** 需要学生对象的控制器：统一取 currentStudent */
function requireStudent(socket, cb) {
  const conn = conns.get(socket.id);
  if (!conn || !conn.studentId) return null;
  const room = getRoom(conn.room);
  if (!room) return null;
  const st = room.getStudent(conn.studentId);
  if (!st) return null;
  st.lastSeen = Date.now();
  return { room, st, conn };
}

const TEACHER_VIEWS = new Set(['control']);

function requireTeacher(socket, ack) {
  const conn = conns.get(socket.id);
  if (!conn || conn.view !== 'control') {
    if (ack) ack({ ok: false, msg: '无权限：非控制端连接' });
    return null;
  }
  const room = getRoom(conn.room);
  if (!room) {
    if (ack) ack({ ok: false, msg: '课堂不存在' });
    return null;
  }
  return room;
}

/**
 * 控制端登录限速：防暴力猜口令。
 *
 * 教师口令是 6 位数字，只有 100 万种组合，而课堂码又公开挂在大屏上。
 * 不限制的话，学生拿课堂码就能脚本穷举口令、顶进控制端。这里按
 * 「房间 + 来源 IP」计数：连续失败超过 3 次进入冷却，冷却时长随失败次数
 * 翻倍、封顶 5 分钟。登录成功即清零。
 *
 * IP 优先取 X-Forwarded-For 首段（本项目走 WAF 反代，客户端真实 IP 在这个
 * 头里），没有才用 socket 直连地址——否则所有人都会被记成 WAF 的 IP，
 * 一个学生猜错就能把全班（连同老师）一起锁出去。
 */
const loginFails = new Map(); // key -> { fails, lockUntil, last }

function loginKey(roomCode, socket) {
  const xff = socket.handshake.headers['x-forwarded-for'];
  const ip = xff ? String(xff).split(',')[0].trim() : (socket.handshake.address || '?');
  return `${roomCode}|${ip}`;
}

function lockRemainSec(key) {
  const rec = loginFails.get(key);
  if (!rec || !rec.lockUntil) return 0;
  const remain = Math.ceil((rec.lockUntil - Date.now()) / 1000);
  return remain > 0 ? remain : 0;
}

function registerLoginFail(key) {
  const rec = loginFails.get(key) || { fails: 0, lockUntil: 0, last: 0 };
  rec.fails += 1;
  rec.last = Date.now();
  // 前 3 次只计数不锁（允许手滑），之后每次失败冷却翻倍、封顶 5 分钟。
  if (rec.fails >= 3) {
    const secs = Math.min(300, 5 * Math.pow(2, rec.fails - 3));
    rec.lockUntil = Date.now() + secs * 1000;
  }
  loginFails.set(key, rec);
}

// 清理久未活动的计数项，避免房间越积越多把内存撑大。
setInterval(() => {
  const now = Date.now();
  for (const [k, rec] of loginFails) {
    if (now - rec.last > 10 * 60 * 1000) loginFails.delete(k);
  }
}, 60 * 1000).unref();

io.on('connection', (socket) => {
  socket.on('disconnect', () => {
    const conn = conns.get(socket.id);
    if (!conn) return;
    const room = getRoom(conn.room);
    if (!room) return conns.delete(socket.id);
    if (conn.view === 'mobile' && conn.studentId) {
      const st = room.getStudent(conn.studentId);
      if (st) {
        st.sockets.delete(socket.id);
        if (st.sockets.size === 0) {
          st.online = false;
          room.addLog(`${st.avatar} ${st.nickname} 暂时离开`, 'leave');
          room.touch('leave');
        }
      }
    }
    conns.delete(socket.id);
  });

  /* --- 加入频道 --- */

  socket.on('control:join', ({ code, token, pass } = {}, ack) => {
    const room = getRoom(code);
    if (!room) return ack && ack({ ok: false, msg: '课堂不存在，请重新创建' });
    // 冷却期内直接拒绝，不再校验口令——否则等于白限速。
    const key = loginKey(room.code, socket);
    const remain = lockRemainSec(key);
    if (remain > 0) {
      return ack && ack({ ok: false, locked: true, msg: `尝试过于频繁，请 ${remain} 秒后再试` });
    }
    // 两套凭证任一匹配即可：本机保存的 token（免登录），或教师口令（换设备时手输）。
    const tokenOk = room.teacherToken && token === room.teacherToken;
    const passOk = room.teacherPass && String(pass || '').trim() === room.teacherPass;
    if (!tokenOk && !passOk) {
      registerLoginFail(key);
      return ack && ack({ ok: false, msg: '主持人令牌无效，请核对口令' });
    }
    loginFails.delete(key); // 登录成功，清零失败计数
    socket.join(`c:${room.code}`);
    conns.set(socket.id, { room: room.code, view: 'control', studentId: null });
    room.addLog('控制端已连接', 'sys');
    room.touch('control-join');
    ack && ack({ ok: true, state: room.publicState('control'), token: room.teacherToken });
  });

  socket.on('wall:join', ({ code } = {}, ack) => {
    const room = getRoom(code);
    if (!room) return ack && ack({ ok: false, msg: '课堂不存在' });
    socket.join(`w:${room.code}`);
    conns.set(socket.id, { room: room.code, view: 'wall', studentId: null });
    room.touch('wall-join');
    ack && ack({ ok: true, state: room.publicState('wall') });
  });

  socket.on('student:join', ({ code, nickname, avatar, studentId } = {}, ack) => {
    const room = getRoom(code);
    if (!room) return ack && ack({ ok: false, msg: '课堂不存在或已结束' });

    let st = studentId ? room.getStudent(studentId) : null;
    // 换手机或清了缓存时 studentId 会丢，此时按昵称认领原来的身份，
    // 否则一节课的积分就白攒了，榜单上还会出现同名的两条。
    const byName = !st && nickname ? room.findOfflineByName(nickname) : null;
    if (byName) st = byName;
    if (!st) {
      st = room.addStudent({ nickname, avatar });
    } else {
      st.online = true;
      if (nickname) st.nickname = nickname;
      if (avatar) st.avatar = avatar;
      room.addLog(`${st.avatar} ${st.nickname} 重新连接${byName ? '（按昵称认领）' : ''}`, 'join');
    }
    st.sockets.add(socket.id);
    st.lastSeen = Date.now();

    socket.join(`m:${room.code}`);
    conns.set(socket.id, { room: room.code, view: 'mobile', studentId: st.id });

    emitTo(room, 'wall', 'student:new', {
      id: st.id, nickname: st.nickname, avatar: st.avatar, color: st.color,
    });
    emitTo(room, 'control', 'student:new', {
      id: st.id, nickname: st.nickname, avatar: st.avatar, color: st.color,
    });

    room.touch('student-join');
    ack && ack({ ok: true, studentId: st.id, student: { ...st, sockets: undefined }, state: room.publicState('mobile') });
  });

  /* ================= 控制端指令 ================= */

  const teacher = (handler) => (payload = {}, ack) => {
    const room = requireTeacher(socket, ack);
    if (!room) return;
    try {
      handler(room, payload, ack);
    } catch (e) {
      console.error('[teacher-handler]', e);
      ack && ack({ ok: false, msg: e.message });
    }
  };

  socket.on('room:rename', teacher((room, { title }, ack) => {
    room.title = title || room.title;
    room.addLog(`课堂名称改为「${room.title}」`, 'sys');
    room.touch('rename');
    ack && ack({ ok: true });
  }));

  socket.on('settings:update', teacher((room, patch, ack) => {
    const next = { ...room.settings, ...(patch || {}) };
    // 分值字段直接决定积分，必须做白名单 + 范围收敛：
    // 不校验的话，一句 { scoreRules: { seatFront: 9999 } } 就能把平时分刷爆，
    // 或者塞进未知键把快照撑大。
    if (patch && patch.scoreRules && typeof patch.scoreRules === 'object') {
      const rules = {};
      for (const [k, v] of Object.entries(patch.scoreRules)) {
        if (!Object.prototype.hasOwnProperty.call(SCORE_RULES, k)) continue;
        const n = Math.round(Number(v));
        if (!Number.isFinite(n)) continue;
        // "答错" 类分值允许为负（-2 是常见的扣分档），但要封顶防止恶意刷分；
        // 其他分值限制在 0..20 内。
        if (k === 'buzzWrong' || k === 'wheelWrong') {
          rules[k] = Math.min(0, Math.max(-20, n));
        } else {
          rules[k] = Math.min(20, Math.max(0, n));
        }
      }
      next.scoreRules = { ...(room.settings.scoreRules || {}), ...rules };
    }
    room.settings = next;
    room.touch('settings');
    ack && ack({ ok: true, settings: room.settings });
  }));

  socket.on('teacher:pass', teacher((room, { pass }, ack) => {
    const p = String(pass || '').trim();
    if (!/^\d{6}$/.test(p)) return ack && ack({ ok: false, msg: '口令需为 6 位数字' });
    room.teacherPass = p;
    room.addLog('已修改教师口令', 'sys');
    room.touch('pass');
    ack && ack({ ok: true, pass: p });
  }));

  socket.on('seat:config', teacher((room, cfg, ack) => {
    // 排数同理：rows 太大座位图会卡死浏览器，backRows 不能超过总排数。
    const rows = Math.min(20, Math.max(1, Math.round(Number(cfg && cfg.rows)) || room.seatMap.rows));
    const cols = Math.min(20, Math.max(1, Math.round(Number(cfg && cfg.cols)) || room.seatMap.cols));
    const frontRows = Math.min(rows, Math.max(0, Math.round(Number(cfg?.frontRows ?? room.seatMap.frontRows)) || 0));
    const backRows = Math.min(rows, Math.max(0, Math.round(Number(cfg?.backRows ?? room.seatMap.backRows)) || 0));
    room.seatMap = { rows, cols, frontRows, backRows };
    room.touch('seat-config');
    ack && ack({ ok: true });
  }));

  /* --- 多节课：开始新的一课 / 清空全部数据 --- */

  // 开始新的一课：保留名单、积分、座位，清掉上一节的活动与分组。
  socket.on('room:newSession', teacher((room, _, ack) => {
    const no = room.newSession();
    emitAll(room, 'session:new', { sessionNo: no });
    room.touch('new-session');
    ack && ack({ ok: true, sessionNo: no });
  }));

  // 清空全部数据：连学生和积分一起清，用于换班级 / 新学期。
  socket.on('room:reset', teacher((room, _, ack) => {
    const { strays } = room.resetAll();
    // 旧连接手里还攥着已经不存在的 studentId，留着它们后续发指令会加到空气上，
    // 所以清掉 conns 里的记录并通知前端重新走加入流程。
    for (const sid of strays) {
      conns.delete(sid);
      const s = io.sockets.sockets.get(sid);
      if (s) s.emit('room:reset');
    }
    emitTo(room, 'wall', 'room:reset', {});
    emitTo(room, 'control', 'room:reset', {});
    room.touch('reset');
    ack && ack({ ok: true });
  }));

  /* --- 题库：提前录好题目，课堂上一键发布 --- */

  const BANK_TYPES = new Set(['poll', 'quiz', 'word', 'buzz']);
  const BANK_MAX = 60;
  // 题型：choice 选择题 / judge 判断题 / text 简答题
  const BANK_FORMATS = new Set(['choice', 'judge', 'text']);
  const JUDGE_OPTIONS = ['正确', '错误'];

  // 把任意来源（手录 / 导入文件）的题目收敛成统一结构；不合法返回 null。
  // 手录和导入共用同一套收敛规则，避免两处校验逻辑漂移。
  function normalizeBankItem(item = {}) {
    const type = BANK_TYPES.has(item.type) ? item.type : 'poll';
    const question = String(item.question || '').trim().slice(0, 200);
    if (!question) return null;
    // 词云/弹幕不参与题型，别拿选择题的规则去卡它（老题库的词云题本来就没选项）
    const isWord = type === 'word';
    // 老题库没有 format 字段：小测/投票按选择题处理，抢答按简答题处理
    // （改造前抢答就是一句提示语，没有选项，这样迁移过来表现完全一致）
    const format = isWord
      ? undefined
      : (BANK_FORMATS.has(item.format) ? item.format : (type === 'buzz' ? 'text' : 'choice'));

    let options = [];
    if (!isWord && format === 'judge') {
      options = [...JUDGE_OPTIONS];
    } else if (!isWord && format === 'choice') {
      // 选项最多 8 个、每个截到 60 字：不收敛的话一条超长题目就能把快照撑大
      options = (Array.isArray(item.options) ? item.options : [])
        .map((o) => String(o || '').trim().slice(0, 60))
        .filter(Boolean)
        .slice(0, 8);
      if (options.length < 2) return null;   // 选择题至少两个选项
    }

    let correct = null;
    if (!isWord && (format === 'choice' || format === 'judge')) {
      const n = Number(item.correct);
      correct = Number.isInteger(n) && n >= 0 && n < options.length ? n : null;
    }
    // 简答题的参考答案；抢答也能存答案（老师判定完再决定要不要公布）
    const answerText = !isWord && format === 'text'
      ? String(item.answerText || '').trim().slice(0, 200)
      : '';

    return {
      type,
      format,
      question,
      options,
      correct,
      answerText,
      multi: !isWord && format === 'choice' ? !!item.multi : false,
    };
  }

  const BANK_TYPE_NAME = { word: '词云', buzz: '抢答', quiz: '小测' };

  socket.on('bank:add', teacher((room, item = {}, ack) => {
    if (room.questionBank.length >= BANK_MAX) {
      return ack && ack({ ok: false, msg: `题库最多 ${BANK_MAX} 条，请先删除一些` });
    }
    const norm = normalizeBankItem(item);
    if (!norm) return ack && ack({ ok: false, msg: '题目内容不能为空或选项不足 2 个' });
    const q = { id: room.nextId(), ...norm };
    room.questionBank.push(q);
    const tn = BANK_TYPE_NAME[norm.type] || '投票';
    room.addLog(`题库新增${tn}题目：${norm.question.slice(0, 20)}`, 'bank');
    room.touch('bank-add');
    ack && ack({ ok: true, item: q, bank: room.questionBank });
  }));

  // 跨课堂共享：导入另一个班级导出的题库 JSON。
  // 合并而非替换——老师通常是「把这个班的题加进那个班」，不想把现有题冲掉。
  // 已存在同 id 则跳过（重复导入同一文件幂等），超限则停止，非法项忽略并计数。
  socket.on('bank:import', teacher((room, payload = {}, ack) => {
    const incoming = Array.isArray(payload) ? payload : (Array.isArray(payload.items) ? payload.items : []);
    if (!incoming.length) return ack && ack({ ok: false, msg: '没有可导入的题目' });
    const seen = new Set(room.questionBank.map((q) => q.id));
    const out = [];
    let added = 0, skipped = 0, dup = 0;
    for (const raw of incoming) {
      const norm = normalizeBankItem(raw);
      if (!norm) { skipped++; continue; }
      const id = (typeof raw.id === 'string' && raw.id) ? raw.id : room.nextId();
      if (seen.has(id)) { dup++; continue; } // 已存在则跳过（幂等）
      seen.add(id);
      if (room.questionBank.length + added >= BANK_MAX) break; // 不超上限
      out.push({ id, ...norm });
      added++;
    }
    if (out.length) {
      room.questionBank.push(...out);
      room.addLog(`题库导入 ${added} 题`, 'bank');
      room.touch('bank-import');
    }
    ack && ack({ ok: true, added, skipped, dup, total: room.questionBank.length, bank: room.questionBank });
  }));

  socket.on('bank:remove', teacher((room, { id }, ack) => {
    const before = room.questionBank.length;
    room.questionBank = room.questionBank.filter((q) => q.id !== id);
    room.touch('bank-remove');
    ack && ack({ ok: true, removed: before - room.questionBank.length, bank: room.questionBank });
  }));

  socket.on('bank:clear', teacher((room, _, ack) => {
    room.questionBank = [];
    room.touch('bank-clear');
    ack && ack({ ok: true, bank: [] });
  }));

  /* --- 活动的暂停 / 继续（对投票、词云、抢答、转盘通用） --- */

  // 暂停 = 截止提交但保留结果；结束 = 归档并清空。
  // 两者分开是因为老师最常见的动作是「先别投了，让大家看看结果」，
  // 而原来的「结束」会把结果一起清掉，大屏立刻回到待机，看不到分布。
  socket.on('activity:pause', teacher((room, _, ack) => {
    const act = room.pauseActivity();
    if (!act) return ack && ack({ ok: false, msg: '当前没有进行中的活动' });
    emitAll(room, 'activity:paused', { type: act.type, id: act.id });
    room.touch('activity-pause');
    ack && ack({ ok: true, paused: true });
  }));

  socket.on('activity:resume', teacher((room, _, ack) => {
    const act = room.resumeActivity();
    if (!act) return ack && ack({ ok: false, msg: '当前没有进行中的活动' });
    emitAll(room, 'activity:resumed', { type: act.type, id: act.id });
    room.touch('activity-resume');
    ack && ack({ ok: true, paused: false });
  }));

  /* --- 投票 / 选择题 --- */

  socket.on('poll:start', teacher((room, p, ack) => {
    const act = room.startPoll(p);
    if (!act) return ack && ack({ ok: false, msg: '至少需要 1 个选项' });
    emitAll(room, 'poll:started', {
      id: act.id, question: act.question, options: act.options,
      multi: act.multi, type: act.type, format: act.format,
    });
    room.touch('poll-start');
    ack && ack({ ok: true });
  }));

  socket.on('poll:stop', teacher((room, _, ack) => {
    const act = room.stopActivity();
    emitAll(room, 'poll:stopped', {});
    room.touch('poll-stop');
    ack && ack({ ok: true, correct: act ? act.correct : null });
  }));

  /**
   * 公布 / 收起答案。
   * 这是老师的显式动作，不跟「结束」自动绑定——他可以选择不公布
   * （比如想先让同学自己再想想）。传 { reveal:false } 表示收起，
   * 控制端把按钮做成「公布 ↔ 收起」的切换。
   */
  socket.on('poll:reveal', teacher((room, p = {}, ack) => {
    const act = room.activity;
    if (!act || !act.options) return ack && ack({ ok: false, msg: '当前不是投票活动' });
    const reveal = p.reveal !== false;
    room.revealAnswer(reveal);
    // -1 是「收起」的哨兵，和 poll:stopped 一致：大屏收到 -1 就把高亮撤掉
    const idx = reveal && Number.isInteger(act.correct) ? act.correct : -1;
    emitAll(room, 'poll:reveal', { correct: idx, revealed: reveal, answerText: reveal ? act.answerText : undefined });
    room.touch('reveal');
    ack && ack({ ok: true });
  }));

  /* --- 词云 / 弹幕 --- */

  socket.on('word:start', teacher((room, p, ack) => {
    const act = room.startWord(p);
    emitAll(room, 'word:started', { id: act.id, prompt: act.prompt, mode: act.mode });
    room.touch('word-start');
    ack && ack({ ok: true });
  }));

  socket.on('word:stop', teacher((room, _, ack) => {
    room.stopActivity();
    emitAll(room, 'word:stopped', {});
    room.touch('word-stop');
    ack && ack({ ok: true });
  }));

  socket.on('word:clear', teacher((room, _, ack) => {
    if (room.activity && room.activity.type === 'word') {
      room.activity.items = [];
      room.activity.submitters = [];
    }
    room.touch('word-clear');
    ack && ack({ ok: true });
  }));

  socket.on('word:hide', teacher((room, { text }, ack) => {
    const r = room.hideWord(text);
    if (!r.ok) return ack && ack(r);
    // 大屏上正在飘的、控制端已经列出的，都得立刻撤下来
    emitTo(room, 'wall', 'word:hidden', { text: r.text });
    emitTo(room, 'control', 'word:hidden', { text: r.text });
    room.touch('word-hide');
    ack && ack(r);
  }));

  socket.on('word:unblock', teacher((room, { text }, ack) => {
    room.unblockWord(text);
    room.touch('word-unblock');
    ack && ack({ ok: true });
  }));

  /* --- 抢答 --- */

  socket.on('buzz:start', teacher((room, p, ack) => {
    if (!room.settings.buzzEnabled) return ack && ack({ ok: false, msg: '抢答已在设置中关闭' });
    const act = room.startBuzz(p);
    emitAll(room, 'buzz:started', {
      prompt: act.prompt, format: act.format, options: act.options,
    });
    room.touch('buzz-start');
    ack && ack({ ok: true });
  }));

  // 抢答公布 / 收起答案。抢答按约定「只抢不答」，所以答案只是挂出来给全班看，
  // 老师在判定完之后再决定要不要公布。
  socket.on('buzz:reveal', teacher((room, p = {}, ack) => {
    const act = room.activity;
    if (!act || act.type !== 'buzz') return ack && ack({ ok: false, msg: '当前没有进行中的抢答' });
    const reveal = p.reveal !== false;
    room.revealAnswer(reveal);
    emitAll(room, 'buzz:reveal', {
      revealed: reveal,
      correct: reveal && Number.isInteger(act.correct) ? act.correct : -1,
      answerText: reveal ? act.answerText : undefined,
    });
    room.touch('buzz-reveal');
    ack && ack({ ok: true });
  }));

  socket.on('buzz:reset', teacher((room, _, ack) => {
    const act = room.activity;
    if (act && act.type === 'buzz') {
      act.ranks = [];
      for (const s of room.students.values()) s.buzzRank = null;
    }
    emitAll(room, 'buzz:reset', {});
    room.touch('buzz-reset');
    ack && ack({ ok: true });
  }));

  socket.on('buzz:stop', teacher((room, _, ack) => {
    room.stopActivity();
    emitAll(room, 'buzz:stopped', {});
    room.touch('buzz-stop');
    ack && ack({ ok: true });
  }));

  // 2026-09-04 修订：抢答本身不加分，老师按"答对/答错/0 分"手动判定。
  // 这里只调 addScore 走唯一入口；拒绝给已经"停止/归档"的活动发奖，
  // 否则老师手滑重发一次，同学就被扣两次分。
  // 同一名同学在同一轮抢答里可以多次调整（先打错 +0、改判后再 +5），
  // 用 latest 覆盖；记录到 act.ranks 让大屏"待判定 → +5"自动跟随刷新。
  socket.on('buzz:award', teacher((room, { studentId, delta, reason } = {}, ack) => {
    const act = room.activity;
    if (!act || act.type !== 'buzz') return ack && ack({ ok: false, msg: '当前没有进行中的抢答' });
    const st = room.getStudent(studentId);
    if (!st) return ack && ack({ ok: false, msg: '学生不存在' });
    const d = Number(delta) || 0;
    const rankRow = act.ranks.find((r) => r.studentId === studentId);
    if (!rankRow) return ack && ack({ ok: false, msg: '该同学没有抢答' });
    const txt = reason || (d > 0 ? '抢答答对' : d < 0 ? '抢答答错' : '抢答判定 0 分');
    // 撤回上一次判定（如果存在），再加新的，保证 net = delta 而不是累加
    if (typeof rankRow.awarded === 'number') {
      room.addScore(st, -rankRow.awarded, '撤回上一次抢答判定');
    }
    room.addScore(st, d, txt);
    rankRow.awarded = d;
    room.touch('buzz-award');
    ack && ack({ ok: true, score: st.score, sessionScore: st.sessionScore, awarded: d });
  }));

  /* --- 大转盘 --- */

  socket.on('wheel:open', teacher((room, p, ack) => {
    const act = room.startWheel(p || {});
    emitAll(room, 'wheel:opened', { candidates: act.candidates, title: act.title, pool: act.pool });
    room.touch('wheel-open');
    ack && ack({ ok: true });
  }));

  socket.on('wheel:spin', teacher((room, _, ack) => {
    const act = room.activity;
    if (!act || act.type !== 'wheel') return ack && ack({ ok: false, msg: '转盘未打开' });
    if (act.spinning) return ack && ack({ ok: false, msg: '正在旋转中' });
    act.spinning = true;
    const res = room.spinWheel();
    if (!res) {
      act.spinning = false;
      return ack && ack({ ok: false, msg: '没有可抽取的同学' });
    }
    emitAll(room, 'wheel:spin', { winner: res.winner, index: res.index, total: act.candidates.length });
    setTimeout(() => {
      act.spinning = false;
      room.touch('wheel-done');
    }, 5200);
    room.touch('wheel-spin');
    ack && ack({ ok: true, winner: res.winner });
  }));

  socket.on('wheel:close', teacher((room, _, ack) => {
    room.stopActivity();
    emitAll(room, 'wheel:closed', {});
    room.touch('wheel-close');
    ack && ack({ ok: true });
  }));

  socket.on('wheel:refresh', teacher((room, p, ack) => {
    const act = room.activity;
    if (!act || act.type !== 'wheel') return ack && ack({ ok: false, msg: '转盘未打开' });
    act.candidates = room.pickCandidates(act.pool, (p && p.count) || act.candidates.length);
    act.picked = [];
    act.result = null;
    emitAll(room, 'wheel:opened', { candidates: act.candidates, title: act.title, pool: act.pool });
    room.touch('wheel-refresh');
    ack && ack({ ok: true });
  }));

  // 2026-09-04 修订：转盘抽中人不自动加分，老师按"答对/答错/0 分"判定。
  socket.on('wheel:award', teacher((room, { studentId, delta, reason } = {}, ack) => {
    const act = room.activity;
    if (!act || act.type !== 'wheel') return ack && ack({ ok: false, msg: '当前没有进行中的转盘' });
    const st = room.getStudent(studentId);
    if (!st) return ack && ack({ ok: false, msg: '学生不存在' });
    const d = Number(delta) || 0;
    const txt = reason || (d > 0 ? '抽问答对' : d < 0 ? '抽问答错' : '提问判定 0 分');
    room.addScore(st, d, txt);
    room.touch('wheel-award');
    ack && ack({ ok: true, score: st.score, sessionScore: st.sessionScore });
  }));

  /* --- 计时器 --- */

  socket.on('timer:set', teacher((room, { seconds }, ack) => {
    const t = room.setTimer(Number(seconds) || 0);
    emitAll(room, 'timer:sync', t);
    room.touch('timer');
    ack && ack({ ok: true, timer: t });
  }));

  socket.on('timer:pause', teacher((room, _, ack) => {
    const t = room.pauseTimer();
    emitAll(room, 'timer:sync', t);
    room.touch('timer');
    ack && ack({ ok: true });
  }));

  socket.on('timer:resume', teacher((room, _, ack) => {
    const t = room.resumeTimer();
    emitAll(room, 'timer:sync', t);
    room.touch('timer');
    ack && ack({ ok: true });
  }));

  /* --- 分组 --- */

  socket.on('group:make', teacher((room, { count, mode }, ack) => {
    const groups = room.makeGroups(Number(count) || 4, mode || 'random');
    emitAll(room, 'group:made', { groups });
    room.touch('group');
    ack && ack({ ok: true, groups });
  }));

  socket.on('group:clear', teacher((room, _, ack) => {
    room.groups = [];
    for (const s of room.students.values()) s.group = null;
    emitAll(room, 'group:made', { groups: [] });
    room.touch('group');
    ack && ack({ ok: true });
  }));

  /* --- 举手 / 积分 / 其他 --- */

  socket.on('hand:clear', teacher((room, _, ack) => {
    for (const s of room.students.values()) s.handsUp = false;
    room.touch('hand-clear');
    ack && ack({ ok: true });
  }));

  socket.on('score:adjust', teacher((room, { studentId, delta, reason }, ack) => {
    const st = room.getStudent(studentId);
    if (!st) return ack && ack({ ok: false, msg: '学生不存在' });
    room.addScore(st, Number(delta) || 0, reason || '教师调整');
    emitTo(room, 'mobile', 'score:changed', { studentId, delta: Number(delta) || 0, score: st.score, reason: reason || '教师调整' });
    room.touch('score');
    ack && ack({ ok: true, score: st.score });
  }));

  socket.on('score:adjustMany', teacher((room, { studentIds, delta, reason }, ack) => {
    let n = 0;
    for (const id of studentIds || []) {
      const st = room.getStudent(id);
      if (st) { room.addScore(st, Number(delta) || 0, reason || '教师调整'); n++; }
    }
    room.touch('score');
    ack && ack({ ok: true, count: n });
  }));

  socket.on('student:kick', teacher((room, { studentId }, ack) => {
    const st = room.getStudent(studentId);
    if (!st) return ack && ack({ ok: false, msg: '学生不存在' });
    for (const sid of st.sockets) {
      const s = io.sockets.sockets.get(sid);
      if (s) s.emit('kicked', { msg: '你已被移出课堂' });
    }
    st.online = false;
    st.sockets.clear();
    room.touch('kick');
    ack && ack({ ok: true });
  }));

  socket.on('broadcast:effect', teacher((room, { kind, text }, ack) => {
    emitTo(room, 'wall', 'effect', { kind: kind || 'celebrate', text: text || '' });
    ack && ack({ ok: true });
  }));

  // 强制大屏切到某个视图（idle/poll/word/wheel/seat/buzz/group）
  socket.on('wall:show', teacher((room, { view }, ack) => {
    emitTo(room, 'wall', 'wall:show', { view });
    ack && ack({ ok: true });
  }));

  // 在大屏底栏推送一条提示语
  socket.on('wall:msg', teacher((room, { text }, ack) => {
    emitTo(room, 'wall', 'wall:msg', { text: text || '' });
    ack && ack({ ok: true });
  }));

  /* ================= 学生端指令 ================= */

  const student = (handler) => (payload = {}, ack) => {
    const ctx = requireStudent(socket);
    if (!ctx) return ack && ack({ ok: false, msg: '请先加入课堂' });
    try {
      handler(ctx.room, ctx.st, payload, ack);
    } catch (e) {
      console.error('[student-handler]', e);
      ack && ack({ ok: false, msg: e.message });
    }
  };

  socket.on('student:seat', student((room, st, { row, col }, ack) => {
    const r = room.takeSeat(st, { row: Number(row), col: Number(col) });
    // 座位已被在线同学占用：把占用者回传过去，让前端能直接说出是谁，
    // 而不是干巴巴一句"选座失败"。
    if (!r || r.ok === false) {
      return ack && ack({
        ok: false,
        occupied: true,
        msg: r && r.by ? `${Number(row) + 1} 排 ${Number(col) + 1} 座 已被 ${r.by.avatar} ${r.by.nickname} 占用` : '选座失败',
      });
    }
    emitTo(room, 'wall', 'seat:taken', { id: st.id, row: st.seat.row, col: st.seat.col, avatar: st.avatar, color: st.color, nickname: st.nickname });
    io.to(`m:${room.code}`).emit('state', room.publicState('mobile'));
    room.touch('seat');
    ack && ack({ ok: true, seat: st.seat, score: st.score, front: r.front, bonus: r.bonus, changed: r.changed });
  }));

  // 退出座位：同学发现自己坐错了，先退出来再重新挑，避免只能硬换。
  socket.on('student:unseat', student((room, st, _, ack) => {
    const r = room.leaveSeat(st);
    if (!r.ok) return ack && ack(r);
    emitTo(room, 'wall', 'seat:released', { id: st.id });
    io.to(`m:${room.code}`).emit('state', room.publicState('mobile'));
    room.touch('unseat');
    ack && ack({ ok: true });
  }));

  /**
   * 学生自己改昵称。
   *
   * 课堂上真有同学手滑打成「张3」、或者临时想换成真实姓名。没有入口的话，
   * 他就得顶着错的昵称上一整个学期，而老师点名、分组、导出的平时分表里
   * 全是那个错名字。
   *
   * 重名只提醒、不拒绝：拒绝会让想改的人卡死；而加入时本来就允许同名共存
   * （同名且原主在线时另建身份），所以放行不会让数据变乱。
   * 但要把「撞名了」告诉本人——重名时老师点名会分不清是谁。
   */
  socket.on('student:rename', student((room, st, { nickname } = {}, ack) => {
    const clean = String(nickname || '').trim().slice(0, 12);
    if (!clean) return ack && ack({ ok: false, msg: '昵称不能为空' });
    if (clean === st.nickname) return ack && ack({ ok: true, nickname: clean, unchanged: true });

    const oldName = st.nickname;
    const clash = [...room.students.values()]
      .some((o) => o.id !== st.id && o.online && o.nickname === clean);
    st.nickname = clean;
    room.addLog(`${st.avatar} ${oldName} 改名为 ${clean}`, 'rename');
    // 通过 touch() 触发 broadcast，三端（控制端/大屏/手机）都会刷新到新昵称。
    // 不必再单独 io.to(`m:`...) 手动推，flush() 已经覆盖所有视图。
    room.touch('student-rename');
    ack && ack({ ok: true, nickname: clean, avatar: st.avatar, oldName, clash });
  }));

  socket.on('student:vote', student((room, st, { indexes }, ack) => {
    const r = room.vote(st, indexes);
    if (!r.ok) return ack && ack(r);
    const act = room.activity;
    emitTo(room, 'wall', 'poll:update', {
      options: act.options.map((o) => ({ text: o.text, count: o.count })),
      totalVotes: act.voters.length,
      onlineCount: room.onlineStudents().length,
    });
    emitTo(room, 'control', 'poll:update', {
      options: act.options.map((o) => ({ text: o.text, count: o.count })),
      totalVotes: act.voters.length,
    });
    room.touch('vote');
    ack && ack({ ok: true, score: st.score });
  }));

  // 简答题（text 题型）：同学提交文字答案。
  // 答案列表挂在 publicState.activity.answers 上（大屏要做实名答案墙），
  // 所以这里只需 touch 一下让三端重新取状态，不必再单独发一遍列表。
  socket.on('student:answer', student((room, st, { text }, ack) => {
    const r = room.submitAnswer(st, text);
    if (!r.ok) return ack && ack(r);
    room.touch('answer');
    ack && ack({ ok: true, score: st.score });
  }));

  socket.on('student:word', student((room, st, { text }, ack) => {
    const r = room.submitWord(st, text);
    if (!r.ok) return ack && ack(r);
    emitTo(room, 'wall', 'word:new', r.item);
    emitTo(room, 'control', 'word:new', r.item);
    room.touch('word');
    ack && ack({ ok: true, score: st.score });
  }));

  socket.on('student:buzz', student((room, st, _, ack) => {
    if (!room.settings.buzzEnabled) return ack && ack({ ok: false, msg: '老师已关闭抢答' });
    const r = room.pressBuzz(st);
    if (!r.ok) return ack && ack(r);
    emitAll(room, 'buzz:rank', { rank: r.rank, id: st.id, nickname: st.nickname, avatar: st.avatar, color: st.color });
    room.touch('buzz');
    ack && ack({ ok: true, rank: r.rank, score: st.score });
  }));

  socket.on('student:hand', student((room, st, { up }, ack) => {
    room.toggleHand(st, up);
    room.touch('hand');
    ack && ack({ ok: true, handsUp: st.handsUp });
  }));

  socket.on('student:cheer', student((room, st, { kind }, ack) => {
    const ok = room.cheer(st, kind || '👏');
    if (!ok) return ack && ack({ ok: false, msg: '喝彩已关闭' });
    emitTo(room, 'wall', 'cheer:burst', { kind: kind || '👏', nickname: st.nickname, avatar: st.avatar, color: st.color });
    room.touch('cheer');
    ack && ack({ ok: true });
  }));
});

/* ---------------- 计时器心跳 ---------------- */

setInterval(() => {
  for (const room of rooms.values()) {
    const r = room.tickTimer();
    if (r === null) continue;
    emitAll(room, 'timer:sync', room.timer);
    if (r.finished) {
      emitTo(room, 'wall', 'effect', { kind: 'timeup', text: '时间到！' });
    }
    room.dirty = true;
    scheduleSave(room);
  }
}, 1000);

/* ---------------- 启动 ---------------- */

loadRooms();
for (const r of rooms.values()) bindRoom(r);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  课堂互动系统已启动`);
  console.log(`  本地访问:  http://localhost:${PORT}`);
  console.log(`  控制端:    http://localhost:${PORT}/c`);
  console.log(`  数据目录:  ${DATA_DIR}\n`);
});

process.on('SIGTERM', () => {
  if (!PERSISTENT) {
    console.log('[shutdown] 纯内存模式，无数据需要保存');
    server.close(() => process.exit(0));
    return;
  }
  console.log('[shutdown] 正在保存房间数据…');
  for (const r of rooms.values()) {
    try { fs.writeFileSync(roomFile(r.code), JSON.stringify(r.toJSON(), null, 2), 'utf8'); } catch {}
  }
  server.close(() => process.exit(0));
});
