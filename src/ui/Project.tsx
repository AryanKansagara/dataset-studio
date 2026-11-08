import { createContext, useContext, useEffect, useState } from 'react'
import { A, Icon, Modal, Progress, fmtInt } from './common.tsx'
import { Page } from './Shell.tsx'
import { saveProject, toast, useObs, projects$, type Project } from '../lib/store.ts'
import { navigate } from '../router.ts'
import { MODELS, getModel } from '../engine/rules.ts'
import { limitFor } from '../engine/exporters.ts'
import { useProjectSession, SessionCtx, useSession } from './session.ts'
import { ImportStep } from './steps/Import.tsx'
import { ValidateStep } from './steps/Validate.tsx'
import { TokensStep } from './steps/Tokens.tsx'
import { QualityStep } from './steps/Quality.tsx'
import { SplitStep } from './steps/Split.tsx'
import { ExportStep } from './steps/Export.tsx'
import { VersionsStep } from './steps/Versions.tsx'
import { RowDrawer } from './steps/RowDrawer.tsx'

const STEPS = [
  { id: 'import', label: 'Import & map' },
  { id: 'validate', label: 'Validate' },
  { id: 'tokens', label: 'Tokens' },
  { id: 'quality', label: 'Quality' },
  { id: 'split', label: 'Split & cost' },
  { id: 'export', label: 'Export' },
  { id: 'versions', label: 'Versions' },
] as const

const RowCtx = createContext<(id: number) => void>(() => {})
export const useOpenRow = () => useContext(RowCtx)

export function useProject(id: string): Project {
  return useObs(projects$)!.find((p) => p.id === id)!
}

