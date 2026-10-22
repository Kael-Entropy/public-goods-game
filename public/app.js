// 前端：圆桌场景渲染 + 各阶段操作
let S = null, me = null;
let selVote = null, ratings = {}, inviteSel = new Set();
let callMsgs = {}, archive = [], spy = [], acted = {};
let giftTo = null, myGifts = [], recvGifts = [];
const aKey = () => `${S.phase}:${S.round}`;
const markActed = () => { acted[aKey()] = true; };
const hasActed = () => !!acted[aKey()];
const $ = id => document.getElementById(id);
// 金币小图标（assets/coin_N.png，由 AI 生成后抠底）
const CI = (n, lg) => `<img class="cico${lg ? ' lg' : ''}" src="assets/coin_${n || 16}.png" alt="">`;
// Q 版形象：按席位号取图（不暴露任何性格线索）。界面只用 96px 缩略图，
// 1024 原图太重（单张 300~800KB），十张一起拉会拖慢首屏。
const AV = (seat) => `assets/avatars/a${((seat || 0) % 10) + 1}_96.png`;
const AV96 = AV;

// 带 ?spy=1 打开网址 = 调试模式（坐席位的玩家也能开"监听"页签偷看 AI 密谈）
// YOU = 服务端告诉我的"我是谁"：{ pid, spectate }。spectate 为真 = 观战位（不占席位，上帝视角）
let YOU = { pid: 'p1', spectate: false };   // 默认乐观绑定 0 号席位，服务端下发后覆盖
// 网址带 ?watch=1 = 直接以观战位进入（可以单独分享"只看不玩"的链接）
let myRole = /[?&]watch=1/.test(location.search) ? 'watch' : 'play';
let ROOM_ID = '';                           // 进房后由服务端下发；房号单独存，S 每次广播都会被整体换掉
// ---- 房间大厅 ----
let ROOMS = [];                             // 本机 + 网络上现存的房间列表（带 online 标记的来自中继）
let RELAY_UP = false;                       // 本地网关有没有连上联机中继
let inRoom = false;                         // 是否已进入某个房间（false = 还停在大厅）
let roomName = '', roomLocked = false;      // 当前房间的名字与是否设了密码
let roomPublic = true;                      // 当前房间有没有开放到网络（建房时勾的那个）
let passFor = null;                         // 正在等用户输入密码的房号
const amSpectator = () => !!(YOU && YOU.spectate);
// ---- 连接：只连本机的网关 ----
// 客户端架构：规则、AI、阶段推进全在本地网关里跑，而且网关只监听 127.0.0.1。
// 也就是说同一 Wi-Fi 下的人用浏览器也打不开这台机器上的游戏 —— 想一起玩，
// 必须用客户端、靠"房号 + 中继"进来。前端因此不需要（也不该）去连别的服务器。
function serverWsUrl() { return `ws://${location.host}${location.search}`; }
// 昵称：加入别人的房间时显示在席位上
let NICK = '玩家';
try { NICK = localStorage.getItem('pgg_nick') || '玩家'; } catch {}

// 连接可重建：大厅里切换服务器 = 断开旧连接、连新的
let ws = null;
function connect() {
  if (ws) { try { ws.onopen = ws.onmessage = ws.onclose = null; ws.close(); } catch {} }
  ws = new WebSocket(serverWsUrl());
  ws.onopen = () => syncSeat();
  ws.onmessage = onWsMessage;
  ws.onclose = () => { if (inRoom) toast('与服务器的连接断开了，请刷新页面'); };
}
// 进房后才占席位；大厅里没有席位可占
function syncSeat() {
  if (!inRoom) return;
  if (myRole === 'watch') send({ type: 'join', spectate: true, name: '观众' });
  else send({ type: 'join', seat: 0, name: '你' });
}
function onWsMessage(ev) {
  const m = JSON.parse(ev.data);
  if (m.type === 'hello') {
    // 大厅：只给房间列表，没有对局状态。若 hello 里带了 state 则视为已在房内（兼容直达/旧客户端）
    ROOMS = m.rooms || [];
    if (m.relay !== undefined) RELAY_UP = m.relay;
    roomName = m.name || ''; roomLocked = !!m.locked;
    if (m.state) {
      inRoom = true; if (m.roomId) ROOM_ID = m.roomId;
      const prev = S; S = m.state; if (prev) S._invMax = prev._invMax;
      if (S.result) lastResult = S.result;
      syncSeat();
    } else { inRoom = false; S = null; }
    render();
  }
  else if (m.type === 'entered') {
    inRoom = true; ROOM_ID = m.roomId; roomName = m.name || ''; roomLocked = !!m.locked;
    passFor = null;
    // 网址补上房号：刷新页面还能回到这个房间，也方便直接复制给别人
    try { const u = new URL(location.href); u.searchParams.set('room', m.roomId); history.replaceState(null, '', u); } catch {}
    const prev = S; S = m.state; if (prev) S._invMax = prev._invMax;
    if (m.you) { YOU = m.you; me = m.you.pid; }
    if (S.result) lastResult = S.result;    // 战报留档，新局开起来后也能回看
    syncSeat();
    render();
  }
  // 房间列表刷新：只换列表那一块，别把人家正在填的房间名/房号冲掉
  else if (m.type === 'rooms') { ROOMS = m.rooms || []; if (m.relay !== undefined) RELAY_UP = m.relay; if (!inRoom) renderHallRooms(); }
  else if (m.type === 'room:created') { toast(`房间 ${m.roomId} 已建好`); }
  else if (m.type === 'state') {
    const prev = S; S = m.state; if (m.roomId) ROOM_ID = m.roomId; if (prev) S._invMax = prev._invMax;
    if (m.you) { YOU = m.you; me = m.you.pid; }
    if (m.relay !== undefined) RELAY_UP = m.relay;
    if (S.result) lastResult = S.result;    // 战报留档，新局开起来后也能回看
    render();
  }
  else if (m.type === 'joined') { YOU = { pid: m.pid, spectate: !!m.spectate }; me = m.pid; render(); }
  else if (m.type === 'call:msg') { onCallMsg(m); }
  else if (m.type === 'gift:recv') {
    recvGifts.push(m);
    toast(`${m.fromName} 赠给你 ${m.amount} 枚金币`);
    render();
  }
  else if (m.type === 'error') {
    if (m.msg) toast(m.msg);
    const e2 = $('errStick'); if (e2 && m.msg) { e2.textContent = '⚠ ' + m.msg; e2.style.display = ''; setTimeout(() => e2.style.display = 'none', 3000); }
    if (m.needPassword) { passFor = m.roomId; if (!inRoom) renderHall(); }   // 密码房：就地展开输入框
    if (String(m.msg).includes('占用')) me = null;   // 乐观绑定失败，回退
  }
}
connect();                                   // 启动：默认连本机，大厅里可切换到线上
function send(o) { ws.send(JSON.stringify(o)); }
window.addEventListener('error', e => { try { toast('脚本错误: ' + e.message); } catch {} });
function toast(t) {
  const el = $('toast'); el.textContent = t; el.style.display = 'block';
  clearTimeout(el._t); el._t = setTimeout(() => el.style.display = 'none', 2200);
}
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function playerOf(id) { return S.players.find(p => p.id === id); }
function nameOf(id) { return playerOf(id)?.name || id; }
function onCallMsg(m) {
  // spectate 标记 = 监听/偷看流（别人家的密谈）。这种消息绝不能混进自己的通话记录里，
  // 否则"密谈只有通话里的人看得到"就是句空话。它只进监听列表，观战位的主聊天区另外渲染。
  if (m.spectate) {
    spy.push(m);
    renderSpy();
    if (amSpectator()) renderChatBody();
    return;
  }
  (callMsgs[m.callId] = callMsgs[m.callId] || []).push(m);
  archive.push({ round: S ? S.round : 0, ...m });
  renderChatBody();
}

const PHASE_TEXT = { lobby: '建房中', invest: '投资', vote: '投票', settle: '结算', discuss: '自由讨论', scoring: '互评打分', over: '已结束' };
const PHASE_SUB = {
  invest: '把金币放进桌心的箱子，翻倍后全员平分',
  vote: '被投出的人本轮不参与平分，投入全部沉没',
  settle: '箱子里已经清空，等待下一轮',
  discuss: '没有公开发言，只能私聊；也允许私下转钱',
  scoring: '你的分数 = 别人给你的评分，按他手里金币占比加权',
};

function render() {
  // 还没进房：显示房间大厅（建房 / 选房加入）
  if (!inRoom || !S) { renderHall(); return; }
  const inGame = S.phase !== 'lobby' && S.phase !== 'over';
  document.body.classList.toggle('overlay-on', !inGame);
  ensureSeats();
  renderAssetBar();          // 先于 layoutScene：中央卡片要贴着资产条的下缘摆
  layoutScene();
  updateSeats();
  renderChest();
  renderChat();
  renderInfo();
  renderStage();
  maybeSettleAnim();
  if (!inGame) renderOverlay();
  else if (!_showingLast) $('lobby').style.display = 'none';   // 正翻看旧战报时别给它关掉
}

