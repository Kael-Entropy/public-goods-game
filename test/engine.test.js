// 纯引擎规则测试：不开服务，同步跑完 6 轮并断言所有规则细节
import * as E from '../server/engine.js';
import * as AI from '../server/ai.js';

let fail = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg); if (!cond) fail++; };

const st = E.createRoom({ rounds: 6, multiplier: 2, seats: 10, initialCoins: 10 });

console.log('\n[1] 初始状态');
ok(st.players.length === 10, '10 个席位');
ok(st.players.every(p => p.coins === 10), '每人初始 10 金币');
ok(st.players.filter(p => p.persona).length === 9, '9 个 AI 席位都有人格');
ok(st.history.length === 0, '尚无结算记录');

console.log('\n[2] 跑完 6 轮（本地策略 AI）');
for (let r = 1; r <= 6; r++) {
  E.beginInvest(st);
  for (const p of st.players) E.submitInvestment(st, p.id, AI.localInvest(st, p));
  if (r > 1) {
    E.beginVote(st);
    for (const p of st.players) E.submitVote(st, p.id, AI.localVote(st, p));
  }
  E.settleRound(st);
  E.beginDiscuss(st);
  // 讨论期赠与：AI 按人格决定慈善 / 行贿 / 互惠
  for (const p of st.players) {
    const g = AI.localGift(st, p);
    if (g) E.submitGift(st, p.id, g.to, g.amount);
  }
}
ok(st.round === 6, '轮次推进到 6');
ok(st.history.length === 6, '产生 6 条结算记录');
ok(st.players.every(p => p.coins >= 0), '没有人的金币变成负数');

console.log('\n[3] 结算数学');
let mathOK = true;
for (const s of st.history) {
  const sharers = s.excluded ? 9 : 10;
  if (s.payout !== Math.ceil(s.total * st.config.multiplier / sharers)) mathOK = false;
}
ok(mathOK, '每份 = ceil(箱内总额 × M ÷ 分红人数)，向上取整正确');
const r1 = st.history[0];
ok(r1.excluded === null, '第 1 轮无人被排除（第 1 轮不投票）');
const withExcl = st.history.slice(1).find(s => s.excluded);
ok(!!withExcl || st.history.slice(1).every(s => s.excluded === null), '第 2 轮起投票生效（本局结果：' +
  (withExcl ? '有排除' : '本局未达 6 票') + '）');

console.log('\n[4] 对外公示不含投入额');
const pub = E.publicSummary(st.history[0]);
ok(pub.holdings && !('invest' in pub) && !('deltas' in pub), '公示只含持有数/总额/每份/被排除者');

console.log('\n[5] 反推投入（规则自带的推理空间）');
const est = AI.estimateContributions(st);
const r1est = est[1];
ok(Object.keys(r1est).length === 10, '第 1 轮 10 人的投入都能被反推');
ok(Object.values(r1est).every(v => v >= 0 && v <= 10), '反推值落在合理区间 0~10');

console.log('\n[6] 终局计分');
E.beginScoring(st);
for (const p of st.players) E.submitRating(st, p.id, AI.localRating(st, p));
const res = E.finalize(st);
ok(res.ranked.length === 10, '产出 10 人排名');
ok(res.winners.length === 4, '前 4 名获胜');
ok(res.ranked.every(x => x.score >= 1 && x.score <= 5), '最终分落在 1~5 之间');
const wsum = res.ranked.reduce((s, x) => s + x.weight, 0);
ok(Math.abs(wsum - 1) < 1e-9, '金币占比权重之和 = 1');
ok(res.ranked.every((x, i) => i === 0 || res.ranked[i - 1].score >= x.score), '按分数降序排列');
ok(res.ranked[0].win && !res.ranked[9].win, '第 1 名获胜、最后 1 名未获胜');

