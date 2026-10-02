/* ==========================================================
   大屏呈现端主控
   ========================================================== */
import { Net, StarField, Sfx, sfx, toast, $, $$, esc, fmtTime, fmtClock, qs, ls } from './common.js';
import { WordCloud } from './viz-wordcloud.js';
import { Danmaku } from './viz-danmaku.js';
import { Wheel } from './viz-wheel.js';
import { BarChart, SeatMap, Confetti } from './viz-misc.js';

const code = (qs('room') || ls.get('last_room', '') || '').toUpperCase();
if (code) ls.set('last_room', code);

/* ---------- 背景与特效 ---------- */
const stars = new StarField($('#fx-canvas'));
const confetti = new Confetti($('#confetti-canvas'));

/* ---------- 网络 ---------- */
const net = new Net();
net.on('__connect', () => {
  $('#wb-net').textContent = '已连接';
  $('#wb-net').className = 'ok';
  join();
  sfx._ensure();
});
net.on('__disconnect', () => {
  $('#wb-net').textContent = '连接中断';
  $('#wb-net').className = 'bad';
});
net.onReconnect = () => join();

net.on('state', onState);
net.on('student:new', onStudentNew);
net.on('poll:started', () => { sfx.pop(); flash('新投票开始了'); });
net.on('poll:update', (d) => onPollUpdate(d));
net.on('poll:reveal', (d) => { bars.reveal(d.correct); sfx.success(); });
net.on('poll:stopped', () => { bars.reveal(-1); });
net.on('word:started', (d) => {
  // 新一轮开始时清空上一轮的累积
  wordItems = [];
  cloud.clear();
  $('#word-prompt').textContent = d.prompt;
  $('#word-count').textContent = '0';
  $('#word-people').textContent = '0';
  sfx.pop();
});
net.on('word:new', onWordNew);
net.on('word:hidden', onWordHidden);
net.on('word:stopped', () => {});
net.on('buzz:started', (d) => {
  $('#buzz-q').textContent = d.prompt;
  renderBuzzExtras({ format: d.format, options: d.options, revealed: false });
  sfx.fanfare();
});
net.on('buzz:reveal', () => { if (state) onState(state); sfx.success(); });

/**
 * 抢答的题目展示与公布答案。
 * 抢答按约定「只抢不答」，所以选项只是挂出来让全班看清题目，同学不用选；
 * 老师判定完之后再决定要不要公布答案。
 */
function renderBuzzExtras(act) {
  const fmt = act.format || 'text';
  const opts = (fmt === 'choice' || fmt === 'judge') ? (act.options || []) : [];
  const box = $('#buzz-options');
  box.classList.toggle('hidden', !opts.length);
  box.innerHTML = opts
    .map((o, i) => `<span class="buzz-opt">${String.fromCharCode(65 + i)}. ${esc(o.text)}</span>`)
    .join('');
  const el = $('#buzz-answer-ref');
  const txt = act.revealed ? answerTextOf(act) : '';
  el.textContent = txt;
  el.classList.toggle('hidden', !txt);
}
net.on('buzz:rank', onBuzzRank);
net.on('buzz:reset', () => renderBuzz([]));
net.on('wheel:opened', onWheelOpened);
net.on('wheel:spin', onWheelSpin);
net.on('wheel:closed', () => { $('#wheel-result').classList.remove('show'); });
net.on('cheer:burst', onCheer);
net.on('timer:sync', onTimer);
net.on('group:made', (d) => { forcedView = null; renderGroups(d.groups); });
net.on('effect', onEffect);
net.on('wall:show', (d) => { forcedView = d.view || null; setView(forcedView || 'idle'); });
net.on('wall:msg', (d) => { $('#wb-msg').textContent = d.text || ''; });

// 暂停/继续：活动还在（结果保留在屏上），只是不能提交了，重刷一次状态即可
net.on('activity:paused', () => { if (state) onState(state); });
net.on('activity:resumed', () => { if (state) onState(state); });

