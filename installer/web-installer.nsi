Unicode true
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 64

!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"

!ifndef VERSION
  !error "VERSION is required"
!endif
!ifndef STAGE_DIR
  !error "STAGE_DIR is required"
!endif
!ifndef OUTPUT_DIR
  !error "OUTPUT_DIR is required"
!endif

!define APP_NAME "个人AI工作台"
!define REG_KEY "Software\TeamDailyWorkbench"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\TeamDailyWorkbench"

Name "${APP_NAME} ${VERSION}"
OutFile "${OUTPUT_DIR}\个人AI工作台-Web版-Setup-${VERSION}.exe"
InstallDir "$LOCALAPPDATA\Programs\个人AI工作台"
InstallDirRegKey HKCU "${REG_KEY}" "InstallDir"
BrandingText "个人AI工作台"
ShowInstDetails show
ShowUninstDetails show

Var IsUpgrade
Var DeleteDataCheckbox
Var DeleteUserData

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchWorkbench
!define MUI_FINISHPAGE_RUN_TEXT "启动个人AI工作台"

!insertmacro MUI_PAGE_WELCOME
PageEx directory
  PageCallbacks DirectoryPre
PageExEnd
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
UninstPage custom un.DataPage un.DataPageLeave
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"

Function .onInit
  SetShellVarContext current
  StrCpy $IsUpgrade "0"
  ReadRegStr $0 HKCU "${REG_KEY}" "InstallDir"
  ${If} $0 != ""
    StrCpy $INSTDIR $0
    StrCpy $IsUpgrade "1"
  ${Else}
    IfFileExists "D:\" 0 +2
      StrCpy $INSTDIR "D:\个人AI工作台"
  ${EndIf}
FunctionEnd

Function DirectoryPre
  ${If} $IsUpgrade == "1"
    Abort
  ${EndIf}
FunctionEnd

Function LaunchWorkbench
  Exec '"$SYSDIR\wscript.exe" "$INSTDIR\launcher\invoke.vbs" start'
FunctionEnd

Section "安装" SEC_MAIN
  SetShellVarContext current

  ; 升级前先停止正在运行的旧服务。首次安装时该文件不存在。
  IfFileExists "$INSTDIR\launcher\invoke.vbs" 0 +2
    ExecWait '"$SYSDIR\wscript.exe" "$INSTDIR\launcher\invoke.vbs" stop' $0

  CreateDirectory "$INSTDIR\launcher"
  CreateDirectory "$INSTDIR\versions\${VERSION}"
  CreateDirectory "$INSTDIR\config"
  CreateDirectory "$INSTDIR\data"
  CreateDirectory "$INSTDIR\logs"
  CreateDirectory "$INSTDIR\backups"

  SetOutPath "$INSTDIR\launcher"
  File /r "${STAGE_DIR}\launcher\*.*"

  SetOutPath "$INSTDIR\versions\${VERSION}"
  File /r "${STAGE_DIR}\version\*.*"

  IfFileExists "$INSTDIR\config\app.env" +3 0
    SetOutPath "$INSTDIR\config"
    File /oname=app.env "${STAGE_DIR}\app.env.example"

  ; 新版本自带的 Node 执行安装准备、备份、切换与健康检查。
  ExecWait '"$INSTDIR\versions\${VERSION}\runtime\node.exe" "$INSTDIR\launcher\launcher.mjs" prepare-install --quiet' $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "无法设置安装目录权限。请确认目标是本机 NTFS 磁盘，且当前用户具有写入权限。"
    Abort
  ${EndIf}

  ExecWait '"$INSTDIR\versions\${VERSION}\runtime\node.exe" "$INSTDIR\launcher\launcher.mjs" backup-rollback --quiet' $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "无法创建升级前备份，安装已停止。"
    Abort
  ${EndIf}

  ExecWait '"$INSTDIR\versions\${VERSION}\runtime\node.exe" "$INSTDIR\launcher\launcher.mjs" activate ${VERSION} --quiet' $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "无法启用新版本，安装已停止。"
    Abort
  ${EndIf}

  ExecWait '"$INSTDIR\versions\${VERSION}\runtime\node.exe" "$INSTDIR\launcher\launcher.mjs" verify --quiet' $0
  ${If} $0 != 0
    ${If} $IsUpgrade == "1"
      ExecWait '"$INSTDIR\versions\${VERSION}\runtime\node.exe" "$INSTDIR\launcher\launcher.mjs" rollback --quiet' $1
      MessageBox MB_ICONSTOP "新版本未能通过启动检查，已尝试恢复上一版本。详情请查看 $INSTDIR\logs。"
    ${Else}
      MessageBox MB_ICONSTOP "工作台未能通过启动检查。详情请查看 $INSTDIR\logs。"
    ${EndIf}
    Abort
  ${EndIf}

  WriteRegStr HKCU "${REG_KEY}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${REG_KEY}" "Version" "${VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "Personal AI Workbench"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  CreateDirectory "$SMPROGRAMS\个人AI工作台"
  CreateShortCut "$DESKTOP\个人AI工作台.lnk" "$SYSDIR\wscript.exe" '"$INSTDIR\launcher\invoke.vbs" start'
  CreateShortCut "$DESKTOP\停止工作台.lnk" "$SYSDIR\wscript.exe" '"$INSTDIR\launcher\invoke.vbs" stop'
  CreateShortCut "$DESKTOP\重启工作台.lnk" "$SYSDIR\wscript.exe" '"$INSTDIR\launcher\invoke.vbs" restart'
  CreateShortCut "$DESKTOP\卸载工作台.lnk" "$INSTDIR\Uninstall.exe"
  CreateShortCut "$SMPROGRAMS\个人AI工作台\个人AI工作台.lnk" "$SYSDIR\wscript.exe" '"$INSTDIR\launcher\invoke.vbs" start'
  CreateShortCut "$SMPROGRAMS\个人AI工作台\停止工作台.lnk" "$SYSDIR\wscript.exe" '"$INSTDIR\launcher\invoke.vbs" stop'
  CreateShortCut "$SMPROGRAMS\个人AI工作台\重启工作台.lnk" "$SYSDIR\wscript.exe" '"$INSTDIR\launcher\invoke.vbs" restart'
  CreateShortCut "$SMPROGRAMS\个人AI工作台\导出本地备份.lnk" "$SYSDIR\wscript.exe" '"$INSTDIR\launcher\invoke.vbs" backup'
  CreateShortCut "$SMPROGRAMS\个人AI工作台\卸载.lnk" "$INSTDIR\Uninstall.exe"
