!include "LogicLib.nsh"
!include "StrFunc.nsh"
!include "WinMessages.nsh"

!ifdef BUILD_UNINSTALLER
  ${UnStrRep}
!else
  ${StrStr}
!endif

!define TASKBOARD_ENV_KEY "Environment"
!define TASKBOARD_OWNED_PATH_KEY "Software\AI Taskboard"

!macro ReadTaskboardUserPath
  StrCpy $3 1
  ClearErrors
  ReadRegStr $0 HKCU "${TASKBOARD_ENV_KEY}" "Path"
  ${If} ${Errors}
    # A missing Path is safe to create. An existing unreadable value is not safe to replace.
    StrCpy $0 ""
    StrCpy $1 0
    ${Do}
      EnumRegValue $2 HKCU "${TASKBOARD_ENV_KEY}" $1
      ${If} $2 == ""
        ${ExitDo}
      ${EndIf}
      ${If} $2 == "Path"
        StrCpy $3 0
        ${ExitDo}
      ${EndIf}
      IntOp $1 $1 + 1
    ${Loop}
  ${EndIf}
!macroend

!macro customInstall
  Push $0
  Push $1
  Push $2
  Push $3
  !insertmacro ReadTaskboardUserPath
  ${If} $3 == 1
    StrLen $1 $0
    StrLen $2 "$INSTDIR\resources\bin"
    IntOp $1 $1 + $2
    IntOp $1 $1 + 3
    ${If} $1 < ${NSIS_MAX_STRLEN}
      StrCpy $1 ";$0;"
      ${StrStr} $2 $1 ";$INSTDIR\resources\bin;"
      ${If} $2 == ""
        ${If} $0 == ""
          StrCpy $0 "$INSTDIR\resources\bin"
        ${Else}
          StrCpy $0 "$0;$INSTDIR\resources\bin"
        ${EndIf}
        ClearErrors
        WriteRegExpandStr HKCU "${TASKBOARD_ENV_KEY}" "Path" $0
        ${IfNot} ${Errors}
          WriteRegStr HKCU "${TASKBOARD_OWNED_PATH_KEY}" "CliPath" "$INSTDIR\resources\bin"
          SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=1000
        ${EndIf}
      ${EndIf}
    ${Else}
      DetailPrint "The existing user PATH is too long to update safely."
    ${EndIf}
  ${Else}
    DetailPrint "The existing user PATH could not be read safely."
  ${EndIf}
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro customUnInstall
  Push $0
  Push $1
  Push $2
  Push $3
  ReadRegStr $2 HKCU "${TASKBOARD_OWNED_PATH_KEY}" "CliPath"
  ${If} $2 == "$INSTDIR\resources\bin"
    !insertmacro ReadTaskboardUserPath
    StrLen $1 $0
    IntOp $1 $1 + 3
    ${If} $3 == 1
    ${AndIf} $1 < ${NSIS_MAX_STRLEN}
      StrCpy $1 ";$0;"
      ${UnStrRep} $2 $1 ";$INSTDIR\resources\bin;" ";"
      ${If} $2 != $1
        StrCpy $0 $2 -1 1
        ClearErrors
        WriteRegExpandStr HKCU "${TASKBOARD_ENV_KEY}" "Path" $0
        ${IfNot} ${Errors}
          DeleteRegValue HKCU "${TASKBOARD_OWNED_PATH_KEY}" "CliPath"
          DeleteRegKey /ifempty HKCU "${TASKBOARD_OWNED_PATH_KEY}"
          SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=1000
        ${EndIf}
      ${Else}
        DeleteRegValue HKCU "${TASKBOARD_OWNED_PATH_KEY}" "CliPath"
        DeleteRegKey /ifempty HKCU "${TASKBOARD_OWNED_PATH_KEY}"
      ${EndIf}
    ${EndIf}
  ${EndIf}
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend
