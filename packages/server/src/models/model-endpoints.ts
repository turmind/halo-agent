/**
 * Which endpoints one model is served on. A model entry's optional
 * `endpoints:` list, when non-empty, is authoritative for that model; without
 * it the provider's `endpointPresets` apply. The default is the provider's
 * `defaultEndpoint` unless the model's own list leaves it out — then the
 * list's first entry.
 *
 * Kept identical to packages/admin/src/features/agents/model-endpoints.ts (the
 * agent form's copy — admin can't import server code); test/model-endpoints.test.ts
 * runs the same cases against both.
 */
const urls = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((u): u is string => typeof u === 'string' && u.length > 0) : []

export function resolveModelEndpoints(
  provider: { defaultEndpoint?: unknown; endpointPresets?: unknown } | undefined,
  model: { endpoints?: unknown } | undefined,
): { presets: string[]; defaultEndpoint: string; modelScoped: boolean } {
  const providerDefault = typeof provider?.defaultEndpoint === 'string' ? provider.defaultEndpoint : ''
  const own = urls(model?.endpoints)
  if (own.length === 0) return { presets: urls(provider?.endpointPresets), defaultEndpoint: providerDefault, modelScoped: false }
  return { presets: own, defaultEndpoint: own.includes(providerDefault) ? providerDefault : own[0]!, modelScoped: true }
}
