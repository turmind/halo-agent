import { resolveModelEndpoints } from '@/features/agents/model-endpoints'

/** `bedrock-runtime.us-east-1.amazonaws.com`, `bedrock-mantle.us-west-2.api.aws`
 *  (also `.amazonaws.com.cn`, `us-gov-*`) → the region; anything else is not AWS. */
const AWS_REGION_HOST = /^[^.]+\.([a-z]{2}(?:-gov)?-[a-z]+-\d+)\.(?:amazonaws\.com(?:\.cn)?|api\.aws)$/

/** Chip label for one endpoint URL: the AWS region when the host carries one,
 *  else the host; an unparsable string as-is. */
export function endpointLabel(url: string): { label: string; region: boolean } {
  let host: string
  try { host = new URL(url).hostname } catch { return { label: url, region: false } }
  const m = AWS_REGION_HOST.exec(host)
  return m ? { label: m[1]!, region: true } : { label: host, region: false }
}

export interface ModelEndpointChip { label: string; region: boolean; isDefault: boolean; urls: string[] }

/** Where one model can be called (model-endpoints.ts rules: its own
 *  `endpoints:` list, else the provider's presets, else the provider default),
 *  one chip per label in list order — two URLs with one label share a chip. */
export function modelEndpointChips(
  provider: { defaultEndpoint?: unknown; endpointPresets?: unknown },
  model: { endpoints?: unknown },
): ModelEndpointChip[] {
  const { presets, defaultEndpoint } = resolveModelEndpoints(provider, model)
  const urls = defaultEndpoint && !presets.includes(defaultEndpoint) ? [defaultEndpoint, ...presets] : presets
  const chips: ModelEndpointChip[] = []
  for (const url of urls) {
    const { label, region } = endpointLabel(url)
    const chip = chips.find((c) => c.label === label)
    if (chip) {
      chip.urls.push(url)
      chip.isDefault ||= url === defaultEndpoint
    } else {
      chips.push({ label, region, isDefault: url === defaultEndpoint, urls: [url] })
    }
  }
  return chips
}

/** 272000 → 272K, 1000000 → 1M, 1050000 → 1.05M; a power-of-two multiple
 *  reads binary (262144 → 256K, 1048576 → 1M) unless it is also a round
 *  thousand (128000 → 128K). */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  const binary = n % 1000 !== 0 && n % 1024 === 0
  const k = binary ? 1024 : 1000
  const [value, unit] = n >= k * k ? [n / (k * k), 'M'] : [n / k, 'K']
  return `${+value.toFixed(2)}${unit}`
}
