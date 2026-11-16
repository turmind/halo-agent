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

; Kill everything still running from $INSTDIR. The stock check (taskkill /im
; Halo.exe) kills only Halo.exe — but Halo spawns a child `node.exe` (the
; server, holding port 9527 + ~/.halo/global/server.lock). Closing the Halo
; window without a clean before-quit (or a crash) orphans that node.exe; it
; survives, keeps the lock, and the installer keeps reporting "still running"
; even after the user closed Halo. `/T` walks the whole tree (Halo.exe + its
; node.exe children), `/F` forces it. Silent + idempotent: taskkill on a
; not-running process just no-ops, so this is safe to run unconditionally and
; avoids the stock check's modal-prompt-and-retry loop.
;
; Second pass: an ALREADY-orphaned process (its Halo.exe parent died without
; a clean quit — app.exit() paths in older builds, Task Manager "End process",
; Windows shutdown races) is unreachable by `/im Halo.exe /T`: the tree walk
; starts from Halo.exe pids and there are none. That orphan still holds
; locks inside $INSTDIR, so the upgrade hits "file in use" retry prompts — the
; exact "still running even after I closed it" report. Kill EVERY process
; whose image lives under $INSTDIR, not just node.exe: node-pty's
; OpenConsole.exe (resources\*-runtime\node_modules\node-pty\prebuilds\…\
; conpty\) outlives a killed server the same way, and so would any exe a
; future dependency ships. A user's own processes (system node.exe, shells)
; have images elsewhere and never match. PowerShell is already a dependency
; of this installer (PATH helper above). `$$_` is NSIS-escaping for a literal
; PowerShell `$_`.
;
; Our own pid is excluded: the old uninstaller normally runs from
; $PLUGINSDIR (%TEMP%), but electron-builder falls back to running it in
; place ($INSTDIR\Uninstall Halo.exe) when the temp copy can't launch, and
; this macro runs inside the uninstaller too (un.onInit → CHECK_APP_RUNNING).
;
; Match on Win32_Process.ExecutablePath, NOT Get-Process .Path: the NSIS
; installer is a 32-bit process, so the `powershell` it launches is the 32-bit
; one (SysWOW64), and there Get-Process can't read a 64-bit process's module
; path — .Path is empty, the filter matches nothing, and the orphan survives.
; CIM reads the image path from any bitness.
;
; $INSTDIR reaches PowerShell through the env (HALO_INSTDIR, inherited by the
; nsExec child), NOT spliced into the command: inside a PS '...' literal a `'`
; in the path ends the string, and `-like` reads `[` / `]` as wildcards. The
; match is a literal case-insensitive prefix test instead.
!macro haloKillInstDirProcesses
  nsExec::Exec '"$SYSDIR\taskkill.exe" /im "${APP_EXECUTABLE_FILENAME}" /T /F'
  System::Call 'kernel32::SetEnvironmentVariable(t "HALO_INSTDIR", t "$INSTDIR")'
  System::Call 'kernel32::GetCurrentProcessId() i .r9'
  nsExec::Exec `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $$_.ProcessId -ne $9 -and $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$env:HALO_INSTDIR + '\', [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
  Sleep 500   ; give the OS a moment to release the file locks before we overwrite
!macroend

; Upgrade fallback when the OLD version's uninstaller fails. electron-builder
; runs it (`uninstallOldVersion`, 5 attempts) before extracting; its update-
; mode atomicRMDir renames every file into %TEMP%, and a single file it can't
; move — a lock held by something outside $INSTDIR (antivirus, indexer, an
; editor), a path over MAX_PATH in an older build — aborts it with a non-zero
; exit. Stock handling then shows "Halo cannot be closed" (Retry / Cancel),
; and on Cancel "Failed to uninstall old application files" and QUITS — the
; user is stuck on the old version with no way forward but deleting the
; install dir by hand. Defining these hooks replaces that stock result check
; (handleUninstallResult inserts the macro and returns before its own
; IfErrors / $R0 test), so the failure test is ours: on any failure, kill
; again, wipe $INSTDIR ourselves and carry on — extraction rewrites every
; file. The Halo.exe guard keeps RMDir off a directory that isn't a Halo
; install. User data lives in ~/.halo and %APPDATA%\Halo, never $INSTDIR.
; The Retry / Cancel prompt itself sits inside uninstallOldVersion's loop with
; no hook, so it still appears once; Cancel now continues instead of quitting.
!macro haloUnInstallCheck
  ${if} ${Errors}
  ${orIf} $R0 != 0
    DetailPrint `Old uninstaller failed (code $R0), removing "$INSTDIR" and continuing.`
    !insertmacro haloKillInstDirProcesses
    ${if} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      RMDir /r $INSTDIR
    ${endif}
    ClearErrors
  ${endif}
!macroend

; --- electron-builder hooks ------------------------------------------------

; Override the default "app is running" check. Runs before the old
; uninstaller (and inside the uninstaller's un.onInit), so clearing our own
; processes here removes the main cause of the uninstall failure up front.
!macro customCheckAppRunning
  !insertmacro haloKillInstDirProcesses
!macroend

!macro customUnInstallCheck
  !insertmacro haloUnInstallCheck
!macroend

!macro customUnInstallCheckCurrentUser
  !insertmacro haloUnInstallCheck
!macroend

!macro customInstall
  ; Launcher: bundled node.exe + the cli-runtime esbuild bundle. %~dp0 is the
  ; .cmd's own dir ($INSTDIR with trailing backslash), so the app stays
  ; relocatable. %* forwards all args (tui / cli "<prompt>" / setup / …).
  ; HALO_FRONTEND_DIR: the Windows build ships no cli-runtime\admin-out (stage-
  ; runtime.mjs pruneCliAdminOut), so `halo server start` serves the same
  ; resources\admin-out the desktop app's server does.
  FileOpen $0 "$INSTDIR\halo.cmd" w
  FileWrite $0 "@echo off$\r$\n"
  FileWrite $0 'if not defined HALO_FRONTEND_DIR set "HALO_FRONTEND_DIR=%~dp0resources\admin-out"$\r$\n'
  FileWrite $0 '"%~dp0resources\node.exe" "%~dp0resources\cli-runtime\bin\halo.js" %*$\r$\n'
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
