---
name: send-file
requiresAccess: workspace
description: Send images, videos, or files as attachments to the current user. Works on all channels (Web, WeChat, Telegram, Slack, Feishu). Use when the user asks to send a file, or when an attachment (screenshot, PDF, chart, generated artifact) is more useful than inline text.
---
# Send File

To send a file, emit a line `MEDIA:<absolute_path>` by itself in your reply. The channel intercepts these lines and delivers them as attachments. The marker is stripped from the visible text.

Multiple `MEDIA:` lines in one reply = multiple attachments.

## Rules

- Marker must be alone on a line. No leading spaces, no inline text.
- Path must be absolute and the file must exist. Verify with `file_list` if unsure.
- Write normal text around `MEDIA:` lines for context.

## Example

```
Report is ready — the main findings are in the PDF.

MEDIA:/home/user/project/reports/april-2026.pdf
```

## Channel-specific behavior

Each channel handles the file differently based on platform capabilities (size limits, type mapping). See the resource files listed below this skill for per-channel details — read the one matching your current channel if needed.
