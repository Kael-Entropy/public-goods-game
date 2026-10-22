// 公共财博弈 · 规则引擎（纯逻辑，不依赖网络，可单独跑测试）
// 规则要点：
//   10 人 / 初始 10 金 / 6 轮
//   每轮：投资 -> 投票(第2轮起) -> 翻倍平分(向上取整) -> 公示持有数 -> 自由讨论
//   ≥6 票可指定 1 人不参与分钱，其投入沉没
//   只公示持有数，不公示每轮投入
//   终局互评 1~5 分，按"金币占比"加权，前 4 名获胜（建房可改）

export const DEFAULTS = {
  seats: 10,
  initialCoins: 10,
  rounds: 6,
  multiplier: 2,         // 建房可改，默认 2（M < 席位数 → 搭便车诱惑极大，合作靠社交层逼出来）
  maxInvestPerRound: 0,  // 0 = 不限制，可投入 0 ~ 当前持有
  investSeconds: 30,
  voteSeconds: 30,
  discussSeconds: 180,
  scoringSeconds: 90,
  settleSeconds: 4,      // 结算公示停留时间：太短玩家根本来不及看清每份多少、谁被投出
  voteThreshold: 6,      // 至少 6 票
  maxCallMembers: 4,     // 通话最多 4 人
  giftVisibility: 'total', // 赠与公示方式：full=全公开 / total=只公示笔数与总额 / secret=不公示
  giftRatingPenalty: 0.8,  // 被赠予者给赠予者打分时，其金币权重打这个折（1 = 关闭）。买来的票打折。
  topWinners: 4,      // 获胜名额（建房可改）
  // 团队达标线：结束时人均金币达不到这个数，全员失败（无人获胜）。0 = 不设门槛。
  // 默认 20 = 初始金币的 2 倍。数学上「平均金币 = 初始 + 人均累计投入」，
  // 所以这条线等于"每个人都把自己最初的本金完整投入过一遍"：
  // 全不投 10、半数人每轮投 2 是 16、全员敷衍投 1 也是 16，都过不了；全员认真投 2 到 22，刚好过。
  targetAvgCoins: 20,
  rateMin: 1,
  rateMax: 5,
  defaultRating: 3,      // 未打分时的兜底值
};

export const PERSONAS = ['cooperator', 'freeRider', 'reciprocator', 'strategist', 'waverer'];

// ---------------------------------------------------------------- 房间

export function createRoom(cfg = {}) {
  const config = { ...DEFAULTS, ...cfg };
  config.seats = clampInt(config.seats, 2, 12);
  config.multiplier = Number(config.multiplier) || DEFAULTS.multiplier;
  // 达标线：0 或留空 = 不设门槛；上限给到 999，别让建房手滑填出无法达成的数
  config.targetAvgCoins = clampInt(config.targetAvgCoins ?? DEFAULTS.targetAvgCoins, 0, 999);

  const players = [];
  for (let i = 0; i < config.seats; i++) {
    players.push({
      id: 'p' + (i + 1),
      seat: i,
      name: `席位${i + 1}`,
      kind: i === 0 ? 'human' : 'local',   // human | api | local
      persona: null,                        // 本地策略 AI 的人格
      coins: config.initialCoins,
      api: { baseUrl: '', apiKey: '', model: '' },
      connected: false,
    });
  }
  assignPersonas(players);

  return {
    config,
    phase: 'lobby',        // lobby|invest|vote|settle|discuss|scoring|over
    round: 0,
    players,
    phaseEndsAt: 0,
    invest: {},            // { round: { pid: n } }
    votes: {},             // { round: { voterId: targetId|null } }
    ratings: {},           // { raterId: { targetId: 1..5 } }
    gifts: {},             // { round: [ { from, to, amount, t } ] }  讨论期私下的金币转移
    calls: [],             // 私密频道
    callSeq: 0,
    history: [],           // 每轮结算摘要（对外只发 holdings / total / payout / excluded）
    log: [],
    result: null,
  };
}

function assignPersonas(players) {
  const pool = ['cooperator', 'cooperator', 'freeRider', 'reciprocator',
                'strategist', 'waverer', 'cooperator', 'freeRider', 'reciprocator', 'strategist'];
  players.forEach((p, i) => { if (p.kind !== 'human') p.persona = pool[i % pool.length]; });
}

export function clampInt(v, lo, hi) {
  v = Math.floor(Number(v));
  if (!Number.isFinite(v)) v = lo;
  return Math.min(hi, Math.max(lo, v));
}

