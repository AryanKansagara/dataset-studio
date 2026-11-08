/** App state: projects (IndexedDB, local-first), user settings (localStorage), toasts. */
import { useSyncExternalStore } from 'react'
import { idb } from './db.ts'
import type { Mapping, Format } from '../engine/mapping.ts'
import type { Op, SplitSettings } from '../engine/pipeline.ts'
import type { VersionStats } from '../engine/compare.ts'
import { DEFAULT_JOB, type JobSettings } from '../engine/exporters.ts'

export interface SourceInfo {
  kind: 'file' | 'sample' | 'hf'
  name: string
  size: number
  dataset?: string
  config?: string
  split?: string
  maxRows?: number
  rows?: number
}

export interface Version {
  id: string
  n: number
  label: string
  createdAt: string
  ops: Op[]
  job: JobSettings
  split: SplitSettings
  stats: VersionStats
}

export interface Project {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  source: SourceInfo | null
  mapping: Mapping | null
  format: Format | null
  job: JobSettings
  split: SplitSettings
  nearThreshold: number
  ops: Op[]
  /** ops undone with Undo, re-applied by Redo */
  redo: Op[]
  versions: Version[]
}

export interface Settings {
  defaultModel: string
  valFraction: number
  seed: number
  epochs: number
  exactTokens: boolean
  reduceMotion: boolean
}

const SETTINGS_KEY = 'ds.settings'
const DEFAULT_SETTINGS: Settings = { defaultModel: DEFAULT_JOB.model, valFraction: 0.1, seed: 42, epochs: 3, exactTokens: false, reduceMotion: false }

// ---------- tiny observable ----------

function observable<T>(initial: T) {
  let value = initial
  const subs = new Set<() => void>()
  return {
    get: () => value,
    set: (v: T) => { value = v; subs.forEach((s) => s()) },
    subscribe: (s: () => void) => { subs.add(s); return () => { subs.delete(s) } },
  }
}

export const projects$ = observable<Project[] | null>(null)
export const settings$ = observable<Settings>({ ...DEFAULT_SETTINGS, ...safeJson(localStorage.getItem(SETTINGS_KEY)) })

export interface Toast { id: number; text: string; kind: 'info' | 'error' | 'success'; action?: { label: string; run: () => void } }
export const toasts$ = observable<Toast[]>([])

function safeJson(s: string | null) { try { return s ? JSON.parse(s) : {} } catch { return {} } }

export function useObs<T>(o: { get: () => T; subscribe: (s: () => void) => () => void }): T {
  return useSyncExternalStore(o.subscribe, o.get, o.get)
}

let toastSeq = 0
export function toast(text: string, kind: Toast['kind'] = 'info', action?: Toast['action'], ms = 5000) {
  const t = { id: ++toastSeq, text, kind, action }
  toasts$.set([...toasts$.get(), t].slice(-4))
  setTimeout(() => dismissToast(t.id), action ? ms + 3000 : ms)
}
export function dismissToast(id: number) { toasts$.set(toasts$.get().filter((t) => t.id !== id)) }

export function saveSettings(patch: Partial<Settings>) {
  const s = { ...settings$.get(), ...patch }
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s))
  settings$.set(s)
}

// ---------- projects ----------

/** Set by the sync module when signed in; called after every local write. */
export const hooks: { onSave?: (p: Project) => void; onDelete?: (id: string) => void } = {}

export async function loadProjects() {
  try {
    const all = await idb.all<Project>('projects')
    projects$.set(all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)))
  } catch {
    projects$.set([])
    toast('Local storage is unavailable (private browsing?). Projects will not persist.', 'error')
  }
}

export function newProject(name: string): Project {
  const s = settings$.get()
  const now = new Date().toISOString()
  return {
    id: crypto.randomUUID(), name, createdAt: now, updatedAt: now, source: null, mapping: null, format: null,
    job: { ...DEFAULT_JOB, model: s.defaultModel, epochs: s.epochs, seed: s.seed },
    split: { valFraction: s.valFraction, seed: s.seed, stratify: true }, nearThreshold: 0.8, ops: [], redo: [], versions: [],
  }
}

export async function saveProject(p: Project, opts: { touch?: boolean; silent?: boolean } = {}) {
  const next = opts.touch === false ? p : { ...p, updatedAt: new Date().toISOString() }
  const list = projects$.get() ?? []
  projects$.set([next, ...list.filter((x) => x.id !== p.id)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)))
  await idb.put('projects', next).catch(() => {})
  if (!opts.silent) hooks.onSave?.(next)
  return next
}

export async function deleteProject(id: string) {
  const p = projects$.get()?.find((x) => x.id === id)
  const file = await idb.get<Blob>('files', id).catch(() => undefined)
  projects$.set((projects$.get() ?? []).filter((x) => x.id !== id))
  await idb.del('projects', id).catch(() => {})
  await idb.del('files', id).catch(() => {})
  hooks.onDelete?.(id)
  return { project: p, file }
}

export async function restoreProject(p: Project, file?: Blob) {
  await saveProject(p, { touch: false })
  if (file) await idb.put('files', file, p.id).catch(() => {})
}

/** Keep the source file on this device (never synced) so the project reopens without re-importing. */
export const MAX_KEPT_FILE = 300 * 1024 * 1024
export async function keepFile(id: string, file: Blob) {
  if (file.size > MAX_KEPT_FILE) return false
  try { await idb.put('files', file, id); return true } catch { return false }
}
export const getFile = (id: string) => idb.get<File | Blob>('files', id).catch(() => undefined)

export function projectById(id: string) { return projects$.get()?.find((p) => p.id === id) }

export async function exportAllData(): Promise<Blob> {
  const ps = projects$.get() ?? []
  return new Blob([JSON.stringify({ app: 'dataset-studio', exportedAt: new Date().toISOString(), note: 'Projects, pipelines and version stats. Raw rows are not included.', projects: ps, settings: settings$.get() }, null, 2)], { type: 'application/json' })
}

export async function wipeLocal() {
  await idb.clear('projects').catch(() => {})
  await idb.clear('files').catch(() => {})
  projects$.set([])
}
