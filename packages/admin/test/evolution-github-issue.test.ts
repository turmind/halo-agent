import { describe, expect, it } from 'vitest'
import { buildIssueUrl, HALO_REPO, ISSUE_URL_MAX, issueTitle, parseGithubRepo, type IssueInput } from '../src/features/evolution/github-issue'

const NOTE = '\n\n… (truncated — full text in the Evolution tab, run r1)'

function input(observation: string, extra: Partial<IssueInput> = {}): IssueInput {
  return {
    observation,
    runId: 'r1',
    files: ['agents/default/INSTRUCTIONS.md'],
    score: { avg: 88, confidence: 'high' },
    haloVersion: '1.9.0',
    truncatedNote: NOTE,
    ...extra,
  }
}

function params(url: string): { title: string; body: string } {
  const u = new URL(url)
  return { title: u.searchParams.get('title') ?? '', body: u.searchParams.get('body') ?? '' }
}

describe('parseGithubRepo', () => {
  it.each([
    ['https://github.com/turmind/halo-agent.git', 'turmind', 'halo-agent'],
    ['https://github.com/turmind/halo-agent', 'turmind', 'halo-agent'],
    ['https://github.com/turmind/halo-agent/', 'turmind', 'halo-agent'],
    ['https://user:tok@github.com/o/r.git', 'o', 'r'],
    ['git@github.com:turmind/halo.hub.git', 'turmind', 'halo.hub'],
    ['ssh://git@github.com/o/r.git', 'o', 'r'],
    ['ssh://git@github.com:22/o/r', 'o', 'r'],
    ['  https://GitHub.com/O/R.git\n', 'O', 'R'],
  ])('%s', (url, owner, repo) => {
    expect(parseGithubRepo(url)).toEqual({ owner, repo })
  })

  it.each([
    'https://gitlab.com/o/r.git',
    'git@gitlab.com:o/r.git',
    'https://github.com.evil.example/o/r',
    'https://notgithub.com/o/r',
    'https://github.com/o',
    'https://github.com/o/r/tree/main',
    '/srv/git/r.git',
    '',
  ])('non-github / malformed → null: %s', (url) => {
    expect(parseGithubRepo(url)).toBeNull()
  })
})

describe('issueTitle', () => {
  it('uses the first non-empty line without its markdown marker', () => {
    expect(issueTitle('\n\n- Skills should declare a timeout\nmore')).toBe('[evo] Skills should declare a timeout')
    expect(issueTitle('### Heading here')).toBe('[evo] Heading here')
  })

  it('cuts at 80 characters, counting CJK as one each', () => {
    const t = issueTitle('改'.repeat(100))
    expect(t).toBe(`[evo] ${'改'.repeat(80)}…`)
    expect(issueTitle('x'.repeat(80))).toBe(`[evo] ${'x'.repeat(80)}`)
  })
})

describe('buildIssueUrl', () => {
  it('prefills title + body with run facts', () => {
    const url = buildIssueUrl(HALO_REPO, input('Agents keep re-reading INDEX.md.'))
    expect(url.startsWith('https://github.com/turmind/halo-agent/issues/new?title=')).toBe(true)
    const { title, body } = params(url)
    expect(title).toBe('[evo] Agents keep re-reading INDEX.md.')
    expect(body).toContain('Agents keep re-reading INDEX.md.')
    expect(body).toContain('Run: `r1`')
    expect(body).toContain('`agents/default/INSTRUCTIONS.md`')
    expect(body).toContain('avg 88 · confidence high')
    expect(body).toContain('Halo: 1.9.0')
    expect(body).not.toContain('truncated')
  })

  it('missing score / version / files render as placeholders', () => {
    const { body } = params(buildIssueUrl(HALO_REPO, input('obs', { files: [], score: null, haloVersion: null })))
    expect(body).toContain('Files: —')
    expect(body).toContain('Score: —')
    expect(body).toContain('Halo: unknown')
  })

  it('a long ASCII observation is cut to fit, with the note and the footer kept', () => {
    const obs = 'a'.repeat(20000)
    const url = buildIssueUrl(HALO_REPO, input(obs))
    expect(url.length).toBeLessThanOrEqual(ISSUE_URL_MAX)
    expect(url.length).toBeGreaterThan(ISSUE_URL_MAX - 20)
    const { body } = params(url)
    expect(body).toContain(NOTE)
    expect(body).toContain('Run: `r1`')
  })

  it('budgets CJK by encoded length (9 bytes per char), not by character count', () => {
    const obs = '中'.repeat(2000) // 2000 chars, ~18000 encoded
    const url = buildIssueUrl(HALO_REPO, input(obs))
    expect(url.length).toBeLessThanOrEqual(ISSUE_URL_MAX)
    const { body } = params(url)
    const kept = body.split(NOTE)[0]
    expect(kept.length).toBeLessThan(900)
    expect(kept.length).toBeGreaterThan(700)
    expect(/^中+$/.test(kept)).toBe(true)
  })

  it('never splits a surrogate pair', () => {
    const obs = '😀'.repeat(3000)
    const url = buildIssueUrl(HALO_REPO, input(obs))
    expect(url.length).toBeLessThanOrEqual(ISSUE_URL_MAX)
    expect(() => decodeURIComponent(url)).not.toThrow()
  })
})
