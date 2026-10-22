// 前端渲染验证：用 jsdom 真跑 app.js，逐阶段检查界面是否正确渲染、有无运行时报错
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import * as E from '../server/engine.js';
import * as AI from '../server/ai.js';

let fail = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fail++; };

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const appJs = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

// 构造一个"第 3 轮投资中"的真实房间状态
function buildState(phase) {
  const st = E.createRoom({ rounds: 6, multiplier: 10, maxInvestPerRound: 10 });
  for (let r = 1; r <= 3; r++) {
    E.beginInvest(st);
    for (const p of st.players) E.submitInvestment(st, p.id, AI.localInvest(st, p));
    if (r > 1) { E.beginVote(st); for (const p of st.players) E.submitVote(st, p.id, AI.localVote(st, p)); }
    E.settleRound(st);
    E.beginDiscuss(st);
  }
  if (phase === 'scoring' || phase === 'over') {
    E.beginScoring(st);
    for (const p of st.players) E.submitRating(st, p.id, AI.localRating(st, p));
    if (phase === 'over') E.finalize(st);
  } else {
    st.phase = phase; st.phaseEndsAt = Date.now() + 30000;
  }
  return E.publicState(st);
}

function boot(state) {
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:8787/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const errs = [];
  w.addEventListener('error', e => errs.push(e.message));
  const sent = [];
  class FakeWS {
    constructor() { this.onopen = null; this.onmessage = null; }
    send(s) { sent.push(JSON.parse(s)); }
    close() {}
  }
  w.WebSocket = FakeWS;
  w.eval(appJs);
  const ws = null;
  // 模拟服务端推送：hello -> joined -> state
  return { dom, w, errs, sent,
    push(obj) { const inst = w.__ws; inst.onmessage({ data: JSON.stringify(obj) }); } };
}

// app.js 里 WebSocket 实例是模块内私有的，这里用一个可抓取的包装
const patched = appJs.replace('ws = new WebSocket(serverWsUrl());',
  'ws = new WebSocket(serverWsUrl()); window.__ws = ws;');

function boot2(state) {
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:8787/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const errs = [];
  w.onerror = (m) => errs.push(String(m));
  const sent = [];
  class FakeWS {
    constructor() { setTimeout(() => this.onopen && this.onopen(), 0); }
    send(s) { sent.push(JSON.parse(s)); }
    close() {}
  }
  w.WebSocket = FakeWS;
  try { w.eval(patched); } catch (e) { errs.push('eval: ' + e.message); }
  const inst = w.__ws;
  inst.onmessage({ data: JSON.stringify({ type: 'hello', roomId: 'R1', state }) });
  inst.onmessage({ data: JSON.stringify({ type: 'joined', pid: 'p1' }) });
  inst.onmessage({ data: JSON.stringify({ type: 'state', state }) });
  return { dom, w, errs, sent, inst };
}

const $ = (w, id) => w.document.getElementById(id);

console.log('\n[UI-1] 建房界面（lobby）');
{
  const st = E.publicState(E.createRoom({}));
  const { w, errs } = boot2(st);
  const t = $(w, 'lobby').textContent;
  ok(errs.length === 0, '脚本无运行时报错' + (errs.length ? '：' + errs[0] : ''));
  ok(t.includes('建房'), '渲染出建房浮层');
  ok(t.includes('倍数M') && t.includes('每轮上限'), '倍数与每轮上限可调');
  ok(w.document.querySelectorAll('[data-kind]').length === 10, '10 个席位都可配置类型');
  ok(w.document.querySelectorAll('[data-base]').length === 10, '每个席位都有 API 接口输入框');
  ok($(w, 'seats').textContent.includes('席位1'), '席位列表渲染出来');
}

console.log('\n[UI-2] 投资阶段');
{
  const { w, errs } = boot2(buildState('invest'));
  const t = $(w, 'stagePanel').textContent;
  ok(errs.length === 0, '无运行时报错' + (errs.length ? '：' + errs[0] : ''));
  ok(t.includes('投资'), '渲染投资面板（含标题）');
  ok(!!$(w, 'invRange') && !!$(w, 'btnInv'), '有滑块与提交按钮');
  ok($(w, 'invRange').getAttribute('max') === '10', '投入上限被正确限制为 10');
  ok(w.document.querySelector('.top').textContent.includes('投资'), '顶栏显示当前阶段');
}

