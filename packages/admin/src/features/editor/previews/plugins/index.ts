/**
 * All built-in preview plugins are registered here.
 *
 * To add a new file type:
 *   1. Create a new plugin file in this directory (e.g. `foo.tsx`)
 *   2. Export a `PreviewPlugin` object from it
 *   3. Import + register it below
 */

import { register } from '../registry'
import { pdfPlugin } from './pdf'
import { docxPlugin } from './docx'
import { xlsxPlugin } from './xlsx'
import { pptxPlugin } from './pptx'
import { mediaPlugin } from './media'

register(pdfPlugin)
register(docxPlugin)
register(xlsxPlugin)
register(pptxPlugin)
register(mediaPlugin)
