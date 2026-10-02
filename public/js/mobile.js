/* ==========================================================
   手机端主控
   ========================================================== */
import { Net, toast, $, $$, esc, qs, ls, sfx } from './common.js';

const AVATARS = ['🦊', '🐼', '🐯', '🐨', '🐸', '🐵', '🐧', '🐙', '🦁', '🐷', '🐮', '🐔', '🐳', '🦄', '🐝', '🦉', '🐺', '🐴', '🦋', '🐬', '🦖', '🐲', '🦉', '🐱'];

const code = (qs('room') || '').toUpperCase();
if (!code) document.body.innerHTML = '<div style="padding:40px;text-align:center;color:#b8c2e8">缺少课堂码，请重新扫码</div>';

const KEY_ID = `sid_${code}`;
const KEY_NICK = `nick_${code}`;
const KEY_AV = `av_${code}`;

let state = null;
let myId = ls.get(KEY_ID, null);
let myAvatar = ls.get(KEY_AV, AVATARS[Math.floor(Math.random() * AVATARS.length)]);
let mySeat = null;
let myVotes = [];
let myWords = [];
let handsUp = false;
let buzzDone = false;
let lastActivityId = null;
// 是否已成功加入课堂。收到服务端广播时要用它判断该不该切换页面——
// 还没加入就跳页面，会把正在填昵称的同学直接从加入页掀走。
let joined = false;
// 记住最后一次渲染的座位网格，退出座位后要按它重绘
let lastSeatGrid = 'm-seat-grid';

/**
 * 读取本课堂的分值设置。手机端所有「+N 分」提示都必须走这里：
 * 写死数字的话，老师把分值改成别的值，同学看到的提示还是旧的，
 * 就会觉得"说好的加分没给"。
 */
function rule(key, fallback) {
  const rules = state && state.settings && state.settings.scoreRules;
  const v = rules ? Number(rules[key]) : NaN;
  return Number.isFinite(v) ? v : fallback;
}

/** 抢答名次对应的分值，前三名之外为 0 */
function buzzScore(rank) {
  if (rank === 1) return rule('buzz1', 5);
  if (rank === 2) return rule('buzz2', 3);
  if (rank === 3) return rule('buzz3', 1);
  return 0;
}

const net = new Net();
net.on('__connect', () => join());
net.onReconnect = () => join();
let netWarned = false;
net.on('__error', () => {
  // 连接失败时给一次提示，避免用户点了没反应却不知道发生了什么
  if (netWarned || net.connected) return;
  netWarned = true;
  toast('网络连接不稳定，正在重试…', 'err');
  setTimeout(() => { netWarned = false; }, 8000);
});
net.on('state', onState);
net.on('poll:started', (d) => { myVotes = []; toast('老师发布了新问题', 'ok'); sfx.pop(); });
net.on('poll:reveal', (d) => onReveal(d.correct));
net.on('poll:stopped', () => {});
net.on('word:started', (d) => { myWords = []; $('#m-word-text').value = ''; toast('快说出你的想法！', 'ok'); });
net.on('buzz:started', () => { buzzDone = false; $('#m-buzz-btn').classList.remove('done', 'disabled'); toast('抢答开始！', 'ok'); sfx.fanfare(); });
net.on('buzz:reset', () => { buzzDone = false; $('#m-buzz-btn').classList.remove('done', 'disabled'); $('#m-buzz-rank').innerHTML = ''; });
net.on('buzz:rank', onBuzzRank);
net.on('wheel:spin', () => { $('#m-wheel-status').textContent = '转动中…'; $('#m-wheel-card')?.classList.remove('win'); });
net.on('score:changed', (d) => {
  if (d.studentId !== myId) return;
  toast(`${d.delta > 0 ? '+' : ''}${d.delta} 分 · ${d.reason || '教师调整'}`, d.delta > 0 ? 'ok' : 'warn');
  sfx.success();
});
net.on('kicked', (d) => {
  document.body.innerHTML = `<div style="padding:60px 24px;text-align:center;color:#b8c2e8;line-height:2">
    <div style="font-size:56px">👋</div><h2>你已被移出课堂</h2><p>${esc(d.msg || '')}</p></div>`;
});