console.log('\n[UI-3] 投票阶段');
{
  const { w, errs } = boot2(buildState('vote'));
  const t = $(w, 'stagePanel').textContent;
  ok(errs.length === 0, '无运行时报错' + (errs.length ? '：' + errs[0] : ''));
  ok(t.includes('投票'), '渲染投票面板');
  ok(w.document.querySelectorAll('[data-v]').length === 10, '10 个可选投票对象');
  ok(t.includes('≥6 票'), '显示 6 票门槛');
}

console.log('\n[UI-4] 讨论阶段');
{
  const { w, errs } = boot2(buildState('discuss'));
  const t = $(w, 'stagePanel').textContent;
  ok(errs.length === 0, '无运行时报错' + (errs.length ? '：' + errs[0] : ''));
  ok(t.includes('自由讨论'), '渲染讨论面板');
  ok(w.document.querySelectorAll('[data-inv]').length === 9, '可邀请其余 9 人');
  ok(t.includes('非议会制'), '标明了非议会制规则');
  ok($(w, 'callCard').style.display !== 'none', '私密频道面板已显示');
  // 赠与面板
  ok(w.document.querySelectorAll('[data-g]').length === 9, '赠与面板有其余 9 个可选对象');
  ok(!!$(w, 'giftNum') && !!$(w, 'btnGift'), '有数量输入框与赠出按钮');
  ok(t.includes('赠与金币'), '标明了赠与规则');
  ok(t.includes('本轮转账公示'), '有本轮转账公示区');
}

console.log('\n[UI-4b] 赠与交互');
{
  const { w, errs, sent } = boot2(buildState('discuss'));
  w.document.querySelector('[data-g="p3"]').click();
  $(w, 'giftNum').value = '5';
  $(w, 'btnGift').click();
  const g = sent.find(m => m.type === 'gift');
  ok(!!g, '点击赠出会发出 gift 指令');
  ok(g && g.to === 'p3' && g.amount === 5, '指令里带上受赠人与数量（p3 / 5）');
  ok(errs.length === 0, '赠与交互无运行时报错' + (errs.length ? '：' + errs[0] : ''));
}

console.log('\n[UI-5] 打分阶段');
{
  const { w, errs } = boot2(buildState('scoring'));
  const t = $(w, 'stagePanel').textContent;
  ok(errs.length === 0, '无运行时报错' + (errs.length ? '：' + errs[0] : ''));
  ok(t.includes('互评打分'), '渲染打分面板');
  ok(w.document.querySelectorAll('[data-r]').length === 50, '10 人 × 5 档 = 50 个评分按钮');
}

console.log('\n[UI-6] 结果界面');
{
  const { w, errs } = boot2(buildState('over'));
  const t = $(w, 'lobby').textContent;
  ok(errs.length === 0, '无运行时报错' + (errs.length ? '：' + errs[0] : ''));
  ok(t.includes('最终结果'), '渲染结果浮层');
  ok(w.document.querySelectorAll('.rank').length === 10, '10 行排名');
  ok(w.document.querySelectorAll('.rank.win').length === 4, '高亮前 4 名获胜者');
}

console.log('\n[UI-7] 历史公示不含投入额');
{
  const { w } = boot2(buildState('over'));
  const hist = $(w, 'hist').textContent;
  const h = JSON.stringify(buildState('over').history);
  ok(!/deltas|"invest"/.test(h), '下发的历史数据里没有 deltas / invest 字段');
  ok(hist.length > 0 && !hist.includes('undefined'), '历史表格渲染正常');
}

