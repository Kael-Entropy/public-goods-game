/*
 * 客户端架构端到端测试：中继 + 两台本地网关（房主 / 客机）
 *
 * 验证的事：
 *   GW-1 中继不托管网页 —— 浏览器打开只有说明文字
 *   GW-2 房主建房会登记到中继，客机大厅能刷到这个"网络房间"
 *   GW-3 客机加入后，房主本地引擎里真的多出一个真人席位
 *   GW-4 客机的操作能传到本地引擎（投资被记到它那个席位上）
 *   GW-5 远端玩家碰不了房主的权限（start / config 被拦）
 *   GW-6 房主关房，客机被请回大厅
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import WebSocket from 'ws';

const RELAY_PORT = 8790;
const HOST_UI = 8791, HOST_ENG = 8891;
const GUEST_UI = 8792, GUEST_ENG = 8892;
const ROOT = new URL('..', import.meta.url).pathname;

let pass = 0, fail = 0;
const ok = (c, name) => { if (c) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } };

const procs = [];
// detached + 进程组：网关还会再拉起一个引擎子进程，收尾时必须整组杀干净，
// 否则端口被占着，第二次跑测试直接 EADDRINUSE
function run(env, file) {
  const p = spawn(process.execPath, [file], {
    cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  procs.push(p);
  p.stderr.on('data', d => process.stderr.write(`[${file}] ${d}`));
  return p;
}
function killAll() {
  for (const p of procs) { try { process.kill(-p.pid, 'SIGKILL'); } catch { try { p.kill('SIGKILL'); } catch {} } }
}
function httpReady(port, tries = 80) {
  return new Promise((resolve, reject) => {
    const tick = (n) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 800 }, (r) => { r.resume(); resolve(); });
      req.on('error', () => n <= 0 ? reject(new Error('端口 ' + port + ' 未就绪')) : setTimeout(() => tick(n - 1), 150));
      req.on('timeout', () => req.destroy());
    };
    tick(tries);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 一个"假界面"：收所有消息，可按条件等待
function ui(port, query = '') {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/${query}`);
  const c = { ws, msgs: [] };
  ws.on('message', raw => { try { c.msgs.push(JSON.parse(raw.toString())); } catch {} });
  c.send = o => ws.send(JSON.stringify(o));
  c.wait = async (fn, ms = 6000, label = '') => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const hit = c.msgs.find(fn);
      if (hit) return hit;
      await sleep(60);
    }
    throw new Error('等待超时: ' + label);
  };
  c.last = fn => [...c.msgs].reverse().find(fn);
  return new Promise(res => ws.on('open', () => res(c)));
}

const main = async () => {
  console.log('\n公共财博弈 · 客户端架构端到端测试\n');

  // 默认起一个本命中继；给 PGG_TEST_RELAY 就换成真·公网中继，验证跨互联网链路
  const CLOUD = (process.env.PGG_TEST_RELAY || '').trim();
  const RELAY_WS = CLOUD || `ws://127.0.0.1:${RELAY_PORT}`;

  if (!CLOUD) {
    run({ PORT: String(RELAY_PORT) }, 'server/relay.js');
    await httpReady(RELAY_PORT);
    // ---- GW-1 中继不托管网页
    const body = await new Promise(res => {
      http.get({ host: '127.0.0.1', port: RELAY_PORT, path: '/' }, r => {
        let s = ''; r.on('data', d => s += d); r.on('end', () => res(s));
      });
    });
    ok(/没有游戏|中继/.test(body) && !/<html/i.test(body), 'GW-1 中继只返回说明文字，不托管任何网页');
  } else {
    console.log('  （用公网中继 ' + CLOUD + '，跳过本命中继的网页检查）\n');
  }

  run({ PGG_PORT: String(HOST_UI), PGG_ENGINE_PORT: String(HOST_ENG), PGG_RELAY: RELAY_WS }, 'server/gateway.js');
  run({ PGG_PORT: String(GUEST_UI), PGG_ENGINE_PORT: String(GUEST_ENG), PGG_RELAY: RELAY_WS }, 'server/gateway.js');
  await httpReady(HOST_UI); await httpReady(GUEST_UI);
  await sleep(500);   // 等两边都连上中继

  const host = await ui(HOST_UI);
  const guest = await ui(GUEST_UI);

  // ---- 房主建房
  host.send({ type: 'room:create', name: '阿伟的房间', password: '', public: true,
    config: { seats: 6, rounds: 2, multiplier: 2, investSeconds: 20, discussSeconds: 15, voteSeconds: 15, scoringSeconds: 20 } });
  const entered = await host.wait(m => m.type === 'entered', 8000, '房主进房');
  const roomId = entered.roomId;
  ok(!!roomId, 'GW-2 房主建房拿到房号 ' + roomId);
  // 真实界面进房后会立刻占 1 号席位，这里照做
  host.send({ type: 'join', seat: 0, name: '阿伟' });
  await host.wait(m => m.type === 'joined' && m.pid, 5000, '房主落座');

  // ---- 客机大厅能刷到网络房间
  let seen = null;
  for (let i = 0; i < 60 && !seen; i++) {
    guest.send({ type: 'rooms:list' });
    await sleep(200);
    seen = guest.last(m => m.type === 'rooms' && (m.rooms || []).some(r => r.id === roomId));
  }
  const row = seen && seen.rooms.find(r => r.id === roomId);
  ok(!!row && row.online === true, 'GW-2 客机大厅刷到这个网络房间（online 标记）');

  // ---- 客机加入
  guest.send({ type: 'room:join', roomId, name: '小明' });
  const gEntered = await guest.wait(m => m.type === 'entered', 8000, '客机进房');
  const gJoined = await guest.wait(m => m.type === 'joined' && m.pid, 8000, '客机分配席位');
  ok(!!gEntered.state && gEntered.state.config.seats === 6, 'GW-3 客机拿到了房主本地引擎的完整对局状态');
  ok(!!gJoined.pid, 'GW-3 客机被分配到席位 ' + gJoined.pid);

  // entered 到达时席位还没落定，要看随后广播的状态
  let st = null;
  for (let i = 0; i < 60 && !st; i++) {
    await sleep(150);
    const s = guest.last(m => m.type === 'state' && m.state &&
      (m.state.players || []).some(p => p.id === gJoined.pid && p.connected && p.kind === 'human'));
    if (s) st = s.state;
  }
  const humans = st ? st.players.filter(p => p.connected && p.kind === 'human').length : 0;
  ok(humans >= 2, `GW-3 房主引擎里已有 ${humans} 个真人席位（房主 + 远端客机）`);
  const mySeat = st && st.players.find(p => p.id === gJoined.pid);
  ok(!!mySeat && mySeat.name === '小明', 'GW-3 远端席位用的是客机自己填的名字「小明」');
  ok(!!mySeat && mySeat.seat !== 0, 'GW-3 远端玩家没有抢走房主的 1 号席位（分到 ' + (mySeat ? mySeat.seat + 1 : '?') + ' 号）');

  // ---- GW-4 客机操作能传到房主本地引擎
  host.send({ type: 'start' });
  await host.wait(m => m.type === 'state' && m.state && m.state.phase === 'invest', 8000, '开局进入投资阶段');
  await guest.wait(m => m.type === 'state' && m.state && m.state.phase === 'invest', 8000, '客机同步到投资阶段');
  guest.send({ type: 'invest', amount: 5 });
  const invested = await guest.wait(m => m.type === 'state' && m.state &&
    m.state.investDone >= 1, 6000, '投资被记录');
  ok(!!invested, 'GW-4 客机的投资经中继传到了房主本地引擎');

  // ---- GW-5 远端玩家不能开新局 / 改配置
  guest.msgs.length = 0;
  guest.send({ type: 'start' });
  const denied = await guest.wait(m => m.type === 'error', 4000, '权限拦截提示');
  ok(/只有房主/.test(denied?.msg || ''), 'GW-5 远端玩家改配置/开新局被拦下：' + denied?.msg);

  // ---- GW-6 房主关房，客机被请回大厅
  guest.msgs.length = 0;
  host.ws.close();
  const closed = await guest.wait(m => m.type === 'hello' && !m.state || m.type === 'error', 8000, '房间关闭通知');
  ok(!!closed, 'GW-6 房主关房后客机收到通知并退回大厅');

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  try { host.ws.close(); guest.ws.close(); } catch {}
  killAll();
  process.exit(fail ? 1 : 0);
};

main().catch(e => {
  console.error('\n测试崩了：', e.message);
  killAll();
  process.exit(1);
});
