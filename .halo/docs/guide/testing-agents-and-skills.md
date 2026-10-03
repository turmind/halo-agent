# Testing Agents and Skills

How to verify an agent you just created behaves right, and how to exercise a skill end-to-end. There is no separate "sandbox mode" — testing runs a **real** session in the current workspace with the same tools, skills, and storage as production. You just get to drive it from the Agent management UI.

## Testing an agent

### 1. Open the agent

Activity Bar → `🤖 Agents` → click the agent you want to test.

### 2. Click Test

Top-right `Test` button. What it does, concretely:

1. Opens a new draft chat tab in the Explorer panel with this agent selected (`newTab(agentId)` — an untouched draft tab is reused). Any session you already had open keeps its own tab, and keeps running if it was busy
2. Dispatches a `halo:navigate` event that switches to the Explorer tab

Source: `testAgent` in [packages/admin/src/features/agents/agent-management-main.tsx](../../../packages/admin/src/features/agents/agent-management-main.tsx).

### 3. Start chatting

The Explorer's Chat panel is now ready with your agent pre-selected. Send a message.

- Input appears in the session
- The agent streams a reply with tool-call cards inline
- A session file is created at `<workspace>/.halo/sessions/<agentId>/<sid>.json`
- A SQLite row is added to `agent_sessions`

**This is a real session.** The agent has its full tool set (whatever is in `agent.yaml tools`), access to the workspace filesystem, and persisted history. Anything it writes to disk is actually written.

### 4. Verify behaviour

- **Does it greet the way AGENT.md says?** Send "Hi". Check the reply matches the personality you wrote.
- **Does it call the right tools?** If the agent is supposed to read files, ask it to. Watch the inline tool-call card — it shows the tool name, arguments, and (expandable) output.
- **Is the system prompt what you expect?** Open the Sessions panel (Activity Bar → `📨 Sessions`), select this session, toggle **Debug mode**, click the **Prompt** button in the viewer header. Full rendered system prompt (AGENT.md + USER.md + INSTRUCTIONS.md + skill metadata + tool list).
- **Is the model correct?** Debug mode's usage badges show `model` on every assistant turn.

### 5. Iterate

Edits are never retroactive — the turn that is running finishes on the old config — but a session is rebuilt from disk after every run, so the **next turn** of an existing session already picks them up:

| What you changed | When it takes effect |
|---|---|
| `AGENT.md` body, `agent.yaml` tools / skills / model | Next turn (and any new session) |
| `settings.yaml` values | Next turn (or next `activate_skill` call for SKILL bodies) |
| Env vars (`<<ENV>>` placeholders) | Restart server, then next turn |

So the loop is: edit → send another message (or `/session new` for a clean slate) → re-test. No server restart for MD/YAML/settings changes. Full table in [delegation-and-access.md](delegation-and-access.md#2-when-a-config-edit-takes-effect).

---

## Testing a skill

There is **no separate "test this skill" button**. Skills exist to be called by an agent, so the test path is:

### 1. Attach the skill to an agent

In the agent's Form view, the **Skills** section lists every skill in the workspace. Check the one you want to test (the form auto-saves).

Equivalent YAML edit:

```yaml
skills:
  - your-skill-id
```

### 2. Test that agent

Click the agent's Test button (same flow as above).

### 3. Trigger the skill — two paths

**Path A: natural language** — ask the agent something that fits the skill's description.

For a `code-review` skill with description "Review code for correctness, performance, and style":
> "Please review packages/server/src/agents/agent-loader.ts"

The agent decides to call `activate_skill(skill_id='code-review')`, which returns the full SKILL.md body. It then follows those instructions.

**Path B: slash command** — if the SKILL.md frontmatter declares `command: /review`:
> `/review packages/server/src/agents/agent-loader.ts`

Halo renders the SKILL.md body with `$ARGUMENTS` / `{{args}}` = `packages/server/src/agents/agent-loader.ts` and sends it to the agent as a message (args reach the body only through placeholders). See [skills.md#skill-as-command](skills.md#skill-as-command).

### 4. Verify activation

In Sessions → Debug mode, find the assistant turn. You should see a tool-call card named `activate_skill` with:
- `skill_id`: your skill's ID
- Output: the full SKILL.md body (with placeholders rendered)

If the card is missing, the agent didn't decide to use the skill — see "Common issues" below.

### 5. Verify placeholders rendered

If your SKILL.md references `{{params.api_key}}` (short form, auto-qualified to `{{<skill-id>.params.api_key}}` at activation) or `<<EXAMPLE_KEY>>`, inspect the tool-call output (expand the card). The rendered body should show the real value (or, if the env var is unset, the literal `<<EXAMPLE_KEY>>` — that's intentional, see [secrets-and-credentials.md](secrets-and-credentials.md#missing-env-var)).

---

## Common issues

### The agent never activates the skill

**Most common cause**: the skill's `description` is too vague. Agents read the description in the `<available_skills>` block and decide whether to activate based on it. "Helps with code" is useless. "Review code for correctness, performance bugs, style consistency with codebase" is actionable.

Other causes:
- Skill not in `agent.yaml skills:` — open the Form view and re-check the box
- `SKILL.md` missing from both `<ws>/.halo/skills/<id>/` and `~/.halo/global/skills/<id>/`
- Skill name collision: a workspace skill with the same id shadows the global one. Fine if intentional, surprising otherwise.

### The agent's reply shows `<<EXAMPLE_KEY>>` in plain text

The env var is unset. Halo renders the literal placeholder so you (and the agent) can see what's missing. Fix: `export EXAMPLE_KEY=...` in the shell that launches the server, restart, re-test. Full rules in [secrets-and-credentials.md](secrets-and-credentials.md).

### Saved agent changes don't seem to apply

You might be looking at a turn that was already running when you saved — it finishes on the old config, and the edit applies from the next turn. If the next turn still behaves the old way, `/session new` to start fresh.

### Deleting a test session

Sessions → hover the session → trash icon. Or programmatically: `DELETE /api/sessions/logs/:id`. Deletion cascades to child sessions (sub-agents), their JSON files, and the SQLite rows. See [dev/api.md#session-logs](../dev/api.md#session-logs-unified).

### "Test button does something weird" — the session is orphaned

Since 1.5.3-alpha, Test no longer clears any stored session: it only opens a new draft tab (the old `localStorage.halo_session_<projectId>` key is gone). The new session is created by the first message you send from that tab. If you see an old conversation instead of an empty one, the draft tab isn't the one on screen. Click **+** below the session tabs to bring it back (an unused draft is reused).

---

## References

- Test button implementation: `testAgent` in [packages/admin/src/features/agents/agent-management-main.tsx](../../../packages/admin/src/features/agents/agent-management-main.tsx)
- `activate_skill` runtime: [packages/server/src/agents/agent-loader.ts](../../../packages/server/src/agents/agent-loader.ts) (function `createSkillTool`)
- Skill metadata → system prompt: [packages/server/src/agents/agent-loader.ts](../../../packages/server/src/agents/agent-loader.ts) (function `buildSkillPrompt`)
- Chat session creation on first message: [packages/server/src/ws/handler.ts](../../../packages/server/src/ws/handler.ts) (function `handleChat`)
- End-to-end test scenarios for the session system: [test/session.md](../test/session.md)
