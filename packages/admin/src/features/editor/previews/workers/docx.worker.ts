/// <reference lib="webworker" />

import mammoth from 'mammoth'

type Req = { id: number; buf: ArrayBuffer }
type Res = { id: number; ok: true; data: string } | { id: number; ok: false; error: string }

const ctx = self as unknown as DedicatedWorkerGlobalScope

ctx.addEventListener('message', async (e: MessageEvent<Req>) => {
  const { id, buf } = e.data
  try {
    const result = await mammoth.convertToHtml({ arrayBuffer: buf })
    const res: Res = { id, ok: true, data: result.value }
    ctx.postMessage(res)
  } catch (err) {
    const res: Res = { id, ok: false, error: err instanceof Error ? err.message : String(err) }
    ctx.postMessage(res)
  }
})