console.log('\n[7] 私密频道规则');
const st2 = E.createRoom({});
const c = E.createCall(st2, 'p1', ['p2', 'p3', 'p4', 'p5', 'p6']);
ok(c.ok && c.call.members.length === 1 && c.call.pending.length === 3, '邀请被裁到上限：1 主持 + 3 待定 = 共 4 人');
E.respondCall(st2, c.call.id, 'p2', true);
E.respondCall(st2, c.call.id, 'p3', true);
E.respondCall(st2, c.call.id, 'p4', true);
ok(c.call.members.length === 4, '接受后满 4 人');
const over = E.respondCall(st2, c.call.id, 'p5', true);
ok(!over.ok, '第 5 人被拒绝（超过 4 人上限）');
ok(E.createCall(st2, 'p2', ['p3']).ok === false, '已在通话中的人不能再发起');
ok(E.canTalk(st2, c.call.id, 'p2') && !E.canTalk(st2, c.call.id, 'p9'), '频道外的人看不到消息');

console.log('\n[8] 赠与规则');
const st3 = E.createRoom({ seats: 10 });
ok(E.submitGift(st3, 'p1', 'p2', 5).ok === false, '非讨论阶段不能赠与');
E.beginInvest(st3);
for (const p of st3.players) E.submitInvestment(st3, p.id, 0);
E.settleRound(st3);
E.beginDiscuss(st3);
ok(E.submitGift(st3, 'p1', 'p1', 1).ok === false, '不能赠给自己');
ok(E.submitGift(st3, 'p1', 'p2', 999).amount === 10, '超额赠与被夹到持有上限（10）');
const before = st3.players.reduce((s, p) => s + p.coins, 0);
const g1 = E.submitGift(st3, 'p3', 'p4', 3);
ok(g1.ok && g1.amount === 3, '合法赠与成功');
ok(st3.players.find(p => p.id === 'p3').coins === 7, '赠出方扣 3');
ok(st3.players.find(p => p.id === 'p4').coins === 13, '接收方加 3');
ok(st3.players.reduce((s, p) => s + p.coins, 0) === before, '赠与不改变场内金币总量');
const broke = st3.players.find(p => p.id === 'p5');
broke.coins = 0;
ok(E.submitGift(st3, 'p5', 'p6', 1).ok === false, '没有金币时不能赠与');
ok(E.submitGift(st3, 'p6', 'p7', 0).ok === false, '赠与 0 枚被拒绝');

console.log('\n[9] 赠与公示的三种可见性');
const st4 = E.createRoom({ seats: 10, giftVisibility: 'full' });
E.beginInvest(st4);
for (const p of st4.players) E.submitInvestment(st4, p.id, 0);
E.settleRound(st4); E.beginDiscuss(st4);
E.submitGift(st4, 'p1', 'p2', 4);
E.submitGift(st4, 'p8', 'p9', 6);
const gf = E.publicGifts(st4, 1);
ok(gf.mode === 'full' && gf.list.length === 2 && gf.total === 10, 'full：公开每笔明细，总额 10');
st4.config.giftVisibility = 'total';
const gt = E.publicGifts(st4, 1);
ok(gt.mode === 'total' && gt.count === 2 && gt.total === 10 && gt.list.length === 0, 'total：只给笔数与总额，不给对象');
st4.config.giftVisibility = 'secret';
const gs = E.publicGifts(st4, 1);
ok(gs.mode === 'secret' && gs.count === 0 && gs.total === 0, 'secret：笔数与总额都不给');
ok(E.publicState(st4).gifts.mode === 'secret', 'publicState 会带上裁剪后的赠与信息');

console.log('\n[10] 投入上限：0 表示不限制');
const st5 = E.createRoom({ seats: 10, maxInvestPerRound: 0 });
st5.players[0].coins = 250;
E.beginInvest(st5);
ok(E.investCap(st5, st5.players[0]) === 250, '上限 0 时可投入全部持有（250）');
E.submitInvestment(st5, 'p1', 999);
ok(st5.invest[1].p1 === 250, '提交 999 被夹到 250');
const st6 = E.createRoom({ seats: 10, maxInvestPerRound: 10 });
st6.players[0].coins = 250;
E.beginInvest(st6);
ok(E.investCap(st6, st6.players[0]) === 10, '上限 10 时最多投 10');

