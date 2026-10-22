// 服务端：静态托管 + WebSocket 房间 + 阶段状态机 + AI 席位调度
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 本机在局域网里的 IPv4 地址，用于生成邀请链接
function lanIPs() {
  const out = [];
  try {
    for (const list of Object.values(os.networkInterfaces()))
      for (const i of list || [])
        if ((i.family === 'IPv4' || i.family === 4) && !i.internal) out.push(i.address);
  } catch {}
  return out;
}
import { WebSocketServer } from 'ws';

import * as E from './engine.js';
import { decideInvest, decideVote, decideRating, decideTalk, decideAcceptCall, decideGift } from './ai.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT || 8787);

const rooms = new Map();      // roomId -> { state, timer, clients:Set<ws>, aiTimers:[], name, password, ... }
const lobby = new Set();      // 还没进任何房间的连接（房间大厅）
const ROOM_IDLE_MS = 30 * 60 * 1000;        // 空房间 30 分钟无人则回收
const ROOM_PLAYING_MS = 6 * 60 * 60 * 1000; // 对局进行中的房间留 6 小时

// ------------------------------------------------------------ 静态资源

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
               '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
               '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.join(PUBLIC, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

const wss = new WebSocketServer({ server });

// ------------------------------------------------------------ 房间

// 房号：4 位大写，剔除 0/O/1/I 这类念出来会混淆的字符
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newRoomId() {
  let s = '';
  for (let i = 0; i < 4; i++) s += ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)];
  return rooms.has(s) ? newRoomId() : s;
}

function newRoom(cfg = {}, id, meta = {}) {
  id = String(id || newRoomId()).toUpperCase().slice(0, 16);
  const state = E.createRoom(cfg);
  const room = {
    id, state, timer: null, clients: new Set(), aiTimers: [],
    name: String(meta.name || '').replace(/\s+/g, ' ').trim().slice(0, 20) || `房间 ${id}`,
    password: meta.password ? String(meta.password).slice(0, 32) : '',
    host: String(meta.host || '').slice(0, 16),
    createdAt: Date.now(),
    lastSeen: Date.now(),
  };
  rooms.set(id, room);
  broadcast(room);
  return room;
}

// 房间大厅用的摘要：绝不能把密码带出去
function roomSummary(room) {
  const st = room.state;
  const humans = st.players.filter(p => p.connected).length;
  const playing = st.phase !== 'lobby' && st.phase !== 'over';
  return {
    id: room.id,
    name: room.name,
    host: room.host,
    seats: st.config.seats,
    rounds: st.config.rounds,
    humans,
    watchers: [...room.clients].filter(c => c._spectate).length,
    clients: room.clients.size,
    phase: st.phase,
    round: st.round,
    playing,
    locked: !!room.password,
    createdAt: room.createdAt,
  };
}
const listRooms = () => [...rooms.values()].sort((a, b) => b.createdAt - a.createdAt).map(roomSummary);

function broadcastLobby() {
  const list = listRooms();
  for (const ws of lobby) send(ws, { type: 'rooms', rooms: list });
}

// 邀请链接里的房号（?room=xxx）。只取号，不建房间：房间没了要如实告诉用户
function roomIdFromUrl(req) {
  try {
    const u = new URL(req.url || '/', 'http://x');
    return String(u.searchParams.get('room') || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 16).toUpperCase();
  } catch { return ''; }
}

// 进出房间。带密码的房间必须口令正确才让进
function enterRoom(ws, room, password) {
  if (room.password && String(password || '') !== room.password) return false;
  if (ws._room) leaveRoom(ws);
  lobby.delete(ws);
  ws._room = room;
  room.clients.add(ws);
  room.lastSeen = Date.now();
  send(ws, { type: 'entered', roomId: room.id, name: room.name, locked: !!room.password,
             state: E.publicState(room.state), you: youOf(ws) });
  broadcast(room);
  broadcastLobby();
  return true;
}

