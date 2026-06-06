'use client'

import type { PreviewProps } from '../types'
import { PreviewShell } from '../ui/preview-shell'

export function PdfPreview(props: PreviewProps) {
  const { name, viewUrl, downloadUrl, onOpenAsText } = props
  return (
    <PreviewShell name={name} downloadUrl={downloadUrl} onOpenAsText={onOpenAsText}>
      <iframe src={viewUrl} title={name} className="h-full w-full border-0" style={{ background: '#525659' }} />
    </PreviewShell>
  )
}
