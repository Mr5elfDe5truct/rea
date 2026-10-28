; REA Windows installer (per-user, no administrator rights required).
; Built by packaging/windows/build.sh, which passes VERSION and STAGE_DIR.

Unicode true
SetCompressor /SOLID lzma
RequestExecutionLevel user

!ifndef VERSION
  !error "Pass -DVERSION=x.y.z"
!endif
!ifndef STAGE_DIR
  !error "Pass -DSTAGE_DIR=<staged files>"
!endif
!ifndef OUT_FILE
  !define OUT_FILE "REA-Setup-${VERSION}-x64.exe"
!endif

!define APP_NAME "REA"
!define APP_FULL_NAME "REA - Reverse Engineer Anything"
!define PUBLISHER "REA contributors"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\REA"

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "x64.nsh"

Name "${APP_FULL_NAME}"
OutFile "${OUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\REA"
InstallDirRegKey HKCU "${UNINSTALL_KEY}" "InstallLocation"
BrandingText "${APP_NAME} ${VERSION}"

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${APP_FULL_NAME}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "FileDescription" "${APP_NAME} installer"
VIAddVersionKey "LegalCopyright" "MIT License"
VIAddVersionKey "CompanyName" "${PUBLISHER}"

!define MUI_ICON "rea.ico"
!define MUI_UNICON "rea.ico"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TEXT "This will install ${APP_NAME} ${VERSION} for the current user.$\r$\n$\r$\nYou get the REA desktop app and the rea command, which is added to your user PATH. REA bundles its own private Node.js runtime, so nothing else needs to be installed.$\r$\n$\r$\nGhidra, IDA and Hopper stay optional and bring-your-own.$\r$\n$\r$\nClick Next to continue."
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Open REA"
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchDesktopApp
!define MUI_FINISHPAGE_SHOWREADME ""
!define MUI_FINISHPAGE_SHOWREADME_TEXT "Configure my AI agents now (rea setup)"
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION RunAgentSetup
!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${STAGE_DIR}\LICENSE.txt"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_COMPONENTS
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "REA requires 64-bit Windows 10 or later."
    Abort
  ${EndIf}
FunctionEnd

Function RunAgentSetup
  Exec '"$SYSDIR\cmd.exe" /k ""$INSTDIR\bin\rea.cmd" setup"'
FunctionEnd

Function LaunchDesktopApp
  Exec '"$INSTDIR\REA.exe"'
FunctionEnd

; REA.exe cannot be replaced or removed while the desktop app is open.
!macro WaitForDesktopAppClosed UN
  Function ${UN}WaitForDesktopAppClosed
    ${DoWhile} ${FileExists} "$INSTDIR\REA.exe"
      ClearErrors
      Delete "$INSTDIR\REA.exe"
      ${IfNot} ${Errors}
        ${ExitDo}
      ${EndIf}
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "REA is still open. Close the REA window, then click Retry." /SD IDCANCEL IDRETRY retry
      Abort
      retry:
    ${Loop}
  FunctionEnd
!macroend
!insertmacro WaitForDesktopAppClosed ""
!insertmacro WaitForDesktopAppClosed "un."

; The desktop app renders with Microsoft Edge WebView2, which ships with
; Windows 11 and current Windows 10. The rea command works without it.
Function CheckWebView2
  ReadRegStr $0 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ${If} $0 == ""
  ${OrIf} $0 == "0.0.0.0"
    ReadRegStr $0 HKCU "Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ${EndIf}
  ${If} $0 == ""
  ${OrIf} $0 == "0.0.0.0"
    MessageBox MB_YESNO|MB_ICONINFORMATION "The REA desktop app needs the Microsoft Edge WebView2 Runtime, which was not found on this PC. The rea command works without it.$\r$\n$\r$\nOpen the WebView2 download page now?" /SD IDNO IDNO +2
    ExecShell "open" "https://developer.microsoft.com/microsoft-edge/webview2/"
  ${EndIf}
FunctionEnd

!macro EditUserPath ACTION
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\path.ps1" -Action ${ACTION} -Directory "$INSTDIR\bin"'
  Pop $0
  ${If} $0 != 0
    DetailPrint "Could not update the user PATH (exit code $0)."
  ${EndIf}
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
!macroend

