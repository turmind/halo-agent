# WeCom Channel — File Delivery

The bot uploads the file as a temporary media asset over the same long-connect socket, then replies with the matching message type. Type is inferred from extension, and WeCom is stricter than Feishu about which formats render inline:

- `.png/.jpg/.jpeg/.gif` → image (renders inline)
- `.mp4`                 → video (renders as a player)
- anything else          → generic file (download card) — this includes `.webp/.bmp`, `.mov/.webm`, PDFs, audio, archives

There is no voice-bubble path: WeCom voice requires `amr`, which the agent never produces, so audio always goes as a file. Hard limit is 20 MB per file — larger files fail and the bot posts a short upload-failed note instead.

If an image must render inline, convert to png/jpg first:

```bash
ffmpeg -i input.webp output.png -y
```