// ================================================================ 圆桌场景
// 左右常驻面板宽度，场景布局要据此让出安全区（改 CSS 时这里也要同步改）
const PANEL_W = { chat: 222, stage: 252 };
let _seatSig = '';
function ensureSeats() {
  const sig = S.players.map(p => p.id).join(',');
  if (sig === _seatSig) return;
  _seatSig = sig;
  const box = $('seats'); if (!box) return;
  box.innerHTML = '';
  S.players.forEach(p => {
    const d = document.createElement('div');
    d.className = 'seat2'; d.dataset.pid = p.id;
    d.innerHTML = `<img class="av" src="${AV(p.seat)}" alt="">
      <span class="badge" style="display:none"></span>
      <span class="talk" style="display:none">密谈中</span>
      <div class="nm">${esc(p.name)}</div>
      <div class="cb">${CI(16)}<span class="cv">0</span></div>`;
    box.appendChild(d);
  });
}

function sceneGeom() {
  const W = window.innerWidth || 1280, H = window.innerHeight || 800;
  // 左右两侧常驻面板占用的宽度 + 外边距 + 安全间隙（间隙留够，座位才不会被面板切掉）
  const L = PANEL_W.chat + 12 + 24, R = W - PANEL_W.stage - 12 - 24;
  // 中央卡片动态贴在资产条下方（资产条高度随内容/窗口变化，写死必被盖住页签）
  const ip = $('infoPanel'), ab = $('assetBar');
  if (ip && ab && ip.offsetParent !== null) ip.style.top = Math.round(ab.getBoundingClientRect().bottom + 8) + 'px';
  const T = Math.max(92, ip && ip.offsetParent !== null ? ip.getBoundingClientRect().bottom + 12 : 100);
  const B = H - 14;
  const availW = Math.max(260, R - L), availH = Math.max(220, B - T);
  const ry = Math.max(66, Math.min(availH / 2 - 58, 240));
  const rx = Math.max(150, Math.min(availW / 2 - 66, ry * 1.75));
  const cx = Math.max(L + rx + 66, Math.min(R - rx - 66, (L + R) / 2));
  const cy = (T + B) / 2;
  return { cx, cy, rx, ry };
}

function layoutScene() {
  const g = sceneGeom();
  const o = document.querySelector('.table-outer'), i = document.querySelector('.table-inner'), c = $('chestZone');
  if (o) { o.style.left = (g.cx - g.rx) + 'px'; o.style.top = (g.cy - g.ry) + 'px'; o.style.width = (g.rx * 2) + 'px'; o.style.height = (g.ry * 2) + 'px'; o.style.transform = 'none'; }
  if (i) { const rx = g.rx * 0.78, ry = g.ry * 0.76; i.style.left = (g.cx - rx) + 'px'; i.style.top = (g.cy - ry) + 'px'; i.style.width = (rx * 2) + 'px'; i.style.height = (ry * 2) + 'px'; i.style.transform = 'none'; }
  if (c) { c.style.left = g.cx + 'px'; c.style.top = g.cy + 'px'; }
  const seats = document.querySelectorAll('.seat2');
  const n = seats.length || 1;
  seats.forEach((el, idx) => {
    const th = 90 + idx * (360 / n);          // 0 号席位坐在正下方（靠近玩家自己）
    const rad = th * Math.PI / 180;
    const x = g.cx + g.rx * Math.cos(rad), y = g.cy + g.ry * Math.sin(rad);
    const persp = 0.80 + 0.20 * ((Math.sin(rad) + 1) / 2);   // 远排略小，制造纵深
    el.style.left = x + 'px'; el.style.top = y + 'px';
    el.style.transform = `translate(-50%,-50%) scale(${persp.toFixed(3)})`;
    el.style.zIndex = String(10 + Math.round(Math.sin(rad) * 10));
  });
}
window.addEventListener('resize', () => { if (S) layoutScene(); });

function updateSeats() {
  const last = S.history.length ? S.history[S.history.length - 1] : null;
  const inRound = last && last.round === S.round;
  const talkingPids = new Set();
  for (const c of (S.calls || [])) if (!(c.pending || []).length) c.members.forEach(id => talkingPids.add(id));
  for (const p of S.players) {
    const el = document.querySelector(`.seat2[data-pid="${p.id}"]`); if (!el) continue;
    const cv = el.querySelector('.cv'); if (cv) cv.textContent = p.coins;
    const excluded = !!(inRound && last.holdings[p.id] == null);
    const badge = el.querySelector('.badge'), talk = el.querySelector('.talk');
    if (badge) { badge.style.display = excluded ? '' : 'none'; badge.textContent = '✕'; badge.title = '本轮被投出'; }
    if (talk) talk.style.display = talkingPids.has(p.id) ? '' : 'none';
    el.classList.toggle('out', excluded);
    el.classList.toggle('me', p.id === me);
  }
}

function renderChest() {
  const t = $('chestTotal'), h = $('chestHint');
  if (!t) return;
  const last = S.history.length ? S.history[S.history.length - 1] : null;
  if (S.phase === 'invest') { t.textContent = '?'; h.textContent = `已放入 ${S.investDone}/${S.config.seats} 份`; }
  else if (S.phase === 'settle' && last) { t.textContent = last.total; h.textContent = `×${S.config.multiplier} → 每份 ${last.payout}`; }
  else if (last) { t.textContent = last.total; h.textContent = `第 ${last.round} 轮 · 每份 ${last.payout}`; }
  else { t.textContent = '0'; h.textContent = S.config.seats + ' 人就座，等待开局'; }
}

// ---------------------------------------------------------------- 金币飞行动画
function rectOf(el) {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (!r.width && !r.height && !r.left && !r.top) return null;
  return r;
}
function flyCoins(fromEl, toEl, n, opt = {}) {
  const a = rectOf(fromEl), b = rectOf(toEl);
  if (!a || !b || !n) return;
  const cnt = Math.min(n, opt.max ?? 8), src = opt.src || 'assets/coin_24.png';
  for (let i = 0; i < cnt; i++) {
    const img = document.createElement('img');
    img.src = src; img.className = 'flycoin'; img.alt = '';
    img.style.left = (a.left + a.width / 2 - 11) + 'px';
    img.style.top = (a.top + a.height / 2 - 11) + 'px';
    img.style.opacity = '1';
    document.body.appendChild(img);
    const jx = (Math.random() - 0.5) * 34, jy = (Math.random() - 0.5) * 26;
    const delay = i * 55 + (opt.delay || 0);
    setTimeout(() => {
      requestAnimationFrame(() => {
        img.style.left = (b.left + b.width / 2 - 11 + jx) + 'px';
        img.style.top = (b.top + b.height / 2 - 11 + jy) + 'px';
        img.style.opacity = opt.fade === false ? '1' : '0.15';
      });
    }, delay);
    setTimeout(() => img.remove(), delay + 950);
  }
}
function seatEl(pid) { return document.querySelector(`.seat2[data-pid="${pid}"] img.av`); }
let _lastHistN = 0;
function maybeSettleAnim() {
  const n = S.history.length;
  if (n > _lastHistN && n > 0) {
    const h = S.history[n - 1];
    S.players.forEach((p, idx) => {
      const delay = idx * 55;
      if (h.holdings[p.id] == null) {           // 被排除：投入沉进箱子
        flyCoins(seatEl(p.id), $('chestZone'), 3, { delay, fade: false, src: 'assets/coin_24.png' });
      } else {                                   // 分红飞回来
        flyCoins($('chestZone'), seatEl(p.id), Math.min(3, h.payout || 1), { delay: delay + 120 });
      }
    });
  }
  _lastHistN = n;
}

// ================================================================ 顶部资产条
let _lastRound = -1;
function renderAssetBar() {
  if (S.round !== _lastRound) {
    _lastRound = S.round;
    myGifts = []; recvGifts = []; callMsgs = {}; giftTo = null; S._giftAmt = 1; S._inv = null; inviteSel.clear(); selVote = null;
  }
  const cfg = S.config;
  const round = $('abRound');
  if (round) round.innerHTML = `房间 ${ROOM_ID} · ${cfg.seats} 席 · M=${cfg.multiplier}
    <span class="sub">${S.round ? `第 ${S.round}/${cfg.rounds} 轮 · ${PHASE_TEXT[S.phase] || S.phase}` : (PHASE_TEXT[S.phase] || S.phase)}</span>`;

  // 本轮变化基准：上一轮结算后的持有数
  let base = null;
  for (let i = S.history.length - 1; i >= 0; i--) if (S.history[i].round < S.round) { base = S.history[i].holdings; break; }
  const list = $('abList');
  if (list) {
    list.innerHTML = S.players.map(p => {
      const d = base && base[p.id] != null ? p.coins - base[p.id] : 0;
      const out = base && base[p.id] == null;
      // 本轮没变化就不显示 ±0，能省下一截宽度给别的 chips
      const dHtml = d === 0 ? '' : `<span class="d ${d > 0 ? 'up' : 'dn'}">${d > 0 ? '+' + d : d}</span>`;
      return `<div class="ab-chip ${p.id === me ? 'me' : ''} ${out ? 'out' : ''}" title="${esc(p.name)}">
        <img src="${AV96(p.seat)}" alt=""><span class="v">${p.coins}</span>${dHtml}</div>`;
    }).join('');
  }
  ensureTimer();
}

