---
name: Manage Cron Jobs
description: Create, list, edit, or delete scheduled cron tasks that run a halo agent on a cron schedule and optionally push the result to a chat channel (telegram / wechat / slack / feishu). Activate when the user asks to "add / create a cron job", "list cron tasks", "delete a scheduled task", or anything similar around recurring agent runs.
command: /manage-cron-jobs
requiresAccess: full
---

# Manage Cron Jobs

Halo runs a global cron daemon that executes user-defined agent prompts on a schedule and
optionally pushes the resulting text to a chat (telegram / wechat / slack / feishu). Use the
`manage-cron.py` helper script (sibling of this file) for every operation — it handles id
generation, JSON encoding for `targets`, timestamps, and so on, so you don't end up
handcrafting SQL.

The server's runner picks up changes within ~10 seconds (it polls the db on a reconcile
loop). No restart needed after edits.

## Steps

### 1. Confirm the user intent

- **list / show / view** → `list` (all) or `list --chat-id {{channel.chat_id}}`
  (only jobs that push to this chat — use this from inside a channel where
  the user means "my crons", not the global list) or `get <id>` for one job
- **add / create** → `create`. From inside a channel, default to pinning
  the result back to the current chat with `{{channel.chat_id}}` — the user
  almost always means "send it to me here"
- **edit / pause / resume** → `update`, `enable`, `disable`
- **delete / remove** → `delete`. From inside a channel the user won't
  know the cron `id`; first run `list --chat-id {{channel.chat_id}}` to find
  the matching job, confirm which one, then delete by id
- **history / runs** → `runs <jobId>`

When important fields are unclear (workspace, agent, exact schedule, channels), ask once.
Sensible defaults if user didn't say:

| Field      | Default                                                       |
|------------|----------------------------------------------------------------|
| workspace  | the user's current workspace (`pwd` / `/ws` output)           |
| agent      | `default`                                                     |
| timezone   | leave unset (host time)                                       |
| targets    | none (log only — the run shows in admin Cron tab)             |
| label      | summarize from prompt + schedule                              |

### 2. Translate the schedule

**Recurring (default)** — standard 5-field cron `minute hour day-of-month month day-of-week`:

| Spoken                              | Cron               |
|--------------------------------------|--------------------|
| every day at 9am                    | `0 9 * * *`        |
| every Monday at 10am                | `0 10 * * 1`       |
| every 15 minutes                    | `*/15 * * * *`     |
| every Sunday 8pm in Asia/Shanghai   | `0 20 * * 0` + tz `Asia/Shanghai` |
| first day of every month at noon    | `0 12 1 * *`       |

**One-shot (at-mode)** — pass `--run-at` instead of `--schedule`. The job
fires once at that instant and auto-disables. Useful for "remind me at 3pm
today" or "send the report next Monday morning".

| Spoken                            | Flag                                      |
|-----------------------------------|-------------------------------------------|
| at 3pm today                      | `--run-at 2026-05-23T15:00`               |
| next Monday at 9                  | `--run-at 2026-05-25T09:00`               |
| in 2 hours                        | `--run-at <iso-of-now+2h>`                |

Ambiguous time ("morning")? Ask once for the exact hour.

### 3. Channels (only when delivery is wanted)

Run `channels` first to see what's available:

```bash
shell_exec: python3 <skill-dir>/manage-cron.py channels
```

Output is a JSON array `[{channelType, accountId, label, ready}, ...]`.

#### Pinning the chatId — REQUIRED for telegram / slack / feishu

The cron dispatcher used to fall back to "whoever last messaged the bot"
when no chatId was given, but in practice that always pushed to a stranger.
**As of the current build, telegram / slack / feishu cron pushes require
an explicit chatId.** WeChat is the exception — it has a QR-bound owner
that's a stable single recipient.

The current chat context is injected as `{{channel.type}}`,
`{{channel.account_id}}`, `{{channel.chat_id}}` — when invoked from a
chat, you have these for free; just substitute them into `--targets`.

Format per channel:

| Channel  | Target syntax                                   | chatId shape                            |
|----------|-------------------------------------------------|-----------------------------------------|
| wechat   | `wechat:<accountId>` (chatId optional)          | `o-…` open id (if explicit)             |
| telegram | `telegram:<accountId>:<chatId>`                 | numeric (Telegram private-chat id)      |
| slack    | `slack:<accountId>:<chatId>`                    | `D…` (DM), `C…` (channel top), `C…:<thread_ts>` (thread) |
| feishu   | `feishu:<accountId>:<chatId>`                   | `oc_…` chat_id                          |

