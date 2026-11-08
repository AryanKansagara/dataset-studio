/** Per-project working session: keeps the worker loaded with the open project's rows,
 * re-runs the analysis whenever the pipeline or settings change, and owns undo/redo. */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { engine, type ProgressEvt, type Source } from '../lib/engine.ts'
import { getFile, keepFile, projectById, saveProject, toast, settings$, type Project, type Version } from '../lib/store.ts'
import { pushVersion } from '../lib/sync.ts'
import type { Mapping } from '../engine/mapping.ts'
import { describeOp, type Op, type Report } from '../engine/pipeline.ts'
import { statsOf } from '../engine/compare.ts'
import { limitFor } from '../engine/exporters.ts'

export type GOp = Op & { g?: number }

export interface TkInfo { repo: string; hasTemplate: boolean; approximate: boolean }

export interface SessionState {
  phase: 'idle' | 'needs-source' | 'needs-file' | 'loading' | 'ready' | 'error'
  progress: ProgressEvt | null
  error: string | null
  report: Report | null
  analyzing: boolean
  tk: TkInfo | null
  tkState: 'idle' | 'loading' | 'ready' | 'error'
  tkError: string | null
}

let loadedProject: string | null = null
let loadedKey = ''
let inflight: { key: string; p: Promise<void> } | null = null
/** Files picked in this tab, so the first load does not depend on IndexedDB having stored them. */
const pendingFiles = new Map<string, File>()

export function sourceFor(p: Project, file?: Blob | null): Source | null {
  if (!p.source) return null
  if (p.source.kind === 'sample') return { kind: 'sample' }
  if (p.source.kind === 'hf') return { kind: 'hf', dataset: p.source.dataset!, config: p.source.config, split: p.source.split, maxRows: p.source.maxRows }
  return file ? { kind: 'file', file: file instanceof File ? file : new File([file], p.source.name) } : null
}

const mappingKey = (p: Project) => JSON.stringify([p.source?.name, p.source?.dataset, p.source?.split, p.source?.maxRows, p.mapping])

