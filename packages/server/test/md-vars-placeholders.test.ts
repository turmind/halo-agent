import { describe, it, expect, afterEach } from 'vitest'
import { renderMdBody, parseUserMdFrontmatter } from '../src/prompts/md-vars.js'
import type { RenderContext } from '../src/prompts/md-vars.js'

/**
 * Contract: `{{...}}` resolution in AGENT.md/SKILL.md bodies is a SECURITY
 * boundary — rendered MD is model-visible, so only `<id>.params.<key>` paths
 * may resolve; `<id>.secrets.<key>` must stay literal (never leak server-side
 * secrets), and allowedNamespace confines an agent to its own params. The
 * `<<ENV>>` expansion complements setup's literal-placeholder write.
 */

const ctx = (over: Partial<RenderContext> = {}): RenderContext => ({
  builtin: { args: '', workspace_root: '/ws', ...over.builtin },
  settings: over.settings ?? {},
  allowedNamespace: over.allowedNamespace,
})

afterEach(() => {
  delete process.env.HALO_TEST_MD_VAR
})

describe('renderMdBody placeholder resolution', () => {
  it('resolves built-ins (no dots)', () => {
    const out = renderMdBody('root={{workspace_root}}', ctx())
    expect(out).toBe('root=/ws')
  })

  it('unknown placeholder stays literal', () => {
    expect(renderMdBody('x={{no_such_builtin}}', ctx())).toBe('x={{no_such_builtin}}')
  })

  it('resolves <id>.params.<key> from settings', () => {
    const out = renderMdBody('key={{tavily.params.api_key}}', ctx({
      settings: { tavily: { params: { api_key: 'tv-123' } } },
    }))
    expect(out).toBe('key=tv-123')
  })

  it('NEVER resolves <id>.secrets.<key> — stays literal (leak guard)', () => {
    const out = renderMdBody('sk={{provider.secrets.access_key}}', ctx({
      settings: { provider: { secrets: { access_key: 'SHOULD-NOT-LEAK' } } },
    }))
    expect(out).toBe('sk={{provider.secrets.access_key}}')
    expect(out).not.toContain('SHOULD-NOT-LEAK')
  })

  it('allowedNamespace rejects another skill\'s params', () => {
    const settings = {
      mine: { params: { key: 'ok' } },
      other: { params: { key: 'stolen' } },
    }
    const out = renderMdBody('a={{mine.params.key}} b={{other.params.key}}', ctx({
      settings,
      allowedNamespace: 'mine',
    }))
    expect(out).toBe('a=ok b={{other.params.key}}')
  })

  it('extracts .value from a self-describing leaf', () => {
    const out = renderMdBody('v={{skill.params.mode}}', ctx({
      settings: { skill: { params: { mode: { value: 'fast', description: 'speed' } } } },
    }))
    expect(out).toBe('v=fast')
  })

  it('expands <<ENV_NAME>> inside a resolved value; missing env stays literal', () => {
    process.env.HALO_TEST_MD_VAR = 'expanded'
    const settings = {
      s: { params: { a: '<<HALO_TEST_MD_VAR>>', b: '<<HALO_TEST_MD_VAR_MISSING>>' } },
    }
    const out = renderMdBody('a={{s.params.a}} b={{s.params.b}}', ctx({ settings }))
    expect(out).toBe('a=expanded b=<<HALO_TEST_MD_VAR_MISSING>>')
  })

  it('channel.* dotted built-ins resolve, empty when unset', () => {
    const out = renderMdBody('t={{channel.type}} c={{channel.chat_id}}', ctx({
      builtin: { args: '', 'channel.type': 'telegram' },
    }))
    expect(out).toBe('t=telegram c=')
  })

  it('null leaf stays literal', () => {
    const out = renderMdBody('v={{s.params.gone}}', ctx({
      settings: { s: { params: { gone: null } } },
    }))
    expect(out).toBe('v={{s.params.gone}}')
  })
})

describe('parseUserMdFrontmatter', () => {
  it('parses user_name / ai_name / lang (CRLF tolerant)', () => {
    const raw = '---\r\nuser_name: Ada\r\nai_name: Halo\r\nlang: zh-CN\r\n---\r\n\n## Communication Style\n'
    expect(parseUserMdFrontmatter(raw)).toEqual({ user_name: 'Ada', ai_name: 'Halo', lang: 'zh-CN' })
  })

  it('lang absent → undefined; no frontmatter → null', () => {
    expect(parseUserMdFrontmatter('---\nuser_name: Ada\n---\n')?.lang).toBeUndefined()
    expect(parseUserMdFrontmatter('## No frontmatter\n')).toBeNull()
  })
})