function leaveRoom(ws) {
  const room = ws._room; if (!room) return;
  room.clients.delete(ws);
  if (ws._pid) { const p = E.getPlayer(room.state, ws._pid); if (p) p.connected = false; }
  ws._pid = null; ws._spectate = false; ws._room = null;
  broadcast(room);
  broadcastLobby();
}

// 空房间回收：没人连着就开始计时，免得房间列表越堆越长
const reaper = setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [id, room] of [...rooms]) {
    if (room.clients.size > 0) { room.lastSeen = now; continue; }
    const playing = room.state.phase !== 'lobby' && room.state.phase !== 'over';
    if (now - room.lastSeen > (playing ? ROOM_PLAYING_MS : ROOM_IDLE_MS)) {
      clearTimers(room); rooms.delete(id); changed = true;
    }
  }
  if (changed) broadcastLobby();
}, 60000);
if (reaper.unref) reaper.unref();

function clearTimers(room) {
  room.finishing = false;
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
  room.aiTimers.forEach(t => clearTimeout(t));
  room.aiTimers = [];
}
function later(room, fn, ms) {
  const t = setTimeout(fn, ms);
  room.aiTimers.push(t);
  return t;
}

function send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }
// 每个连接"我是谁"：坐席位的玩家 / 纯观战者
function youOf(ws) { return { pid: ws._pid || null, spectate: !!ws._spectate }; }

// 交还席位：观战或换席位时调用。席位转交本地 AI，没人坐也不会卡住流程
function leaveSeat(room, ws) {
  if (!ws._pid) return;
  const p = E.getPlayer(room.state, ws._pid);
  if (p) { p.connected = false; p.kind = 'local'; }
  ws._pid = null;
}

function broadcast(room, extra = {}) {
  const base = E.publicState(room.state);
  // 赠与关系是双边私事：每人只拿到自己那一份，用于评分界面提示"这份好意会打折"
  for (const ws of room.clients) {
    try {
      let state = base;
      if (ws._pid) {
        state = { ...base, myRecv: E.receivedBy(room.state, ws._pid), mySent: E.sentBy(room.state, ws._pid) };
      }
      ws.send(JSON.stringify({ type: 'state', state, you: youOf(ws), ...extra }));
    } catch {}
  }
}
function sendTo(room, pid, obj) {
  for (const ws of room.clients) if (ws._pid === pid) send(ws, obj);
}

// ------------------------------------------------------------ 阶段推进

function setPhase(room, phase, onTimeout) {
  const st = room.state;
  room.finishing = false;
  st.phase = phase;
  const dur = E.phaseDuration(st, phase);
  st.phaseEndsAt = Date.now() + dur;
  broadcast(room);
  if (room.timer) clearTimeout(room.timer);
  if (dur > 0) room.timer = setTimeout(() => onTimeout(room), dur);
}

function startGame(room) {
  clearTimers(room);
  const st = room.state;
  // 联机时有人占了席位又掉线：开局把这些没人操作的席位交还给 AI。
  // 否则它们每轮只投 0 枚、不投票、不打分，等于桌上白放一个纯搭便车的死席位
  const freed = st.players.filter(p => p.kind === 'human' && !p.connected);
  for (const p of freed) p.kind = 'local';
  st.history = []; st.log = []; st.result = null; st.ratings = {}; st.invest = {}; st.votes = {}; st.gifts = {}; st.round = 0;
  for (const p of st.players) p.coins = st.config.initialCoins;
  E.pushLog(st, '游戏开始');
  if (freed.length) E.pushLog(st, `${freed.length} 个无人席位已交给 AI 接管`);
  nextInvest(room);
}

function nextInvest(room) {
  E.beginInvest(room.state);
  setPhase(room, 'invest', onInvestTimeout);
  driveAI(room, 'invest');
}

function onInvestTimeout(room) {
  const st = room.state;
  fillMissing(room, 'invest');
  if (st.round === 1) return doSettle(room);      // 第 1 轮无投票
  E.beginVote(st);
  setPhase(room, 'vote', onVoteTimeout);
  driveAI(room, 'vote');
}

