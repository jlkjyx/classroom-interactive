/* ==========================================================
   教师控制端主控
   ========================================================== */
import { Net, StarField, sfx, toast, $, $$, esc, fmtTime, fmtClock, qs, ls } from './common.js';

const stars = new StarField($('#fx-canvas'), { count: 46 });

let code = '';
let token = '';
let state = null;
let currentTab = 'poll';

/**
 * 统一处理服务端回执，再决定弹什么提示。
 *
 * 之前所有按钮清一色写成 (res) => toast('操作成功')，压根不看 res.ok。
 * 后果：服务端因为设置开关、状态冲突等原因拒绝时，控制端照样弹"抢答开始！"，
 * 老师以为生效了，其实什么都没发生——而且没有任何线索可查。
 * 现在统一先判失败（红色提示 + 服务端给的中文原因），成功才走各自的逻辑。
 */
function ackToast(okMsg, onOk) {
  return (res) => {
    if (res && res.ok === false) return toast(res.msg || '操作未生效', 'err');
    // 先给反馈再跑回调。原来写成 if (onOk) return onOk(res); if (okMsg) toast(...)，
    // 一旦传了回调就把成功提示吞了——老师点了「保存设置」却什么都没弹，
    // 会以为没保存住而反复点。
    if (okMsg) toast(okMsg, 'ok');
    if (onOk) return onOk(res);
  };
}

const net = new Net();
net.on('__connect', () => { $('#c-status').textContent = '已连接'; join(); });
net.on('__disconnect', () => { $('#c-status').textContent = '连接中断，重连中…'; });
net.onReconnect = join;
net.on('state', onState);
net.on('poll:update', (d) => renderMiniBars(d.options, state && state.activity ? state.activity.correct : null));
net.on('word:new', (item) => addWordChip(item));
net.on('buzz:rank', (d) => { sfx.success(); });
net.on('wheel:opened', () => {});
net.on('wheel:spin', (d) => { $('#wh-avatar').textContent = '🎡'; $('#wh-name').textContent = '转动中…'; $('#wh-seat').textContent = '别眨眼'; });
net.on('timer:sync', (t) => renderTimer(t));
net.on('kicked', () => toast('你已被移出课堂', 'err'));
net.on('activity:paused', () => { toast('已暂停作答，结果保留在大屏', 'ok'); syncPauseButtons(); });
net.on('activity:resumed', () => { toast('已继续作答', 'ok'); syncPauseButtons(); });
net.on('session:new', (d) => toast(`第 ${d.sessionNo} 课开始`, 'ok'));
net.on('room:reset', () => { toast('课堂数据已清空', 'ok'); });

/**
 * 读取本课堂的分值。所有展示「+N 分」的地方都必须走这里，
 * 不能写死数字——老师在设置页改了分值，界面上还显示旧数字，
 * 就会被当成"设置没生效"来报 bug。
 * 设置里没这个键（旧快照恢复的课堂）时退回默认值。
 */
function rule(key, fallback) {
  const rules = state && state.settings && state.settings.scoreRules;
  const v = rules ? Number(rules[key]) : NaN;
  return Number.isFinite(v) ? v : fallback;
}

/** 前排奖励按钮的分值（手动加分），默认 2 */
function rewardScore() {
  return rule('frontReward', 2);
}

/* ================= 建课堂 ================= */

async function createRoom() {
  const title = $('#gate-title').value.trim() || '课堂互动';
  const rows = Number($('#gate-rows').value) || 6;
  const cols = Number($('#gate-cols').value) || 8;
  const frontRows = Number($('#gate-front').value) || 2;
  const teacherPass = $('#gate-pass').value.trim();
  try {
    const res = await fetch('/api/room', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, rows, cols, frontRows, teacherPass }),
    }).then((r) => r.json());
    code = res.code;
    token = res.token;
    ls.set(`tok_${code}`, token);
    ls.set(`pass_${code}`, res.pass);
    ls.set('last_room', code);
    enterConsole();
    // 口令是老师换设备进控制端的凭证，创建后必须让老师看得见、记得住。
    toast(`教师口令：${res.pass}（换设备进入控制端用，可在「设置」里改）`, 'ok', 9000);
  } catch (e) {
    toast('创建失败：' + e.message, 'err');
  }
}

function enterConsole() {
  $('#gate').classList.add('hidden');
  $('#console').classList.remove('hidden');
  $('#c-code').textContent = code;
  $('#c-qr').src = `/api/room/${code}/qrcode.png?t=${Date.now()}`;
  net.connect();
}

function join() {
  if (!code) return;
  token = ls.get(`tok_${code}`, token);
  const pass = $('#gate-pass-enter').value.trim() || ls.get(`pass_${code}`, '');
  net.emit('control:join', { code, token, pass }, (res) => {
    if (!res || !res.ok) {
      toast((res && res.msg) || '加入失败', 'err');
      $('#c-status').textContent = (res && res.msg) || '加入失败';
      if (res && res.msg && (res.msg.includes('令牌') || res.msg.includes('口令') || res.locked)) {
        $('#console').classList.add('hidden');
        $('#gate').classList.remove('hidden');
      }
      return;
    }
    if (res.token) { token = res.token; ls.set(`tok_${code}`, token); }
    onState(res.state);
  });
}

$('#gate-create').onclick = createRoom;
$('#gate-enter').onclick = () => {
  const c = ($('#gate-code').value || '').trim().toUpperCase();
  if (c.length !== 6) return toast('请输入 6 位课堂码', 'err');
  code = c;
  enterConsole();
};
$('#gate-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#gate-enter').click(); });
$('#gate-pass-enter').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#gate-enter').click(); });

/* ================= 状态渲染 ================= */