console.log('\n[UI-8] 输入内容不会被服务端广播冲掉');
{
  const st = buildState('invest');
  const { w, errs, inst } = boot2(st);
  const n = $(w, 'invNum');
  n.value = '7';
  n.dispatchEvent(new w.Event('input', { bubbles: true }));
  // 模拟服务端连着推两次 state（AI 每提交一次投资就会推一次）
  inst.onmessage({ data: JSON.stringify({ type: 'state', state: st }) });
  inst.onmessage({ data: JSON.stringify({ type: 'state', state: st }) });
  ok($(w, 'invNum').value === '7', '投资输入框在连续广播后仍是 7（不再跳回一半）');
  ok($(w, 'invRange').value === '7', '滑块跟着同步到 7');
  ok(errs.length === 0, '无运行时报错' + (errs.length ? '：' + errs[0] : ''));
}

console.log('\n[UI-8b] 赠与数量同样不会被冲掉');
{
  const st = buildState('discuss');
  const { w, errs, inst } = boot2(st);
  const gn = $(w, 'giftNum');
  gn.value = '4';
  gn.dispatchEvent(new w.Event('input', { bubbles: true }));
  inst.onmessage({ data: JSON.stringify({ type: 'state', state: st }) });
  ok($(w, 'giftNum').value === '4', '赠与数量输入框保留 4');
  ok(errs.length === 0, '无运行时报错' + (errs.length ? '：' + errs[0] : ''));
}

console.log('\n[UI-9] 默认不暴露 AI 之间的密谈');
{
  const spyTab = w => w.document.querySelector('.ip-tab[data-t="spy"]');
  {
    const { w } = boot2(buildState('discuss'));
    ok(spyTab(w) && spyTab(w).style.display === 'none', '默认看不到"监听"页签（密谈只有通话里的人看得到）');
  }
  {
    const { w } = bootAs(buildState('discuss'), { you: { pid: null, spectate: true }, watch: true });
    ok(spyTab(w) && spyTab(w).style.display !== 'none', '观战位能看到"监听"页签');
  }
}

console.log('\n[UI-10] 结果页不会被一次点击顶掉');
{
  const { w, sent } = boot2(buildState('over'));
  const btn = $(w, 'btnAgain');
  ok(!!btn, '结果页有"再来一局"按钮');
  btn.click();
  ok(!sent.some(m => m.type === 'start'), '刚弹出的 1.2 秒内点击不生效（防连击穿透）');
  await new Promise(r => setTimeout(r, 1400));
  btn.click();
  ok(!sent.some(m => m.type === 'start'), '解锁后第一次点击只做确认，不开局');
  ok(btn.textContent.includes('确认'), '按钮进入二次确认态');
  btn.click();
  ok(sent.some(m => m.type === 'start'), '再点一次才真的开新一局');
}

console.log('\n[UI-11] 战报缺失时不会摆出建房页');
{
  const st = buildState('over');
  st.result = null;
  const { w } = boot2(st);
  ok(!$(w, 'btnStart'), '没有"开始游戏"按钮（避免玩家以为是没结算成功）');
  ok($(w, 'lobby').textContent.includes('本局已结束'), '只显示"本局已结束"占位');
}

console.log('\n[UI-12] 上一局战报随时可回看');
{
  const { w, inst } = boot2(buildState('over'));
  inst.onmessage({ data: JSON.stringify({ type: 'state', state: buildState('invest') }) });
  const btn = $(w, 'btnLastResult');
  ok(btn && btn.style.display !== 'none', '开新一局后"上局战报"入口还在');
  btn.click();
  ok($(w, 'lobby').style.display === '', '点开后战报浮层显示');
  ok($(w, 'lobby').textContent.includes('最终结果'), '内容是上一局的战报');
  $(w, 'btnCloseLast').click();
  ok($(w, 'lobby').style.display === 'none', '关闭后浮层收起');
}