// 老师清空了课堂：本地存的学生 id 已经失效，必须清掉再重新加入，
// 否则会拿着一个服务端不认识的 id 去认领身份，积分和座位都对不上。
net.on('room:reset', () => {
  ls.del(KEY_ID);
  ls.del(KEY_NICK);
  toast('老师已重置课堂，正在重新进入…', 'warn');
  setTimeout(() => location.reload(), 900);
});

// 新的一课：座位每节课都重排（按小组坐、换教室都可能变），所以服务端会把
// 座位清掉，这里也要同步清本地状态并把同学带到选座页，否则界面上还显示着
// 上节课的位置，而服务端已经认为他没坐了——两边对不上，前排加分也会漏。
net.on('session:new', (d) => {
  mySeat = null;
  toast(`第 ${d.sessionNo} 课开始，请重新选座`, 'ok', 3200);
  if (joined) showPage('m-seat');
});

// 暂停/继续：同学这边只影响能不能提交和提示语，结果本来就一直显示着
net.on('activity:paused', () => { toast('老师已暂停作答', 'warn'); if (state && state.activity) renderActivity(state); });
net.on('activity:resumed', () => { toast('继续作答', 'ok'); if (state && state.activity) renderActivity(state); });

function join() {
  const nickname = ls.get(KEY_NICK, '');
  net.emit('student:join', { code, nickname, avatar: myAvatar, studentId: myId }, (res) => {
    if (!res || !res.ok) {
      toast((res && res.msg) || '加入失败', 'err');
      showPage('m-join');
      return;
    }
    myId = res.studentId;
    ls.set(KEY_ID, myId);
    ls.set(KEY_NICK, res.student.nickname);
    ls.set(KEY_AV, res.student.avatar);
    mySeat = res.student.seat;
    joined = true;
    onState(res.state);
    if (res.student.seat) showPage('m-main');
    else showPage('m-seat');
    sfx._ensure();
  });
}

/* ================= 加入页 ================= */

$('#m-my-avatar').textContent = myAvatar;
$('#m-nickname').value = ls.get(KEY_NICK, '');
$('#m-shuffle').onclick = () => {
  const cur = $('#m-my-avatar');
  let a = myAvatar;
  while (a === myAvatar) a = AVATARS[Math.floor(Math.random() * AVATARS.length)];
  myAvatar = a;
  cur.textContent = a;
  cur.classList.remove('change');
  void cur.offsetWidth;
  cur.classList.add('change');
  sfx.click();
};

$('#m-join-btn').onclick = () => {
  const nickname = $('#m-nickname').value.trim();
  if (!nickname) { toast('请输入昵称', 'warn'); $('#m-nickname').focus(); return; }
  ls.set(KEY_NICK, nickname);
  ls.set(KEY_AV, myAvatar);
  // 新同学进来时 socket 还没连（boot 里只在有历史 studentId 时才连），
  // 必须先连上再发加入请求；连上后 __connect 会自动调用 join()。
  if (net.connected) join();
  else net.connect();
};
$('#m-nickname').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#m-join-btn').click(); });

/* ================= 选座 ================= */

$('#m-seat-skip').onclick = () => showPage('m-main');
$('#m-seat2-back').onclick = () => showPage('m-main');

