import { useState } from 'react'
import { Histogram, Icon, fmtInt, fmtTokens, timeAgo } from '../common.tsx'
import { saveProject, toast, type Project } from '../../lib/store.ts'
import { compareVersions, histShift } from '../../engine/compare.ts'
import { describeOp } from '../../engine/pipeline.ts'
import { getModel } from '../../engine/rules.ts'

export function VersionsStep({ project }: { project: Project }) {
  const vs = project.versions
  const [a, setA] = useState(vs.length > 1 ? vs[vs.length - 2].id : vs[0]?.id)
  const [b, setB] = useState(vs[vs.length - 1]?.id)
  if (!vs.length) return <div className="empty fade-in"><h2>No versions yet</h2><p>The first analysis after import is saved as v1. Each time you save a fix pipeline run, or export, it becomes a new version you can compare here.</p></div>
  const va = vs.find((v) => v.id === a) ?? vs[0]
  const vb = vs.find((v) => v.id === b) ?? vs[vs.length - 1]
  const deltas = compareVersions(va.stats, vb.stats)
  const shift = va.stats.tokens && vb.stats.tokens ? histShift(va.stats.tokens.hist, vb.stats.tokens.hist) : null
  const reasons = new Map<string, { a: number; b: number; lines: number[] }>()
  for (const d of va.stats.dropped) reasons.set(d.reason, { a: d.count, b: 0, lines: [] })
  for (const d of vb.stats.dropped) reasons.set(d.reason, { a: reasons.get(d.reason)?.a ?? 0, b: d.count, lines: d.lines })
  const opsA = new Set(va.ops.map(describeOp))
  const opsB = vb.ops.map(describeOp)
  const restore = async (id: string) => {
    const v = vs.find((x) => x.id === id)!
    const prev = { ops: project.ops, split: project.split, job: project.job }
    await saveProject({ ...project, ops: v.ops, split: v.split, job: v.job, redo: [] })
    toast(`Restored the v${v.n} pipeline.`, 'success', { label: 'Undo', run: () => void saveProject({ ...project, ...prev }) })
  }

  return (
    <div className="fade-in">
      <div className="card" style={{ overflow: 'auto' }}>
        <table className="t">
          <thead><tr><th>Version</th><th>Saved</th><th className="r">Examples</th><th className="r">Tokens</th><th className="r">Errors</th><th>Model</th><th className="r">Compare</th><th /></tr></thead>
          <tbody>
            {[...vs].reverse().map((v) => (
              <tr key={v.id}>
                <td><b style={{ fontWeight: 500 }}>v{v.n}</b> <span className="muted">{v.label}</span><div className="tiny faint">{v.ops.length} fix{v.ops.length === 1 ? '' : 'es'}</div></td>
                <td className="small muted" title={new Date(v.createdAt).toLocaleString()}>{timeAgo(v.createdAt)}</td>
                <td className="r num">{fmtInt(v.stats.rows)}</td>
                <td className="r num">{v.stats.tokens ? fmtTokens(v.stats.tokens.total) : '—'}</td>
                <td className="r num" style={{ color: v.stats.errors ? 'var(--err)' : 'var(--ok)' }}>{fmtInt(v.stats.errors)}</td>
                <td className="small muted">{getModel(v.job.model).name}</td>
                <td className="r" style={{ whiteSpace: 'nowrap' }}>
                  <label className="tiny" style={{ marginRight: 8 }}><input type="radio" name="va" checked={va.id === v.id} onChange={() => setA(v.id)} /> A</label>
                  <label className="tiny"><input type="radio" name="vb" checked={vb.id === v.id} onChange={() => setB(v.id)} /> B</label>
                </td>
                <td className="r"><button className="btn ghost small" onClick={() => void restore(v.id)}>Restore</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {vs.length === 1 && <div className="card pad row wrap-row" style={{ marginTop: 16, background: 'var(--accent-bg)', borderColor: 'transparent' }}><Icon name="git" /><span className="small">Only one version so far. Apply fixes and press <b>Save version</b> (or export) to compare runs side by side.</span></div>}
      <div className="panel-h"><h2>v{va.n} → v{vb.n}</h2><span className="spacer" />{shift && <span className="badge accent" title="Total variation distance between the two token-length distributions">distribution shift {(shift.tvd * 100).toFixed(1)}%</span>}</div>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
        <div className="card" style={{ overflow: 'auto' }}>
          <table className="t">
            <thead><tr><th>Metric</th><th className="r">v{va.n}</th><th className="r">v{vb.n}</th><th className="r">Change</th></tr></thead>
            <tbody>
              {deltas.map((d) => {
                const diff = d.b - d.a
                const good = d.better === 'none' || diff === 0 ? null : (d.better === 'down') === diff < 0
                return (
                  <tr key={d.key}>
                    <td>{d.label}</td>
                    <td className="r num muted">{d.key === 'tokens' ? fmtTokens(d.a) : fmtInt(d.a)}</td>
                    <td className="r num">{d.key === 'tokens' ? fmtTokens(d.b) : fmtInt(d.b)}</td>
                    <td className="r num" style={{ color: good === null ? 'var(--ink-3)' : good ? 'var(--ok)' : 'var(--err)' }}>{diff === 0 ? '—' : `${diff > 0 ? '+' : '−'}${d.key === 'tokens' ? fmtTokens(Math.abs(diff)) : fmtInt(Math.abs(diff))}`}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <div className="card pad">
          <div className="row" style={{ marginBottom: 8 }}><b>Token length distribution</b><span className="spacer" /><span className="legend"><span><i style={{ background: 'var(--accent)' }} />v{va.n}</span><span><i style={{ background: '#2bb6c2' }} />v{vb.n}</span></span></div>
          {shift ? <Histogram counts={shift.a} compare={shift.b} limit={vb.stats.tokens?.limit} height={220} width={440} /> : <p className="small faint">Token counts were not available for one of these versions.</p>}
          <p className="tiny faint" style={{ marginTop: 6 }}>Shares of examples per length bucket, so versions of different sizes compare fairly.</p>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16, marginTop: 16 }}>
        <div className="card pad">
          <b>What was dropped and why</b>
          {reasons.size === 0 ? <p className="small faint" style={{ marginTop: 8 }}>Neither version dropped any rows.</p> : (
            <table className="t" style={{ marginTop: 8 }}>
              <thead><tr><th>Reason</th><th className="r">v{va.n}</th><th className="r">v{vb.n}</th></tr></thead>
              <tbody>{[...reasons].map(([reason, x]) => (
                <tr key={reason}><td className="small">{reason}{x.lines.length > 0 && <div className="tiny faint mono" style={{ marginTop: 3 }}>lines {x.lines.slice(0, 10).join(', ')}{x.b > 10 ? ' …' : ''}</div>}</td><td className="r num muted">{fmtInt(x.a)}</td><td className="r num">{fmtInt(x.b)}</td></tr>
              ))}</tbody>
            </table>
          )}
        </div>
        <div className="card pad">
          <b>Pipeline of v{vb.n}</b>
          {opsB.length === 0 ? <p className="small faint" style={{ marginTop: 8 }}>No fixes: data as imported.</p> : (
            <div className="log" style={{ marginTop: 10 }}>
              {opsB.map((o, i) => <div className="e" key={i}><span className="i">{String(i + 1).padStart(2, '0')}</span><span>{o}</span>{!opsA.has(o) ? <span className="badge ok">new</span> : <span />}</div>)}
            </div>
          )}
          <p className="tiny faint" style={{ marginTop: 10 }}><Icon name="shield" size={12} /> Versions store pipeline settings and summary stats only. Raw rows stay on this device.</p>
        </div>
      </div>
    </div>
  )
}
