#!/bin/bash
# 打 Windows 发行包：安装版 exe + 绿色版 zip
#
# 产物自带 Electron 运行时，用户不需要装 Node.js、不需要 npm install、安装过程不联网。
#
# 依赖（Linux 打包机）：
#   sudo apt-get install nsis zip unzip curl          # NSIS 用来编安装程序
#   sudo apt-get install gcc-mingw-w64-x86-64         # 用来编启动器 exe
#   imagemagick                                       # 可选，用来给 exe 加图标
#   wine64                                            # 可选，用来试跑安装程序
#
# 用法：./tools/build-win.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${WORK:-/tmp/pgg-build-win}"
ELECTRON_VERSION="${ELECTRON_VERSION:-44.8.0}"
MIRROR="${MIRROR:-https://mirrors.huaweicloud.com/electron}"   # GitHub 太慢，默认走华为云镜像

command -v makensis >/dev/null || { echo "缺 makensis：sudo apt-get install nsis"; exit 1; }
command -v x86_64-w64-mingw32-gcc >/dev/null || { echo "缺 mingw：sudo apt-get install gcc-mingw-w64-x86-64"; exit 1; }

rm -rf "$WORK"; mkdir -p "$WORK"
cd "$WORK"

echo "▶ 1/5 下载 Electron ${ELECTRON_VERSION} Windows 运行时"
# 150MB 的运行时缓存在 ~/.cache 里，重打包不用重新下载
CACHE="${HOME}/.cache/pgg-electron"
ZIP="$CACHE/electron-v$ELECTRON_VERSION-win32-x64.zip"
mkdir -p "$CACHE"
[ -f "$ZIP" ] || curl -fL --retry 3 -o "$ZIP" "$MIRROR/$ELECTRON_VERSION/electron-v$ELECTRON_VERSION-win32-x64.zip"
unzip -q -o "$ZIP" -d runtime

echo "▶ 2/5 准备应用目录（只装运行时依赖，不装 devDependencies）"
mkdir -p 游戏
cp -r "$ROOT"/server "$ROOT"/public "$ROOT"/electron 游戏/
cat > 游戏/package.json <<EOF
{
  "name": "public-goods-game",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "electron/main.cjs",
  "dependencies": { "ws": "^8.22.0" }
}
EOF
(cd 游戏 && npm install --omit=dev --no-audit --no-fund --loglevel=error)

echo "▶ 3/5 编启动器 exe（带图标）"
if command -v convert >/dev/null && [ -f "$ROOT/public/assets/coin_128.png" ]; then
  convert "$ROOT/public/assets/coin_128.png" -define icon:auto-resize=256,128,64,48,32,16 app.ico
  printf 'IDI_ICON1 ICON DISCARDABLE "app.ico"\n' > icon.rc
  x86_64-w64-mingw32-windres icon.rc -O coff icon.o
  ICON_OBJ="icon.o"
else
  ICON_OBJ=""
fi
# shellcheck disable=SC2086
x86_64-w64-mingw32-gcc -municode -mwindows -O2 -o 启动游戏.exe \
  "$ROOT/launcher/launcher.c" $ICON_OBJ -lws2_32 -lshell32 -luser32

echo "▶ 4/5 组装发行目录"
mkdir -p 公共财博弈
cp 启动游戏.exe 公共财博弈/
cp -r runtime 公共财博弈/运行时
cp -r 游戏 公共财博弈/游戏
rm -f 公共财博弈/运行时/resources/default_app.asar
for f in 公共财博弈/运行时/locales/*.pak; do
  case "$(basename "$f")" in zh-CN.pak|en-US.pak) ;; *) rm -f "$f";; esac
done

echo "▶ 5/5 编安装程序 + 打绿色包"
cp "$ROOT/tools/installer.nsi" .
makensis installer.nsi
zip -r -9 -q 公共财博弈-绿色版.zip 公共财博弈

mkdir -p "$ROOT/发布"
cp 公共财博弈-安装版.exe 公共财博弈-绿色版.zip "$ROOT/发布/"
echo "✔ 完成：$ROOT/发布/"
ls -la "$ROOT/发布/"

# 传 GitHub Release 时注意：附件名会被 GitHub 剥掉中文，只剩 "-.exe"。
# 上传必须改用 ASCII 名，例如：
#   gh release create v1.0.0 发布/公共财博弈-安装版.exe 发布/公共财博弈-绿色版.zip   ← 会坏
#   正解是用 API 逐条传，并在 URL 里指定 name：
#   curl -X POST -H "Authorization: Bearer $(gh auth token)" \
#        -H "Content-Type: application/octet-stream" \
#        --data-binary @"发布/公共财博弈-安装版.exe" \
#        "https://uploads.github.com/repos/<owner>/<repo>/releases/<id>/assets?name=PublicGoodsGame-Setup.exe"