let tick = null, _tKey = '', _tTotal = 1;
function ensureTimer() { if (!tick) tick = setInterval(tickFn, 100); }
function tickFn() {
  const el = $('abTimer'), tx = $('abTimerText');
  if (!el || !tx || !S) return;
  if (!S.phaseEndsAt || S.phase === 'lobby' || S.phase === 'over') {
    el.style.setProperty('--p', 0); tx.textContent = '–'; el.classList.remove('low'); return;
  }
  const key = `${S.phase}:${S.phaseEndsAt}`;
  if (key !== _tKey) { _tKey = key; _tTotal = Math.max(1, S.phaseEndsAt - Date.now()); }
  const left = Math.max(0, S.phaseEndsAt - Date.now());
  el.style.setProperty('--p', Math.max(0, Math.min(100, left / _tTotal * 100)).toFixed(1));
  tx.textContent = Math.ceil(left / 1000) + 's';
  el.classList.toggle('low', left < 5000);
}

// ================================================================ 左侧对话
function myCallOf() { return (S.calls || []).find(c => c.members.includes(me)) || null; }
function renderChat() {
  const card = $('callCard'), inp = $('chatInput');
  if (!card || !inp) return;
  // 观战位：上帝视角，能听见所有人私下的密谈（场上玩家互相听不到）
  if (amSpectator()) {
    card.innerHTML = `<div class="call-note">观战位 · 上帝视角：所有密谈你都听得见，但不能发言。</div>`;
    renderChatBody();
    inp.innerHTML = '';
    return;
  }
  const discussing = S.phase === 'discuss';
  const myCall = discussing ? myCallOf() : null;
  const prevText = $('sayText') ? $('sayText').value : '';
  card.style.display = discussing ? '' : '';
  if (discussing) {
    const others = (S.calls || []).filter(c => !c.members.includes(me));
    card.innerHTML = myCall
      ? `<div class="call-note">当前通话：${myCall.members.map(id => esc(nameOf(id))).join('、')}${(myCall.pending || []).length ? '（有人还没接）' : ''}</div>`
      : (others.length
        ? `<div class="chat-locked">桌下正同时进行 ${others.length} 场密谈（${others.map(c => c.members.length + '人').join('、')}），具体内容听不见。</div>`
        : `<div class="chat-locked">你还没加入任何通话。桌上一片安静。</div>`);
  } else {
    card.innerHTML = `<div class="chat-locked">非讨论阶段：只能回看之前的密谈内容，不能发言。</div>`;
  }
  renderChatBody();
  inp.innerHTML = myCall
    ? `<div class="ci-row"><input type="text" id="sayText" placeholder="说点什么…" maxlength="120">
        <button class="btn sm primary" id="btnSay">发送</button></div>
       <div class="row" style="margin:6px 0 0"><button class="btn sm" id="btnLeave">退出通话</button></div>`
    : '';
  const t = $('sayText'); if (t) t.value = prevText;
  const bs = $('btnSay'); if (bs) bs.onclick = () => {
    const el = $('sayText'); const v = el.value.trim(); if (!v || !myCall) return;
    send({ type: 'call:say', callId: myCall.id, text: v }); el.value = '';
  };
  const tl = $('sayText'); if (tl) tl.onkeydown = e => { if (e.key === 'Enter') { const b = $('btnSay'); if (b) b.click(); } };
  const bl = $('btnLeave'); if (bl) bl.onclick = () => send({ type: 'call:leave' });
}

function renderChatBody() {
  const body = $('chatBody'); if (!body) return;
  if (amSpectator()) {
    body.innerHTML = spy.length
      ? spy.slice(-80).map(m => `<div class="grp"><div class="who">${esc(m.fromName)}</div><div class="bubble">${esc(m.text)}</div></div>`).join('')
      : '<span class="muted">还没有人在密谈。</span>';
    body.scrollTop = body.scrollHeight;
    return;
  }
  const discussing = S.phase === 'discuss';
  const myCall = discussing ? myCallOf() : null;
  const bubble = (m, mine) => `<div class="grp ${mine ? 'mine' : ''}">
    <div class="who">${esc(m.fromName)}</div><div class="bubble">${esc(m.text)}</div></div>`;
  if (myCall) {
    const msgs = callMsgs[myCall.id] || [];
    body.innerHTML = msgs.length ? msgs.map(m => bubble(m, m.from === me)).join('')
      : '<span class="muted">通话里还没有人说话。</span>';
    body.scrollTop = body.scrollHeight;
    return;
  }
  // 历史模式（只读）
  if (!archive.length) { body.innerHTML = '<span class="muted">还没有任何密谈记录。</span>'; return; }
  let html = '', lastRound = null;
  for (const m of archive) {
    if (m.round !== lastRound) { lastRound = m.round; html += `<div class="rd">第 ${m.round} 轮</div>`; }
    html += bubble(m, m.from === me);
  }
  body.innerHTML = html;
  body.scrollTop = body.scrollHeight;
}

// ================================================================ 中央信息卡片
let infoTab = 'hist';
function bindTabs() {
  // 监听面板默认关闭：AI 之间的密谈只有通话里的人才有资格知道，
  // 想调试时给网址加 ?spy=1
  // 监听页签只给两种人：网址带 ?spy=1 的调试者、以及观战位（本来就是上帝视角）
  const spyOn = /[?&]spy=1/.test(location.search) || myRole === 'watch';
  document.querySelectorAll('.ip-tab').forEach(b => {
    if (b.dataset.t === 'spy') { b.style.display = spyOn ? '' : 'none'; }
    if (!b.dataset.t) return;               // "上局战报"不是页签，别把它当成切换按钮
    b.onclick = () => {
      infoTab = b.dataset.t;
      document.querySelectorAll('.ip-tab').forEach(x => x.classList.toggle('on', x === b));
      ['hist', 'log', 'spy'].forEach(id => { const e = $(id); if (e) e.style.display = (id === infoTab ? '' : 'none'); });
    };
  });
}
function renderInfo() {
  const bl = $('btnLastResult');
  if (bl) bl.style.display = lastResult ? '' : 'none';
  renderHist(); renderLog(); renderSpy();
}

function renderHist() {
  const el = $('hist'); if (!el) return;
  if (!S.history.length) { el.innerHTML = '<span class="muted">还没有结算。</span>'; return; }
  const head = `<tr><th>席位</th>${S.history.map(h => `<th>R${h.round}</th>`).join('')}</tr>`;
  const body = S.players.map(p => `<tr><td>${esc(p.name)}</td>${
    S.history.map(h => {
      const v = h.holdings[p.id];
      return v == null ? '<td class="ex">✕</td>' : `<td>${v}</td>`;
    }).join('')}</tr>`).join('');
  el.innerHTML = `<table>${head}${body}</table>`;
}
function renderLog() {
  const el = $('log'); if (!el) return;
  el.innerHTML = (S.log || []).slice(-40).reverse().map(l => `<div>${esc(l.text)}</div>`).join('') || '<span class="muted">暂无事件。</span>';
}
function renderSpy() {
  const el = $('spy'); if (!el) return;
  el.innerHTML = spy.slice(-40).map(m => `<div class="msg"><span class="who">${esc(m.fromName)} · 监听</span><div>${esc(m.text)}</div></div>`).join('')
    || '<span class="muted">AI 之间的密谈会出现在这里（仅调试）。</span>';
  el.scrollTop = el.scrollHeight;
}

// ================================================================ 右侧阶段面板
function headHTML(title, sub) {
  const head = $('stageHead'); if (!head) return;
  head.style.display = '';
  head.innerHTML = `<h2>${title}</h2><div class="muted">${sub || ''}</div>`;
}
function renderStage() {
  const box = $('stage'); if (!box) return;
  // 观战位：不渲染任何操作控件，只报告场上正在发生什么
  if (amSpectator() && S.phase !== 'lobby' && S.phase !== 'over') {
    headHTML('观战中', '你不占席位，桌上十个人自己博弈');
    return renderWatch(box);
  }
  switch (S.phase) {
    case 'invest': headHTML(`第 ${S.round} 轮 · 投资`, PHASE_SUB.invest); return renderInvest(box);
    case 'vote': headHTML(`第 ${S.round} 轮 · 投票`, PHASE_SUB.vote); return renderVote(box);
    case 'settle': headHTML(`第 ${S.round} 轮 · 结算`, PHASE_SUB.settle); return renderSettle(box);
    case 'discuss': headHTML(`第 ${S.round} 轮 · 自由讨论`, PHASE_SUB.discuss); return renderDiscuss(box);
    case 'scoring': headHTML('终局 · 互评打分', PHASE_SUB.scoring); return renderScoring(box);
    default: {
      const h = $('stageHead'); if (h) h.style.display = 'none';
      box.innerHTML = ''; box._sig = '';
    }
  }
}
// ---------------------------------------------------------------- 观战面板
const WATCH_TIP = {
  invest: '每人私下往桌心箱子投金币，投多少不公示，只能从结算后的持有变化里反推。',
  vote: '（第 2 轮起）得票够多的人本轮不参与平分，他投进去的钱全部沉没。',
  settle: '箱子里的钱翻倍后由没被投出的人平分。',
  discuss: '没有公开发言，只能拉人进私密通话；也允许私下转钱。观战位能听见所有密谈。',
  scoring: '互评打分：谁的金币多，他手里那张评分票就更重。',
};
function renderWatch(box) {
  const sig = 'watch:' + S.phase + ':' + S.round;
  if (box._sig !== skelSig(sig)) {
    box._sig = skelSig(sig);
    box.innerHTML = `<div class="muted">${WATCH_TIP[S.phase] || ''}</div>
      <div id="watchInfo" style="margin-top:8px"></div>`;
  }
  const el = $('watchInfo'); if (!el) return;
  const n = S.config.seats;
  if (S.phase === 'invest') el.innerHTML = `<div class="muted">已提交 ${S.investDone}/${n}</div>`;
  else if (S.phase === 'vote') el.innerHTML = `<div class="muted">已投票 ${S.voteDone}/${n} · 门槛 ${S.config.voteThreshold} 票</div>`;
  else if (S.phase === 'settle') {
    const s = S.history[S.history.length - 1];
    el.innerHTML = s ? `<div class="row" style="font-size:15px">箱内 <b>${s.total}</b> × ${S.config.multiplier} → 每份 <b>${s.payout}</b></div>
      <div class="muted">${s.excluded ? esc(nameOf(s.excluded)) + ' 被投出，投入沉没' : '无人被投出'}</div>` : '';
  } else if (S.phase === 'discuss') {
    const calls = S.calls || [];
    el.innerHTML = calls.length
      ? calls.map(c => `<div class="muted">${c.members.map(id => esc(nameOf(id))).join('、')}（${c.members.length} 人）在密谈</div>`).join('')
      : '<div class="muted">暂时没人发起密谈</div>';
  } else if (S.phase === 'scoring') el.innerHTML = `<div class="muted">已提交评分 ${S.ratingDone}/${n}</div>`;
}

