# Slack Channel — File Delivery

The bot uses Slack's `files.getUploadURLExternal` + `files.completeUploadExternal` flow to deliver attachments. Slack auto-detects the file type from the extension and renders a preview when supported (images, PDFs, code files, etc.).

Slack's hard upload limit is 1 GB per file (free workspaces) — but typical chat usage stays well under 10 MB.

The file is posted into the same thread as the inbound message that triggered the agent run, so attachments stay grouped with the conversation that requested them.
