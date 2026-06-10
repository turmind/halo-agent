# Testing Agents and Skills

How to verify an agent you just created behaves right, and how to exercise a skill end-to-end. There is no separate "sandbox mode" — testing runs a **real** session in the current workspace with the same tools, skills, and storage as production. You just get to drive it from the Agent management UI.

## Testing an agent

### 1. Open the agent

Activity Bar → `👥 Agents` → click the agent you want to test.

### 2. Click Test

Top-right `Test` button. What it does, concretely:

1. Detaches any active chat session from the Explorer panel
2. Clears the selected agent override and sets it to this agent (`selectedAgentId`)
3. Dispatches a `halo:navigate` event that switches to the Explorer tab

Source: [packages/admin/src/features/agents/agent-management-main.tsx:278-290](../../../packages/admin/src/features/agents/agent-management-main.tsx#L278-L290).

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
- **Is the system prompt what you expect?** Open the Sessions panel (Activity Bar → `🕘 Sessions`), select this session, toggle **Debug mode**, click the **Prompt** button on the first message. Full rendered system prompt (AGENT.md + USER.md + INSTRUCTIONS.md + skill metadata + tool list).
- **Is the model correct?** Debug mode's usage badges show `model` on every assistant turn.

### 5. Iterate

Edits take effect on the **next** session, not retroactively:

| What you changed | When it takes effect |
|---|---|
| `AGENT.md` body | Next `/session new` session |
| `agent.yaml` tools / skills / model | Next session spawn |
| `settings.yaml` values | Next session spawn (or next `activate_skill` call for SKILL bodies) |
| Env vars (`<<ENV>>` placeholders) | Restart server, then next session spawn |

So the loop is: edit → `/session new` → re-test. No server restart for MD/YAML/settings changes.

---

## Testing a skill

There is **no separate "test this skill" button**. Skills exist to be called by an agent, so the test path is:

### 1. Attach the skill to an agent

In the agent's Form view, the **Skills** section lists every skill in the workspace. Check the one you want to test. Save.

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

You might be looking at a session that started *before* the edit. Every session caches its own assembled system prompt at spawn time. `/session new` to start fresh, or switch to a different session and back.

### Deleting a test session

Sessions → select → context menu → Delete. Or programmatically: `DELETE /api/sessions/logs/:id`. Deletion cascades to child sessions (sub-agents), their JSON files, and the SQLite rows. See [dev/api.md#session-logs](../dev/api.md#session-logs-unified).

### "Test button does something weird" — the session is orphaned

If clicking Test sometimes shows a stale conversation instead of a new one, you might be seeing a previously-detached session that hasn't been cleared. The Test handler explicitly clears `localStorage.halo_session_<projectId>` and the in-memory `sessionId` — but an in-flight WS message can race. Refresh the page; it should settle.

---

## References

- Test button implementation: [packages/admin/src/features/agents/agent-management-main.tsx:278-290](../../../packages/admin/src/features/agents/agent-management-main.tsx#L278-L290)
- `activate_skill` runtime: [packages/server/src/agents/agent-loader.ts:111-159](../../../packages/server/src/agents/agent-loader.ts#L111-L159) (function `createSkillTool`)
- Skill metadata → system prompt: [packages/server/src/agents/agent-loader.ts:97-102](../../../packages/server/src/agents/agent-loader.ts#L97-L102) (function `buildSkillPrompt`)
- Chat session creation on first message: [packages/server/src/ws/handler.ts:263-344](../../../packages/server/src/ws/handler.ts#L263-L344) (function `handleChat`)
- End-to-end test scenarios for the session system: [test/session.md](../test/session.md)
