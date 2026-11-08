/** Promise wrapper around the engine worker. Calls are queued so progress events map to one request. */
import type { Source, HfInfo } from '../worker.ts'
import type { Peek } from '../engine/ingest.ts'
import type { Format, Mapping } from '../engine/mapping.ts'
import type { Issue } from '../engine/validate.ts'
import type { Op, Report, Row, SplitSettings } from '../engine/pipeline.ts'

export type { Source, HfInfo }

export interface ProgressEvt { phase: string; done: number; total: number }
type Listener = (p: ProgressEvt | null) => void

export interface RowDetail {
  row: Row
  original: Row | null
  issues: Issue[]
  rendered: string[] | null
  tokens: number[] | null
  dropped: string | null
  split: 'train' | 'validation' | null
}

class EngineClient {
  private worker: Worker | null = null
  private seq = 0
  private pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>()
  private queue: Promise<unknown> = Promise.resolve()
  private listeners = new Set<Listener>()

  private get w(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('../worker.ts', import.meta.url), { type: 'module' })
      this.worker.onmessage = (e) => {
        const m = e.data
        if (m.t === 'progress') { this.listeners.forEach((l) => l({ phase: m.phase, done: m.done, total: m.total })); return }
        const p = this.pending.get(m.id)
        if (!p) return
        this.pending.delete(m.id)
        if (m.t === 'result') p.res(m.data)
        else p.rej(new Error(m.message))
      }
      this.worker.onerror = (e) => { for (const p of this.pending.values()) p.rej(new Error(e.message || 'Engine crashed')); this.pending.clear() }
    }
    return this.worker
  }

  onProgress(l: Listener): () => void { this.listeners.add(l); return () => this.listeners.delete(l) }

  private call<T>(msg: Record<string, unknown>): Promise<T> {
    const run = () => new Promise<T>((res, rej) => {
      const id = ++this.seq
      this.pending.set(id, { res: res as (v: unknown) => void, rej })
      this.w.postMessage({ ...msg, id })
    }).finally(() => this.listeners.forEach((l) => l(null)))
    const p = this.queue.then(run, run)
    this.queue = p.catch(() => {})
    return p
  }

  peek(source: Source) { return this.call<Peek & { name: string; size: number }>({ t: 'peek', source }) }
  hfInfo(dataset: string) { return this.call<HfInfo>({ t: 'hfInfo', dataset }) }
  ingest(source: Source, mapping: Mapping) { return this.call<{ rows: number; format: Format; parseErrors: number; columns: string[] }>({ t: 'ingest', source, mapping }) }
  tokenizer(model: string) { return this.call<{ repo: string; hasTemplate: boolean; approximate: boolean }>({ t: 'tokenizer', model }) }
  analyze(p: { ops: Op[]; split: SplitSettings; limit: number; exactTokens: boolean; nearThreshold: number }) { return this.call<Report>({ t: 'analyze', ...p }) }
  row(rowId: number, limit: number) { return this.call<RowDetail | null>({ t: 'row', rowId, limit }) }
  export(p: { kind: 'jsonl' | 'parquet'; part: 'train' | 'val' | 'all'; trainOnInputs: boolean; limit: number }) { return this.call<Blob>({ t: 'export', ...p }) }
  clearCache() { return this.call<boolean>({ t: 'clearCache' }) }
}

export const engine = new EngineClient()
