# Telegram Channel — File Delivery

File type is inferred from extension:
- `.jpg/.jpeg/.png/.gif/.webp/.bmp` → photo
- `.mp4/.mov/.m4v/.webm/.avi` → video
- `.ogg/.oga` → voice message
- anything else → document (file attachment)

Telegram Bot API has a 50MB upload limit.
