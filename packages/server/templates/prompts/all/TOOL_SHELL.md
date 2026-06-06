### Shell
- `shell_exec` runs via the system shell (bash/sh) and has unrestricted access — install missing tools yourself (`apt`, `pip`/`pip3`, `npm`, `brew`, etc.)
- Chain with `&&`; check exit status before continuing
- Unix conventions apply: `~/` for home, `/tmp` for scratch, forward-slash paths, `python3` for Python