// 带身份（观战位 / 局域网 IP）启动，用来验证"我是谁"相关的界面分支
function bootAs(state, { you, lan, roomId, watch } = {}) {
  // 网址不带 room 参数：房号只能来自服务端的 hello，这样才测得出"广播会不会把房号冲掉"
  const url = 'http://127.0.0.1:8787/' + (watch ? '?watch=1' : '');
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const errs = [];
  w.onerror = (m) => errs.push(String(m));
  const sent = [];
  class FakeWS {
    constructor() { setTimeout(() => this.onopen && this.onopen(), 0); }
    send(s) { sent.push(JSON.parse(s)); }
    close() {}
  }
  w.WebSocket = FakeWS;
  try { w.eval(patched); } catch (e) { errs.push('eval: ' + e.message); }
  const inst = w.__ws;
  inst.onmessage({ data: JSON.stringify({ type: 'hello', roomId: roomId || 'R1', state, you, lan }) });
  if (you) inst.onmessage({ data: JSON.stringify({ type: 'joined', pid: you.pid, spectate: !!you.spectate }) });
  inst.onmessage({ data: JSON.stringify({ type: 'state', state, you }) });
  return { dom, w, errs, sent, inst };
}

console.log('\n[UI-13] 观战位：只许看，不许动');
{
  const { w, errs } = bootAs(buildState('invest'), { you: { pid: null, spectate: true } });
  const t = $(w, 'stagePanel').textContent;
  ok(errs.length === 0, '无运行时报错' + (errs.length ? '：' + errs[0] : ''));
  ok(t.includes('观战中'), '显示观战面板而不是操作面板');
  ok(!$(w, 'invRange') && !$(w, 'btnInv'), '没有投资滑块和提交按钮（无法插手）');
  ok($(w, 'callCard').textContent.includes('上帝视角'), '左侧标明上帝视角');
}
{
  const { w, errs } = bootAs(buildState('discuss'), { you: { pid: null, spectate: true } });
  const t = $(w, 'stagePanel').textContent;
  ok(errs.length === 0, '观战位在讨论阶段无报错' + (errs.length ? '：' + errs[0] : ''));
  ok(w.document.querySelectorAll('[data-inv]').length === 0, '不能发起密谈');
  ok(w.document.querySelectorAll('[data-g]').length === 0, '不能赠与金币');
  ok(t.includes('密谈'), '能看到场上谁在密谈');
}
{
  // 观战位能听见所有 AI 密谈
  const { w, inst } = bootAs(buildState('discuss'), { you: { pid: null, spectate: true } });
  inst.onmessage({ data: JSON.stringify({ type: 'call:msg', callId: 'c1', from: 'p2', fromName: '席位2', text: '别投了', spectate: true }) });
  ok($(w, 'chatBody').textContent.includes('别投了'), '观战位能听见 AI 之间的密谈');
}
{
  // 坐席位的玩家听不见别人的密谈
  const { w, inst } = bootAs(buildState('discuss'), { you: { pid: 'p1', spectate: false } });
  inst.onmessage({ data: JSON.stringify({ type: 'call:msg', callId: 'c1', from: 'p2', fromName: '席位2', text: '别投了', spectate: true }) });
  ok(!$(w, 'chatBody').textContent.includes('别投了'), '坐席位的玩家听不见别人的密谈');
}

console.log('\n[UI-14] 联机邀请：只给房号，不给网址');
{
  // 客户端架构下网址毫无意义 —— 它指向的是房主本机的 127.0.0.1，别人打不开。
  // 能给出去的只有房号：对方用自己的客户端输入即可入座。
  const st = E.publicState(E.createRoom({}));
  const { w, errs } = bootAs(st, { you: { pid: 'p1', spectate: false }, roomId: 'R1' });
  const url = $(w, 'inviteUrl').value;
  ok(errs.length === 0, '无运行时报错' + (errs.length ? '：' + errs[0] : ''));
  ok(url === 'R1', '邀请框里就是房号本身，不再是局域网网址');
  ok(!url.startsWith('http'), '不再给出任何可直接在浏览器打开的链接');
  ok(!!$(w, 'btnCopy') && !!$(w, 'btnNewRoom'), '有复制与换房按钮');
  ok($(w, 'lobby').textContent.includes('R1'), '建房页显示当前房号');
}
{
  // 分享 ?watch=1 的链接，对方打开就是观战位，不用自己点
  const st = E.publicState(E.createRoom({}));
  const { w, sent } = bootAs(st, { you: { pid: null, spectate: true }, lan: ['192.168.1.9'], watch: true });
  await new Promise(r => setTimeout(r, 30));   // onopen 是异步触发的
  ok(sent.some(m => m.type === 'join' && m.spectate === true), '?watch=1 打开时自动以观战位入座');
  ok($(w, 'lobby').textContent.includes('观战位'), '建房页显示当前是观战位');
}
{
  // 房间号不会因为广播刷新而丢失（曾挂在 S 上被整体换掉，邀请链接退化成 R1）
  const st = E.publicState(E.createRoom({}));
  const { w, inst } = bootAs(st, { you: { pid: 'p1', spectate: false }, lan: ['192.168.1.9'], roomId: 'AB12' });
  inst.onmessage({ data: JSON.stringify({ type: 'state', state: st, you: { pid: 'p1', spectate: false } }) });
  ok($(w, 'inviteUrl').value === 'AB12', '多次广播后房号不会丢');
  ok(w.document.querySelector('.top') !== null, '顶栏正常渲染');
}