function renderSeatGrid(elId) {
  if (!state) return;
  const { rows, cols, frontRows } = state.seatMap;
  const taken = new Map();
  (state.seats || []).forEach((s) => { if (s.id !== myId) taken.set(`${s.row}-${s.col}`, s); });
  const grid = $('#' + elId);
  // 不能写死像素宽：8 列 × 40px + 间距在 360px 的小屏上会溢出，首尾两列被切掉，
  // 老师把座位表配成 10 列时就更离谱。改为等分自适应，由 CSS 按可用宽度收缩。
  grid.style.setProperty('--seat-cols', String(cols));
  grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
  grid.innerHTML = '';
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const s = taken.get(`${r}-${c}`);
      const isMine = mySeat && mySeat.row === r && mySeat.col === c;
      const d = document.createElement('div');
      d.className = 'm-seat' + (r < frontRows ? ' front' : '') + (s ? ' taken' : '') + (isMine ? ' mine' : '');
      if (s) d.style.setProperty('--sc', s.color);
      d.textContent = s ? s.avatar : isMine ? '✓' : '';
      // 悬停/长按提示带上占用者姓名：同学认错座位时最想确认的就是"这是谁的座"
      d.title = s
        ? `${r + 1}排${c + 1}座 · ${s.nickname}`
        : isMine ? `${r + 1}排${c + 1}座 · 我的座位（点击退出重选）` : `${r + 1}排${c + 1}座（空闲）`;
      // 每个座位都可点：被占的提示是谁、自己的可退出、空的直接坐下。
      // 原来只对空座绑 onclick，点已占座位毫无反应，同学会以为页面卡了。
      d.onclick = () => onSeatClick(r, c, s, isMine);
      grid.appendChild(d);
    }
  }
}

/**
 * 座位点击分发。
 * 占座和换座走同一条路径，区别只在目标座位的状态；
 * 服务端也会再校验一次占用，本地状态过期（别人刚抢先占了）时以服务端为准。
 */
function onSeatClick(r, c, occupant, isMine) {
  if (isMine) {
    net.emit('student:unseat', {}, (res) => {
      if (!res || !res.ok) return toast((res && res.msg) || '操作失败', 'err');
      mySeat = null;
      sfx.click();
      toast('已退出座位，请重新选择', 'ok');
      renderSeatGrid(lastSeatGrid);
    });
    return;
  }
  if (occupant) {
    toast(`${r + 1} 排 ${c + 1} 座 已被 ${occupant.avatar} ${occupant.nickname} 占用`, 'warn');
    return;
  }
  pickSeat(r, c);
}

function pickSeat(r, c) {
  net.emit('student:seat', { row: r, col: c }, (res) => {
    if (!res || !res.ok) {
      // 服务端在座位被占时会带上占用者姓名，直接转述即可
      return toast((res && res.msg) || '选座失败', res && res.occupied ? 'warn' : 'err');
    }
    mySeat = res.seat;
    sfx.success();
    // 提示以服务端回传的实际加分为准：在前排内换座是不加分的，
    // 若照写"前排 +3 分"，同学发现分数没动就会来找老师。
    if (res.bonus) toast(`前排就坐！+${res.bonus} 分 🎉`, 'ok');
    else if (res.changed) toast(`已换到 ${r + 1} 排 ${c + 1} 座`, 'ok');
    else toast(`已选 ${r + 1} 排 ${c + 1} 座`, 'ok');
    setTimeout(() => showPage('m-main'), 500);
  });
}

/* ================= 页面切换 ================= */

function showPage(id) {
  $$('.m-page').forEach((p) => p.classList.toggle('active', p.id === id));
  if (id === 'm-seat') { lastSeatGrid = 'm-seat-grid'; renderSeatGrid(lastSeatGrid); }
  if (id === 'm-seat2') { lastSeatGrid = 'm-seat-grid2'; renderSeatGrid(lastSeatGrid); }
  if (id === 'm-rank') renderRank();
  if (id === 'm-me') renderMe();
}

$$('.m-tab').forEach((b) => (b.onclick = () => {
  const t = b.dataset.mtab;
  if (t === 'act') showPage('m-main');
  else if (t === 'seat') showPage('m-seat2');
  else if (t === 'rank') showPage('m-rank');
  else showPage('m-me');
}));
$('#m-rank-back').onclick = () => showPage('m-main');
// 「我的」页也要有返回：底部 tabbar 只在 #m-main 里，切到 m-me 后就没了
$('#m-me-back').onclick = () => showPage('m-main');