export function ProjectView({ project, step }: { project: Project; step: string }) {
  const session = useProjectSession(project.id)
  const [row, setRow] = useState<number | null>(null)
  const [help, setHelp] = useState(false)
  const { s } = session

  useEffect(() => { void session.load() }, [project.mapping, project.source?.name]) // eslint-disable-line react-hooks/exhaustive-deps

  // keyboard: 1-7 steps, Cmd/Ctrl+Z undo, Shift+Cmd/Ctrl+Z redo, ? help
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.closest('input,textarea,select,[contenteditable]')) return
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); void (e.shiftKey ? session.redo() : session.undo()); return }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const n = Number(e.key)
      if (n >= 1 && n <= STEPS.length) navigate(`/app/p/${project.id}/${STEPS[n - 1].id}`)
      if (e.key === '?') setHelp(true)
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [project.id, session])

  const r = s.report
  const badge = (id: string) => {
    if (!r) return null
    if (id === 'validate') return r.issues.rowsWithErrors ? <span className="badge err">{fmtInt(r.issues.rowsWithErrors)}</span> : r.issues.rowsWithWarnings ? <span className="badge warn">{fmtInt(r.issues.rowsWithWarnings)}</span> : <span className="badge ok"><Icon name="check" size={11} /></span>
    if (id === 'tokens' && r.tokens) return r.tokens.over ? <span className="badge warn">{fmtInt(r.tokens.over)}</span> : <span className="badge ok"><Icon name="check" size={11} /></span>
    if (id === 'quality') { const q = r.quality; const n = q.exactDup.rows + q.nearDup.rows + q.pii.rows + q.refusals.rows + q.leakage.rows; return n ? <span className="badge warn">{fmtInt(n)}</span> : <span className="badge ok"><Icon name="check" size={11} /></span> }
    if (id === 'versions') return <span className="badge">{project.versions.length}</span>
    return null
  }

  const ready = s.phase === 'ready'
  const needsData = step !== 'import' && (s.phase === 'needs-source' || s.phase === 'needs-file')
  const body = step === 'import' || needsData ? <ImportStep project={project} reattach={s.phase === 'needs-file'} />
    : s.phase === 'error' ? <div className="empty"><h2>Could not load the data</h2><p>{s.error}</p><div className="row" style={{ justifyContent: 'center', marginTop: 18 }}><A className="btn" href={`/app/p/${project.id}/import`}>Back to import</A></div></div>
    : !ready || !r ? <div className="grid" style={{ gap: 14 }}><Progress label={s.progress?.phase ?? (s.phase === 'loading' ? 'Loading rows' : 'Running checks')} value={s.progress?.done} total={s.progress?.total} /><div className="stats">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: 96 }} />)}</div><div className="skeleton" style={{ height: 280 }} /></div>
    : step === 'validate' ? <ValidateStep project={project} />
    : step === 'tokens' ? <TokensStep project={project} />
    : step === 'quality' ? <QualityStep project={project} />
    : step === 'split' ? <SplitStep project={project} />
    : step === 'export' ? <ExportStep project={project} />
    : step === 'versions' ? <VersionsStep project={project} />
    : <div className="empty"><h2>Unknown step</h2></div>

  return (
    <SessionCtx.Provider value={session}>
      <RowCtx.Provider value={setRow}>
        <Page>
          <div className="page-title" style={{ marginBottom: 18 }}>
            <div style={{ minWidth: 0 }}>
              <A href="/app" className="tag plain" style={{ textDecoration: 'none' }}>← Projects</A>
              <ProjectName project={project} />
            </div>
            <span className="spacer" />
            <div className="row no-print">
              <button className="btn small secondary" disabled={!project.ops.length} onClick={() => void session.undo()} title="Undo last fix (Ctrl/⌘ Z)"><Icon name="undo" size={13} /> Undo</button>
              <button className="btn small secondary" disabled={!project.redo.length} onClick={() => void session.redo()} title="Redo (Shift Ctrl/⌘ Z)"><Icon name="redo" size={13} /> Redo</button>
              <CommitButton project={project} />
            </div>
          </div>
          <div className="studio">
            <nav className="side" aria-label="Steps">
              {STEPS.map((st, i) => (
                <A key={st.id} href={`/app/p/${project.id}/${st.id}`} aria-current={step === st.id ? 'page' : undefined}>
                  <span className="n">0{i + 1}</span>{st.label}{badge(st.id)}
                </A>
              ))}
              <div className="side-foot">
                {project.source ? <><div className="label" style={{ marginBottom: 6 }}>Source</div><div style={{ wordBreak: 'break-all' }}>{project.source.name}</div>{project.source.rows !== undefined && <div className="faint num">{fmtInt(project.source.rows)} rows</div>}</> : 'No data yet'}
                <div style={{ marginTop: 10 }}><button className="btn ghost small" style={{ padding: 0, height: 'auto' }} onClick={() => setHelp(true)}><kbd>?</kbd> shortcuts</button></div>
              </div>
            </nav>
            <div style={{ minWidth: 0 }}>
              {ready && step !== 'import' && step !== 'versions' && <Toolbar project={project} />}
              {s.analyzing && r && <div className="progress indet no-print" style={{ marginBottom: 12 }}><div /></div>}
              {body}
            </div>
          </div>
        </Page>
        {row !== null && <RowDrawer project={project} rowId={row} onClose={() => setRow(null)} />}
        {help && (
          <Modal title="Keyboard shortcuts" onClose={() => setHelp(false)}>
            <table className="t"><tbody>
              <tr><td><kbd>1</kbd> … <kbd>7</kbd></td><td>Jump to a step</td></tr>
              <tr><td><kbd>⌘/Ctrl</kbd> <kbd>Z</kbd></td><td>Undo the last fix</td></tr>
              <tr><td><kbd>⇧</kbd> <kbd>⌘/Ctrl</kbd> <kbd>Z</kbd></td><td>Redo</td></tr>
              <tr><td><kbd>Esc</kbd></td><td>Close a panel</td></tr>
              <tr><td><kbd>?</kbd></td><td>This help</td></tr>
            </tbody></table>
          </Modal>
        )}
      </RowCtx.Provider>
    </SessionCtx.Provider>
  )
}

function ProjectName({ project }: { project: Project }) {
  const [edit, setEdit] = useState(false)
  const [v, setV] = useState(project.name)
  if (edit) return (
    <form onSubmit={(e) => { e.preventDefault(); void saveProject({ ...project, name: v.trim() || project.name }); setEdit(false) }} style={{ marginTop: 8 }}>
      <input className="input" autoFocus value={v} onChange={(e) => setV(e.target.value)} onBlur={() => { void saveProject({ ...project, name: v.trim() || project.name }); setEdit(false) }} aria-label="Project name" style={{ fontSize: 22, height: 44, maxWidth: 480 }} />
    </form>
  )
  return <h1 style={{ marginTop: 10, cursor: 'text', overflow: 'hidden', textOverflow: 'ellipsis' }} title="Click to rename" onClick={() => setEdit(true)}>{project.name}</h1>
}