Comma-separated for multiple targets:

```
--targets telegram:halo_agent_bot:{{channel.chat_id}},slack:T01234:{{channel.chat_id}}
```

**Pinning to the current chat (the common case).** When the user inside
telegram/slack/feishu/wechat asks "remind me at X" / "send me a daily
digest", construct the target with `{{channel.chat_id}}`:

```
--targets {{channel.type}}:{{channel.account_id}}:{{channel.chat_id}}
```

**Admin-UI cron jobs.** When invoked from the admin web UI there's no
chat context (`{{channel.*}}` is empty). Either:
  - Tell the user "the cron will run silently — its result shows up in
    the cron log but won't be pushed anywhere. Add a target if you want
    a notification."
  - Or ask for a chatId explicitly and pass it as a target.

### 4. Apply the change

Helper script lives in this skill's directory; agents invoking from elsewhere should
substitute the right path (often `~/.halo/global/skills/manage-cron-jobs/manage-cron.py`).

**Create (from inside a chat — pin the result back to that chat):**
```bash
shell_exec: python3 ~/.halo/global/skills/manage-cron-jobs/manage-cron.py create \
  --label "Daily status digest" \
  --workspace /home/ubuntu/sa-agent \
  --agent default \
  --prompt "Summarize today's commits and open PRs." \
  --schedule "0 9 * * *" \
  --timezone Asia/Shanghai \
  --targets {{channel.type}}:{{channel.account_id}}:{{channel.chat_id}}
```

**Create (silent — no push, just appears in the cron log):**
```bash
shell_exec: python3 ~/.halo/global/skills/manage-cron-jobs/manage-cron.py create \
  --label "Nightly index rebuild" \
  --workspace /home/ubuntu/sa-agent \
  --prompt "Rebuild the search index." \
  --schedule "0 3 * * *"
```

**Update (change schedule or any other field):**
```bash
shell_exec: python3 ~/.halo/global/skills/manage-cron-jobs/manage-cron.py update <id> \
  --schedule "0 10 * * 1"
```

**Pause / unpause:**
```bash
shell_exec: python3 ~/.halo/global/skills/manage-cron-jobs/manage-cron.py disable <id>
shell_exec: python3 ~/.halo/global/skills/manage-cron-jobs/manage-cron.py enable <id>
```

**Delete:**
```bash
shell_exec: python3 ~/.halo/global/skills/manage-cron-jobs/manage-cron.py delete <id>
```

**List:**
```bash
shell_exec: python3 ~/.halo/global/skills/manage-cron-jobs/manage-cron.py list
```

**List jobs that push to the current chat (use this from inside a channel
when the user asks "what crons do I have?" / "remove the one I subscribed to earlier"):**
```bash
shell_exec: python3 ~/.halo/global/skills/manage-cron-jobs/manage-cron.py list --chat-id {{channel.chat_id}}
```

The user inside a chat doesn't know the cron `id` — they think in terms of
"the daily digest I set up here". Use `list --chat-id {{channel.chat_id}}`
to find the matching job(s), confirm with the user which one, then call
`delete <id>` / `disable <id>`.

**One job's run history (paginated, latest first):**
```bash
shell_exec: python3 ~/.halo/global/skills/manage-cron-jobs/manage-cron.py runs <jobId> --limit 20
shell_exec: python3 ~/.halo/global/skills/manage-cron-jobs/manage-cron.py runs <jobId> --limit 20 --before <oldestRunIdFromPrev>
```

### 5. Confirm and summarize

After a successful write, summarize what changed in 1-2 sentences and mention the runner
picks it up within ~10s. Example:

> Created cron job `cron-mphsy-abc123`: runs the `default` agent every day at 9am,
> output will be pushed to this chat. The runner picks it up within ~10s.

## Patterns that go sideways

- **telegram / slack / feishu target without a chatId** — every fire errors with
  `… cron target requires an explicit chatId …`. From inside a chat, use the
  `{{channel.chat_id}}` template; from the admin UI, ask the user for the chatId
  (or accept that the cron will run silently with no push target).
- **Picking a wechat target with `ready: false`** — no QR-bound owner means there's
  nowhere to deliver the cron output. Tell the user to scan the QR first.
- **Setting `enabled=0` and calling it "delete"** — pause and delete are different.
  Delete also drops cron_runs history.
- **Trying to use channel `web`** — web is SSE-only and reactive; cron has nowhere to
  push to. The dispatcher will record the run as failed-with-reason rather than swallowing.