function onState(s) {
  state = s;
  $('#c-title').textContent = s.title || '课堂互动';
  $('#c-online').textContent = s.stats.online;
  $('#c-seated').textContent = s.stats.seat.total;
  $('#c-front').textContent = s.stats.seat.rate + '%';
  $('#c-hands').textContent = s.stats.hands;

  renderRank(s.leaderboard || []);
  renderHands(s.students || []);
  renderLog(s.log || []);
  renderStudents();
  renderSeatPreview();
  renderGroupsPreview(s.groups || []);
  renderFrontRank();
  renderTimer(s.timer);

  // 活动面板同步：服务端一旦推来活动状态，控制端的输入框就要对应回填，
  // 否则「从题库发布」后老师切回面板，看到题干/选项都是空的，会以为没发布成功。
  const act = s.activity;
  if (act && (act.type === 'poll' || act.type === 'quiz')) {
    // 答案只在老师点过「公布答案」之后才显示——结束本身不公布，老师有选择权
    if (act.format === 'text') renderTextAnswers(act.answers);
    else renderMiniBars(act.options || [], act.revealed ? act.correct : null);
    $('#p-count').textContent = `${act.totalVotes || 0} / ${s.stats.online}`;
    $('#p-question').value = act.question || '';
    if (act.format) $('#p-format').value = act.format;
    if (document.activeElement !== $('#p-answer')) $('#p-answer').value = act.answerText || '';
    // 判断题的选项是服务端固定的，别拿它回填到选项框里
    if (act.format !== 'judge' && act.options) $('#p-options').value = act.options.map((o) => o.text).join('\n');
    syncPollFormat();
    $('#p-correct').value = act.correct === null || act.correct === undefined ? '' : String(act.correct);
    $('#p-multi').value = act.multi ? '1' : '0';
  }
  if (act && act.type === 'word') {
    $('#w-count').textContent = `${(act.items || []).length} 条`;
    renderWordChips(act.items || []);
    $('#w-prompt').value = act.prompt || '';
  }
  if (act && act.type === 'wheel') {
    renderCands(act.candidates || [], act.picked || []);
    if (act.result) {
      const w = act.result;
      $('#wh-avatar').textContent = w.avatar || '🎉';
      $('#wh-name').textContent = w.nickname || '—';
      $('#wh-seat').textContent = w.seat ? `${w.seat.row + 1} 排 ${w.seat.col + 1} 座` : '未选座';
    }
    $('#wh-title').value = act.title || '';
  }
  if (act && act.type === 'buzz') {
    renderBuzzList(act.ranks || []);
    $('#b-prompt').value = act.prompt || '';
    if (act.format) { $('#b-format').value = act.format; syncBuzzFormat(); }
    if (act.format === 'choice' && act.options) $('#b-options').value = act.options.map((o) => o.text).join('\n');
    rebuildBuzzCorrectOptions();
    $('#b-correct').value = act.correct === null || act.correct === undefined ? '' : String(act.correct);
    if (document.activeElement !== $('#b-answer')) $('#b-answer').value = act.answerText || '';
  }

  // 公布答案按钮的文案随当前状态切换（已公布 → 「收起答案」）
  syncRevealButtons();

  // 设置回填
  if (document.activeElement !== $('#set-title')) $('#set-title').value = s.title || '';
  $('#set-danmaku').checked = !!s.settings.danmakuEnabled;
  $('#set-cheer').checked = !!s.settings.cheerEnabled;
  $('#set-buzz').checked = !!s.settings.buzzEnabled;
  $('#set-multivote').checked = !!s.settings.allowMultiVote;
  if (document.activeElement !== $('#set-maxlen')) $('#set-maxlen').value = s.settings.maxWordLen;
  // 口令回填：只读显示，避免每次状态同步把正在输入的修改口令覆盖掉
  if (document.activeElement !== $('#set-pass') && !$('#set-pass').dataset.editing) {
    $('#set-pass').value = s.teacherPass || '';
  }
  // 前排加分 / 后排排数：之前这两个输入框是死控件——HTML 里有，但 JS 既不回填
  // 也不提交，老师改了保存根本不生效。这里补上回填。
  const rules = s.settings.scoreRules || {};
  if (document.activeElement !== $('#set-score-front')) {
    $('#set-score-front').value = rules.seatFront !== undefined ? rules.seatFront : 3;
  }
  if (document.activeElement !== $('#set-backrows')) {
    $('#set-backrows').value = s.seatMap.backRows !== undefined ? s.seatMap.backRows : 2;
  }
  // 前排奖励按钮的分值同样要回填，否则设置页一打开就显示默认 2，
  // 老师以为自己改的值没保存住。
  if (document.activeElement !== $('#set-score-reward')) {
    $('#set-score-reward').value = rules.frontReward !== undefined ? rules.frontReward : 2;
  }
  // 抢答 / 转盘的判定分值（控制端"答对/答错"按钮带的默认 delta）
  if (document.activeElement !== $('#set-score-buzz-correct')) {
    $('#set-score-buzz-correct').value = rules.buzzCorrect !== undefined ? rules.buzzCorrect : 5;
  }
  if (document.activeElement !== $('#set-score-buzz-wrong')) {
    $('#set-score-buzz-wrong').value = rules.buzzWrong !== undefined ? rules.buzzWrong : -2;
  }
  if (document.activeElement !== $('#set-score-wheel-correct')) {
    $('#set-score-wheel-correct').value = rules.wheelCorrect !== undefined ? rules.wheelCorrect : 3;
  }
  if (document.activeElement !== $('#set-score-wheel-wrong')) {
    $('#set-score-wheel-wrong').value = rules.wheelWrong !== undefined ? rules.wheelWrong : 0;
  }
  renderScoreRuleText(rules);
  syncRewardButton();
  renderBuzzScoreHint();
  // 暂停按钮的文案/禁用态取决于当前活动，每次状态同步都要刷新
  syncPauseButtons();

  // 第几课：多节课共用同一个课堂码时，老师需要一眼知道现在上到第几节
  const sn = $('#session-now');
  if (sn) sn.textContent = `当前是第 ${s.sessionNo || 1} 课`;

  // 题库只在内容变化时重绘，避免每次状态同步都重建整个列表（会打断滚动）
  const bankSig = (s.questionBank || []).map((q) => q.id).join(',');
  const qbBox = $('#qb-list');
  if (qbBox && qbBox.dataset.sig !== bankSig) {
    qbBox.dataset.sig = bankSig;
    renderQuestionBank();
  }

  $('#s-rows').value = s.seatMap.rows;
  $('#s-cols').value = s.seatMap.cols;
  $('#s-front').value = s.seatMap.frontRows;
}

