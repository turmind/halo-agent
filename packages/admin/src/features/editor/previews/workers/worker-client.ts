/**
 * Generic client for single-purpose parse workers.
 *
 * Each preview type gets its own worker file (xlsx.worker.ts, docx.worker.ts, …).
 * This client handles the messaging plumbing so each worker only needs to handle
 * a single message shape.
 *
 * Worker protocol:
 *   main → worker: { id, buf, meta? }  (buf is transferred)
 *   worker → main: { id, ok: true, data } | { id, ok: false, error }
 *
 * If the caller aborts, the reply is dropped; the worker is not signalled
 * (parsers are typically synchronous and can't be interrupted mid-flight,
 * and dropping the reply is functionally equivalent since no UI updates).
 */

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void }

export class WorkerClient {
  private worker: Worker | null = null
  private nextId = 1
  private pending = new Map<number, Pending>()

  constructor(private readonly factory: () => Worker) {}

  private getWorker(): Worker {
    if (this.worker) return this.worker
    this.worker = this.factory()
    this.worker.addEventListener('message', (e: MessageEvent) => {
      const msg = e.data as { id: number; ok: boolean; data?: unknown; error?: string }
      const p = this.pending.get(msg.id)
      if (!p) return // caller aborted
      this.pending.delete(msg.id)
      if (msg.ok) p.resolve(msg.data)
      else p.reject(new Error(msg.error ?? 'Worker error'))
    })
    return this.worker
  }

  call<T, M = unknown>(signal: AbortSignal, buf: ArrayBuffer, meta?: M): Promise<T> {
    const id = this.nextId++
    const w = this.getWorker()
    return new Promise<T>((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'))
        return
      }
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      const onAbort = () => {
        this.pending.delete(id)
        reject(new DOMException('Aborted', 'AbortError'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      w.postMessage({ id, buf, meta }, [buf])
    })
  }
}