console.log('\n[UI-15] 一键十 AI 对局');
{
  const st = E.publicState(E.createRoom({}));
  const { w, sent, errs } = bootAs(st, { you: { pid: 'p1', spectate: false }, lan: ['192.168.1.9'] });
  ok(!!$(w, 'btnAllAI'), '建房页有"十席全交给 AI"按钮');
  $(w, 'btnAllAI').click();
  const cfg = sent.find(m => m.type === 'config');
  ok(!!cfg, '发出配置指令');
  ok(cfg && cfg.config.players.length === 10, '十个席位都下发');
  ok(cfg && cfg.config.players.every(p => p.kind === 'local'), '全部改成离线策略（含原本是人的 1 号席位）');
  ok(sent.some(m => m.type === 'join' && m.spectate === true), '自己退到观战位');
  ok(errs.length === 0, '无运行时报错' + (errs.length ? '：' + errs[0] : ''));
}

console.log('\n[UI-16] 中途加入：身份绑定后面板要重建');
{
  // hello 比 joined 先到，那时 me 还是 null。骨架签名若不含身份，
  // 绑定席位后不会重建，会把"自己"也算进可邀请名单
  const { w } = bootAs(buildState('discuss'), { you: { pid: 'p1', spectate: false } });
  ok(w.document.querySelectorAll('[data-inv]').length === 9, '可邀请名单不含自己');
  ok(w.document.querySelectorAll('[data-g]').length === 9, '赠与名单不含自己');
}

console.log('\n[UI-17] 大厅：网络房间有标记，可凭房号加入');
{
  const st = E.publicState(E.createRoom({}));
  const { w, inst, sent } = bootAs(st, { you: { pid: 'p1', spectate: false } });
  // 带 state 的 hello 会让界面进房，所以先用一个不带 state 的 hello 回到大厅视角
  inst.onmessage({ data: JSON.stringify({ type: 'hello', roomId: null, rooms: [], relay: false }) });
  ok($(w, 'lobby').textContent.includes('房间大厅'), '渲染的是房间大厅');
  ok(w.document.body.textContent.includes('未连接'), '中继没连上时大厅标明"未连接"');

  // 网关把本机房间和网络房间合成一个列表下发
  inst.onmessage({ data: JSON.stringify({ type: 'rooms', relay: 'wss://relay.example', rooms: [
    { id: 'ABCD', name: '本机房间', seats: 10, humans: 1, phase: 'lobby', round: 0, playing: false, locked: false, createdAt: 1, online: false },
    { id: 'WXYZ', name: '别人的房间', seats: 10, humans: 3, phase: 'invest', round: 2, playing: true, locked: true, createdAt: 2, online: true },
  ] }) });
  ok(w.document.body.textContent.includes('已连中继'), '中继连上后大厅显示"已连中继"');
  ok(w.document.body.textContent.includes('ABCD') && w.document.body.textContent.includes('本机'), '本机房间带「本机」标记');
  ok(w.document.body.textContent.includes('WXYZ') && w.document.body.textContent.includes('网络'), '网络房间带「网络」标记');

  // 用房号加入：必须带上昵称，房主那边才知道坐下的谁
  $(w, 'nickName').value = '小明';
  $(w, 'hallRoomId').value = 'wxyz';
  $(w, 'btnJoinById').click();
  const join = sent.filter(m => m.type === 'room:join').pop();
  ok(join && join.roomId === 'WXYZ', '房号自动转成大写并发出加入指令');
  ok(join && join.name === '小明', '加入时带上了昵称');

  // 建房时"开放到网络"要如实上报
  sent.length = 0;
  $(w, 'hallPublic').checked = false;
  $(w, 'hallName').value = '私密局';
  $(w, 'btnHallCreate').click();
  const create = sent.filter(m => m.type === 'room:create').pop();
  ok(create && create.public === false, '没勾"开放到网络"时如实下发 public:false');
}

