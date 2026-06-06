# Remote Mac Worker — Design Blueprint

**Status**: not started, design initially frozen
**Filed**: 2026-04-28
**Priority**: future work, not at the front of the roadmap

## Scope

Wire the user's Mac into Halo — **not** as a remote code workspace, but as a **capability provider**, letting server-side agents tap into native Mac capabilities (screenshot, camera, browser, WPS, iMessage, calendar, …).

The key contrast with openclaw / opencode / Claude Code:
- Those tools: agent loop on the local machine, LLM remote
- This plan: **agent loop + LLM both on the server, Mac is just a "capability execution environment"**

It's "Mac as a service", not "LLM as a service".

## Architecture choice: Swiss-army knife + skill accumulation

Rejected alternatives (discussed and dropped):
- **Static capability plugin** (a fixed preset tool set) → capability boundary is rigid; agents have no recourse for novel capabilities
- **Computer Use pixel-level** (screenshot + click coordinates) → unfriendly to the 2018 Intel Mac (slow + expensive); universality bought with token cost

Settled on **Swiss-army knife + skills**:

```
Low-level primitives (registered by the Worker)
  - mac_shell(cmd)            → arbitrary shell commands
  - mac_applescript(script)   → arbitrary AppleScript
  - mac_jxa(script)           → JavaScript for Automation (AppleScript modernised)
  - mac_filesystem            → file_read/write/list etc.

Middle layer — skills (preset + user-written + agent-accumulated)
  - mac_screenshot
  - mac_take_photo
  - mac_open_wps
  - mac_safari_goto
  - mac_read_imessage
  - …(agent first explores new scenarios, then asks user to save them as skills after verification)

Surface / UI
  - Settings shows the connected worker + its registered primitives
  - Each skill can be enabled/disabled
```

Why:
- Covers ~99% of Mac apps (mature AppleScript ecosystem)
- Friendly to old Intel Mac hardware (no continuous-screenshot + vision-inference load)
- Plays naturally with Halo's existing Skill system
- High capability ceiling (Turing-complete)

## Worker protocol outline

WebSocket-based reverse connection (Mac only needs outbound; no public IP needed):

```
Mac                         Halo Server (9527)
halo-worker  ──── WSS ───▶ /worker endpoint
                              ↕
                           worker-pool
                              ↕
                           agent tool dispatch
```

Worker registration payload:

```json
{
  "type": "register",
  "workerId": "peter-mac",
  "primitives": ["shell", "applescript", "jxa", "filesystem"],
  "os": "macos",
  "osVersion": "14.x",
  "arch": "x64",
  "home": "/Users/peter"
}
```

Server reads `primitives` and dynamically assembles the tool set it injects into the agent.

Protocol messages to support:

```
Worker → Server
  - register
  - tool_result (id, ok, result)
  - tool_stream (id, chunk)     // shell stdout streaming
  - pong

Server → Worker
  - tool_call (id, tool, args, dry_run?)
  - tool_cancel (id)
  - ping
```

**Tool results must support multiple shapes**: text / image (base64 PNG) / file (binary) / structured (JSON). No longer the "all-tool-results-are-strings" simplification.

## Security model (mandatory)

**Dynamic model + Swiss-army knife = high risk**. Required guards:

### 1. Frontend approval

Every `mac_shell` / `mac_applescript` execution pops a frontend confirmation:
- Show the command text
- Allow once / allow for this session / allow permanently for this command pattern

Like Claude Desktop / Cursor's tool approval UI.

### 2. Server-side dangerous-command blocking

Regex scan for:
- `rm -rf`, `sudo`, `curl|bash` pipes, `nc`, `mkfs`, `dd`
- AppleScript `delete file`, `empty trash`, `quit application`
→ Force popup, no "session allowlist"

### 3. Worker-side path validation

`mac_filesystem`-family tools still use the `validateWorkspacePath` approach from `workspace-tools.ts`; the worker validates itself, doesn't trust server-supplied absolute paths.

### 4. Capability switches

Settings lets the user:
- Disable `mac_shell` (keep only AppleScript)
- Block specific commands entirely (`rm` / `sudo` / `curl`)
- Disable an entire sensitive skill

## Hardware constraints (user's 2018 Intel Mac)

- Latest macOS (exact version unknown — will probe)
- **Computer Use pixel-vision unsuitable** — old GPU, slow image processing
- AppleScript / shell / osascript are native CLI — no perf issues
- `node-pty` needs to be built x64 (not arm64)

## Time estimate (revised)

The earlier "2-3 days" was wishful; realistic estimate:

| Phase | Time | Deliverable |
|---|---|---|
| MVP: protocol + shell + filesystem | 1 week | Agent can run commands / read files on Mac |
| + AppleScript + screenshot | 3 days | Agent controls any Mac app + screenshots |
| + Safari control, WPS control | 3 days | "Open this page and screenshot it" works end-to-end |
| + Camera, iMessage | 3-5 days | Take photos, read/send messages |
| UI: worker management + approvals | 1 week | Frontend can see worker status, approve tool calls |
| Polish + package CLI + deploy docs | 1-2 weeks | Shippable |

**Total: 4-6 full-time weeks.**

Suggested split:
- **First window (2 weekend days)**: MVP only. Get "agent executes `ls` on Mac and sees the result". Stop to evaluate whether to continue.
- **Second window (2-3 weeks)**: up to "screenshot + Safari + WPS control" — already a strong demo.

## MVP checklist

Start and stop here; do nothing else until it lands:

- [ ] New `packages/worker` workspace, add to pnpm
- [ ] New `packages/server/src/workers/` with worker-pool + `/worker` WS endpoint
- [ ] Protocol: register / tool_call / tool_result / ping-pong
- [ ] Worker CLI: WS connect, register, ping, one `mac_shell` primitive
- [ ] Server: Project table gains `execution_target` (local / worker:<id>)
- [ ] Agent tool dispatch abstraction: `LocalExecutor` vs `RemoteExecutor`
- [ ] Frontend: Settings hard-codes one worker entry + shows worker status
- [ ] End-to-end: agent runs `ls ~` on Mac successfully

Stop once these 8 are green. **Do not expand scope.**

## Decision log vs Anthropic Computer Use

We discussed Computer Use (Claude Sonnet 3.5+'s vision + coordinate-click capability) and decided not to go that route, because:

1. User's machine is 2018 Intel Mac; vision inference is slow
2. Each step's screenshot burns tokens → costly
3. Non-deterministic (potential misclicks)
4. Generic, but overkill for macOS's mature AppleScript ecosystem
5. Halo runs on Bedrock Claude; it's supported but latency/cost is worse than direct API

**Not opposed to adding it later** as another primitive ("vision fallback"), but not the main path.

## Reference projects

- **Anthropic computer-use-demo** (Docker demo, for protocol reference)
- **OpenInterpreter 01** (open-source local agent, primitive design)
- **Claude Desktop + MCP** (tool approval UX)
- **Self-Operating Computer** (coordinate-click fallback, if we ever add it)
- **Dagger** / **dstack.ai** (worker pool management)

## Questions to answer before starting

1. Mac's specific macOS version (gates which APIs are available)
2. Which three skills to prioritise packaging (pick 3 from screenshot / Safari / WPS / iMessage)
3. Approval UI granularity (session allowlist vs per-command pattern)
4. Worker auth (where to store tokens, rotation)
5. Multi-worker support (1 server to N workers)

Answer these first before any code.