function onVoteTimeout(room) {
  fillMissing(room, 'vote');
  doSettle(room);
}

function doSettle(room) {
  const st = room.state;
  E.settleRound(st);
  st.phase = 'settle';
  st.phaseEndsAt = Date.now() + E.phaseDuration(st, 'settle');   // 早期版本漏了这行，倒计时环会一直显示投资阶段的剩余时间
  broadcast(room, { settle: E.publicSummary(st.history[st.history.length - 1]) });
  if (room.timer) clearTimeout(room.timer);
  room.timer = setTimeout(() => {
    E.beginDiscuss(st);
    setPhase(room, 'discuss', onDiscussTimeout);
    driveAI(room, 'discuss');
  }, E.phaseDuration(st, 'settle'));
}

function onDiscussTimeout(room) {
  const st = room.state;
  clearTimers(room);
  if (st.round >= st.config.rounds) {
    E.beginScoring(st);
    setPhase(room, 'scoring', onScoringTimeout);
    driveAI(room, 'scoring');
  } else {
    nextInvest(room);
  }
}

function onScoringTimeout(room) {
  fillMissing(room, 'rating');
  const res = E.finalize(room.state);
  clearTimers(room);
  broadcast(room, { result: res });
}

// 超时未提交：AI 用本地策略兜底，真人按 0 处理
function fillMissing(room, what) {
  const st = room.state;
  for (const p of st.players) {
    if (what === 'invest') {
      if (st.invest[st.round][p.id] === undefined) {
        // 必须走 submitInvestment，否则会绕过"每轮投入上限"导致财富指数爆炸
        const v = p.kind === 'human' ? 0 : localInvestSync(st, p);
        const r = E.submitInvestment(st, p.id, v);
        if (!r.ok) st.invest[st.round][p.id] = Math.min(v, E.investCap(st, p));
      }
    } else if (what === 'vote') {
      if (st.votes[st.round][p.id] === undefined) st.votes[st.round][p.id] = p.kind === 'human' ? null : null;
    } else if (what === 'rating') {
      if (!st.ratings[p.id]) st.ratings[p.id] = defaultRatings(st, p);
    }
  }
}
function localInvestSync(st, p) {
  // 直接用 ai.js 的同步本地策略（不发起网络请求）
  const { localInvest } = aiLocal;
  return localInvest(st, p);
}
function defaultRatings(st, p) {
  const out = {};
  if (p.kind === 'human') { for (const q of st.players) out[q.id] = st.config.defaultRating; return out; }
  return aiLocal.localRating(st, p);
}

// ------------------------------------------------------------ AI 调度

import * as aiLocal from './ai.js';

function aiSeats(st) { return st.players.filter(p => p.kind === 'api' || p.kind === 'local'); }

function driveAI(room, phase) {
  const st = room.state;
  const seats = aiSeats(st);
  if (phase === 'invest') {
    seats.forEach((p, i) => later(room, async () => {
      if (st.phase !== 'invest') return;
      const d = await decideInvest(st, p);
      E.submitInvestment(st, p.id, d.amount);
      broadcast(room);
      if (E.investmentsComplete(st)) finishEarly(room, onInvestTimeout);
    }, 800 + i * 500 + Math.random() * 4000));
  }

  if (phase === 'vote') {
    seats.forEach((p, i) => later(room, async () => {
      if (st.phase !== 'vote') return;
      const d = await decideVote(st, p);
      E.submitVote(st, p.id, d.target);
      broadcast(room);
      if (E.votesComplete(st)) finishEarly(room, onVoteTimeout);
    }, 600 + i * 400 + Math.random() * 6000));
  }

  if (phase === 'scoring') {
    seats.forEach((p, i) => later(room, async () => {
      if (st.phase !== 'scoring') return;
      const d = await decideRating(st, p);
      E.submitRating(st, p.id, d.ratings);
      broadcast(room);
      if (E.ratingsComplete(st)) finishEarly(room, onScoringTimeout);
    }, 600 + i * 400 + Math.random() * 3000));
  }

  if (phase === 'discuss') driveDiscuss(room);
}

