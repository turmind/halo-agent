# Linked machines (`halo node`)

Let a workspace's agents work on files on **your own computer** — a laptop, a desktop, a box behind NAT — while the agents themselves keep running on the halo server. You run `halo node` on that machine; it dials out to the server (no port to open), and the workspace's agents get `node_*` tools that read, write, search and (if you allow it) run commands there.

```
[your laptop]                               [server]
halo-node --root ~/proj ──WebSocket──────▶ halo server ── agent in workspace W
  (files, optional shell)                     node_read / node_write / … / node_run
```

Two clients do the same job, with the same flags and the same behaviour:

- **Linux (x86_64 / arm64 / armv7) and Windows (amd64)**: `halo-node`, a single binary attached to every GitHub release. It needs no Node.js. The Linux build is ~7 MB and idles at about 9 MB of memory.
- **macOS** (or a Linux / Windows machine that already has the npm package): `halo node` from `npm install -g @turmind/halo`.

Neither needs `halo setup` or model keys, and neither writes anything under `~/.halo/`.

Supported: **Linux, macOS and Windows amd64**. The Go client is tested natively on Linux and Windows CI; macOS uses npm. Windows `node_run` commands go to `cmd.exe`, with UTF-8 output and a GBK fallback.

## 1. Create a token

Admin → **Channels → Linked machines** → **Add machine**. Pick the workspace and a machine name (`a-z 0-9 -`, e.g. `mbp`; unique within the workspace — the agent uses it to address the machine). The dialog shows two commands to copy: one installs `halo-node` on Linux and runs it with `~/.local/bin` prepended to `PATH` (where a non-root install lands), the other runs the npm `halo node` client. On Windows, use the standalone exe below instead. The install link points at the server's own release, so the machine and the server come from the same version.

The token stays on the list row (copy button). Deleting the row revokes it at once and disconnects the machine.

## 2. Run it on the machine

**Linux** — install once with the release's install script, then run:

```bash
curl -fsSL https://github.com/turmind/halo-agent/releases/latest/download/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"           # non-root install; Debian / Ubuntu add it only at the next login
export HALO_NODE_TOKEN=<token>                 # better than --token: flags show up in ps / shell history
halo-node --server https://halo.example.com --root ~/proj
```

What the script does (`sh`, busybox included; curl or wget):

- picks `halo-node-linux-{amd64,arm64,armv7}` from `uname -m` (`armv8l`, a 64-bit kernel with 32-bit userland, gets armv7). Any other architecture, or not Linux, stops with a message.
- downloads that release's binary and checks it against the release's `SHA256SUMS` (`sha256sum` or `shasum`). A mismatch stops with an error and leaves nothing behind. With neither tool installed it warns and skips the check.
- installs to `/usr/local/bin/halo-node` when run as root, otherwise to `~/.local/bin/halo-node`. If that directory isn't in `PATH`, it says so. Debian, Ubuntu and Raspberry Pi OS add `~/.local/bin` to `PATH` only at a login after it exists, which is why the commands above (and the admin's) prepend it.
- runs the downloaded binary's `--version` before replacing anything; a download that doesn't run stops with an error.
- replaces an existing `halo-node` in place, even one that is running (that process keeps the old file until it restarts). **Re-run the script to upgrade.**
- needs no token, starts nothing, and writes no service file.

Each release's `install.sh` installs that release's binary. The admin's command uses the server's own version (`releases/download/v<version>/install.sh`); `latest` installs the newest release. `halo-node --version` prints the version.

**Manual download** — if you'd rather not pipe a script into `sh`, have only wget (`wget -qO- <url>/install.sh | sh` also works), or the machine can't reach GitHub (download on another machine, copy it over):

```bash
A=$(uname -m); case "$A" in x86_64) A=amd64;; aarch64|arm64) A=arm64;; armv7l|armv8l) A=armv7;; *) echo "no halo-node build for $A — use npm" >&2;; esac
curl -fLo halo-node "https://github.com/turmind/halo-agent/releases/latest/download/halo-node-linux-$A" && chmod +x halo-node
# optional: verify
curl -fsL https://github.com/turmind/halo-agent/releases/latest/download/SHA256SUMS | grep "halo-node-linux-$A\$" | sed "s/halo-node-linux-$A/halo-node/" | sha256sum -c
./halo-node --server https://halo.example.com --root ~/proj
```

### Windows (amd64)

