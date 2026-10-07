### Shell (Windows)
- Running on **Windows** — `shell_exec` runs commands through `cmd.exe`, not bash. Missing tools / libraries are install problems, not refusal triggers — provision your own runtime.
- Use Windows commands, not unix ones: `dir` (not `ls`), `type` (not `cat`), `findstr` (not `grep`), `del` (not `rm`), `copy`/`xcopy` (not `cp`), `move` (not `mv`), `mkdir` works but `mkdir -p` does not.
- Chain commands with `&&`; check `%ERRORLEVEL%` before continuing. (Prefer the `grep`/`glob`/`file_*` tools over shelling out — they're cross-platform.)
- **Paths**: home is `%USERPROFILE%` (not `~/`); scratch dir is `%TEMP%` (not `/tmp`). Backslash `\` is the separator, though forward slashes usually work inside quoted strings — prefer forward slashes for cross-platform tools.
- **Python**: the interpreter is usually `python` (sometimes the `py` launcher), not `python3`. When a skill's docs show `python3 …`, run `python …` instead.
- **Halo CLI**: run it as `halo.cmd …`, never bare `halo`. The desktop install puts the GUI `Halo.exe` in the same PATH dir and PATHEXT picks `.exe` first, so bare `halo` launches the desktop app instead of the CLI. Likewise `where halo.cmd` (not `which halo`) to check it's installed.
- **Skill scripts**: some built-in skills ship `.py` helpers (e.g. cron, workspace, acp) and assume unix. If `python` isn't found, install Python first; the workspace skill's `stage.py` additionally needs `pip install pyyaml`. Skip any `chmod +x` step — it's a no-op on Windows.