/* ---------- 排行榜 ---------- */
function renderRank(list) {
  const ol = $('#c-ranklist');
  // signature 带上本次课得分：它变了也要重绘，否则侧栏只显示总分看不出本节课变化
  const sig = list.map((x) => `${x.id}:${x.score}:${Number(x.sessionScore) || 0}`).join('|');
  if (ol.dataset.sig === sig) return;
  const prev = new Map((ol.dataset.scores || '').split(';').filter(Boolean).map((x) => x.split(':')).map(([a, b]) => [a, Number(b)]));
  ol.dataset.sig = sig;
  ol.dataset.scores = list.map((x) => `${x.id}:${x.score}`).join(';');
  ol.innerHTML = '';
  list.slice(0, 20).forEach((st) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="rk">${st.rank}</span><span class="rav">${esc(st.avatar)}</span>
      <span class="rname">${esc(st.nickname)}</span>
      <span class="rscore"><b>${st.score}</b><em>${Number(st.sessionScore) || 0}</em></span>`;
    li.title = `投票 ${st.stats.votes} · 答对 ${st.stats.correct} · 发言 ${st.stats.words} · 抢答 ${st.stats.buzz} · 被点名 ${st.stats.picked}`;
    ol.appendChild(li);
    if (prev.has(st.id) && prev.get(st.id) !== st.score) {
      li.classList.add('flash');
      setTimeout(() => li.classList.remove('flash'), 800);
    }
  });
}

function renderHands(students) {
  const hands = students.filter((s) => s.handsUp && s.online);
  const box = $('#c-handslist');
  $('#c-handcount').textContent = hands.length;
  const sig = hands.map((h) => h.id).join(',');
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  box.innerHTML = hands.map((h) => `<span class="hand-mini">${esc(h.avatar)}${esc(h.nickname)}</span>`).join('')
    || '<span style="color:var(--text-3);font-size:12px">暂无举手</span>';
}

function renderLog(log) {
  const box = $('#c-log');
  const html = log.slice(-40).reverse().map((l) =>
    `<div class="log-i ${l.kind}"><i>${fmtClock(l.ts)}</i>${esc(l.text)}</div>`
  ).join('');
  if (box.innerHTML !== html) box.innerHTML = html;
}

/* ================= 投票 / 小测（选择题 · 判断题 · 简答题） ================= */

/** 当前题型 */
function pollFormat() { return $('#p-format') ? $('#p-format').value : 'choice'; }

/**
 * 当前题型的选项文本。
 * 判断题固定「正确 / 错误」两项——让老师手打会写成「对/错」「T/F」各种花样，
 * 前端还得去猜哪个下标算正确项，一猜错整题就判反了，所以由服务端统一定死。
 */
function pollOptionTexts() {
  const fmt = pollFormat();
  if (fmt === 'judge') return ['正确', '错误'];
  if (fmt === 'text') return [];
  return $('#p-options').value.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 8);
}

function rebuildCorrectOptions() {
  const opts = pollOptionTexts();
  const sel = $('#p-correct');
  const cur = sel.value;
  sel.innerHTML = '<option value="">不设正确答案</option>' +
    opts.map((o, i) => `<option value="${i}">${String.fromCharCode(65 + i)}. ${esc(o)}</option>`).join('');
  sel.value = cur;
}

const FORMAT_HINT = {
  choice: '同学点选项作答；设了正确答案就是小测，不设就是纯投票',
  judge: '固定「正确 / 错误」两项，同学二选一',
  text: '同学输入文字答案，大屏实名展示成答案墙；参考答案可选',
};

/** 题型切换：只显示和当前题型相关的输入项 */
function syncPollFormat() {
  const fmt = pollFormat();
  $('#p-only-choice').classList.toggle('hidden', fmt !== 'choice');
  $('#p-only-multi').classList.toggle('hidden', fmt !== 'choice');
  $('#p-only-correct').classList.toggle('hidden', fmt === 'text');
  $('#p-only-answer').classList.toggle('hidden', fmt !== 'text');
  const hint = $('#p-format-hint');
  if (hint) hint.textContent = FORMAT_HINT[fmt] || '';
  rebuildCorrectOptions();
}

/** 公布 / 收起答案按钮的文案跟随当前状态 */
function syncRevealButtons() {
  const revealed = !!(state && state.activity && state.activity.revealed);
  const p = $('#p-reveal'); if (p) p.textContent = revealed ? '🙈 收起答案' : '✅ 公布答案';
  const b = $('#b-reveal'); if (b) b.textContent = revealed ? '🙈 收起答案' : '✅ 公布答案';
}

$('#p-options').addEventListener('input', rebuildCorrectOptions);
$('#p-format').onchange = syncPollFormat;
syncPollFormat();

$('#p-start').onclick = () => {
  const question = $('#p-question').value.trim();
  const format = pollFormat();
  const options = pollOptionTexts();
  if (format === 'choice' && !options.length) return toast('请至少填写 1 个选项', 'err');
  const correct = format === 'text'
    ? null
    : ($('#p-correct').value === '' ? null : Number($('#p-correct').value));
  const answerText = format === 'text' ? $('#p-answer').value.trim() : '';
  net.emit('poll:start', {
    question, options, correct, format, answerText,
    multi: format === 'choice' && $('#p-multi').value === '1',
    quiz: correct !== null,
  }, (res) => {
    if (!res || !res.ok) return toast((res && res.msg) || '发布失败', 'err');
    toast('投票已发布', 'ok');
    sfx.pop();
    $('#p-bars').innerHTML = '';
  });
};

$('#p-stop').onclick = () => net.emit('poll:stop', {}, ackToast('已结束投票'));

// 公布 / 收起答案做成切换：老师可以选择不公布（讲评时常常想先让同学自己再想想），
// 所以默认不公布，只有他点了才下发答案。
$('#p-reveal').onclick = () => {
  const revealed = !!(state && state.activity && state.activity.revealed);
  net.emit('poll:reveal', { reveal: !revealed }, (res) => {
    if (!res || !res.ok) return toast((res && res.msg) || '操作失败', 'err');
    toast(revealed ? '已收起答案' : '已公布答案', 'ok');
    syncRevealButtons();
  });
};

/**
 * 暂停 / 继续。
 * 和「结束」的区别：暂停只是截止提交，结果原样留在 activity 里，
 * 大屏和手机端继续显示票数/词云；结束会把活动归档并清空，大屏就回到待机了。
 * 老师最常见的诉求是「先别投了，让大家看看结果」，所以要能暂停看。
 */
function togglePause() {
  const paused = state && state.activity && state.activity.paused;
  if (paused) net.emit('activity:resume', {}, ackToast(null, () => syncPauseButtons()));
  else net.emit('activity:pause', {}, ackToast(null, () => syncPauseButtons()));
}

/** 三个面板共用同一套暂停语义，文案和禁用态统一在这里同步 */
function syncPauseButtons() {
  const act = state && state.activity;
  const paused = !!(act && act.paused);
  const label = paused ? '▶ 继续' : '⏸ 暂停';
  ['#p-pause', '#w-pause', '#b-pause'].forEach((sel) => {
    const b = $(sel);
    if (!b) return;
    b.textContent = label;
    b.classList.toggle('on', paused);
    // 没有进行中的活动时点了也没意义，直接禁用，免得老师以为没生效
    b.disabled = !act;
  });
}

$('#p-pause').onclick = togglePause;
$('#w-pause').onclick = togglePause;
$('#b-pause').onclick = togglePause;
$('#p-resend').onclick = () => {
  if (!state || !state.activity) return;
  const act = state.activity;
  net.emit('poll:stop', {}, () => {
    net.emit('poll:start', { question: act.question, options: act.options.map((o) => o.text), correct: act.correct, multi: act.multi, quiz: act.type === 'quiz' });
    toast('已重新推送', 'ok');
  });
};

const TPLS = {
  yn: { q: '你同意这个观点吗？', o: ['同意', '不同意', '不确定'] },
  understand: { q: '这部分内容听懂了吗？', o: ['完全听懂', '基本听懂', '有点模糊', '完全没懂'] },
  speed: { q: '老师的语速合适吗？', o: ['有点快', '正合适', '有点慢'] },
  abcd: { q: '请选择你的答案', o: ['A 选项', 'B 选项', 'C 选项', 'D 选项'] },
};
$$('[data-tpl]').forEach((b) => (b.onclick = () => {
  const t = TPLS[b.dataset.tpl];
  $('#p-question').value = t.q;
  $('#p-options').value = t.o.join('\n');
  rebuildCorrectOptions();
  $('#p-question').focus();
}));

const MB_COLORS = [['#22d3ee', '#0891b2'], ['#a78bfa', '#6d28d9'], ['#f472b6', '#be185d'], ['#fbbf24', '#d97706'],
  ['#34d399', '#047857'], ['#4c8dff', '#1d4ed8'], ['#fb923c', '#c2410c'], ['#2dd4bf', '#0f766e']];

function renderMiniBars(options, correct) {
  const box = $('#p-bars');
  if (!options || !options.length) { box.innerHTML = '<span style="color:var(--text-3);font-size:13px">暂无进行中的投票</span>'; return; }
  const max = Math.max(1, ...options.map((o) => o.count));
  box.innerHTML = options.map((o, i) => {
    const [c1, c2] = MB_COLORS[i % MB_COLORS.length];
    const isCorrect = correct !== null && correct !== undefined && correct >= 0 && i === correct;
    return `<div class="mb ${isCorrect ? 'correct' : ''}" style="--c1:${c1};--c2:${c2}">
      <span class="mb-label">${String.fromCharCode(65 + i)}. ${esc(o.text)}</span>
      <span class="mb-track"><i class="mb-fill" style="width:${(o.count / max) * 100}%"></i></span>
      <span class="mb-num">${o.count}</span>
    </div>`;
  }).join('');
  if (state && state.activity) {
    $('#p-count').textContent = `${state.activity.totalVotes || 0} / ${state.stats.online}`;
  }
}

/**
 * 简答题：控制端实时结果区列出同学们提交的文字答案。
 * 老师讲课时要能一眼看到谁答了什么，方便点名讲评，所以这里是实名列表而不是词云。
 */
function renderTextAnswers(answers) {
  const box = $('#p-bars');
  if (!answers || !answers.length) {
    box.innerHTML = '<span style="color:var(--text-3);font-size:13px">还没有同学提交答案</span>';
    return;
  }
  box.innerHTML = answers.map((a) => `
    <div class="ta-row">
      <span class="ta-av">${esc(a.avatar || '🙂')}</span>
      <b>${esc(a.nickname || '?')}</b>
      <span class="ta-text">${esc(a.text)}</span>
    </div>`).join('');
}

/* ================= 词云 / 弹幕 ================= */

$('#w-start').onclick = () => {
  const prompt = $('#w-prompt').value.trim();
  net.emit('word:start', { prompt, mode: $('#w-mode').value }, (res) => {
    if (!res || !res.ok) return toast('发布失败', 'err');
    toast('开始收集', 'ok');
    $('#w-chips').innerHTML = '';
  });
};
$('#w-stop').onclick = () => net.emit('word:stop', {}, ackToast('已结束'));
$('#w-clear').onclick = () => { net.emit('word:clear', {}, ackToast(null, () => { $('#w-chips').innerHTML = ''; })); };

function renderWordChips(items) {
  const freq = new Map();
  items.forEach((i) => freq.set(i.text, (freq.get(i.text) || 0) + 1));
  $('#w-count').textContent = `${items.length} 条`;
  $('#w-chips').innerHTML = [...freq.entries()].sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `<button type="button" class="wchip" data-t="${esc(t)}" title="点击从大屏撤下并屏蔽">${esc(t)}${n > 1 ? `<b>×${n}</b>` : ''}</button>`).join('')
    || '<span style="color:var(--text-3);font-size:13px">还没有同学提交</span>';
}
function addWordChip(item) { if (state && state.activity) renderWordChips(state.activity.items || []); }

/* 点词条 = 撤下并屏蔽。
   大屏是教室里的公共屏幕，遇到不合适的内容要能手起刀落，
   而不是只能「清空」把全班的心血一起删掉。
   这里不用 confirm 弹窗：连着下掉好几条时，每次都点一次确认太打断讲课节奏。
   改成提示条上带「撤销」，误点一下就能改回来——已经撤下的条目找不回来，
   所以撤销解除的是屏蔽，让同学能重新提交，提示语把这点写明白。 */
$('#w-chips').addEventListener('click', (e) => {
  const chip = e.target.closest('.wchip');
  if (!chip) return;
  const text = chip.dataset.t || '';
  if (!text) return;
  net.emit('word:hide', { text }, (res) => {
    if (!res || !res.ok) return toast((res && res.msg) || '撤下失败', 'warn');
    toast(`已撤下「${text}」${res.removed} 条`, 'ok', 6000, {
      label: '撤销屏蔽',
      onClick: () => net.emit('word:unblock', { text }, (r2) => {
        if (r2 && r2.ok) toast(`已解除屏蔽，「${text}」可以重新提交了`, 'ok');
        else toast((r2 && r2.msg) || '撤销失败', 'warn');
      }),
    });
  });
});

net.on('word:hidden', ({ text } = {}) => {
  if (!state || !state.activity || state.activity.type !== 'word') return;
  // 服务端是先广播 word:hidden、再 touch() 触发状态同步的，
  // 所以此刻本地 state 里还是旧列表，必须自己先滤掉再重绘，
  // 否则刚屏蔽的词条会留在面板上，要等下一次状态同步才消失。
  const t = String(text || '').trim().toLowerCase();
  if (t) state.activity.items = (state.activity.items || []).filter((i) => String(i.text || '').trim().toLowerCase() !== t);
  renderWordChips(state.activity.items || []);
});

/* ================= 转盘 ================= */

function ensureWheel() {
  if (state && state.activity && state.activity.type === 'wheel') return true;
  const pool = $('#wh-pool').value;
  const count = Number($('#wh-count').value) || 8;
  net.emit('wheel:open', { pool, count, title: $('#wh-title').value.trim() || '今天谁来回答？' });
  return false;
}

$('#wh-spin').onclick = () => {
  sfx.click();
  const wasOpen = state && state.activity && state.activity.type === 'wheel';
  if (!wasOpen) {
    ensureWheel();
    setTimeout(() => net.emit('wheel:spin', {}, (res) => onSpinResult(res)), 320);
  } else {
    net.emit('wheel:spin', {}, (res) => onSpinResult(res));
  }
};

function onSpinResult(res) {
  if (!res || !res.ok) return toast((res && res.msg) || '抽取失败', 'err');
  const w = res.winner;
  // 2026-09-04：转盘抽中人不自动加分。这里只显示结果 + 出现判定按钮组。
  // 老师按"答对/答错/0 分/自定义"按钮后走 wheel:award，由服务端 addScore。
  setTimeout(() => {
    $('#wh-avatar').textContent = w.avatar || '🎉';
    $('#wh-name').textContent = w.nickname || '—';
    $('#wh-seat').textContent = w.seat ? `${w.seat.row + 1} 排 ${w.seat.col + 1} 座` : '未选座';
    // 写最新得主的 id / 头像 / 昵称到 dataset，"答对/答错/0 分"按钮从这里读
    $('#wh-result').dataset.id = w.id || '';
    $('#wh-award').hidden = false;
    // 同步设置里的判定分值
    const ok = rule('wheelCorrect', 3);
    const ng = rule('wheelWrong', 0);
    $('#wh-award-ok-n').textContent = `+${ok}`;
    $('#wh-award-ng-n').textContent = `${ng >= 0 ? '+' : ''}${ng}`;
    $('#wh-award-custom').value = '';
  }, 5100);
}

// 把"答对/答错/0 分/自定义"四档连发到 wheel:award
function emitWheelAward(delta, reason) {
  const sid = $('#wh-result').dataset.id;
  if (!sid) return toast('请先转动转盘', 'err');
  net.emit('wheel:award', { studentId: sid, delta, reason }, ackToast(`已 ${delta >= 0 ? '+' : ''}${delta}`));
}
$('#wh-award-ok').onclick = () => emitWheelAward(rule('wheelCorrect', 3), '抽问答对');
$('#wh-award-ng').onclick = () => emitWheelAward(rule('wheelWrong', 0), '抽问答错');
$('#wh-award-zero').onclick = () => emitWheelAward(0, '提问判定 0 分');
$('#wh-award-go').onclick = () => {
  const v = Number($('#wh-award-custom').value);
  if (!Number.isFinite(v)) return toast('请输入有效分值', 'err');
  emitWheelAward(v, '提问自定义');
};

$('#wh-refresh').onclick = () => {
  if (!state || !state.activity || state.activity.type !== 'wheel') return ensureWheel();
  net.emit('wheel:refresh', { count: Number($('#wh-count').value) || 8 }, ackToast('已换一批'));
};
$('#wh-close').onclick = () => net.emit('wheel:close', {}, ackToast('转盘已关闭'));

function renderCands(cands, picked) {
  $('#wh-cands').innerHTML = cands.map((c) =>
    `<span class="cand ${picked.includes(c.id) ? 'picked' : ''}">${esc(c.avatar)} ${esc(c.nickname)}</span>`).join('')
    || '<span style="color:var(--text-3);font-size:13px">暂无候选</span>';
}

/* ================= 抢答 ================= */

/** 抢答题型：默认简答题（改造前抢答就只有一句提示语，保持原表现） */
function buzzFormat() { return $('#b-format') ? $('#b-format').value : 'text'; }

function buzzOptionTexts() {
  const fmt = buzzFormat();
  if (fmt === 'judge') return ['正确', '错误'];
  if (fmt === 'text') return [];
  return $('#b-options').value.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 8);
}

function rebuildBuzzCorrectOptions() {
  const opts = buzzOptionTexts();
  const sel = $('#b-correct');
  const cur = sel.value;
  sel.innerHTML = '<option value="">不设正确答案</option>' +
    opts.map((o, i) => `<option value="${i}">${String.fromCharCode(65 + i)}. ${esc(o)}</option>`).join('');
  sel.value = cur;
}

function syncBuzzFormat() {
  const fmt = buzzFormat();
  $('#b-only-choice').classList.toggle('hidden', fmt !== 'choice');
  $('#b-only-correct').classList.toggle('hidden', fmt === 'text');
  $('#b-only-answer').classList.toggle('hidden', fmt !== 'text');
  rebuildBuzzCorrectOptions();
}
$('#b-options').addEventListener('input', rebuildBuzzCorrectOptions);
$('#b-format').onchange = syncBuzzFormat;
syncBuzzFormat();

/** 组装抢答载荷：抢答「只抢不答」，题目和答案只是挂给全班看 */
function buzzPayload() {
  const format = buzzFormat();
  const options = buzzOptionTexts();
  const correct = format === 'text'
    ? null
    : ($('#b-correct').value === '' ? null : Number($('#b-correct').value));
  return {
    prompt: $('#b-prompt').value.trim() || '抢答开始！',
    format,
    options,
    correct,
    answerText: format === 'text' ? $('#b-answer').value.trim() : '',
  };
}

$('#b-start').onclick = () => {
  if (buzzFormat() === 'choice' && !buzzOptionTexts().length) return toast('请至少填写 1 个选项', 'err');
  net.emit('buzz:start', buzzPayload(), ackToast('抢答开始！'));
};
$('#b-reveal').onclick = () => {
  const revealed = !!(state && state.activity && state.activity.revealed);
  net.emit('buzz:reveal', { reveal: !revealed }, (res) => {
    if (!res || !res.ok) return toast((res && res.msg) || '操作失败', 'err');
    toast(revealed ? '已收起答案' : '已公布答案', 'ok');
    syncRevealButtons();
  });
};
$('#b-reset').onclick = () => net.emit('buzz:reset', {}, ackToast('已重置', () => { $('#b-list').innerHTML = ''; }));
$('#b-stop').onclick = () => net.emit('buzz:stop', {}, ackToast('抢答结束'));

/** 抢答面板顶部的分值说明：现在不再是"前三自动 +N"，而是老师判定。
 *  给老师一个直接的提示：默认"答对 +5 / 答错 -2"，想改去设置。 */
function renderBuzzScoreHint() {
  const el = $('#b-score-hint');
  if (!el) return;
  const ok = rule('buzzCorrect', 5);
  const ng = rule('buzzWrong', -2);
  el.textContent = `抢答不自动加分 · 答对 +${ok} / 答错 ${ng >= 0 ? '+' : ''}${ng}（可在设置改）`;
}

/**
 * 抢答结果列表：每行除了名次/头像/昵称，加 3 个判定按钮——
 * 「答对 +N」「答错 -N」「0 分」。默认 delta 来自设置（buzzCorrect/buzzWrong），
 * 想给不一样的数，按钮点开自定义也行；最常见的用法就是直接点这三个按钮。
 *
 * 这里**不发奖**，只是把按钮放在那里——按下去才走 buzz:award 事件，由服务端加/减分。
 * 这样设计的理由：抢到不等于答对，"抢到 + 答错 + 没扣分"是被老规则惯出来的问题。
 */
function renderBuzzList(ranks) {
  const ok = rule('buzzCorrect', 5);
  const ng = rule('buzzWrong', -2);
  $('#b-list').innerHTML = ranks.slice(0, 5).map((r) => `
    <div class="bz-row" data-id="${esc(r.id || r.studentId || '')}">
      <span class="bzr">${r.rank}</span>
      <span class="bza">${esc(r.avatar)}</span>
      <span class="bzn">${esc(r.nickname)}</span>
      <span class="bz-award">
        <button class="bz-btn ok" data-award="${ok}">答对 +${ok}</button>
        <button class="bz-btn ng" data-award="${ng}">答错 ${ng >= 0 ? '+' : ''}${ng}</button>
        <button class="bz-btn zero" data-award="0">0 分</button>
      </span>
    </div>`).join('')
    || '<span style="color:var(--text-3);font-size:13px">等待同学抢答…</span>';
  // 事件代理：一个 listener 处理整列按钮
  $$('#b-list .bz-btn').forEach((b) => b.onclick = (e) => {
    const row = e.target.closest('.bz-row');
    const sid = row && row.dataset.id;
    const delta = Number(b.dataset.award) || 0;
    if (!sid) return;
    net.emit('buzz:award', {
      studentId: sid,
      delta,
      reason: delta > 0 ? '抢答答对' : delta < 0 ? '抢答答错' : '抢答判定 0 分',
    }, ackToast(`已 ${delta >= 0 ? '+' : ''}${delta}`));
  });
}

/* ================= 座位 ================= */

$('#s-apply').onclick = () => net.emit('seat:config', {
  rows: Number($('#s-rows').value) || 6,
  cols: Number($('#s-cols').value) || 8,
  frontRows: Number($('#s-front').value) || 2,
}, ackToast('座位表已更新'));
$('#s-show').onclick = () => net.emit('wall:show', { view: 'seat' }, ackToast('大屏已切到座位图'));
$('#s-reward').onclick = () => {
  const ids = (state ? state.students : []).filter((s) => s.seat && s.seat.row < state.seatMap.frontRows).map((s) => s.id);
  if (!ids.length) return toast('还没有同学坐前排', 'warn');
  // 分值读设置（默认 2），不再写死：设置里改成 1 或 5，这里同步生效，
  // 按钮文案也由 syncRewardButton() 跟着改，两处不会对不上。
  const d = rewardScore();
  net.emit('score:adjustMany', { studentIds: ids, delta: d, reason: '前排就坐奖励' },
    ackToast(`已给 ${ids.length} 位前排同学 +${d} 分`));
};

/** 加分按钮上的数字跟设置保持一致，避免"设置改成 1 了按钮还写 +2" */
function syncRewardButton() {
  const b = $('#s-reward');
  if (!b) return;
  b.textContent = `🏅 给前排同学加分 +${rewardScore()}`;
}

function renderSeatPreview() {
  if (!state) return;
  const { rows, cols, frontRows } = state.seatMap;
  const taken = new Map();
  state.students.filter((s) => s.seat).forEach((s) => taken.set(`${s.seat.row}-${s.seat.col}`, s));

  const sig = `${rows}x${cols}x${frontRows}|` + [...taken.entries()].map(([k, v]) => `${k}:${v.id}`).sort().join(',');
  if ($('#s-preview').dataset.sig === sig) return;
  $('#s-preview').dataset.sig = sig;

  let html = '<div style="width:max-content;margin:0 auto">';
  html += '<div class="c-podium">讲台</div>';
  html += `<div class="c-seatgrid" style="grid-template-columns:repeat(${cols},38px)">`;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const s = taken.get(`${r}-${c}`);
      const cls = ['c-seat', r < frontRows ? 'front' : '', s ? 'taken' : ''].join(' ');
      html += `<div class="${cls}" ${s ? `style="--sc:${s.color}"` : ''} title="${s ? esc(s.nickname) : `${r + 1}排${c + 1}座`}">${s ? esc(s.avatar) : ''}</div>`;
    }
  }
  html += '</div></div>';
  $('#s-preview').innerHTML = html;
}

function renderFrontRank() {
  if (!state) return;
  const { front, total, rate } = state.stats.seat;
  $('#fr-fill').style.width = rate + '%';
  $('#fr-text').textContent = `${rate}% （${front} / ${total}）`;
}

/* ================= 分组 ================= */

$('#g-make').onclick = () => net.emit('group:make', { count: Number($('#g-count').value) || 6, mode: $('#g-mode').value },
  ackToast(null, (res) => toast(`已分成 ${res.groups.length} 组`, 'ok')));
$('#g-show').onclick = () => net.emit('wall:show', { view: 'group' }, ackToast('已投屏'));
$('#g-clear').onclick = () => net.emit('group:clear', {}, ackToast('已清空'));

function renderGroupsPreview(groups) {
  $('#g-preview').innerHTML = groups.map((g) =>
    `<div class="gp-card" style="--gc:${g.color}">
      <h5>${esc(g.name)} · ${g.members.length} 人</h5>
      <div class="gp-mem">${g.members.map((m) => `<span>${esc(m.avatar)}${esc(m.nickname)}</span>`).join('')}</div>
    </div>`).join('');
}

/* ================= 计时器 ================= */

function renderTimer(t) {
  if (!t) return;
  const el = $('#t-display');
  el.textContent = fmtTime(t.remain);
  el.classList.toggle('warn', t.remain <= 10 && t.remain > 0);
}
$$('[data-sec]').forEach((b) => (b.onclick = () => net.emit('timer:set', { seconds: Number(b.dataset.sec) })));
$('#t-start').onclick = () => net.emit('timer:set', { seconds: Number($('#t-custom').value) || 120 });
$('#t-pause').onclick = () => net.emit('timer:pause', {});
$('#t-resume').onclick = () => net.emit('timer:resume', {});
$('#t-reset').onclick = () => net.emit('timer:set', { seconds: 0 });

/* ================= 特效 ================= */

$$('.fx-btn').forEach((b) => (b.onclick = () => {
  net.emit('broadcast:effect', { kind: b.dataset.fx, text: b.dataset.text }, ackToast('特效已发送'));
}));
$('#fx-send').onclick = () => {
  const text = $('#fx-text').value.trim();
  if (!text) return toast('请输入文字', 'warn');
  net.emit('broadcast:effect', { kind: 'celebrate', text }, ackToast('已发送'));
};
$('#fx-msg').onclick = () => {
  const text = $('#fx-text').value.trim();
  net.emit('wall:msg', { text }, ackToast('已设为底栏提示'));
};
$$('[data-view]').forEach((b) => (b.onclick = () => net.emit('wall:show', { view: b.dataset.view }, ackToast('已切换'))));

/* ================= 学生 ================= */

function renderStudents() {
  if (!state) return;
  const kw = ($('#st-search').value || '').trim().toLowerCase();
  const f = $('#st-filter').value;
  let list = state.students;
  if (f === 'online') list = list.filter((s) => s.online);
  if (f === 'front') list = list.filter((s) => s.seat && s.seat.row < state.seatMap.frontRows);
  if (f === 'hand') list = list.filter((s) => s.handsUp);
  if (kw) list = list.filter((s) => s.nickname.toLowerCase().includes(kw));
  list = [...list].sort((a, b) => b.score - a.score || a.joinedAt - b.joinedAt);

  // 数据未变则跳过重绘（大班时避免每帧重建上百行 DOM）。
  // signature 要把 nickname + sessionScore 都算进去，否则改名 / 本次课得分变了表格不刷新。
  const sig = list.map((s) => `${s.id},${s.nickname},${s.score},${Number(s.sessionScore) || 0},${s.online ? 1 : 0},${s.handsUp ? 1 : 0},${s.seat ? s.seat.row + '.' + s.seat.col : '-'},${s.stats.votes},${s.stats.words}`).join('|');
  const box = $('#st-table');
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;

  $('#st-total').textContent = `${list.length} 人`;
  box.innerHTML = list.map((s) => {
    const front = s.seat && s.seat.row < state.seatMap.frontRows;
    return `<div class="st-row ${s.online ? '' : 'off'}">
      <span class="st-av">${esc(s.avatar)}</span>
      <span class="st-name">${esc(s.nickname)}<small>投票 ${s.stats.votes} · 发言 ${s.stats.words} · 抢答 ${s.stats.buzz} · 点名 ${s.stats.picked}</small></span>
      ${s.seat ? `<span class="st-seat ${front ? 'front' : ''}">${front ? '★ ' : ''}${s.seat.row + 1}排${s.seat.col + 1}座</span>` : '<span class="st-seat">未选座</span>'}
      ${s.handsUp ? '<span class="st-hand">✋</span>' : ''}
      <span class="st-score">
        <b>${s.score}</b>
        <em>本次 ${Number(s.sessionScore) || 0}</em>
      </span>
      <span class="st-btns">
        <button class="btn" data-act="add" data-id="${s.id}">+1</button>
        <button class="btn" data-act="add5" data-id="${s.id}">+5</button>
        <button class="btn" data-act="sub" data-id="${s.id}">-1</button>
      </span>
    </div>`;
  }).join('') || '<div style="color:var(--text-3);font-size:13px;padding:20px;text-align:center">暂无同学</div>';

  $$('#st-table [data-act]').forEach((b) => (b.onclick = () => {
    const delta = b.dataset.act === 'add' ? 1 : b.dataset.act === 'add5' ? 5 : -1;
    net.emit('score:adjust', { studentId: b.dataset.id, delta, reason: '教师手动' }, ackToast(null, () => sfx.click()));
  }));
}
$('#st-search').addEventListener('input', renderStudents);
$('#st-filter').addEventListener('change', renderStudents);
$('#st-refresh').onclick = () => renderStudents();
$('#st-reward-all').onclick = () => {
  const ids = (state ? state.students : []).filter((s) => s.online).map((s) => s.id);
  net.emit('score:adjustMany', { studentIds: ids, delta: 1, reason: '全员奖励' }, ackToast(`已给 ${ids.length} 人 +1 分`));
};
$('#st-export').onclick = () => { location.href = `/api/room/${code}/export.csv`; };

/* ================= 设置 ================= */

// 按当前分值设置生成积分规则文案（之前这行是写死的「加入 +1 · 参与投票 +1」，
// 老师改了前排加分后文案也不会变，看着像没生效）。
function renderScoreRuleText(rules) {
  const r = rules || {};
  const front = r.seatFront !== undefined ? r.seatFront : 3;
  const reward = r.frontReward !== undefined ? r.frontReward : 2;
  const picked = r.handPicked !== undefined ? r.handPicked : 2;
  $('#score-rule-text').textContent =
    `加入 +${r.join ?? 1} · 前排就坐 +${front} · 参与投票 +${r.vote ?? 1} · 答对 +${r.voteCorrect ?? 2}`
    + ` · 发言 +${r.word ?? 1} · 抢答前3 ${r.buzz1 ?? 5}/${r.buzz2 ?? 3}/${r.buzz3 ?? 1}`
    + ` · 被点名 +${picked} · 前排奖励 +${reward}`;
}

$('#set-save').onclick = () => {
  net.emit('room:rename', { title: $('#set-title').value.trim() }, () => {});
  net.emit('settings:update', {
    danmakuEnabled: $('#set-danmaku').checked,
    cheerEnabled: $('#set-cheer').checked,
    buzzEnabled: $('#set-buzz').checked,
    allowMultiVote: $('#set-multivote').checked,
    maxWordLen: Number($('#set-maxlen').value) || 20,
    // 前排就坐加分 + 前排奖励按钮分值 + 抢答/转盘判定分值，一起存进 scoreRules。
    // 抢答/转盘本身不再自动加分，老师按"答对/答错/0 分"手动判定。
    scoreRules: {
      seatFront: Number($('#set-score-front').value) || 0,
      frontReward: Number($('#set-score-reward').value) || 0,
      buzzCorrect: Number($('#set-score-buzz-correct').value) || 0,
      buzzWrong: Number($('#set-score-buzz-wrong').value) || 0,
      wheelCorrect: Number($('#set-score-wheel-correct').value) || 0,
      wheelWrong: Number($('#set-score-wheel-wrong').value) || 0,
    },
  }, ackToast('设置已保存', () => { syncRewardButton(); renderBuzzScoreHint(); }));
  // 后排定义属于座位配置，走 seat:config 单独存（只动 backRows，其余不变）
  net.emit('seat:config', { backRows: Number($('#set-backrows').value) || 2 });
};
$('#set-clearhands').onclick = () => net.emit('hand:clear', {}, ackToast('已清空举手'));
$('#c-clearhands').onclick = () => net.emit('hand:clear', {});

/* ---- 多节课管理：开始新的一课 / 清空全部数据 ---- */

/**
 * 这两个操作都要二次确认。「清空全部数据」不用说了，「开始新的一课」也会
 * 清掉上一节的活动记录和分组，老师手滑点一下就没了，而课堂上没时间找回。
 */
function confirmDanger(msg, onYes) {
  if (!window.confirm(msg)) return;
  onYes();
}

$('#set-newsession').onclick = () => {
  confirmDanger(
    '开始新的一课？\n\n将清空上一节的活动记录、分组、举手、词云，'
    + '并把所有座位清空（座位安排每节课都可能变，同学需要重新点一下）；\n'
    + '「本次课得分」也会清零重新计。\n\n'
    + '学生名单和累计总积分会保留，同学不用重新扫码。',
    () => net.emit('room:newSession', {}, (res) => {
      if (!res || !res.ok) return toast((res && res.msg) || '操作失败', 'err');
      toast(`第 ${res.sessionNo} 课已开始`, 'ok');
    })
  );
};

$('#set-reset').onclick = () => {
  confirmDanger(
    '确定清空全部数据？\n\n将删除所有学生、积分、座位和活动记录，回到刚建课堂的空状态。\n课堂码、教师口令、设置和题库会保留。\n\n此操作不可撤销。',
    () => net.emit('room:reset', {}, (res) => {
      if (!res || !res.ok) return toast((res && res.msg) || '操作失败', 'err');
      toast('课堂数据已清空', 'ok');
    })
  );
};

/* ---- 题库：课前录题，课堂一键发布 ---- */

const QB_TYPE_NAME = { poll: '📊 投票', quiz: '📝 小测', word: '💬 词云', buzz: '⚡ 抢答' };

/**
 * 题型相关的显隐。
 * 词云/弹幕没有题型也没选项，整块藏掉；投票/小测/抢答都可能有选项和答案
 * （抢答题也能存答案了，老师判定完再决定要不要公布）。
 */
function syncQuestionForm() {
  const t = $('#qb-type').value;
  const needExtra = t !== 'word';
  const fmt = $('#qb-format').value;
  $('#qb-only-poll').classList.toggle('hidden', !needExtra);
  $('#qb-only-format').classList.toggle('hidden', !needExtra);
  if (!needExtra) return;
  // 抢答默认简答题（原来抢答就是一句提示语），投票/小测默认选择题
  $('#qb-only-options').classList.toggle('hidden', fmt !== 'choice');
  $('#qb-only-multi').classList.toggle('hidden', fmt !== 'choice');
  $('#qb-only-correct').classList.toggle('hidden', fmt === 'text');
  $('#qb-only-answer').classList.toggle('hidden', fmt !== 'text');
  $('#qb-question').placeholder = t === 'word'
    ? '例：用一个词形容你眼中的数据清洗'
    : t === 'buzz' ? '例：Excel 中删除重复值在哪个选项卡？'
      : '例：下面哪一项不属于数据清洗的步骤？';
  rebuildQbCorrect();
}

$('#qb-type').onchange = () => {
  // 切到抢答时默认给简答题，切到投票/小测默认给选择题，省得老师每次都改
  const t = $('#qb-type').value;
  $('#qb-format').value = t === 'buzz' ? 'text' : 'choice';
  syncQuestionForm();
};
$('#qb-format').onchange = syncQuestionForm;
syncQuestionForm();   // 初始也要跑一遍，否则新增的题型区块显隐取决于 HTML 默认值

function rebuildQbCorrect() {
  const fmt = $('#qb-format') ? $('#qb-format').value : 'choice';
  // 判断题的选项是服务端固定的「正确 / 错误」，这里照它生成下拉项
  const opts = fmt === 'judge'
    ? ['正确', '错误']
    : fmt === 'text'
      ? []
      : $('#qb-options').value.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 8);
  const sel = $('#qb-correct');
  const cur = sel.value;
  sel.innerHTML = '<option value="">不设正确答案</option>' +
    opts.map((o, i) => `<option value="${i}">${String.fromCharCode(65 + i)}. ${esc(o)}</option>`).join('');
  sel.value = cur;
}
$('#qb-options').addEventListener('input', rebuildQbCorrect);

$('#qb-add').onclick = () => {
  const type = $('#qb-type').value;
  const question = $('#qb-question').value.trim();
  if (!question) return toast('请先填写题目', 'warn');
  const format = type === 'word' ? undefined : $('#qb-format').value;
  const options = format === 'choice'
    ? $('#qb-options').value.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 8)
    : [];
  if (format === 'choice' && options.length < 2) return toast('选择题至少 2 个选项', 'warn');
  const correct = format === 'choice' || format === 'judge'
    ? ($('#qb-correct').value === '' ? null : Number($('#qb-correct').value))
    : null;
  net.emit('bank:add', {
    type, question, options, correct, format,
    answerText: format === 'text' ? $('#qb-answer').value.trim() : '',
    multi: format === 'choice' && $('#qb-multi').checked,
  }, (res) => {
    if (!res || !res.ok) return toast((res && res.msg) || '添加失败', 'err');
    toast('已加入题库', 'ok');
    $('#qb-question').value = '';
    if (state) { state.questionBank = res.bank; renderQuestionBank(); }
  });
};

$('#qb-clear').onclick = () => {
  if (!state || !state.questionBank || !state.questionBank.length) return toast('题库已经是空的', 'warn');
  confirmDanger('清空整个题库？此前录入的题目都会删除。', () => {
    net.emit('bank:clear', {}, (res) => {
      if (res && res.ok && state) { state.questionBank = []; renderQuestionBank(); toast('题库已清空', 'ok'); }
    });
  });
};

/* 跨课堂共享：导出成 JSON 文件，可导入到另一个班级 */
$('#qb-export').onclick = () => {
  const list = (state && state.questionBank) || [];
  if (!list.length) return toast('题库为空，没有可导出的题目', 'warn');
  const blob = new Blob([JSON.stringify({
    app: 'classroom-interactive',
    kind: 'question-bank',
    version: 1,
    exportedAt: new Date().toISOString(),
    items: list,
  }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `互动题库-${code}-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`已导出 ${list.length} 题到文件`, 'ok');
};