// 老师清空了课堂：本地缓存的词云要一起清掉，否则会残留上一批同学的发言
net.on('room:reset', () => {
  wordItems = [];
  cloud.clear();
  lastSeatCount = 0;
  if (state) onState(state);
});

// 开始新的一课：上一节的词云不该留到这一节
net.on('session:new', () => {
  wordItems = [];
  cloud.clear();
});

// 同学退出座位：立刻重绘座位图，不然空出来的位置还显示着人
net.on('seat:released', () => { if (state) renderSeat(state); });

net.connect();

function join() {
  if (!code) { $('#w-status').textContent = '缺少课堂码，请从控制端打开大屏'; return; }
  net.emit('wall:join', { code }, (res) => {
    if (!res || !res.ok) {
      $('#w-status').textContent = (res && res.msg) || '加入失败';
      return;
    }
    $('#w-qr').src = `/api/room/${code}/qrcode.png?t=${Date.now()}`;
    $('#w-qr-big').src = `/api/room/${code}/qrcode.png?t=${Date.now()}`;
    onState(res.state);
  });
}

/* ---------- 可视化实例 ---------- */
const bars = new BarChart($('#poll-bars'), { onCountChange: () => sfx.tick() });
const cloud = new WordCloud($('#word-cloud'), { minSize: 28, maxSize: 132 });
const danmaku = new Danmaku($('#danmaku-layer'));
const seatmap = new SeatMap($('#seat-map'));
const wheel = new Wheel($('#wheel-canvas'), {
  onTick: () => sfx.tick(),
  onSettle: onWheelSettle,
});

/* ---------- 状态 ---------- */
let state = null;
let forcedView = null;
let wordItems = [];
let lastRanks = [];
let lastSeatCount = 0;

/**
 * 读取本课堂的分值设置。大屏上所有「+N 分」都要走这里。
 * 投影出去的字全班都看得见，写死数字而设置里改了，等于当众报错分数。
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

/**
 * 大屏拿到的 buzz 列表行可能带 `awarded`（老师已判定的最终分）。
 * 老快照/老广播没这个字段，按"待判定"渲染，让同学知道现在抢到不等于拿分。
 */
function buzzLineText(r) {
  if (r && r.awarded !== undefined && r.awarded !== null) {
    return `${r.awarded >= 0 ? '+' : ''}${r.awarded} 分`;
  }
  return '待老师判定';
}

function onState(s) {
  const prev = state;
  state = s;
  $('#w-title').textContent = s.title || '课堂互动';
  $('#w-code').textContent = s.code || '------';
  $('#w-code-big').textContent = s.code || '------';

  $('#w-online').textContent = s.stats.online;
  $('#w-hands').textContent = s.stats.hands;
  $('#w-frontrate').innerHTML = `${s.stats.seat.rate}<i>%</i>`;
  $('#w-idle-count').textContent = s.stats.seat.total;

  renderIdleAvatars(s);
  renderRank(s.leaderboard || []);
  renderHands(s.hands || []);

  // 视图优先级：进行中的活动 > 教师手动指定（座位/分组）> 有分组则显示分组 > 待机
  const act = s.activity;
  let view = null;
  if (act && (act.type === 'poll' || act.type === 'quiz')) view = 'poll';
  else if (act && act.type === 'word') view = 'word';
  else if (act && act.type === 'wheel') view = 'wheel';
  else if (act && act.type === 'buzz') view = 'buzz';
  else view = forcedView || (s.groups && s.groups.length ? 'group' : 'idle');
  setView(view);

  if (act && (act.type === 'poll' || act.type === 'quiz')) renderPoll(act, s);
  if (act && act.type === 'word') { syncWord(act); }
  if (act && act.type === 'wheel' && !act.spinning) syncWheel(act);
  if (act && act.type === 'buzz') { renderBuzz(act.ranks || []); renderBuzzExtras(act); }

  renderSeat(s);
  if (s.groups && s.groups.length) renderGroups(s.groups);

  $('#w-status').textContent = statusText(s);
}

