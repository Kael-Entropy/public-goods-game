/*
 * 本地网关 —— "客户端游戏"架构的核心，跑在每个玩家自己的电脑上。
 *
 * 它干四件事：
 *   1. 拉起本地权威引擎（server/index.js）。规则、AI、阶段推进全在这台机器上算，
 *      而且只监听 127.0.0.1 —— 局域网里或互联网上，谁都别想用浏览器直接打开来玩。
 *   2. 给本地界面（Electron 独立窗口）提供 HTTP + WebSocket，端口 8787。
 *   3. 建房时把房间登记到云端中继：云端只留一个"房号 → 房主在哪"的目录条目。
 *   4. 别人加入时，在本地引擎里为它开一个真实席位，再把两边的消息原样对拷。
 *
 * 云端中继（relay.js）是纯邮局：不含任何规则、不托管任何网页。
 * 所以没有本地客户端 = 玩不了，这正是这套架构想要的结果。
 *
 * 环境变量：
 *   PGG_PORT        本地界面端口（默认 8787）
 *   PGG_ENGINE_PORT 本地引擎端口（默认 8899，只监听回环）
 *   PGG_RELAY       中继地址，例如 wss://xxx.app.workbuddy.host（留空=纯单机）
 *   PGG_BIND        界面监听地址（默认 127.0.0.1，不要改成 0.0.0.0）
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const UI_PORT     = Number(process.env.PGG_PORT || 8787);
const ENGINE_PORT = Number(process.env.PGG_ENGINE_PORT || 8899);
const BIND        = process.env.PGG_BIND || '127.0.0.1';
// 中继地址默认写死公网那个；PGG_RELAY=off 表示完全离线（只玩单机 / AI）
const DEFAULT_RELAY = 'wss://pgg-relay.app.workbuddy.host';
const relayEnv = (process.env.PGG_RELAY ?? '').trim();
const RELAY_URL = relayEnv === 'off' ? '' : (relayEnv || DEFAULT_RELAY);

const engineUrl = (q = '/') => `ws://127.0.0.1:${ENGINE_PORT}${q}`;

// ---------------------------------------------------------------- 本地权威引擎

let engine = null;
function startEngine() {
  engine = spawn(process.execPath, [path.join(__dirname, 'index.js')], {
    cwd: ROOT,
    // ELECTRON_RUN_AS_NODE：网关本身可能被 Electron 二进制拉起，子进程要显式回到纯 Node 模式
    env: { ...process.env, PORT: String(ENGINE_PORT), HOST: '127.0.0.1', ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  engine.stdout.on('data', () => {});
  engine.stderr.on('data', d => process.stderr.write('[engine] ' + d));
  engine.on('exit', (code) => {
    console.error(`[gateway] 本地引擎退出（${code}），网关一并退出`);
    process.exit(code || 1);
  });
}

function engineReady(timeoutMs = 15000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get({ host: '127.0.0.1', port: ENGINE_PORT, path: '/', timeout: 800 }, (res) => {
        res.resume(); resolve();
      });
      req.on('error', () => {
        if (Date.now() - t0 > timeoutMs) return reject(new Error('本地引擎启动超时'));
        setTimeout(tick, 150);
      });
      req.on('timeout', () => req.destroy());
    };
    tick();
  });
}

// ---------------------------------------------------------------- HTTP：只把静态资源从引擎透出去
// 注意只监听 127.0.0.1：外网就算知道端口也连不上，游戏文件必须在本地

const httpServer = http.createServer((req, res) => {
  const p = http.request({ host: '127.0.0.1', port: ENGINE_PORT, path: req.url, method: req.method, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode || 502, r.headers);
    r.pipe(res);
  });
  p.on('error', () => { res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('本地引擎未就绪'); });
  req.pipe(p);
});

const wss = new WebSocketServer({ server: httpServer });

// ---------------------------------------------------------------- 中继连接

let relay = null;
let relayLive = false;
let RELAY_ROOMS = [];
const sessions = new Set();                 // 所有本地界面连接
const hosted = new Map();                   // roomId -> { owner, password, name, seats, state, guests:Map }

const mergedRooms = () => {
  const localIds = new Set(LOCAL_ROOMS.map(r => r.id));
  const out = LOCAL_ROOMS.map(r => ({ ...r, online: false }));
  for (const r of RELAY_ROOMS) {
    if (localIds.has(r.id)) continue;       // 房号撞了以本机为准：本机的一定是自己的
    out.push({
      id: r.id, name: r.name, seats: r.seats || 10, humans: r.humans || 0,
      watchers: 0, phase: r.phase || 'lobby', round: r.round || 0,
      playing: !!r.playing, locked: !!r.locked, createdAt: r.createdAt, online: true,
    });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
};

let LOCAL_ROOMS = [];
function pushRooms(s) { sendUI(s, { type: 'rooms', rooms: mergedRooms() }); }
function pushRoomsAll() { for (const s of sessions) pushRooms(s); }

function connectRelay() {
  if (!RELAY_URL) return;
  let ws;
  try { ws = new WebSocket(RELAY_URL); } catch { return scheduleRelayRetry(); return; }
  relay = ws;
  ws.on('open', () => {
    relayLive = true;
    console.log('[gateway] 已连上联机中继:', RELAY_URL);
    // 断线期间建的房间补登记
    for (const [id, h] of hosted) registerRoom(id, h);
    for (const s of sessions) pushRooms(s);
  });
  ws.on('message', (raw) => onRelayMessage(raw.toString()));
  ws.on('close', () => {
    relayLive = false; relay = null; RELAY_ROOMS = [];
    console.log('[gateway] 与中继断开，5 秒后重连（单机仍可正常玩）');
    for (const s of sessions) pushRooms(s);
    scheduleRelayRetry();
  });
  ws.on('error', () => { try { ws.close(); } catch {} });
}
function scheduleRelayRetry() { setTimeout(connectRelay, 5000).unref?.(); }

function relaySend(obj) {
  if (!relay || relay.readyState !== WebSocket.OPEN) return false;
  try { relay.send(JSON.stringify(obj)); return true; } catch { return false; }
}

function onRelayMessage(raw) {
  let m; try { m = JSON.parse(raw); } catch { return; }
  switch (m.type) {
    case 'hello':
    case 'rooms':
      RELAY_ROOMS = m.rooms || [];
      // 界面开着 ?room=XXX 在等：房号出现在中继目录里就替它加入（可能要等目录同步到）
      for (const s of [...sessions]) {
        if (!s.wanted) continue;
        if (LOCAL_ROOMS.some(r => r.id === s.wanted)) { s.wanted = null; continue; }
        if (RELAY_ROOMS.some(r => r.id === s.wanted)) {
          const id = s.wanted; s.wanted = null;
          maybeJoinRemote(s, id, '');
        }
      }
      return pushRoomsAll();

    case 'net:hosted':
      return console.log('[gateway] 房间已登记到中继:', m.roomId);

    // 我作为客机加入成功：切到远端模式，之后所有消息都过中继
    case 'net:joined': {
      const s = [...sessions].find(x => x.pendingRemote && x.pendingRemote.roomId === m.roomId);
      if (!s) return;
      s.mode = 'remote'; s.connId = m.connId; s.roomId = m.roomId; s.pendingRemote = null;
      return;
    }

    // 有人加入我的房间：在本地引擎里给他开一个席位
    case 'net:guest':
      return addGuest(m.connId, String(m.name || '网友').slice(0, 12));

    // 转发来的消息：带 connId = 客机发给房主；不带 = 房主发给（我这边的）客机
    case 'net:from':
      return m.connId !== undefined ? guestSays(m.connId, m.msg) : hostSays(m.msg);

    case 'net:leave':
      return dropGuest(m.connId, '对方离开了房间');

    case 'net:closed':
      return onRemoteClosed(m);

    case 'error':
      for (const s of sessions) if (s.mode === 'remote' || s.pendingRemote) sendUI(s, m);
      return;

    default: return;
  }
}

// 客机侧：房主关房 / 被踢
function onRemoteClosed(m) {
  for (const s of [...sessions]) {
    if (s.mode !== 'remote' && !s.pendingRemote) continue;
    s.mode = 'local'; s.pendingRemote = null; s.connId = null; s.pid = null;
    sendUI(s, { type: 'error', msg: m.reason || '房间已关闭' });
    // 没有专门的"退房"消息，就用 hello 让界面回到大厅（hello 不带 state = 未进房）
    sendUI(s, { type: 'hello', rooms: mergedRooms(), you: { pid: null, spectate: false } });
  }
}

// ---------------------------------------------------------------- 本地界面连接

wss.on('connection', (ws, req) => {
  const s = {
    ws, mode: 'local', eng: null, roomId: null, pid: null, seat: null, seated: false,
    pending: null,          // 房主：待登记的建房参数
    pendingRemote: null,    // 客机：正在加入的网络房间
    connId: null,
    hostedId: null,
  };
  sessions.add(s);

  const eng = new WebSocket(engineUrl(req.url || '/'));
  s.eng = eng;

  eng.on('open', () => {
    const box = s.outbox || []; s.outbox = [];
    for (const raw of box) { try { eng.send(raw); } catch {} }
  });
  eng.on('message', (raw) => {
    const str = raw.toString();
    let m; try { m = JSON.parse(str); } catch { return sendUI(s, str); }

    if (m.type === 'hello' || m.type === 'rooms') {
      LOCAL_ROOMS = m.rooms || [];
      // 本机就有这个房：查询串原样透传了，引擎会自己放人进去，不用我们管
      if (s.wanted && LOCAL_ROOMS.some(r => r.id === s.wanted)) s.wanted = null;
      m.rooms = mergedRooms();
      m.relay = relayLive ? RELAY_URL : false;   // 让界面知道"网络联机"现在是通的还是断的
      return sendUI(s, JSON.stringify(m));
    }
    if (m.type === 'entered') {
      s.roomId = m.roomId; s.pid = m.you?.pid || null;
      // 房主建房成功（entered 早于 room:created 到达）：立刻把房间登记到中继，
      // 别人才能靠房号从互联网进来
      if (s.pending) {
        const h = makeHosted(s, m.roomId);
        h.state = m.state || null;
        registerRoom(m.roomId, h);
        s.pending = null;
      }
      return sendUI(s, str);
    }
    if (m.type === 'room:created') return sendUI(s, str);
    if (m.type === 'state' && s.hostedId && hosted.has(s.hostedId)) {
      const h = hosted.get(s.hostedId);
      h.state = m.state;
      if (relayLive) relaySend({ type: 'net:update', roomId: s.hostedId, ...summaryOf(h) });
    }
    if (m.type === 'joined') { s.pid = m.pid; s.seated = true; }
    return sendUI(s, str);
  });
  eng.on('close', () => { try { ws.close(); } catch {} });
  eng.on('error', () => {});

  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (s.mode === 'remote') return fromRemoteUI(s, m, raw.toString());
    return fromLocalUI(s, m, raw.toString());
  });

  ws.on('close', () => {
    sessions.delete(s);
    if (s.hostedId) closeHosted(s.hostedId);
    // 客机掉线也要通知房主，否则房主那边会留一个没人操作的死席位
    if (s.mode === 'remote' || s.pendingRemote) relaySend({ type: 'net:close' });
    try { eng.close(); } catch {}
  });
  ws.on('error', () => {});

  // 邀请直达：?room=XXXX。先记下房号，等引擎的房间列表到了再判断：
  // 本机有这个房 → 引擎自己会放人进去（查询串原样透传了）；本机没有但中继目录里有 → 走中继
  const q = String(req.url || '');
  const mm = /[?&]room=([A-Za-z0-9_-]+)/.exec(q);
  if (mm) s.wanted = mm[1].toUpperCase();
});

function sendUI(s, obj) {
  try { s.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); } catch {}
}

// 界面连进来时，通往引擎的那条连接可能还没握手完。这时 send 会抛错，
// 消息就悄悄丢了（最明显的症状是"建房没反应"）。先存着，握手完再补发。
function toEngine(s, raw) {
  if (s.eng && s.eng.readyState === WebSocket.OPEN) { try { s.eng.send(raw); } catch {} return; }
  (s.outbox = s.outbox || []).push(raw);
}

// ---------------------------------------------------------------- 本机模式（房主 / 单机）

function fromLocalUI(s, m, raw) {
  switch (m.type) {
    case 'room:create':
      s.pending = {
        name: String(m.name || '').slice(0, 20),
        password: String(m.password || '').slice(0, 32),
        seats: Number(m.config?.seats) || 10,
        public: m.public !== false,           // 默认开放到网络
      };
      break;

    case 'room:join': {
      // 先问本机引擎；本机没有就去网上找
      const id = String(m.roomId || '').toUpperCase();
      if (!LOCAL_ROOMS.some(r => r.id === id) && RELAY_ROOMS.some(r => r.id === id)) {
        return maybeJoinRemote(s, id, m.password || '', m.name);
      }
      break;
    }

    case 'room:leave':
      if (s.hostedId) closeHosted(s.hostedId);
      break;

    // 记住房主自己坐哪：远端客机分配席位时要避开它，不然会把房主挤下去
    case 'join':
      s.seat = m.spectate ? null : (Number(m.seat) || 0);
      break;
  }
  toEngine(s, raw);
}

function makeHosted(s, roomId) {
  const h = {
    owner: s, roomId, password: s.pending?.password || '',
    name: s.pending?.name || `房间 ${roomId}`, seats: s.pending?.seats || 10,
    state: null, guests: new Map(),
  };
  s.hostedId = roomId;
  hosted.set(roomId, h);
  return h;
}

function registerRoom(roomId, h) {
  if (!h) return;
  if (h.public === false) return;   // 房主没勾选"开放到网络"
  relaySend({ type: 'net:host', roomId, name: h.name, password: h.password, seats: h.seats, humans: 1 });
}

function summaryOf(h) {
  const st = h.state;
  const humans = st ? st.players.filter(p => p.connected).length : 1;
  const playing = !!st && st.phase !== 'lobby' && st.phase !== 'over';
  return {
    humans, playing,
    phase: st ? st.phase : 'lobby',
    round: st ? st.round : 0,
    seats: st ? st.config.seats : h.seats,
    name: h.name,
  };
}

function closeHosted(roomId) {
  const h = hosted.get(roomId);
  if (!h) return;
  hosted.delete(roomId);
  if (h.owner) h.owner.hostedId = null;
  for (const [, g] of h.guests) { try { g.eng.close(); } catch {} }
  h.guests.clear();
  relaySend({ type: 'net:close' });
  console.log('[gateway] 房间已从网络撤下:', roomId);
}

// ---------------------------------------------------------------- 房主：为远端客机开席位

// 席位分配必须自己记账，不能只看引擎广播的状态：
// 广播到达有先后，等我们收到时"房主已经坐下"这件事可能还没反映进来，
// 照着旧状态挑就会把客机塞进 1 号位，把房主顶掉
function pickSeat(h) {
  const seats = (h.state && h.state.config && h.state.config.seats) || h.seats;
  const used = new Set([...h.guests.values()].map(g => g.seat));
  if (h.owner && h.owner.seat != null) used.add(h.owner.seat);
  for (let i = 0; i < seats; i++) if (!used.has(i)) return i;
  return -1;                      // 满员了
}

function addGuest(connId, name, tries = 20) {
  // 目前一个网关同时只托管一个网络房间（房主一次开一间就够用了）
  const h = [...hosted.values()][0] || null;
  if (!h) { relaySend({ type: 'net:kick', connId }); return; }
  // 房主还没落座（或还没明确"我只观战"）就先等一下，最多 5 秒
  if (!h.owner.seated && tries > 0) { setTimeout(() => addGuest(connId, name, tries - 1), 250); return; }
  const seat = pickSeat(h);
  if (seat < 0) { relaySend({ type: 'net:kick', connId }); return; }

  const eng = new WebSocket(engineUrl('/'));
  const g = { connId, eng, name, seat, roomId: h.roomId, joined: false };
  h.guests.set(connId, g);

  eng.on('open', () => {
    engSend(eng, { type: 'room:join', roomId: h.roomId, password: h.password });
    engSend(eng, { type: 'join', seat, name });
  });
  eng.on('message', (raw) => {
    const str = raw.toString();
    let m; try { m = JSON.parse(str); } catch {}
    if (m && m.type === 'joined') g.joined = true;
    relaySend({ type: 'net:toguest', connId, msg: str });
  });
  eng.on('close', () => dropGuest(connId, null));
  eng.on('error', () => {});

  relaySend({ type: 'net:update', roomId: h.roomId, ...summaryOf(h) });
  console.log(`[gateway] 远端玩家「${name}」入座：房间 ${h.roomId} 席位 ${seat + 1}`);
}

function dropGuest(connId, reason) {
  for (const [, h] of hosted) {
    const g = h.guests.get(connId);
    if (!g) continue;
    h.guests.delete(connId);
    try { g.eng.close(); } catch {}
    relaySend({ type: 'net:update', roomId: h.roomId, ...summaryOf(h) });
    if (reason) console.log(`[gateway] ${reason}: ${connId}`);
  }
}

// 客机 -> 房主：原样喂给那个席位对应的引擎连接
function guestSays(connId, msg) {
  for (const [, h] of hosted) {
    const g = h.guests.get(connId);
    if (!g) continue;
    try { g.eng.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); } catch {}
    return;
  }
}

// ---------------------------------------------------------------- 客机模式

function maybeJoinRemote(s, roomId, password, name) {
  if (!relayLive) { sendUI(s, { type: 'error', msg: '还没连上联机中继，暂时只能玩本机的房间' }); return; }
  s.pendingRemote = { roomId };
  relaySend({ type: 'net:join', roomId, password: password || '', name: String(name || '').slice(0, 12) || '网友' });
}

// 房主 -> 客机：原样交给本地界面
function hostSays(msg) {
  for (const s of sessions) if (s.mode === 'remote') sendUI(s, typeof msg === 'string' ? msg : JSON.stringify(msg));
}

const BLOCKED_REMOTE = new Set(['start', 'config', 'reset', 'skip']);   // 房主的权限，远端玩家不能碰

function fromRemoteUI(s, m, raw) {
  // 加入成功：切到远端模式，之后所有消息都过中继
  if (m.type === 'room:join') return maybeJoinRemote(s, String(m.roomId || '').toUpperCase(), m.password || '', m.name);

  if (m.type === 'room:leave') {
    relaySend({ type: 'net:close' });
    s.mode = 'local'; s.pendingRemote = null; s.connId = null; s.pid = null;
    return sendUI(s, { type: 'hello', rooms: mergedRooms(), you: { pid: null, spectate: false } });
  }
  if (m.type === 'rooms:list') return pushRooms(s);

  // 席位已由房主分配好。界面上手滑发来的 join{seat:0} 不能转发，
  // 否则会把远端玩家挤到 1 号位去抢房主的席位
  if (m.type === 'join') {
    if (m.spectate) return relaySend({ type: 'net:tohost', msg: raw });
    if (s.pid) sendUI(s, { type: 'joined', pid: s.pid, spectate: false });
    return;
  }

  if (BLOCKED_REMOTE.has(m.type)) return sendUI(s, { type: 'error', msg: '只有房主能改配置或开新局' });
  if (m.type === 'ping') return sendUI(s, { type: 'pong' });

  // 还没接到房主的 entered 就发操作：先存着，接通后补发
  if (!s.pid && !['hello'].includes(m.type)) { s.queue = s.queue || []; s.queue.push(raw); }
  relaySend({ type: 'net:tohost', msg: raw });
}

function engSend(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }

// ---------------------------------------------------------------- 启动

startEngine();
try {
  await engineReady();
} catch (e) {
  console.error('[gateway] ' + e.message);
  process.exit(1);
}

httpServer.listen(UI_PORT, BIND, () => {
  console.log(`公共财博弈 · 本地网关已就绪: http://127.0.0.1:${UI_PORT}`);
  console.log(`  本地权威引擎: 127.0.0.1:${ENGINE_PORT}（只监听回环，外网与局域网浏览器都进不来）`);
  console.log(RELAY_URL
    ? `  联机中继: ${RELAY_URL}（只转发消息，不含任何游戏规则）`
    : '  未配置中继（PGG_RELAY）：单机 / AI 对局可用，网络联机关闭');
  connectRelay();
});

// 收到终止信号必须把引擎一起带走：node 收 SIGTERM 默认不跑 exit 钩子，
// 只 kill 网关会留下一个占着 8899 的孤儿引擎，下次启动直接 EADDRINUSE
function shutdown() {
  try { engine?.kill('SIGKILL'); } catch {}
  process.exit(0);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, shutdown);
process.on('exit', () => { try { engine?.kill('SIGKILL'); } catch {} });