$('#qb-import').onclick = () => $('#qb-import-file').click();
$('#qb-import-file').onchange = (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = ''; // 允许重复选同一文件
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    let data;
    try { data = JSON.parse(reader.result); }
    catch { return toast('文件不是合法的 JSON', 'err'); }
    const items = Array.isArray(data)
      ? data
      : (Array.isArray(data.items) ? data.items : null);
    if (!items) return toast('文件中没有可识别的题库数据', 'err');
    net.emit('bank:import', items, (res) => {
      if (!res || !res.ok) return toast((res && res.msg) || '导入失败', 'err');
      if (state) { state.questionBank = res.bank; renderQuestionBank(); }
      const parts = [`已新增 ${res.added} 题`];
      if (res.dup) parts.push(`跳过重复 ${res.dup} 题`);
      if (res.skipped) parts.push(`忽略无效 ${res.skipped} 题`);
      toast(parts.join('，') + `，当前共 ${res.total} 题`, 'ok');
    });
  };
  reader.readAsText(file);
};

function renderQuestionBank() {
  const box = $('#qb-list');
  const list = (state && state.questionBank) || [];
  $('#qb-count').textContent = list.length ? `共 ${list.length} 题` : '题库为空';
  if (!list.length) {
    box.innerHTML = '<div style="color:var(--text-3);font-size:13px;padding:24px;text-align:center">'
      + '还没有题目。课前把要问的录进来，上课点「发布」即可。</div>';
    return;
  }
  box.innerHTML = list.map((q) => `
    <div class="qb-item" data-id="${q.id}">
      <div class="qb-main">
        <span class="qb-type t-${q.type}">${QB_TYPE_NAME[q.type] || q.type}</span>
        <b class="qb-q">${esc(q.question)}</b>
        ${q.options && q.options.length
          ? `<div class="qb-opts">${q.options.map((o, i) =>
              `<span class="qb-o${q.correct === i ? ' right' : ''}">${String.fromCharCode(65 + i)}. ${esc(o)}${q.correct === i ? ' ✓' : ''}</span>`).join('')}</div>`
          : ''}
      </div>
      <div class="qb-ops">
        <button class="btn btn-primary" data-act="send" data-id="${q.id}">📤 发布</button>
        <button class="btn btn-ghost" data-act="del" data-id="${q.id}">🗑</button>
      </div>
    </div>`).join('');

  $$('#qb-list [data-act="send"]').forEach((b) => (b.onclick = () => publishQuestion(b.dataset.id)));
  $$('#qb-list [data-act="del"]').forEach((b) => (b.onclick = () => {
    net.emit('bank:remove', { id: b.dataset.id }, (res) => {
      if (res && res.ok && state) { state.questionBank = res.bank; renderQuestionBank(); }
    });
  }));
}

