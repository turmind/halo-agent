# Linked machines (`halo node`)

Let a workspace's agents work on files on **your own computer** — a laptop, a desktop, a box behind NAT — while the agents themselves keep running on the halo server. You run `halo node` on that machine; it dials out to the server (no port to open), and the workspace's agents get `node_*` tools that read, write, search and (if you allow it) run commands there.

```
[your laptop]                               [server]
halo node --root ~/proj ──WebSocket──────▶ halo server ── agent in workspace W
  (files, optional shell)                     node_read / node_write / … / node_run
```

The machine needs only the `halo` package — no `halo setup`, no model keys, nothing under `~/.halo/`.

Supported: **macOS and Linux**. Windows works on a best-effort basis (not regularly tested; `node_run` commands go to `cmd.exe`).

## 1. Create a token

Admin → **Channels → Linked machines** → **Add machine**. Pick the workspace and a machine name (`a-z 0-9 -`, e.g. `mbp`; unique within the workspace — the agent uses it to address the machine). The dialog shows a command to copy:

```bash
halo node --server https://halo.example.com --token <token> --root <folder>
```

The token stays on the list row (copy button). Deleting the row revokes it at once and disconnects the machine.

## 2. Run `halo node` on the machine

```bash
npm install -g @turmind/halo                   # once
export HALO_NODE_TOKEN=<token>                 # better than --token: flags show up in ps / shell history
halo node --server https://halo.example.com --root ~/proj
```

It runs in the foreground and logs each call (`[Node] read src/app.ts`, `[Node] refused write ../x: outside root`). Ctrl-C stops it. It reconnects by itself after network drops or a server restart; it exits on a bad / revoked token or when the workspace is gone.

The admin row turns green (live, no refresh) and shows `folder · shell on/off · os`.

### Folder mode vs whole-machine mode

- **`--root <folder>`** — share one folder. Every path the agent passes must stay inside it (symlinks pointing out are refused too); relative paths start from it.
- **No `--root`** (or `--root /`) — **whole-machine mode**: the agent can reach every path your user can, like a full-access local session. Relative paths start from the directory you ran `halo node` in. A startup line warns about it, and the admin shows "Whole machine".

Prefer `--root` unless you really mean the whole machine.

### `--allow-shell`

Off by default — `node_run` then refuses with "restart `halo node` with --allow-shell". With it, agents can run **any command as your user, not sandboxed**. In folder mode only the command's working directory is held inside the folder; the command itself (`cat ~/.ssh/...`, `curl ...`) can reach anything your user can. Turn it on only for agents and workspaces you trust. Commands are killed after the shell timeout (120 s, or `HALO_SHELL_TIMEOUT` in ms on the machine).

### What the agent can see

Everything inside the shared folder — including `.env` files, keys, credentials and git history. Don't share a folder that holds secrets you wouldn't paste into the chat. Whole-machine mode exposes your whole home directory.

### Behind a login proxy

`halo node` sends a bearer token, nothing else. If the server sits behind an auth proxy (Cloudflare Access, an SSO gateway, basic auth), either point `--server` at an address the machine can reach directly, or pass the proxy's credentials with `--header` (repeatable, `Name: value`, split on the first colon):

```bash
halo node --server https://halo.example.com --root ~/proj \
  --header "CF-Access-Client-Id: <id>" --header "CF-Access-Client-Secret: <secret>"
```

## 3. Let the agent use it

Node tools are enabled per agent by **`node_list`** in `agent.yaml`'s `tools:` — that one name brings all eight (`node_list`, `node_read`, `node_write`, `node_edit`, `node_list_dir`, `node_grep`, `node_glob`, `node_run`). The bundled `default` agent lists it. If your workspace overrides the default agent (`<workspace>/.halo/agents/default/agent.yaml`), or you use another agent, add it yourself:

```yaml
tools:
  - file_read
  # …
  - node_list   # linked machines (whole node_* set)
```

Only **Full** access sessions get node tools — a Workspace or Readonly session listing `node_list` gets none. Cron jobs in the workspace can use them too.

Then just ask: "list my machines", "read `notes/todo.md` on mbp", "run the tests on mbp". The agent calls `node_list` first to see which machines are online.

## Troubleshooting

| Message | Meaning |
|---|---|
| `token rejected by the server (401)` | Wrong / deleted token — create a new one. 5 bad tries in 15 min lock the address out for a while (429). |
| `the workspace this token is bound to no longer exists (404)` | The workspace folder was removed on the server. |
| `protocol mismatch (426)` | `halo` versions too far apart — upgrade the older side. |
| `this token is already connected from another process` | Another `halo node` with the same token is running; this one keeps retrying until that one stops. |
| agent: `machine "mbp" is offline` | `halo node` isn't running / connected. |
| agent: `went offline during the call` | The connection dropped mid-call; the operation may or may not have happened. Running commands on the machine were stopped. |
| agent: `not available in this runtime` | You're in the standalone CLI / TUI — linked machines only work through `halo server` (admin UI or a channel). |