// 骨架缓存：同一阶段内只建一次 DOM，之后只更新文本/样式。
// 不这么做的话，服务端每来一次广播都会重建输入框，玩家打字会被冲掉、光标也会丢。
// 签名里必须带上"我是谁"：hello 比 joined 先到，那时 me 还是 null。
// 不带身份的话，绑定席位后面板不会重建，中途加入/刷新页面会把"自己"也算进可邀请名单。
function skelSig(sig) { return sig + '#' + (me || '-') + (amSpectator() ? '#w' : '#p'); }
function stageSkel(box, sig) { return box._sig !== skelSig(sig); }
function stageSet(box, sig, html) { box._sig = skelSig(sig); box.innerHTML = html; }

const _clamp = (lo, hi, v) => Math.min(hi, Math.max(lo, v));
function invMax() {
  const me_ = S.players.find(p => p.id === me);
  const c = me_ ? me_.coins : 0;
  return S.config.maxInvestPerRound > 0 ? Math.min(c, S.config.maxInvestPerRound) : c;
}
function myCoins() { return (S.players.find(p => p.id === me)?.coins) ?? 0; }
function setInvestAmount(v, src) {
  const m = invMax();
  v = _clamp(0, m, Math.round(+v || 0));
  S._inv = v;
  const r = $('invRange'), n = $('invNum');
  if (r && r !== src) r.value = v;             // 不回写正在输入的那个框
  if (n && n !== src) n.value = v;
}

// ---------------------------------------------------------------- 位置 / 联机
// 邀请链接优先用服务端报上来的局域网 IP，否则退回当前地址栏的域名
// 邀请不再给网址：网址指向的是房主本机，别人打不开（这正是客户端架构要的效果）。
// 能给出去的只有房号 —— 对方用自己的客户端输入房号即可入座。
function inviteUrl() { return ROOM_ID || ''; }
function setRole(r) {
  myRole = r;
  bindTabs();                                                                // 观战位要露出"监听"页签
  if (r === 'watch') send({ type: 'join', spectate: true, name: '观众' });   // 交还席位，十席全 AI
  else send({ type: 'join', seat: 0, name: '你' });
}
async function copyInvite(watch) {
  const el = $('inviteUrl'); if (!el) return;
  const text = el.value;
  el.select();
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(text);
    else document.execCommand('copy');
    toast(watch ? '房号已复制：对方加入后切到观战位即可只看不玩' : '房号已复制，发给朋友让他用自己的客户端加入');
  } catch { toast('复制失败，请手动选中房号复制'); }
}
// "换个新房" = 回大厅。房号由服务端发，客户端不再自己编
function newRoom() { location.search = ''; }
// 一键十 AI 对局：把所有席位（含 1 号）改成离线策略，自己退到观战位看戏
function allAI() {
  const players = S.players.map(p => ({
    name: p.name,
    kind: p.kind === 'api' ? 'api' : 'local',   // 已填好云端 API 的席位保留，其余全用本地策略
    api: { baseUrl: p.api?.baseUrl || '', apiKey: p.api?.apiKey || '', model: p.api?.model || '' },
  }));
  send({ type: 'config', config: { ...S.config, players } });
  const c = S.config;
  toast(`${c.seats} 个席位已全部交给 AI，你退到观战位`);
  setRole('watch');
}

// ---------------------------------------------------------------- 投资
function renderInvest(box) {
  const me_ = S.players.find(p => p.id === me);
  const max = invMax();
  const sig = 'invest:' + S.round;
  if (stageSkel(box, sig)) {
    const v0 = Math.min(max, S._inv ?? Math.round(max / 2));
    const mpcr = S.config.multiplier / S.config.seats;
    stageSet(box, sig, `
    <div class="muted">箱子里的钱会 ×${S.config.multiplier} 后由没被投出的人平分。你多投 1 枚，自己只分回 ${mpcr.toFixed(2)} 枚${
      S.config.multiplier < S.config.seats
        ? `（净亏 ${(1 - mpcr).toFixed(2)} 枚）—— 数学上搭便车更划算，合作只能靠投票、赠与和密谈逼出来`
        : ' —— 投入对自己是划算的'}</div>
    <div class="row">
      <input type="range" id="invRange" min="0" max="${max}" value="${v0}">
      <input type="number" id="invNum" min="0" max="${max}" value="${v0}" style="width:80px">
    </div>
    <div class="row">
      <button class="btn sm" data-q="0">不投</button>
      <button class="btn sm" data-q="0.25">1/4</button>
      <button class="btn sm" data-q="0.5">一半</button>
      <button class="btn sm" data-q="1">全部</button>
      <span style="flex:1"></span>
      <button class="btn primary" id="btnInv">投进箱子</button>
    </div>
    <div class="muted" id="invFoot"></div>
    <div class="muted">投入金额不会单独公示，别人只能从结算后的持有变化里反推。</div>`);
  }
  const r = $('invRange'); if (r) r.max = max;
  const done = hasActed();
  const b = $('btnInv'); if (b) { b.disabled = done; b.textContent = done ? '已投入' : '投进箱子'; }
  const f = $('invFoot');
  if (f) f.textContent = `你持有 ${me_ ? me_.coins : 0} 枚${S.config.maxInvestPerRound > 0 ? ` · 本轮上限 ${S.config.maxInvestPerRound}` : ''} · 桌上已提交 ${S.investDone}/${S.config.seats}`;
}
function doInvest() {
  const n = $('invNum');
  const amt = _clamp(0, invMax(), Math.round(+n.value || 0));
  S._inv = amt;
  send({ type: 'invest', amount: amt }); markActed();
  flyCoins(seatEl(me), $('chestZone'), amt, { max: 6 });
  const b = $('btnInv'); if (b) { b.disabled = true; b.textContent = '已投入'; }
}

// ---------------------------------------------------------------- 投票
function renderVote(box) {
  const sig = 'vote:' + S.round;
  if (stageSkel(box, sig)) {
    const opts = S.players.map(p => `<button class="seatbtn" data-v="${p.id}">
      <img class="av" src="${AV96(p.seat)}" alt="">${esc(p.name)}
      <div class="muted" data-coin="${p.id}">持有 ${p.coins}</div>
    </button>`).join('');
    stageSet(box, sig, `
    <div class="muted">获得 ≥${S.config.voteThreshold} 票的人，本轮不参与平分，他投进去的钱全部沉没；平票时持有最多的人出局。</div>
    <div class="seatgrid">${opts}</div>
    <div class="row">
      <button class="btn primary" id="btnVote">投给 TA</button>
      <button class="btn" id="btnAbstain">弃权</button>
      <span class="muted" id="voteProg"></span>
    </div>`);
  }
  document.querySelectorAll('#stage [data-v]').forEach(el => {
    el.classList.toggle('sel', el.dataset.v === selVote);
    const c = el.querySelector('[data-coin]');
    if (c) c.textContent = '持有 ' + (playerOf(el.dataset.v)?.coins ?? 0);
  });
  const done = hasActed();
  const bv = $('btnVote'); if (bv) { bv.disabled = done; bv.textContent = done ? '已投票' : '投给 TA'; }
  const p = $('voteProg'); if (p) p.textContent = `已投票 ${S.voteDone}/${S.config.seats}`;
}

// ---------------------------------------------------------------- 结算
function renderSettle(box) {
  const s = S.history[S.history.length - 1];
  const sig = 'settle:' + S.round;
  if (!s) { if (stageSkel(box, sig + ':wait')) stageSet(box, sig + ':wait', '<span class="muted">结算中…</span>'); return; }
  if (stageSkel(box, sig)) {
    const rows = S.players.map(p => `<tr><td>${esc(p.name)}</td><td>${s.holdings[p.id] == null ? '<span class="ex">✕</span>' : s.holdings[p.id]}</td></tr>`).join('');
    stageSet(box, sig, `
    <div class="row" style="font-size:15px">
      箱内 <b>${s.total}</b> × ${S.config.multiplier} → 每份 <b>${s.payout}</b>
    </div>
    <div class="muted">${s.excluded ? `${esc(nameOf(s.excluded))} 被投出，投入全部沉没，一分钱都拿不回来。` : '这一轮没有人被投出。'}</div>
    <div class="hist" style="margin-top:8px"><table><tr><th>席位</th><th>持有</th></tr>${rows}</table></div>
    <div class="hint">只公示持有数。但每个人都能算：非被投出者的投入 = 每份 − 持有变化。</div>`);
  }
}

