import { describe, it, expect } from 'vitest'
import { classifyModelError, type ModelErrorKind } from '../src/agents/model-error.js'

/** AWS-SDK-shaped error: name + structured `$metadata.httpStatusCode`. */
function sdkError(name: string, message: string, httpStatusCode?: number): Error {
  const err = new Error(message)
  err.name = name
  if (httpStatusCode !== undefined) {
    Object.assign(err, { $metadata: { httpStatusCode } })
  }
  return err
}

describe('classifyModelError', () => {
  describe('one representative input per kind', () => {
    it.each<[string, unknown, ModelErrorKind]>([
      ['context overflow (Bedrock)', new Error('Input is too long: too many input tokens'), 'context_overflow'],
      ['account (401 from meta)', sdkError('UnrecognizedClientException', 'The security token is invalid', 401), 'account'],
      ['throttle (Bedrock, keyword)', sdkError('ThrottlingException', 'Rate exceeded, request throttled'), 'throttle'],
      // The real Bedrock SDK message carries no throttle keyword — must be
      // caught by errName / status 429, not the string checks.
      ['throttle (Bedrock, real SDK message)', sdkError('ThrottlingException', 'Too many requests, please wait before trying again.', 429), 'throttle'],
      ['throttle (429 status, keyword-free body)', sdkError('X', 'slow down', 429), 'throttle'],
      ['server error (Bedrock 500)', sdkError('InternalServerException', 'Bedrock is unable to process your request', 500), 'server_error'],
      ['network (undici)', new Error('fetch failed'), 'network'],
      ['empty response (Mantle)', new Error('MantleEmptyResponse: status=completed with empty output[]'), 'empty_response'],
      ['corrupted (missing tool_result)', new Error('messages.3: tool_use ids were found without tool_result blocks'), 'corrupted'],
      ['multimodal 4xx', new Error('[Kimi] 400 Could not process image'), 'multimodal_4xx'],
      ['fatal (unknown)', new Error('something unexpected'), 'fatal'],
    ])('%s → %s', (_label, err, expected) => {
      expect(classifyModelError(err).kind).toBe(expected)
    })
  })

  describe('httpStatus extraction', () => {
    it('$metadata.httpStatusCode wins over a status embedded in the message', () => {
      expect(classifyModelError(sdkError('X', 'API error 429', 503)).httpStatus).toBe(503)
    })

    it.each<[string, number | undefined]>([
      ['OpenAI API error 429: rate limited', 429],
      ['[Kimi] 503 upstream unavailable', 503],
      ['Mantle request failed status=500', 500],
      ['no status anywhere in here', undefined],
    ])('%s → %s', (message, expected) => {
      expect(classifyModelError(new Error(message)).httpStatus).toBe(expected)
    })
  })

  describe('account asymmetry — status is authoritative when present', () => {
    it('503 whose body says "authentication" is server_error, not account', () => {
      const err = sdkError('ServiceUnavailable', 'authentication service unavailable', 503)
      expect(classifyModelError(err).kind).toBe('server_error')
    })

    it('plain Unauthorized with no status → account (keyword path)', () => {
      expect(classifyModelError(new Error('Unauthorized')).kind).toBe('account')
    })

    it('401 with an unrelated body → account (status path)', () => {
      expect(classifyModelError(sdkError('X', 'nothing to see here', 401)).kind).toBe('account')
    })
  })

  describe('ordering — first match wins', () => {
    it('ServiceUnavailableException matches 3b (msg) and 3b-2 (errName) → throttle', () => {
      const err = sdkError('ServiceUnavailableException', 'ServiceUnavailableException: try again')
      expect(classifyModelError(err).kind).toBe('throttle')
    })

    it('too many input tokens + 429 status → context_overflow (2 before 3b)', () => {
      const err = sdkError('X', 'too many input tokens', 429)
      expect(classifyModelError(err).kind).toBe('context_overflow')
    })
  })

  describe('non-Error inputs', () => {
    it.each<[string, unknown, string]>([
      ['string', 'boom', 'boom'],
      ['object without message', { code: 42 }, '[object Object]'],
    ])('%s → msg is String(err), errName empty, kind fatal', (_label, err, expectedMsg) => {
      expect(classifyModelError(err)).toEqual({ kind: 'fatal', msg: expectedMsg, errName: '', httpStatus: undefined })
    })
  })

  describe('exact-equality network predicates stay exact', () => {
    it.each<[string, ModelErrorKind]>([
      ['Model request timed out', 'network'],
      ['Model request timed out (extra)', 'fatal'],
    ])('%s → %s', (message, expected) => {
      expect(classifyModelError(new Error(message)).kind).toBe(expected)
    })
  })

  describe('multimodal — 4xx gate', () => {
    it.each<[string, number | undefined, ModelErrorKind]>([
      ['with 400', 400, 'multimodal_4xx'],
      ['with 500', 500, 'server_error'],
      ['with no status', undefined, 'fatal'],
    ])('"Could not process image" %s → %s', (_label, status, expected) => {
      expect(classifyModelError(sdkError('X', 'Could not process image', status)).kind).toBe(expected)
    })
  })
})
