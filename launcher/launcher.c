/*
 * 公共财博弈 · Windows 启动器
 *
 * 这不是"把整个游戏封进 exe"，只是一个几十 KB 的壳。它按优先级挑一种方式开局：
 *   1. 有 Electron（npm install 会带上）→ 直接起 Electron，真正的独立窗口，跟浏览器无关
 *   2. 没有 → 找 node（同目录 runtime\node.exe → 同目录 → 系统 PATH），
 *      后台拉起 server\gateway.js（不弹黑框），再用 Edge / Chrome 的应用模式开一个独立窗口
 *   3. 连浏览器都没有 → 退回默认浏览器
 *
 * 注意：起的是本地网关，不是单纯的服务器。网关会拉起只监听 127.0.0.1 的权威引擎，
 * 并把房间登记到中继 —— 别人必须用自己的客户端 + 房号才能进来，光有个网址是玩不了的。
 *
 * 编译（Linux 上交叉编译 Windows 版）：
 *   x86_64-w64-mingw32-gcc -municode -mwindows -O2 -o 启动游戏.exe launcher.c -lws2_32 -lshell32 -luser32
 */
#ifndef UNICODE
#define UNICODE
#define _UNICODE
#endif

#include <winsock2.h>
#include <windows.h>
#include <shellapi.h>

#define PORT      8787
#define APP_NAME  L"公共财博弈"
#define URL       L"http://127.0.0.1:8787"

static PROCESS_INFORMATION g_pi;
static HWND g_label = NULL;
static int  g_mode = 0;          /* 1 = Electron，2 = node + 浏览器窗口 */

/* 取 exe 所在目录（结尾带反斜杠） */
static void exeDir(wchar_t *out, DWORD cap) {
  GetModuleFileNameW(NULL, out, cap);
  wchar_t *slash = wcsrchr(out, L'\\');
  if (slash) *(slash + 1) = L'\0';
  else out[0] = L'\0';
}

/* 找 node.exe：同目录 runtime\ 优先（可随包携带绿色版），其次同目录，最后交给系统 PATH */
static int findNode(wchar_t *out, DWORD cap, const wchar_t *dir) {
  wsprintfW(out, L"%sruntime\\node.exe", dir);
  if (GetFileAttributesW(out) != INVALID_FILE_ATTRIBUTES) return 1;
  wsprintfW(out, L"%snode.exe", dir);
  if (GetFileAttributesW(out) != INVALID_FILE_ATTRIBUTES) return 1;
  out[0] = L'\0';
  return 0;   /* 用 "node"，让系统 PATH 去找 */
}

/* 轮询端口，等网关真的起来了再开窗口 */
static int portReady(int port) {
  SOCKET s;
  struct sockaddr_in a;
  for (int i = 0; i < 80; i++) {          /* 最多等 20 秒 */
    s = socket(AF_INET, SOCK_STREAM, 0);
    if (s == INVALID_SOCKET) { Sleep(250); continue; }
    memset(&a, 0, sizeof(a));
    a.sin_family = AF_INET;
    a.sin_port = htons((u_short)port);
    a.sin_addr.s_addr = inet_addr("127.0.0.1");
    int r = connect(s, (struct sockaddr *)&a, sizeof(a));
    closesocket(s);
    if (r == 0) return 1;
    Sleep(250);
  }
  return 0;
}

static void setStatus(const wchar_t *t) {
  if (g_label) SetWindowTextW(g_label, t);
}