// ---------------------------------------------------------------- 讨论（通话 / 赠与 / 公示）
function renderDiscuss(box) {
  const myCall = myCallOf();
  const pending = (S.calls || []).filter(c => (c.pending || []).includes(me));
  const c10 = myCoins();
  const pen = Number(S.config.giftRatingPenalty);
  const giftPenOn = pen > 0 && pen < 1;
  const giftPenPct = Math.round(pen * 100);
  const sig = 'discuss:' + S.round;

  if (stageSkel(box, sig)) {
    const others = S.players.filter(p => p.id !== me).map(p =>
      `<label style="font-size:12.5px;display:flex;gap:3px;align-items:center;min-width:0">
        <input type="checkbox" data-inv="${p.id}">${esc(p.name)}</label>`).join('');
    const giftOpts = S.players.filter(p => p.id !== me).map(p =>
      `<button class="seatbtn" data-g="${p.id}">
        <img class="av" src="${AV96(p.seat)}" alt="">${esc(p.name)}
        <div class="muted" data-coin="${p.id}">持有 ${p.coins}</div>
      </button>`).join('');
    const G0 = S.gifts || { mode: 'total' };
    const giftVisText = { full: '全公开', total: '只公示笔数与总额', secret: '完全不公示' }[G0.mode] || G0.mode;
    stageSet(box, sig, `
    <div class="muted">非议会制：没有公开发言，只能拉人进私密通话，最多 ${S.config.maxCallMembers} 人，对方可以拒绝。</div>
    <div id="discPending"></div>
    <h3 style="margin-top:10px">发起通话</h3>
    <div class="row" style="gap:4px" id="discInvite">${others}</div>
    <div class="row"><button class="btn primary sm" id="btnCall">发起密谈</button></div>
    <div id="discMembers" class="muted" style="margin-top:6px"></div>

    <h3 style="margin-top:14px">赠与金币</h3>
    <div class="muted">讨论期可以把金币私下送给任何人，数量自定。动机不限——慈善、行贿、结盟都行。</div>
    ${giftPenOn ? `<div class="hint" style="margin-top:6px">代价：收到你金币的人，终局给你的评分权重只剩 ${giftPenPct}%。折扣只看"送没送过"，跟金额无关——大额行贿反而先亏自己的权重。</div>` : ''}
    <div id="discGiftTip" class="muted" style="margin-top:4px"></div>
    <div class="seatgrid">${giftOpts}</div>
    <div class="row">
      <input type="number" id="giftNum" min="1" max="${c10}" value="${S._giftAmt ?? 1}" style="width:80px">
      <button class="btn sm" data-gq="0.1">10%</button>
      <button class="btn sm" data-gq="0.25">1/4</button>
      <button class="btn sm" data-gq="0.5">一半</button>
      <button class="btn sm" data-gq="1">全部</button>
      <span style="flex:1"></span>
      <button class="btn primary sm" id="btnGift" ${c10 < 1 ? 'disabled' : ''}>赠出</button>
    </div>
    <div class="muted" id="discMyCoins"></div>

    <h3 style="margin-top:12px">本轮转账公示（${giftVisText}）</h3>
    <div id="discGiftPub"></div>
    <div class="muted" id="discMyActs" style="margin-top:6px"></div>`);
  }

  // --- 动态部分（骨架不再重建，逐个节点更新）---
  const dp = $('discPending');
  if (dp) dp.innerHTML = pending.map(c => `<div class="row" style="margin:6px 0">
      <span class="muted">${esc(nameOf(c.members[0]))} 拉你密谈（${c.members.length} 人）</span>
      <button class="btn sm primary" data-acc="${c.id}">接</button>
      <button class="btn sm" data-ref="${c.id}">拒</button></div>`).join('');
  const dm = $('discMembers');
  if (dm) {
    if (myCall) {
      dm.className = 'call-note'; dm.style.marginTop = '6px';
      dm.innerHTML = `你在通话中：<b>${myCall.members.map(id => esc(nameOf(id))).join('、')}</b>　发言看左侧密谈频道。`;
    } else {
      dm.className = 'muted'; dm.style.marginTop = '6px';
      dm.textContent = '还没加入通话。左侧只能看历史记录。';
    }
  }
  document.querySelectorAll('#stage [data-g]').forEach(el => {
    el.classList.toggle('sel', el.dataset.g === giftTo);
    const c = el.querySelector('[data-coin]');
    if (c) c.textContent = '持有 ' + (playerOf(el.dataset.g)?.coins ?? 0);
  });
  const tip = $('discGiftTip');
  if (tip) {
    if (giftPenOn && giftTo) {
      const again = S.mySent && S.mySent[giftTo] > 0;
      tip.innerHTML = `选中 ${esc(nameOf(giftTo))}：赠出后，TA 给你打分的那张票权重降到 ${giftPenPct}%。${again ? '（你已经送过 TA 了，再送不会更亏，但也不会更划算）' : ''}`;
    } else tip.innerHTML = '';
  }
  const mc = $('discMyCoins');
  if (mc) mc.textContent = `你持有 ${c10} 枚${c10 < 1 ? '（没有金币可赠）' : ''}`;
  const gp = $('discGiftPub');
  if (gp) {
    const G = S.gifts || { mode: 'total', count: 0, total: 0, list: [] };
    gp.innerHTML =
      G.mode === 'full'
        ? (G.list.length ? G.list.map(x => `<div class="muted">${esc(nameOf(x.from))} → ${esc(nameOf(x.to))} ${x.amount} 枚</div>`).join('') : '<span class="muted">本轮还没有转账</span>')
        : G.mode === 'secret'
          ? '<span class="muted">转账不公示，只能从各人持有数的变化里猜</span>'
          : `<span class="muted">本轮发生 ${G.count} 笔转账，总额 ${G.total} 枚（对象与金额不公示）</span>`;
  }
  const ma = $('discMyActs');
  if (ma) {
    const a = [];
    if (myGifts.length) a.push(`已赠出：${myGifts.map(x => `${esc(nameOf(x.to))} ${x.amount}`).join('，')}`);
    if (recvGifts.length) a.push(`收到：${recvGifts.map(x => `${esc(x.fromName)} ${x.amount}`).join('，')}`);
    ma.textContent = a.join('　｜　');
  }
}
function doCall() {
  const list = [...inviteSel];
  if (!list.length) return toast('先勾选要邀请的人');
  inviteSel.clear();
  document.querySelectorAll('#stage [data-inv]').forEach(c => c.checked = false);
  send({ type: 'call:create', invite: list });
}
function doGift() {
  const c = myCoins();
  if (!giftTo) return toast('先选一个人');
  const el = $('giftNum');
  const amt = _clamp(1, c, Math.round(+el.value || 0));
  if (amt < 1 || amt > c) return toast('数量不合法');
  send({ type: 'gift', to: giftTo, amount: amt });
  myGifts.push({ to: giftTo, amount: amt });
  S._giftAmt = 1;
  flyCoins(seatEl(me), seatEl(giftTo), amt, { max: 6, fade: false });
  const tgt = seatEl(giftTo);
  if (tgt && tgt.parentElement) {
    tgt.parentElement.classList.add('bump');
    setTimeout(() => tgt.parentElement.classList.remove('bump'), 520);
  }
  toast(`已赠给 ${nameOf(giftTo)} ${amt} 枚`);
}
function setGiftRatio(q) {
  const c = myCoins();
  S._giftAmt = Math.max(1, Math.min(c, Math.round(c * q)));
  const el = $('giftNum'); if (el) el.value = S._giftAmt;
}

// ---------------------------------------------------------------- 打分
function renderScoring(box) {
  if (!Object.keys(ratings).length) for (const p of S.players) ratings[p.id] = 3;
  const pen = Number(S.config.giftRatingPenalty);
  const on = pen > 0 && pen < 1;
  const recv = S.myRecv || {};
  const sig = 'scoring:' + S.round;
  if (stageSkel(box, sig)) {
    const rows = S.players.map(p => {
      const got = recv[p.id] || 0;
      const tag = (on && got > 0 && p.id !== me)
        ? `<span class="pill warn" title="TA 赠过你金币，你的评分权重打 ${Math.round(pen * 100)}%">收过 ${got}</span>` : '';
      return `<div class="rate"><span class="nm"><img src="${AV96(p.seat)}" alt="">${esc(p.name)}</span>
        <span class="muted" data-coin="${p.id}">${p.coins}</span>${tag}
        <span class="stars">${[1, 2, 3, 4, 5].map(v =>
          `<button class="star" data-r="${p.id}" data-v="${v}">${v}</button>`).join('')}</span></div>`;
    }).join('');
    stageSet(box, sig, `
    <div class="muted">给所有人打分，包括你自己。最终分 = 这些评分按「打分人的金币占比」加权平均。</div>
    <div id="rateTip" class="muted"></div>
    <div style="margin:8px 0">${rows}</div>
    <div class="row"><button class="btn primary" id="btnRate">提交评分</button>
      <span class="muted" id="rateProg"></span></div>`);
  }
  document.querySelectorAll('#stage [data-r]').forEach(el => {
    el.classList.toggle('on', ratings[el.dataset.r] === +el.dataset.v);
  });
  document.querySelectorAll('#stage .rate [data-coin]').forEach(el => {
    el.textContent = playerOf(el.dataset.coin)?.coins ?? 0;
  });
  const tip = $('rateTip');
  if (tip && on) tip.textContent = `买来的票打折：你收过 ${Object.keys(recv).length} 个人的金币，你给他们的评分权重只有 ${Math.round(pen * 100)}%。`;
  const rp = $('rateProg'); if (rp) rp.textContent = `已提交 ${S.ratingDone}/${S.config.seats}`;
  const done = hasActed();
  const br = $('btnRate'); if (br) { br.disabled = done; br.textContent = done ? '已提交' : '提交评分'; }
}