function statusText(s) {
  if (!s.activity) return s.stats.online ? `${s.stats.online} 位同学已就坐，等待老师开始` : '等待同学加入…';
  const act = s.activity;
  // 暂停时结果仍留在屏上，底栏要明确说"已暂停 · 可看结果"，
  // 否则同学以为还在进行中、一直刷新手机等提交。
  if (act.paused) {
    const p = { poll: '投票已暂停 · 以下是当前结果', quiz: '小测已暂停 · 以下是当前结果', word: '词云已暂停 · 以下是当前结果', buzz: '抢答已暂停 · 以下是当前结果' };
    return p[act.type] || '已暂停 · 以下是当前结果';
  }
  const t = { poll: '投票进行中', quiz: '随堂小测进行中', word: '词云 / 弹幕进行中', wheel: '大转盘准备中', buzz: '抢答进行中' };
  return t[act.type] || '活动进行中';
}

/* ---------- 视图切换 ---------- */
function setView(v) {
  if (!v) return;
  $$('.view').forEach((el) => el.classList.toggle('active', el.id === `view-${v}`));
  document.body.dataset.view = v;
  if (v === 'word') setTimeout(() => cloud.relayout(), 60);
  if (v === 'wheel') setTimeout(() => wheel.draw(), 60);
  if (v === 'seat') setTimeout(() => renderSeat(state), 60);
}

function flash(text) {
  $('#wb-msg').textContent = text;
}

/* ---------- 待机头像 ---------- */
function renderIdleAvatars(s) {
  const box = $('#idle-avatars');
  // 优先用完整名册（wall 视图的 roster），否则退回排行榜
  const list = (s.roster && s.roster.length ? s.roster : s.leaderboard || []).slice(0, 24);
  const sig = list.map((x) => x.id).join(',') + '|' + list.length;
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  const prevIds = new Set($$('.join-avatar', box).map((e) => e.dataset.id));
  box.innerHTML = '';
  list.forEach((st, i) => {
    const el = document.createElement('div');
    el.className = 'join-avatar' + (prevIds.has(st.id) ? '' : ' n');
    el.dataset.id = st.id;
    el.dataset.name = st.nickname;
    el.textContent = st.avatar;
    el.style.borderColor = st.color;
    el.style.animationDelay = (i % 12) * 40 + 'ms';
    box.appendChild(el);
  });
}

/* ---------- 学生加入气泡 ---------- */
function onStudentNew(st) {
  const layer = $('#join-float');
  const el = document.createElement('div');
  el.className = 'join-bubble';
  el.style.left = 6 + Math.random() * 62 + '%';
  el.innerHTML = `<span style="font-size:24px">${esc(st.avatar)}</span><span>${esc(st.nickname)}</span><span style="color:var(--green);font-size:14px">+${rule('join', 1)}</span>`;
  layer.appendChild(el);
  setTimeout(() => el.remove(), 3500);
  sfx.pop();
}

/* ---------- 投票 ---------- */
const FMT_NAME = { choice: '选择题', judge: '判断题', text: '简答题' };

