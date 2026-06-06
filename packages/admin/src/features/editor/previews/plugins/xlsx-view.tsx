'use client'

import { useState } from 'react'
import type { PreviewProps } from '../types'
import { PreviewShell } from '../ui/preview-shell'
import { usePreviewFetch } from '../ui/use-preview-fetch'
import { WorkerClient } from '../workers/worker-client'
import type { XlsxSheet } from '../workers/xlsx.worker'

let client: WorkerClient | null = null
function getClient(): WorkerClient {
  if (!client) {
    client = new WorkerClient(
      () => new Worker(new URL('../workers/xlsx.worker.ts', import.meta.url), { type: 'module' }),
    )
  }
  return client
}

export function XlsxPreview(props: PreviewProps) {
  const { name, viewUrl, downloadUrl, onOpenAsText } = props
  const ext = name.split('.').pop()?.toLowerCase() ?? ''

  const { data: sheets, error, loading } = usePreviewFetch<XlsxSheet[]>(
    viewUrl,
    (buf, signal) => getClient().call<XlsxSheet[], { ext: string }>(signal, buf, { ext }),
    [ext],
  )

  const [activeSheet, setActiveSheet] = useState(0)
  const sheet = sheets?.[activeSheet]

  const extraToolbar = sheets && sheets.length > 1 ? (
    <div className="flex gap-1">
      {sheets.map((s, i) => (
        <button
          key={s.name}
          onClick={() => setActiveSheet(i)}
          className={`rounded px-2 py-0.5 text-[10px] ${
            i === activeSheet
              ? 'bg-[var(--secondary)] text-[var(--foreground)]'
              : 'text-[var(--muted-foreground)] hover:bg-[var(--secondary)]'
          }`}
        >
          {s.name}
        </button>
      ))}
    </div>
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
      {sheet && (
        <div className="h-full overflow-auto">
          <table className="min-w-full border-collapse text-xs">
            <thead className="sticky top-0 z-10 bg-[var(--card)] shadow-[inset_0_-1px_0_var(--border)]">
              <tr>
                <th className="px-2 py-1.5 text-right text-[10px] font-medium text-[var(--muted-foreground)]">#</th>
                {Array.from({ length: sheet.colCount }).map((_, i) => (
                  <th key={i} className="whitespace-nowrap px-3 py-1.5 text-left text-[10px] font-medium text-[var(--foreground)]">
                    {sheet.headers[i] || String.fromCharCode(65 + i)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sheet.rows.slice(0, 500).map((row, ri) => (
                <tr key={ri} className="odd:bg-[var(--card)]/40 hover:bg-[var(--secondary)]">
                  <td className="px-2 py-1 text-right text-[10px] text-[var(--muted-foreground)] tabular-nums">{ri + 1}</td>
                  {Array.from({ length: sheet.colCount }).map((_, ci) => (
                    <td key={ci} className="whitespace-nowrap px-3 py-1 text-[var(--foreground)]">{row[ci] ?? ''}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PreviewShell>
  )
}