// ---------------------------------------------------------------- 阶段面板事件委托
// 只挂一次：骨架重建也不会丢监听，还省掉每次 render 的重复绑定
function bindStage() {
  const box = $('stage'); if (!box) return;
  box.addEventListener('click', e => {
    const t = e.target.closest('button');
    if (!t || !S) return;
    if (t.dataset.q !== undefined) return setInvestAmount(invMax() * parseFloat(t.dataset.q));
    if (t.dataset.gq !== undefined) return setGiftRatio(parseFloat(t.dataset.gq));
    if (t.dataset.r !== undefined) { ratings[t.dataset.r] = +t.dataset.v; renderStage(); return; }
    if (t.dataset.v !== undefined) { selVote = t.dataset.v; renderStage(); return; }
    if (t.dataset.g !== undefined) { giftTo = t.dataset.g; renderStage(); return; }
    if (t.dataset.acc) return send({ type: 'call:respond', callId: t.dataset.acc, accept: true });
    if (t.dataset.ref) return send({ type: 'call:respond', callId: t.dataset.ref, accept: false });
    if (t.id === 'btnInv') return doInvest();
    if (t.id === 'btnVote') {
      if (!selVote) return toast('先选一个人');
      send({ type: 'vote', target: selVote }); markActed();
      const b = $('btnVote'); if (b) { b.disabled = true; b.textContent = '已投票'; }
      return;
    }
    if (t.id === 'btnAbstain') { send({ type: 'vote', target: null }); markActed(); return; }
    if (t.id === 'btnCall') return doCall();
    if (t.id === 'btnGift') return doGift();
    if (t.id === 'btnRate') {
      send({ type: 'rate', ratings }); markActed();
      const b = $('btnRate'); if (b) { b.disabled = true; b.textContent = '已提交'; }
      return;
    }
  });
  box.addEventListener('input', e => {
    const t = e.target; if (!S) return;
    if (t.id === 'invRange') return setInvestAmount(+t.value, t);
    if (t.id === 'invNum') return setInvestAmount(+t.value, t);
    if (t.id === 'giftNum') { S._giftAmt = Math.max(1, Math.min(myCoins(), Math.round(+t.value || 1))); }
  });
  box.addEventListener('change', e => {
    const t = e.target; if (!S) return;
    if (t.dataset.inv !== undefined) {
      t.checked ? inviteSel.add(t.dataset.inv) : inviteSel.delete(t.dataset.inv);
    }
  });
}