function renderPoll(act, s) {
  $('#poll-question').textContent = act.question || '请选择你的答案';
  const fmt = act.format || 'choice';
  const badge = $('#poll-badge');
  // 小测保留「小测」字样（教师和自动化都靠它区分），后面再挂题型
  badge.textContent = act.type === 'quiz'
    ? `小测 · ${FMT_NAME[fmt] || ''}`.trim()
    : (FMT_NAME[fmt] || '投票');
  badge.className = 'poll-badge' + (act.type === 'quiz' ? ' quiz' : '');

  // 简答题没有柱子，改成实名答案墙；选择题/判断题照旧走柱状图
  const isText = fmt === 'text';
  $('#poll-bars').classList.toggle('hidden', isText);
  $('#poll-answers').classList.toggle('hidden', !isText);
  if (isText) {
    renderAnswerWall(act.answers || []);
  } else {
    bars.setData({
      options: act.options || [],
      totalVotes: act.totalVotes || 0,
      onlineCount: s.stats.online,
      multi: act.multi,
    });
  }

  // 公布答案：老师可能选择不公布，所以只在 revealed 时才显示
  renderAnswerRef(act);

  const voted = act.totalVotes || 0;
  const online = Math.max(1, s.stats.online);
  const pct = Math.min(100, Math.round((voted / online) * 100));
  $('#pp-fill').style.width = pct + '%';
  $('#pp-text').textContent = `${voted} / ${s.stats.online} 已作答`;
  $('#poll-hint').textContent = act.open
    ? (isText ? '扫码输入你的答案' : act.multi ? '可多选 · 扫码提交' : '扫码选择你的答案')
    : (act.paused ? '⏸ 老师已暂停作答 · 以下是当前结果' : '已结束');
}

/** 简答题答案墙：同学们的文字答案实名平铺，方便老师点名讲评 */
function renderAnswerWall(answers) {
  const box = $('#poll-answers');
  if (!answers.length) {
    box.innerHTML = '<div class="ans-empty">还没有同学提交答案</div>';
    return;
  }
  box.innerHTML = answers.slice(-24).map((a) => `
    <div class="ans-item">
      <span class="ans-av">${esc(a.avatar || '🙂')}</span>
      <b>${esc(a.nickname || '?')}</b>
      <span class="ans-text">${esc(a.text)}</span>
    </div>`).join('');
}

/**
 * 公布答案区。
 * 选择题/判断题显示「正确答案：B. xxx」，简答题显示参考答案。
 * 没公布（revealed 为假）就什么都不显示——老师可以选择不公布。
 */
function renderAnswerRef(act) {
  const el = $('#poll-answer-ref');
  if (!act.revealed) { el.textContent = ''; el.classList.add('hidden'); return; }
  const txt = answerTextOf(act);
  el.textContent = txt;
  el.classList.toggle('hidden', !txt);
}

/** 按题型拼出「正确答案 / 参考答案」文案；没设答案则返回空串 */
function answerTextOf(act) {
  const fmt = act.format || 'choice';
  if (fmt === 'text') return act.answerText ? `参考答案：${act.answerText}` : '';
  const i = act.correct;
  if (Number.isInteger(i) && act.options && act.options[i]) {
    return `正确答案：${String.fromCharCode(65 + i)}. ${act.options[i].text}`;
  }
  return '';
}

function onPollUpdate(d) {
  bars.setData({ options: d.options, totalVotes: d.totalVotes, onlineCount: d.onlineCount });
  const voted = d.totalVotes || 0;
  const online = Math.max(1, d.onlineCount);
  $('#pp-fill').style.width = Math.min(100, Math.round((voted / online) * 100)) + '%';
  $('#pp-text').textContent = `${voted} / ${d.onlineCount} 已作答`;
}

/* ---------- 词云 / 弹幕 ---------- */
function syncWord(act) {
  $('#word-prompt').textContent = act.prompt || '';
  const items = act.items || [];
  if (items.length !== wordItems.length) {
    wordItems = items;
    if (act.mode !== 'danmaku') cloud.setWords(items);
    $('#word-count').textContent = items.length;
    const people = new Set(items.map((i) => i.studentId)).size;
    $('#word-people').textContent = people;
  }
}

function onWordNew(item) {
  if (!state || !state.activity) return;
  const mode = state.activity.mode || 'both';
  wordItems.push(item);
  if (mode !== 'danmaku') cloud.setWords(wordItems);
  if (mode !== 'cloud') danmaku.push(item);
  $('#word-count').textContent = wordItems.length;
  $('#word-people').textContent = new Set(wordItems.map((i) => i.studentId)).size;
  sfx.pop();
}

