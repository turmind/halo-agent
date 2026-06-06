/**
 * ModelRuntime — provider-agnostic interface for LLM streaming agents.
 *
 * Each provider (aws-bedrock-claude-invoke, openai, etc.) ships an implementation that
 * adapts its native SDK to this interface. `createModelRuntime` dispatches by
 * `providerId` — the same id that appears in `<global>/models/<providerId>.yaml`
 * and in `agent.yaml` `model.provider`.
 */
import { BedrockAgent } from './bedrock-agent.js'
import { DeepSeekAgent } from './deepseek-agent.js'
import { KimiAgent } from './kimi-agent.js'
import { MiniMaxAgent } from './minimax-agent.js'
import { QwenAgent } from './qwen-agent.js'
import { HunyuanAgent } from './hunyuan-agent.js'
import { DoubaoAgent } from './doubao-agent.js'
import { OpenAIAgent } from './openai-agent.js'
import { MantleAgent } from './mantle-agent.js'
import { AnthropicAgent } from './anthropic-agent.js'
import type { AgentEvent, AnthropicMessage, ContentBlock, ToolDef } from './bedrock-agent.js'

export interface ModelRuntimeConfig {
  modelId: string
  systemPrompt: string
  tools: ToolDef[]
  maxTokens?: number
  promptCaching?: boolean | '5m' | '1h'
  thinking?: { enabled: boolean; effort?: string }
  /** Which thinking API the model wants — see `resolveThinkingMode` in
   *  config.ts. Currently only the Bedrock Claude provider branches on it. */
  thinkingMode?: 'adaptive' | 'manual'
  /** Output verbosity for the OpenAI Responses API (`text.verbosity`).
   *  Currently only the Mantle provider uses it. */
  verbosity?: 'low' | 'medium' | 'high'
  /** Explicit budget_tokens for manual-mode thinking. When set, it overrides
   *  the effort→budget translation. Ignored in adaptive mode. */
  thinkingBudgetTokens?: number
  /** Provider endpoint URL */
  endpoint?: string
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

export function createModelRuntime(providerId: string, cfg: ModelRuntimeConfig): ModelRuntime {
  switch (providerId) {
    case 'aws-bedrock-claude-invoke':
      return new BedrockAgent({
        modelId: cfg.modelId,
        endpoint: cfg.endpoint ?? 'https://bedrock-runtime.us-east-1.amazonaws.com',
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
        endpoint: cfg.endpoint ?? 'https://api.moonshot.cn/v1',
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
        endpoint: cfg.endpoint ?? 'https://api.deepseek.com',
        apiKey: cfg.apiKey ?? '',
        systemPrompt: cfg.systemPrompt,
        tools: cfg.tools,
        maxTokens: cfg.maxTokens,
        thinking: cfg.thinking,
      })
    case 'minimax':
      return new MiniMaxAgent({
        modelId: cfg.modelId,
        endpoint: cfg.endpoint ?? 'https://api.minimaxi.com/anthropic',
        apiKey: cfg.apiKey ?? '',
        systemPrompt: cfg.systemPrompt,
        tools: cfg.tools,
        maxTokens: cfg.maxTokens,
        promptCaching: cfg.promptCaching,
        thinking: cfg.thinking,
        thinkingBudgetTokens: cfg.thinkingBudgetTokens,
      })
    case 'qwen':
      return new QwenAgent({
        modelId: cfg.modelId,
        endpoint: cfg.endpoint ?? 'https://dashscope.aliyuncs.com/apps/anthropic',
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
        endpoint: cfg.endpoint ?? 'https://tokenhub.tencentmaas.com/v1',
        apiKey: cfg.apiKey ?? '',
        systemPrompt: cfg.systemPrompt,
        tools: cfg.tools,
        maxTokens: cfg.maxTokens,
        thinking: cfg.thinking,
      })
    case 'doubao':
      return new DoubaoAgent({
        modelId: cfg.modelId,
        endpoint: cfg.endpoint ?? 'https://ark.cn-beijing.volces.com/api/v3',
        apiKey: cfg.apiKey ?? '',
        systemPrompt: cfg.systemPrompt,
        tools: cfg.tools,
        maxTokens: cfg.maxTokens,
        thinking: cfg.thinking,
      })
    case 'openai':
      return new OpenAIAgent({
        modelId: cfg.modelId,
        endpoint: cfg.endpoint ?? 'https://api.openai.com/v1',
        apiKey: cfg.apiKey ?? '',
        systemPrompt: cfg.systemPrompt,
        tools: cfg.tools,
        maxTokens: cfg.maxTokens,
        thinking: cfg.thinking,
      })
    case 'aws-bedrock-mantle':
      return new MantleAgent({
        modelId: cfg.modelId,
        endpoint: cfg.endpoint ?? 'https://bedrock-mantle.us-east-2.api.aws/openai/v1',
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
    case 'anthropic':
      return new AnthropicAgent({
        modelId: cfg.modelId,
        endpoint: cfg.endpoint ?? 'https://api.anthropic.com',
        apiKey: cfg.apiKey ?? '',
        systemPrompt: cfg.systemPrompt,
        tools: cfg.tools,
        maxTokens: cfg.maxTokens,
        promptCaching: cfg.promptCaching,
        thinking: cfg.thinking,
        thinkingBudgetTokens: cfg.thinkingBudgetTokens,
      })
    default:
      throw new Error(`[model-runtime] Unknown provider "${providerId}". Check agent.yaml model.provider and <global>/models/*.yaml.`)
  }
}
