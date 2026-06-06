/// <reference lib="webworker" />

import * as XLSX from 'xlsx'

export type XlsxSheet = { name: string; headers: string[]; rows: string[][]; colCount: number }

type Req = { id: number; buf: ArrayBuffer; meta: { ext: string } }
type Res = { id: number; ok: true; data: XlsxSheet[] } | { id: number; ok: false; error: string }

const ctx = self as unknown as DedicatedWorkerGlobalScope

ctx.addEventListener('message', (e: MessageEvent<Req>) => {
  const { id, buf, meta } = e.data
  try {
    let wb: XLSX.WorkBook
    if (meta.ext === 'csv') {
      let text = new TextDecoder('utf-8').decode(buf)
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1)
      wb = XLSX.read(text, { type: 'string' })
    } else {
      wb = XLSX.read(buf, { type: 'array' })
    }
    const sheets: XlsxSheet[] = wb.SheetNames.map((sheetName) => {
      const ws = wb.Sheets[sheetName]
      const json = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '' })
      const rowsAll = json.map((r) => (Array.isArray(r) ? r.map((c) => (c == null ? '' : String(c))) : []))
      const colCount = rowsAll.reduce((m, r) => Math.max(m, r.length), 0)
      const headers = (rowsAll[0] ?? []).slice()
      while (headers.length < colCount) headers.push('')
      return { name: sheetName, headers, rows: rowsAll.slice(1), colCount }
    })
    const res: Res = { id, ok: true, data: sheets }
    ctx.postMessage(res)
  } catch (err) {
    const res: Res = { id, ok: false, error: err instanceof Error ? err.message : String(err) }
    ctx.postMessage(res)
  }
})
