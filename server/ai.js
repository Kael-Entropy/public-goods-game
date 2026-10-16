// AI 席位驱动
//   kind = 'local' -> 内置策略人格（离线可玩，用来把整局跑通）
//   kind = 'api'   -> 云端大模型（OpenAI 兼容 /chat/completions），失败自动降级为 local
import { getPlayer, clampInt, netGiftOut } from './engine.js';

// ------------------------------------------------------------ 反推每个人的投入
// 公示只给持有数，但数学上可反推：
//   非被排除者：Δ = payout − x        =>  x = payout − Δ
//   被排除者  ：Δ = −x                =>  x = −Δ
//
// 加了赠与之后，Δ 里还混着私下的金币转移，反推不再精确：
//   Δ = payout − x − 赠出 + 收到      =>  x = (payout − Δ) − 净流出
// 也就是说：**赠与让暗投真正变暗了**。别人的转账你无从得知，反推只能得到
// 「投入 + 净流出」的混合值；只有自己那一份可以修正（自己知道自己转了多少）。
export function estimateContributions(state, mePid = null) {
  const out = {};   // { round: { pid: x } }
  let prev = null;
  for (const s of state.history) {
    const before = prev || Object.fromEntries(state.players.map(p => [p.id, state.config.initialCoins]));
    const cur = {};
    for (const p of state.players) {
      const d = (s.holdings[p.id] ?? before[p.id]) - (before[p.id] ?? 0);
      let x = (p.id === s.excluded) ? Math.max(0, -d) : Math.max(0, (s.payout ?? 0) - d);
      if (mePid && p.id === mePid) x = Math.max(0, x - netGiftOut(state, s.round, mePid));
      cur[p.id] = x;
    }
    out[s.round] = cur;
    prev = s.holdings;
  }
  return out;
}

