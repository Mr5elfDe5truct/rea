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
!define MUI_WELCOMEPAGE_TEXT "This will install ${APP_NAME} ${VERSION} for the current user.$\r$\n$\r$\nREA bundles its own private Node.js runtime, so nothing else needs to be installed. The rea command is added to your user PATH.$\r$\n$\r$\nGhidra, IDA and Hopper stay optional and bring-your-own.$\r$\n$\r$\nClick Next to continue."
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Configure my AI agents now (rea setup)"
!define MUI_FINISHPAGE_RUN_FUNCTION RunAgentSetup
!define MUI_FINISHPAGE_RUN_NOTCHECKED
!define MUI_FINISHPAGE_SHOWREADME "https://rea.tools/guides/"
!define MUI_FINISHPAGE_SHOWREADME_TEXT "Open the REA guides"
!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${STAGE_DIR}\LICENSE.txt"
!insertmacro MUI_PAGE_DIRECTORY
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
SectionEnd

; Runs first so REA can still read its own configuration ownership records.
Section "un.Remove REA agent integrations (MCP entries and skills)" UnSecAgents
  DetailPrint "Removing REA agent integrations..."
  nsExec::ExecToLog '"$INSTDIR\node\node.exe" "$INSTDIR\app\node_modules\rea-agents\scripts\rea.mjs" uninstall'
  Pop $0
SectionEnd

Section /o "un.Also delete REA caches and saved analysis state" UnSecPurge
  DetailPrint "Deleting REA caches and state..."
  nsExec::ExecToLog '"$INSTDIR\node\node.exe" "$INSTDIR\app\node_modules\rea-agents\scripts\rea.mjs" uninstall --purge-data'
  Pop $0
SectionEnd

Section "-un.Program files"
  SetShellVarContext current
  !insertmacro EditUserPath remove

  RMDir /r "$SMPROGRAMS\REA"
  RMDir /r "$INSTDIR\app"
  RMDir /r "$INSTDIR\node"
  RMDir /r "$INSTDIR\bin"
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
  !insertmacro MUI_DESCRIPTION_TEXT ${UnSecPurge} "Runs rea uninstall --purge-data to also delete REA caches and saved state."
!insertmacro MUI_UNFUNCTION_DESCRIPTION_END
