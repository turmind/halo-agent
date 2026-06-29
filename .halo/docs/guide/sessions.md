# Sessions — User Guide

A session is "one continuous conversation with an agent". It includes your conversation with the main agent plus any sub-agents the main agent spawns.

## Sessions panel

Left-side Activity Bar → `📨 Sessions` (message icon).

```
┌─────────────────┬──────────────────────────┐
│ Sessions        │  Message viewer          │
│─────────────────│                          │
│ ▼ My task      │                          │
│   📨 user msg   │                          │
│ ▶ └ 🤖 coder    │                          │
│ ▶ └ 🤖 sleeper  │                          │
│ 📨 Old chat     │                          │
└─────────────────┴──────────────────────────┘
```

## Hierarchy tree

The main agent (the one you talk to directly) sits at the top; any sub-agents it delegates to are shown indented.

- Collapse/expand: click the arrow
- Count badge `+3`: 3 descendants
- Red ⏹ icon: session was stopped (stopped_at is set)

## Message viewer

Click a session on the left to open the viewer:
- User messages and assistant replies (Markdown)
- Tool-call cards (expandable for input/output)
- Timestamps and agent-name badges

## Debug mode

Top-right Bug icon toggles it. When on you also see:

| Colour | Type | Content |
|---|---|---|
| Purple | Context | Full system prompt |
| Blue | Tool Call | Full tool input JSON |
| Green/Red | Tool Result | Full tool output |
| — | Usage | Token counts / latency / cache hit% / model ID |

**Essential for debugging and reviewing agent behaviour.**

## System prompt viewer

In Debug mode the top-right gets an extra `Prompt` button; click to expand the full system prompt (AGENT.md + INSTRUCTIONS.md + INDEX.md + TOOL_GUIDELINES + skill metadata).

Use it to see exactly what context the agent was given for a given turn.

## Non-destructive /session new

Typing `/session new` in the chat:
1. Saves the current session to disk
2. Creates a background handler to keep the old session's in-flight events flowing
3. UI resets to an empty session
4. **The old session's sub-agents keep running** (not killed)

When you switch back, the background-finished events are already in the file and render normally.

## Refresh / reconnect

Refreshing the browser or a network blip:
- SessionManager keeps the session alive for the grace period (5 minutes)
- On reconnect, messageLog + in-flight streaming state are restored from disk
- If the agent is still running, live streaming resumes; if it finished, the full history loads

## Deleting a session

Right-click a session → Delete:
- Cascade delete in SQLite (parent + all descendants)
- `.halo/sessions/{agentId}/{sid}.json` removed
- Sidebar entry removed

**Not recoverable** — be careful.

## Session tools (agent-side)

Agents can manage other sessions via tools. The whole bundle is granted automatically when an agent declares a non-empty `team` in `agent.yaml` (no separate tool checklist); empty or absent `team` = no delegation:

| Tool | Purpose |
|---|---|
| `start_session` | Start a sub-agent, asynchronous, auto-reports on completion |
| `session_list` | List the current session's children |
| `query_session` | Send a message to a session (idle = run now, busy = queue) |
| `interrupt_session` | Interrupt + re-run |
| `stop_session` | Stop (no re-run, recoverable) |
| `archive_session` | Cascade archive (not recoverable) |
| `get_session_output` | Read a session's latest turn output |
| `query_agent` | Inspect another agent (team-gated to the roster) |

See [dev/tools.md](../dev/tools.md).

## Scenarios

**Figuring out why an agent messed up**: open the session → Debug mode → scroll through tool-call cards to see inputs and outputs.

**Reusing a historical task**: find a relevant session → click `Prompt` → copy the system prompt into a new agent's AGENT.md.

**Following multi-level delegation**: within the depth-16 cap, the indented tree is easy to follow; click any sub-session to see exactly what it did.