/* ================= 状态渲染 ================= */

function onState(s) {
  state = s;
  $('#m-room-title').textContent = s.title || '课堂互动';
  $('#m-top-avatar').textContent = ls.get(KEY_AV, '🦊');
  $('#m-top-name').textContent = ls.get(KEY_NICK, '我');
  $('#m-top-seat').textContent = mySeat ? `${mySeat.row + 1} 排 ${mySeat.col + 1} 座` : '未选座';

  const me = (s.leaderboard || []).find((x) => x.id === myId);
  // 顶栏放「本次课得分」而不是累计总分：课中会长动、同学真正盯着的是这个数，
  // 放总分的话一节课下来几乎不动，看着像系统卡了。累计总分在「我的」页。
  const myScore = me ? (Number(me.sessionScore) || 0) : 0;
  const scoreEl = $('#m-score');
  if (scoreEl.textContent !== String(myScore)) {
    scoreEl.textContent = myScore;
    $('.m-score').classList.add('bump');
    setTimeout(() => $('.m-score').classList.remove('bump'), 500);
  }

  renderActivity(s);
  renderRankMini(s.leaderboard || []);
  $$('.m-tab').forEach((b) => b.classList.toggle('active', b.dataset.mtab === 'act' && $('#m-main').classList.contains('active')));

  // 喝彩开关：服务端 Room.cheer() 已按 cheerEnabled 拦截，但学生端最好直接把
  // 按钮置灰，避免反复去点才发现「老师没开」——既防误触也防课堂里有人狂点刷屏。
  const cheerBtn = $('#m-cheer-btn');
  if (cheerBtn) {
    const cheerOn = !!(s.settings && s.settings.cheerEnabled);
    cheerBtn.classList.toggle('disabled', !cheerOn);
    cheerBtn.querySelector('b').textContent = cheerOn ? '喝彩' : '已关闭';
    cheerBtn.querySelector('span').textContent = cheerOn ? '给课堂加点料' : '老师未开启';
  }
}

function renderActivity(s) {
  const act = s.activity;
  // 简答题没有选项，要换成输入作答的界面；选择题/判断题沿用选项列表
  const view = !act ? 'idle'
    : (act.type === 'poll' || act.type === 'quiz')
      ? (act.format === 'text' ? 'text' : 'poll')
      : act.type;
  $$('.m-view').forEach((v) => v.classList.toggle('active', v.id === `mv-${view}`));
  const tab = $('.m-tab[data-mtab="act"]');
  if (tab) tab.innerHTML = `<i>${view === 'idle' ? '⏳' : '🎯'}</i><span>活动</span>` + (act ? '<i class="dot"></i>' : '');

  if (!act) {
    $('#m-idle-hint').textContent = s.stats.online > 1
      ? `${s.stats.online} 位同学已就坐，等老师发布活动`
      : '老师发布活动后会实时出现在这里';
    return;
  }

  if (act.type === 'poll' || act.type === 'quiz') {
    if (act.format === 'text') renderText(act, s); else renderPoll(act, s);
  }
  if (act.type === 'word') renderWord(act, s);
  if (act.type === 'buzz') renderBuzz(act, s);
  if (act.type === 'wheel') renderWheel(act, s);
}

