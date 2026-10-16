// 联机端到端：真起一个服务端，用真实 WebSocket 验证房间大厅、密码房、多房间隔离与十 AI 自动对局
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const PORT = 8899;
const BASE = `ws://127.0.0.1:${PORT}`;
let fail = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fail++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 一个极简客户端：收全量消息，按需查询
function client(query = '') {
  const ws = new WebSocket(`${BASE}/${query}`);
  const msgs = [];
  const c = {
    ws, msgs, you: null, roomId: null,
    type(t) { return msgs.filter(m => m.type === t); },
    last(t) { const a = c.type(t); return a[a.length - 1] || null; },
    state() { const s = c.last('state'); return s ? s.state : null; },
    err() { return c.last('error'); },
    send(o) { ws.send(JSON.stringify(o)); },
    async waitFor(t, ms = 8000) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (c.last(t)) return c.last(t);
        await sleep(50);
      }
      return null;
    },
    async waitState(fn, ms = 60000) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const s = c.state();
        if (s && fn(s)) return s;
        await sleep(50);
      }
      return null;
    },
    close() { try { ws.close(); } catch {} },
  };
  ws.on('message', d => {
    const m = JSON.parse(d);
    msgs.push(m);
    if (m.you) c.you = m.you;
    if (m.roomId && (m.type === 'entered' || m.type === 'room:created')) c.roomId = m.roomId;
  });
  c.ready = new Promise(r => { ws.on('open', r); ws.on('error', r); });
  return c;
}

// 建房并等待服务端下发房号
async function mkRoom(c, opts = {}) {
  c.send({ type: 'room:create', name: opts.name || '测试房', password: opts.password || '', config: opts.config || {} });
  const m = await c.waitFor('room:created', 8000);
  return m ? m.roomId : null;
}

