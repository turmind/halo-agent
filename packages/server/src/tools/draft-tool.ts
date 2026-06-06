/**
 * Draft tool — opt-in self-review step for an agent's final answer.
 *
 * The agent loop only ever makes another model call when the model emits a
 * `tool_use` block (see agent-loop.ts). A plain text answer (`end_turn`) is
 * single-pass — `thinking` happens BEFORE the answer in the same call, so the
 * model never gets to look at its own finished answer and revise it.
 *
 * `draft` closes that gap without touching the loop: the model writes its
 * answer into the tool's `content` input (which is materialised into the
 * conversation, uncapped), and the tool_result hands back an adversarial
 * review checklist. The next model call then critiques that now-concrete
 * draft — and either revises (calls `draft` again) or writes the final answer.
 *
 * Opt-in per agent: list `draft` in the agent.yaml `tools:` whitelist. No
 * global switch — agents that don't want it simply don't declare it.
 *
 * Bounded by a classic per-turn counter (NOT a prompt instruction — that
 * would just be noise in the model's context): after MAX_DRAFTS calls in a
 * single turn, the tool returns a friendly "stop drafting, answer now"
 * message instead of the checklist. `reset()` is called at the top of every
 * turn-attempt by the session manager so the budget refreshes per user turn.
 */
import { TOOL_ERROR_MARKER, type ToolDef } from '../agents/agent-loop.js'

/** Max draft rounds per turn. Past this the tool soft-lands: it stops handing
 *  back the checklist and tells the model to finalise. Three rounds is enough
 *  for "draft → fix the things the review caught → maybe one more"; more than
 *  that is usually the model spinning rather than improving. */
const MAX_DRAFTS = 3

/** The adversarial review handed back after each draft. Framed as a hostile
 *  reviewer on purpose: a model asked "is this good?" tends to self-affirm and
 *  wave its own draft through; a model told "find what's wrong with this" digs.
 *  The fact checklist forces an explicit per-claim source label so "I checked,
 *  it's fine" can't slide by without an actual tool call. */
const REVIEW_CHECKLIST = `You are now a hostile reviewer whose job is to find everything wrong with the draft above. Do not defend it — attack it.

1. Facts: list every factual claim in the draft, each tagged [verified-with-tool] / [from-memory] / [guess]. For anything not [verified-with-tool], verify it NOW with file_read / grep / search, or mark it "unconfirmed" in the answer. Do not assert from memory.
2. Delivery: is it friendly? Does it answer the question simply and directly, or is it dancing around? If it uses a rhetorical question, is that question actually necessary?
3. Gaps: is anything missing? If it can be looked up, look it up; if it can't, say "unknown" — don't paper over it.

If the draft clears all three, write the final answer now. If not, fix it (gather more via tools, or call draft again to rewrite).`

/**
 * Build the `draft` tool plus its per-turn reset hook.
 *
 * @returns `{ tool, reset }` — register `tool` in the agent's tool set; call
 *          `reset()` at the start of each turn-attempt to refresh the budget.
 */
export function createDraftTool(): { tool: ToolDef; reset: () => void } {
  // Per-turn call count. Lives in this closure; the agent instance is reused
  // across turns (one per session), so without reset() this would accumulate
  // across the whole session and lock the tool after the first three answers.
  let drafts = 0

  const tool: ToolDef = {
    name: 'draft',
    description:
      'Submit a draft answer for self-review. Returns a checklist that critiques '
      + 'the draft so you can improve it before sending the final answer.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        content: {
          type: 'string' as const,
          description: 'The complete draft answer. Required and must be non-empty.',
        },
      },
      required: ['content'],
    },
    callback: (input: unknown) => {
      // `content` is schema-required, but the model sometimes calls draft with
      // an empty `{}` anyway — and an empty draft has nothing to review. Reject
      // it WITHOUT consuming a draft round (it never produced a real draft), so
      // a stray empty call doesn't eat into the budget or hand back a checklist
      // for a draft that isn't there.
      const content = (input as { content?: unknown })?.content
      if (typeof content !== 'string' || content.trim().length === 0) {
        return `${TOOL_ERROR_MARKER}\nError: draft requires non-empty \`content\` — put your full draft answer there.`
      }
      // The draft text itself is already in the conversation as this tool_use
      // block's input — no need to echo it back. The result is just the review
      // (short, so it never trips the tool_result truncation cap).
      drafts++
      if (drafts > MAX_DRAFTS) {
        return `You have drafted ${MAX_DRAFTS} times this turn — that is the limit. Write your final answer now, directly, without calling draft again.`
      }
      return REVIEW_CHECKLIST
    },
  }

  return { tool, reset: () => { drafts = 0 } }
}