/* ---------- 投票 ---------- */
function renderPoll(act, s) {
  $('#m-poll-badge').textContent = act.type === 'quiz' ? '📝 随堂小测' : '📊 投票';
  $('#m-poll-q').textContent = act.question || '请选择';
  const total = (act.options || []).reduce((a, o) => a + o.count, 0) || 1;
  const correct = act.correct;
  $('#m-options').innerHTML = (act.options || []).map((o, i) => {
    const picked = myVotes.includes(i);
    const isCorrect = correct !== null && correct !== undefined && correct >= 0;
    let cls = 'm-opt';
    if (picked) cls += ' picked';
    if (isCorrect && i === correct) cls += ' correct';
    if (isCorrect && picked && i !== correct) cls += ' wrong';
    return `<button class="${cls}" data-i="${i}">
      <span class="obar" style="width:${act.open ? 0 : (o.count / total) * 100}%"></span>
      <span class="ol">${String.fromCharCode(65 + i)}</span>
      <span class="ot">${esc(o.text)}</span>
      <span class="oc">${act.open ? '' : o.count}</span>
    </button>`;
  }).join('');
  // 暂停和结束都要显示票数（让同学看到结果），但提示语要区分开：
  // 暂停时说"老师已暂停"，结束才说"已结束"。
  $('#m-poll-hint').textContent = act.open
    ? (act.multi ? '可多选，再点一次取消' : '选择后立即同步到大屏')
    : (act.paused ? '老师已暂停作答，可查看当前结果' : '已结束');
  $$('#m-options .m-opt').forEach((b) => (b.onclick = () => vote(Number(b.dataset.i), act)));
  renderRef($('#m-poll-ref'), act);
}

/**
 * 公布答案区。
 * 老师可以选择不公布，所以只在 revealed 为真时才显示；
 * 选择题/判断题显示正确项，简答题显示参考答案。
 */
function renderRef(el, act) {
  if (!el) return;
  if (!act.revealed) { el.textContent = ''; el.classList.add('hidden'); return; }
  const fmt = act.format || 'choice';
  let txt = '';
  if (fmt === 'text') {
    txt = act.answerText ? `参考答案：${act.answerText}` : '';
  } else if (Number.isInteger(act.correct) && act.options && act.options[act.correct]) {
    txt = `正确答案：${String.fromCharCode(65 + act.correct)}. ${act.options[act.correct].text}`;
  }
  el.textContent = txt;
  el.classList.toggle('hidden', !txt);
}

/* ---------- 简答题 ---------- */
function renderText(act, s) {
  $('#m-text-badge').textContent = act.type === 'quiz' ? '📝 简答题' : '✍️ 简答题';
  $('#m-text-q').textContent = act.question || '说说你的答案';
  const mine = (act.answers || []).find((a) => a.id === myId);
  const inp = $('#m-text-answer');
  // 别在同学正在打字时把输入框冲掉
  if (document.activeElement !== inp) inp.value = mine ? mine.text : '';
  $('#m-text-hint').textContent = act.open
    ? (mine ? '已提交，可以改完再交一次' : '提交后会显示在大屏答案墙上')
    : (act.paused ? '老师已暂停作答' : '本题已结束');
  $('#m-text-send').textContent = mine ? '修改' : '提交';
  renderRef($('#m-text-ref'), act);
}

function sendTextAnswer() {
  const inp = $('#m-text-answer');
  const text = inp.value.trim();
  if (!text) return toast('请先输入答案', 'warn');
  net.emit('student:answer', { text }, (res) => {
    if (!res || !res.ok) return toast((res && res.msg) || '提交失败', 'err');
    sfx.pop();
    toast(`提交成功 +${rule('vote', 1)} 分`, 'ok');
    if (state && state.activity) renderText(state.activity, state);
  });
}
$('#m-text-send').onclick = sendTextAnswer;
$('#m-text-answer').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendTextAnswer(); });

function vote(i, act) {
  // 暂停时说"老师已暂停"，别让同学误以为活动结束了、白点一通
  if (!act.open) return toast(act.paused ? '老师已暂停作答' : '投票已结束', 'warn');
  let indexes;
  if (act.multi) {
    indexes = myVotes.includes(i) ? myVotes.filter((x) => x !== i) : [...myVotes, i];
  } else {
    if (myVotes.length) return toast('你已经投过票了', 'warn');
    indexes = [i];
  }
  net.emit('student:vote', { indexes }, (res) => {
    if (!res || !res.ok) return toast((res && res.msg) || '提交失败', 'err');
    myVotes = indexes;
    sfx.pop();
    // 分值读设置：写死 +1 的话，老师把参与分改成 2 分，同学看到的提示还是旧的
    toast(`提交成功 +${rule('vote', 1)} 分`, 'ok');
    if (state && state.activity) renderPoll(state.activity, state);
  });
}