SectionEnd

Function un.onInit
  SetShellVarContext current
  StrCpy $DeleteUserData "0"
FunctionEnd

Function un.DataPage
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 30u "默认仅删除程序和快捷方式，配置、数据库与备份会保留在原安装目录。"
  Pop $1
  ${NSD_CreateCheckbox} 0 42u 100% 20u "同时永久删除所有本地配置、数据和备份"
  Pop $DeleteDataCheckbox
  ${NSD_Uncheck} $DeleteDataCheckbox
  nsDialogs::Show
FunctionEnd

Function un.DataPageLeave
  ${NSD_GetState} $DeleteDataCheckbox $DeleteUserData
  ${If} $DeleteUserData == ${BST_CHECKED}
    MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "此操作将永久删除工作台数据库、Outlook 本地状态、密钥配置和所有备份，且无法撤销。确定继续吗？" IDYES +2
      StrCpy $DeleteUserData "0"
  ${EndIf}
FunctionEnd

Section "Uninstall"
  SetShellVarContext current
  IfFileExists "$INSTDIR\launcher\invoke.vbs" 0 +2
    ExecWait '"$SYSDIR\wscript.exe" "$INSTDIR\launcher\invoke.vbs" stop' $0

  Delete "$DESKTOP\个人AI工作台.lnk"
  Delete "$DESKTOP\停止工作台.lnk"
  Delete "$DESKTOP\重启工作台.lnk"
  Delete "$DESKTOP\卸载工作台.lnk"
  RMDir /r "$SMPROGRAMS\个人AI工作台"
  RMDir /r "$INSTDIR\launcher"
  RMDir /r "$INSTDIR\versions"
  Delete "$INSTDIR\current.json"
  Delete "$INSTDIR\Uninstall.exe"

  ${If} $DeleteUserData == ${BST_CHECKED}
    RMDir /r "$INSTDIR\config"
    RMDir /r "$INSTDIR\data"
    RMDir /r "$INSTDIR\logs"
    RMDir /r "$INSTDIR\backups"
  ${EndIf}

  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  DeleteRegKey HKCU "${REG_KEY}"
  RMDir "$INSTDIR"
SectionEnd