// ---------------------------------------------------------------- 阶段

export function phaseDuration(state, phase) {
  const c = state.config;
  switch (phase) {
    case 'invest':  return c.investSeconds * 1000;
    case 'vote':    return c.voteSeconds * 1000;
    case 'discuss': return c.discussSeconds * 1000;
    case 'scoring': return c.scoringSeconds * 1000;
    case 'settle':  return c.settleSeconds * 1000;
    default:        return 0;
  }
}

export function beginInvest(state) {
  state.round += 1;
  state.phase = 'invest';
  state.invest[state.round] = {};
  state.votes[state.round] = {};
  state.gifts[state.round] = [];
  state.calls = [];
  pushLog(state, `第 ${state.round} 轮 · 投资阶段开始`);
  return state;
}

export function beginVote(state) {
  state.phase = 'vote';
  pushLog(state, `第 ${state.round} 轮 · 投票阶段开始`);
  return state;
}

export function beginDiscuss(state) {
  state.phase = 'discuss';
  pushLog(state, `第 ${state.round} 轮 · 自由讨论 ${Math.round(state.config.discussSeconds)} 秒`);
  return state;
}

export function beginScoring(state) {
  state.phase = 'scoring';
  state.calls = [];
  pushLog(state, '终局 · 互评打分开始');
  return state;
}

// ---------------------------------------------------------------- 投资

export function investCap(state, p) {
  const cap = state.config.maxInvestPerRound;
  return cap > 0 ? Math.min(p.coins, cap) : p.coins;
}

export function submitInvestment(state, pid, amount) {
  if (state.phase !== 'invest') return { ok: false, reason: '当前不是投资阶段' };
  const p = getPlayer(state, pid);
  if (!p) return { ok: false, reason: '席位不存在' };
  const x = clampInt(amount, 0, investCap(state, p));
  state.invest[state.round][pid] = x;
  return { ok: true, amount: x };
}

export function investmentsComplete(state) {
  const rec = state.invest[state.round] || {};
  return state.players.every(p => p.kind === 'human'
    ? (!p.connected || rec[p.id] !== undefined)
    : rec[p.id] !== undefined);
}

export function submitVote(state, voterId, targetId) {
  if (state.phase !== 'vote') return { ok: false, reason: '当前不是投票阶段' };
  if (!getPlayer(state, voterId)) return { ok: false, reason: '席位不存在' };
  if (targetId && !getPlayer(state, targetId)) return { ok: false, reason: '目标不存在' };
  state.votes[state.round][voterId] = targetId || null;
  return { ok: true };
}

export function votesComplete(state) {
  const rec = state.votes[state.round] || {};
  return state.players.every(p => p.kind === 'human'
    ? (!p.connected || rec[p.id] !== undefined)
    : rec[p.id] !== undefined);
}

// ---------------------------------------------------------------- 结算

export function settleRound(state) {
  const r = state.round;
  const inv = state.invest[r] || {};
  const votes = state.votes[r] || {};

  const tally = {};
  for (const target of Object.values(votes)) {
    if (!target) continue;
    tally[target] = (tally[target] || 0) + 1;
  }
  let excluded = null;
  for (const [pid, n] of Object.entries(tally)) {
    if (n >= state.config.voteThreshold) { excluded = pid; break; }
  }

  let total = 0;
  for (const p of state.players) total += inv[p.id] ?? 0;

  const sharers = state.players.filter(p => p.id !== excluded).length;
  const payout = sharers > 0 ? Math.ceil((total * state.config.multiplier) / sharers) : 0;

  const deltas = {};
  for (const p of state.players) {
    const x = inv[p.id] ?? 0;
    p.coins -= x;                       // 投入先付出（被排除者沉没）
    if (p.id === excluded) {
      deltas[p.id] = -x;
    } else {
      p.coins += payout;
      deltas[p.id] = payout - x;
    }
  }

  const holdings = {};
  for (const p of state.players) holdings[p.id] = p.coins;

  const summary = {
    round: r, excluded, total, payout,
    tally,                              // 仅服务端/复盘用，不下发
    deltas,                             // 同上：对外不公开投入
    gifts: state.gifts[r] || [],        // 同上：赠与明细不下发
    holdings,
  };
  state.history.push(summary);
  pushLog(state, `第 ${r} 轮结算：箱内 ${total}，每份 ${payout}` +
    (excluded ? `，${nameOf(state, excluded)} 被排除` : '，无人被排除'));
  return summary;
}