/**
 * 公布 / 收起答案。
 * 服务端用 -1 表示「收起」（和 poll:stopped 一致），所以这里要能双向切换——
 * 老师公布一次再收起来，同学这边不能还挂着答案。
 */
function onReveal(d = {}) {
  if (!state || !state.activity) return;
  const act = state.activity;
  const revealed = d.revealed !== false && d.correct !== -1;
  act.revealed = revealed;

  if (act.format === 'text') {
    if (revealed && d.answerText !== undefined) act.answerText = d.answerText;
    renderText(act, state);
    return;
  }
  if (revealed && Number.isInteger(d.correct)) act.correct = d.correct;
  act.open = false;
  renderPoll(act, state);
  if (revealed && myVotes.length === 1 && myVotes[0] === act.correct) {
    toast(`答对了！+${rule('voteCorrect', 2)} 分 🎉`, 'ok');
    sfx.success();
  }
}

/* ---------- 词云 ---------- */
function renderWord(act, s) {
  $('#m-word-prompt').textContent = act.prompt || '说说你的想法';
  const tags = ['数据清洗很重要', '有点难', '听懂了', '想多练练', 'Excel', 'Power Query', '有意思', '还想再讲讲'];
  if (!$('#m-word-tags').dataset.done) {
    $('#m-word-tags').innerHTML = tags.map((t) => `<button class="m-tag">${esc(t)}</button>`).join('');
    $$('#m-word-tags .m-tag').forEach((b) => (b.onclick = () => { $('#m-word-text').value = b.textContent; sendWord(); }));
    $('#m-word-tags').dataset.done = '1';
  }
  $('#m-my-words').innerHTML = myWords.map((w) => `<div class="m-mw">${esc(w)}</div>`).join('');
}

function sendWord() {
  const text = $('#m-word-text').value.trim();
  if (!text) return toast('请输入内容', 'warn');
  net.emit('student:word', { text }, (res) => {
    if (!res || !res.ok) return toast((res && res.msg) || '发送失败', 'err');
    myWords.push(text);
    $('#m-word-text').value = '';
    sfx.pop();
    toast('已发送，快看大屏 ✨', 'ok');
    $('#m-my-words').innerHTML = myWords.map((w) => `<div class="m-mw">${esc(w)}</div>`).join('');
  });
}
$('#m-word-send').onclick = sendWord;
$('#m-word-text').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendWord(); });

/* ---------- 抢答 ---------- */
function renderBuzz(act, s) {
  $('#m-buzz-q').textContent = act.prompt || '抢答！';
  const myRank = (act.ranks || []).findIndex((r) => r.studentId === myId) + 1;
  $('#m-buzz-rank').innerHTML = (act.ranks || []).slice(0, 5).map((r, i) =>
    `<div class="mbr ${r.studentId === myId ? 'me' : ''}">
      <span class="p">${i + 1}</span><span style="font-size:19px">${esc(r.avatar)}</span>
      <span>${esc(r.nickname)}</span><span class="s">+${buzzScore(i + 1)}</span>
    </div>`).join('');
  if (myRank) $('#m-buzz-btn').classList.add('done');
  // 抢答只抢不答，但如果老师公布了答案，同学这边也能看到
  renderRef($('#m-buzz-ref'), act);
}

$('#m-buzz-btn').onclick = () => {
  net.emit('student:buzz', {}, (res) => {
    if (!res || !res.ok) { toast((res && res.msg) || '抢答失败', 'err'); return; }
    buzzDone = true;
    $('#m-buzz-btn').classList.add('done');
    sfx.fanfare();
    const got = buzzScore(res.rank);
    toast(got ? `第 ${res.rank} 名！+${got} 分 🎉` : `第 ${res.rank} 名，本次不加分`, got ? 'ok' : 'warn');
    if (navigator.vibrate) navigator.vibrate([30, 40, 60]);
  });
};

