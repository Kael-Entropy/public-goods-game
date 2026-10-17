// Electron 桌面外壳：双击即玩，内置启动游戏服务，不依赖浏览器
// 逻辑：先探测 8787 是否已有服务（避免和终端里跑的实例打架），
//       没有就用 ELECTRON_RUN_AS_NODE 起一个纯 Node 子进程跑 server/gateway.js（网关再拉权威引擎），
//       等它就绪后开窗口加载页面；关窗即整体退出。
const { app, BrowserWindow, Menu, dialog } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const PORT = Number(process.env.PGG_PORT || 8787);
// PGG_QUERY 只在自动截图时用：例如 ?watch=1 让窗口以观战位打开
const URL_ = `http://127.0.0.1:${PORT}${process.env.PGG_QUERY || ''}`;
let serverProc = null;
let win = null;

function probe() {
  return new Promise(resolve => {
    const req = http.get(URL_, res => { res.resume(); resolve(true); });
    req.on('error', () => resolve(false));
    req.setTimeout(700, () => { req.destroy(); resolve(false); });
  });
}

async function waitServer(tries = 48) {
  for (let i = 0; i < tries; i++) {
    if (await probe()) return true;
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

// 客户端架构：拉起的是本地网关，不是单纯的服务器。
// 网关会自己再拉一个权威引擎（只监听 127.0.0.1），并把房间登记到中继让别人用房号进来。
function startServer() {
  const serverPath = path.join(__dirname, '..', 'server', 'gateway.js');
  serverProc = spawn(process.execPath, [serverPath], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },   // 让 Electron 二进制以纯 Node 模式跑 ESM 服务
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', () => {});
  serverProc.stderr.on('data', d => process.stderr.write('[server] ' + d));
  serverProc.on('exit', () => { serverProc = null; });
}

function killServer() {
  if (serverProc) { try { serverProc.kill(); } catch {} serverProc = null; }
}

async function boot() {
  Menu.setApplicationMenu(null);

  // 已有服务在跑就直接连（例如终端里手动启动过），否则自己起一个
  if (!(await probe())) startServer();
  const ok = await waitServer();
  if (!ok) {
    dialog.showErrorBox('启动失败', '游戏服务未能启动，请检查端口 8787 是否被占用。');
    app.quit();
    return;
  }

  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1024,
    minHeight: 680,
    title: '公共财博弈',
    icon: path.join(__dirname, '..', 'public', 'assets', 'coin_128.png'),
    backgroundColor: '#f6f6f4',
    // 截图模式也必须 show：隐藏窗口从不走合成器，capturePage 会拿到旧帧
    // （实测隐藏窗口里 DOM 已更新、图片已加载，但拍出来还是加载中的画面）
    show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  // 窗口建好就主动抢一次焦点：否则它可能被别的窗口挡在后面，
  // 用户看到的就是"启动器说已打开，但屏幕上什么都没有"
  win.once('ready-to-show', () => { try { win.show(); win.focus(); } catch {} });
  win.loadURL(URL_).then(async () => {
    try { win.focus(); } catch {}
    console.log('[electron] 窗口已加载', URL_);
    if (process.env.PGG_SHOT) {           // 自动验证：截一张图然后退出
      await new Promise(r => setTimeout(r, Number(process.env.PGG_SHOT_WAIT) || 1800));
      try {
        const info = await win.webContents.executeJavaScript(`JSON.stringify({
          s: (window.__S && window.__S()) ? { phase: window.__S().phase, ends: window.__S().phaseEndsAt, now: Date.now() } : null,
          timer: document.getElementById('abTimerText').textContent,
          pendingImgs: [...document.images].filter(i => !i.complete).length,
          totalImgs: document.images.length,
        })`);
        console.log('[page]', info);
      } catch (e) { console.log('[page] executeJavaScript 失败:', e.message); }
      const img = await win.capturePage();
      require('fs').writeFileSync(process.env.PGG_SHOT, img.toPNG());
      console.log('[shot] 已保存', process.env.PGG_SHOT);
      app.quit();
    }
  }).catch(err => {
    console.error('[electron] 页面加载失败:', err.message);
  });
  win.on('closed', () => { win = null; });
}

app.whenReady().then(boot);
app.on('window-all-closed', () => { killServer(); app.quit(); });
app.on('before-quit', killServer);