// 对外公示：只给持有数 + 箱内总额 + 每份金额 + 被排除者
export function publicSummary(summary) {
  return {
    round: summary.round,
    excluded: summary.excluded,
    total: summary.total,
    payout: summary.payout,
    holdings: summary.holdings,
  };
}

// ---------------------------------------------------------------- 私密频道（非议会制）

export function createCall(state, hostId, inviteIds = []) {
  const max = state.config.maxCallMembers;
  if (findCallOf(state, hostId)) return { ok: false, reason: '你已在通话中' };
  const members = [hostId];
  const pending = [];
  for (const id of inviteIds) {
    if (id === hostId) continue;
    if (!getPlayer(state, id)) continue;
    if (members.length + pending.length >= max) break;
    pending.push(id);
  }
  const call = { id: 'c' + (++state.callSeq), members, pending, createdAt: Date.now() };
  state.calls.push(call);
  return { ok: true, call };
}

export function respondCall(state, callId, pid, accept) {
  const call = state.calls.find(c => c.id === callId);
  if (!call) return { ok: false, reason: '通话不存在' };
  const idx = call.pending.indexOf(pid);
  if (idx < 0) return { ok: false, reason: '你没有待处理的邀请' };
  call.pending.splice(idx, 1);
  if (accept) {
    if (call.members.length >= state.config.maxCallMembers) return { ok: false, reason: '通话已满 4 人' };
    if (findCallOf(state, pid)) return { ok: false, reason: '你已在通话中' };
    call.members.push(pid);
  }
  return { ok: true, call, accepted: !!accept };
}

export function findCallOf(state, pid) {
  return state.calls.find(c => c.members.includes(pid)) || null;
}

export function leaveCall(state, pid) {
  const call = findCallOf(state, pid);
  if (!call) return { ok: false };
  call.members = call.members.filter(m => m !== pid);
  if (call.members.length === 0) state.calls = state.calls.filter(c => c.id !== call.id);
  return { ok: true, call };
}

export function canTalk(state, callId, pid) {
  const call = state.calls.find(c => c.id === callId);
  return !!call && call.members.includes(pid);
}

// ---------------------------------------------------------------- 赠与（自由讨论期的私下金币转移）

export function giftAllowed(state) {
  return state.phase === 'discuss';
}

export function submitGift(state, fromId, toId, amount) {
  if (!giftAllowed(state)) return { ok: false, reason: '只能在自由讨论阶段赠与金币' };
  const from = getPlayer(state, fromId), to = getPlayer(state, toId);
  if (!from) return { ok: false, reason: '席位不存在' };
  if (!to) return { ok: false, reason: '受赠席位不存在' };
  if (fromId === toId) return { ok: false, reason: '不能赠给自己' };
  if (from.coins <= 0) return { ok: false, reason: '你没有金币可赠' };
  // 先按 0 夹下界：填 0 应被拒绝，而不是悄悄变成 1
  const raw = clampInt(amount, 0, from.coins);
  if (raw < 1) return { ok: false, reason: '赠与数量必须至少 1 枚' };
  const x = raw;
  from.coins -= x;
  to.coins += x;
  const rec = { from: fromId, to: toId, amount: x, t: Date.now() };
  (state.gifts[state.round] = state.gifts[state.round] || []).push(rec);
  pushLog(state, state.config.giftVisibility === 'full'
    ? `${nameOf(state, fromId)} 赠给 ${nameOf(state, toId)} ${x} 枚金币`
    : '讨论期发生了 1 笔金币转移');
  return { ok: true, amount: x, gift: rec };
}

// 赠与的对外公示：按建房时选的可见性裁剪
export function publicGifts(state, round) {
  const list = state.gifts[round] || [];
  const total = list.reduce((s, g) => s + g.amount, 0);
  const v = state.config.giftVisibility;
  if (v === 'full') {
    return { mode: 'full', count: list.length, total,
             list: list.map(g => ({ from: g.from, to: g.to, amount: g.amount })) };
  }
  if (v === 'secret') return { mode: 'secret', count: 0, total: 0, list: [] };
  return { mode: 'total', count: list.length, total, list: [] };
}

// ---------------------------------------------------------------- 打分与结果

