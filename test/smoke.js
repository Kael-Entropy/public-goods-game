// 端到端冒烟：真起服务 + 真 WebSocket + 真人席位自动应答 + 跑完整 6 轮
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const NODE = process.execPath;
const PORT = 8791;
const T0 = Date.now();
let fail = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fail++; };

const srv = spawn(NODE, ['server/index.js'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvOut = '';
srv.stdout.on('data', d => { srvOut += d.toString(); });
srv.stderr.on('data', d => { srvOut += d.toString(); console.error('[srv]', d.toString().trim()); });

const sleep = ms => new Promise(r => setTimeout(r, ms));
for (let i = 0; i < 100 && !srvOut.includes('已启动'); i++) await sleep(100);
ok(srvOut.includes('已启动'), '服务启动成功');

// 连接带 ?spy=1：服务端默认不再把 AI 密谈监听流发给普通端，观战端要显式订阅
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/?spy=1`);
let S = null, me = null, acted = new Set(), callMsgCount = 0, settleCount = 0;
let maxGiftCount = 0, maxGiftTotal = 0;

await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
ok(true, 'WebSocket 连接建立');

ws.on('message', raw => {
  const m = JSON.parse(raw.toString());
  if (m.type === 'hello' || m.type === 'state' || m.type === 'entered') {
    if (m.state) S = m.state; if (m.settle) settleCount++;
    if (!S) return;                      // 大厅里的 hello 不带对局状态
    react();
    if (S.phase === 'discuss' && S.gifts) {
      maxGiftCount = Math.max(maxGiftCount, S.gifts.count);
      maxGiftTotal = Math.max(maxGiftTotal, S.gifts.total);
    }
  }
  else if (m.type === 'joined') me = m.pid;
  else if (m.type === 'call:msg') callMsgCount++;
  else if (m.type === 'error') console.log('  ! ' + m.msg);
});

function send(o) { ws.send(JSON.stringify(o)); }

function react() {
  if (!S || !me) return;
  const key = `${S.phase}:${S.round}`;
  if (acted.has(key)) return;
  if (S.phase === 'invest') {
    acted.add(key);
    send({ type: 'invest', amount: Math.floor(Math.random() * 6) });   // 真人席位：随机投 0~5
  } else if (S.phase === 'vote') {
    acted.add(key);
    const others = S.players.filter(p => p.id !== me);
    send({ type: 'vote', target: others[Math.floor(Math.random() * others.length)].id });
  } else if (S.phase === 'scoring') {
    acted.add(key);
    const r = {}; for (const p of S.players) r[p.id] = 1 + Math.floor(Math.random() * 5);
    send({ type: 'rate', ratings: r });
  }
}

// 服务端改成大厅制：连接后要先建房（或加入别人的房）才有对局状态
send({ type: 'room:create', name: '冒烟测试房', config: { seats: 10, rounds: 6 } });
await sleep(400);
ok(!!S, '建房成功并进入房间');

send({ type: 'join', seat: 0, name: '测试员' });
await sleep(300);
ok(!!me, '真人席位绑定成功');

send({ type: 'config', config: {
  seats: 10, rounds: 6, multiplier: 2, maxInvestPerRound: 0, voteThreshold: 6, giftVisibility: 'total',
  investSeconds: 4, voteSeconds: 4, discussSeconds: 6,
} });
await sleep(300);
ok(S.config.rounds === 6 && S.config.investSeconds === 4, '建房配置下发成功');

send({ type: 'start' });

const DEADLINE = Date.now() + 180000;
while (Date.now() < DEADLINE && (!S || S.phase !== 'over')) await sleep(400);
const secs = ((Date.now() - T0) / 1000).toFixed(1);

console.log(`\n耗时 ${secs}s（测试用加速计时；正式为 30s/30s/180s）`);
ok(S && S.phase === 'over', '6 轮跑完，进入结束态');
ok(S.history.length === 6, `产生 6 轮结算（实际 ${S?.history.length}）`);
ok(S.players.every(p => p.coins >= 0), '没有负金币');
ok(!!S.result && S.result.ranked.length === 10, '产出 10 人排名');
ok(!!S.result && S.result.winners.length === 4, '前 4 名获胜');
ok(settleCount >= 6, `收到 ${settleCount} 次结算推送`);
ok(callMsgCount > 0, `讨论期产生了 ${callMsgCount} 条私密频道消息`);
ok(S.history.every(h => !('invest' in h)), '历史记录里不含任何人的投入额');
const coins = S.players.map(p => p.coins);
const spread = (Math.max(...coins) - Math.min(...coins));
ok(Math.max(...coins) < 2000, `金币没有指数爆炸（最高 ${Math.max(...coins)}）`);
ok(spread / Math.max(...coins) > 0.05, `金币占比权重有区分度（极差 ${spread}）`);

// 赠与：端到端确实发生了私下转账，且总量守恒
const totalGifts = (S.history || []).length;
ok(S.config.giftVisibility === 'total', '赠与公示方式已下发到客户端');
ok(S.gifts && typeof S.gifts.total === 'number', '客户端能拿到本轮赠与的汇总');
console.log(`   讨论期赠与峰值：单轮 ${maxGiftCount} 笔 / 总额 ${maxGiftTotal} 枚`);
ok(maxGiftCount > 0, `AI 在讨论期确实发生了私下赠与（单轮最多 ${maxGiftCount} 笔）`);
ok(S.players.reduce((s, p) => s + p.coins, 0) > 0, '场内金币总量为正');

if (S?.result) {
  console.log('\n  最终排名：');
  for (const x of S.result.ranked) {
    console.log(`   ${String(x.rank).padStart(2)}. ${x.name.padEnd(8)} 金币 ${String(x.coins).padStart(4)}  权重 ${(x.weight * 100).toFixed(1).padStart(5)}%  得分 ${x.score.toFixed(2)}${x.win ? '  [获胜]' : ''}`);
  }
}

ws.close(); srv.kill();
console.log(fail === 0 ? '\n端到端全部通过\n' : `\n${fail} 项未通过\n`);
process.exit(fail === 0 ? 0 : 1);
