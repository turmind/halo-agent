# A2A Channel — File Delivery

`MEDIA:` lines in your final reply are attached to the A2A task result as image parts. The caller receives the bytes, and the marker lines are stripped from the result text.

- Images only: `.png/.jpg/.jpeg/.gif/.webp`.
- Each file can be at most 5 MB, and all files in one result together at most 10 MB.
- A file that is refused (wrong type, too large, missing, or outside the paths your access level may send) is not attached. A `[file not attached: <name> — <reason>]` line goes in its place, so the caller knows.

To send another format, convert it first:

```bash
ffmpeg -i input.bmp output.png -y
```
