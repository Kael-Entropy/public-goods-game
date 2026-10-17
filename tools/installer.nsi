; 公共财博弈 · Windows 安装程序
; 安装过程中不需要联网、不需要预先安装 Node.js —— 运行时和依赖全部内置。
Unicode true

!define APPNAME   "公共财博弈"
!define VERSION   "1.0.0"
!define PUBLISHER "公共财博弈"
!define ICON      "app.ico"

Name        "${APPNAME}"
OutFile     "公共财博弈-安装版.exe"
InstallDir  "$LOCALAPPDATA\PublicGoodsGame"   ; 装到 ASCII 路径：中文安装目录对 Electron 有风险
                                              ; （快捷方式、开始菜单、开始菜单文件夹仍是中文）
RequestExecutionLevel user          ; 装到当前用户目录，不弹 UAC、不需要管理员
SetCompressor /SOLID lzma
SetCompressorDictSize 64

!include "MUI2.nsh"
!define MUI_ICON    "${ICON}"
!define MUI_UNICON  "${ICON}"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\启动游戏.exe"
!define MUI_FINISHPAGE_RUN_TEXT "立即启动 ${APPNAME}"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

Section "安装 ${APPNAME}" SEC_MAIN
  SetOutPath "$INSTDIR"

  ; 内置 Electron 运行时 + 游戏本体 + 启动器，一次性释放
  File /r "dist\*.*"

  ; 开始菜单与桌面快捷方式（图标取启动器自带的那个）
  CreateDirectory "$SMPROGRAMS\${APPNAME}"
  CreateShortcut  "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk" "$INSTDIR\启动游戏.exe" "" "$INSTDIR\启动游戏.exe" 0
  CreateShortcut  "$DESKTOP\${APPNAME}.lnk" "$INSTDIR\启动游戏.exe" "" "$INSTDIR\启动游戏.exe" 0

  ; 卸载入口（"设置 → 应用"里能看到）
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "DisplayName"     "${APPNAME}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "DisplayVersion"  "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "Publisher"       "${PUBLISHER}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "DisplayIcon"     "$INSTDIR\启动游戏.exe,0"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "UninstallString" "$INSTDIR\卸载.exe"
  WriteUninstaller "$INSTDIR\卸载.exe"
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\${APPNAME}.lnk"
  RMDir  /r "$SMPROGRAMS\${APPNAME}"
  RMDir  /r "$INSTDIR"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}"
SectionEnd