export function submitRating(state, raterId, ratings) {
  if (state.phase !== 'scoring') return { ok: false, reason: '当前不是打分阶段' };
  if (!getPlayer(state, raterId)) return { ok: false, reason: '席位不存在' };
  const clean = {};
  for (const p of state.players) {
    const v = ratings?.[p.id];
    clean[p.id] = Number.isFinite(Number(v))
      ? clampInt(v, state.config.rateMin, state.config.rateMax)
      : state.config.defaultRating;
  }
  state.ratings[raterId] = clean;
  return { ok: true };
}

export function ratingsComplete(state) {
  return state.players.every(p => p.kind === 'human'
    ? (!p.connected || !!state.ratings[p.id])
    : !!state.ratings[p.id]);
}

// 最终分 = 以"打分人的金币占比"为权重的加权平均
//   score_j = Σ_i ( coins_i / 总金币 ) × 折扣_{i→j} × rating_{i→j}
// 折扣：i 曾收到 j 的赠与 → i 给 j 的这一票按 giftRatingPenalty 打折（默认 0.8）
//   买来的票打折。不归一化——撒钱越广，有效票权掉得越多。
export function finalize(state) {
  const players = state.players;
  const totalCoins = players.reduce((s, p) => s + p.coins, 0);

  const weights = {};
  for (const p of players) {
    weights[p.id] = totalCoins > 0 ? p.coins / totalCoins : 1 / players.length;
  }

  const giftM = giftReceivedMatrix(state);
  const penRaw = Number(state.config.giftRatingPenalty);
  const pen = (Number.isFinite(penRaw) && penRaw > 0 && penRaw < 1) ? penRaw : 1;

  const scores = {};
  const effWeight = {};   // 打折后某人身上的有效票权总和（≤1，越广撒钱越少）
  const discounted = {};  // 有多少人的票被打了折
  for (const t of players) {
    let acc = 0, wsum = 0, n = 0;
    for (const r of players) {
      const v = state.ratings[r.id]?.[t.id] ?? state.config.defaultRating;
      const f = (giftM[r.id] && giftM[r.id][t.id] > 0) ? pen : 1;
      if (f < 1) n++;
      const w = weights[r.id] * f;
      acc += w * v;
      wsum += w;
    }
    scores[t.id] = acc;
    effWeight[t.id] = wsum;
    discounted[t.id] = n;
  }

  // 累计投入：同分时的决胜依据
  // 注意不能用金币决胜——搭便车者本来就更有钱，用金币决胜等于再奖励一次自私，
  // 会让"抱团互刷同分"的联盟靠金币碾压晋级（实测平权下联盟仍能靠金币拿下全部名额）。
  const invested = {};
  for (const p of players) {
    let s = 0;
    for (let r = 1; r <= state.round; r++) s += state.invest[r]?.[p.id] ?? 0;
    invested[p.id] = s;
  }

  const ranked = players.map(p => ({
    id: p.id, name: p.name, seat: p.seat,
    coins: p.coins,
    invested: invested[p.id],
    weight: weights[p.id],
    effWeight: effWeight[p.id],        // 打折后的有效票权和
    discountedBy: discounted[p.id],    // 有多少张票被打了折
    score: scores[p.id],
  })).sort((a, b) => (b.score - a.score) || (b.invested - a.invested) || (b.coins - a.coins) || (a.seat - b.seat));

  ranked.forEach((x, i) => { x.rank = i + 1; x.win = i < state.config.topWinners; });

  // 团队达标线：全场懒到一定程度，谁也别想赢。
  // 这条线只看平均水平，不看个人——所以它惩罚的是"集体摆烂"，而不是某个搭便车的人。
  const seatCount = players.length || 1;
  const avgCoins = Math.round((totalCoins / seatCount) * 10) / 10;
  const target = Number(state.config.targetAvgCoins) || 0;
  const met = target <= 0 || avgCoins >= target;
  if (!met) {
    for (const x of ranked) x.win = false;
    pushLog(state, `团队未达标：人均 ${avgCoins} 金币，未达到 ${target}，本局无人获胜`);
  } else if (target > 0) {
    pushLog(state, `团队达标：人均 ${avgCoins} 金币（门槛 ${target}）`);
  }

  state.result = {
    totalCoins,
    giftRatingPenalty: pen,
    goal: { target, avg: avgCoins, met },
    ranked,
    winners: met ? ranked.slice(0, state.config.topWinners).map(x => x.id) : [],
  };
  state.phase = 'over';
  pushLog(state, '游戏结束');
  return state.result;
}

