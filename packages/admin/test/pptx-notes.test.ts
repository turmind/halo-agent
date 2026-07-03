import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { extractPptxNotes, repairPptxContentTypes } from '../src/features/editor/previews/plugins/pptx-notes'

/**
 * Contract: speaker notes come back in PRESENTATION (play) order — resolved
 * through sldIdLst + rels, never slideN.xml filename order — with domIndex
 * mapping play order onto pptx-preview's filename-sorted DOM. These tests
 * build real OPC zips (jszip) and parse with jsdom's namespace-aware
 * DOMParser, the same engine shape the browser uses.
 */

const P_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'

interface SlideSpec {
  /** Part file number — slide<fileNum>.xml. */
  fileNum: number
  /** Notes paragraphs; omit for a slide with no notesSlide part. */
  notes?: string[]
}

/** Build a minimal-but-real pptx package. `slides` is in PLAY order. */
async function buildPptx(slides: SlideSpec[], opts?: { extraOverride?: string }): Promise<ArrayBuffer> {
  const zip = new JSZip()

  const sldIds = slides
    .map((s, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`)
    .join('')
  zip.file('ppt/presentation.xml',
    `<?xml version="1.0"?>` +
    `<p:presentation xmlns:p="${P_NS}" xmlns:r="${R_NS}">` +
    `<p:sldIdLst>${sldIds}</p:sldIdLst></p:presentation>`)

  const rels = slides
    .map((s, i) => `<Relationship Id="rId${i + 1}" Type="${R_NS}/slide" Target="slides/slide${s.fileNum}.xml"/>`)
    .join('')
  zip.file('ppt/_rels/presentation.xml.rels',
    `<?xml version="1.0"?><Relationships xmlns="${REL_NS}">${rels}</Relationships>`)

  const overrides: string[] = []
  for (const s of slides) {
    const slidePath = `ppt/slides/slide${s.fileNum}.xml`
    zip.file(slidePath, `<?xml version="1.0"?><p:sld xmlns:p="${P_NS}"/>`)
    overrides.push(`<Override PartName="/${slidePath}" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`)

    if (s.notes) {
      zip.file(`ppt/slides/_rels/slide${s.fileNum}.xml.rels`,
        `<?xml version="1.0"?><Relationships xmlns="${REL_NS}">` +
        `<Relationship Id="rId2" Type="${R_NS}/notesSlide" Target="../notesSlides/notesSlide${s.fileNum}.xml"/>` +
        `</Relationships>`)
      const paras = s.notes
        .map((p) => `<a:p>${p.split('\n').map((line) => `<a:r><a:t>${line}</a:t></a:r>`).join('<a:br/>')}</a:p>`)
        .join('')
      zip.file(`ppt/notesSlides/notesSlide${s.fileNum}.xml`,
        `<?xml version="1.0"?>` +
        `<p:notes xmlns:p="${P_NS}" xmlns:a="${A_NS}">` +
        // sldImg placeholder first — must be skipped by the type check.
        `<p:sp><p:nvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr></p:sp>` +
        `<p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr>` +
        `<p:txBody>${paras}</p:txBody></p:sp>` +
        `</p:notes>`)
    }
  }

  zip.file('[Content_Types].xml',
    `<?xml version="1.0"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    overrides.join('') +
    (opts?.extraOverride ?? '') +
    `</Types>`)

  return zip.generateAsync({ type: 'arraybuffer' })
}

describe('extractPptxNotes', () => {
  it('extracts notes per slide, empty string for a slide without notes', async () => {
    const buf = await buildPptx([
      { fileNum: 1, notes: ['first slide notes'] },
      { fileNum: 2 },
      { fileNum: 3, notes: ['third slide notes'] },
    ])
    const { texts, domIndex } = await extractPptxNotes(buf)
    expect(texts).toEqual(['first slide notes', '', 'third slide notes'])
    expect(domIndex).toEqual([0, 1, 2]) // play order == filename order here
  })

  it('follows sldIdLst PLAY order when slides were reordered (not filename order)', async () => {
    // PowerPoint reorders sldIdLst but never renames parts: play order is
    // slide2.xml then slide1.xml.
    const buf = await buildPptx([
      { fileNum: 2, notes: ['now first'] },
      { fileNum: 1, notes: ['now second'] },
    ])
    const { texts, domIndex } = await extractPptxNotes(buf)
    expect(texts).toEqual(['now first', 'now second'])
    // pptx-preview renders filename-sorted: slide1 at DOM 0, slide2 at DOM 1.
    // Play position 0 (slide2.xml) lives at DOM index 1 and vice versa.
    expect(domIndex).toEqual([1, 0])
  })

  it('joins paragraphs with \\n and turns <a:br/> into a newline', async () => {
    const buf = await buildPptx([
      { fileNum: 1, notes: ['para one\nwith break', 'para two'] },
    ])
    const { texts } = await extractPptxNotes(buf)
    expect(texts[0]).toBe('para one\nwith break\npara two')
  })

  it('skips the sldImg placeholder and reads only the body placeholder', async () => {
    // The builder always puts a sldImg sp BEFORE the body sp — reaching the
    // right text at all proves the type check works.
    const buf = await buildPptx([{ fileNum: 1, notes: ['body text'] }])
    const { texts } = await extractPptxNotes(buf)
    expect(texts[0]).toBe('body text')
  })

  it('throws on a package missing presentation.xml (caller treats as "no notes")', async () => {
    const zip = new JSZip()
    zip.file('whatever.txt', 'not a pptx')
    const buf = await zip.generateAsync({ type: 'arraybuffer' })
    await expect(extractPptxNotes(buf)).rejects.toThrow()
  })
})

describe('repairPptxContentTypes', () => {
  it('returns null for a consistent package (no re-zip cost)', async () => {
    const buf = await buildPptx([{ fileNum: 1, notes: ['x'] }])
    expect(await repairPptxContentTypes(buf)).toBeNull()
  })

  it('drops a dangling Override and returns a rebuilt, loadable buffer', async () => {
    // The in-the-wild WPS shape: Content_Types declares parts that do not
    // exist; pptx-preview's loader then dies silently with 0 slides.
    const buf = await buildPptx(
      [{ fileNum: 1, notes: ['still here'] }],
      { extraOverride: '<Override PartName="/ppt/slideMasters/slideMaster99.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' },
    )
    const repaired = await repairPptxContentTypes(buf)
    expect(repaired).not.toBeNull()

    const zip = await JSZip.loadAsync(repaired!)
    const ct = await zip.file('[Content_Types].xml')!.async('text')
    expect(ct).not.toContain('slideMaster99')
    expect(ct).toContain('slide1.xml') // legitimate overrides survive

    // The repaired package still parses end-to-end.
    const { texts } = await extractPptxNotes(repaired!)
    expect(texts).toEqual(['still here'])
  })
})