Download `halo-node-windows-amd64.exe` from the [GitHub release](https://github.com/turmind/halo-agent/releases/latest) matching your server (no npm or Node.js needed). Put it in e.g. `C:\halo-node`. In PowerShell:

```powershell
$env:HALO_NODE_TOKEN = '<token>'
& 'C:\halo-node\halo-node-windows-amd64.exe' --server https://halo.example.com --root 'C:\Users\alice\proj'
```

The release's `SHA256SUMS` includes the exe; compare its entry with `Get-FileHash C:\halo-node\halo-node-windows-amd64.exe -Algorithm SHA256`. Use either `/` or `\` in paths; `~/` expands from `USERPROFILE`. Folder mode resolves symlinks and junctions before checking the root. Add `--allow-shell` only if you want commands as this Windows user. Stop the process before replacing the exe during an upgrade.

**macOS (npm)**:

```bash
npm install -g @turmind/halo                   # once
export HALO_NODE_TOKEN=<token>
halo node --server https://halo.example.com --root ~/proj
```

On Linux, `halo node` still works, and prints one `[Node] tip:` line with the install command.

Either one runs in the foreground and logs each call (`[Node] read src/app.ts`, `[Node] refused write ../x: outside root`). Ctrl-C stops it. It reconnects by itself after network drops or a server restart; it exits (code 1) on a bad / revoked token or when the workspace is gone.

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
halo-node --server https://halo.example.com --root ~/proj \
  --header "CF-Access-Client-Id: <id>" --header "CF-Access-Client-Secret: <secret>"
```

Neither client follows `HTTP(S)_PROXY`. To reach the server through a forward proxy, put a reverse proxy in front of the server instead, or use `--header`.

### TLS certificates (`https://` servers)

`halo-node` trusts the system's CA store (the Windows certificate store on Windows; `/etc/ssl/certs/…` on Linux, where `SSL_CERT_FILE` / `SSL_CERT_DIR` can point it elsewhere). It falls back to a built-in Mozilla root set only on a system with no CA bundle at all. For a private or corporate CA, install it into the system store, or on Linux set `SSL_CERT_FILE`. `halo node` (Node.js) does the opposite: it uses Node's built-in roots plus `NODE_EXTRA_CA_CERTS`, and ignores the system store.

### Run it as a service (systemd)

```ini
# /etc/systemd/system/halo-node.service
[Unit]
Description=halo node
Wants=network-online.target
After=network-online.target

[Service]
User=alice
# whole-machine mode: relative paths start here
WorkingDirectory=/home/alice
# HALO_NODE_TOKEN=…   (chmod 600)
EnvironmentFile=/home/alice/.halo-node.env
# installed as root; as alice: /home/alice/.local/bin/halo-node
ExecStart=/usr/local/bin/halo-node --server https://halo.example.com --root /home/alice/proj
Restart=on-failure
RestartSec=10
# 1 = bad / revoked token or workspace gone: restarting won't help
RestartPreventExitStatus=1
# optional, for very small boards
# Environment=GOMEMLIMIT=24MiB

[Install]
WantedBy=multi-user.target
```

Network drops, server restarts, a busy token (409) and a lockout (429) are handled inside the process, which keeps running, so `on-failure` is enough. Don't use `Restart=always`: it keeps restarting after a revoked token, and each restart is a failed login. After 5 failures in 15 minutes the server locks out that IP address, which blocks every machine connecting from it. ExecStart takes the path the install script printed. For the npm client, set `ExecStart=/usr/bin/halo node …`. After upgrading with the install script, `systemctl restart halo-node` to run the new binary.

### Start at boot on Windows (Task Scheduler)

Create `C:\halo-node\start.cmd` (replace the token, server and shared folder). Restrict this directory and wrapper to your account, Administrators and SYSTEM: it contains a plaintext token, and the log can contain file paths. The wrapper keeps the token out of the task's command line and appends logs:

```bat
@echo off
setlocal
set "HALO_NODE_TOKEN=<token>"
"C:\halo-node\halo-node-windows-amd64.exe" --server https://halo.example.com --root "C:\Users\alice\proj" >>"C:\halo-node\halo-node.log" 2>&1
exit /b %errorlevel%
```

Run PowerShell **as administrator** once to register a startup task. Set `$user` to the account that owns the shared files (not necessarily the administrator registering the task):

```powershell
$user = "$env:COMPUTERNAME\alice"
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\cmd.exe" -Argument '/d /c "C:\halo-node\start.cmd"' -WorkingDirectory 'C:\halo-node'
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'halo-node' -Action $action -Trigger $trigger -Principal $principal -Settings $settings
Start-ScheduledTask -TaskName 'halo-node'
```

S4U runs hidden without a logged-in desktop or a stored password. It cannot use that user's network credentials (mapped drives / authenticated SMB) or EFS-encrypted files; use a local shared folder. Outbound HTTPS with the Halo token still works. `ExecutionTimeLimit` **must be zero**: Task Scheduler's default stops a task after 72 hours. Do not enable restart-on-failure: exit 1 means a rejected token / other permanent refusal, and restarting repeats failed logins. Network failures already retry inside halo-node.

If your server is reached through **Tailscale**, enable Tailscale's **Run unattended** on Windows so it connects before login. halo-node retries until the network is ready. Inspect `C:\halo-node\halo-node.log` and `Get-ScheduledTaskInfo halo-node`; after replacing the token or upgrading the exe, stop and start the task. The append-only log is yours to rotate.

### Settings on the machine

`halo-node` takes its shell timeout only from `HALO_SHELL_TIMEOUT` (ms, default 120 s); grep's default of 50 matches and the 5 MiB command-output cap are fixed. `halo node` (npm) also reads them from the machine's own `~/.halo/secrets/` (`timeout.shell_exec` in `config.yaml`, the `general.limits.*` keys in `settings.yaml`). This only matters on a machine that also runs a halo server with those settings changed.

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
| `protocol mismatch (426)` | Client and server versions too far apart — upgrade the older side. |
| `this token is already connected from another process` | Another `halo node` with the same token is running; this one keeps retrying until that one stops. Also normal right after the machine rebooted or woke from sleep: the server needs 40–60 s to notice the old connection is dead, so the new process backs off and can take up to ~90 s to come online. |
| agent: `machine "mbp" is offline` | `halo node` isn't running / connected. |
| agent: `went offline during the call` | The connection dropped mid-call; the operation may or may not have happened. Running commands on the machine were stopped. |
| agent: `not available in this runtime` | You're in the standalone CLI / TUI — linked machines only work through `halo server` (admin UI or a channel). |