// ---------------------------------------------------------------- 工具

export function getPlayer(state, pid) {
  return state.players.find(p => p.id === pid) || null;
}

// 某人在某一轮的赠与净流出（赠出 − 收到）
export function netGiftOut(state, round, pid) {
  let net = 0;
  for (const g of state.gifts[round] || []) {
    if (g.from === pid) net += g.amount;
    if (g.to === pid) net -= g.amount;
  }
  return net;
}

// 全局赠与关系网：recv[收款人][付款人] = 累计枚数（跨轮累计，与公示档位无关）
export function giftReceivedMatrix(state) {
  const m = {};
  for (const r of Object.keys(state.gifts || {})) {
    for (const g of state.gifts[r] || []) {
      if (!m[g.to]) m[g.to] = {};
      m[g.to][g.from] = (m[g.to][g.from] || 0) + g.amount;
    }
  }
  return m;
}

// 评分权重折扣：rater 曾收到 target 的金币 → rater 给 target 的这一票按 giftRatingPenalty 打折
// 目的：花钱买来的评分话语权打折。注意是"收钱的人给送钱的人打分"才打折，反向不打折。
export function ratingPenalty(state, raterId, targetId) {
  const k = Number(state.config.giftRatingPenalty);
  if (!Number.isFinite(k) || k >= 1 || k <= 0) return 1;
  const m = giftReceivedMatrix(state);
  return (m[raterId] && m[raterId][targetId] > 0) ? k : 1;
}

// 某人收到过的赠与（按付款人汇总）。只发给当事人自己——收没收到钱，自己当然知道。
export function receivedBy(state, pid) {
  const m = giftReceivedMatrix(state);
  return m[pid] ? { ...m[pid] } : {};
}

// 某人送出过的赠与（按收款人汇总）。同样只发给当事人自己。
export function sentBy(state, pid) {
  const m = {};
  for (const r of Object.keys(state.gifts || {})) {
    for (const g of state.gifts[r] || []) {
      if (g.from !== pid) continue;
      m[g.to] = (m[g.to] || 0) + g.amount;
    }
  }
  return m;
}
export function nameOf(state, pid) {
  return getPlayer(state, pid)?.name ?? pid;
}
export function pushLog(state, text) {
  state.log.push({ t: Date.now(), text });
  if (state.log.length > 400) state.log.shift();
}

// 给客户端的完整房间视图（不含任何人的本轮投入）
export function publicState(state) {
  return {
    phase: state.phase,
    round: state.round,
    phaseEndsAt: state.phaseEndsAt,
    config: {
      seats: state.config.seats,
      rounds: state.config.rounds,
      multiplier: state.config.multiplier,
      voteThreshold: state.config.voteThreshold,
      maxCallMembers: state.config.maxCallMembers,
      topWinners: state.config.topWinners,
      maxInvestPerRound: state.config.maxInvestPerRound,
      targetAvgCoins: state.config.targetAvgCoins,
      giftVisibility: state.config.giftVisibility,
      giftRatingPenalty: state.config.giftRatingPenalty,
      investSeconds: state.config.investSeconds,
      voteSeconds: state.config.voteSeconds,
      discussSeconds: state.config.discussSeconds,
      scoringSeconds: state.config.scoringSeconds,
      settleSeconds: state.config.settleSeconds,
    },
    players: state.players.map(p => ({
      id: p.id, seat: p.seat, name: p.name, kind: p.kind,
      coins: p.coins, connected: p.connected,
      api: { baseUrl: p.api.baseUrl, model: p.api.model, hasKey: !!p.api.apiKey },
      // 注意：这里不再下发 persona —— 人格一旦外泄，推理博弈就退化成读标签
    })),
    investDone: Object.keys(state.invest[state.round] || {}).length,
    voteDone: Object.keys(state.votes[state.round] || {}).length,
    ratingDone: Object.keys(state.ratings).length,
    // 当前人均金币：UI 上画达标进度条用（服务端算好，省得每个客户端各算一遍）
    avgCoins: Math.round((state.players.reduce((s, p) => s + p.coins, 0) / (state.players.length || 1)) * 10) / 10,
    calls: state.calls.map(c => ({ id: c.id, members: c.members.slice(), pending: c.pending.slice() })),
    gifts: publicGifts(state, state.round),
    history: state.history.map(publicSummary),
    log: state.log.slice(-60),
    result: state.result,
  };
}