/** 发布题库条目：按类型走对应的开始事件，发布后自动切到那个面板看结果 */
function publishQuestion(id) {
  const q = ((state && state.questionBank) || []).find((x) => x.id === id);
  if (!q) return toast('题目不存在', 'err');
  if (q.type === 'poll' || q.type === 'quiz') {
    // 题型和答案一起发过去：老题库条目没有 format，服务端会按选择题处理
    net.emit('poll:start', {
      question: q.question,
      options: q.options,
      correct: q.correct,
      format: q.format || 'choice',
      answerText: q.answerText || '',
      multi: !!q.multi,
      quiz: q.type === 'quiz' || q.correct !== null,
    }, (res) => {
      if (!res || !res.ok) return toast((res && res.msg) || '发布失败', 'err');
      toast('已发布，大屏同步中', 'ok');
      switchTab('poll');
      $('#p-bars').innerHTML = '';
    });
  } else if (q.type === 'word') {
    net.emit('word:start', { prompt: q.question, mode: 'both' }, (res) => {
      if (!res || !res.ok) return toast((res && res.msg) || '发布失败', 'err');
      toast('已开始收集', 'ok');
      switchTab('word');
      $('#w-chips').innerHTML = '';
    });
  } else {
    // 抢答题也能带题型和答案（只抢不答，答案挂在大屏上，判定后由老师决定要不要公布）
    net.emit('buzz:start', {
      prompt: q.question,
      format: q.format || 'text',
      options: q.options || [],
      correct: q.correct,
      answerText: q.answerText || '',
    }, (res) => {
      if (!res || !res.ok) return toast((res && res.msg) || '发布失败', 'err');
      toast('抢答开始！', 'ok');
      switchTab('buzz');
      $('#b-list').innerHTML = '';
    });
  }
}

