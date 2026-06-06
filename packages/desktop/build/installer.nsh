; Custom NSIS hooks for the Halo installer.
;
; On install we drop a `halo.cmd` launcher into $INSTDIR and add $INSTDIR to
; the current user's PATH so `halo tui` / `halo cli` work from any terminal.
; The launcher runs the bundled node.exe against the staged cli-runtime bundle,
; so the CLI needs no system Node install. On uninstall we remove both.
;
; PATH editing is delegated to a tiny PowerShell helper (written to $INSTDIR)
; rather than hand-rolled NSIS string surgery: PowerShell ships on every
; supported Windows (10+), [Environment]::SetEnvironmentVariable(...,'User')
; writes HKCU and auto-broadcasts WM_SETTINGCHANGE, and the filter-then-rejoin
; logic is idempotent and safe to run on uninstall (a buggy hand-rolled PATH
; edit could corrupt the user's PATH — not worth the risk).

; Emit halo-path.ps1 next to the app. Stays after install so the uninstaller
; can reuse it; deleted in customUnInstall. Escaping: NSIS expands `$`, so the
; PowerShell `$` sigils are written as `$$`; the script uses single-quoted PS
; strings so no `"` collides with the NSIS double-quoted FileWrite args.
!macro WritePathHelper
  FileOpen $9 "$INSTDIR\halo-path.ps1" w
  FileWrite $9 "param([string]$$Action,[string]$$Dir)$\r$\n"
  FileWrite $9 "$$p=[Environment]::GetEnvironmentVariable('Path','User'); if(-not $$p){$$p=''}$\r$\n"
  FileWrite $9 "$$parts=@($$p -split ';' | Where-Object {$$_ -ne '' -and $$_ -ne $$Dir})$\r$\n"
  FileWrite $9 "if($$Action -eq 'add'){$$parts+=$$Dir}$\r$\n"
  FileWrite $9 "[Environment]::SetEnvironmentVariable('Path',($$parts -join ';'),'User')$\r$\n"
  FileClose $9
!macroend

; --- electron-builder hooks ------------------------------------------------

!macro customInstall
  ; Launcher: bundled node.exe + the cli-runtime esbuild bundle. %~dp0 is the
  ; .cmd's own dir ($INSTDIR with trailing backslash), so the app stays
  ; relocatable. %* forwards all args (tui / cli "<prompt>" / setup / …).
  FileOpen $0 "$INSTDIR\halo.cmd" w
  FileWrite $0 "@echo off$\r$\n"
  FileWrite $0 '"%~dp0resources\node.exe" "%~dp0resources\cli-runtime\dist\index.js" %*$\r$\n'
  FileClose $0

  !insertmacro WritePathHelper
  nsExec::Exec 'powershell -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\halo-path.ps1" add "$INSTDIR"'
!macroend

!macro customUnInstall
  Delete "$INSTDIR\halo.cmd"
  ; halo-path.ps1 survives install, so it's here to run on uninstall too.
  IfFileExists "$INSTDIR\halo-path.ps1" 0 +3
    nsExec::Exec 'powershell -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\halo-path.ps1" remove "$INSTDIR"'
    Delete "$INSTDIR\halo-path.ps1"
!macroend
