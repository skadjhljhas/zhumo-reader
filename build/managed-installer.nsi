Unicode true
RequestExecutionLevel user
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "x64.nsh"

Name "${DISPLAY_NAME}"
OutFile "${OUTPUT_FILE}"
InstallDir "${DEFAULT_INSTALL}"
InstallDirRegKey HKCU "${REGISTRY_KEY}" "InstallLocation"
SetCompressor /SOLID lzma
SetCompressorDictSize 32
ShowInstDetails show
ShowUninstDetails show
!define MUI_ICON "${ICON_FILE}"
!define MUI_UNICON "${ICON_FILE}"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TEXT "安装新版朱墨，并保留原有文稿与阅读设置。$\r$\n$\r$\n更新前请保存并正常退出朱墨。安装失败时，原版本和恢复记录会保留。"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_FUNCTION OpenReader
!define MUI_FINISHPAGE_RUN_TEXT "打开朱墨"
!define MUI_FINISHPAGE_TEXT "朱墨已安装。原有文稿和设置保留，启动入口会打开已校验的当前版本。"
!insertmacro MUI_PAGE_FINISH
!define MUI_UNCONFIRMPAGE_TEXT_TOP "卸载朱墨并清理有明确归属的程序副本。文稿、设置、用户改过的文件和资料恢复点保留。"
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

Var Runtime
Var Launcher
Var ResultFile
Var PlanFile
Var SourceDir
Var ReturnCode
Var PreviousNodeMode
Var PreviousProfileUiMode
Var DesktopLink
Var MenuLink
Var InstanceId
Var Uninstaller
Var InstallerMutex
Var CleanupSource

!macro LockInstaller
  System::Call 'kernel32::CreateMutexW(p 0, i 0, w "${INSTALLER_MUTEX}") p.r0 ?e'
  Pop $1
  StrCpy $InstallerMutex $0
  ${If} $0 == 0
  ${OrIf} $1 == 183
    SetErrorLevel 94
    MessageBox MB_ICONEXCLAMATION|MB_OK "另一项朱墨安装或卸载正在进行，请等它结束后重试。" /SD IDOK
    Abort
  ${EndIf}
!macroend

Function .onInit
  !insertmacro LockInstaller
  SetShellVarContext current
  ${If} ${RunningX64}
    SetRegView 64
  ${EndIf}
FunctionEnd

Function OpenReader
  Exec '"$Launcher" --zhumo-launch-current "$INSTDIR"'
FunctionEnd

