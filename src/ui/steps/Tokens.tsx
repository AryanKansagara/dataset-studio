import { useEffect, useState } from 'react'
import { Histogram, Icon, fmtInt, fmtTokens } from '../common.tsx'
import { saveSettings, settings$, useObs, type Project } from '../../lib/store.ts'
import { engine, type RowDetail } from '../../lib/engine.ts'
import { getModel } from '../../engine/rules.ts'
import { limitFor } from '../../engine/exporters.ts'
import { useSession } from '../session.ts'
import { useOpenRow } from '../Project.tsx'

/** Highlight special tokens like <|im_start|>, <s>, [INST] in a rendered template. */
export function TemplateView({ text }: { text: string }) {
  const parts = text.split(/(<\|[^|]{1,40}\|>|<\/?s>|\[\/?INST\]|<start_of_turn>|<end_of_turn>|<bos>|<eos>|<think>|<\/think>|<｜[^｜]{1,40}｜>)/g)
  return <pre className="code tpl">{parts.map((p, i) => (i % 2 ? <span key={i} className="sp">{p}</span> : p))}</pre>
}

export function TokensStep({ project }: { project: Project }) {
  const { s, applyOps, analyze } = useSession()
  const openRow = useOpenRow()
  const settings = useObs(settings$)
  const r = s.report!
  const t = r.tokens
  const limit = limitFor(project.job)
  const model = getModel(project.job.model)
  const [preview, setPreview] = useState<RowDetail | null>(null)
  const [pi, setPi] = useState(0)

  useEffect(() => {
    const id = r.sampleIds[pi % Math.max(1, r.sampleIds.length)]
    if (id === undefined || s.tkState !== 'ready') return
    let alive = true
    void engine.row(id, limit).then((d) => { if (alive) setPreview(d) })
    return () => { alive = false }
  }, [pi, r, s.tkState, limit])

  if (!t) return (
    <div className="empty fade-in">
      {s.tkState === 'error' ? <><h2>Tokenizer failed to load</h2><p>{s.tkError}</p></> : <><span className="spinner" style={{ margin: '0 auto' }} /><h2>Loading the {model.name} tokenizer</h2><p>Downloaded once from the Hugging Face Hub and cached in this browser.</p></>}
    </div>
  )
  const truncApplied = project.ops.some((o) => o.type === 'truncate' && o.limit === limit)

  return (
    <div className="fade-in">
      <div className="stats">
        <div className="stat"><div className="label">Tokens</div><div className="v num">{fmtTokens(t.total)}</div><div className="s">{t.exact ? 'Every row counted' : `Estimated from ${fmtInt(t.sampled)} sampled rows`}</div></div>
        <div className="stat"><div className="label">Median · p95</div><div className="v num">{fmtInt(t.p50)}<small>/ {fmtInt(t.p95)}</small></div><div className="s">Max {fmtInt(t.max)}{t.perSide ? ' per side' : ''}</div></div>
        <div className={`stat ${t.over ? 'warn' : 'ok'}`}><div className="label">Over the limit</div><div className="v num">{fmtInt(t.over)}</div><div className="s">{t.over ? `${(100 * t.over / Math.max(1, t.n)).toFixed(1)}% of examples` : 'Everything fits'}</div></div>
        <div className={`stat ${t.cut ? 'warn' : ''}`}><div className="label">Tokens cut</div><div className="v num">{fmtTokens(t.cut)}</div><div className="s">Silently lost at {fmtInt(limit)} if uploaded as-is</div></div>
      </div>

      <div className="card pad" style={{ marginTop: 16 }}>
        <div className="row wrap-row" style={{ marginBottom: 10 }}>
          <b>Token length per example</b>
          <span className="badge">{s.tk?.approximate ? 'estimated' : `${s.tk?.repo}${s.tk?.hasTemplate ? ' + chat template' : ''}`}</span>
          <span className="spacer" />
          <span className="tiny faint">log scale · orange = over max_seq_length</span>
        </div>
        <Histogram counts={t.hist} limit={limit} height={210} />
        {!t.exact && (
          <label className="switch" style={{ marginTop: 12 }}>
            <input type="checkbox" checked={settings.exactTokens} onChange={(e) => { saveSettings({ exactTokens: e.target.checked }); void analyze() }} />
            <span className="small">Count every row (slower on very large files)</span>
          </label>
        )}
      </div>

      {t.over > 0 && (
        <div className="card pad row wrap-row" style={{ marginTop: 16, background: 'var(--warn-bg)', borderColor: 'transparent' }}>
          <Icon name="ruler" />
          <div style={{ flex: 1, minWidth: 240 }}>
            <b>{fmtInt(t.over)} examples will be cut at {fmtInt(limit)} tokens</b>
            <div className="small muted">Smart truncation drops the oldest whole exchanges and keeps the system prompt and the final answer. Prompts are cut from the start, text from the end. Rows whose final answer alone is too long are dropped.</div>
          </div>
          {truncApplied ? <span className="applied"><Icon name="check" size={13} /> applied</span> : <button className="btn" onClick={() => void applyOps([{ type: 'truncate', limit }])}>Truncate smartly</button>}
        </div>
      )}

      <div className="two-col">
        <div style={{ minWidth: 0 }}>
          <div className="panel-h"><h3>Rendered chat template</h3><span className="spacer" />
            <button className="btn small secondary" onClick={() => setPi((x) => Math.max(0, x - 1))} disabled={pi === 0}>Prev</button>
            <button className="btn small secondary" onClick={() => setPi((x) => x + 1)}>Next</button>
          </div>
          {preview?.rendered ? (
            <>
              <TemplateView text={preview.rendered[0].length > 4000 ? preview.rendered[0].slice(0, 4000) + '\n…' : preview.rendered[0]} />
              <div className="row tiny faint" style={{ marginTop: 6 }}>
                <span>Line {preview.row.line}</span><span>·</span><span className="num">{preview.tokens?.map(fmtInt).join(' / ')} tokens</span>
                <span className="spacer" />
                <button className="btn ghost small" onClick={() => openRow(preview.row.id)}>Inspect row</button>
              </div>
            </>
          ) : <div className="skeleton" style={{ height: 220 }} />}
          {s.tk && !s.tk.hasTemplate && !s.tk.approximate && <p className="tiny faint" style={{ marginTop: 6 }}>This model's tokenizer ships no chat template, so conversations are counted as role-tagged text.</p>}
        </div>
        <div style={{ minWidth: 0 }}>
          <div className="panel-h"><h3>Longest examples</h3></div>
          <div className="card qcard" style={{ padding: 10 }}>
            <div className="ex" style={{ maxHeight: 340 }}>
              {t.longest.map((e) => (
                <button key={e.id} onClick={() => openRow(e.id)}><span className="ln">L{e.line}</span><span className="tx">{e.text}</span><span className="mono tiny" style={{ color: Number(e.extra?.replace(/\D/g, '')) > limit ? 'var(--warn)' : undefined }}>{e.extra?.replace(' tokens', '')}</span></button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
