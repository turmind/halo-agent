/**
 * Model-call error classification for `runAgentTurn`'s retry loop.
 *
 * Pure decision only — which retry branch a thrown model error belongs to.
 * The branch *actions* (backoff, repair, compaction, event texts) stay in
 * session-manager.ts; this module must not know about attempts / maxRetries.
 * Branch ORDER is the contract: first match wins.
 */

export type ModelErrorKind =
  | 'context_overflow' | 'account' | 'throttle' | 'server_error'
  | 'network' | 'empty_response' | 'corrupted' | 'multimodal_4xx' | 'fatal'

export interface ClassifiedModelError {
  kind: ModelErrorKind
  msg: string
  errName: string
  httpStatus: number | undefined
}

export function classifyModelError(err: unknown): ClassifiedModelError {
  const msg = err instanceof Error ? err.message : String(err)
  const errName = err instanceof Error ? err.name : ''
  // Prefer the AWS SDK's structured HTTP status; fall back to parsing it
  // out of the message for the fetch-based providers (anthropic / openai /
  // deepseek / doubao / hunyuan / kimi / minimax / qwen / mantle), which
  // throw plain string Errors with the status embedded — without this,
  // the transient-5xx retry below only ever fires for Bedrock.
  const httpStatusFromMeta = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode
  const httpStatusFromMsg = msg.match(/API error (\d{3})/)?.[1]
    ?? msg.match(/\]\s+(\d{3})\b/)?.[1]
    ?? msg.match(/status=(\d{3})/)?.[1]
  const httpStatus = httpStatusFromMeta ?? (httpStatusFromMsg ? Number(httpStatusFromMsg) : undefined)

  return { kind: classifyKind(msg, errName, httpStatus), msg, errName, httpStatus }
}

function classifyKind(msg: string, errName: string, httpStatus: number | undefined): ModelErrorKind {
  // 2. Context overflow → local (no-LLM) compact then retry.
  if (msg.includes('too many input tokens') || msg.includes('prompt_too_long') || msg.includes('ContextWindowOverflow')) {
    return 'context_overflow'
  }

  // 3a. Account-level errors (bad key, no balance, suspended) → unrecoverable,
  // don't retry. HTTP status is authoritative when present: 401/402/403 is
  // account-level, anything else with a status is NOT, whatever the body
  // says (a 503 whose body reads "authentication service temporarily
  // unavailable" must fall through to the transient retry below). The
  // keyword list only applies when no status could be recovered.
  const isAccountError = httpStatus !== undefined
    ? httpStatus === 401 || httpStatus === 402 || httpStatus === 403
    : msg.includes('insufficient balance') || msg.includes('suspended') || msg.includes('invalid api key') || msg.includes('Invalid API Key') || msg.includes('Unauthorized') || msg.includes('authentication')
  if (isAccountError) {
    return 'account'
  }

  // 3b. Throttling → exponential backoff and retry
  if (msg.includes('throttl') || msg.includes('rate limit') || msg.includes('ThrottlingException') || msg.includes('ServiceUnavailableException') || msg.includes('API error 429')) {
    return 'throttle'
  }

  // 3b-2. Transient server-side errors (500/502/503/504 server-side +
  // 408 model timeout). Identified by the AWS SDK error's structured
  // fields, NOT the message string — Bedrock's 500/503 messages are
  // generic ("is unable to process your request") and match no keyword,
  // which is exactly why they slipped past retry and killed the turn on
  // attempt 1. Same exponential backoff as throttling.
  if (
    errName === 'InternalServerException'
    || errName === 'ModelTimeoutException'
    || errName === 'ServiceUnavailableException'
    || httpStatus === 500
    || httpStatus === 502
    || httpStatus === 503
    || httpStatus === 504
    || httpStatus === 529  // Anthropic Overloaded — transient
    || httpStatus === 408
  ) {
    return 'server_error'
  }

  // 3c. Transient transport-layer errors (TCP reset, undici headers
  // timeout, DNS hiccups) → short backoff retry. HTTP 5xx gateway errors
  // are handled by the transient-server branch above (by status code);
  // this branch only catches connection-level errno markers that carry
  // no HTTP status. Without a retry, one bad packet kills the whole turn
  // and the user has to /new — not great UX. The substring check is
  // conservative: only obvious network-layer markers, never anything
  // that could be a model-side semantic error.
  if (
    msg === 'fetch failed'
    || msg === 'Model request timed out'  // agent-loop MODEL_TIMEOUT_ERROR — hung model call, treat as transport failure
    || msg.includes('http2 request did not get a response')  // AWS SDK NodeHttp2Handler requestTimeout — hung Bedrock stream, same class as MODEL_TIMEOUT
    || msg.includes('UND_ERR_HEADERS_TIMEOUT')
    || msg.includes('HeadersTimeoutError')
    || msg.includes('socket hang up')
    || msg.includes('ECONNRESET')
    || msg.includes('ECONNREFUSED')
    || msg.includes('ETIMEDOUT')
    || msg.includes('EAI_AGAIN')
  ) {
    return 'network'
  }

  // 3d. Bedrock-Mantle empty-response glitch → short backoff retry.
  if (msg.includes('MantleEmptyResponse')) {
    return 'empty_response'
  }

  // 4. Corrupted conversation → repair and retry
  if (msg.includes("reading 'role'") || msg.includes("reading 'content'") || msg.includes('failed to add message') || msg.includes('tool_use ids were found without tool_result') || msg.includes('unexpected `tool_use_id` found in `tool_result`')) {
    return 'corrupted'
  }

  // 4b. 4xx multimodal rejection → degrade and retry once. Keyword set is
  // deliberately narrow (known provider messages only) — a miss means no
  // degrade (current behavior), a false positive would strip images on an
  // unrelated 400.
  if (
    httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500
    && (msg.includes('Multimodal data is corrupted') || msg.includes('Could not process image'))
  ) {
    return 'multimodal_4xx'
  }

  // 5. Unrecoverable
  return 'fatal'
}