function CommitButton({ project }: { project: Project }) {
  const session = useSession()
  const [open, setOpen] = useState(false)
  const [label, setLabel] = useState('')
  const last = project.versions[project.versions.length - 1]
  const dirty = !last || JSON.stringify(last.ops) !== JSON.stringify(project.ops) || JSON.stringify(last.split) !== JSON.stringify(project.split) || last.job.model !== project.job.model
  return (
    <>
      <button className="btn small" disabled={!session.s.report || !dirty} onClick={() => { setLabel(''); setOpen(true) }} title={dirty ? 'Save this pipeline run as a version' : 'No changes since the last version'}>
        <Icon name="git" size={13} /> Save version
      </button>
      {open && (
        <Modal title={`Save v${(last?.n ?? 0) + 1}`} onClose={() => setOpen(false)}>
          <p className="muted small">A version stores the fix pipeline, split and model settings plus summary stats. Compare versions any time in the Versions tab.</p>
          <form onSubmit={async (e) => { e.preventDefault(); const v = await session.commit(label.trim() || `${project.ops.length} fixes`); setOpen(false); if (v) toast(`Saved v${v.n}.`, 'success') }} className="grid" style={{ gap: 12, marginTop: 14 }}>
            <label className="field"><span>Label</span><input className="input" autoFocus placeholder="e.g. deduped + redacted" value={label} onChange={(e) => setLabel(e.target.value)} /></label>
            <div className="row" style={{ justifyContent: 'flex-end' }}><button type="button" className="btn secondary" onClick={() => setOpen(false)}>Cancel</button><button className="btn" type="submit">Save version</button></div>
          </form>
        </Modal>
      )}
    </>
  )
}

function Toolbar({ project }: { project: Project }) {
  const { s, update } = useSession()
  const model = getModel(project.job.model)
  const ctx = project.job.method === 'dpo' ? model.ctxDpo : model.ctxSft
  const orgs = [...new Set(MODELS.map((m) => m.org))]
  return (
    <div className="toolbar no-print">
      <label className="field sel-model">
        <span>Target model</span>
        <select className="input" value={project.job.model} onChange={(e) => void update((p) => ({ ...p, job: { ...p.job, model: e.target.value, lora: getModel(e.target.value).full ? p.job.lora : true } }))}>
          {orgs.map((o) => <optgroup key={o} label={o}>{MODELS.filter((m) => m.org === o).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</optgroup>)}
        </select>
      </label>
      <label className="field" style={{ width: 170 }}>
        <span>max_seq_length</span>
        <input className="input num" type="number" min={128} max={ctx} step={128} placeholder={`${ctx} (model max)`} value={project.job.maxSeq ?? ''}
          onChange={(e) => { const v = e.target.value ? Math.min(ctx, Math.max(128, Number(e.target.value))) : null; void update((p) => ({ ...p, job: { ...p.job, maxSeq: v } })) }} />
      </label>
      <div className="field">
        <span>Tokenizer</span>
        <div className="row" style={{ height: 38 }}>
          {s.tkState === 'loading' && <span className="badge accent"><span className="spinner" style={{ width: 11, height: 11 }} /> {s.progress?.phase?.startsWith('Downloading') ? `${s.progress.phase.replace('Downloading ', '')} ${s.progress.total ? Math.round((100 * s.progress.done) / s.progress.total) + '%' : ''}` : 'loading'}</span>}
          {s.tkState === 'ready' && s.tk && (s.tk.approximate ? <span className="badge warn" title="No JavaScript-loadable tokenizer for this model; counts are estimated at ~3.6 chars/token">estimate</span> : <span className="badge ok" title={`${s.tk.repo}${s.tk.hasTemplate ? ' with chat template' : ' (no chat template)'}`}><Icon name="check" size={11} /> {s.tk.repo.split('/')[1]}</span>)}
          {s.tkState === 'error' && <span className="badge err" title={s.tkError ?? ''}>failed: {s.tkError?.slice(0, 40)}</span>}
        </div>
      </div>
      <span className="spacer" />
      <div className="tiny faint" style={{ textAlign: 'right' }}>limit <b className="num" style={{ color: 'var(--ink)' }}>{fmtInt(limitFor(project.job))}</b> tokens<br />{project.job.method === 'dpo' ? 'per side (DPO)' : 'per example'}</div>
    </div>
  )
}
