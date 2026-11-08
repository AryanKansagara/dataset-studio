import { useEffect, useRef, useState } from 'react'
import { A, Icon, Modal, Sparkline, fmtInt, timeAgo, fmtTokens } from './common.tsx'
import { Page } from './Shell.tsx'
import { deleteProject, newProject, projects$, restoreProject, saveProject, toast, useObs, type Project } from '../lib/store.ts'
import { navigate } from '../router.ts'
import { FORMAT_LABEL } from '../engine/mapping.ts'
import { getModel } from '../engine/rules.ts'
import { ProjectView } from './Project.tsx'

export default function Studio({ path }: { path: string }) {
  const projects = useObs(projects$)
  const m = path.match(/^\/app\/p\/([^/]+)(?:\/([a-z]+))?/)
  const handledSample = useRef(false)

  useEffect(() => {
    if (!projects || handledSample.current) return
    const q = new URLSearchParams(location.search)
    if (q.get('sample')) {
      handledSample.current = true
      void (async () => {
        const p = await saveProject({ ...newProject('Support bot (messy sample)') })
        navigate(`/app/p/${p.id}/import?sample=1`, { replace: true })
      })()
    }
  }, [projects])

  if (!projects) return <Page><div className="skeleton" style={{ height: 200, marginTop: 40 }} /></Page>
  if (m) {
    const p = projects.find((x) => x.id === m[1])
    if (!p) return <Page><div className="empty" style={{ marginTop: 40 }}><h2>Project not found</h2><p>It may have been deleted on another device.</p><div className="row" style={{ justifyContent: 'center', marginTop: 20 }}><A href="/app" className="btn">All projects</A></div></div></Page>
    return <ProjectView key={p.id} project={p} step={m[2] ?? 'import'} />
  }
  return <ProjectList projects={projects} />
}

function ProjectList({ projects }: { projects: Project[] }) {
  const [naming, setNaming] = useState(false)
  const create = async (name: string) => {
    const p = await saveProject(newProject(name || 'Untitled dataset'))
    navigate(`/app/p/${p.id}/import`)
  }
  const remove = async (p: Project) => {
    const { project, file } = await deleteProject(p.id)
    toast(`Deleted “${p.name}”.`, 'info', project ? { label: 'Undo', run: () => void restoreProject(project, file) } : undefined)
  }
  return (
    <Page>
      <div className="page-title">
        <div>
          <span className="tag">Workspace</span>
          <h1 style={{ marginTop: 10 }}>Projects</h1>
        </div>
        <span className="spacer" />
        {projects.length > 0 && <button className="btn" onClick={() => setNaming(true)}><Icon name="plus" size={14} /> New project</button>}
      </div>
      {projects.length === 0 ? (
        <div className="empty fade-in">
          <span className="pill-label">First run</span>
          <h2>Turn a raw export into a file that trains.</h2>
          <p>Start with a deliberately messy support-chat dataset (duplicates, leaked secrets, broken turns, a 70k-token log paste), or bring your own JSONL, CSV, Parquet or Hugging Face dataset.</p>
          <div className="row wrap-row" style={{ justifyContent: 'center', marginTop: 24 }}>
            <A href="/app?sample=1" className="btn"><Icon name="sparkle" size={14} /> Try the sample</A>
            <button className="btn secondary" onClick={() => setNaming(true)}><Icon name="upload" size={14} /> Import your data</button>
          </div>
          <p className="tiny faint" style={{ marginTop: 18 }}>Everything runs in this browser. Nothing is uploaded unless you sign in, and even then only settings and stats sync.</p>
        </div>
      ) : (
        <div className="projects">
          {projects.map((p) => {
            const last = p.versions[p.versions.length - 1]
            const model = getModel(p.job.model)
            return (
              <div key={p.id} className="card pcard fade-in">
                <A href={`/app/p/${p.id}/${p.source ? 'validate' : 'import'}`} style={{ position: 'absolute', inset: 0, borderRadius: 12 }} aria-label={`Open ${p.name}`} />
                <div className="row">
                  <h3 style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</h3>
                  <button className="icon-btn" style={{ position: 'relative', zIndex: 1, width: 30, height: 30 }} aria-label={`Delete ${p.name}`} onClick={() => void remove(p)}><Icon name="trash" size={14} /></button>
                </div>
                <div className="small muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.source ? p.source.name : 'No data yet'}</div>
                <div className="meta">
                  {p.format && <span className="badge">{FORMAT_LABEL[p.format].split(' (')[0]}</span>}
                  <span className="badge">{model.name}</span>
                  <span className="badge accent">v{last?.n ?? 0}</span>
                </div>
                {last ? (
                  <>
                    <Sparkline values={last.stats.tokens?.hist ?? []} />
                    <div className="row tiny muted">
                      <span className="num">{fmtInt(last.stats.rows)} rows</span>
                      {last.stats.tokens && <span className="num">· {fmtTokens(last.stats.tokens.total)} tokens</span>}
                      <span className="spacer" />
                      <span>{timeAgo(p.updatedAt)}</span>
                    </div>
                  </>
                ) : <div className="tiny faint">Created {timeAgo(p.createdAt)}</div>}
              </div>
            )
          })}
        </div>
      )}
      {naming && <NameDialog onClose={() => setNaming(false)} onDone={(n) => void create(n)} />}
    </Page>
  )
}

function NameDialog({ onClose, onDone }: { onClose: () => void; onDone: (name: string) => void }) {
  const [name, setName] = useState('')
  return (
    <Modal title="New project" onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); onDone(name.trim()); onClose() }} className="grid" style={{ gap: 14, marginTop: 8 }}>
        <label className="field"><span>Name</span><input className="input" autoFocus placeholder="e.g. Support bot, Nov export" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
          <button className="btn" type="submit">Create</button>
        </div>
      </form>
    </Modal>
  )
}