/** 老师屏蔽了某条内容：本地已渲染的立刻撤下，不让它继续挂在大屏上 */
function onWordHidden({ text } = {}) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return;
  const before = wordItems.length;
  wordItems = wordItems.filter((i) => String(i.text || '').trim().toLowerCase() !== t);
  if (wordItems.length === before) return;
  const mode = (state && state.activity && state.activity.mode) || 'both';
  if (mode !== 'danmaku') cloud.setWords(wordItems);
  if (mode !== 'cloud') danmaku.removeByText(text);
  $('#word-count').textContent = wordItems.length;
  $('#word-people').textContent = new Set(wordItems.map((i) => i.studentId)).size;
}

/* ---------- 抢答 ---------- */
function renderBuzz(ranks) {
  const box = $('#buzz-podium');
  const slots = [
    { cls: 'r2', label: '2' },
    { cls: 'r1', label: '1' },
    { cls: 'r3', label: '3' },
  ];
  const byRank = new Map((ranks || []).map((r) => [r.rank, r]));
  box.innerHTML = '';
  slots.forEach((sl) => {
    const rank = Number(sl.label);
    const r = byRank.get(rank);
    const el = document.createElement('div');
    el.className = `buzz-slot ${sl.cls}` + (r ? '' : ' empty');
    el.innerHTML = `
      <div class="bz-rank">${sl.label}</div>
      ${r ? `<div class="bz-av">${esc(r.avatar)}</div><div class="bz-name">${esc(r.nickname)}</div><div class="bz-score">${esc(buzzLineText(r))}</div>`
          : `<div class="bz-av" style="opacity:.3">⏳</div><div class="bz-name" style="opacity:.4">虚位以待</div>`}
    `;
    box.appendChild(el);
  });
}

function onBuzzRank(d) {
  renderBuzz([...(state && state.activity && state.activity.ranks ? state.activity.ranks : []), d]);
  if (d.rank === 1) { sfx.fanfare(); confetti.burst({ count: 70 }); }
  else sfx.success();
}

/* ---------- 大转盘 ---------- */
function onWheelOpened(d) {
  wheel.setCandidates(d.candidates || []);
  $('#wheel-result').classList.remove('show');
  const list = $('#wheel-list');
  list.innerHTML = '';
  (d.candidates || []).forEach((c, i) => {
    const li = document.createElement('li');
    li.dataset.id = c.id;
    li.innerHTML = `<span class="wl-i">${i + 1}</span><span style="font-size:24px">${esc(c.avatar)}</span><span>${esc(c.nickname)}</span>`;
    list.appendChild(li);
  });
  $('#wheel-title').textContent = d.title || '今天谁来回答？';
}

function syncWheel(act) {
  if (!act.candidates) return;
  const cur = wheel.candidates.map((c) => c.id).join(',');
  if (cur !== act.candidates.map((c) => c.id).join(',')) {
    wheel.setCandidates(act.candidates);
  }
  $$('#wheel-list li').forEach((li, i) => {
    li.classList.toggle('picked', (act.picked || []).includes(li.dataset.id));
  });
  $('#wheel-title').textContent = act.title || '今天谁来回答？';
}

function onWheelSpin(d) {
  forcedView = null;
  setView('wheel');
  $('#wheel-result').classList.remove('show');
  sfx.drumroll(4.6);
  wheel.spin(d.index, { turns: 5, duration: 5000 });
  $$('#wheel-list li').forEach((li) => li.classList.remove('hit'));
}

