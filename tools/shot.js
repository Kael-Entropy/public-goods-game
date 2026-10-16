// 自动截图验证：起服务 → 用 WS 把对局推进到指定阶段 → 让 Electron 截一张图
// 用法：node tools/shot.js <phase> <out.png>
//   phase: lobby | invest | vote | settle | discuss | scoring | over | watch
//   watch = 十 AI 自动对局、窗口以观战位打开的画面
import WebSocket from 'ws';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const target = process.argv[2] || 'discuss';
const out = process.argv[3] || `/tmp/pgg-${target}.png`;
const PORT = 8792;   // 别和 test/smoke.js 的 8791 撞车，否则会连到别人的房间
const ROOT = path.resolve(new URL('..', import.meta.url).pathname);

// 起本地网关（跟真正游玩时一个路径）。PGG_RELAY=off：截图房不要登记到公网中继上
const srv = spawn(process.execPath, ['server/gateway.js'], {
  cwd: ROOT, env: { ...process.env, PGG_PORT: String(PORT), PGG_ENGINE_PORT: '8892', PGG_RELAY: 'off' },
  stdio: ['ignore', 'pipe', 'pipe'], detached: true,   // 成组启动，收尾时连引擎一起杀
});
srv.stderr.on('data', d => process.stderr.write('[server] ' + d));

const wait = ms => new Promise(r => setTimeout(r, ms));
const sleep = wait;

async function main() {
  // 等服务起来
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/`); if (r.ok) break; } catch {}
    await sleep(200);
  }

  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  let S = null, ROOM_ID = null;
  const done = new Promise(res => ws.on('close', res));
  ws.on('message', d => {
    const m = JSON.parse(d);
    if (m.type === 'hello' || m.type === 'state' || m.type === 'entered') { if (m.state) S = m.state; }
    if (m.type === 'room:created' || m.type === 'entered') ROOM_ID = m.roomId || ROOM_ID;
  });
  await new Promise(r => ws.on('open', r));
  const send = o => ws.send(JSON.stringify(o));
  // 大厅制：先建房才有对局状态
  send({ type: 'room:create', name: '截图房', config: { seats: 10, rounds: 6 } });
  for (let i = 0; i < 40 && !S; i++) await sleep(100);
  if (!ROOM_ID) throw new Error('建房失败');
  console.log('[shot] 房间', ROOM_ID);
  if (target === 'hall') {
    // 大厅截图：另开一个连接再建个密码房（带锁标记），然后本连接退回大厅看列表
    const ws2 = new WebSocket(`ws://127.0.0.1:${PORT}`);
    await new Promise(r => ws2.on('open', r));
    ws2.send(JSON.stringify({ type: 'room:create', name: '阿伟的房间', password: '1234', config: { seats: 10, rounds: 6 } }));
    await sleep(400);
    ws2.send(JSON.stringify({ type: 'join', seat: 0, name: '阿伟' }));
    await sleep(200);
    send({ type: 'room:leave' });
    await sleep(500);
  } else {
    // 坐 1 号（不是 0 号）：把 0 号留给截图窗口，否则页面端的席位会被驱动端挤掉
    send({ type: 'join', seat: 1, name: '测试员' });
    await sleep(300);
  }

  // 观战截图：十席全交给 AI，驱动端自己退到观战位，窗口也用 ?watch=1 打开
  const WATCH = target === 'watch';
  const stopAt = WATCH ? 'discuss' : target;
  if (WATCH) {
    send({ type: 'config', config: { ...S.config,
      players: S.players.map(p => ({ name: p.name, kind: 'local', api: {} })),
      investSeconds: 6, voteSeconds: 4, discussSeconds: 40, settleSeconds: 6 } });
    await sleep(300);
    send({ type: 'join', spectate: true, name: '观众' });
    await sleep(300);
  }
  if (target !== 'lobby') send({ type: 'start' });

  const deadline = Date.now() + (target === 'over' ? 240000 : 60000);
  let last = '', actedKey = '';
  while (Date.now() < deadline) {
    await sleep(250);
    if (!S) continue;
    if (S.phase !== last) { last = S.phase; console.log('  · 进入', S.phase, 'round', S.round); }
    if (S.phase === stopAt) break;
    const key = S.phase + ':' + S.round;
    if (WATCH) {                     // 观战位插不了手，只能等超时推进
      if (S.phase === 'settle') send({ type: 'skip' });
      continue;
    }
    if (key !== actedKey) {          // 每个阶段只提交一次，避免连点把节奏挤出问题
      actedKey = key;
      if (S.phase === 'invest') send({ type: 'invest', amount: 3 });
      else if (S.phase === 'vote') send({ type: 'vote', target: null });
      else if (S.phase === 'scoring') send({ type: 'rate', ratings: Object.fromEntries(S.players.map(p => [p.id, 3])) });
      else if (S.phase === 'settle' || S.phase === 'discuss') send({ type: 'skip' });
    }
  }
  console.log('[shot] 停在', S && S.phase, '轮次', S && S.round);

  // 保持王：截图期间别让它跳走（用一个 ./shotServer 无关的旁路：不断续命没法做，反正几秒内够）
  await sleep(400);

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.PGG_SHOT = out;
  env.PGG_SHOT_WAIT = process.env.SHOT_WAIT || '2600';
  env.PGG_PORT = String(PORT);
  env.PGG_QUERY = target === 'hall' ? '' : `?room=${ROOM_ID}${WATCH ? '&watch=1' : ''}`;
  const el = spawn(path.join(ROOT, 'node_modules/electron/dist/electron'), ['.', '--no-sandbox'], {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  el.stdout.on('data', d => process.stdout.write('[electron] ' + d));
  el.stderr.on('data', d => process.stderr.write('[electron:err] ' + d));
  await new Promise(r => el.on('exit', r));

  ws.close(); await done;
  try { process.kill(-srv.pid, 'SIGKILL'); } catch { try { srv.kill('SIGKILL'); } catch {} }
  console.log('[shot] 完成 →', out, fs.existsSync(out) ? `(${fs.statSync(out).size} 字节)` : '(没有生成)');
  process.exit(fs.existsSync(out) ? 0 : 1);
}
main().catch(e => { console.error(e); try { process.kill(-srv.pid, "SIGKILL"); } catch { srv.kill(); } process.exit(1); });
