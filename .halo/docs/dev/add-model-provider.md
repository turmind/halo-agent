# Adding a Model Provider

How to wire up a new LLM provider (OpenAI-compatible, a local model server — anything that speaks chat completions).

## Reality check

Halo is **not a plugin system** for providers today. Adding one means:
- One new runtime class extending `AgentLoop`
- One new YAML manifest on disk
- One case added to a switch statement
- API key wiring in config.ts + settings.yaml

No recompile of the frontend — the Form view's Provider dropdown reads the manifest at startup and picks up the new provider automatically. Server code does need a rebuild.

Total effort: typically a few hours depending on how weird the upstream API is about tool use and response format.

### Existing providers

| Provider ID | Class | File | Notes |
|---|---|---|---|
| `aws-bedrock-claude-invoke` | `BedrockAgent` | `bedrock-agent.ts` | Anthropic Messages API via AWS SDK |
| `kimi` | `KimiAgent` | `kimi-agent.ts` | OpenAI-compatible, vision, thinking (reasoning_content) |
| `deepseek` | `DeepSeekAgent` | `deepseek-agent.ts` | OpenAI-compatible, thinking, no vision |
| `minimax` | `MiniMaxAgent` | `minimax-agent.ts` | Anthropic Messages API (x-api-key), thinking always-on (manual budget_tokens), prompt caching (5m, M2.7 doesn't report cache_creation_input_tokens), no vision |
| `qwen` | `QwenAgent` | `qwen-agent.ts` | Aliyun Bailian Anthropic-compatible API, thinking enable/disable both honored, prompt caching (5m only), vision on Plus, max no vision |
| `hunyuan` | `HunyuanAgent` | `hunyuan-agent.ts` | Tencent Hy3 preview via OpenAI-compatible (tokenhub.tencentmaas.com), reasoning_effort low/high (no_think = omit), automatic prompt caching (cached_tokens), no vision |
| `doubao` | `DoubaoAgent` | `doubao-agent.ts` | ByteDance Doubao Seed-2.0 (pro/lite/mini/code) on Volcengine Ark, OpenAI-compatible + `thinking:{type:'enabled'/'disabled'}` (no `auto`), automatic prompt caching, no vision |
| `openai` | `OpenAIAgent` | `openai-agent.ts` | **Generic OpenAI-compatible**. Use for native OpenAI or any third-party OpenAI gateway (incl. Ollama / llama.cpp). User fills endpoint + model id; capabilities openly editable in the form. Forgiving about cache field names (`prompt_tokens_details.cached_tokens`, `prompt_cache_hit_tokens`, `cache_read_tokens` all read) and reasoning field names (`reasoning_content` for OpenAI o-series/DeepSeek, `reasoning` for Ollama/llama.cpp). |
| `anthropic` | `AnthropicAgent` | `anthropic-agent.ts` | **Generic Anthropic Messages**. Use for api.anthropic.com or any Anthropic-compatible gateway. User fills endpoint + model id. Standard `cache_control: ephemeral` with optional `ttl: '1h'`. |
| `aws-bedrock-mantle` | `MantleAgent` | `mantle-agent.ts` | OpenAI GPT-5.x (5.5 / 5.4) on Amazon Bedrock via the **OpenAI Responses API** (not Completions/Converse/InvokeModel). Vision, reasoning via `reasoning.effort` (low/med/high, no budget_tokens), `text.verbosity`. With reasoning on, returns streaming snapshots as multiple completed items — see the "Bedrock-Mantle returns streaming snapshots as separate output items" gotcha below. |

---

## The contract

Your runtime must extend `AgentLoop` (which implements `ModelRuntime`):

```ts
// packages/server/src/agents/agent-loop.ts
export abstract class AgentLoop {
  messages: AnthropicMessage[] = []
  protected abstract callModel(
    signal: AbortSignal | undefined,
  ): Promise<ModelCallResult>
}

// packages/server/src/agents/model-runtime.ts
export interface ModelRuntime {
  messages: AnthropicMessage[]
  run(
    input: string | ContentBlock[],
    options?: { cancelSignal?: AbortSignal },
  ): AsyncGenerator<AgentEvent>
}
```

`AgentLoop` handles the tool execution loop (call model → execute tools → loop). You only implement `callModel()` — the provider-specific API call. **All providers use non-streaming (invoke) mode** — `callModel()` returns a `Promise<ModelCallResult>` containing the complete response. The base class `run()` method yields events per loop iteration.

Two important constraints:

1. **`messages` is public and externally mutated.** SessionManager's compact / repair code reaches into it. You must carry the `AnthropicMessage[]` shape and translate to the upstream's native format on each `callModel()` invocation.

2. **`ModelCallResult` is the return contract.** Your `callModel()` must populate and return a `ModelCallResult` with the full response:

   ```ts
   interface ModelCallResult {
     assistantBlocks: ContentBlock[]
     stopReason: string
     text: string
     thinking: string
     toolCalls: Array<{ id: string; name: string; input: unknown }>
     usage: { inputTokens; outputTokens; totalTokens; cacheReadInputTokens?; cacheWriteInputTokens? }
     durationMs?: number
   }
   ```

   The base class `run()` translates this into `AgentEvent`s (`text`, `thinking`, `tool_call`, `tool_result`, `usage`, `stop`) that the rest of Halo consumes.

### Usage reporting convention

All providers must normalize token counts so the UI calculates context window usage correctly:

- `inputTokens` = **non-cached** input tokens (total input minus cache hits)
- `outputTokens` = output tokens
- `totalTokens` = `inputTokens + outputTokens` (does NOT include cached tokens)
- `cacheReadInputTokens` = cache hit tokens (optional)
- `cacheWriteInputTokens` = cache write tokens (optional)

The UI computes full context as: `totalTokens + cacheRead + cacheWrite`.

For providers where the API returns `prompt_tokens` inclusive of cached (e.g. Kimi, DeepSeek), subtract cache hit before reporting `inputTokens`.

---

## Steps

### 1. Write the runtime

Create `packages/server/src/agents/<provider>-agent.ts`. Extend `AgentLoop` and implement `callModel()`.

Reference implementations:
- OpenAI-compatible: [kimi-agent.ts](../../../packages/server/src/agents/kimi-agent.ts), [deepseek-agent.ts](../../../packages/server/src/agents/deepseek-agent.ts)
- AWS native: [bedrock-agent.ts](../../../packages/server/src/agents/bedrock-agent.ts)

Rough shape for OpenAI-compatible providers:

```ts
import { AgentLoop } from './agent-loop.js'
import type { ContentBlock, ModelCallResult, ToolDef } from './agent-loop.js'

export class MyProviderAgent extends AgentLoop {
  constructor(config: MyConfig) { super(config.tools); ... }

  protected async callModel(signal): Promise<ModelCallResult> {
    const startTime = Date.now()
    const messages = this.buildMessages()  // translate AnthropicMessage[] → provider format
    const tools = this.buildTools()        // translate ToolDef[] → provider format

    // POST to endpoint with stream: false, parse JSON response
    // Return ModelCallResult with assistantBlocks, stopReason, text, thinking, toolCalls, usage, durationMs
  }

  private buildMessages() { ... }  // system + user/assistant/tool message conversion
  private buildTools() { ... }     // OpenAI function calling format
}
```

**Things that bite**:

- **Tool results format.** Anthropic stores tool results as `{ role: 'user', content: [{ type: 'tool_result', ... }] }`. OpenAI-compatible APIs need separate `{ role: 'tool', tool_call_id, content }` messages. See `convertToolResults()` in kimi-agent.ts.
- **Thinking/reasoning replay.** If the provider returns `reasoning_content` and requires it in follow-up messages (Kimi, DeepSeek with tool calls), you must store it in `result.assistantBlocks` as a `{ type: 'thinking', thinking: '...' }` block and replay it as `reasoning_content` in `convertAssistantMessage()`.
- **Reasoning field name varies.** OpenAI o-series/DeepSeek emit reasoning in `message.reasoning_content`; Ollama / llama.cpp's OpenAI-compat layer uses `message.reasoning`. `OpenAIAgent` reads both (`reasoning_content ?? reasoning`). A vendor-specific class should read whichever its API uses.
- **Cancellation.** The caller passes `signal`; pass it to `fetch()` directly.
- **Max tokens.** Use `config.maxTokens ?? resolveMaxOutputTokens(config.modelId)` for consistency.
- **Prompt caching and thinking** are optional per provider. If unsupported, silently ignore.

### 2. Write the manifest

Create `packages/server/templates/models/<provider>.yaml` (deployed to `~/.halo/global/models/` on init):

```yaml
id: myprovider                         # required, must match filename and agent.yaml model.provider
displayName: My Provider
description: Short description
defaultEndpoint: https://api.example.com/v1

models:
  - id: my-model-v1
    displayName: My Model V1
    maxOutputTokens: 16384
    capabilities:
      image: true                      # supports image input
      video: false                     # no video understanding
      audio: false                     # no audio input
      promptCaching:                   # omit this block if the provider can't cache
        ttlPresets:
          - { value: 5m, label: 5min }
      thinking:                        # omit to hide Thinking toggle in the UI
        effortPresets:
          - { value: enabled, label: On }
          - { value: disabled, label: Off }
```

**Capability flags drive the UI.** The Form view reads this file directly to decide which controls to render:
- `defaultEndpoint` → auto-fills endpoint when switching provider in agent/settings UI
- `capabilities.image` / `capabilities.video` / `capabilities.audio` → modality badges (green = supported, grey = unsupported); also controls runtime behavior in two ways: (a) the `view_image` workspace tool is dropped from the agent's tool list at session-create time when `image: false`, so the model never sees a tool the provider would 400 on; (b) user-supplied images on inbound messages are filtered with a text notice instead of being sent to the API
- `capabilities.promptCaching.ttlPresets` → renders the Prompt Caching dropdown with those options
- `capabilities.thinking.effortPresets` → renders the Thinking effort dropdown
- Omit either block → the UI hides that control for this model

Shape source: [packages/server/templates/models/aws-bedrock-claude-invoke.yaml](../../../packages/server/templates/models/aws-bedrock-claude-invoke.yaml) and [design/storage.md#model-registry-format](../design/storage.md#model-registry-format).

### 3. Wire the dispatcher

Edit [packages/server/src/agents/model-runtime.ts](../../../packages/server/src/agents/model-runtime.ts) — add import and switch case:

```ts
import { MyProviderAgent } from './myprovider-agent.js'

case 'myprovider':
  return new MyProviderAgent({
    modelId: cfg.modelId,
    endpoint: cfg.endpoint ?? 'https://api.example.com/v1',
    apiKey: cfg.apiKey ?? '',
    systemPrompt: cfg.systemPrompt,
    tools: cfg.tools,
    maxTokens: cfg.maxTokens,
    thinking: cfg.thinking,
  })
```

### 4. Declare API key in the provider yaml

Add a `secrets:` section to the provider manifest you wrote in step 2:

```yaml
# packages/server/templates/models/myprovider.yaml
id: myprovider
displayName: My Provider
defaultEndpoint: https://api.example.com/v1

secrets:
  - key: api_key
    description: My Provider API Key
    description_zh: 我的供应商 API Key
    default: <<MY_PROVIDER_API_KEY>>
    secret: true

models:
  - id: my-model-v1
    ...
```

The Settings page reads this declaration and renders inputs grouped under "My Provider". Values land in `~/.halo/secrets/settings.yaml` at `myprovider.secrets.api_key`.

`resolveApiKey('myprovider')` reads `<provider-id>.secrets.api_key` automatically — **no `config.ts` changes needed for bearer-token providers**. AWS-credential-style providers (access_key_id + secret_access_key) get them via `resolveAwsCredentials(providerId)`.

If a user wants to keep the key in an env var, they leave the `default` (`<<MY_PROVIDER_API_KEY>>`) as the value; `getServerSecret` expands `<<…>>` references at read time. Missing env var → the literal `<<MY_PROVIDER_API_KEY>>` propagates to the API call, which fails loudly with a clear 401 — there is **no hard-coded silent fallback** to a canonical env var, by design (typoed env-var names should be discoverable, not masked by a global default).

> Only put a key under `params:` if a *skill* needs to inject it into a shell command (e.g. `curl -H "Authorization: Bearer {{tavily-web-search.params.api_key}}"`). Server-side provider keys belong in `secrets:` — they're never visible to agents.

### 5. Bump template version

In [packages/server/src/init.ts](../../../packages/server/src/init.ts), increment `TEMPLATE_VERSION` so new manifests and settings deploy on restart.

### 6. Use it

In any `agent.yaml`:

```yaml
model:
  provider: myprovider
  id: my-model-v1
  endpoint: https://api.example.com/v1
```

Or via the Form view: the Provider dropdown will include the new provider once the manifest is on disk and the server restarts.

---

## Testing

1. Set the API key as env var or in settings.yaml
2. Edit an agent's YAML to use your new provider (or switch via Form view)
3. Send a plain message → check text arrives
4. Send a "read this file" message → check tool calls fire and the agent uses the result
5. Check the usage badges: `inputTokens` (non-cached) + `cacheRead` should equal total prompt tokens; token ring should show correct context window percentage
6. If the provider supports thinking, verify `reasoning_content` appears and tool loop works across multiple turns

If something's wrong, server logs under `~/.halo/global/logs/server.log` are the first place to look. The dispatcher throws `Unknown provider "..."` when either the manifest's `id` doesn't match or the switch is missing a case.

---

## When to use the generic `openai` / `anthropic` provider instead of writing a new class

Two of the providers above are deliberately generic — they take whatever `endpoint` + `model id` the user fills in the form and don't ship a curated model list. Use them when:

- The new vendor speaks **stock OpenAI chat completions** or **stock Anthropic Messages** with no quirks worth coding around. Examples: self-hosted vLLM, third-party OpenAI gateway.
- You don't want to maintain a model registry for that vendor — users are expected to know what model id and endpoint to use.

Write a dedicated provider class when:

- The vendor's wire shape diverges enough that hard-coding it makes sense (auth header is non-standard, cache field has a unique name, thinking field uses a vendor-specific shape, image format is custom, etc.).
- You want the form to lock down certain capabilities (e.g. "Doubao Mini doesn't support thinking auto-mode" → manifest enforces; user can't accidentally set it).

In the admin form, when the user picks `openai` / `anthropic` **and** types a model id that isn't in the (sparse) `models:` list, the form treats every capability as user-editable: `image` / `video` / `audio` become checkboxes (instead of read-only badges), and the thinking control shows both effort labels and a "use budget" link to flip to a numeric `budget_tokens` input. The choice is persisted to `agent.yaml model.image/video/audio` and overrides the registry default at runtime via `modelSupportsImage(modelId, override)`.

---

## Onboarding gotchas (lessons from MiniMax / Qwen)

Things that bit during recent provider integrations — fix them before you ship the manifest, not after.

### Don't trust capability claims — probe before declaring

Vendor docs say one thing; the wire returns another. Before writing `capabilities.image: true|false` etc. in the manifest, run a one-off probe with the API key and confirm. Examples we hit:

- **MiniMax doc:** "thinking 完全支持" with no detail. Live probe: `thinking:{type:'disabled'}` and omitting the field both still produce a thinking block — thinking can't actually be disabled. Manifest needs to reflect this (no off toggle).
- **Aliyun Qwen doc:** says image input "需视觉模型" (requires vision models). Live probe: `qwen3.6-plus` correctly identifies a colored PNG; `qwen3.7-max` returns `Unexpected item type in content`. So one model in the same family supports vision and the other doesn't, contrary to the doc grouping. Capability flags must be per-model, not copy-pasted.
- **MiniMax M2.7 caching:** vendor doesn't document it, and a single cold-miss probe returns `cache_creation_input_tokens: 0`. Easy to conclude "doesn't support caching" — wrong. The cache **does** get written; M2.7 just doesn't report the creation count. You only see this by sending the same prompt twice and watching `cache_read_input_tokens` light up on turn 2.

### Prompt caching probes — always send the same prompt twice

`cache_creation_input_tokens` is reported by some providers, suppressed by others. The reliable signal that caching works is: same exact prompt → second turn shows `cache_read_input_tokens > 0`. **One-shot cache-buster probes are the wrong test** — they only show you what creation looks like, not whether read happens.

Minimum experiment for any new provider that claims caching:

```js
// Same long system prompt, two turns
for (let i = 0; i < 2; i++) {
  const res = await fetch(endpoint, { ..., body: JSON.stringify({
    system: [{ type: 'text', text: longSys, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: 'hi' }],
  })})
  console.log(`turn ${i+1} usage:`, (await res.json()).usage)
}
```

Turn 2 should show non-zero `cache_read_input_tokens`. If yes → caching works regardless of what turn 1 reports.

### Use the doc's TTL — don't infer from "no error returned"

If you POST `cache_control: { ttl: 'banana' }` and the server doesn't 400, that's **not** evidence the gateway accepted `banana`. Most Anthropic-compatible gateways are lenient; they ignore unknown attributes silently and use the default TTL. Set `ttlPresets` from what the doc says, not from "what didn't error."

(Example: MiniMax docs say 5min, no `1h` mention → manifest only exposes `5m`. Aliyun's `cache_creation` field name is `ephemeral_5m_input_tokens`, also confirming 5min default. Don't put `1h` in the form just because `ttl: '1h'` doesn't 400.)

### Manifest changes need a server restart

`getModelsRegistry()` is loaded at module-init time and cached as a module-level const (see [config.ts:loadModelsRegistry](../../../packages/server/src/config.ts)). Editing or copying a new `models/<provider>.yaml` while the server is running has **no effect on a running session** — the form will keep showing the old presets. Either restart, or wait for the next process boot.

(Distinct from `settings.yaml`, which is mtime-watched and re-read on each access.)

### env var → secret expansion — settings.yaml entry is required

Adding `default: <<MY_PROVIDER_API_KEY>>` to the manifest's `secrets:` block does **not** automatically populate settings.yaml. `resolveApiKey('myprovider')` reads from `<provider>.secrets.api_key` in settings.yaml, then expands `<<…>>` against env vars. If settings.yaml has no entry for the provider, you get `undefined` even when the env var is set.

`halo setup` writes the entry on first run. For a hot deploy without re-running setup, append it manually:

```yaml
# ~/.halo/secrets/settings.yaml
myprovider:
  secrets:
    api_key: <<MY_PROVIDER_API_KEY>>
```

### Effort labels are Halo-side only

`effortPresets: [low, medium, high]` is purely a UI affordance — it lives on the form and gets translated to `budget_tokens` (or whatever the provider wants) inside the agent class via an effort→budget table. Don't write `effort=medium` directly to the wire. Provider doesn't know what `medium` means.

Probe each preset's actual budget against the model's `maxOutputTokens`. We hit this with MiniMax: `low` (1024 budget) caused `stop=max_tokens` before any thinking completed — left it out of the preset list.

### Image probes — verify with a real image, not a 1×1 pixel

A 1×1 PNG is too small to be meaningful — some providers return generic "I can't see an image" responses on it even when they do support vision. Use a 64×64 solid-color PNG and ask for the dominant color. If the model says "Red" / "Blue" → vision works.

```python
# generate a 64x64 solid PNG (any color), base64-encode for the API
import base64, struct, zlib
def png(w, h, rgb):
    sig = b'\x89PNG\r\n\x1a\n'
    ihdr = struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)
    raw = b''.join(b'\x00' + bytes(rgb * w) for _ in range(h))
    idat = zlib.compress(raw)
    chunk = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d))
    return sig + chunk(b'IHDR', ihdr) + chunk(b'IDAT', idat) + chunk(b'IEND', b'')
print(base64.b64encode(png(64, 64, [255, 0, 0])).decode())
```

### Bedrock-Mantle returns streaming snapshots as separate output items

`aws-bedrock-mantle` (GPT-5.x via Bedrock's OpenAI Responses surface) has a server-side quirk: with **reasoning enabled**, it returns the *streaming generation* of a single logical output as **multiple completed items**, each a growing superset of the last. Two faces of the same bug:

- **`message`**: emitted as `reasoning → message → reasoning → message …`, each later `message` repeating the prior as a growing superset → `MantleAgent` keeps only the **last** message item (see `mantle-agent.ts`, the `message` branch).
- **`function_call`**: a **long-argument** tool call comes back as `reasoning,fc,reasoning,fc,…` — N items, each carrying a growing **prefix snapshot** of the arguments JSON. Only the last is complete, valid JSON; the earlier N-1 are truncated mid-string (verified: a `draft` call returned 11 truncated snapshots + 1 complete, arguments length 461→…→2214). `MantleAgent` filters on **JSON completeness** — `strictParseOrNull` returns null for a truncated fragment and the parse loop skips it. This is tool- and length-agnostic: a genuine parallel tool_use (each `function_call` its own complete JSON, e.g. 4 distinct `shell_exec` searches) is fully preserved; only truncated snapshots are dropped.

Distinguishing snapshot-spam from real parallel calls: snapshots are same-`name` with `reasoning,fc` **interleaved** and arguments forming a growing prefix chain; parallel calls are one `reasoning` then `fc,fc,fc` **consecutive** with independent complete arguments. Root cause is in Bedrock-Mantle, not halo — first-party OpenAI returns a single final item. If Bedrock ever fixes this, the "last only" / completeness filters become no-ops, not regressions.

Diagnosis note: the session file's `rawMessages` stores arguments **after** `strictParseOrNull`, so truncated snapshots already show as `{}` — they look like "empty tool calls", not snapshots. To see the real shape you must capture Mantle's **raw response body** (temporary `console.warn` in the parse loop; `console.log` is dropped at the default `warn` log level).

---

## Not a plugin system — why not

Keeping it a hard-coded switch is deliberate for now:
- Each provider has enough quirks (auth, response format, tool calling conventions, thinking replay rules) that a generic "provider interface with fetch client" would leak abstractions
- Each provider independently extends `AgentLoop` — no shared OpenAI-compatible base class, to avoid coupling when APIs diverge
- The Agent management UI reads the manifest directly; a runtime-registered plugin would need to notify the frontend dynamically
- One provider lands every few months, not every week

If / when Halo has 5+ providers and the switch becomes unwieldy, the next step would be a module-load registry — each provider exports a `register(providerId, factory)` call that the dispatcher discovers at boot. Until then, editing the switch is simpler than managing a registry.

---

## References

- Base class (agent loop): [packages/server/src/agents/agent-loop.ts](../../../packages/server/src/agents/agent-loop.ts)
- Dispatcher + interface: [packages/server/src/agents/model-runtime.ts](../../../packages/server/src/agents/model-runtime.ts)
- Bedrock (Anthropic native): [packages/server/src/agents/bedrock-agent.ts](../../../packages/server/src/agents/bedrock-agent.ts)
- Kimi (OpenAI-compatible + vision): [packages/server/src/agents/kimi-agent.ts](../../../packages/server/src/agents/kimi-agent.ts)
- DeepSeek (OpenAI-compatible, no vision): [packages/server/src/agents/deepseek-agent.ts](../../../packages/server/src/agents/deepseek-agent.ts)
- Manifest examples: [packages/server/templates/models/](../../../packages/server/templates/models/)
- Models registry loader: [packages/server/src/config.ts](../../../packages/server/src/config.ts) (`getModelsRegistry`)
- Architecture context: [design/architecture.md#modelruntime](../design/architecture.md#modelruntime--llm-interaction-layer-provider-agnostic)
- Agent lifecycle context: [design/agent.md#agent-instance](../design/agent.md#agent-instance)
