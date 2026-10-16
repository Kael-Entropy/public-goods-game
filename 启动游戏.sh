#!/bin/bash
# 公共财博弈 · 桌面启动器
# 双击或 ./启动游戏.sh 即可，独立窗口运行，不依赖浏览器
cd "$(dirname "$0")"

# WorkBuddy 等 Electron 宿主会把 ELECTRON_RUN_AS_NODE 注入环境，必须剥离，
# 否则窗口会退化成纯 Node 进程，弹不出界面
unset ELECTRON_RUN_AS_NODE

# 开发期 chrome-sandbox 未配置 SUID，需要 --no-sandbox；打包成 exe 后不需要
exec ./node_modules/electron/dist/electron . --no-sandbox "$@"