Section "安装朱墨"
  System::Call 'ole32::CoCreateGuid(g .r0) i.r1'
  ${If} $1 != 0
    Abort "无法创建本次安装的独立运行目录。"
  ${EndIf}
  StrCpy $InstanceId $0
  CreateDirectory "${RUNTIME_BASE}"
  StrCpy $Runtime "${RUNTIME_BASE}\$InstanceId"
  System::Call 'kernel32::CreateDirectoryW(w "$Runtime", p 0) i.r1'
  ${If} $1 == 0
    Abort "无法创建独立运行目录；未覆盖原程序。"
  ${EndIf}
  StrCpy $SourceDir "$Runtime\payload"
  StrCpy $ResultFile "$Runtime\installed.ini"
  StrCpy $PlanFile "$Runtime\setup.ini"
  SetOutPath "$SourceDir"
  File /r "${PAYLOAD_DIR}\*.*"
  StrCpy $Launcher "$SourceDir\${EXECUTABLE_NAME}"
  StrCpy $Uninstaller "$Runtime\remove.exe"
  ClearErrors
  WriteUninstaller "$Uninstaller"
  ${If} ${Errors}
    SetErrorLevel 93
    Abort "无法创建本次卸载入口；未更改原安装。"
  ${EndIf}
  ; Each path is written separately. The helper command remains below NSIS string limits.
  ClearErrors
  FileOpen $0 "$PlanFile" w
  FileWriteByte $0 255
  FileWriteByte $0 254
  FileWriteUTF16LE $0 "[Setup]$\r$\n"
  FileWriteUTF16LE $0 "source=$SourceDir$\r$\n"
  FileWriteUTF16LE $0 "installRoot=$INSTDIR$\r$\n"
  FileWriteUTF16LE $0 "defaultProfile=${PROFILE_DIR}$\r$\n"
  FileWriteUTF16LE $0 "workRoot=${WORK_DIR}$\r$\n"
  FileWriteUTF16LE $0 "coordinator=${COORDINATOR_DIR}$\r$\n"
  FileWriteUTF16LE $0 "manifestHash=${MANIFEST_HASH}$\r$\n"
  FileWriteUTF16LE $0 "appId=${APP_ID}$\r$\n"
  FileWriteUTF16LE $0 "appName=${APP_NAME}$\r$\n"
  FileWriteUTF16LE $0 "resultFile=$ResultFile$\r$\n"
  FileWriteUTF16LE $0 "desktopDirectory=${DESKTOP_DIR}$\r$\n"
  FileWriteUTF16LE $0 "menuDirectory=${MENU_DIR}$\r$\n"
  FileWriteUTF16LE $0 "displayName=${DISPLAY_NAME}$\r$\n"
  FileWriteUTF16LE $0 "registryKey=${REGISTRY_KEY}$\r$\n"
  FileWriteUTF16LE $0 "uninstaller=$Uninstaller$\r$\n"
  FileWriteUTF16LE $0 "runtimeId=$InstanceId$\r$\n"
  FileClose $0
  ${If} ${Errors}
    SetErrorLevel 89
    Abort "无法写入完整安装计划。"
  ${EndIf}
  DetailPrint "正在校验程序、保留原有文件并准备新版本……"
  ReadEnvStr $PreviousNodeMode "ELECTRON_RUN_AS_NODE"
  ReadEnvStr $PreviousProfileUiMode "ZHUMO_SETUP_NO_UI"
  ${If} ${Silent}
    System::Call 'kernel32::SetEnvironmentVariableW(w "ZHUMO_SETUP_NO_UI", w "1")'
  ${Else}
    System::Call 'kernel32::SetEnvironmentVariableW(w "ZHUMO_SETUP_NO_UI", w "0")'
  ${EndIf}
  System::Call 'kernel32::SetEnvironmentVariableW(w "ELECTRON_RUN_AS_NODE", w "1") i.r1'
  ${If} $1 == 0
    Abort "无法启动安装检查。"
  ${EndIf}
  ClearErrors
  nsExec::ExecToLog '"$Launcher" "$SourceDir\resources\app.asar\out\main\setup-action.js" --plan "$PlanFile"'
  Pop $ReturnCode
  ${If} $PreviousProfileUiMode == ""
    System::Call 'kernel32::SetEnvironmentVariableW(w "ZHUMO_SETUP_NO_UI", p 0)'
  ${Else}
    System::Call 'kernel32::SetEnvironmentVariableW(w "ZHUMO_SETUP_NO_UI", w "$PreviousProfileUiMode")'
  ${EndIf}
  ${If} $ReturnCode == "error"
  ${OrIf} $ReturnCode == "timeout"
    StrCpy $ReturnCode 90
  ${EndIf}
  ${If} ${Errors}
    StrCpy $ReturnCode 90
  ${EndIf}
  ${If} $PreviousNodeMode == ""
    System::Call 'kernel32::SetEnvironmentVariableW(w "ELECTRON_RUN_AS_NODE", p 0)'
  ${Else}
    System::Call 'kernel32::SetEnvironmentVariableW(w "ELECTRON_RUN_AS_NODE", w "$PreviousNodeMode")'
  ${EndIf}
  ${If} $ReturnCode != 0
    SetErrorLevel $ReturnCode
    MessageBox MB_ICONEXCLAMATION|MB_OK "安装未完成。请确认朱墨已保存并退出，路径可用后重试。原文件和恢复记录已保留。" /SD IDOK
    Abort
  ${EndIf}
  ReadINIStr $0 "$ResultFile" "Install" "Status"
  ${If} $0 != "committed"
    SetErrorLevel 91
    Abort "安装回执尚未完成，未写入系统入口。"
  ${EndIf}
  ReadINIStr $INSTDIR "$ResultFile" "Install" "Root"
  ReadINIStr $Launcher "$ResultFile" "Install" "Launcher"
  ${If} $INSTDIR == ""
  ${OrIf} $Launcher == ""
    SetErrorLevel 91
    Abort "安装结果无法读取。"
  ${EndIf}
  ReadINIStr $DesktopLink "$ResultFile" "Install" "DesktopLink"
  ReadINIStr $MenuLink "$ResultFile" "Install" "MenuLink"
  ${If} $DesktopLink == ""
  ${OrIf} $MenuLink == ""
    SetErrorLevel 93
    Abort "快捷方式回执缺失；未写入系统登记。"
  ${EndIf}
  ; Native registration and its readback are completed by setup-action under the profile guard.
  DetailPrint "安装完成；文稿、设置和旧版本均已保留。"
SectionEnd

Function un.onInit
  !insertmacro LockInstaller
  SetShellVarContext current
  ${If} ${RunningX64}
    SetRegView 64
  ${EndIf}
FunctionEnd

Section "Uninstall"
  ; $INSTDIR is the original uninstaller directory, including when NSIS runs its temp copy.
  StrCpy $Runtime "$INSTDIR"
  StrCpy $SourceDir "$Runtime\payload"
  StrCpy $PlanFile "$Runtime\setup.ini"
  ; The uninstaller carries an independent recovery runtime. It can remove the old
  ; bootstrap files without deleting its own executing image or depending on them to retry.
  InitPluginsDir
  StrCpy $CleanupSource "$PLUGINSDIR\cleanup-runtime"
  SetOutPath "$CleanupSource"
  File /r "${PAYLOAD_DIR}\*.*"
  StrCpy $Launcher "$CleanupSource\${EXECUTABLE_NAME}"
  ; The helper first recovers an interrupted removal, then checks this runtime's ownership.
  ; Do not reject a half-removed registry entry before its journal can be recovered.
  ReadEnvStr $PreviousNodeMode "ELECTRON_RUN_AS_NODE"
  System::Call 'kernel32::SetEnvironmentVariableW(w "ELECTRON_RUN_AS_NODE", w "1")'
  nsExec::ExecToLog '"$Launcher" "$CleanupSource\resources\app.asar\out\main\setup-action.js" --uninstall "$PlanFile" --execution-source "$CleanupSource"'
  Pop $ReturnCode
  ${If} $PreviousNodeMode == ""
    System::Call 'kernel32::SetEnvironmentVariableW(w "ELECTRON_RUN_AS_NODE", p 0)'
  ${Else}
    System::Call 'kernel32::SetEnvironmentVariableW(w "ELECTRON_RUN_AS_NODE", w "$PreviousNodeMode")'
  ${EndIf}
  ${If} $ReturnCode != 0
    SetErrorLevel 95
    MessageBox MB_ICONEXCLAMATION|MB_OK "卸载未完成。请保存并退出朱墨后重试；文稿、设置和恢复记录已保留。" /SD IDOK
    Abort
  ${EndIf}
  DetailPrint "已卸载并清理归属明确的程序副本。文稿、设置、用户改动和资料恢复点保留。"
SectionEnd
