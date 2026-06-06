'use client'

import { Printer } from 'lucide-react'
import type { PreviewProps } from '../types'
import { PreviewShell, ToolbarButton } from '../ui/preview-shell'
import { usePreviewFetch } from '../ui/use-preview-fetch'
import { printHtml } from '../ui/print'
import { WorkerClient } from '../workers/worker-client'

let client: WorkerClient | null = null
function getClient(): WorkerClient {
  if (!client) {
    client = new WorkerClient(
      () => new Worker(new URL('../workers/docx.worker.ts', import.meta.url), { type: 'module' }),
    )
  }
  return client
}

export function DocxPreview(props: PreviewProps) {
  const { name, viewUrl, downloadUrl, onOpenAsText } = props
  const { data: html, error, loading } = usePreviewFetch(viewUrl, (buf, signal) =>
    getClient().call<string>(signal, buf),
  )
  const extraToolbar = html ? (
    <ToolbarButton onClick={() => printHtml(name, html)} title="Print">
      <Printer className="h-3 w-3" />
      <span>Print</span>
    </ToolbarButton>
  ) : null
  return (
    <PreviewShell
      name={name}
      downloadUrl={downloadUrl}
      onOpenAsText={onOpenAsText}
      extraToolbar={extraToolbar}
      loading={loading}
      error={error}
    >
      {html && (
        <div className="h-full overflow-y-auto bg-white p-8">
          <div className="prose prose-sm max-w-none text-black" dangerouslySetInnerHTML={{ __html: html }} />
        </div>
      )}
    </PreviewShell>
  )
}