// ---------------------------------------------------------------- 输入保护
// 大厅和建房页都是「整块 innerHTML 重建」的画法。重建一次，正在进行的输入就废一次：
// 值被冲回服务端那份、光标丢失、中文输入法打到一半的组合也会被掐断。
// 所以每次重建前后都要把「用户改过的值」和「焦点 / 光标位置」原样搬回去。
//
// 判断「用户改过」靠 _v0：渲染结束时给每个输入框记一份基线值，
// 重建时只有偏离基线的字段才回填 —— 这样别人改了配置、服务端推来的新值不会被本地旧值盖掉。
// 选择器转义：只用在属性值里，转义引号和反斜杠就够了（jsdom 里没有 CSS.escape）
function cssEsc(s) { return String(s).replace(/["\\]/g, m => '\\' + m); }
function inputKey(n) {
  if (n.id) return '#' + n.id;
  for (const a of ['nm', 'kind', 'base', 'key', 'model']) {
    if (n.dataset[a]) return `[data-${a}="${cssEsc(n.dataset[a])}"]`;
  }
  return '';
}
function markInputs(root) {
  root.querySelectorAll('input, select, textarea').forEach(n => { n._v0 = n.value; n._c0 = !!n.checked; });
}
function snapshotInputs(root) {
  const fields = [];
  root.querySelectorAll('input, select, textarea').forEach(n => {
    const k = inputKey(n); if (!k) return;
    const toggler = (n.type === 'checkbox' || n.type === 'radio');
    // _dirty = 上一轮重建时判定过的"用户还没提交的改动"。只看值差会漏：
    // 回填之后值就等于基线了，第二次重建会把它当成没动过而丢掉。
    if (n._dirty || (toggler ? (!!n.checked !== !!n._c0) : (n.value !== n._v0))) {
      fields.push({ k, value: n.value, checked: !!n.checked });
    }
  });
  let sel = null;
  const act = document.activeElement;
  if (act && root.contains(act)) {
    const k = inputKey(act);
    if (k) {
      let s = null, e = null;
      try { s = act.selectionStart; e = act.selectionEnd; } catch {}   // number/checkbox 读光标会抛
      sel = { k, s, e };
    }
  }
  return { fields, sel };
}
function restoreInputs(root, snap) {
  markInputs(root);                 // 基线先按服务端这份值建好，回填不会污染它
  if (!snap) return;
  for (const f of snap.fields) {
    let n = null; try { n = root.querySelector(f.k); } catch {}
    if (!n) continue;
    const toggler = (n.type === 'checkbox' || n.type === 'radio');
    const before = toggler ? n.checked : n.value;      // 服务端这次给的值
    if (toggler) n.checked = f.checked; else n.value = f.value;
    // 回填后若跟服务端这份不同，说明用户还有没提交的改动，往后每次重建都继续保住它；
    // 改回跟服务端一样了就解除，之后乖乖跟着服务端走。
    n._dirty = (before !== (toggler ? n.checked : n.value));
  }
  if (snap.sel) {
    let n = null; try { n = root.querySelector(snap.sel.k); } catch {}
    if (n) {
      try { n.focus({ preventScroll: true }); } catch {}
      if (snap.sel.s != null) { try { n.setSelectionRange(snap.sel.s, snap.sel.e); } catch {} }
    }
  }
  markInputs(root);
}

// ---------------------------------------------------------------- 房间大厅（未进房时的全屏浮层）
// 建房 / 从网络房间列表里挑一个加入 / 密码房输口令
function renderHall() {
  const box = $('lobby'); if (!box) return;
  const snap = snapshotInputs(box);
  const _roomsHtml = hallRoomsHtml();
  document.body.classList.add('overlay-on');
  box.style.display = '';

  box.innerHTML = `<div class="card">
    <h2 style="font-size:18px;margin-bottom:2px">公共财博弈 · 房间大厅</h2>
    <div class="muted">游戏跑在你这台机器上：规则、AI、发牌全在本地算。别人想一起玩，得自己装上客户端，
      再用「房号」从互联网进来 —— 中继只负责牵线，不含任何游戏内容。</div>

    <h3 style="margin-top:12px">网络联机</h3>
    <div class="row" style="gap:10px">
      <span id="hallRelay">${relayStateHtml()}</span>
      我的昵称<input type="text" id="nickName" maxlength="12" value="${esc(NICK)}" style="width:120px">
    </div>

    <h3 style="margin-top:12px">新建房间</h3>
    <div class="row">
      房间名<input type="text" id="hallName" maxlength="20" placeholder="例如：阿伟的房间" style="width:170px">
      密码（可留空）<input type="password" id="hallPwd" maxlength="32" placeholder="设了别人要输密码才能进" style="width:190px">
    </div>
    <div class="row">
      席位<input type="number" id="hallSeats" value="10" min="2" max="12" style="width:60px">
      轮次<input type="number" id="hallRounds" value="6" min="1" max="12" style="width:60px">
      倍数M<input type="number" id="hallM" value="2" min="1" max="50" style="width:60px">
      <label style="font-size:13px;display:flex;gap:5px;align-items:center">
        <input type="checkbox" id="hallPublic" checked>开放到网络（别人用房号加入）</label>
      <button class="btn primary" id="btnHallCreate">创建房间</button>
    </div>

    <h3 style="margin-top:12px">用房号加入</h3>
    <div class="row">
      <input type="text" id="hallRoomId" maxlength="8" placeholder="例如：A6ND" style="width:140px">
      <button class="btn sm" id="btnJoinById">加入</button>
      <span class="muted">开房的人把 4 位房号发给你，输入即可入座</span>
    </div>

    <h3 style="margin-top:12px">现有房间（<span id="hallRoomCount">${ROOMS.length}</span>）</h3>
    <div id="hallRoomList">${_roomsHtml}</div>

    <div class="hint">十个人围坐一张桌子，每轮把金币投进中间那只箱子。箱内总额翻倍后全员平分 —— 不投的人照样分红。合作只能靠投票、赠与和密谈逼出来。</div>
  </div>`;
  const _hl = box.querySelector('#hallRoomList'); if (_hl) _hl._html = _roomsHtml;
  restoreInputs(box, snap);
}

function relayStateHtml() {
  return RELAY_UP
    ? `<span class="pill">已连中继</span><span class="muted">列表里带「网络」的房间来自互联网，挑一个进去就行。</span>`
    : `<span class="pill">未连接</span><span class="muted">现在只能玩本机房间（单机 / AI 对局）。中继连上后会自动出现网络房间。</span>`;
}

// 房间列表单独成块：定时刷新只换这一块，建房/房号那些输入框根本不碰
function hallRoomsHtml() {
  const rows = ROOMS.map(r => {
    if (passFor && passFor === r.id) {
      return `<tr><td colspan="5">
        <div class="row">进入「${esc(r.name)}」需要密码
          <input type="password" id="hallPass" placeholder="房间密码" style="width:140px">
          <button class="btn sm primary" id="btnHallPass" data-room="${esc(r.id)}">进入</button>
          <button class="btn sm" id="btnHallPassCancel">取消</button></div>
      </td></tr>`;
    }
    const st = r.playing ? `进行中 · 第 ${r.round} 轮`
      : (r.phase === 'over' ? '已结束 · 可回看战报' : '等待开始');
    return `<tr>
      <td><b>${esc(r.id)}</b>${r.online ? ' <span class="pill">网络</span>' : ' <span class="pill">本机</span>'}</td>
      <td>${esc(r.name)}${r.locked ? ' <span class="pill">密码</span>' : ''}</td>
      <td>${r.humans}/${r.seats} 人${r.watchers ? ` · ${r.watchers} 观战` : ''}</td>
      <td>${st}</td>
      <td><button class="btn sm" data-join="${esc(r.id)}" data-locked="${r.locked ? '1' : ''}">加入</button></td>
    </tr>`;
  }).join('');
  return ROOMS.length
    ? `<div class="scroll"><table class="cfg">
        <tr><th>房号</th><th>房间名</th><th>人数</th><th>状态</th><th></th></tr>${rows}</table></div>`
    : '<div class="muted">现在一个房间都没有。上面建一个，或者让开房的人把房号发给你。</div>';
}

// 每 5 秒一次的房间列表刷新走这里：只更新列表块，且内容没变就完全不动
function renderHallRooms() {
  const box = $('lobby'); if (!box) return;
  const host = box.querySelector('#hallRoomList');
  if (!host) { renderHall(); return; }          // 大厅还没渲染过，走全量
  const rs = box.querySelector('#hallRelay');    // 中继连通性不在列表块里，单独刷
  if (rs) { const h = relayStateHtml(); if (rs.innerHTML !== h) rs.innerHTML = h; }
  const html = hallRoomsHtml();
  if (html === host._html) return;               // 列表没变就一个字都不动
  const snap = snapshotInputs(host);
  host._html = html;
  host.innerHTML = html;
  restoreInputs(host, snap);
  const c = box.querySelector('#hallRoomCount'); if (c) c.textContent = ROOMS.length;
}

function createRoom() {
  const name = ($('hallName')?.value || '').trim();
  const password = ($('hallPwd')?.value || '').trim();
  roomPublic = !!$('hallPublic')?.checked;
  send({ type: 'room:create',
    name: name || '我的房间',
    password: password || '',
    host: name || '',
    public: !!$('hallPublic')?.checked,          // 勾了才会登记到中继让别人用房号进来
    config: {
      seats: +($('hallSeats')?.value || 10),
      rounds: +($('hallRounds')?.value || 6),
      multiplier: +($('hallM')?.value || 2),
    } });
}
function joinRoom(id, locked) {
  saveNick();
  if (locked) { passFor = id; renderHall(); return; }
  send({ type: 'room:join', roomId: id, name: NICK });
}
function submitRoomPass(id) {
  const v = $('hallPass')?.value || '';
  if (!v) return toast('请输入密码');
  saveNick();
  send({ type: 'room:join', roomId: id, password: v, name: NICK });
}
function joinById() {
  const id = ($('hallRoomId')?.value || '').trim().toUpperCase();
  if (!id) return toast('请先填房号');
  saveNick();
  send({ type: 'room:join', roomId: id, name: NICK });
}
function saveNick() {
  const v = ($('nickName')?.value || '').trim();
  NICK = v || '玩家';
  try { localStorage.setItem('pgg_nick', NICK); } catch {}
}

// ---------------------------------------------------------------- 建房（全屏浮层）
function renderOverlay() {
  const el = $('lobby'); if (!el) return;
  if (S.phase === 'over') {
    // 哪怕战报还没送过来，也绝不能把建房页摆出来 —— 玩家会当成"没结算成功"顺手点
    // "开始游戏"，一局就这么被顶掉了
    if (S.result) return renderResult(el);
    el.style.display = '';
    el.innerHTML = `<div class="card"><h2>本局已结束</h2>
      <div class="muted">正在生成最终战报…</div></div>`;
    return;
  }
  return renderLobby(el);
}

function renderLobby(box) {
  const snap = snapshotInputs(box);   // 服务端推状态会重建这块，别把改了一半的配置冲掉
  const c = S.config;
  let rows = '';
  for (const p of S.players) {
    rows += `<tr>
      <td>${p.seat + 1}</td>
      <td><input type="text" data-nm="${p.id}" value="${esc(p.name)}" style="width:72px"></td>
      <td><select data-kind="${p.id}">
        <option value="human"${p.kind === 'human' ? ' selected' : ''}>真人</option>
        <option value="local"${p.kind === 'local' ? ' selected' : ''}>本地策略</option>
        <option value="api"${p.kind === 'api' ? ' selected' : ''}>云端API</option>
      </select></td>
      <td><input type="text" data-base="${p.id}" value="${esc(p.api.baseUrl || '')}" placeholder="https://.../v1"></td>
      <td><input type="password" data-key="${p.id}" value="${esc(p.api.apiKey || '')}" placeholder="sk-..."></td>
      <td><input type="text" data-model="${p.id}" value="${esc(p.api.model || '')}" placeholder="模型名" style="width:110px"></td>
    </tr>`;
  }
  const humans = S.players.filter(p => p.connected).map(p => esc(p.name));
  box.style.display = '';
  box.innerHTML = `<div class="card">
    <div class="row" style="justify-content:space-between;align-items:baseline">
      <h2 style="font-size:18px;margin-bottom:2px">房间 <b>${esc(ROOM_ID)}</b>${roomName ? ` · ${esc(roomName)}` : ''} · 建房${roomLocked ? ' <span class="pill">密码房</span>' : ''}</h2>
      <button class="btn sm" id="btnLeaveRoom" title="退回房间大厅，房间保留">离开房间</button>
    </div>
    <div class="muted">十个人围坐一张桌子，每轮把金币投进中间那只箱子。箱内总额翻倍后全员平分 —— 不投的人照样分红。</div>

    <h3 style="margin-top:12px">我的位置</h3>
    <div class="row" style="gap:14px">
      <label style="font-size:13px;display:flex;gap:5px;align-items:center">
        <input type="radio" name="myrole" id="rolePlay" ${myRole === 'play' ? 'checked' : ''}>亲自上场（坐 1 号席位）</label>
      <label style="font-size:13px;display:flex;gap:5px;align-items:center">
        <input type="radio" name="myrole" id="roleWatch" ${myRole === 'watch' ? 'checked' : ''}>只看不玩（观战位）</label>
      <button class="btn sm" id="btnAllAI">十席全交给 AI</button>
      <span class="muted">${myRole === 'watch'
        ? '观战位：十席全部由 AI 自动博弈，你能听见所有密谈，但不能插手。'
        : '你坐 1 号席位，其余九席由 AI 接管；想先看几局摸清套路就切到观战位。'}</span>
    </div>

    <h3 style="margin-top:10px">联机（用房号邀请）</h3>
    <div class="row">
      <input type="text" id="inviteUrl" readonly value="${inviteUrl()}" style="width:140px;font-weight:700;letter-spacing:2px">
      <button class="btn sm" id="btnCopy">复制房号</button>
      <button class="btn sm" id="btnNewRoom">换个房间</button>
      <span class="muted">${roomPublic
        ? '这个房间已经开放到网络：朋友装上客户端、在房间大厅输入这个房号就能入座。'
        : '这个房间没有开放到网络（建房时没勾选），暂时只有你自己能进。'}</span>
    </div>
    <div class="muted">房间 <b>${ROOM_ID}</b> · 已入座的真人：${humans.length ? humans.join('、') : '（只有你）'}</div>
    <div class="row">
      席位<input type="number" id="cfgSeats" class="narrow" value="${c.seats}" min="2" max="12" style="width:60px">
      轮次<input type="number" id="cfgRounds" value="${c.rounds}" min="1" max="12" style="width:60px">
      倍数M<input type="number" id="cfgM" value="${c.multiplier}" min="1" max="50" style="width:60px">
      每轮上限<input type="number" id="cfgCap" value="${c.maxInvestPerRound}" min="0" max="999" style="width:64px" title="0 表示不限制，可投入 0~当前持有">
      投票门槛<input type="number" id="cfgVT" value="${c.voteThreshold}" min="2" max="12" style="width:60px">
      获胜名额<input type="number" id="cfgTopW" value="${c.topWinners}" min="1" max="12" style="width:60px">
    </div>
    <div class="row">
      投资秒<input type="number" id="cfgI" value="${c.investSeconds}" style="width:60px">
      投票秒<input type="number" id="cfgV" value="${c.voteSeconds}" style="width:60px">
      讨论秒<input type="number" id="cfgD" value="${c.discussSeconds}" style="width:60px">
      结算秒<input type="number" id="cfgS" value="${c.settleSeconds}" style="width:60px">
    </div>
    <div class="row">
      赠与公示
      <select id="cfgGiftV">
        <option value="full"${c.giftVisibility === 'full' ? ' selected' : ''}>全公开（谁给谁多少）</option>
        <option value="total"${c.giftVisibility === 'total' ? ' selected' : ''}>只公示笔数与总额</option>
        <option value="secret"${c.giftVisibility === 'secret' ? ' selected' : ''}>完全不公示</option>
      </select>
      <span class="muted">每轮上限填 0 = 可投入 0 ~ 当前持有</span>
    </div>
    <div class="row">
      赠与减权
      <select id="cfgGiftPen">
        <option value="1"${Number(c.giftRatingPenalty) >= 1 ? ' selected' : ''}>关闭（送钱不影响评分权重）</option>
        <option value="0.8"${Math.abs(Number(c.giftRatingPenalty) - 0.8) < 0.01 ? ' selected' : ''}>打 80%（默认）</option>
        <option value="0.65"${Math.abs(Number(c.giftRatingPenalty) - 0.65) < 0.01 ? ' selected' : ''}>打 65%（行贿基本失效）</option>
        <option value="0.5"${Math.abs(Number(c.giftRatingPenalty) - 0.5) < 0.01 ? ' selected' : ''}>打 50%（重罚）</option>
      </select>
      <span class="muted">收到你钱的人，给你打分时他的权重打这个折</span>
    </div>
    <h3 style="margin-top:12px">席位（本地策略=离线可玩；云端API=OpenAI 兼容格式）</h3>
    <div class="scroll"><table class="cfg">
      <tr><th>#</th><th>名字</th><th>类型</th><th>baseUrl</th><th>API Key</th><th>模型</th></tr>
      ${rows}
    </table></div>
    <div class="row" style="margin-top:10px">
      <button class="btn primary" id="btnStart">开始游戏</button>
      <span class="muted">所有人初始 ${S.players[0]?.coins ?? 10} 金币 · 前 ${c.topWinners} 名获胜</span>
    </div>
    <div class="hint">终局计分：你的最终分 = 所有人给你的评分，按「打分人的金币占比」加权平均（1~5 分）。金币越多的人，他的评价权重越大。</div>
  </div>`;
  restoreInputs(box, snap);
}

function pushConfig() {
  const players = S.players.map(p => ({
    name: document.querySelector(`[data-nm="${p.id}"]`)?.value || p.name,
    kind: document.querySelector(`[data-kind="${p.id}"]`)?.value || p.kind,
    api: {
      baseUrl: document.querySelector(`[data-base="${p.id}"]`)?.value || '',
      apiKey: document.querySelector(`[data-key="${p.id}"]`)?.value || '',
      model: document.querySelector(`[data-model="${p.id}"]`)?.value || '',
    },
  }));
  send({ type: 'config', config: {
    seats: +$('cfgSeats').value, rounds: +$('cfgRounds').value, multiplier: +$('cfgM').value,
    voteThreshold: +$('cfgVT').value, investSeconds: +$('cfgI').value,
    voteSeconds: +$('cfgV').value, discussSeconds: +$('cfgD').value,
    settleSeconds: +$('cfgS').value, players,
    maxInvestPerRound: +$('cfgCap').value, giftVisibility: $('cfgGiftV').value,
    topWinners: +$('cfgTopW').value, giftRatingPenalty: +$('cfgGiftPen').value,
  } });
}
// ---------------------------------------------------------------- 结果
let _resultShownAt = 0;
// 战报卡片：终局浮层与"上局战报"回看共用同一段
function resultCardHtml(r) {
  const pen = Number(r.giftRatingPenalty);
  const on = pen > 0 && pen < 1;
  const pod = r.ranked.slice(0, 3).map(x => `<div class="pod ${x.rank === 1 ? 'p1' : ''}">
      <img src="${AV(x.seat)}" alt="">
      <div class="pn">${x.rank}. ${esc(x.name)}</div>
      <div class="pc">${CI(16)}${x.coins} · ${x.score.toFixed(2)} 分</div></div>`).join('');
  const rows = r.ranked.map(x => {
    const disc = x.discountedBy > 0
      ? `<span class="pill warn" title="${x.discountedBy} 张票因赠与被打折">票权 ${(x.effWeight * 100).toFixed(1)}%</span>`
      : '';
    return `
    <div class="rank ${x.win ? 'win' : ''}">
      <span class="no">${x.rank}</span>
      <span class="nm"><img src="${AV96(x.seat)}" alt="">${esc(x.name)}</span>
      <span class="muted">${CI(16)}${x.coins} · 权重 ${(x.weight * 100).toFixed(1)}%</span>
      ${disc}
      <b>${x.score.toFixed(2)}</b>
      ${x.win ? '<span class="pill">获胜</span>' : ''}
    </div>`;
  }).join('');
  return `<div class="result-head">
      <div class="over-flag">本局已结束</div>
      <h2>最终结果</h2>
      <div class="muted">总盘 ${r.totalCoins} 金币 · 计分 = Σ(打分人金币占比 × 他给你的分)${on ? ` × ${Math.round(pen * 100)}%（若你曾赠与他）` : ''}</div>
    </div>
    <div class="podium">${pod}</div>
    <div style="margin:10px 0">${rows}</div>`;
}

// 战报留档：哪怕玩家手滑开了新局，这份也还能翻回来
let lastResult = null, _showingLast = false;
function showLastResult() {
  if (!lastResult) return toast('还没有上一局的战报');
  const el = $('lobby'); if (!el) return;
  _showingLast = true;
  el.style.display = '';
  el.innerHTML = `<div class="card">${resultCardHtml(lastResult)}
    <div class="row"><button class="btn primary" id="btnCloseLast">关闭</button>
      <span class="muted">这是上一局的存档战报，新一局不受影响</span></div></div>`;
}
function closeLastResult() {
  _showingLast = false;
  const el = $('lobby'); if (!el) return;
  if (S && (S.phase === 'lobby' || S.phase === 'over')) return;   // 那两种状态自有浮层
  el.style.display = 'none';
}

function renderResult(box) {
  const r = S.result;
  box.style.display = '';
  _resultShownAt = Date.now();
  box.innerHTML = `<div class="card">
    ${resultCardHtml(r)}
    <div class="row"><button class="btn primary" id="btnAgain">再来一局</button>
      <span class="muted">开新一局不会丢这份战报（可随时回看），但要点两次确认</span></div>
  </div>`;
}

// 「再来一局」两步走：结果页刚出来的 1.2 秒内一律不接受，且第一次点击只做确认。
// 起因：玩家最后一次操作（提交评分）的连击第二下会穿透到结果页的按钮上，
// 结果页连露脸的机会都没有就开了新一局。
function onAgainClick(btn) {
  if (Date.now() - _resultShownAt < 1200) return toast('结果页刚出来，缓一秒再点');
  if (btn.dataset.armed !== '1') {
    btn.dataset.armed = '1';
    btn.textContent = '再点一次，确认开新局';
    toast('战报会被清空：再点一次才真的开新一局');
    clearTimeout(btn._t);
    btn._t = setTimeout(() => {
      btn.dataset.armed = ''; btn.textContent = '再来一局';
    }, 5000);
    return;
  }
  clearTimeout(btn._t);
  resetLocal(); send({ type: 'start' });
}

function resetLocal() {
  ratings = {}; callMsgs = {}; archive = []; spy = []; acted = {};
  myGifts = []; recvGifts = []; giftTo = null; selVote = null; inviteSel.clear();
  _lastHistN = 0; _lastRound = -1; _showingLast = false;
  // 注意 lastResult 不清：上一局战报要留到新局里还能回看
}

// 调试钩子：Electron 截图/自动化可以 executeJavaScript 取到最新状态
window.__S = () => S;

// ---------------------------------------------------------------- 顶栏按钮
const _bs = $('btnSkip'), _br = $('btnReset');
if (_bs) _bs.onclick = () => send({ type: 'skip' });
if (_br) _br.onclick = () => { resetLocal(); send({ type: 'reset' }); };
bindTabs();
bindStage();
// 停在大厅时定期刷新房间列表：别人建房 / 房间散了都要能看见
setInterval(() => { if (!inRoom) send({ type: 'rooms:list' }); }, 5000);
// 结果浮层/建房浮层的按钮
document.addEventListener('click', e => {
  const t = e.target.closest('button'); if (!t) return;
  if (t.id === 'btnStart') { pushConfig(); send({ type: 'start' }); }
  if (t.id === 'btnAgain') return onAgainClick(t);
  if (t.id === 'btnLastResult') return showLastResult();
  if (t.id === 'btnCloseLast') return closeLastResult();
  if (t.id === 'btnCopy') return copyInvite(false);
  if (t.id === 'btnCopyWatch') return copyInvite(true);
  if (t.id === 'btnNewRoom') return newRoom();
  if (t.id === 'btnAllAI') return allAI();
  if (t.id === 'btnHallCreate') return createRoom();
  if (t.id === 'btnHallPass') return submitRoomPass(t.dataset.room);
  if (t.id === 'btnHallPassCancel') { passFor = null; return renderHall(); }
  if (t.id === 'btnLeaveRoom') return send({ type: 'room:leave' });
  if (t.id === 'btnJoinById') return joinById();
  if (t.dataset && t.dataset.join) return joinRoom(t.dataset.join, !!t.dataset.locked);
});
document.addEventListener('change', e => {
  const t = e.target;
  if (t.id === 'rolePlay' && t.checked) return setRole('play');
  if (t.id === 'roleWatch' && t.checked) return setRole('watch');
});