/* 关窗口要连子进程一起杀：网关下面还挂着引擎，只杀父进程会留一堆孤儿 */
static void killTree(void) {
  if (!g_pi.hProcess) return;
  DWORD pid = GetProcessId(g_pi.hProcess);
  if (pid) {
    wchar_t cmd[64];
    wsprintfW(cmd, L"taskkill /f /t /pid %lu", (unsigned long)pid);
    STARTUPINFOW si = {0}; si.cb = sizeof(si);
    si.dwFlags = STARTF_USESHOWWINDOW; si.wShowWindow = SW_HIDE;
    PROCESS_INFORMATION pi2; memset(&pi2, 0, sizeof(pi2));
    if (CreateProcessW(NULL, cmd, NULL, NULL, FALSE, CREATE_NO_WINDOW,
                       NULL, NULL, &si, &pi2)) {
      WaitForSingleObject(pi2.hProcess, 3000);
      CloseHandle(pi2.hThread); CloseHandle(pi2.hProcess);
    }
  }
  TerminateProcess(g_pi.hProcess, 0);
  CloseHandle(g_pi.hThread);
  CloseHandle(g_pi.hProcess);
  g_pi.hProcess = NULL;
}

/* 开一个"独立窗口"：Edge / Chrome 的应用模式没有地址栏和页签，跟客户端窗口一个观感。
   都不行就退回系统默认浏览器。 */
static void openWindow(HWND hwnd) {
  wchar_t args[300];
  wsprintfW(args, L"--app=%s", URL);

  HINSTANCE r = ShellExecuteW(NULL, L"open", L"msedge.exe", args, NULL, SW_SHOWNORMAL);
  if ((INT_PTR)r > 32) { g_mode = 2; setStatus(L"已在 Edge 应用窗口中打开。\n关闭本窗口即停止本地服务。"); return; }

  r = ShellExecuteW(NULL, L"open", L"chrome.exe", args, NULL, SW_SHOWNORMAL);
  if ((INT_PTR)r > 32) { g_mode = 2; setStatus(L"已在 Chrome 应用窗口中打开。\n关闭本窗口即停止本地服务。"); return; }

  r = ShellExecuteW(NULL, L"open", URL, NULL, NULL, SW_SHOWNORMAL);
  if ((INT_PTR)r > 32) { g_mode = 2; setStatus(L"已在默认浏览器中打开。\n关闭本窗口即停止本地服务。"); return; }

  MessageBoxW(hwnd, L"服务已经起来了，但没能打开窗口。\n请手动在浏览器里访问 http://127.0.0.1:8787",
              APP_NAME, MB_ICONWARNING | MB_OK);
}

LRESULT CALLBACK WndProc(HWND h, UINT m, WPARAM w, LPARAM l) {
  switch (m) {
    case WM_CLOSE:
      DestroyWindow(h);
      return 0;
    case WM_DESTROY:
      killTree();
      PostQuitMessage(0);
      return 0;
    case WM_COMMAND:
      if (LOWORD(w) == 1) {
        if (g_mode == 1) { /* Electron 模式下这个按钮没意义：窗口由 Electron 自己管 */ }
        else openWindow(h);
      }
      return 0;
  }
  return DefWindowProcW(h, m, w, l);
}

