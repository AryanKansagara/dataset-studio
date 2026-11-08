import { useMemo, useState } from 'react'
import { Icon, download, fmtInt } from '../common.tsx'
import type { Project } from '../../lib/store.ts'
import { ISSUE_INFO, type IssueCode } from '../../engine/validate.ts'
import type { Op } from '../../engine/pipeline.ts'
import { FORMAT_LABEL } from '../../engine/mapping.ts'
import { useSession } from '../session.ts'
import { useOpenRow } from '../Project.tsx'
import { FixLog } from './FixLog.tsx'

const FIX_FOR: Partial<Record<IssueCode, { label: string; ops: Op[] }>> = {
  E_ROLE_ORDER: { label: 'Repair turns', ops: [{ type: 'repairStructure' }] },
  E_EMPTY_TURN: { label: 'Repair turns', ops: [{ type: 'repairStructure' }] },
  W_FINAL_NOT_ASSISTANT: { label: 'Trim trailing turns', ops: [{ type: 'repairStructure' }] },
  W_WHITESPACE: { label: 'Trim whitespace', ops: [{ type: 'repairStructure' }] },
  W_UNKNOWN_KEY: { label: 'Strip keys', ops: [{ type: 'stripUnknownKeys' }] },
}

export function ValidateStep({ project }: { project: Project }) {
  const { s, applyOps } = useSession()
  const openRow = useOpenRow()
  const r = s.report!
  const [code, setCode] = useState<IssueCode | ''>('')
  const [q, setQ] = useState('')
  const [shown, setShown] = useState(150)
  const codes = (Object.entries(r.issues.byCode) as [IssueCode, number][]).sort((a, b) => (a[0][0] === b[0][0] ? b[1] - a[1] : a[0][0] === 'E' ? -1 : 1))
  const list = useMemo(() => r.issues.list.filter((i) => (!code || i.code === code) && (!q || String(i.line).startsWith(q.replace(/\D/g, '')) || i.msg.toLowerCase().includes(q.toLowerCase()))), [r, code, q])
  const clean = r.rows - r.issues.rowsWithErrors - r.issues.rowsWithWarnings
  const fixAll: Op[] = [{ type: 'repairStructure' }, { type: 'stripUnknownKeys' }, { type: 'dropInvalid' }]
  const csv = () => {
    const rows = [['line', 'severity', 'code', 'message'], ...r.issues.list.map((i) => [i.line, i.sev, i.code, i.msg])]
    download(new Blob([rows.map((x) => x.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')], { type: 'text/csv' }), `${project.name.replace(/\W+/g, '-')}-validation.csv`)
  }
  const tokenOver = r.tokens?.over ?? 0

  return (
    <div className="fade-in">
      <div className="stats">
        <div className="stat"><div className="label">Examples</div><div className="v num">{fmtInt(r.rows)}{r.rows !== r.baseRows && <small>of {fmtInt(r.baseRows)}</small>}</div><div className="s">{FORMAT_LABEL[r.format]}</div></div>
        <div className={`stat ${r.issues.rowsWithErrors ? 'err' : 'ok'}`}><div className="label">Rows with errors</div><div className="v num">{fmtInt(r.issues.rowsWithErrors)}</div><div className="s">Will fail or train on nothing</div></div>
        <div className={`stat ${r.issues.rowsWithWarnings ? 'warn' : ''}`}><div className="label">Warnings only</div><div className="v num">{fmtInt(r.issues.rowsWithWarnings)}</div><div className="s">Trains, but probably not as intended</div></div>
        <div className="stat ok"><div className="label">Clean</div><div className="v num">{fmtInt(clean)}</div><div className="s">{r.rows ? Math.round((100 * clean) / r.rows) : 0}% of examples</div></div>
      </div>

      {(r.issues.rowsWithErrors > 0 || r.issues.rowsWithWarnings > 0) && (
        <div className="card pad row wrap-row" style={{ marginTop: 16, background: 'var(--accent-bg)', borderColor: 'transparent' }}>
          <Icon name="sparkle" />
          <div style={{ flex: 1, minWidth: 220 }}>
            <b>Fix everything that can be fixed mechanically</b>
            <div className="small muted">Trims whitespace, merges back-to-back turns from the same role, removes leading assistant and trailing user turns, strips undocumented keys, then drops what still fails. One undo step.</div>
          </div>
          <button className="btn" onClick={() => void applyOps(fixAll, 'Fixed validation issues')}>Fix all</button>
        </div>
      )}

      <div className="panel-h"><h2>Findings by rule</h2><span className="spacer" />{codes.length === 0 && <span className="badge ok"><Icon name="check" size={11} /> Matches Together's documented schema</span>}</div>
      {codes.length > 0 && (
        <div className="card" style={{ overflow: 'auto' }}>
          <table className="t">
            <thead><tr><th>Rule</th><th>What to do</th><th className="r">Rows</th><th /></tr></thead>
            <tbody>
              {codes.map(([c, n]) => {
                const fix = FIX_FOR[c] ?? (c === 'E_OVERSIZE' ? null : { label: 'Drop rows', ops: [{ type: 'dropInvalid' }] as Op[] })
                return (
                  <tr key={c} className="click" onClick={() => { setCode(c); setShown(150) }}>
                    <td><div className="row" style={{ gap: 8 }}><span className={`badge ${c[0] === 'E' ? 'err' : 'warn'}`}>{c[0] === 'E' ? 'error' : 'warn'}</span><b style={{ fontWeight: 500 }}>{ISSUE_INFO[c].title}</b></div><div className="mono tiny faint" style={{ marginTop: 4 }}>{c}</div></td>
                    <td className="small muted">{ISSUE_INFO[c].fix}</td>
                    <td className="r num">{fmtInt(n)}</td>
                    <td className="r" onClick={(e) => e.stopPropagation()}>
                      {fix ? <button className="btn small secondary" onClick={() => void applyOps(fix.ops)}>{fix.label}</button>
                        : <span className="tiny faint">see Tokens</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {r.issues.list.length > 0 && <>
        <div className="panel-h">
          <h2>Line-numbered report</h2>
          <span className="spacer" />
          <select className="input" style={{ width: 220, height: 34 }} value={code} onChange={(e) => { setCode(e.target.value as IssueCode | ''); setShown(150) }} aria-label="Filter by rule">
            <option value="">All rules</option>
            {codes.map(([c, n]) => <option key={c} value={c}>{ISSUE_INFO[c].title} ({n})</option>)}
          </select>
          <input className="input" style={{ width: 180, height: 34 }} placeholder="Line # or text" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search issues" />
          <button className="btn small secondary" onClick={csv}><Icon name="download" size={13} /> CSV</button>
        </div>
        <div className="card" style={{ overflow: 'auto' }}>
          <table className="t">
            <thead><tr><th style={{ width: 80 }}>Line</th><th style={{ width: 80 }}>Level</th><th>Problem</th></tr></thead>
            <tbody>
              {list.slice(0, shown).map((i, k) => (
                <tr key={k} className="click" onClick={() => openRow(i.id)} tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') openRow(i.id) }}>
                  <td className="mono num">{i.line}</td>
                  <td><span className={`badge ${i.sev === 'error' ? 'err' : 'warn'}`}>{i.sev}</span></td>
                  <td className="small">{i.msg}</td>
                </tr>
              ))}
              {list.length === 0 && <tr><td colSpan={3} className="muted small">No matching findings.</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <span className="tiny faint">{fmtInt(Math.min(shown, list.length))} of {fmtInt(list.length)} shown{r.issues.truncatedList ? ' · report capped at the first 5,000 findings' : ''}. Click a line to inspect it.</span>
          <span className="spacer" />
          {shown < list.length && <button className="btn small secondary" onClick={() => setShown((x) => x + 300)}>Show more</button>}
        </div>
      </>}

      {tokenOver > 0 && <p className="small muted" style={{ marginTop: 18 }}><Icon name="ruler" size={13} /> {fmtInt(tokenOver)} examples are longer than max_seq_length. See the Tokens step.</p>}
      <FixLog />
    </div>
  )
}
