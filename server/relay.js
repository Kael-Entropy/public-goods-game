/*
 * 云端中继服务器 —— 只当"邮局"，不含任何游戏规则，也不托管网页。
 *
 * 职责只有三件：
 *   1. 房间目录：房主注册房间（房号/名字/密码/人数），任何人可列
 *   2. 配对：客机点加入 → 通知房主 → 房主为它开一个本地席位 → 双向接通
 *   3. 转发：客机的操作原样转给房主，房主下发的状态原样转给对应客机
 *
 * 所以在浏览器里打开这个地址是没有任何游戏的 —— 游戏必须靠本地客户端跑。
 *
 * 运行：PORT=8787 node server/relay.js
 */
import http from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 8787);

// roomId -> { id, name, password, seats, humans, host:<ws>, guests:Map<connId, ws>, createdAt }
const rooms = new Map();
let connSeq = 0;

const send = (ws, obj) => { try { ws.send(JSON.stringify(obj)); } catch {} };

// ---------------------------------------------------------------- 房间目录
function roomSummary(r) {
  return {
    id: r.id, name: r.name, seats: r.seats, humans: r.humans,
    guests: r.guests.size, locked: !!r.password, createdAt: r.createdAt,
    phase: r.phase || 'lobby', round: r.round || 0, playing: !!r.playing,
  };
}
const listRooms = () => [...rooms.values()].sort((a, b) => b.createdAt - a.createdAt).map(roomSummary);

// 房间列表变了就通知所有还停在大厅的连接
const watchers = new Set();
function broadcastRooms() {
  const list = listRooms();
  for (const ws of watchers) send(ws, { type: 'rooms', rooms: list });
}

// ---------------------------------------------------------------- 极简 HTTP
// 不托管任何页面：它就是个中继，浏览器打开只会看到一行说明
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('公共财博弈 · 联机中继服务\n\n这里只是转发消息的中转站，没有游戏。\n请下载游戏客户端，用客户端连接本服务。\n');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws._role = null;          // 'host' | 'guest'
  ws._roomId = null;
  ws._connId = null;
  watchers.add(ws);
  send(ws, { type: 'hello', role: null, rooms: listRooms() });

  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    handle(ws, m);
  });

  ws.on('close', () => {
    watchers.delete(ws);
    // 房主掉线 = 房间没了，通知所有客机
    if (ws._role === 'host' && ws._roomId) {
      const r = rooms.get(ws._roomId);
      if (r && r.host === ws) {
        for (const [, g] of r.guests) send(g, { type: 'net:closed', reason: '房主关闭了房间' });
        rooms.delete(ws._roomId);
        broadcastRooms();
      }
    } else if (ws._role === 'guest' && ws._roomId) {
      const r = rooms.get(ws._roomId);
      if (r) {
        r.guests.delete(ws._connId);
        if (r.host) send(r.host, { type: 'net:leave', connId: ws._connId });
        r.humans = Math.max(0, r.humans - 1);
        broadcastRooms();
      }
    }
  });
});

function handle(ws, m) {
  switch (m.type) {
    case 'rooms:list':
      return send(ws, { type: 'rooms', rooms: listRooms() });

    // 房主：开一个房间并登记到目录
    case 'net:host': {
      const id = String(m.roomId || '').toUpperCase().slice(0, 12);
      if (!id) return send(ws, { type: 'error', msg: '缺少房号' });
      if (rooms.has(id)) return send(ws, { type: 'error', msg: '这个房号已经被占用了' });
      const r = {
        id, name: String(m.name || `房间 ${id}`).slice(0, 20),
        password: m.password ? String(m.password).slice(0, 32) : '',
        seats: Number(m.seats) || 10, humans: Number(m.humans) || 0,
        host: ws, guests: new Map(), createdAt: Date.now(),
      };
      rooms.set(id, r);
      ws._role = 'host'; ws._roomId = id;
      watchers.delete(ws);
      send(ws, { type: 'net:hosted', roomId: id });
      return broadcastRooms();
    }

    // 房主：更新人数等摘要
    case 'net:update': {
      const r = ws._roomId && rooms.get(ws._roomId);
      if (!r || r.host !== ws) return;
      if (m.humans !== undefined) r.humans = Number(m.humans) || 0;
      if (m.name !== undefined) r.name = String(m.name).slice(0, 20);
      if (m.seats !== undefined) r.seats = Number(m.seats) || 10;
      if (m.phase !== undefined) { r.phase = String(m.phase).slice(0, 16); r.playing = !!m.playing; }
      if (m.round !== undefined) r.round = Number(m.round) || 0;
      return broadcastRooms();
    }

    // 客机：加入某个房间
    case 'net:join': {
      const id = String(m.roomId || '').toUpperCase().slice(0, 12);
      const r = rooms.get(id);
      if (!r) return send(ws, { type: 'error', msg: '房间不存在或房主已关闭' });
      if (r.password && String(m.password || '') !== r.password) {
        return send(ws, { type: 'error', msg: '密码不对', needPassword: true, roomId: id });
      }
      const connId = 'c' + (++connSeq);
      ws._role = 'guest'; ws._roomId = id; ws._connId = connId;
      watchers.delete(ws);
      r.guests.set(connId, ws);
      send(ws, { type: 'net:joined', roomId: id, name: r.name, connId });
      // 让房主为这个客机准备一个本地席位
      send(r.host, { type: 'net:guest', connId, name: m.name || '玩家' });
      return broadcastRooms();
    }

    // 转发：客机 -> 房主（房主侧会把它当作某个席位发的）
    case 'net:tohost': {
      const r = ws._roomId && rooms.get(ws._roomId);
      if (!r || !r.host || ws._role !== 'guest') return;
      return send(r.host, { type: 'net:from', connId: ws._connId, msg: m.msg });
    }

    // 转发：房主 -> 指定客机
    case 'net:toguest': {
      const r = ws._roomId && rooms.get(ws._roomId);
      if (!r || r.host !== ws) return;
      const g = r.guests.get(m.connId);
      if (g) send(g, { type: 'net:from', msg: m.msg });
      return;
    }

    // 房主：踢掉/断开某个客机
    case 'net:kick': {
      const r = ws._roomId && rooms.get(ws._roomId);
      if (!r || r.host !== ws) return;
      const g = r.guests.get(m.connId);
      if (g) { send(g, { type: 'net:closed', reason: '被房主请出房间' }); try { g.close(); } catch {} }
      return;
    }

    case 'net:close': {
      const r = ws._roomId && rooms.get(ws._roomId);
      if (!r) return;
      if (r.host === ws) {
        for (const [, g] of r.guests) send(g, { type: 'net:closed', reason: '房主关闭了房间' });
        rooms.delete(r.id);
      } else {
        r.guests.delete(ws._connId);
        if (r.host) send(r.host, { type: 'net:leave', connId: ws._connId });
      }
      ws._role = null; ws._roomId = null; ws._connId = null;
      watchers.add(ws);
      return broadcastRooms();
    }

    default:
      return send(ws, { type: 'error', msg: '未知指令: ' + m.type });
  }
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`公共财博弈 · 联机中继已启动: ${PORT}`);
  console.log('  只做消息转发与房间目录，不含任何游戏规则，也不托管网页。');
});
