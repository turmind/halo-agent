/**
 * ModelRuntime — provider-agnostic interface for LLM streaming agents.
 *
 * Each wire protocol (Bedrock InvokeModel, Anthropic Messages, OpenAI Chat
 * Completions, …) ships an implementation that adapts its native API to this
 * interface. A provider yaml (`<global>/models/<providerId>.yaml`) keeps `id`
 * as the provider identity (model picker, `agent.yaml` `model.provider`,
 * `<id>.secrets.*`) and names its implementation in `runtime:` —
 * `resolveProviderRuntime` reads that field, `createModelRuntime` dispatches
 * on it.
 */
import path from 'node:path'
import { BedrockAgent } from './bedrock-agent.js'
import { DeepSeekAgent } from './deepseek-agent.js'
import { KimiAgent } from './kimi-agent.js'
import { MiniMaxAgent } from './minimax-agent.js'
import { QwenAgent } from './qwen-agent.js'
import { HunyuanAgent } from './hunyuan-agent.js'
import { DoubaoAgent } from './doubao-agent.js'
import { ZhipuAgent } from './zhipu-agent.js'
import { OpenAIAgent } from './openai-agent.js'
import { MantleAgent } from './mantle-agent.js'
import { AnthropicAgent } from './anthropic-agent.js'
import type { AgentEvent, AnthropicMessage, ContentBlock, ToolDef } from './bedrock-agent.js'
import { getModelsRegistry, HALO_GLOBAL_DIR } from '../config.js'

export interface ModelRuntimeConfig {
  modelId: string
  systemPrompt: string
  tools: ToolDef[]
  maxTokens?: number
  promptCaching?: boolean | '5m' | '1h'
  thinking?: { enabled: boolean; effort?: string }
  /** Which thinking API the model wants — see `resolveThinkingMode` in
   *  config.ts. The Bedrock Claude and MiniMax providers branch on it. */
  thinkingMode?: 'adaptive' | 'manual'
  /** Output verbosity for the OpenAI Responses API (`text.verbosity`).
   *  Currently only the Mantle provider uses it. */
  verbosity?: 'low' | 'medium' | 'high'
  /** Explicit budget_tokens for manual-mode thinking. When set, it overrides
   *  the effort→budget translation. Ignored in adaptive mode. */
  thinkingBudgetTokens?: number
  /** Provider endpoint URL (agent.yaml `model.endpoint`, required there) */
  endpoint: string
  /** Explicit AWS credentials — if empty, falls back to default credential chain */
  credentials?: { accessKeyId: string; secretAccessKey: string }
  /** API key for providers that use bearer token auth (Kimi, DeepSeek, etc.) */
  apiKey?: string
  /** Session ID — used as cache key hint for providers with automatic caching (Kimi) */
  sessionId?: string
}

export interface ModelRuntime {
  /** Conversation state — mutated externally during compaction/repair */
  messages: AnthropicMessage[]
  /** Empty `input` (`[]`) = resume: skip the user push and call the model on
   *  the existing history. SessionManager's retry loop uses this so a failed
   *  attempt's already-landed input isn't stacked again. */
  run(
    input: string | ContentBlock[],
    options?: {
      cancelSignal?: AbortSignal
      /** Pre-model-call hook used by SessionManager to interleave context
       *  management (mid-turn auto-compact) inside the agent loop. */
      beforeCallModel?: () => Promise<void>
    },
  ): AsyncGenerator<AgentEvent>
}

/** Values a provider yaml's `runtime:` may name — one per implementation
 *  class. Vendor subclasses keep their vendor name. */
export const MODEL_RUNTIME_NAMES = [
  'anthropic-messages', 'openai-chat', 'bedrock-invoke', 'bedrock-mantle',
  'kimi', 'deepseek', 'minimax', 'qwen', 'hunyuan', 'doubao', 'zhipu',
] as const

/** Look up the `runtime:` of a provider's yaml in the models registry. Throws
 *  when the yaml is missing, lacks the field (seed predates it), or names a
 *  runtime this build doesn't know. */
export function resolveProviderRuntime(providerId: string): string {
  const yamlPath = path.join(HALO_GLOBAL_DIR, 'models', `${providerId}.yaml`)
  const providers = (getModelsRegistry() as { providers: Array<Record<string, unknown>> }).providers
  const entry = providers.find((p) => p.id === providerId)
  if (!entry) {
    throw new Error(`[model-runtime] Unknown provider "${providerId}": no provider yaml with that id (expected ${yamlPath}). Check agent.yaml model.provider, or run \`halo setup\` to install the bundled providers.`)
  }
  const runtime = entry.runtime
  if (typeof runtime !== 'string' || !runtime) {
    throw new Error(`[model-runtime] Provider "${providerId}" has no \`runtime:\` field in ${yamlPath}. Run \`halo setup\` or restart the Halo server to refresh templates.`)
  }
  if (!(MODEL_RUNTIME_NAMES as readonly string[]).includes(runtime)) {
    throw new Error(`[model-runtime] Provider "${providerId}" names unknown runtime "${runtime}" in ${yamlPath}. Valid runtimes: ${MODEL_RUNTIME_NAMES.join(', ')}.`)
  }
  return runtime
}

