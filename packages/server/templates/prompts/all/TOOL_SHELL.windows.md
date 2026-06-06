### Shell (Windows)
- Running on **Windows** — `shell_exec` runs commands through `cmd.exe`, not bash.
- Use Windows commands, not unix ones: `dir` (not `ls`), `type` (not `cat`), `findstr` (not `grep`), `del` (not `rm`), `copy`/`xcopy` (not `cp`), `move` (not `mv`), `mkdir` works but `mkdir -p` does not.
- Chain commands with `&&`; check `%ERRORLEVEL%` before continuing. (Prefer the `grep`/`glob`/`file_*` tools over shelling out — they're cross-platform.)
- **Paths**: home is `%USERPROFILE%` (not `~/`); scratch dir is `%TEMP%` (not `/tmp`). Backslash `\` is the separator, though forward slashes usually work inside quoted strings — prefer forward slashes for cross-platform tools.
- **Python**: the interpreter is usually `python` (sometimes the `py` launcher), not `python3`. When a skill's docs show `python3 …`, run `python …` instead.
- **Skill scripts**: some built-in skills ship `.py` helpers (e.g. manage-cron-jobs, share-workspace, create-halo-acp) and assume unix. If `python` isn't found, install Python first; `share-workspace`'s `stage.py` additionally needs `pip install pyyaml`. Skip any `chmod +x` step — it's a no-op on Windows.
