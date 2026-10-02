/**
 * 课堂互动系统 · 房间状态与活动状态机
 * 纯内存 + JSON 快照持久化，无外部数据库依赖。
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

/* ---------------- 常量 ---------------- */

export const AVATARS = [
  '🦊', '🐼', '🐯', '🐨', '🐸', '🐵', '🐧', '🐙',
  '🦁', '🐷', '🐮', '🐔', '🐳', '🦄', '🐝', '🦉',
  '🐺', '🐗', '🐴', '🦋', '🐬', '🦖', '🐲', '🦊',
];

export const COLORS = [
  '#FF6B6B', '#FF922B', '#FFD43B', '#51CF66', '#20C997',
  '#22B8CF', '#4C6EF5', '#7950F2', '#E64980', '#F06595',
  '#94D82D', '#66D9E8',
];

// 去掉易混淆的 0/O/1/I
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** 积分规则集中配置，教师端可微调 */
export const SCORE_RULES = {
  join: 1,            // 扫码进入课堂
  seatFront: 3,       // 选择前排就坐
  seatBack: 0,        // 后排
  vote: 1,            // 参与投票
  voteCorrect: 2,     // 答对（若设置了正确答案）
  word: 1,            // 提交词语
  danmaku: 1,         // 发送弹幕
  // 2026-09-04 修订：抢答/转盘本身**不加分**了，老师根据回答情况手动加/减/0 分。
  // buzz1/buzz2/buzz3、handPicked 留作"老字段兜底"，新行为读下面的 buzzCorrect/Wrong
  // 和 wheelCorrect/Wrong。新代码不要直引这几个老字段。
  buzz1: 5,           // 老字段——新行为里已不再使用，仅作回退
  buzz2: 3,
  buzz3: 1,
  handPicked: 2,      // 老字段——同上
  cheer: 0,           // 送鼓励
  // 座位页「给前排同学加分」按钮的分值。它不自动触发，只在老师点按钮时按此值
  // 批量加分，但同样要能被设置页改——写死就成了"改了设置按钮还是 +2"。
  frontReward: 2,
  // 抢答结果加分（老师点击判定按钮时按此值加/减）
  buzzCorrect: 5,     // 答对 +5（默认）
  buzzWrong: -2,      // 答错 -2（默认；用 0 就是"答错不扣分"）
  // 提问大转盘结果加分（老师点击判定按钮时按此值加/减）
  wheelCorrect: 3,    // 答对 +3（默认）
  wheelWrong: 0,      // 答错 0 分（默认；想扣分可改成负数）
};