// 讨论期：AI 主动发起私密频道 -> 对方决定是否加入 -> 频道内发言
function driveDiscuss(room) {
  const st = room.state;
  const seats = aiSeats(st);
  seats.forEach((p, i) => {
    later(room, async () => {
      if (st.phase !== 'discuss') return;
      if (E.findCallOf(st, p.id)) return;
      const others = st.players.filter(x => x.id !== p.id).map(x => x.id);
      const n = 1 + Math.floor(Math.random() * 2);          // 邀请 1~2 人
      const invites = others.sort(() => Math.random() - 0.5).slice(0, n);
      const r = E.createCall(st, p.id, invites);
      if (!r.ok) return;
      broadcast(room);
      for (const id of invites) scheduleRespond(room, r.call.id, id);
      talkInCall(room, r.call.id, p.id);
    }, 800 + i * 700 + Math.random() * 2500);

    // 赠与：讨论中段随机时机，动机由人格决定（慈善 / 行贿 / 互惠 / 铁公鸡）
    later(room, async () => {
      if (st.phase !== 'discuss') return;
      const g = await decideGift(st, p);
      if (!g) return;
      const r = E.submitGift(st, p.id, g.to, g.amount);
      if (!r.ok) return;
      broadcast(room);
      sendTo(room, g.to, { type: 'gift:recv', from: p.id, fromName: E.nameOf(st, p.id), amount: r.amount });
    }, 600 + i * 250 + Math.random() * 2000);   // 尽早发生：短讨论局也能触发，且给对方留出反应时间
  });
}

function scheduleRespond(room, callId, pid) {
  const st = room.state;
  const p = E.getPlayer(st, pid);
  if (!p) return;
  later(room, () => {
    if (st.phase !== 'discuss') return;
    const accept = p.kind === 'human' ? false : decideAcceptCall(st, p);   // 真人自己点
    const r = E.respondCall(st, callId, pid, accept);
    if (r.ok) { broadcast(room); if (r.accepted) talkInCall(room, callId, pid); }
  }, 700 + Math.random() * 3500);
}

function talkInCall(room, callId, pid) {
  const st = room.state;
  const p = E.getPlayer(st, pid);
  if (!p) return;
  const times = 1 + Math.floor(Math.random() * 2);
  for (let k = 0; k < times; k++) {
    later(room, async () => {
      if (st.phase !== 'discuss') return;
      if (!E.canTalk(st, callId, pid)) return;
      const call = st.calls.find(c => c.id === callId);
      const peers = call.members.filter(m => m !== pid).map(m => E.nameOf(st, m));
      const d = await decideTalk(st, p, { peers });
      deliverCallMessage(room, callId, pid, d.say);
    }, 2500 + k * 6000 + Math.random() * 4000);
  }
}

// 全员到齐就提前结束阶段。注意必须加同向闸门：
// 早期版本每次收到提交都会 clearTimeout + 重排 400ms，客户端若反复提交（或误触连点），
// 这个 400ms 永远走不完，阶段会被永久卡住 —— 实测会把房间钉死在 invest。
function finishEarly(room, fn) {
  if (room.finishing) return;
  room.finishing = true;
  if (room.timer) clearTimeout(room.timer);
  room.timer = setTimeout(() => { room.finishing = false; fn(room); }, 400);
}

// ------------------------------------------------------------ 消息协议