const srv = spawn(process.execPath, ['server/index.js'], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvLog = '';
srv.stdout.on('data', d => { srvLog += d; });
srv.stderr.on('data', d => { srvLog += d; });
for (let i = 0; i < 100; i++) { await sleep(100); if (srvLog.includes('服务已启动')) break; }

console.log('\n[NET-1] 服务端启动');
{
  ok(srvLog.includes('服务已启动'), '服务端启动成功');
  ok(srvLog.includes('房间大厅'), '启动日志说明了先进房间大厅');
  ok(/http:\/\/(?!127\.0\.0\.1)\d+\.\d+\.\d+\.\d+:\d+\//.test(srvLog), '打印了局域网入口');
}

console.log('\n[NET-2] 房间大厅：建房 / 列表 / 加入');
let openId = '', lockedId = '';
{
  const a = client();
  await a.ready; await a.waitFor('hello', 3000);
  ok(a.last('hello') && a.last('hello').roomId === null, '不带房号打开 → 停在大厅（没有对局状态）');
  ok(Array.isArray(a.last('hello').rooms), 'hello 里带着房间列表');
  ok(a.last('hello').state === undefined, '大厅里不下发任何对局状态');

  openId = await mkRoom(a, { name: '开放的房', config: { seats: 10 } });
  ok(!!openId, `建好一个房间（房号 ${openId}）`);
  ok(/^[A-Z0-9]{4}$/.test(openId || ''), '房号是 4 位易读大写（避开了 0/O/1/I）');
  ok(!!a.last('entered') && a.last('entered').roomId === openId, '建房者自动进入房间');
  ok(a.state() && a.state().phase === 'lobby', '进房后拿到该房间的状态');

  const b = client();
  await b.ready; await b.waitFor('hello', 3000);
  const list = b.last('hello').rooms;
  ok(list.some(r => r.id === openId), '另一个人打开游戏就能在列表里看到这个房间');
  const r0 = list.find(r => r.id === openId);
  ok(r0 && r0.name === '开放的房', '列表里带房间名');
  ok(r0 && r0.locked === false, '没设密码的房间标记为不锁');
  ok(r0 && r0.password === undefined, '列表里绝不外泄密码');

  b.send({ type: 'room:join', roomId: openId });
  await sleep(300);
  ok(!!b.last('entered') && b.last('entered').roomId === openId, '点一下就加入了房间');
  ok(b.state() && b.state().phase === 'lobby', '加入后拿到同一份房间状态');
  a.close(); b.close();
}

console.log('\n[NET-3] 密码房');
{
  const a = client();
  await a.ready; await a.waitFor('hello', 3000);
  lockedId = await mkRoom(a, { name: '要密码的房', password: 'abc123' });
  ok(!!lockedId, '建成一个带密码的房间');

  const b = client();
  await b.ready; await b.waitFor('hello', 3000);
  const r0 = b.last('hello').rooms.find(r => r.id === lockedId);
  ok(r0 && r0.locked === true, '列表里标出这个房间需要密码');

  b.send({ type: 'room:join', roomId: lockedId });
  await sleep(300);
  ok(b.last('entered') === null || b.last('entered').roomId !== lockedId, '不输密码进不去');
  ok(b.err() && b.err().needPassword === true, '服务端回了"需要密码"而不是放行');

  b.send({ type: 'room:join', roomId: lockedId, password: 'wrong' });
  await sleep(300);
  ok(!b.last('entered') || b.last('entered').roomId !== lockedId, '密码不对仍然进不去');

  b.send({ type: 'room:join', roomId: lockedId, password: 'abc123' });
  await sleep(300);
  ok(!!b.last('entered') && b.last('entered').roomId === lockedId, '密码对了才进得去');
  a.close(); b.close();
}

console.log('\n[NET-4] 邀请链接直达 / 房间已解散');
{
  const a = client();
  await a.ready; await a.waitFor('hello', 3000);
  const id = await mkRoom(a, { name: '直达测试' });
  a.close();

  const c = client(`?room=${id}`);
  await c.ready;
  await sleep(400);
  ok(!!c.last('entered') && c.last('entered').roomId === id, '带 ?room= 的邀请链接直接进房，不用先过大厅');

  const d = client('?room=ZZZZ');       // 不存在的房号
  await d.ready; await d.waitFor('hello', 3000);
  await sleep(300);
  ok(!d.last('entered'), '房号不存在时不会凭空建一个房');
  ok(d.err() && /不存在|解散/.test(d.err().msg), `提示房间不存在（"${d.err() && d.err().msg}"）`);
  c.close(); d.close();
}

console.log('\n[NET-5] 多房间互不干扰');
{
  const a = client(), b = client();
  await Promise.all([a.ready, b.ready]);
  await Promise.all([a.waitFor('hello', 3000), b.waitFor('hello', 3000)]);
  const idA = await mkRoom(a, { name: 'A房' });
  const idB = await mkRoom(b, { name: 'B房' });
  ok(idA && idB && idA !== idB, `两个房间房号不同（${idA} / ${idB}）`);

  a.send({ type: 'config', config: { rounds: 3 } });
  await sleep(400);
  ok(a.state()?.config.rounds === 3, 'A 房改成了 3 轮');
  ok(b.state()?.config.rounds !== 3, 'B 房的配置没被隔壁改动影响');

  a.send({ type: 'join', seat: 0, name: '房主A' });
  b.send({ type: 'join', seat: 0, name: '房主B' });
  await sleep(300);
  ok(a.last('joined')?.pid === 'p1' && b.last('joined')?.pid === 'p1', '两房各坐各的 1 号席位，互不冲突');
  a.close(); b.close();
}

console.log('\n[NET-6] 观战位：十 AI 自动跑完整局');
{
  const host = client();
  await host.ready; await host.waitFor('hello', 3000);
  await mkRoom(host, { name: 'AI 自博', config: { seats: 10, rounds: 3 } });
  host.send({ type: 'join', seat: 0, name: '房主' });
  await sleep(200);

  // 房主把十席全交给 AI（含自己刚坐的 1 号席位），自己退到观战位
  const st = host.state();
  host.send({ type: 'config', config: { ...st.config, players: st.players.map(p => ({ name: p.name, kind: 'local', api: {} })),
    investSeconds: 6, voteSeconds: 4, discussSeconds: 8, settleSeconds: 1, scoringSeconds: 1 } });
  await sleep(300);
  host.send({ type: 'join', spectate: true, name: '观众' });
  await sleep(400);

  ok(host.last('joined')?.spectate === true, '服务端确认进入观战位');
  const s2 = host.state();
  ok(s2.players.every(p => p.kind === 'local'), '十个席位全交给 AI（无一席留给人）');
  ok(s2.players.every(p => !p.connected), '没有席位在等真人操作');
  ok(host.you && host.you.spectate === true && host.you.pid === null, '广播里标明我是观战者、不占席位');

  host.send({ type: 'start' });
  const fin = await host.waitState(s => s.phase === 'over', 90000);
  ok(!!fin, '无人操作也自动跑到了终局（不会卡住等人类）');
  ok(fin && fin.history.length >= 3, `完成了 ${fin?.history.length} 轮结算`);

  const spyMsgs = host.msgs.filter(m => m.type === 'call:msg' && m.spectate === true);
  ok(spyMsgs.length > 0, `观战者收到了 ${spyMsgs.length} 条 AI 密谈（上帝视角）`);

  const withRes = await host.waitState(s => s.result && s.result.ranked, 10000);
  ok(!!withRes && withRes.result.ranked.length === 10, '终局战报正常生成（十人排名）');
  host.close();
}

srv.kill('SIGKILL');
await sleep(300);
console.log(fail === 0 ? '\n联机与房间大厅全部通过\n' : `\n${fail} 项未通过\n`);
process.exit(fail === 0 ? 0 : 1);
