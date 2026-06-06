# User Guide

Aimed at Halo end-users. Pick the doc that matches your situation.

## Suggested order

1. [getting-started.md](getting-started.md) — opening Halo for the first time (login, workspace, first conversation)
2. [workspace.md](workspace.md) — interface layout, Activity Bar, keyboard shortcuts
3. [chat.md](chat.md) — everything the chat panel does (agent selection, slash commands, `@` file mentions, context injection)
4. [agents.md](agents.md) — creating, editing, configuring agents
5. [skills.md](skills.md) — skill concepts, creating skills, attaching them to agents
6. [sessions.md](sessions.md) — viewing session history, debug mode, multi-agent collaboration

## Channels — talk to your agent from somewhere other than the admin UI

[channels/README.md](channels/README.md) is the index. Per-channel onboarding (how to register the bot, what credentials to paste in admin):

- [Web](channels/web.md) — token-based HTTP + SSE for browsers / custom clients
- [Telegram](channels/telegram.md) — BotFather token, long-poll
- [Slack](channels/slack.md) — Socket Mode (no public webhook needed)
- [Feishu / Lark](channels/feishu.md) — long-connect with appId + appSecret
- [WeChat](channels/wechat.md) — QR-scan iLink bot
- [ACP](channels/acp.md) — Claude Code or other ACP clients driving a remote halo

## Related docs

- Development: [dev/](../dev/) — environment, API, tool reference
- Architecture: [design/](../design/) — implementation details and data flow
- Requirements: [requirements/](../requirements/) — per-module feature definitions