function onBuzzRank(d) {
  if (state && state.activity) renderBuzz(state.activity, state);
}

/* ---------- 转盘 ---------- */
function renderWheel(act, s) {
  const card = $('#mv-wheel .m-wheel-card');
  card.id = 'm-wheel-card';
  $('#m-wheel-title').textContent = act.title || '提问大转盘';
  const mine = act.result && act.result.id === myId;
  if (act.result) {
    card.classList.toggle('win', mine);
    $('.m-wheel-spin').textContent = mine ? '🎉' : act.result.avatar || '🎡';
    const picked = rule('handPicked', 2);
    const bonus = picked ? `（+${picked} 分）` : '';
    $('#m-wheel-status').textContent = mine ? `恭喜，请起立回答！${bonus}` : `${act.result.nickname} 请起立回答`;
  } else {
    $('#m-wheel-status').textContent = `候选 ${(act.candidates || []).length} 人，等老师转动`;
  }
}

/* ---------- 举手 / 喝彩 ---------- */
$('#m-hand-btn').onclick = () => {
  handsUp = !handsUp;
  net.emit('student:hand', { up: handsUp }, () => {
    $('#m-hand-btn').classList.toggle('on', handsUp);
    $('#m-hand-btn').querySelector('b').textContent = handsUp ? '已举手' : '举手';
    toast(handsUp ? '已举手，等老师点名' : '已放下手', 'ok');
  });
};

$('#m-cheer-btn').onclick = () => {
  const btn = $('#m-cheer-btn');
  if (btn.classList.contains('disabled')) return; // 老师未开启，按钮已置灰，点也没用
  const kinds = ['👏', '🎉', '🔥', '👍', '💯', '🚀'];
  const kind = kinds[Math.floor(Math.random() * kinds.length)];
  net.emit('student:cheer', { kind }, (res) => {
    if (!res || !res.ok) return toast('喝彩已关闭', 'warn');
    sfx.pop();
    if (navigator.vibrate) navigator.vibrate(20);
    toast('已送出 ' + kind, 'ok', 1200);
  });
};

/* ---------- 排行榜 ---------- */
function renderRankMini(list) {
  const top = list.slice(0, 5);
  const myIdx = list.findIndex((x) => x.id === myId);
  let rows = top;
  if (myIdx >= 5) rows = [...top, list[myIdx]];
  // 榜单按累计总分排序（这是"整学期谁最认真"），但每行同时带上本次课得分，
  // 否则同学只看到自己总分没动，会以为这节课白参与了。
  $('#m-rank-mini').innerHTML = `<h4>🏆 积分榜</h4>` + rows.map((st) =>
    `<div class="mrm-row ${st.id === myId ? 'me' : ''}">
      <span class="r">${st.rank}</span><span class="a">${esc(st.avatar)}</span>
      <span class="n">${esc(st.nickname)}</span>
      <span class="s">${st.score}<em>本次 ${Number(st.sessionScore) || 0}</em></span>
    </div>`).join('');
}

function renderRank() {
  if (!state) return;
  const list = state.leaderboard || [];
  $('#m-rank-list').innerHTML = list.map((st) =>
    `<li class="${st.id === myId ? 'me' : ''}">
      <span class="rk">${st.rank}</span><span class="a">${esc(st.avatar)}</span>
      <span class="n">${esc(st.nickname)}<small>${st.seat ? `${st.seat.row + 1}排${st.seat.col + 1}座` : '未选座'}</small></span>
      <span class="s">${st.score}<em>本次 ${Number(st.sessionScore) || 0}</em></span>
    </li>`).join('') || '<li style="justify-content:center;color:var(--text-3)">还没有同学</li>';
}