function onWheelSettle(index) {
  const c = wheel.candidates[index];
  if (!c) return;
  $('#wr-avatar').textContent = c.avatar || '🎉';
  $('#wr-name').textContent = c.nickname || '—';
  $('#wr-sub').textContent = c.seat ? `${c.seat.row + 1} 排 ${c.seat.col + 1} 座 · 请起立回答` : '请起立回答';
  $('#wheel-result').classList.add('show');
  const li = $$('#wheel-list li')[index];
  if (li) li.classList.add('hit');
  sfx.fanfare();
  confetti.cannons(70);
  setTimeout(() => confetti.burst({ count: 90, spread: 1.3 }), 420);
}

/* ---------- 喝彩 ---------- */
function onCheer(d) {
  const layer = $('#effect-layer');
  const el = document.createElement('div');
  el.style.cssText = `position:absolute;left:${20 + Math.random() * 60}%;bottom:20%;font-size:70px;animation:bubble-up 2.4s var(--ease) both;filter:drop-shadow(0 0 20px rgba(251,191,36,.7))`;
  el.textContent = d.kind || '👏';
  layer.appendChild(el);
  setTimeout(() => el.remove(), 2500);
  confetti.burst({ x: Math.random() * innerWidth, y: innerHeight * 0.6, count: 22, spread: 0.7 });
}

/* ---------- 座位 ---------- */
function renderSeat(s) {
  if (!s) return;
  seatmap.render({ seatMap: s.seatMap, seats: s.seats || [] });
  $('#seat-map').style.setProperty('--cols', s.seatMap.cols);
  const rate = s.stats.seat.rate;
  $('#sr-fill').style.width = rate + '%';
  $('#sr-num').textContent = rate + '%';
  const cheers = [
    '前排视野好、互动多，还有额外积分哦 ✨',
    '坐前排的同学更容易被老师记住 🏅',
    // 分值读设置：投影出去的字全班都看得见，写死会和老师的设置对不上
    `前排就坐 +${rule('seatFront', 3)} 分，还能优先被转盘选中 🎯`,
    '今天的勇气，从换到前排开始 💪',
  ];
  $('#seat-cheer').textContent = s.stats.seat.front === 0
    ? '还没有人坐前排 —— 第一个吃螃蟹的同学有额外惊喜 🎁'
    : cheers[Math.min(cheers.length - 1, Math.floor(rate / 26))];

  if (s.stats.seat.total > lastSeatCount && lastSeatCount > 0) sfx.pop();
  lastSeatCount = s.stats.seat.total;
}

/* ---------- 分组 ---------- */
function renderGroups(groups) {
  if (!groups || !groups.length) return;
  const box = $('#group-grid');
  box.innerHTML = '';
  groups.forEach((g, i) => {
    const el = document.createElement('div');
    el.className = 'group-card';
    el.style.setProperty('--gc', g.color);
    el.style.animationDelay = i * 80 + 'ms';
    el.innerHTML = `<h5>${esc(g.name)} · ${g.members.length} 人</h5>
      <div class="group-members">
        ${g.members.map((m) => `<span class="gm"><span style="font-size:19px">${esc(m.avatar)}</span>${esc(m.nickname)}</span>`).join('')}
      </div>`;
    box.appendChild(el);
  });
  sfx.success();
}