// 建房配置来自客户端，必须逐项钳制：不然一个越界的 seats/rounds 就能把服务端拖垮
function sanitizeCfg(c = {}) {
  const out = {};
  // 只钳制客户端真正传了的字段：没传的留给引擎自己的默认值，
  // 否则这里塞的默认值（比如获胜名额 5）会悄悄盖掉引擎的默认（4）
  const put = (k, lo, hi) => {
    const v = Number(c[k]);
    if (Number.isFinite(v)) out[k] = Math.min(hi, Math.max(lo, v));
  };
  put('seats', 2, 12);
  put('rounds', 1, 12);
  put('multiplier', 1, 50);
  put('maxInvestPerRound', 0, 999);
  put('voteThreshold', 2, 12);
  put('topWinners', 1, 12);
  put('targetAvgCoins', 0, 999);   // 团队达标线：0 = 不设门槛
  put('investSeconds', 5, 300);
  put('voteSeconds', 5, 300);
  put('discussSeconds', 5, 600);
  put('settleSeconds', 1, 30);
  put('scoringSeconds', 5, 300);
  if (['full', 'total', 'secret'].includes(String(c.giftVisibility))) out.giftVisibility = String(c.giftVisibility);
  const pen = Number(c.giftRatingPenalty);
  if (Number.isFinite(pen) && pen > 0 && pen <= 1) out.giftRatingPenalty = pen;
  return out;
}

wss.on('connection', (ws, req) => {
  ws._spy = /[?&]spy=1/.test(req.url || '');   // ?spy=1 = 调试端，会额外收到 AI 密谈监听流
  ws._spectate = false; ws._pid = null; ws._room = null;
  lobby.add(ws);
  // lan 带出去，建房页才能生成"发给朋友"的邀请链接
  send(ws, { type: 'hello', roomId: null, rooms: listRooms(), you: youOf(ws), lan: lanIPs() });

  // ?room=xxx 邀请链接直达。三种结果：直接进 / 要密码 / 房间已经散了
  const wantedId = roomIdFromUrl(req);
  if (wantedId) {
    const room = rooms.get(wantedId);
    if (!room) send(ws, { type: 'error', msg: '这个房间已经解散了', gone: true, roomId: wantedId });
    else if (!enterRoom(ws, room, '')) {
      send(ws, { type: 'error', msg: '这个房间设了密码', needPassword: true, roomId: room.id, name: room.name });
    }
  }

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    handle(ws, msg);
  });
  ws.on('close', () => {
    lobby.delete(ws);
    leaveRoom(ws);
  });
});

function handle(ws, msg) {
  if (!ws._room) return handleLobby(ws, msg);
  return handleRoom(ws, ws._room, msg);
}

// 大厅：列房间 / 建房 / 进房。此时没有任何对局状态
function handleLobby(ws, msg) {
  switch (msg.type) {
    case 'rooms:list':
      return send(ws, { type: 'rooms', rooms: listRooms() });

    case 'room:create': {
      const room = newRoom(sanitizeCfg(msg.config), null,
        { name: msg.name, password: msg.password, host: msg.host });
      broadcastLobby();
      enterRoom(ws, room, msg.password || '');       // 建房者自己必然进得去
      send(ws, { type: 'room:created', roomId: room.id });
      return;
    }

    case 'room:join': {
      const id = String(msg.roomId || '').toUpperCase().slice(0, 16);
      const room = rooms.get(id);
      if (!room) return send(ws, { type: 'error', msg: '房间不存在或已解散' });
      if (room.password && String(msg.password || '') !== room.password) {
        return send(ws, { type: 'error', msg: '密码不对', needPassword: true, roomId: room.id, name: room.name });
      }
      enterRoom(ws, room, msg.password || '');
      return;
    }

    default:
      return send(ws, { type: 'error', msg: '你还没进入房间' });
  }
}

