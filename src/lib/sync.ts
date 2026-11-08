/** Optional accounts + cloud sync (Supabase). Lazy-loaded; the app is fully usable signed out.
 * Only project configuration, pipelines and version stats are synced. Raw rows and source files never leave the device. */
import type { SupabaseClient, Session } from '@supabase/supabase-js'
import { hooks, projects$, saveProject, toast, type Project, type Version } from './store.ts'

export const APP_ID = 'dataset-studio'
const URL_ = import.meta.env.VITE_SUPABASE_URL as string | undefined
const KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined
const MAX_BYTES = 3_500_000

export type SyncStatus = 'signed-out' | 'syncing' | 'synced' | 'offline' | 'error'
export interface AuthState { email: string | null; status: SyncStatus; error?: string; lastSync?: string }

const subs = new Set<() => void>()
let state: AuthState = { email: null, status: 'signed-out' }
export const auth$ = {
  get: () => state,
  subscribe: (s: () => void) => { subs.add(s); return () => { subs.delete(s) } },
}
function set(p: Partial<AuthState>) { state = { ...state, ...p }; subs.forEach((s) => s()) }

let clientP: Promise<SupabaseClient> | null = null
function client(): Promise<SupabaseClient> {
  if (!URL_ || !KEY) return Promise.reject(new Error('Sync is not configured for this build.'))
  return (clientP ??= import('@supabase/supabase-js').then(({ createClient }) => createClient(URL_, KEY, { auth: { persistSession: true, storageKey: 'ds.auth' } })))
}

/** Only touch Supabase at startup if a session was stored before (keeps first paint free of it). */
export async function initAuth() {
  if (!localStorage.getItem('ds.auth')) return
  try {
    const sb = await client()
    const { data } = await sb.auth.getSession()
    if (data.session) await onSignedIn(data.session)
  } catch (e) { set({ status: 'offline', error: (e as Error).message }) }
}

async function onSignedIn(session: Session) {
  set({ email: session.user.email ?? null, status: 'syncing', error: undefined })
  hooks.onSave = (p) => { void push(p) }
  hooks.onDelete = (id) => { void removeCloud(id) }
  await syncAll()
}

function payload(p: Project) {
  const data = { ...p }
  let json = JSON.stringify(data)
  // keep under the row size cap: trim dropped-line samples from older versions first
  if (json.length > MAX_BYTES) {
    data.versions = data.versions.map((v, i) => i < data.versions.length - 3 ? { ...v, stats: { ...v.stats, dropped: v.stats.dropped.map((d) => ({ ...d, lines: [] })) } } : v)
    json = JSON.stringify(data)
  }
  if (json.length > MAX_BYTES) throw new Error(`Project "${p.name}" is too large to sync (${(json.length / 1e6).toFixed(1)} MB).`)
  return { id: p.id, app: APP_ID, name: p.name, data, updated_at: p.updatedAt, created_at: p.createdAt }
}

const netError = (e: unknown) => /fetch|network|Failed to fetch|timeout/i.test(String((e as Error)?.message ?? e))

const pushTimers = new Map<string, ReturnType<typeof setTimeout>>()
let pushChain: Promise<void> = Promise.resolve()

/** Debounced, serialized upload of a project's latest local state (avoids out-of-order writes). */
function push(p: Project) {
  if (!state.email) return
  set({ status: 'syncing' })
  clearTimeout(pushTimers.get(p.id))
  pushTimers.set(p.id, setTimeout(() => {
    pushTimers.delete(p.id)
    pushChain = pushChain.then(async () => {
      const latest = projects$.get()?.find((x) => x.id === p.id)
      if (!latest || !state.email) return
      try {
        const sb = await client()
        const { error } = await sb.from('projects').upsert(payload(latest))
        if (error) throw error
        if (!pushTimers.size) set({ status: 'synced', lastSync: new Date().toISOString(), error: undefined })
      } catch (e) {
        set({ status: netError(e) ? 'offline' : 'error', error: (e as Error).message })
      }
    })
  }, 400))
}

export async function pushVersion(projectId: string, v: Version) {
  if (!state.email) return
  try {
    const sb = await client()
    await sb.from('project_versions').insert({ project_id: projectId, label: `${v.label}`, data: v })
  } catch { /* the version is also inside the project row; this table is a snapshot log */ }
}

async function removeCloud(id: string) {
  if (!state.email) return
  try {
    const sb = await client()
    await sb.from('project_versions').delete().eq('project_id', id)
    const { error } = await sb.from('projects').delete().eq('id', id)
    if (error) throw error
  } catch (e) { set({ status: 'error', error: (e as Error).message }) }
}

/** Merge local and cloud by project id, last write wins on updated_at. */
export async function syncAll() {
  if (!state.email) return
  set({ status: 'syncing' })
  try {
    const sb = await client()
    const { data, error } = await sb.from('projects').select('id,name,data,updated_at').eq('app', APP_ID)
    if (error) throw error
    const local = new Map((projects$.get() ?? []).map((p) => [p.id, p]))
    const cloud = new Map((data ?? []).map((r) => [r.id as string, r]))
    for (const [id, r] of cloud) {
      const l = local.get(id)
      const cloudP = r.data as Project
      // compare the client-side edit times stored in the payload (the column is set by the server)
      if (!l || new Date(cloudP.updatedAt).getTime() > new Date(l.updatedAt).getTime()) {
        await saveProject(cloudP, { touch: false, silent: true })
      }
    }
    const toPush = [...local.values()].filter((l) => { const r = cloud.get(l.id); return !r || new Date(l.updatedAt).getTime() > new Date((r.data as Project).updatedAt).getTime() })
    if (toPush.length) {
      const { error: e2 } = await sb.from('projects').upsert(toPush.map(payload))
      if (e2) throw e2
    }
    set({ status: 'synced', lastSync: new Date().toISOString(), error: undefined })
  } catch (e) {
    set({ status: netError(e) ? 'offline' : 'error', error: (e as Error).message })
  }
}

export async function signUp(email: string, password: string) {
  const sb = await client()
  const { data, error } = await sb.auth.signUp({ email, password })
  if (error) throw error
  if (!data.session) throw new Error('Account created but no session was returned. Try signing in.')
  await onSignedIn(data.session)
}

export async function signIn(email: string, password: string) {
  const sb = await client()
  const { data, error } = await sb.auth.signInWithPassword({ email, password })
  if (error) throw error
  await onSignedIn(data.session)
}

export async function signOut() {
  const sb = await client()
  await sb.auth.signOut()
  hooks.onSave = undefined
  hooks.onDelete = undefined
  set({ email: null, status: 'signed-out', error: undefined })
  toast('Signed out. Your projects stay on this device.')
}

export async function deleteCloudData() {
  const sb = await client()
  const { data: rows } = await sb.from('projects').select('id').eq('app', APP_ID)
  const ids = (rows ?? []).map((r) => r.id)
  if (ids.length) {
    await sb.from('project_versions').delete().in('project_id', ids)
    const { error } = await sb.from('projects').delete().in('id', ids)
    if (error) throw error
  }
  set({ status: 'synced' })
}

export async function deleteAccount() {
  const sb = await client()
  const { error } = await sb.rpc('delete_my_account')
  if (error) throw error
  await sb.auth.signOut().catch(() => {})
  hooks.onSave = undefined
  hooks.onDelete = undefined
  set({ email: null, status: 'signed-out', error: undefined })
}
