# Adding a Channel

How to wire a new IM / chat platform (Slack, Discord, Telegram, Lark, …) into Halo, so users can talk to agents from that platform the same way they do from WeChat or the web.

## Reality check

Channels are **descriptor-based** but not plugins from a marketplace — you still hand-write the platform integration. The wiring itself is one entry per side: a `ServerChannelDescriptor` (server) and an `AdminChannelDescriptor` (admin UI). Once you've written the per-channel modules, exposing them to the rest of Halo is two new lines in two `descriptors.ts` files. `index.ts`, the cron core, the channels sidebar, the channels main pane — none of those change.

What you get from the platform infrastructure:
- `SessionManagerRegistry` — multi-subscriber; web and your channel can listen to the same session at once
- Per-session `accessLevel` enforcement (full / workspace / readonly) — enforced by SessionManager, not your channel
- Media inbound handling pattern — `<ws>/.halo/assets/<channel>/inbound/<accountId>/<date>/` emits `[图片已保存: /path]` markers with UI support
- Unified channel accounts DB — `~/.halo/secrets/channels/channels.db`, one table for all channels
- Shared accounts DAL — `channels/shared/accounts.ts` handles CRUD, your channel writes a thin adapter
- Shared command dispatcher — `channels/shared/commands.ts` handles all common slash commands
- Channel registry — `channels/registry.ts` (server) + `features/channels/registry.ts` (admin); descriptor-based so adding a channel is 2 entries, not edits to 5+ files
- Cron dispatcher registry — `cron/dispatcher.ts`; per-channel send + listTargets are owned by each channel module
- Agent event stream in a standard shape (see [design/ws.md](../design/ws.md))

What you write yourself:
- Inbound ingestion (webhook / long-poll / socket mode)
- Outbound send client
- Account management (QR / OAuth / bot token) + persistence
- Stream → platform-message coalescing
- Two descriptors (~10 lines each: server + admin)

---

## Reference implementation

Whole directory: [packages/server/src/channels/wechat/](../../../packages/server/src/channels/wechat/) (~1900 lines across 9 files).

The pattern that works:

```
channels/<name>/
├── types.ts          — platform-specific message shapes
├── api.ts            — HTTP client (send / receive / auth)
├── accounts.ts       — DAL: persisted account rows
├── handler.ts        — main loop + dispatch → SessionManager
├── event-adapter.ts  — agent events → coalesced outbound messages
├── login.ts          — QR / OAuth flow (if applicable)
├── cdn.ts            — media download / decrypt (if applicable)
├── send-media.ts     — outbound media upload (if applicable)
└── media-store.ts    — disk save + marker generation (shared helper)
```

Not every channel needs every file. Slack probably doesn't need `cdn.ts`; Telegram might not need `login.ts` if bot tokens are manually provisioned.

---

## What a channel does, step by step

Every channel, on every inbound message, runs this sequence:

1. **Receive.** Webhook endpoint or long-poll loop gets a raw platform message.
2. **Extract.** Pull user ID, workspace binding, text, media. Platform-specific — this is why each channel has its own `types.ts`.
3. **Resolve workspace.** Look up the bound workspace for this account / user. For WeChat this is a DB column; for Slack you'd use team → workspace mapping.
4. **Get a SessionManager.** `registry.getOrCreate(workspacePath)` — cheap, memoized per workspace.
5. **Hand off to `deliverInbound`.** Everything downstream is shared ([channels/shared/inbound.ts](../../../packages/server/src/channels/shared/inbound.ts)): resolve-or-create the session under a per-user `activeOverrides` override (`/session new` / `/session switch` update it), fold the account access level, send the busy hint, refresh the reply **route**, register the responder listener once per session (`sm.registerEventListener`), then `appendUserMessage` + `sendUserMessage`. Your channel supplies the route and the send primitives; the responder coalesces streamed text into whole outbound messages (platforms hate per-token streams).