function handleRoom(ws, room, msg) {
  const st = room.state;
  const pid = ws._pid;
  const need = () => { if (!pid) { send(ws, { type: 'error', msg: '请先选席位' }); return false; } return true; };

  switch (msg.type) {
    // 退回大厅：交还席位，房间仍在
    case 'room:leave': {
      leaveRoom(ws);
      lobby.add(ws);
      send(ws, { type: 'hello', roomId: null, rooms: listRooms(), you: youOf(ws), lan: lanIPs() });
      return;
    }
    case 'join': {
      // 观战位：不占席位、不参与博弈，只接收公开信息 + AI 密谈（上帝视角）
      if (msg.spectate) {
        leaveSeat(room, ws);
        ws._spectate = true; ws._spy = true;
        send(ws, { type: 'joined', pid: null, spectate: true });
        broadcast(room);
        return;
      }
      const p = st.players[Number(msg.seat) || 0];
      if (!p) return send(ws, { type: 'error', msg: '席位不存在' });
      if (p.connected && p.kind === 'human' && ws._pid !== p.id) return send(ws, { type: 'error', msg: '该席位已被占用' });
      leaveSeat(room, ws);                       // 换席位时把上一个席位交还给 AI
      ws._spectate = false;
      ws._pid = p.id; p.kind = 'human'; p.connected = true; p.name = msg.name || p.name;
      // 先回 joined 再广播：前端必须先绑定 me，才能正确渲染"你持有 X 枚"等个人视图
      send(ws, { type: 'joined', pid: p.id, spectate: false });
      broadcast(room);
      return;
    }

    case 'config': {
      if (st.phase !== 'lobby' && st.phase !== 'over') return send(ws, { type: 'error', msg: '游戏进行中不可改配置' });
      const c = msg.config || {};
      for (const k of ['seats', 'rounds', 'multiplier', 'maxInvestPerRound', 'investSeconds', 'voteSeconds', 'discussSeconds', 'scoringSeconds', 'settleSeconds', 'voteThreshold', 'topWinners', 'targetAvgCoins']) {
        if (c[k] !== undefined) st.config[k] = Number(c[k]);
      }
      if (c.giftVisibility !== undefined && ['full', 'total', 'secret'].includes(String(c.giftVisibility))) {
        st.config.giftVisibility = String(c.giftVisibility);
      }
      if (c.giftRatingPenalty !== undefined) {
        const k = Number(c.giftRatingPenalty);
        if (Number.isFinite(k) && k > 0 && k <= 1) st.config.giftRatingPenalty = k;
      }
      if (Array.isArray(c.players)) {
        c.players.forEach((pc, i) => {
          const p = st.players[i]; if (!p) return;
          if (pc.kind) p.kind = pc.kind;
          if (pc.name) p.name = pc.name;
          if (pc.api) p.api = { ...p.api, ...pc.api };
          if (pc.kind !== 'human') p.connected = false;
        });
        // 席位数量变化需重建玩家列表
        if (c.players.length !== st.players.length) st.config.seats = c.players.length;
        while (st.players.length < st.config.seats) {
          const i = st.players.length;
          st.players.push({ id: 'p' + (i + 1), seat: i, name: `席位${i + 1}`, kind: 'local',
                            persona: ['cooperator','freeRider','reciprocator','strategist','waverer'][i % 5],
                            coins: st.config.initialCoins, api: { baseUrl:'', apiKey:'', model:'' }, connected: false });
        }
        st.players = st.players.slice(0, st.config.seats);
      }
      broadcast(room);
      return;
    }

    case 'start': {
      if (st.phase !== 'lobby' && st.phase !== 'over') return send(ws, { type: 'error', msg: '游戏已在进行' });
      // 连点保护：1.5 秒内的第二个 start 直接吞掉。双绑/连点会让 startGame 跑两遍，
      // 玩家的战报被瞬间顶掉，看上去就像"结果页没弹出来直接开了下一局"
      if (room.startedAt && Date.now() - room.startedAt < 1500) return;
      room.startedAt = Date.now();
      startGame(room);
      return;
    }

    case 'reset': {
      clearTimers(room);
      st.phase = 'lobby'; st.round = 0; st.result = null;
      st.invest = {}; st.votes = {}; st.ratings = {}; st.history = []; st.calls = []; st.gifts = {};
      for (const p of st.players) p.coins = st.config.initialCoins;
      broadcast(room);
      return;
    }

    case 'skip': {
      if (st.phase === 'discuss' || st.phase === 'invest' || st.phase === 'vote' || st.phase === 'scoring') {
        if (room.timer) clearTimeout(room.timer);
        ({ invest: onInvestTimeout, vote: onVoteTimeout, discuss: onDiscussTimeout, scoring: onScoringTimeout })[st.phase](room);
      }
      return;
    }

    case 'invest': {
      if (!need()) return;
      const r = E.submitInvestment(st, pid, msg.amount);
      if (!r.ok) return send(ws, { type: 'error', msg: r.reason });
      broadcast(room);
      if (E.investmentsComplete(st)) finishEarly(room, onInvestTimeout);
      return;
    }

    case 'vote': {
      if (!need()) return;
      const r = E.submitVote(st, pid, msg.target);
      if (!r.ok) return send(ws, { type: 'error', msg: r.reason });
      broadcast(room);
      if (E.votesComplete(st)) finishEarly(room, onVoteTimeout);
      return;
    }

    case 'rate': {
      if (!need()) return;
      const r = E.submitRating(st, pid, msg.ratings);
      if (!r.ok) return send(ws, { type: 'error', msg: r.reason });
      broadcast(room);
      if (E.ratingsComplete(st)) finishEarly(room, onScoringTimeout);
      return;
    }

    case 'call:create': {
      if (!need()) return;
      const r = E.createCall(st, pid, msg.invite || []);
      if (!r.ok) return send(ws, { type: 'error', msg: r.reason });
      broadcast(room);
      return;
    }

    case 'call:respond': {
      if (!need()) return;
      const r = E.respondCall(st, msg.callId, pid, !!msg.accept);
      if (!r.ok) return send(ws, { type: 'error', msg: r.reason });
      broadcast(room);
      return;
    }

    case 'gift': {
      if (!need()) return;
      const r = E.submitGift(st, pid, msg.to, msg.amount);
      if (!r.ok) return send(ws, { type: 'error', msg: r.reason });
      broadcast(room);
      sendTo(room, r.gift.to, { type: 'gift:recv', from: pid, fromName: E.nameOf(st, pid), amount: r.amount });
      return;
    }

    case 'call:say': {
      if (!need()) return;
      if (!E.canTalk(st, msg.callId, pid)) return send(ws, { type: 'error', msg: '你不在这个频道里' });
      deliverCallMessage(room, msg.callId, pid, String(msg.text || '').slice(0, 200));
      return;
    }

    case 'call:leave': {
      if (!need()) return;
      E.leaveCall(st, pid);
      broadcast(room);
      return;
    }

    case 'ping': send(ws, { type: 'pong' }); return;
  }
}