/* ---------- 排行榜（FLIP 动画） ---------- */
function renderRank(list) {
  const ol = $('#rank-list');
  const prevPos = new Map();
  $$('#rank-list li').forEach((li) => prevPos.set(li.dataset.id, li.getBoundingClientRect().top));

  const sig = list.map((x) => `${x.id}:${x.score}:${Number(x.sessionScore) || 0}`).join('|');
  if (ol.dataset.sig === sig) return;
  const prevSig = new Set((ol.dataset.ids || '').split(',').filter(Boolean));
  ol.dataset.sig = sig;
  ol.dataset.ids = list.map((x) => x.id).join(',');

  ol.innerHTML = '';
  list.forEach((st) => {
    const li = document.createElement('li');
    li.dataset.id = st.id;
    li.innerHTML = `
      <span class="rk">${st.rank}</span>
      <span class="rav">${esc(st.avatar)}</span>
      <span class="rname">${esc(st.nickname)}${st.seat ? `<span style="color:var(--text-3);font-size:13px;font-weight:600"> ${st.seat.row + 1}排</span>` : ''}</span>
      <span class="rscore"><b>${st.score}</b><em>本次 ${Number(st.sessionScore) || 0}</em></span>`;
    ol.appendChild(li);
  });

  // FLIP
  $$('#rank-list li').forEach((li) => {
    const old = prevPos.get(li.dataset.id);
    if (old === undefined) return;
    const now = li.getBoundingClientRect().top;
    const dy = old - now;
    if (Math.abs(dy) < 1) return;
    li.style.transition = 'none';
    li.style.transform = `translateY(${dy}px)`;
    requestAnimationFrame(() => {
      li.style.transition = 'transform 0.6s cubic-bezier(.22,1,.36,1)';
      li.style.transform = '';
    });
  });

  // 分数变化闪一下（含本次分变化）
  list.forEach((st) => {
    const prev = lastRanks.find((x) => x.id === st.id);
    const sess = Number(st.sessionScore) || 0;
    if (prev && (prev.score !== st.score || (Number(prev.sessionScore) || 0) !== sess)) {
      const li = $(`#rank-list li[data-id="${st.id}"]`);
      if (li) { li.classList.add('flash'); setTimeout(() => li.classList.remove('flash'), 900); }
    }
  });
  lastRanks = list.map((x) => ({ id: x.id, score: x.score, sessionScore: Number(x.sessionScore) || 0 }));
}

function renderHands(hands) {
  const box = $('#hands-list');
  const sig = hands.map((h) => h.id).join(',');
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  $('#hands-count').textContent = hands.length;
  box.innerHTML = hands.map((h) => `<span class="hand-chip"><span style="font-size:20px">${esc(h.avatar)}</span>${esc(h.nickname)}</span>`).join('');
}

/* ---------- 计时器 ---------- */
function onTimer(t) {
  const el = $('#wb-timer');
  if (!t || (!t.running && t.remain <= 0)) { el.classList.remove('show'); return; }
  el.classList.add('show');
  el.classList.toggle('warn', t.remain <= 10);
  $('#timer-text').textContent = fmtTime(t.remain);
  if (t.remain <= 5 && t.remain > 0 && Number(el.dataset.last) !== t.remain) sfx.tick();
  el.dataset.last = t.remain;
}

/* ---------- 特效 ---------- */
function onEffect(d) {
  const layer = $('#effect-layer');
  const el = document.createElement('div');
  el.className = 'effect-text' + (d.kind === 'cool' ? ' cool' : '') + ((d.text || '').length > 6 ? ' small' : '');
  el.textContent = d.text || (d.kind === 'timeup' ? '时间到' : '🎉');
  layer.appendChild(el);
  setTimeout(() => el.remove(), 2200);
  if (d.kind === 'celebrate') { sfx.fanfare(); confetti.cannons(80); }
  else if (d.kind === 'timeup') { sfx.fanfare(); confetti.burst({ count: 60 }); }
  else sfx.success();
}

/* ---------- 自适应缩放 ---------- */
function fit() {
  const s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
  $('#stage-scale').style.transform = `scale(${s}) translate(-50%, -50%)`;
}
window.addEventListener('resize', fit);
fit();

/* ---------- 时钟 ---------- */
setInterval(() => { $('#wb-clock').textContent = fmtClock(Date.now()); }, 10000);
$('#wb-clock').textContent = fmtClock(Date.now());

/* ---------- 快捷键 ---------- */
window.addEventListener('keydown', (e) => {
  if (e.key === 'f' || e.key === 'F') {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
    else document.exitFullscreen?.();
  }
  if (e.key === 'm' || e.key === 'M') sfx.toggle();
});

document.addEventListener('click', () => sfx._ensure(), { once: true });
