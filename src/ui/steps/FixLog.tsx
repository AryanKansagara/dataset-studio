import { Icon, fmtInt } from '../common.tsx'
import { useSession } from '../session.ts'

/** The undo log: every applied fix with what it dropped or changed. */
export function FixLog() {
  const { s, undo } = useSession()
  const log = s.report?.log ?? []
  return (
    <>
      <div className="panel-h"><h3>Fix log</h3><span className="badge">{log.length}</span><span className="spacer" />{log.length > 0 && <button className="btn small secondary" onClick={() => void undo()}><Icon name="undo" size={13} /> Undo last</button>}</div>
      {log.length === 0 ? <p className="small faint">No fixes applied yet. Every fix you apply shows up here, in order, and can be undone.</p> : (
        <div className="log">
          {log.map((l, i) => (
            <div className="e" key={i}>
              <span className="i">{String(i + 1).padStart(2, '0')}</span>
              <div>
                <div>{l.label}</div>
                {l.droppedLines.length > 0 && <div className="tiny faint mono" style={{ marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>lines {l.droppedLines.slice(0, 14).join(', ')}{l.dropped > 14 ? ' …' : ''}</div>}
              </div>
              <span className="tiny num" style={{ whiteSpace: 'nowrap' }}>
                {l.dropped > 0 && <span className="badge err">−{fmtInt(l.dropped)}</span>} {l.modified > 0 && <span className="badge accent">~{fmtInt(l.modified)}</span>}
                {!l.dropped && !l.modified && <span className="badge">no change</span>}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
