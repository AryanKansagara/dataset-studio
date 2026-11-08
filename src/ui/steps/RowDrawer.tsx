import { useEffect, useState } from 'react'
import { Drawer, Icon, fmtInt } from '../common.tsx'
import { engine, type RowDetail } from '../../lib/engine.ts'
import type { Project } from '../../lib/store.ts'
import { limitFor } from '../../engine/exporters.ts'
import { useSession } from '../session.ts'
import { TemplateView } from './Tokens.tsx'

export function RowDrawer({ project, rowId, onClose }: { project: Project; rowId: number; onClose: () => void }) {
  const { applyOps, s } = useSession()
  const [d, setD] = useState<RowDetail | null | undefined>(undefined)
  const limit = limitFor(project.job)
  useEffect(() => { setD(undefined); void engine.row(rowId, limit).then(setD).catch(() => setD(null)) }, [rowId, limit, s.report])
  return (
    <Drawer onClose={onClose} title={d ? <>Line {d.row.line} {d.split && <span className="badge" style={{ marginLeft: 6 }}>{d.split}</span>}{d.dropped && <span className="badge err" style={{ marginLeft: 6 }}>dropped</span>}</> : 'Row'}
      extra={d && !d.dropped ? <button className="btn small secondary" onClick={() => { void applyOps([{ type: 'dropRows', ids: [rowId], reason: `line ${d.row.line} removed by hand` }]); onClose() }}><Icon name="trash" size={13} /> Drop row</button> : null}>
      {d === undefined && <div className="skeleton" style={{ height: 300 }} />}
      {d === null && <p className="muted">This row is no longer available.</p>}
      {d && <>
        {d.dropped && <div className="badge err" style={{ height: 'auto', padding: '8px 10px', whiteSpace: 'normal', borderRadius: 6 }}>Dropped by: {d.dropped}</div>}
        <div>
          <div className="label" style={{ marginBottom: 8 }}>Findings</div>
          {d.issues.length === 0 ? <span className="badge ok"><Icon name="check" size={11} /> passes every schema rule</span> : (
            <div className="grid" style={{ gap: 6 }}>{d.issues.map((i, k) => <div key={k} className="row small"><span className={`badge ${i.sev === 'error' ? 'err' : 'warn'}`}>{i.code}</span>{i.msg}</div>)}</div>
          )}
        </div>
        {d.tokens && <div className="row wrap-row small"><span className="label">Tokens</span>{d.tokens.map((n, i) => <span key={i} className={`badge ${n > limit ? 'warn' : ''}`}>{d.tokens!.length > 1 ? (i ? 'rejected ' : 'chosen ') : ''}{fmtInt(n)} / {fmtInt(limit)}</span>)}</div>}
        <div>
          <div className="label" style={{ marginBottom: 8 }}>{d.original ? 'After fixes' : 'Record'}</div>
          <pre className="code">{d.row.rec ? JSON.stringify(d.row.rec, null, 2).slice(0, 20000) : d.row.raw ?? '(unparseable line)'}</pre>
        </div>
        {d.original?.rec && <div><div className="label" style={{ marginBottom: 8 }}>As imported</div><pre className="code" style={{ opacity: 0.75 }}>{JSON.stringify(d.original.rec, null, 2).slice(0, 20000)}</pre></div>}
        {d.rendered && <div><div className="label" style={{ marginBottom: 8 }}>Rendered with the chat template</div><TemplateView text={d.rendered[0].slice(0, 6000)} /></div>}
      </>}
    </Drawer>
  )
}