export function createModelRuntime(runtime: string, cfg: ModelRuntimeConfig): ModelRuntime {
  switch (runtime) {
    case 'bedrock-invoke':
      return new BedrockAgent({
        modelId: cfg.modelId,
        endpoint: cfg.endpoint,
        systemPrompt: cfg.systemPrompt,
        tools: cfg.tools,
        maxTokens: cfg.maxTokens,
        promptCaching: cfg.promptCaching,
        thinking: cfg.thinking,
        thinkingMode: cfg.thinkingMode,
        thinkingBudgetTokens: cfg.thinkingBudgetTokens,
        credentials: cfg.credentials,
      })
    case 'kimi':
      return new KimiAgent({
        modelId: cfg.modelId,
        endpoint: cfg.endpoint,
        apiKey: cfg.apiKey ?? '',
        systemPrompt: cfg.systemPrompt,
        tools: cfg.tools,
        maxTokens: cfg.maxTokens,
        thinking: cfg.thinking,
        cacheKey: cfg.sessionId,
      })
    case 'deepseek':
      return new DeepSeekAgent({
        modelId: cfg.modelId,
        endpoint: cfg.endpoint,
        apiKey: cfg.apiKey ?? '',
        systemPrompt: cfg.systemPrompt,
        tools: cfg.tools,
        maxTokens: cfg.maxTokens,
        thinking: cfg.thinking,
      })
    case 'minimax':
      return new MiniMaxAgent({
        modelId: cfg.modelId,
        endpoint: cfg.endpoint,
        apiKey: cfg.apiKey ?? '',
        systemPrompt: cfg.systemPrompt,
        tools: cfg.tools,
        maxTokens: cfg.maxTokens,
        promptCaching: cfg.promptCaching,
        thinking: cfg.thinking,
        thinkingMode: cfg.thinkingMode,
        thinkingBudgetTokens: cfg.thinkingBudgetTokens,
      })
    case 'qwen':
      return new QwenAgent({
        modelId: cfg.modelId,
        endpoint: cfg.endpoint,
        apiKey: cfg.apiKey ?? '',
        systemPrompt: cfg.systemPrompt,
        tools: cfg.tools,
        maxTokens: cfg.maxTokens,
        promptCaching: cfg.promptCaching,
        thinking: cfg.thinking,
        thinkingBudgetTokens: cfg.thinkingBudgetTokens,
      })
    case 'hunyuan':
      return new HunyuanAgent({
        modelId: cfg.modelId,
        endpoint: cfg.endpoint,
        apiKey: cfg.apiKey ?? '',
        systemPrompt: cfg.systemPrompt,
        tools: cfg.tools,
        maxTokens: cfg.maxTokens,
        thinking: cfg.thinking,
      })
    case 'doubao':
      return new DoubaoAgent({
        modelId: cfg.modelId,
        endpoint: cfg.endpoint,
        apiKey: cfg.apiKey ?? '',
        systemPrompt: cfg.systemPrompt,
        tools: cfg.tools,
        maxTokens: cfg.maxTokens,
        thinking: cfg.thinking,
      })
    case 'zhipu':
      return new ZhipuAgent({
        modelId: cfg.modelId,
        endpoint: cfg.endpoint,
        apiKey: cfg.apiKey ?? '',
        systemPrompt: cfg.systemPrompt,
        tools: cfg.tools,
        maxTokens: cfg.maxTokens,
        thinking: cfg.thinking,
      })
    case 'openai-chat':
      return new OpenAIAgent({
        modelId: cfg.modelId,
        endpoint: cfg.endpoint,
        apiKey: cfg.apiKey ?? '',
        systemPrompt: cfg.systemPrompt,
        tools: cfg.tools,
        maxTokens: cfg.maxTokens,
        thinking: cfg.thinking,
      })
    // OpenAI Responses API on Bedrock — serves both aws-bedrock-mantle
    // (bedrock-mantle host) and aws-bedrock-openai (bedrock-runtime host,
    // /openai/v1); the endpoint alone picks the host and SigV4 region.
    case 'bedrock-mantle':
      return new MantleAgent({
        modelId: cfg.modelId,
        endpoint: cfg.endpoint,
        // No bearer token → MantleAgent falls back to SigV4 IAM auth using
        // these creds (or the SDK default chain when also empty).
        apiKey: cfg.apiKey ?? '',
        credentials: cfg.credentials,
        systemPrompt: cfg.systemPrompt,
        tools: cfg.tools,
        maxTokens: cfg.maxTokens,
        thinking: cfg.thinking,
        verbosity: cfg.verbosity,
      })
    case 'anthropic-messages':
      return new AnthropicAgent({
        modelId: cfg.modelId,
        endpoint: cfg.endpoint,
        apiKey: cfg.apiKey ?? '',
        systemPrompt: cfg.systemPrompt,
        tools: cfg.tools,
        maxTokens: cfg.maxTokens,
        promptCaching: cfg.promptCaching,
        thinking: cfg.thinking,
        thinkingBudgetTokens: cfg.thinkingBudgetTokens,
      })
    default:
      throw new Error(`[model-runtime] Unknown runtime "${runtime}". Valid runtimes: ${MODEL_RUNTIME_NAMES.join(', ')}.`)
  }
}