export function useProjectSession(projectId: string) {
  const [s, setS] = useState<SessionState>({ phase: 'idle', progress: null, error: null, report: null, analyzing: false, tk: null, tkState: 'idle', tkError: null })
  const patch = useCallback((p: Partial<SessionState>) => setS((x) => ({ ...x, ...p })), [])
  const project = () => projectById(projectId)
  const runId = useRef(0)
  const pendingToast = useRef<string | null>(null)

  useEffect(() => engine.onProgress((p) => setS((x) => ({ ...x, progress: p }))), [])

  /** Ingest the project's source into the worker (once per project/mapping). */
  const load = useCallback(async (fileOverride?: File): Promise<void> => {
    const p = project()
    if (!p) return
    if (!p.source || !p.mapping) { patch({ phase: 'needs-source' }); return }
    const key = p.id + mappingKey(p)
    if (loadedProject === p.id && loadedKey === mappingKey(p) && !fileOverride) { patch({ phase: 'ready' }); return }
    if (inflight?.key === key && !fileOverride) { patch({ phase: 'loading' }); return inflight.p.then(() => patch({ phase: loadedKey === mappingKey(p) ? 'ready' : 'error' })) }
    const file = p.source.kind === 'file' ? fileOverride ?? pendingFiles.get(p.id) ?? (await getFile(p.id)) ?? null : null
    if (fileOverride) pendingFiles.set(p.id, fileOverride)
    const src = sourceFor(p, file)
    if (!src) { patch({ phase: 'needs-file' }); return }
    patch({ phase: 'loading', error: null })
    const run = (async () => {
      try {
        const res = await engine.ingest(src, p.mapping!)
        loadedProject = p.id
        loadedKey = mappingKey(p)
        if (res.format !== p.format || p.source!.rows !== res.rows) {
          const method = res.format === 'preference' ? 'dpo' as const : 'sft' as const
          await saveProject({ ...p, format: res.format, source: { ...p.source!, rows: res.rows }, job: { ...p.job, method } }, { touch: false })
        }
        patch({ phase: 'ready' })
      } catch (e) {
        patch({ phase: 'error', error: (e as Error).message })
      }
    })()
    inflight = { key, p: run }
    await run
    if (inflight?.p === run) inflight = null
  }, [projectId]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Load the tokenizer for the project's model. */
  const model = project()?.job.model
  useEffect(() => {
    if (!model || s.phase !== 'ready') return
    let alive = true
    patch({ tkState: 'loading', tkError: null })
    engine.tokenizer(model).then((tk) => { if (alive) patch({ tk, tkState: 'ready' }) }).catch((e) => { if (alive) patch({ tkState: 'error', tkError: (e as Error).message }) })
    return () => { alive = false }
  }, [model, s.phase]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Re-run the analysis. */
  const analyze = useCallback(async () => {
    const p = project()
    if (!p || loadedProject !== p.id) return
    const id = ++runId.current
    patch({ analyzing: true })
    try {
      const report = await engine.analyze({ ops: p.ops, split: p.split, limit: limitFor(p.job), exactTokens: settings$.get().exactTokens, nearThreshold: p.nearThreshold })
      if (id !== runId.current) return
      patch({ report, analyzing: false })
      if (pendingToast.current) {
        const last = report.log[report.log.length - 1]
        const what = last ? [last.dropped ? `${last.dropped.toLocaleString()} dropped` : '', last.modified ? `${last.modified.toLocaleString()} modified` : ''].filter(Boolean).join(', ') || 'no rows changed' : ''
        toast(`${pendingToast.current}: ${what}`, 'success', { label: 'Undo', run: () => void undo() })
        pendingToast.current = null
      }
      // first analysis after import becomes v1
      const cur = project()!
      if (!cur.versions.length && !cur.ops.length) await commit('Imported', report)
    } catch (e) {
      if (id === runId.current) { patch({ analyzing: false }); toast((e as Error).message, 'error') }
    }
  }, [projectId]) // eslint-disable-line react-hooks/exhaustive-deps

  const p = project()
  const analysisKey = p ? JSON.stringify([p.ops, p.split, p.job.model, p.job.maxSeq, p.job.method, p.nearThreshold, s.tkState === 'ready' ? s.tk?.repo : 'none']) : ''
  useEffect(() => {
    if (s.phase !== 'ready') return
    const t = setTimeout(() => void analyze(), 120)
    return () => clearTimeout(t)
  }, [analysisKey, s.phase, s.tkState]) // eslint-disable-line react-hooks/exhaustive-deps

  const update = useCallback(async (f: (p: Project) => Project) => {
    const cur = project()
    if (cur) await saveProject(f(cur))
  }, [projectId]) // eslint-disable-line react-hooks/exhaustive-deps

  const applyOps = useCallback(async (ops: Op[], label?: string) => {
    const g = Date.now()
    pendingToast.current = label ?? describeOp(ops[0])
    await update((p) => ({ ...p, ops: [...p.ops, ...ops.map((o) => ({ ...o, g }))], redo: [] }))
  }, [update])

  const undo = useCallback(async () => {
    const p = project()
    if (!p || !p.ops.length) return
    const last = p.ops[p.ops.length - 1] as GOp
    const n = p.ops.filter((o) => (o as GOp).g !== undefined && (o as GOp).g === last.g).length || 1
    const removed = p.ops.slice(-n)
    await saveProject({ ...p, ops: p.ops.slice(0, -n), redo: [...p.redo, ...removed] })
    toast(`Undid: ${describeOp(removed[0])}`, 'info', { label: 'Redo', run: () => void redo() })
  }, [projectId]) // eslint-disable-line react-hooks/exhaustive-deps

  const redo = useCallback(async () => {
    const p = project()
    if (!p || !p.redo.length) return
    const last = p.redo[p.redo.length - 1] as GOp
    const n = p.redo.filter((o) => (o as GOp).g !== undefined && (o as GOp).g === last.g).length || 1
    const back = p.redo.slice(-n)
    await saveProject({ ...p, ops: [...p.ops, ...back], redo: p.redo.slice(0, -n) })
  }, [projectId]) // eslint-disable-line react-hooks/exhaustive-deps

  const commit = useCallback(async (label: string, report?: Report) => {
    const p = project()
    const r = report ?? s.report
    if (!p || !r) return null
    const v: Version = { id: crypto.randomUUID(), n: (p.versions[p.versions.length - 1]?.n ?? 0) + 1, label, createdAt: new Date().toISOString(), ops: p.ops, job: p.job, split: p.split, stats: statsOf(r) }
    await saveProject({ ...p, versions: [...p.versions, v] })
    void pushVersion(p.id, v)
    return v
  }, [projectId, s.report]) // eslint-disable-line react-hooks/exhaustive-deps

  return { s, load, analyze, update, applyOps, undo, redo, commit, patch }
}

export type Session = ReturnType<typeof useProjectSession>
export const SessionCtx = createContext<Session | null>(null)
export const useSession = () => useContext(SessionCtx)!

export function forgetLoaded() { loadedProject = null; loadedKey = '' }

/** Start a project from a mapping (used by the import step). */
export async function setSource(p: Project, source: Project['source'], mapping: Mapping, file?: File) {
  forgetLoaded()
  if (file) pendingFiles.set(p.id, file)
  const name = p.name === 'Untitled dataset' && source ? source.name.replace(/^hf:\/\//, '').replace(/\.(jsonl|ndjson|json|csv|tsv|parquet)$/i, '') : p.name
  const next = await saveProject({ ...p, name, source, mapping, format: mapping.format, ops: [], redo: [], versions: p.versions })
  if (file) {
    const kept = await keepFile(p.id, file)
    if (!kept) toast(`${file.name} is larger than 300 MB, so it isn't kept in the browser. You'll be asked to re-attach it next time.`, 'info')
  }
  return next
}
