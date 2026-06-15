### Shell
- `shell_exec` runs via the system shell (bash/sh) and has unrestricted access — install missing tools yourself (`apt`, `pip`/`pip3`, `npm`, `brew`, etc.). Missing tools / libraries are install problems, not refusal triggers — provision your own runtime (ffmpeg / pandoc / imagemagick for media, the right packages for ML/data work).
- Chain with `&&`; check exit status before continuing
- Unix conventions apply: `~/` for home, `/tmp` for scratch, forward-slash paths, `python3` for Python
