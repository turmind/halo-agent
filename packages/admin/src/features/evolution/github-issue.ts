/**
 * "Open a GitHub issue" links for an evo run's Larger observation
 * (plans/evo-l2-l3.md §7). Pure: the detail pane supplies the repo (the
 * workspace's github.com origin, or Halo's own) and the run facts. GitHub's
 * /issues/new form is prefilled through the query string, so nothing leaves
 * the browser until the user submits the form on github.com.
 */

export interface GithubRepo { owner: string; repo: string }

export const HALO_REPO: GithubRepo = { owner: 'turmind', repo: 'halo-agent' }

/** Budget for the whole URL — GitHub rejects much longer prefilled links. */
export const ISSUE_URL_MAX = 8000
const TITLE_MAX = 80
/** Files listed in the body; the rest are counted. */
const FILES_MAX = 20

/** User-perceived characters: an emoji ZWJ sequence or a base + combining
 *  mark is one — cutting inside one would leave half a glyph. */
const graphemes = (s: string): string[] =>
  Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s), (x) => x.segment)

// https://[user[:token]@]github.com/o/r[.git] · git@github.com:o/r[.git] · ssh://git@github.com[:port]/o/r[.git]
const REMOTE_RE = /^(?:(?:https?|ssh|git):\/\/(?:[^@/\s]+@)?github\.com(?::\d+)?\/|[^@/\s]+@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i

/** owner/repo of a github.com remote URL; null for any other host. */
export function parseGithubRepo(url: string): GithubRepo | null {
  const m = REMOTE_RE.exec(url.trim())
  return m ? { owner: m[1], repo: m[2] } : null
}

export interface IssueInput {
  observation: string
  runId: string
  files: string[]
  score: { avg: number; confidence: string } | null
  haloVersion: string | null
  /** Appended to the observation when it is cut to fit ISSUE_URL_MAX. */
  truncatedNote: string
}

/** `[evo] ` + the observation's first non-empty line (markdown list /
 *  heading / quote marker dropped), cut to TITLE_MAX graphemes. */
export function issueTitle(observation: string): string {
  const first = observation.split(/\r?\n/)
    .map((l) => l.trim().replace(/^(?:#+|>|[-*+]|\d+[.)])\s+/, '').trim())
    .find(Boolean) ?? ''
  const chars = graphemes(first)
  return `[evo] ${chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX).join('')}…` : first}`
}

function issueBody(observation: string, input: IssueInput): string {
  const listed = input.files.slice(0, FILES_MAX).map((f) => `\`${f}\``).join(', ')
  const more = input.files.length - FILES_MAX
  const files = !input.files.length ? '—' : more > 0 ? `${listed} …and ${more} more` : listed
  const score = input.score ? `avg ${input.score.avg} · confidence ${input.score.confidence}` : '—'
  return [
    observation,
    '',
    '---',
    `- Run: \`${input.runId}\``,
    `- Files: ${files}`,
    `- Score: ${score}`,
    `- Halo: ${input.haloVersion ?? 'unknown'}`,
    '',
  ].join('\n')
}

/** Prefilled /issues/new URL, at most ISSUE_URL_MAX long (measured after
 *  encoding — a CJK character costs 9). Over budget, the observation is cut
 *  to the longest prefix that fits with `truncatedNote`. */
export function buildIssueUrl(repo: GithubRepo, input: IssueInput): string {
  const base = `https://github.com/${repo.owner}/${repo.repo}/issues/new?title=${encodeURIComponent(issueTitle(input.observation))}&body=`
  const full = base + encodeURIComponent(issueBody(input.observation, input))
  if (full.length <= ISSUE_URL_MAX) return full
  // Cut on whole graphemes (a lone surrogate would also make
  // encodeURIComponent throw).
  const chars = graphemes(input.observation)
  const cut = (n: number) => base + encodeURIComponent(issueBody(chars.slice(0, n).join('').trimEnd() + input.truncatedNote, input))
  let lo = 0
  let hi = chars.length - 1
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (cut(mid).length <= ISSUE_URL_MAX) lo = mid
    else hi = mid - 1
  }
  return cut(lo)
}
