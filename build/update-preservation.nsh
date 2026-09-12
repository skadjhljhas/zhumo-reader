!ifndef ZHUMO_PRESERVATION_INCLUDED
!define ZHUMO_PRESERVATION_INCLUDED
!include "LogicLib.nsh"

; The caller must stage a trusted *new* runtime outside all old installation/profile roots.
; Call before uninstallOldVersion, not from customInstall (which runs too late).
; This hook does not kill applications and does not grant a lifetime update lock.
!macro ZhuMoCaptureBeforeUninstall HELPER_EXE HELPER_SCRIPT PLAN_FILE OLD_INSTALL_ROOT
  Push $R8
  Push $R9
  ReadEnvStr $R8 "ELECTRON_RUN_AS_NODE"
  System::Call 'kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "1") i.R9'
  ${If} $R9 == 0
    Pop $R9
    Pop $R8
    SetErrorLevel 41
    Abort "Cannot start the isolated preservation helper. Old files were not removed."
  ${EndIf}
  ClearErrors
  ExecWait '"${HELPER_EXE}" "${HELPER_SCRIPT}" --plan "${PLAN_FILE}" --installation-root "${OLD_INSTALL_ROOT}"' $R9
  ${If} ${Errors}
    StrCpy $R9 42
  ${EndIf}
  ${If} $R8 == ""
    System::Call 'kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", p 0)'
  ${Else}
    System::Call 'kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t R8)'
  ${EndIf}
  ${If} $R9 != 0
    Pop $R9
    Pop $R8
    SetErrorLevel 43
    Abort "Preservation failed. Save and close ZhuMo, then retry. Old files were not removed."
  ${EndIf}
  Pop $R9
  Pop $R8
!macroend
!endif