/* ---- 教师口令：修改 / 复制 ---- */
$('#set-pass-edit').onclick = () => {
  const input = $('#set-pass');
  if (input.dataset.editing) {
    // 提交修改
    const p = input.value.trim();
    if (!/^\d{6}$/.test(p)) return toast('口令需为 6 位数字', 'err');
    net.emit('teacher:pass', { pass: p }, (res) => {
      if (!res || !res.ok) return toast((res && res.msg) || '修改失败', 'err');
      ls.set(`pass_${code}`, res.pass);
      toast('教师口令已更新', 'ok');
      exitPassEdit();
    });
  } else {
    // 进入编辑态
    input.dataset.editing = '1';
    input.readOnly = false;
    input.focus();
    input.select();
    $('#set-pass-edit').textContent = '保存';
  }
};
function exitPassEdit() {
  const input = $('#set-pass');
  delete input.dataset.editing;
  input.readOnly = true;
  $('#set-pass-edit').textContent = '修改';
  if (state) input.value = state.teacherPass || '';
}
$('#set-pass').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#set-pass-edit').click();
  if (e.key === 'Escape') exitPassEdit();
});
$('#set-pass-copy').onclick = async () => {
  const p = $('#set-pass').value;
  if (!p) return toast('暂无可复制的口令', 'warn');
  try { await navigator.clipboard.writeText(p); toast('口令已复制', 'ok'); }
  catch { toast(p, 'ok', 5000); }
};