console.log('\n[UI-18] 输入框不能被后台刷新冲掉');
{
  // 起因：大厅每 5 秒刷一次房间列表，而 renderHall 是整块 innerHTML 重建，
  // 于是"房间名打到一半 → 内容被清空、光标丢失"，中文输入法的组合也会被掐断。
  const st = E.publicState(E.createRoom({}));
  const { w, inst } = bootAs(st, { you: { pid: 'p1', spectate: false } });
  inst.onmessage({ data: JSON.stringify({ type: 'hello', roomId: null, rooms: [], relay: false }) });

  const room = { id: 'ABCD', name: '别人的房间', seats: 10, humans: 2, phase: 'lobby', round: 0, playing: false, locked: false, createdAt: 1, online: false };
  const nameEl = $(w, 'hallName');
  const seatEl = $(w, 'hallSeats');
  nameEl.focus();
  nameEl.value = '阿伟的房';
  nameEl.setSelectionRange(3, 3);

  inst.onmessage({ data: JSON.stringify({ type: 'rooms', relay: false, rooms: [room] }) });
  const after = $(w, 'hallName');
  ok(after.value === '阿伟的房', '刷新房间列表后，房间名里填的内容还在');
  ok(w.document.activeElement === after, '焦点还留在房间名输入框上');
  ok(after.selectionStart === 3, '光标位置也没被挪走');
  ok(w.document.body.textContent.includes('ABCD'), '房间列表照常更新了');
  // 光值还在不够：整块重建会把输入框换成新节点，中文输入法打到一半的组合会被掐断。
  // 所以定时刷新必须只换列表那一块，建房区的输入框连节点都不能动。
  ok($(w, 'hallName') === nameEl && $(w, 'hallSeats') === seatEl,
     '刷新只重建房间列表那一块，建房输入框是同一个节点（输入法不会被打断）');

  // 再刷一次，这次列表真变了（别人又建了房）：反复重建也不能把内容吞掉
  inst.onmessage({ data: JSON.stringify({ type: 'rooms', relay: false, rooms: [
    room, { id: 'EFGH', name: '第二间', seats: 10, humans: 1, phase: 'lobby', round: 0, playing: false, locked: false, createdAt: 2, online: false },
  ] }) });
  ok($(w, 'hallName').value === '阿伟的房', '列表又变了一次，填到一半的房间名照样还在');
  ok($(w, 'hallName').selectionStart === 3, '反复重建后光标仍在原处');

  // 进房后的建房页也一样：服务端推状态会重建配置区，不能把改了一半的设置冲掉
  const b2 = bootAs(E.publicState(E.createRoom({})), { you: { pid: 'p1', spectate: false } });
  const seats = $(b2.w, 'cfgSeats');
  ok(!!seats, '进房后能看到建房配置区');
  seats.focus();
  seats.value = '8';
  b2.inst.onmessage({ data: JSON.stringify({ type: 'state', roomId: 'ABCD', state: E.publicState(E.createRoom({})) }) });
  ok($(b2.w, 'cfgSeats').value === '8', '服务端推状态时，改了一半的席位不会被冲回默认值');
}

console.log(fail === 0 ? '\n前端全部通过\n' : `\n${fail} 项未通过\n`);
process.exit(fail === 0 ? 0 : 1);