/* ---------- 我的 ---------- */
function renderMe() {
  if (!state) return;
  const me = (state.leaderboard || []).find((x) => x.id === myId);
  const all = state.leaderboard || [];
  const mine = all.find((x) => x.id === myId);
  $('#m-me-av').textContent = ls.get(KEY_AV, '🦊');
  $('#m-me-name').textContent = ls.get(KEY_NICK, '我');
  $('#m-me-session').textContent = me ? (Number(me.sessionScore) || 0) : 0;
  $('#m-me-total').textContent = me ? (Number(me.score) || 0) : 0;
  const rankTxt = mine ? `第 ${mine.rank} 名` : '未上榜';
  $('#m-me-stats').innerHTML = `
    <div class="mms"><b>${mine ? mine.stats.votes : 0}</b><span>参与投票</span></div>
    <div class="mms"><b>${mine ? mine.stats.words : 0}</b><span>发言次数</span></div>
    <div class="mms"><b>${mine ? mine.stats.buzz : 0}</b><span>抢答次数</span></div>
    <div class="mms"><b>${mine ? mine.stats.picked : 0}</b><span>被点名</span></div>
    <div class="mms"><b>${mine ? mine.stats.correct : 0}</b><span>答对次数</span></div>
    <div class="mms"><b>${rankTxt}</b><span>当前排名</span></div>`;

  const g = (state.groups || []).find((g) => g.members.some((m) => m.id === myId));
  $('#m-me-group').innerHTML = g
    ? `<h4>我的小组 · ${esc(g.name)}</h4><div class="gmem">${g.members.map((m) => `<span>${esc(m.avatar)}${esc(m.nickname)}</span>`).join('')}</div>`
    : '<h4>我的小组</h4><span style="color:var(--text-3);font-size:13px">老师还没有分组</span>';
}

/**
 * 修改昵称。
 *
 * 用 prompt 而不是做一个新页面：改名是低频操作，专门为它加一整套页面不值当，
 * 而 prompt 在手机上是系统原生输入框，反而比自绘的更好用。
 * 但要兜住两点——点了取消（拿到 null）不能当成改名，改完要把 localStorage
 * 一起更新，否则下次刷新又变回旧名字，同学会以为改名没生效。
 */
$('#m-rename').onclick = () => {
  const cur = ls.get(KEY_NICK, '');
  const input = window.prompt('改成什么名字？（最多 12 个字）', cur);
  if (input === null) return;                       // 点了取消
  const next = String(input).trim().slice(0, 12);
  if (!next) return toast('昵称不能为空', 'warn');
  if (next === cur) return;

  net.emit('student:rename', { nickname: next }, (res) => {
    if (!res || !res.ok) return toast((res && res.msg) || '改名失败', 'err');
    ls.set(KEY_NICK, res.nickname);
    if (res.avatar) ls.set(KEY_AV, res.avatar);
    $('#m-me-name').textContent = res.nickname;
    $('#m-top-name').textContent = res.nickname;
    if (state) renderMe();
    // 撞名要提醒本人：老师点名时会分不清是谁，但服务端是放行了的
    if (res.clash) toast(`已改为「${res.nickname}」，但课堂里已经有同学用这个名字了`, 'warn', 4000);
    else toast(`已改名为「${res.nickname}」`, 'ok');
  });
};

$('#m-leave').onclick = () => {
  ls.del(KEY_ID);
  myId = null;
  location.reload();
};

/* ================= 启动 ================= */

async function boot() {
  try {
    const meta = await fetch(`/api/room/${code}`).then((r) => r.json());
    if (meta.error) { toast(meta.error, 'err'); return; }
    $('#m-room-title').textContent = meta.title || '课堂互动';
    document.title = meta.title || '课堂互动';
  } catch (e) { /* 忽略 */ }

  if (myId) {
    net.connect();
  } else {
    showPage('m-join');
  }
}
boot();