/* ================= 顶栏动作 ================= */

$('#btn-wall').onclick = () => {
  window.open(`/w?room=${code}`, 'wall', 'width=1280,height=720');
  toast('已打开大屏窗口，拖到投影后按 F11 全屏', 'ok', 3600);
};
$('#btn-copy').onclick = async () => {
  const url = `${location.origin}/m?room=${code}`;
  try { await navigator.clipboard.writeText(url); toast('参与链接已复制', 'ok'); }
  catch { toast(url, 'ok', 5000); }
};
$('#btn-export').onclick = () => { location.href = `/api/room/${code}/export.csv`; };
$('#btn-sfx').onclick = (e) => {
  const on = sfx.toggle();
  e.currentTarget.textContent = on ? '🔊' : '🔇';
  toast(on ? '音效已开启' : '音效已关闭');
};
$('#btn-help').onclick = () => $('#help-modal').classList.remove('hidden');
$('#help-close').onclick = () => $('#help-modal').classList.add('hidden');
$('#help-modal').addEventListener('click', (e) => { if (e.target.id === 'help-modal') e.currentTarget.classList.add('hidden'); });

/* ================= Tab 切换 ================= */

const TAB_ORDER = ['poll', 'bank', 'word', 'wheel', 'buzz', 'seat', 'group', 'timer', 'fx', 'students', 'settings'];
function switchTab(name) {
  currentTab = name;
  $$('.nav-i').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab-pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === name));
}
$$('.nav-i').forEach((b) => (b.onclick = () => switchTab(b.dataset.tab)));

window.addEventListener('keydown', (e) => {
  if (/input|textarea|select/i.test(e.target.tagName)) return;
  const n = Number(e.key);
  if (n >= 1 && n <= 9) switchTab(TAB_ORDER[n - 1]);
  if (e.code === 'Space') {
    e.preventDefault();
    if (currentTab === 'wheel') $('#wh-spin').click();
    else if (currentTab === 'timer') {
      if (state && state.timer && state.timer.running) $('#t-pause').click();
      else $('#t-start').click();
    }
  }
});

/* ================= 恢复上次课堂 ================= */

const savedCode = (qs('room') || ls.get('last_room', '') || '').toUpperCase();
if (savedCode && ls.get(`tok_${savedCode}`)) {
  code = savedCode;
  token = ls.get(`tok_${savedCode}`);
  // 静默恢复：先显示 gate，一键回到上次课堂
  const tip = document.createElement('button');
  tip.className = 'btn btn-block';
  tip.style.marginTop = '12px';
  tip.textContent = `↩ 回到上次的课堂 ${savedCode}`;
  tip.onclick = () => { enterConsole(); };
  $('.gate-form').appendChild(tip);
}