int WINAPI wWinMain(HINSTANCE hInst, HINSTANCE hPrev, PWSTR cmdline, int show) {
  (void)hPrev; (void)cmdline; (void)show;
  memset(&g_pi, 0, sizeof(g_pi));

  WSADATA wsa;
  WSAStartup(MAKEWORD(2, 2), &wsa);

  wchar_t dir[MAX_PATH];
  exeDir(dir, MAX_PATH);

  /* 先建窗口，任何一步失败都能用它提示 */
  WNDCLASSW wc = {0};
  wc.lpfnWndProc = WndProc;
  wc.hInstance = hInst;
  wc.lpszClassName = L"PggLauncher";
  wc.hbrBackground = (HBRUSH)(COLOR_BTNFACE + 1);
  RegisterClassW(&wc);

  HWND hwnd = CreateWindowExW(0, L"PggLauncher", APP_NAME,
      WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX,
      CW_USEDEFAULT, CW_USEDEFAULT, 450, 200, NULL, NULL, hInst, NULL);
  if (!hwnd) return 1;

  g_label = CreateWindowW(L"STATIC",
      L"正在启动本地网关…", WS_CHILD | WS_VISIBLE | SS_LEFT,
      20, 18, 400, 66, hwnd, NULL, hInst, NULL);
  HWND btn = CreateWindowW(L"BUTTON", L"再开一个窗口",
      WS_CHILD | WS_VISIBLE | BS_DEFPUSHBUTTON,
      20, 92, 160, 30, hwnd, (HMENU)1, hInst, NULL);
  (void)btn;
  ShowWindow(hwnd, SW_SHOW);
  UpdateWindow(hwnd);

  STARTUPINFOW si = {0};
  si.cb = sizeof(si);
  si.dwFlags = STARTF_USESHOWWINDOW;
  si.wShowWindow = SW_HIDE;

  /* ---- 路线 1：Electron ----
     两种来源：打好的完整包把运行时放在 运行时\electron.exe（免安装、免 Node）；
     源码跑的话是 npm install 装进来的 node_modules\electron。 */
  wchar_t electron[MAX_PATH];
  wchar_t appArg[64];
  wsprintfW(electron, L"%s运行时\\electron.exe", dir);
  if (GetFileAttributesW(electron) != INVALID_FILE_ATTRIBUTES) {
    wsprintfW(appArg, L"%s游戏", dir);
  } else {
    wsprintfW(electron, L"%snode_modules\\electron\\dist\\electron.exe", dir);
    wsprintfW(appArg, L".");
  }
  if (GetFileAttributesW(electron) != INVALID_FILE_ATTRIBUTES) {
    wchar_t cmd[1200];
    wsprintfW(cmd, L"\"%s\" \"%s\"", electron, appArg);
    if (CreateProcessW(NULL, cmd, NULL, NULL, FALSE, 0, NULL, dir, &si, &g_pi)) {
      g_mode = 1;
      setStatus(L"游戏窗口已打开（Electron 独立窗口）。\n\n"
                L"要跟朋友联机：建房时勾上「开放到网络」，\n"
                L"把 4 位房号发给对方，对方用自己的客户端输入房号即可入座。\n\n"
                L"关闭本窗口即结束游戏。");
      MSG msg;
      while (GetMessageW(&msg, NULL, 0, 0) > 0) { TranslateMessage(&msg); DispatchMessageW(&msg); }
      WSACleanup();
      return 0;
    }
  }

  /* ---- 路线 2：node + 独立窗口 ---- */
  wchar_t node[MAX_PATH];
  int hasNode = findNode(node, MAX_PATH, dir);

  wchar_t cmd[1200];
  if (hasNode) wsprintfW(cmd, L"\"%s\" \"%sserver\\gateway.js\"", node, dir);
  else         wsprintfW(cmd, L"node \"%sserver\\gateway.js\"", dir);

  if (!CreateProcessW(NULL, cmd, NULL, NULL, FALSE, CREATE_NO_WINDOW,
                      NULL, dir, &si, &g_pi)) {
    MessageBoxW(hwnd,
      L"启动本地网关失败。\n\n"
      L"这个游戏需要 Node.js 才能跑本地服务。请到 https://nodejs.org 下载安装（一路下一步即可），\n"
      L"装完后再在本目录执行 npm install，然后重新双击本程序。\n\n"
      L"如果你已经有 Node，也可以把 node.exe 复制到本程序同目录下再试。",
      APP_NAME, MB_ICONERROR | MB_OK);
    return 2;
  }

  if (!portReady(PORT)) {
    MessageBoxW(hwnd,
      L"网关启动了，但端口没有响应。\n\n"
      L"可能是 8787 端口被别的程序占用，或 Node.js 版本过低（需要 18 以上）。",
      APP_NAME, MB_ICONWARNING | MB_OK);
    return 3;
  }

  openWindow(hwnd);

  MSG msg;
  while (GetMessageW(&msg, NULL, 0, 0) > 0) {
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }

  WSACleanup();
  return 0;
}
