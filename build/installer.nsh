# Windows installer additions (electron-builder's nsis.include, see package.json).
#
# From 0.3.0 on, Restart to update runs the downloaded installer with its
# window, so its progress shows while the app is closed: electron-updater
# passes --updated --force-run, without /S (main/updateEngine.js). The stock
# assisted installer would then ask "Anyone / Only me" and wait on its Finish
# page. On an update this file skips both: the installer keeps the existing
# installation's mode, shows the install progress, starts the new version and
# closes by itself. A fresh install looks as before. Installing on quit stays
# silent (/S), where none of these pages show.
#
# Each version's installer is run this way by the version before it, so this
# file must stay in the build for every later version.

!ifndef BUILD_UNINSTALLER
  # The install mode page (multiUserUi.nsh) is skipped when one of these is
  # set. Like the silent update, a per-machine installation elevates (UAC).
  !macro customInstallMode
    ${if} ${isUpdated}
      ${if} $hasPerMachineInstallation == "1"
        StrCpy $isForceMachineInstall "1"
      ${else}
        StrCpy $isForceCurrentInstall "1"
      ${endif}
    ${endif}
  !macroend

  # electron-builder's Finish page (assistedInstaller.nsh) with its Run
  # checkbox, except that an update started with --force-run starts the new
  # version (as installSection.nsh does for a silent one) and skips the page,
  # which ends the installer.
  !macro customFinishPage
    Function StartApp
      ${if} ${isUpdated}
        StrCpy $1 "--updated"
      ${else}
        StrCpy $1 ""
      ${endif}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
    FunctionEnd

    Function finishPageUnlessUpdated
      ${if} ${isUpdated}
      ${andIf} ${isForceRun}
        # otherwise the app's window opens behind the installer's
        HideWindow
        Call StartApp
        Abort
      ${endif}
    FunctionEnd

    !ifndef HIDE_RUN_AFTER_FINISH
      !define MUI_FINISHPAGE_RUN
      !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
    !endif
    !define MUI_PAGE_CUSTOMFUNCTION_PRE finishPageUnlessUpdated
    !insertmacro MUI_PAGE_FINISH
  !macroend
!endif