export function avgContribution(state, pid) {
  const est = estimateContributions(state, pid);
  const vals = Object.values(est).map(r => r[pid]).filter(v => Number.isFinite(v));
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

// ------------------------------------------------------------ 内置策略人格

const rnd = (a, b) => a + Math.random() * (b - a);
const pick = arr => arr[Math.floor(Math.random() * arr.length)];

export function localInvest(state, p) {
  const r = state.round, R = state.config.rounds;
  const est = estimateContributions(state, p.id);
  const last = est[r - 1];
  const othersAvg = last
    ? state.players.filter(x => x.id !== p.id).reduce((s, x) => s + (last[x.id] ?? 0), 0) / (state.players.length - 1)
    : null;
  const ratio = (() => {
    switch (p.persona) {
      case 'cooperator':  return rnd(0.6, 1.0);
      case 'freeRider':   return rnd(0.0, 0.2);
      case 'reciprocator':return othersAvg == null ? rnd(0.4, 0.7) : Math.max(0, Math.min(1, othersAvg / 10)) * rnd(0.8, 1.1);
      case 'strategist':  return r <= Math.ceil(R / 2) ? rnd(0.7, 1.0) : rnd(0.0, 0.15);
      case 'waverer':     return rnd(0.15, 0.85);
      default:            return rnd(0.3, 0.7);
    }
  })();
  return clampInt(p.coins * ratio, 0, p.coins);
}

export function localVote(state, p) {
  const est = estimateContributions(state, p.id);
  const rounds = Object.values(est);
  if (!rounds.length) return null;
  const avg = {};
  for (const pl of state.players) {
    const vs = rounds.map(r => r[pl.id]).filter(v => Number.isFinite(v));
    avg[pl.id] = vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : 0;
  }
  const candidates = state.players.filter(x => x.id !== p.id);
  // 默认：投给平均投入最低的人（惩罚搭便车）
  let sorted = [...candidates].sort((a, b) => avg[a.id] - avg[b.id]);
  if (p.persona === 'freeRider') {
    // 搭便车者反咬：投给投入最高的人，把对手踢出分红
    sorted = [...candidates].sort((a, b) => avg[b.id] - avg[a.id]);
  } else if (p.persona === 'waverer' && Math.random() < 0.35) {
    return pick(candidates).id;
  }
  return sorted[0]?.id ?? null;
}

export function localRating(state, p) {
  const est = estimateContributions(state, p.id);
  const rounds = Object.values(est);
  const out = {};
  for (const t of state.players) {
    let base = 3;
    if (rounds.length) {
      const vs = rounds.map(r => r[t.id]).filter(v => Number.isFinite(v));
      const a = vs.reduce((x, y) => x + y, 0) / vs.length;   // 平均投入
      base = a >= 8 ? 5 : a >= 5 ? 4 : a >= 2.5 ? 3 : a >= 1 ? 2 : 1;
    }
    if (t.id === p.id) base = Math.min(5, base + 1);          // 给自己偏高一点
    if (p.persona === 'freeRider') base = Math.max(1, base - 1); // 搭便车者普遍刻薄
    out[t.id] = clampInt(base, 1, 5);
  }
  return out;
}

export function localTalk(state, p, ctx = {}) {
  const myAvg = avgContribution(state, p.id);
  const lines = {
    cooperator: ['我这轮投得不少，大家一起把盘子做大。', '我一直在投，别投我，投那个一直不出的。',
                 '合作才有的赚，我这票投给投入最低的。'],
    freeRider:  ['我手上要留点钱，这轮少投点。', '规则又没说必须投，我为什么要白给。',
                 '别盯着我，有人投得比我还少。'],
    reciprocator: ['我跟着大家走，上一轮平均多少我这轮就差不多。',
                   '谁投得多我就跟谁站一边。', '这轮我先看看风向。'],
    strategist: ['前期我出力，后面该收就收。', '现在投是投资声誉，不是投资金币。',
                 '最后两轮了，谁都别装。'],
    waverer:    ['我还没想好，听你们的。', '我这轮可能投，也可能不投。', '再给我点信息。'],
  };
  const pool = lines[p.persona] || lines.waverer;
  let s = pick(pool);
  if (myAvg != null) s += `（我平均投入约 ${myAvg.toFixed(1)}）`;
  return s;
}

// ------------------------------------------------------------ 云端大模型

function endpointOf(api) {
  let base = (api?.baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return null;
  if (base.endsWith('/chat/completions')) return base;
  if (base.endsWith('/v1')) return base + '/chat/completions';
  return base + '/v1/chat/completions';
}

async function callLLM(api, messages, ms = 25000) {
  const url = endpointOf(api);
  if (!url || !api.model) throw new Error('未配置 baseUrl / model');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(api.apiKey ? { Authorization: 'Bearer ' + api.apiKey } : {}),
      },
      body: JSON.stringify({
        model: api.model,
        messages,
        temperature: 0.8,
        max_tokens: 400,
      }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const txt = data?.choices?.[0]?.message?.content;
    if (typeof txt !== 'string') throw new Error('返回格式异常');
    return txt;
  } finally {
    clearTimeout(timer);
  }
}

function extractJson(text) {
  if (!text) return null;
  const s = text.replace(/```(?:json)?/g, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

function briefState(state, me) {
  const hist = state.history.map(s => {
    const h = state.players.map(p => `${p.name}:${s.holdings[p.id]}`).join(' ');
    return `第${s.round}轮 箱内${s.total} 每份${s.payout}${s.excluded ? ' 排除' + (state.players.find(p => p.id === s.excluded)?.name) : ''} ｜ ${h}`;
  });
  return [
    `第 ${state.round}/${state.config.rounds} 轮。翻倍倍数 M=${state.config.multiplier}，共 ${state.config.seats} 人。`,
    `你是 ${me.name}（席位${me.seat + 1}），当前持有 ${me.coins} 金币。`,
    `场上持有：${state.players.map(p => `${p.name}=${p.coins}`).join('，')}`,
    hist.length ? '历史公示：\n' + hist.join('\n') : '尚无历史。',
  ].join('\n');
}

// ------------------------------------------------------------ 对外统一接口

export async function decideInvest(state, p) {
  if (p.kind === 'api') {
    try {
      const txt = await callLLM(p.api, [
        { role: 'system', content: '你在一个公共财博弈游戏里。所有人往公共箱投币，箱内总额按倍数翻倍后全员平分；被投票排除的人不分钱且投入沉没。你的目标：最终评分进入前五名。只输出一行JSON。' },
        { role: 'user', content: briefState(state, p) + `\n\n决定本轮投入多少金币（整数，0~${p.coins}）。\n输出：{"invest":数字,"reason":"不超过20字"}` },
      ]);
      const j = extractJson(txt);
      if (j && Number.isFinite(Number(j.invest))) {
        return { amount: clampInt(j.invest, 0, p.coins), reason: String(j.reason || '').slice(0, 40), via: 'api' };
      }
    } catch (e) { /* 降级 */ }
  }
  return { amount: localInvest(state, p), reason: '', via: 'local' };
}

export async function decideVote(state, p) {
  if (p.kind === 'api') {
    try {
      const txt = await callLLM(p.api, [
        { role: 'system', content: '你在一个公共财博弈游戏里。现在要投票：得票≥6的人本轮不参与分红，且其投入沉没。只输出一行JSON。' },
        { role: 'user', content: briefState(state, p) + `\n\n选择你要投的人，填席位id（${state.players.map(x => x.id).join('/')}），弃权填 null。\n输出：{"target":"p3","reason":"不超过20字"}` },
      ]);
      const j = extractJson(txt);
      if (j && j.target && getPlayer(state, String(j.target))) {
        return { target: String(j.target), reason: String(j.reason || '').slice(0, 40), via: 'api' };
      }
    } catch (e) { /* 降级 */ }
  }
  return { target: localVote(state, p), reason: '', via: 'local' };
}

export async function decideRating(state, p) {
  if (p.kind === 'api') {
    try {
      const txt = await callLLM(p.api, [
        { role: 'system', content: '你要给所有玩家（含自己）打 1~5 分。分数会按打分人的金币占比加权，决定最终排名，前五名获胜。只输出一行JSON。' },
        { role: 'user', content: briefState(state, p) + `\n\n给每个人打分。\n输出：{"ratings":{"p1":5,"p2":3,...}}` },
      ]);
      const j = extractJson(txt);
      if (j?.ratings && typeof j.ratings === 'object') return { ratings: j.ratings, via: 'api' };
    } catch (e) { /* 降级 */ }
  }
  return { ratings: localRating(state, p), via: 'local' };
}

export async function decideTalk(state, p, ctx = {}) {
  if (p.kind === 'api') {
    try {
      const txt = await callLLM(p.api, [
        { role: 'system', content: '你在私密小房间里和少数玩家密谈（最多4人）。说话要短、要有立场、可以撒谎。只输出一行JSON。' },
        { role: 'user', content: briefState(state, p) + `\n\n密谈对象：${(ctx.peers || []).join('，')}\n输出：{"say":"不超过40字"}` },
      ]);
      const j = extractJson(txt);
      if (j && typeof j.say === 'string' && j.say.trim()) return { say: j.say.trim().slice(0, 80), via: 'api' };
    } catch (e) { /* 降级 */ }
  }
  return { say: localTalk(state, p, ctx), via: 'local' };
}

// ------------------------------------------------------------ 赠与决策（自由讨论期）
// 动机按人格分化：慈善 / 铁公鸡 / 互惠 / 行贿 / 随手给
export function localGift(state, p) {
  if (p.coins < 1) return null;
  const others = state.players.filter(x => x.id !== p.id);
  if (!others.length) return null;
  const r = state.round, R = state.config.rounds;
  const est = estimateContributions(state, p.id)[r - 1] || null;

  let target = null, amount = 0;
  switch (p.persona) {
    case 'cooperator': {                       // 慈善：补贴最穷的人
      const poorest = others.slice().sort((a, b) => a.coins - b.coins)[0];
      if (!poorest || poorest.coins >= p.coins) return null;
      target = poorest.id;
      amount = Math.max(1, Math.round(p.coins * 0.12));
      break;
    }
    case 'freeRider':                          // 铁公鸡：一枚不出
      return null;
    case 'reciprocator': {                     // 互惠：奖励上一轮投得最多的人
      const best = est ? others.slice().sort((a, b) => (est[b.id] ?? 0) - (est[a.id] ?? 0))[0] : null;
      if (!best || (est?.[best.id] ?? 0) <= 0) return null;
      target = best.id;
      amount = Math.max(1, Math.round(p.coins * 0.10));
      break;
    }
    case 'strategist': {                       // 行贿：后半程巴结最有钱的人（少被投、多被打分）
      if (r < Math.ceil(R / 2)) return null;
      const richest = others.slice().sort((a, b) => b.coins - a.coins)[0];
      if (!richest) return null;
      target = richest.id;
      // 有减权规则时，行贿的净收益 = 3×对方权重 − 送出量/总盘：送得越多越亏。
      // 折扣只看"有没有送过"、不看金额，所以最优是送最小的钱把人情建起来。
      const pen = Number(state.config.giftRatingPenalty);
      amount = (pen > 0 && pen < 1)
        ? clampInt(rnd(1, 3), 1, p.coins)
        : Math.max(1, Math.round(p.coins * 0.15));   // 无减权时大额买票仍然划算（净赚 4×对方权重，与金额无关）
      break;
    }
    default: {                                 // 摇摆者：一半概率随手给一点
      if (Math.random() < 0.5) return null;
      target = pick(others).id;
      amount = clampInt(rnd(1, 4), 1, p.coins);
      break;
    }
  }
  if (!target) return null;
  amount = clampInt(amount, 1, p.coins);
  return { to: target, amount };
}

export async function decideGift(state, p) {
  if (p.kind === 'api' && p.api.baseUrl && p.api.apiKey) {
    try {
      const ids = state.players.map(x => x.id).join('/');
      const txt = await callLLM(p.api, [
        { role: 'system', content: '你在一个公共财博弈游戏里。现在是自由讨论阶段，你可以私下把金币送给任何人——可以是慈善，也可以是行贿，规则不限制动机。金币数会按占比决定你最终评分的权重。只输出一行JSON。' },
        { role: 'user', content: briefState(state, p) +
          `\n\n要不要送金币？送给谁、送多少（整数，1~${p.coins}）？不送就把 to 填 null。\n输出：{"to":"p3","amount":5,"reason":"不超过20字"}` },
      ]);
      const j = extractJson(txt);
      if (j && j.to && getPlayer(state, String(j.to)) && String(j.to) !== p.id) {
        const amt = clampInt(j.amount, 1, p.coins);
        if (amt >= 1) return { to: String(j.to), amount: amt, reason: String(j.reason || '').slice(0, 40), via: 'api' };
      }
      if (j && j.to === null) return null;
    } catch (e) { /* 降级 */ }
  }
  const g = localGift(state, p);
  return g ? { ...g, via: 'local' } : null;
}

export function decideAcceptCall(state, p) {
  switch (p.persona) {
    case 'freeRider':  return Math.random() < 0.5;
    case 'cooperator': return Math.random() < 0.9;
    case 'strategist': return Math.random() < 0.8;
    default:           return Math.random() < 0.75;
  }
}