export function genRoomCode(len = 6) {
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

/* ---------------- 房间 ---------------- */

let seq = 0;

export class Room extends EventEmitter {
  constructor(code, opts = {}) {
    super();
    this.code = code;
    this.title = opts.title || '课堂互动';
    this.teacherToken = opts.teacherToken || null;   // 控制端凭证，防止学生误操作
    this.teacherPass = opts.teacherPass || null;     // 教师口令：换设备/换浏览器时凭它进入，可改
    this.createdAt = Date.now();
    this.students = new Map();      // id -> student
    this.activity = null;           // 当前进行中的活动
    this.history = [];              // 历史活动记录
    // 第几课。同一门课一学期要上很多次，「开始新的一课」会 +1。
    this.sessionNo = opts.sessionNo || 1;
    this.timer = { running: false, remain: 0, duration: 0, endAt: 0 };
    this.cheers = [];               // 鼓励/喝彩流水
    this.groups = [];               // 分组结果
    this.wordBlock = [];            // 被老师屏蔽的词条，之后同样内容直接拒收
    // 题库：老师提前录好的题目，课堂上点一下就发布，不用现场手打。
    // 结构 [{ id, type, question, options, correct, multi }]
    this.questionBank = opts.questionBank || [];
    this.log = [];                  // 事件日志
    this.seatMap = {
      rows: opts.rows || 6,
      cols: opts.cols || 8,
      frontRows: opts.frontRows || 2,
      backRows: opts.backRows || 2,
    };
    this.settings = {
      allowMultiVote: false,
      showCorrect: false,
      danmakuEnabled: true,
      cheerEnabled: true,
      buzzEnabled: true,
      maxWordLen: 20,
      // 分值按课堂可调，默认照抄一份全局规则（复制而不是引用，避免改一个房间
      // 把其它房间一起改了）。旧快照里没有这个字段，读取时由 scoreRule() 兜底。
      scoreRules: { ...SCORE_RULES },
    };
    this.dirty = false;
  }

  /* --- 工具 --- */
  touch(reason = '') {
    this.dirty = true;
    this.emit('change', reason);
  }

  addLog(text, kind = 'info') {
    this.log.push({ ts: Date.now(), text, kind });
    if (this.log.length > 400) this.log.shift();
  }

  nextId() {
    return `a${Date.now().toString(36)}${(seq++).toString(36)}`;
  }

  /* --- 学生 --- */
  addStudent({ nickname, avatar, color }) {
    const id = randomUUID();
    const st = {
      id,
      nickname: (nickname || '').slice(0, 12) || '匿名同学',
      avatar: avatar || AVATARS[Math.floor(Math.random() * AVATARS.length)],
      color: color || COLORS[Math.floor(Math.random() * COLORS.length)],
      seat: null,
      // 走 scoreRule() 而不是直接引用常量：否则老师在设置页把「加入 +N」改了，
      // 新同学拿到的初始分还是旧值，看着像设置没生效。
      score: this.scoreRule('join'),
      // 本次课的得分。和 score（累计总积分）分开记：
      // 老师一学期用同一个课堂码，看总分才知道谁一直认真，看本次分才知道
      // 这节课谁活跃。开新一课时它清零、总分留着。
      sessionScore: this.scoreRule('join'),
      joinedAt: Date.now(),
      lastSeen: Date.now(),
      online: true,
      sockets: new Set(),
      handsUp: false,
      buzzRank: null,
      stats: { votes: 0, correct: 0, words: 0, danmaku: 0, buzz: 0, cheers: 0, picked: 0 },
    };
    this.students.set(id, st);
    this.addLog(`${st.avatar} ${st.nickname} 加入了课堂`, 'join');
    return st;
  }

  getStudent(id) {
    return this.students.get(id);
  }

  /**
   * 本课堂的分值。settings.scoreRules 里配了就用它，没配（旧快照恢复的房间）
   * 就回落全局规则。集中在这里兜底，调用处不用各自判断。
   */
  scoreRule(key) {
    const v = this.settings.scoreRules ? Number(this.settings.scoreRules[key]) : NaN;
    return Number.isFinite(v) ? v : SCORE_RULES[key];
  }

  /**
   * 唯一的加分入口。
   *
   * 两套分同时走这里：score 是累计总积分（跨课累积），sessionScore 是本次课的
   * 得分（开新一课时清零）。所有加分都必须经过它——曾经有 7 处直接引用分值常量，
   * 结果设置页改分值不生效；集中一个入口，这类问题只会出现一次。
   */
  addScore(st, delta, reason = '') {
    if (!st) return;
    const d = delta | 0;
    st.score = Math.max(0, st.score + d);
    // 老快照恢复的房间没有 sessionScore 字段，这里补 0 再累加，
    // 否则会算出 NaN 并一路污染到前端显示。
    st.sessionScore = Math.max(0, (Number(st.sessionScore) || 0) + d);
    if (reason) this.addLog(`${st.avatar} ${st.nickname} ${delta > 0 ? '+' : ''}${delta} 分（${reason}）`, 'score');
  }

  /**
   * 找一个「离线且同名」的学生，用于换设备/清缓存后按昵称认领原身份。
   * 只认领离线的：如果同名那位还在线，说明是另一个人起了同样的名字，
   * 不能让他抢走别人的积分和座位。
   */
  findOfflineByName(nickname) {
    const n = (nickname || '').trim();
    if (!n) return null;
    for (const st of this.students.values()) {
      if (st.nickname === n && !st.online) return st;
    }
    return null;
  }

  removeStudent(id) {
    const st = this.students.get(id);
    if (st) {
      st.online = false;
      st.sockets.clear();
    }
  }

  onlineStudents() {
    return [...this.students.values()].filter((s) => s.online);
  }

  /** 排行榜：积分降序，同分按加入时间 */
  leaderboard(limit = 10) {
    return [...this.students.values()]
      .sort((a, b) => b.score - a.score || a.joinedAt - b.joinedAt)
      .slice(0, limit)
      .map((s, i) => ({
        rank: i + 1, id: s.id, nickname: s.nickname, avatar: s.avatar,
        color: s.color, score: s.score,
        // 本次课得分。前端同时显示两个分，同学才知道"我这节课表现如何"
        // 和"我整学期排第几"是两件事。
        sessionScore: Number(s.sessionScore) || 0,
        seat: s.seat, stats: s.stats,
      }));
  }

  /* --- 座位 --- */
  isFrontSeat(seat) {
    // 座位行号从 0 起算，"前 N 排"就是 row 0 ~ N-1，所以是 < 不是 <=。
    // 曾经这里写成 <=，导致服务端比前端（control/mobile/viz 全部用 row < frontRows）
    // 多算一排：座位图只标 2 排，转盘"仅前排"却能抽到第 3 排的人，导出的 CSV 也跟着错。
    return !!seat && seat.row < this.seatMap.frontRows;
  }

  /**
   * 后排（最后 N 排）。下限要抬到 frontRows，否则小教室（比如 3 排、前后各算 2 排）
   * 会把第 2 排同时算成前排和后排，转盘抽"后排"时会抽到坐在前排的人。
   */
  isBackSeat(seat) {
    const { rows, frontRows, backRows } = this.seatMap;
    const from = Math.max(frontRows || 0, rows - (backRows || 2));
    return !!seat && seat.row >= from;
  }

  takeSeat(st, seat) {
    if (!st) return { ok: false, msg: '学生不存在' };

    // 座位被「在线」同学占着 → 拒绝，并把占用者告诉前端。
    // 原来是直接把对方挤走：同学手滑点一下就把别人顶掉了，对方还不知道自己
    // 座位没了。改成拒绝，前端提示"已被 XXX 占用"，点错也不伤人。
    for (const other of this.students.values()) {
      if (other.id === st.id) continue;
      if (!other.online || !other.seat) continue;
      if (other.seat.row !== seat.row || other.seat.col !== seat.col) continue;
      return {
        ok: false, occupied: true,
        by: { nickname: other.nickname, avatar: other.avatar },
      };
    }
    // 离线同学占的座位释放掉。手机端只渲染在线同学的座位（state.seats 来自
    // onlineStudents），如果这里也拦，就会出现"看着是空座、点下去却被拒"。
    for (const other of this.students.values()) {
      if (other.id === st.id || other.online || !other.seat) continue;
      if (other.seat.row === seat.row && other.seat.col === seat.col) other.seat = null;
    }

    const wasFront = this.isFrontSeat(st.seat);
    const hadSeat = !!st.seat;
    st.seat = { row: seat.row, col: seat.col };
    const isFront = this.isFrontSeat(st.seat);
    const bonus = this.scoreRule('seatFront');
    // 只在「原本不在前排、现在坐进前排」时给分。换座时若还在前排就不重复给，
    // 否则同学来回换座就能刷分。
    const awarded = isFront && !wasFront ? bonus : 0;
    if (awarded) {
      this.addScore(st, awarded, '前排就坐');
      st.frontBonus = true;
    }
    // 分值为 0 时不写"（前排 +0）"，否则控制端的事件日志看着像出了 bug
    const bonusText = awarded ? `（前排 +${awarded}）` : hadSeat ? '（换座）' : '';
    this.addLog(`${st.avatar} ${st.nickname} 选择了 ${seat.row + 1} 排 ${seat.col + 1} 座${bonusText}`, 'seat');
    // 回传给前端，好让提示与实际加分一致：
    // 否则在前排内换座时前端照写"前排就坐 +3 分"，实际一分没加，同学会来问。
    return { ok: true, front: isFront, bonus: awarded, changed: hadSeat };
  }

  /** 取消占座（学生发现自己坐错了，先退出来再重选） */
  leaveSeat(st) {
    if (!st || !st.seat) return { ok: false, msg: '你还没有选座' };
    const seat = { ...st.seat };
    st.seat = null;
    this.addLog(`${st.avatar} ${st.nickname} 退出了 ${seat.row + 1} 排 ${seat.col + 1} 座`, 'seat');
    return { ok: true, seat };
  }

  /** 前排就坐统计 */
  seatStats() {
    let front = 0, total = 0;
    const rows = new Array(this.seatMap.rows).fill(0);
    for (const s of this.onlineStudents()) {
      if (!s.seat) continue;
      total++;
      rows[s.seat.row] = (rows[s.seat.row] || 0) + 1;
      if (this.isFrontSeat(s.seat)) front++;
    }
    return { front, total, rows, frontRows: this.seatMap.frontRows, rate: total ? Math.round((front / total) * 100) : 0 };
  }

  /* --- 活动：投票 / 小测（选择题 · 判断题 · 简答题） --- */

  /**
   * 三种题型（format）：
   *  - choice 选择题：选项由老师录入，correct 是正确项下标
   *  - judge  判断题：固定「正确 / 错误」两项，correct 是 0 / 1
   *  - text   简答题：没有选项，同学提交文字答案，answerText 是参考答案
   *
   * 判断题的选项由服务端固定下发，不让老师手打——否则「对/错」「T/F」「√/×」
   * 各种写法都要前端去猜哪个算正确项，一猜错整题就判反了。
   */
  startPoll({ question, options, multi = false, correct = null, quiz = false, format, answerText = '' }) {
    const fmt = ['choice', 'judge', 'text'].includes(format) ? format : 'choice';
    let opts = [];
    if (fmt === 'judge') {
      opts = [{ text: '正确', count: 0 }, { text: '错误', count: 0 }];
    } else if (fmt !== 'text') {
      opts = (options || [])
        .filter((o) => (o || '').toString().trim() !== '')
        .map((text) => ({ text: text.toString().trim().slice(0, 60), count: 0 }))
        .slice(0, 8);
      if (!opts.length) return null;
    }
    // 全局设置是硬闸门：设置里关掉多选，单次投票就算勾了多选也得降级为单选
    const allowMulti = fmt === 'choice' ? (!!multi && !!this.settings.allowMultiVote) : false;
    let corr = null;
    if (fmt !== 'text') {
      const n = Number(correct);
      corr = Number.isInteger(n) && n >= 0 && n < opts.length ? n : null;
    }
    const act = {
      id: this.nextId(),
      type: quiz ? 'quiz' : 'poll',
      format: fmt,
      question: question || '',
      options: opts,
      multi: allowMulti,
      correct: corr,
      // 简答题的参考答案；选择题/判断题用 correct 下标就够了，这里是空串
      answerText: fmt === 'text' ? String(answerText || '').trim().slice(0, 200) : '',
      answers: fmt === 'text' ? [] : undefined,  // 简答：同学提交的文字答案
      // 是否公布答案。默认 false：老师可以不公布（比如还要让同学再想想），
      // 以前是「一结束就自动下发 correct」，老师没有选择权。
      revealed: false,
      voters: [],          // [studentId]
      startedAt: Date.now(),
      open: true,
    };
    this.activity = act;
    const fmtName = { choice: '选择题', judge: '判断题', text: '简答题' }[fmt] || '';
    this.addLog(`发起${quiz ? '小测' : '投票'}${fmtName}：${act.question || '(无标题)'}`, 'poll');
    return act;
  }

  /** 简答题：同学提交文字答案（可以重交，覆盖上一次） */
  submitAnswer(st, text) {
    const act = this.activity;
    if (!act || (act.type !== 'poll' && act.type !== 'quiz')) return { ok: false, msg: '当前没有进行中的题目' };
    if (act.format !== 'text') return { ok: false, msg: '本题不是简答题，请选择选项' };
    // 暂停和结束都要拒，但文案必须分开（和 vote() 同理）
    if (!act.open) {
      return {
        ok: false,
        paused: !!act.paused,
        msg: act.paused ? '老师已暂停作答，请稍候' : '本题已结束',
      };
    }
    const t = String(text || '').trim().slice(0, 120);
    if (!t) return { ok: false, msg: '答案不能为空' };
    if (!act.answers) act.answers = [];
    const item = { studentId: st.id, text: t, ts: Date.now() };
    const i = act.answers.findIndex((a) => a.studentId === st.id);
    if (i >= 0) act.answers[i] = item; else act.answers.push(item);
    // 只给第一次提交加分，重改答案不该反复刷分
    if (!act.voters.includes(st.id)) {
      act.voters.push(st.id);
      st.stats.votes++;
      this.addScore(st, this.scoreRule('vote'), '参与答题');
    }
    return { ok: true };
  }

  /**
   * 公布 / 收起答案。
   * 老师可以选择「不公布」——讲评时常常想先让同学自己再想想，
   * 所以公布与否是老师的一个显式动作，不跟「结束」自动绑定。
   */
  revealAnswer(reveal = true) {
    const act = this.activity;
    if (!act) return null;
    act.revealed = !!reveal;
    this.addLog(act.revealed ? '已公布答案' : '已收起答案', 'reveal');
    return act;
  }

  vote(st, indexes) {
    const act = this.activity;
    if (!act || (act.type !== 'poll' && act.type !== 'quiz')) return { ok: false, msg: '当前没有进行中的投票' };
    // 简答题走 submitAnswer()：这里拒绝并明确告诉同学该干嘛，
    // 否则他点半天没反应会以为自己掉线了。
    if (act.format === 'text') return { ok: false, msg: '本题是简答题，请输入文字答案' };
    // 暂停和结束都要拒，但文案必须分开：说"已结束"同学会以为没机会了直接走神，
    // 说"没有进行中的投票"又会让人以为自己掉线了。暂停是"稍等还要继续"。
    if (!act.open) {
      return {
        ok: false,
        paused: !!act.paused,
        msg: act.paused ? '老师已暂停作答，请稍候' : '本轮投票已结束',
      };
    }
    if (act.voters.includes(st.id) && !act.multi) return { ok: false, msg: '你已经投过票了' };

    let list = Array.isArray(indexes) ? indexes : [indexes];
    list = [...new Set(list.map(Number))].filter((i) => i >= 0 && i < act.options.length);
    if (!list.length) return { ok: false, msg: '选项无效' };
    if (!act.multi) list = [list[0]];

    // 多选：撤回旧的再计新的
    if (act.multi && act.voters.includes(st.id)) {
      const old = (act._choices && act._choices[st.id]) || [];
      old.forEach((i) => { if (act.options[i]) act.options[i].count = Math.max(0, act.options[i].count - 1); });
    } else {
      act.voters.push(st.id);
    }
    if (!act._choices) act._choices = {};
    act._choices[st.id] = list;
    list.forEach((i) => { act.options[i].count++; });

    st.stats.votes++;
    // 分值一律走 scoreRule()：直接引用 SCORE_RULES 常量的话，老师在设置里
    // 改了分值也不会生效（只有前排加分原本走了 scoreRule，其余全是直引）。
    this.addScore(st, this.scoreRule('vote'), '参与投票');
    if (act.correct !== null && list.length === 1 && list[0] === act.correct) {
      st.stats.correct++;
      this.addScore(st, this.scoreRule('voteCorrect'), '答对');
    }
    return { ok: true };
  }

  /* --- 活动：词云 / 弹幕 --- */
  startWord({ prompt, mode = 'both' }) {
    // 全局设置是硬闸门：关掉弹幕后，无论这次活动选了什么模式都只走词云
    const realMode = this.settings.danmakuEnabled ? (mode || 'both') : 'cloud';
    const act = {
      id: this.nextId(),
      type: 'word',
      prompt: prompt || '用一个词说说你的想法',
      mode: realMode,          // cloud | danmaku | both
      items: [],               // [{text, studentId, nickname, avatar, color, ts}]
      submitters: [],
      startedAt: Date.now(),
      open: true,
    };
    this.activity = act;
    this.addLog(`发起词云/弹幕：${act.prompt}`, 'word');
    return act;
  }

  submitWord(st, text) {
    const act = this.activity;
    if (!act || act.type !== 'word') return { ok: false, msg: '当前没有进行中的词云活动' };
    if (!act.open) {
      return {
        ok: false,
        paused: !!act.paused,
        msg: act.paused ? '老师已暂停收集，请稍候' : '本轮词云已结束',
      };
    }
    const clean = (text || '').toString().trim().slice(0, this.settings.maxWordLen);
    if (!clean) return { ok: false, msg: '内容不能为空' };
    // 已被老师屏蔽的内容直接拒收，否则屏蔽一次他还能再刷一遍上大屏
    if (this.isWordBlocked(clean)) return { ok: false, msg: '这条内容已被老师屏蔽' };
    const mine = act.items.filter((i) => i.studentId === st.id).length;
    if (mine >= 5) return { ok: false, msg: '最多提交 5 条哦' };
    const item = {
      text: clean,
      studentId: st.id,
      nickname: st.nickname,
      avatar: st.avatar,
      color: st.color,
      ts: Date.now(),
    };
    act.items.push(item);
    if (!act.submitters.includes(st.id)) act.submitters.push(st.id);
    st.stats.words++;
    if (act.mode !== 'cloud') st.stats.danmaku++;
    this.addScore(st, this.scoreRule('word'), '参与互动');
    return { ok: true, item };
  }

  /* --- 词条屏蔽 --- */

  /** 大小写不敏感地比对，避免同学换个大小写就绕过屏蔽 */
  static wordKey(text) {
    return String(text || '').trim().toLowerCase();
  }

  isWordBlocked(text) {
    const k = Room.wordKey(text);
    if (!k) return false;
    return this.wordBlock.some((w) => Room.wordKey(w) === k);
  }

  /**
   * 屏蔽一个词条：从当前词云撤下所有同文本的条目，并记进黑名单。
   *
   * 大屏是教室里的公共屏幕，同学随手填的内容难免有不合适的。
   * 没有这个功能时老师只有「清空」一个办法——为了一条内容把全班的心血一起删掉，
   * 实际结果是老师干脆不敢开词云。所以要做到点一下就精准下掉一条。
   */
  hideWord(text) {
    const t = String(text || '').trim();
    if (!t) return { ok: false, msg: '内容不能为空' };
    if (!this.isWordBlocked(t)) {
      this.wordBlock.push(t);
      if (this.wordBlock.length > 200) this.wordBlock.shift();
    }
    let removed = 0;
    if (this.activity && this.activity.type === 'word') {
      const k = Room.wordKey(t);
      const before = this.activity.items.length;
      this.activity.items = this.activity.items.filter((i) => Room.wordKey(i.text) !== k);
      removed = before - this.activity.items.length;
    }
    this.addLog(`已屏蔽词条「${t}」，撤下 ${removed} 条`, 'word');
    return { ok: true, text: t, removed };
  }

  /** 解除屏蔽。屏蔽错了可以改回来，不让老师的一次误点变成永久损失。 */
  unblockWord(text) {
    const k = Room.wordKey(text);
    const before = this.wordBlock.length;
    this.wordBlock = this.wordBlock.filter((w) => Room.wordKey(w) !== k);
    return { ok: true, removed: before - this.wordBlock.length };
  }

  /* --- 活动：抢答 --- */

  /**
   * 抢答同样支持三种题型，但按约定「只抢不答」：
   * 同学照旧拼手速抢名次，题目类型和答案只是挂在大屏上给全班看，
   * 老师判定完再决定要不要公布答案。
   * 老调用（不带 format）默认 text，表现为「只有一句提示语」，和改造前完全一致。
   */
  startBuzz({ prompt, format, options, correct, answerText = '' }) {
    const fmt = ['choice', 'judge', 'text'].includes(format) ? format : 'text';
    let opts = [];
    if (fmt === 'judge') {
      opts = [{ text: '正确', count: 0 }, { text: '错误', count: 0 }];
    } else if (fmt === 'choice') {
      opts = (options || [])
        .filter((o) => (o || '').toString().trim() !== '')
        .map((text) => ({ text: text.toString().trim().slice(0, 60), count: 0 }))
        .slice(0, 8);
    }
    let corr = null;
    if (fmt !== 'text') {
      const n = Number(correct);
      corr = Number.isInteger(n) && n >= 0 && n < opts.length ? n : null;
    }
    const act = {
      id: this.nextId(),
      type: 'buzz',
      format: fmt,
      prompt: prompt || '抢答开始！',
      options: opts,
      correct: corr,
      answerText: fmt === 'text' ? String(answerText || '').trim().slice(0, 200) : '',
      revealed: false,
      ranks: [],
      startedAt: Date.now(),
      open: true,
    };
    this.activity = act;
    for (const s of this.students.values()) s.buzzRank = null;
    this.addLog(`发起抢答：${act.prompt}`, 'buzz');
    return act;
  }

  pressBuzz(st) {
    const act = this.activity;
    if (!act || act.type !== 'buzz') return { ok: false, msg: '抢答未开始' };
    if (!act.open) {
      return {
        ok: false,
        paused: !!act.paused,
        msg: act.paused ? '老师已暂停抢答，请稍候' : '本轮抢答已结束',
      };
    }
    if (act.ranks.some((r) => r.studentId === st.id)) return { ok: false, rank: st.buzzRank, msg: '你已经抢过了' };
    act.ranks.push({ studentId: st.id, ts: Date.now() });
    const rank = act.ranks.length;
    st.buzzRank = rank;
    st.stats.buzz++;
    // 2026-09-04 修订：抢答本身不再加分。是否加分由老师在控制端按"答对/答错/0 分"判定，
    // 通过 buzz:award 事件走 addScore() —— 防止"抢到就行、答错也赚分"。
    // 此处不调 addScore()，分值由老师在结果出来后手动加。
    return { ok: true, rank };
  }

  /* --- 活动：大转盘 --- */
  startWheel({ pool = 'online', count = 8, title = '' }) {
    const candidates = this.pickCandidates(pool, count);
    const act = {
      id: this.nextId(),
      type: 'wheel',
      title: title || '今天谁来回答？',
      pool,
      candidates,            // [{id, nickname, avatar, color}]
      picked: [],            // 已抽中的 id
      result: null,
      spinning: false,
      startedAt: Date.now(),
      open: true,
    };
    this.activity = act;
    this.addLog(`打开提问大转盘（${candidates.length} 人）`, 'wheel');
    return act;
  }

  pickCandidates(pool, count) {
    const all = this.onlineStudents();
    // 洗牌。Math.random() - 0.5 的洗牌严格说并不均匀，但候选池最多 12 人，
    // 偏一点不影响课堂观感，沿用原来的写法以免顺手改动引入新问题。
    const shuffle = (arr) => [...arr].sort(() => Math.random() - 0.5);
    let list = all;
    let preShuffled = false;
    if (pool === 'front') list = all.filter((s) => this.isFrontSeat(s.seat));
    else if (pool === 'hands') list = all.filter((s) => s.handsUp);
    else if (pool === 'back') {
      // 后两排优先：后排整段排在前面，切片时先入选，人不够再用其他人补齐。
      // 效果是躲后排的同学被点到的概率明显变高，同时前排也不会永远轮不到——
      // 完全排他的话，前排同学会立刻发现"坐前面反而没机会"，激励就反了。
      const back = all.filter((s) => this.isBackSeat(s.seat));
      const rest = all.filter((s) => !this.isBackSeat(s.seat));
      list = [...shuffle(back), ...shuffle(rest)];
      preShuffled = true;   // 已经洗过，下面不能再整体洗掉后排优先的顺序
    } else if (pool === 'nopick') {
      const act = this.activity;
      const picked = act && act.picked ? act.picked : [];
      list = all.filter((s) => !picked.includes(s.id));
    }
    if (!list.length) {
      list = all;
      preShuffled = false;
    }
    const shuffled = preShuffled ? list : shuffle(list);
    return shuffled.slice(0, Math.max(2, Math.min(count, 12))).map((s) => ({
      id: s.id, nickname: s.nickname, avatar: s.avatar, color: s.color,
      seat: s.seat, score: s.score,
    }));
  }

  spinWheel() {
    const act = this.activity;
    if (!act || act.type !== 'wheel') return null;
    // 排除已抽中
    let pool = act.candidates.filter((c) => !act.picked.includes(c.id));
    if (!pool.length) {
      act.picked = [];
      pool = act.candidates;
    }
    if (!pool.length) return null;
    const winner = pool[Math.floor(Math.random() * pool.length)];
    const index = act.candidates.findIndex((c) => c.id === winner.id);
    act.picked.push(winner.id);
    act.result = { ...winner, index, ts: Date.now() };
    const st = this.getStudent(winner.id);
    if (st) {
      st.stats.picked++;
      st.handsUp = false;
      // 2026-09-04 修订：转盘抽到人**不再自动加分**。是否加分由老师根据回答情况
      // 手动加/减/0 分，通过 wheel:award 事件走 addScore()。
      // 此处不调 addScore()。
    }
    this.addLog(`转盘选中：${winner.avatar} ${winner.nickname}`, 'wheel');
    return { winner, index };
  }

  /* --- 举手 --- */
  toggleHand(st, up) {
    st.handsUp = !!up;
    return st.handsUp;
  }

  /* --- 喝彩 --- */
  cheer(st, kind = '👏') {
    if (!this.settings.cheerEnabled) return false;
    st.stats.cheers++;
    this.cheers.push({ id: randomUUID(), studentId: st.id, nickname: st.nickname, avatar: st.avatar, color: st.color, kind, ts: Date.now() });
    if (this.cheers.length > 200) this.cheers.shift();
    return true;
  }

  /* --- 分组 --- */
  makeGroups(count, mode = 'random') {
    let list = this.onlineStudents();
    if (mode === 'front') {
      list = [...list].sort((a, b) => (this.isFrontSeat(b.seat) ? 1 : 0) - (this.isFrontSeat(a.seat) ? 1 : 0));
    } else {
      list = [...list].sort(() => Math.random() - 0.5);
    }
    const n = Math.max(1, Math.min(count, 12));
    const groups = Array.from({ length: n }, (_, i) => ({
      index: i,
      name: `第 ${i + 1} 组`,
      color: COLORS[i % COLORS.length],
      members: [],
    }));
    list.forEach((s, i) => {
      const g = groups[i % n];
      g.members.push({ id: s.id, nickname: s.nickname, avatar: s.avatar, color: s.color, seat: s.seat });
      s.group = g.index;
    });
    this.groups = groups;
    this.addLog(`随机分成 ${n} 组`, 'group');
    return groups;
  }

  /* --- 计时器 --- */
  setTimer(seconds) {
    this.timer = {
      running: seconds > 0,
      remain: seconds,
      duration: seconds,
      endAt: seconds > 0 ? Date.now() + seconds * 1000 : 0,
    };
    return this.timer;
  }

  tickTimer() {
    const t = this.timer;
    if (!t.running) return null;
    t.remain = Math.max(0, Math.round((t.endAt - Date.now()) / 1000));
    if (t.remain <= 0) {
      t.running = false;
      t.remain = 0;
      this.addLog('倒计时结束', 'timer');
      return { finished: true, remain: 0 };
    }
    return { finished: false, remain: t.remain };
  }

  pauseTimer() {
    if (!this.timer.running) return this.timer;
    this.timer.running = false;
    this.timer.remain = Math.max(0, Math.round((this.timer.endAt - Date.now()) / 1000));
    return this.timer;
  }

  resumeTimer() {
    if (this.timer.running || this.timer.remain <= 0) return this.timer;
    this.timer.running = true;
    this.timer.endAt = Date.now() + this.timer.remain * 1000;
    return this.timer;
  }

  /* --- 结束活动 --- */
  stopActivity() {
    const act = this.activity;
    if (!act) return null;
    act.open = false;
    act.endedAt = Date.now();
    this.history.push(JSON.parse(JSON.stringify(act, (k, v) => (k === '_choices' ? undefined : v))));
    if (this.history.length > 60) this.history.shift();
    this.activity = null;
    this.addLog('结束当前活动', 'stop');
    return act;
  }

  /**
   * 暂停（截止作答）——注意和「结束」是两件事。
   *
   * 结束 = 归档 + 把 activity 清空，大屏随即切回待机，参与结果就看不到了；
   * 而老师常常只是想「先别让他们再投了，让大家看看现在的分布」。
   * 所以暂停只把 open 置 false、打上 paused 标记，activity 原样保留，
   * 结果继续挂在大屏和手机上，之后还能「继续」再打开。
   */
  pauseActivity() {
    const act = this.activity;
    if (!act) return null;
    if (!act.open) return act;   // 已经截止了，重复点不报错
    act.open = false;
    act.paused = true;
    act.pausedAt = Date.now();
    this.addLog('已暂停作答，结果保留在大屏', 'pause');
    return act;
  }

  /** 继续作答：把暂停的活动重新打开，之前投的票/交的词都在 */
  resumeActivity() {
    const act = this.activity;
    if (!act) return null;
    act.open = true;
    act.paused = false;
    this.addLog('已继续作答', 'resume');
    return act;
  }

  /**
   * 开始新的一课：清掉上一节的临时数据，保留名单和累计总积分。
   *
   * 一学期同一门课要上很多次，老师要的是「名单和平时分延续下去，同学不用
   * 重新扫码填昵称」，但上一节的投票、词云、分组不该混进这一节的成绩里。
   *
   * 座位**每次课都清空**：教室的座位安排每节课都可能变（按小组坐、按学号坐、
   * 换教室），沿用上一节的位置反而是错的。清空后同学重新点一下即可，
   * 反正选座只要两秒——留着旧座位让老师以为"人已经坐好了"才更误事。
   *
   * 本次课得分（sessionScore）清零、总积分（score）保留：老师要看的是
   * "这节课谁活跃"和"整学期谁一直认真"两件事，混成一个数就都看不清了。
   */
  newSession() {
    this.activity = null;
    this.history = [];
    this.cheers = [];
    this.groups = [];
    for (const s of this.students.values()) {
      s.handsUp = false;
      s.buzzRank = null;
      s.group = null;
      s.seat = null;
      s.sessionScore = 0;
    }
    this.sessionNo = (this.sessionNo || 1) + 1;
    this.addLog(`—— 第 ${this.sessionNo} 课开始（名单与总积分已保留，座位与本次得分已重置）`, 'sys');
    return this.sessionNo;
  }

  /**
   * 清空全部数据：连学生、积分、座位一起清掉，回到刚建课堂的空状态。
   * 用于换班级 / 新学期。课堂码、教师口令、设置、座位表布局、屏蔽词都保留。
   */
  resetAll() {
    this.activity = null;
    this.history = [];
    this.cheers = [];
    this.groups = [];
    // 先把在线同学的 socket 记下来：清空后他们的 student 对象就没了，
    // 得让这些连接重新走一遍加入流程，否则会带着一个不存在的 id 继续发指令。
    const strays = [];
    for (const s of this.students.values()) {
      for (const sid of s.sockets) strays.push(sid);
      s.sockets.clear();
    }
    this.students.clear();
    this.sessionNo = 1;
    this.addLog('已清空全部数据（学生、积分、座位、活动记录）', 'sys');
    return { strays };
  }

  /* --- 对外快照 --- */
  publicState(view = 'wall') {
    const act = this.activity;
    const safeAct = act
      ? {
          id: act.id,
          type: act.type,
          question: act.question,
          prompt: act.prompt,
          title: act.title,
          mode: act.mode,
          multi: act.multi,
          // 题型：choice 选择题 / judge 判断题 / text 简答题（老活动没有这个字段时按选择题处理）
          format: act.format || 'choice',
          // 答案只在老师点过「公布答案」之后下发，而不是一结束就自动给——
          // 老师可以选择不公布（先让同学自己再想想），这是他的显式决定。
          revealed: !!act.revealed,
          correct: act.revealed ? act.correct : null,
          answerText: act.revealed ? (act.answerText || '') : undefined,
          options: act.options ? act.options.map((o) => ({ text: o.text, count: o.count })) : undefined,
          // 简答题的答案墙：同学们提交的文字答案（实名，大屏要能点名讲评）
          answers: act.answers
            ? act.answers.slice(-80).map((a) => {
                const s = this.getStudent(a.studentId);
                return {
                  id: a.studentId, text: a.text,
                  nickname: s ? s.nickname : '?', avatar: s ? s.avatar : '🙂', color: s ? s.color : '#999',
                };
              })
            : undefined,
          totalVotes: act.voters ? act.voters.length : undefined,
          onlineCount: this.onlineStudents().length,
          items: act.items ? act.items.slice(-120) : undefined,
          ranks: act.ranks
            ? act.ranks.map((r, i) => {
                const s = this.getStudent(r.studentId);
                return {
                  rank: i + 1,
                  id: r.studentId,
                  nickname: s ? s.nickname : '?',
                  avatar: s ? s.avatar : '🙂',
                  color: s ? s.color : '#999',
                  // 2026-09-04：老师判定的最终分（未判定是 undefined，大屏显示「待老师判定」）。
                  awarded: typeof r.awarded === 'number' ? r.awarded : undefined,
                };
              })
            : undefined,
          candidates: act.candidates,
          picked: act.picked,
          result: act.result,
          spinning: act.spinning,
          open: act.open,
          // 暂停标记：前端靠它区分「已截止但结果还在」和「活动已结束」
          paused: !!act.paused,
          pool: act.pool,
        }
      : null;

    const base = {
      code: this.code,
      title: this.title,
      sessionNo: this.sessionNo,
      activity: safeAct,
      timer: this.timer,
      seatMap: this.seatMap,
      settings: this.settings,
      stats: {
        online: this.onlineStudents().length,
        total: this.students.size,
        seat: this.seatStats(),
        hands: this.onlineStudents().filter((s) => s.handsUp).length,
      },
    };

    if (view === 'control') {
      base.teacherPass = this.teacherPass;
      base.questionBank = this.questionBank;
      base.students = [...this.students.values()].map((s) => ({
        id: s.id,
        nickname: s.nickname,
        avatar: s.avatar,
        color: s.color,
        score: s.score,
        sessionScore: Number(s.sessionScore) || 0,
        seat: s.seat,
        online: s.online,
        handsUp: s.handsUp,
        buzzRank: s.buzzRank,
        joinedAt: s.joinedAt,
        stats: s.stats,
      }));
      base.groups = this.groups;
      base.leaderboard = this.leaderboard(20);
      base.history = this.history.slice(-12);
      base.log = this.log.slice(-60);
      base.cheers = this.cheers.slice(-10);
    } else if (view === 'wall') {
      base.leaderboard = this.leaderboard(8);
      base.groups = this.groups;
      base.hands = this.onlineStudents()
        .filter((s) => s.handsUp)
        .map((s) => ({ id: s.id, nickname: s.nickname, avatar: s.avatar, color: s.color }));
      base.seats = this.onlineStudents()
        .filter((s) => s.seat)
        .map((s) => ({ id: s.id, row: s.seat.row, col: s.seat.col, avatar: s.avatar, color: s.color, nickname: s.nickname }));
      // 待机头像墙用：所有在线同学的简要信息
      base.roster = this.onlineStudents()
        .slice(0, 60)
        .map((s) => ({ id: s.id, nickname: s.nickname, avatar: s.avatar, color: s.color, score: s.score, sessionScore: Number(s.sessionScore) || 0 }));
    } else {
      // 学生端：只给必要信息
      base.leaderboard = this.leaderboard(10);
      base.groups = this.groups.map((g) => ({ index: g.index, name: g.name, color: g.color, members: g.members }));
      // 座位占用也必须下发。原来 seats 只给大屏，手机端拿不到，
      // 选座图上所有座位看着都是空的，同学点下去才被服务端告知"已被占用"——
      // 既没法避开别人的座位，也看不到是谁坐在那儿。
      // 只给坐标+头像+昵称，不含积分等无关信息。
      base.seats = this.onlineStudents()
        .filter((s) => s.seat)
        .map((s) => ({ id: s.id, row: s.seat.row, col: s.seat.col, avatar: s.avatar, color: s.color, nickname: s.nickname }));
    }
    return base;
  }

  /* --- 序列化（持久化用） --- */
  toJSON() {
    return {
      code: this.code,
      title: this.title,
      teacherToken: this.teacherToken,
      teacherPass: this.teacherPass,
      createdAt: this.createdAt,
      sessionNo: this.sessionNo,
      seatMap: this.seatMap,
      settings: this.settings,
      groups: this.groups,
      wordBlock: this.wordBlock,
      questionBank: this.questionBank,
      history: this.history,
      log: this.log.slice(-100),
      students: [...this.students.values()].map((s) => ({
        id: s.id, nickname: s.nickname, avatar: s.avatar, color: s.color,
        seat: s.seat, score: s.score, joinedAt: s.joinedAt, online: false, stats: s.stats,
        sessionScore: Number(s.sessionScore) || 0,
      })),
    };
  }

  static fromJSON(obj) {
    const r = new Room(obj.code, { title: obj.title, teacherToken: obj.teacherToken, teacherPass: obj.teacherPass, ...(obj.seatMap || {}) });
    r.createdAt = obj.createdAt || Date.now();
    r.sessionNo = obj.sessionNo || 1;
    r.settings = { ...r.settings, ...(obj.settings || {}) };
    r.groups = obj.groups || [];
    r.history = obj.history || [];
    r.log = obj.log || [];
    r.wordBlock = Array.isArray(obj.wordBlock) ? obj.wordBlock : [];
    r.questionBank = Array.isArray(obj.questionBank) ? obj.questionBank : [];
    for (const s of obj.students || []) {
      r.students.set(s.id, {
        id: s.id, nickname: s.nickname, avatar: s.avatar, color: s.color,
        seat: s.seat || null, score: s.score || 0,
        sessionScore: Number(s.sessionScore) || 0,
        joinedAt: s.joinedAt || Date.now(),
        lastSeen: Date.now(), online: false, sockets: new Set(), handsUp: false,
        buzzRank: null, stats: s.stats || { votes: 0, correct: 0, words: 0, danmaku: 0, buzz: 0, cheers: 0, picked: 0 },
      });
    }
    return r;
  }
}
