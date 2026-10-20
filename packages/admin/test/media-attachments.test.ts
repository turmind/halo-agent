import { describe, it, expect } from 'vitest'
import { buildMediaUrl } from '../src/shared/components/media-attachments'

/**
 * Contract: a media chip is clickable for any absolute path once a workspace
 * is active — the server (/api/files/download) is the only judge of what's
 * readable. No client-side workspace-prefix or `tmp/` guess (the old regex
 * admitted another workspace's `.halo/tmp/` while the server 403'd it).
 */

const ws = '/home/u/secretary'
const params = (url: string | null) => new URLSearchParams(url!.split('?')[1])

describe('buildMediaUrl', () => {
  it('absolute paths anywhere → inline download URL carrying path + projectId', () => {
    for (const p of [
      '/home/u/sa-agent/.halo/tmp/jw/send/报告.docx', // another workspace's .halo/tmp
      '/home/u/sa-agent/docs/plan.pdf', // another workspace, no tmp segment
      '/tmp/shot.png',
      `${ws}/out/a.png`,
      'C:\\Users\\u\\proj\\a.png',
      'D:/data/b.mp4',
      '\\\\server\\share\\c.wav',
    ]) {
      const url = buildMediaUrl(p, ws)
      expect(url, p).toMatch(/^\/api\/files\/download\?/)
      expect(params(url).get('path')).toBe(p)
      expect(params(url).get('projectId')).toBe(ws)
      expect(params(url).get('inline')).toBe('1')
    }
  })

  it('relative path or no active workspace → null (static chip)', () => {
    expect(buildMediaUrl('out/a.png', ws)).toBeNull()
    expect(buildMediaUrl('tmp/a.png', ws)).toBeNull()
    expect(buildMediaUrl('/tmp/a.png', null)).toBeNull()
  })
})
