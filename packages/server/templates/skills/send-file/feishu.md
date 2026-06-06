# Feishu Channel — File Delivery

The bot uploads to Feishu's media bucket (`/open-apis/im/v1/images` for images, `/open-apis/im/v1/files` for everything else), then posts the matching `msg_type` into the chat. File type is inferred from extension:

- `.jpg/.jpeg/.png/.gif/.webp/.bmp` → image (renders inline)
- `.mp4/.mov/.webm/.m4v/.avi`       → video (renders as a player card)
- `.opus`                           → voice message (audio bubble — Feishu only renders opus codec; mp3/ogg fall through to the generic file path)
- anything else                     → generic file (download card)

In group chats the file is delivered as a reply inside the conversation thread; in 1-on-1 chats it goes directly to the chat. Feishu's hard upload limit is 30 MB per file.

If you need a true voice-bubble for non-opus audio, convert first:

```bash
ffmpeg -i input.mp3 -c:a libopus -b:a 24k -ar 16000 output.opus -y
```