console.log('\n[11] 赠与会给评分权重打折（买来的票打折）');
function scoreWith(penalty, gifts) {
  const s = E.createRoom({ seats: 4, giftRatingPenalty: penalty, topWinners: 1 });
  s.players[0].coins = 60; s.players[1].coins = 20;
  s.players[2].coins = 10; s.players[3].coins = 10;
  E.beginInvest(s);
  for (const p of s.players) E.submitInvestment(s, p.id, 0);
  E.settleRound(s);
  E.beginDiscuss(s);
  for (const g of gifts) E.submitGift(s, g.from, g.to, g.amount);
  E.beginScoring(s);
  for (const p of s.players) {
    const rt = {};
    for (const q of s.players) rt[q.id] = (q.id === 'p1') ? 5 : 1;   // 所有人都给 p1 打 5 分
    E.submitRating(s, p.id, rt);
  }
  const res = E.finalize(s);
  return res.ranked.find(x => x.id === 'p1');
}
const noGift = scoreWith(0.8, []);
const withGift = scoreWith(0.8, [{ from: 'p1', to: 'p2', amount: 10 }]);
ok(Math.abs(noGift.score - 5) < 1e-9, '无人赠与时，全场 5 分 → p1 得分正好 5');
ok(withGift.effWeight < noGift.effWeight, 'p1 赠出金币后，其有效票权下降');
ok(withGift.discountedBy === 1, 'p2 那一张票被标记为打折（1 张）');
ok(withGift.score < noGift.score, '打折后 p1 的加权分确实变低（买来的分打折了）');

// 精确性：p1 赠出 10 后金币 60→50、p2 20→30（总盘 100 不变）
//   p1 权重 0.5（自票不打折）+ p2 权重 0.3 打 0.8 + p3/p4 各 0.1
const g2 = scoreWith(0.8, [{ from: 'p1', to: 'p2', amount: 10 }]);
const expect = (0.5 * 5) + (0.3 * 0.8 * 5) + (0.1 * 5) + (0.1 * 5);
ok(Math.abs(g2.score - expect) < 1e-9, `折扣精确生效：${g2.score.toFixed(2)} = 预期 ${expect.toFixed(2)}`);

const off = scoreWith(1, [{ from: 'p1', to: 'p2', amount: 10 }]);
ok(Math.abs(off.score - 5) < 1e-9, 'penalty=1 时关闭减权，赠与不影响评分');
ok(off.discountedBy === 0, 'penalty=1 时无人被标记为打折');

// 方向性：只有「收钱的人 → 送钱的人」那一票打折；「送钱的人 → 收钱的人」不打折
const s3 = E.createRoom({ seats: 4, giftRatingPenalty: 0.8 });
s3.players[0].coins = 60; s3.players[1].coins = 20; s3.players[2].coins = 10; s3.players[3].coins = 10;
E.beginInvest(s3);
for (const p of s3.players) E.submitInvestment(s3, p.id, 0);
E.settleRound(s3); E.beginDiscuss(s3);
E.submitGift(s3, 'p2', 'p1', 10);       // p2 送钱给 p1
E.beginScoring(s3);
for (const p of s3.players) {
  const rt = {}; for (const q of s3.players) rt[q.id] = 5;   // 全场互给 5 分，隔离评分差异
  E.submitRating(s3, p.id, rt);
}
const res3 = E.finalize(s3).ranked;
ok(res3.find(x => x.id === 'p2').discountedBy === 1, 'p1 收过 p2 的钱 → p1 给 p2 的那一票打折');
ok(res3.find(x => x.id === 'p1').discountedBy === 0, 'p2 没收到钱 → p2 给 p1 的票不打折（送钱方不打折）');
ok(E.ratingPenalty(s3, 'p1', 'p2') === 0.8, 'ratingPenalty：p1 收过 p2 的钱 → p1 给 p2 打 0.8');
ok(E.ratingPenalty(s3, 'p2', 'p1') === 1, 'ratingPenalty：p2 没收过 p1 的钱 → 不打折');
ok(Object.keys(E.receivedBy(s3, 'p1')).length === 1 && E.receivedBy(s3, 'p1').p2 === 10, 'receivedBy：p1 只看到自己收过 p2 的 10 枚');
ok(Object.keys(E.sentBy(s3, 'p2')).length === 1 && E.sentBy(s3, 'p2').p1 === 10, 'sentBy：p2 只看到自己送出给 p1 的 10 枚');
ok(Object.keys(E.receivedBy(s3, 'p3')).length === 0, '没参与赠与的人，receivedBy 为空');

console.log(fail === 0 ? '\n全部通过\n' : `\n${fail} 项未通过\n`);
process.exit(fail === 0 ? 0 : 1);