function deliverCallMessage(room, callId, pid, text) {
  if (!text) return;
  const st = room.state;
  const call = st.calls.find(c => c.id === callId);
  if (!call) return;
  const payload = { type: 'call:msg', callId, from: pid, fromName: E.nameOf(st, pid), text, t: Date.now() };
  for (const id of call.members) sendTo(room, id, payload);
  // 监听流只发给"不在通话里"的观战端：观战位（上帝视角）和 ?spy=1 调试端。
  // 两件事：一是密谈内容本就不该外泄给其他玩家；二是早期版本无条件再发一份给 p1，
  // 导致玩家身处通话时同一句话会收到两遍，聊天框里全是重复内容。
  const watchers = [...room.clients].filter(c =>
    (c._spectate || c._spy) && !(c._pid && call.members.includes(c._pid)));
  for (const c of watchers) send(c, { ...payload, spectate: true });
}

const HOST = process.env.HOST || '0.0.0.0';   // 默认监听所有网卡：同局域网的设备才能进来
server.listen(PORT, HOST, () => {
  console.log(`公共财博弈 · 服务已启动: http://127.0.0.1:${PORT}`);
  console.log(`  打开后先进房间大厅：可新建房间，或从网络房间列表里挑一个加入`);
  const lans = lanIPs();
  if (lans.length) {
    console.log('  同局域网联机入口（发给朋友即可入座）：');
    for (const ip of lans) console.log(`    http://${ip}:${PORT}/`);
    console.log(`  若对方连不上，检查本机防火墙是否放行 ${PORT} 端口`);
  } else {
    console.log('  没检测到局域网 IP，只能本机访问');
  }
  if (HOST === '0.0.0.0') console.log('注意：服务对外开放，仅建议在可信网络下使用。');
});

export { rooms, lobby, listRooms };