Steps 1-4 are yours, step 5 is shared — see [step 4 below](#4-write-the-main-handler) for the call shape. Canonical example: [packages/server/src/channels/wechat/handler.ts](../../../packages/server/src/channels/wechat/handler.ts) (`handleInbound`).

---

## Steps to add a Slack channel (worked example)

### 1. Create the directory

```
packages/server/src/channels/slack/
├── types.ts
├── api.ts
├── accounts.ts
├── handler.ts
└── event-adapter.ts
```

Copy the WeChat shapes to get started, then rewrite against the Slack API.

### 2. Define the account adapter

All channel accounts live in a single unified table: `~/.halo/secrets/channels/channels.db` → `channel_accounts`. Common fields (accountId, workspacePath, label, enabled, accessLevel, language, timestamps) are explicit columns. Channel-specific fields go in the `config` JSON column.

**You do NOT create a new DB file.** Instead:

1. Define your channel's TypeScript interface in `types.ts` (e.g. `SlackAccount` with `teamId`, `botToken`, `botUserId`)
2. Create `accounts.ts` as a thin adapter over `channels/shared/accounts.ts`:
   - Map `ChannelAccount.config` JSON → your typed interface
   - Pass `channelType = 'slack'` to all shared DAL calls

Reference adapters: [channels/telegram/accounts.ts](../../../packages/server/src/channels/telegram/accounts.ts), [channels/web/accounts.ts](../../../packages/server/src/channels/web/accounts.ts).

See [design/storage.md](../design/storage.md#channel_accounts) for the full schema.

### 3. Wire the API client

`api.ts`: `sendMessage`, `postEphemeral`, maybe `uploadFile`. Use the Slack Web API (Node SDK or raw fetch). Auth: `Bearer ${bot_token}`.

Inbound: Slack pushes events via **HTTPS webhooks** (Events API) or **WebSocket** (Socket Mode). Pick one — Socket Mode avoids exposing a public URL but requires Slack app tier. For a self-hosted Halo, Socket Mode is usually easier.

### 4. Write the main handler

`handler.ts`: exports `startSlackChannel(deps: { registry, db })` returning `{ startAccount, stopAccount, stopAll }`. WeChat shape at [packages/server/src/channels/wechat/handler.ts:73-157](../../../packages/server/src/channels/wechat/handler.ts#L73-L157).

For webhook-style channels (Slack Events API), you don't need a `runAccountLoop` — instead expose an HTTP route that validates the signature, deserializes the event, and calls `handleInbound`. For Socket Mode, you **do** have a loop (the WebSocket reconnect loop).

Inside `handleInbound`, **don't hand-roll the session/listener plumbing** — the get-or-create, access folding, busy hint, responder registration and agent-input assembly all live in [channels/shared/inbound.ts](../../../packages/server/src/channels/shared/inbound.ts) (`InboundBridge` + `deliverInbound` + `dispatchChannelCommand`). All four channels go through it; the four hand-written copies it replaced are how audit findings A-M2 (responder locked onto the first user in a chat) and A-M5 (skill-command turns ran with no listener attached) happened. Your handler parses the platform message and supplies a **reply route**:

```ts
// One bridge per running account, owned by the account state so
// stopAccount can closeAll(). The responder reads the route LAZILY at
// send time — never capture the chat/user in the closure (A-M2).
const bridge: InboundBridge<SlackRoute> = new InboundBridge({
  channel: 'slack',
  makeResponder: (sessionId) => new SlackResponder({
    sendText: async (chunk) => {
      const route = bridge.getRoute(sessionId)
      if (!route) return
      await postMessage({ botToken, channel: route.channelId, threadTs: route.replyTs, text: chunk })
    },
  }),
})

async function handleInbound({ registry, db, account, event, bridge, activeOverrides }) {
  const sm = registry.getOrCreate(account.workspacePath)
  await deliverInbound({
    sm, db, accountId: account.accountId, bridge,
    chatKey: event.channel,                       // cached for cron delivery
    tagKey: `${event.user}:${event.threadTs}`,     // activeOverrides key
    sessionPrefix: `slack-${account.accountId}-`,
    activeOverrides,
    accountAccessLevel: account.accessLevel,
    workspacePath: account.workspacePath,
    sessionLabel: `Slack: ${event.user}`,
    setOverrideOnCreate: true,                     // per-thread channels pin it
    route: { channelId: event.channel, replyTs: event.threadTs },  // THIS message
    lang: account.language, sendHint: (t) => postEphemeral(t),
    uiText: event.text, agentText: event.text, userTag: event.user,
    images: event.images,
  })
}
```

`deliverInbound` refreshes the route on every message before `ensureListener`, so a listener registered once follows the conversation to whoever spoke last. Slash commands go through `dispatchChannelCommand` (same `bridge` + `route`), which wires the responder when the command reports `startedTurn`.

### 5. Write the event adapter

`event-adapter.ts`: buffers streamed text and sends whole messages. WeChat's flushes on either a 3500-char hard ceiling (`WECHAT_TEXT_LIMIT`, the ilink gateway rejects >16 KB) or a `complete` event; see [packages/server/src/channels/wechat/event-adapter.ts](../../../packages/server/src/channels/wechat/event-adapter.ts). Use the shared `splitText(text, limit)` from `channels/shared/chunk.ts` for the cut (paragraph boundary, then hard-cut) — all four existing responders do; don't write a private splitter. Slack has a 40k char limit but users dislike huge messages, so it splits at 35k. Serialize your sends through one promise chain per responder (see wechat's `sendTail`) and return it from `close()` so the bridge keeps the route alive until the tail has gone out.

Its send primitives take **no destination argument** — they read `bridge.getRoute(sessionId)` on each send (see step 4). A responder that captured a chat/user id at construction time is the A-M2 bug.

**What to forward, what to drop**:
- Drop `tool_call` / `tool_result` / `thinking` events — they're chatter the user doesn't want in IM
- Drop events where `event.taskId` is set (those are sub-agent events; the root agent's text is enough)
- Forward `stream` text **only when `event.final` is set** — that's the turn's closing reply; the filler the model emits before a tool call ("let me check…") is chatter in IM too. `error` goes out immediately with a `[error]` prefix; `complete` flushes the remaining buffer
- Forward `system` if the platform can render it (e.g. Slack ephemeral messages)

### 6. Surface channel context to skills

Inside `handler.ts`, when you build a `CommandContext` for `dispatchCommand`, fill in the structured `channel` field. This is what lets skills like `cron` default their behaviour to the originating chat (e.g. "remind me at 3pm" creates a cron whose target is *this* slack DM, not a fan-out to every workspace member):

```ts
const ctx: CommandContext = {
  sm, userId: event.user, sessionPrefix, accessLevel: account.accessLevel,
  channelLabel: `Slack: ${event.user}`, activeOverrides,
  workspacePath: account.workspacePath, lang: getLang(account),
  channel: {
    type: 'slack',
    accountId: account.accountId,
    chatId: event.channel,         // Slack channel id; used as cron recipient pin
  },
}
```

Skill bodies see these as `{{channel.type}}`, `{{channel.account_id}}`, `{{channel.chat_id}}` placeholders (rendered by `prompts/md-vars.ts`). Admin/WS skill invocations leave them empty — skills should write their bodies to handle both forms.

### 6.5. Cron dispatcher (proactive sends)

If you want users to be able to schedule cron jobs that deliver to your channel, write a per-channel cron-dispatcher and register it at boot. The cron core (`cron/dispatcher.ts`) is registry-based — there is no central switch on channel type, and you do **not** edit anything in `cron/` to add a channel.

Create `packages/server/src/channels/<name>/cron-dispatcher.ts`:

```ts
import { registerCronDispatcher, type CronTargetOption, type DispatchResult } from '../../cron/dispatcher.js'
import { getChannelDb } from '../../db/channel-db.js'
import { listAccounts, getAccount } from './accounts.js'

async function dispatch(accountId: string, text: string, chatId?: string): Promise<DispatchResult[]> {
  const acct = getAccount(getChannelDb(), accountId)
  if (!acct || !acct.enabled) throw new Error(`<name> account ${accountId} unavailable`)
  // Pick the recipient: explicit chatId (cron created from inside a chat) →
  // your channel's "default proactive target" (e.g. account owner) → cached
  // lastActiveChatId fallback.
  const target = chatId || acct.defaultRecipient || readLastActiveChatId(accountId)
  if (!target) throw new Error('no <name> recipient — bind first / send the bot a message')
  await sendToUser({ account: acct, toUserId: target, text })
  return [{ channelType: '<name>', accountId, chatId: target, ok: true }]
}

function listTargets(): CronTargetOption[] {
  return listAccounts(getChannelDb()).map((a) => ({
    channelType: '<name>',
    accountId: a.accountId,
    label: a.label || a.accountId,
    workspacePath: a.workspacePath,
    enabled: a.enabled === 1,
    hasActiveChat: !!a.defaultRecipient,    // your "ready to deliver" rule
  }))
}

export function register<Name>CronDispatcher(): void {
  registerCronDispatcher({ channelType: '<name>', dispatch, listTargets })
}
```

Two things to decide:

- **Single-recipient vs fan-out.** WeChat is single-recipient (one `dispatch` call → one `DispatchResult`); Telegram fans out to every numeric id in `allowedUsers` and returns one result row per recipient. Pick whichever matches your platform's identity model. Fan-out is what makes "schedule a digest to the whole team" work without one cron per user.
- **`hasActiveChat` rule.** What makes an account "ready to receive" without an explicit chat id? Telegram = numeric id whitelisted OR cached lastActiveChatId; WeChat = QR-bind owner OR cached. The admin UI's "no active chat" warning reads this flag.

### 7. Expose admin routes

`packages/server/src/routes/slack.ts`:

```ts
export function createSlackRoutes(deps: { db, channel }) {
  const app = new Hono()
  app.get('/slack/accounts', (c) => c.json({ accounts: listAccounts(deps.db) }))
  app.post('/slack/accounts', async (c) => { /* create from OAuth token */ })
  app.patch('/slack/accounts/:id', async (c) => { /* label/workspacePath/enabled/accessLevel */ })
  app.delete('/slack/accounts/:id', async (c) => { deps.channel.stopAccount(id); deleteAccount(deps.db, id) })
  // Optional: POST /slack/webhook for Events API, validates signature + routes to handleInbound
  return app
}
```

Pattern: [packages/server/src/routes/wechat.ts](../../../packages/server/src/routes/wechat.ts).

### 8. Write the server descriptor + register

Create `packages/server/src/channels/slack/descriptor.ts`:

```ts
import type { ServerChannelDescriptor } from '../registry.js'
import { startSlackChannel, type SlackChannel } from './handler.js'
import { createSlackRoutes } from '../../routes/slack.js'
import { registerSlackCronDispatcher } from './cron-dispatcher.js'  // step 6.5

export const slackDescriptor: ServerChannelDescriptor<SlackChannel> = {
  channelType: 'slack',
  start: (deps) => startSlackChannel(deps),
  routes: (deps) => createSlackRoutes(deps),
  shutdown: (channel) => channel.stopAll(),
  registerCronDispatcher: () => registerSlackCronDispatcher(),  // omit if no step 6.5
}
```

Then add to [packages/server/src/channels/descriptors.ts](../../../packages/server/src/channels/descriptors.ts):

```ts
import { slackDescriptor } from './slack/descriptor.js'

export const defaultChannelDescriptors = [
  wechatDescriptor,
  telegramDescriptor,
  webDescriptor,
  slackDescriptor,    // ← one new line
]
```

That's all the server wiring. `index.ts` calls `bootChannels(app, defaultChannelDescriptors, …)` which iterates the list — start, routes, cron-dispatcher all hook in via the descriptor. `gracefulShutdown` calls `shutdownChannels()` which drains every descriptor's `shutdown` in reverse order. **Nothing in `index.ts` itself changes when you add a channel.**

### 9. Optional: admin UI

To let users manage Slack accounts from the web UI:

1. Build the React component (mirror [packages/admin/src/features/wechat/wechat-settings.tsx](../../../packages/admin/src/features/wechat/wechat-settings.tsx)). Place it at `packages/admin/src/features/slack/slack-settings.tsx`.
2. Create `packages/admin/src/features/slack/descriptor.ts`:
   ```ts
   import { Hash } from 'lucide-react'    // or whatever icon fits
   import type { AdminChannelDescriptor } from '@/features/channels/registry'
   import { SlackSettings } from './slack-settings'

   export const slackAdminDescriptor: AdminChannelDescriptor = {
     id: 'slack',
     label: 'Slack',                  // brand name; or 'channels.slack' i18n key
     Icon: Hash,
     Component: SlackSettings,
   }
   ```
3. Add to [packages/admin/src/features/channels/descriptors.ts](../../../packages/admin/src/features/channels/descriptors.ts):
   ```ts
   import { slackAdminDescriptor } from '@/features/slack/descriptor'

   export const defaultAdminChannelDescriptors = [
     wechatAdminDescriptor,
     telegramAdminDescriptor,
     webAdminDescriptor,
     slackAdminDescriptor,        // ← one new line
   ]
   ```

The sidebar maps over the list to render itself; the main pane looks up by `id` to render `Component`. `channel-store` validates the `id` against the same list — no edits to `channels-sidebar.tsx`, `channels-main.tsx`, or `channel-store.ts`.

If you skip this step, users provision Slack accounts via curl-ing the REST routes from step 7. Headless deployments often skip it.

### 10. Document

Write `.halo/docs/design/slack.md` mirroring [design/wechat.md](../design/wechat.md): architecture, data model, main loop (or webhook flow), slash commands you support, access level.

Add a row to [dev/api.md](api.md)'s endpoint table.

---

## Common decisions

### Access level

Default to `readonly` for any channel that doesn't have a strong identity verification story. Channel-exposed agents with full filesystem and `shell_exec` are a loaded gun.

Per-account `access_level` column in your DAL, inherited into session creation:

```ts
await sm.createSession('default', null, title, undefined, undefined, null, account.accessLevel)
```

SessionManager enforces the rest: readonly sessions drop `file_write` / `file_edit` / `shell_exec` / `web_fetch` from the tool set automatically. Source: [dev/tools.md#access-level-per-session](tools.md#access-level-per-session).

### Slash commands

You almost always want:
- `/session new` — start a fresh session, old sessions remain reachable
- `/session list` / `/session switch <n>` — session history, switch active
- `/workspace info` / `/workspace switch <path>` — show / switch workspace
- `/help`

Common commands (`/help`, `/evo`, and the object commands `/session`, `/agent`, `/skill`, `/workspace` with their builtin verbs — plus fall-through to same-named skills for skill verbs like `/cron …`) are handled by `dispatchCommand()` in [channels/shared/commands.ts](../../../packages/server/src/channels/shared/commands.ts). Your channel handler only needs to:

1. Build a `CommandContext` (including `lang` from the account's `language` field)
2. Call `dispatchCommand(ctx, command, arg, { channelName: 'slack' })`
3. Handle the result: check `result.workspace` for `/workspace switch` side-effects (update account + restart), check `result.switchTo` for session switches, check `result.startedTurn` (a skill verb kicked the agent — keep the event stream open), then send `result.text` back to the user

Channel-specific commands (e.g. WeChat's `/qr`) go in a fallback switch after `dispatchCommand` returns `null`. All system messages are i18n'd via `channels/shared/i18n.ts`. Reference: [channels/telegram/handler.ts](../../../packages/server/src/channels/telegram/handler.ts) (cleanest example — uses a loop over command names).

### Compact / busy states

Handled for you inside `deliverInbound`: it calls `busyHint(sm, sessionId, lang)` ([channels/shared/busy-hint.ts](../../../packages/server/src/channels/shared/busy-hint.ts)) and sends the result through your `sendHint` callback. The hint is a **hint only** — the message is always delivered, because `sendUserMessage` queues compacting/busy sessions itself. (The four inlined copies once carried an extra `return` in the compacting branch, so messages sent mid-compact were answered with a hint and then silently dropped.)

### Single-instance lock

If your channel uses a polling or socket-mode loop, **respect the server's single-instance lock** (`~/.halo/global/server.lock`). Orphan processes each run an independent loop and fan out duplicate messages to their own session copies. See [design/wechat.md#singleton-note](../design/wechat.md) and [dev/deploy.md](deploy.md).

### Workspace resolution

Each channel account has a `workspace_path` column in the unified `channel_accounts` table. If your channel binds user-to-workspace instead of bot-to-workspace, do the lookup at inbound time.

At handler startup, `resolveAccountWorkspace(account)` checks the path exists on disk and calls `ensureWorkspaceHalo()`. If the workspace is missing, the handler skips the account. Users can re-bind via the admin panel or `/workspace switch` command (full access only).

### Media

Use the shared helper `saveInboundMedia({ workspacePath, accountId, channel: 'slack', buffer, kind: 'image', mimeType })` — [packages/server/src/channels/shared/media-store.ts](../../../packages/server/src/channels/shared/media-store.ts). It saves under `<ws>/.halo/assets/slack/inbound/<accountId>/<date>/` and returns the path. Append `[图片已保存: /abs/path]` to the agent's input text and the existing UI code will render a thumbnail.

For images going to the LLM, also pass them as base64 in the `images` arg — `sm.sendUserMessage(sid, text, images)`.

---

## Testing

No automated test framework for channels — manual for now:

1. Create a test bot on the platform (development workspace / test server)
2. Bind it to a throwaway Halo workspace: `POST /api/slack/accounts`
3. Send a message → verify it lands in `<ws>/.halo/sessions/default/`
4. Verify agent reply comes back as one or more outbound messages
5. Test access level: set the account to `readonly`, send "delete all files in /tmp" → should be refused by the tool guard
6. Test `/session new`, `/session switch`, busy/compact states, large responses (>3500 chars)

---

## References

- Shared inbound skeleton: [packages/server/src/channels/shared/inbound.ts](../../../packages/server/src/channels/shared/inbound.ts) (also written up in [design/telegram.md](../design/telegram.md#shared-inbound-skeleton))
- Full WeChat reference: [design/wechat.md](../design/wechat.md)
- WeChat code: [packages/server/src/channels/wechat/](../../../packages/server/src/channels/wechat/)
- Architecture seat: [design/architecture.md](../design/architecture.md)
- Session registry: [packages/server/src/agents/session-manager-registry.ts](../../../packages/server/src/agents/session-manager-registry.ts)
- Storage conventions: [design/storage.md](../design/storage.md)