Section "REA" SecMain
  SectionIn RO
  SetShellVarContext current

  Call WaitForDesktopAppClosed
  ; Replace the runtime and application wholesale so an upgrade leaves no stale modules.
  RMDir /r "$INSTDIR\app"
  RMDir /r "$INSTDIR\node"
  RMDir /r "$INSTDIR\bin"

  SetOutPath "$INSTDIR"
  File /r "${STAGE_DIR}\*.*"
  File "rea.ico"
  File "path.ps1"

  WriteUninstaller "$INSTDIR\Uninstall REA.exe"

  !insertmacro EditUserPath add

  CreateDirectory "$SMPROGRAMS\REA"
  CreateShortcut "$SMPROGRAMS\REA\REA.lnk" "$INSTDIR\REA.exe" "" "$INSTDIR\REA.exe"
  CreateShortcut "$SMPROGRAMS\REA\REA Command Prompt.lnk" "$SYSDIR\cmd.exe" '/k ""$INSTDIR\bin\rea-shell.cmd""' "$INSTDIR\rea.ico"
  CreateShortcut "$SMPROGRAMS\REA\Configure AI Agents (rea setup).lnk" "$SYSDIR\cmd.exe" '/k ""$INSTDIR\bin\rea.cmd" setup"' "$INSTDIR\rea.ico"
  CreateShortcut "$SMPROGRAMS\REA\Uninstall REA.lnk" "$INSTDIR\Uninstall REA.exe"

  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "${APP_FULL_NAME}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "${PUBLISHER}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "URLInfoAbout" "https://rea.tools/"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\rea.ico"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall REA.exe"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall REA.exe" /S'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "EstimatedSize" "$0"

  Call CheckWebView2
SectionEnd

Section "Desktop shortcut" SecDesktop
  SetShellVarContext current
  CreateShortcut "$DESKTOP\REA.lnk" "$INSTDIR\REA.exe" "" "$INSTDIR\REA.exe"
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecMain} "The REA desktop app, the rea command, and its private Node.js runtime."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecDesktop} "Adds an REA shortcut to your desktop."
!insertmacro MUI_FUNCTION_DESCRIPTION_END

Section "-un.Close the desktop app"
  Call un.WaitForDesktopAppClosed
SectionEnd

; Runs early so REA can still read its own configuration ownership records.
Section "un.Remove REA agent integrations (MCP entries and skills)" UnSecAgents
  DetailPrint "Removing REA agent integrations..."
  nsExec::ExecToLog '"$INSTDIR\node\node.exe" "$INSTDIR\app\node_modules\rea-agents\scripts\rea.mjs" uninstall'
  Pop $0
SectionEnd

Section /o "un.Also delete REA caches and saved analysis state" UnSecPurge
  DetailPrint "Deleting REA caches and state..."
  nsExec::ExecToLog '"$INSTDIR\node\node.exe" "$INSTDIR\app\node_modules\rea-agents\scripts\rea.mjs" uninstall --purge-data'
  Pop $0
  ; Desktop app settings and its WebView2 cache.
  RMDir /r "$APPDATA\tools.rea.desktop"
  RMDir /r "$LOCALAPPDATA\tools.rea.desktop"
SectionEnd

Section "-un.Program files"
  SetShellVarContext current
  !insertmacro EditUserPath remove

  RMDir /r "$SMPROGRAMS\REA"
  Delete "$DESKTOP\REA.lnk"
  RMDir /r "$INSTDIR\app"
  RMDir /r "$INSTDIR\node"
  RMDir /r "$INSTDIR\bin"
  Delete "$INSTDIR\WebView2Loader.dll"
  Delete "$INSTDIR\LICENSE.txt"
  Delete "$INSTDIR\NODE_LICENSE.txt"
  Delete "$INSTDIR\THIRD_PARTY_NOTICES.md"
  Delete "$INSTDIR\rea.ico"
  Delete "$INSTDIR\path.ps1"
  Delete "$INSTDIR\Uninstall REA.exe"
  RMDir "$INSTDIR"

  DeleteRegKey HKCU "${UNINSTALL_KEY}"
SectionEnd

!insertmacro MUI_UNFUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${UnSecAgents} "Runs rea uninstall to remove the MCP server entries and skill files REA added to your AI agents."
  !insertmacro MUI_DESCRIPTION_TEXT ${UnSecPurge} "Runs rea uninstall --purge-data to also delete REA caches and saved state, and removes the desktop app's settings."
!insertmacro MUI_UNFUNCTION_DESCRIPTION_END
