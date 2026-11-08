import { useState } from 'react'
import { Icon, fmtInt, fmtTokens } from '../common.tsx'
import type { Project } from '../../lib/store.ts'
import { getModel, RULES_CHECKED, SOURCES, assumedThroughput } from '../../engine/rules.ts'
import { estimateCost, fmtDuration, fmtUsd } from '../../engine/cost.ts'
import type { JobSettings } from '../../engine/exporters.ts'
import { useSession } from '../session.ts'

export function SplitStep({ project }: { project: Project }) {
  const { s, update } = useSession()
  const r = s.report!
  const job = project.job
  const model = getModel(job.model)
  const setJob = (p: Partial<JobSettings>) => void update((x) => ({ ...x, job: { ...x.job, ...p } }))
  const setSplit = (p: Partial<Project['split']>) => void update((x) => ({ ...x, split: { ...x.split, ...p } }))
  const [tput, setTput] = useState<number | null>(null)
  const t = r.tokens
  const cost = t ? estimateCost({ model, method: job.method, lora: job.lora, epochs: job.epochs, nEvals: r.val ? job.nEvals : 0, trainTokens: t.train, valTokens: t.val, throughput: tput ?? undefined }) : null
  const isPref = r.format === 'preference'
  const valShare = new Map(r.quality.labels.valDist)
  const labelRows = r.quality.labels.labels.slice(0, 8)

  return (
    <div className="fade-in">
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
        <div className="card pad">
          <div className="panel-h" style={{ marginTop: 0 }}><h3>Train / validation split</h3><span className="spacer" />{r.stratified ? <span className="badge accent">stratified by label</span> : <span className="badge">random</span>}</div>
          <label className="field"><span>Validation share · {Math.round(project.split.valFraction * 100)}%</span>
            <input type="range" min={0} max={0.3} step={0.01} value={project.split.valFraction} onChange={(e) => setSplit({ valFraction: Number(e.target.value) })} />
          </label>
          <div className="row" style={{ marginTop: 14, gap: 12 }}>
            <label className="field" style={{ width: 120 }}><span>Seed</span><input className="input num" type="number" value={project.split.seed} onChange={(e) => setSplit({ seed: Number(e.target.value) || 0 })} /></label>
            <label className="switch" style={{ marginTop: 18 }}><input type="checkbox" checked={project.split.stratify} onChange={(e) => setSplit({ stratify: e.target.checked })} />Stratify by label</label>
          </div>
          <div className="stackbar" style={{ marginTop: 18, height: 14 }}>
            <div style={{ width: `${(100 * r.train) / Math.max(1, r.rows)}%`, background: 'var(--accent)' }} />
            <div style={{ width: `${(100 * r.val) / Math.max(1, r.rows)}%`, background: 'var(--orange)' }} />
          </div>
          <div className="legend" style={{ marginTop: 10 }}>
            <span><i style={{ background: 'var(--accent)' }} />Train <b className="num">{fmtInt(r.train)}</b></span>
            <span><i style={{ background: 'var(--orange)' }} />Validation <b className="num">{fmtInt(r.val)}</b></span>
          </div>
          <p className="tiny faint" style={{ marginTop: 12 }}>Deterministic: the same seed and the same rows always give the same split, so next month's version is comparable. {r.quality.leakage.rows > 0 && <b style={{ color: 'var(--err)' }}>{r.quality.leakage.rows} validation rows leak from train (see Quality).</b>}</p>
          {labelRows.length > 1 && r.val > 0 && (
            <table className="t" style={{ marginTop: 10 }}>
              <thead><tr><th>Label</th><th className="r">All</th><th className="r">Validation</th><th className="r">Share</th></tr></thead>
              <tbody>{labelRows.map(([l, n]) => <tr key={l}><td>{l}</td><td className="r num">{fmtInt(n)}</td><td className="r num">{fmtInt(valShare.get(l) ?? 0)}</td><td className="r num">{(((valShare.get(l) ?? 0) / Math.max(1, n)) * 100).toFixed(0)}%</td></tr>)}</tbody>
            </table>
          )}
        </div>

        <div className="card pad">
          <div className="panel-h" style={{ marginTop: 0 }}><h3>Job settings</h3></div>
          <div className="grid" style={{ gap: 14 }}>
            <div className="row wrap-row">
              <div className="seg" role="group" aria-label="Training method">
                <button aria-pressed={job.method === 'sft'} onClick={() => setJob({ method: 'sft' })} disabled={isPref}>SFT</button>
                <button aria-pressed={job.method === 'dpo'} onClick={() => setJob({ method: 'dpo' })} disabled={!isPref}>DPO</button>
              </div>
              <div className="seg" role="group" aria-label="Adapter">
                <button aria-pressed={job.lora} onClick={() => setJob({ lora: true })}>LoRA</button>
                <button aria-pressed={!job.lora} onClick={() => setJob({ lora: false })} disabled={!model.full} title={model.full ? '' : 'Full fine-tuning is not offered for this model'}>Full</button>
              </div>
            </div>
            {isPref && job.method !== 'dpo' && <p className="small" style={{ color: 'var(--warn)' }}>Preference data trains with DPO. Switch the method to DPO.</p>}
            <div className="map-grid">
              <label className="field"><span>Epochs</span><input className="input num" type="number" min={1} max={20} value={job.epochs} onChange={(e) => setJob({ epochs: Math.max(1, Number(e.target.value) || 1) })} /></label>
              <label className="field"><span>Evaluations (n_evals)</span><input className="input num" type="number" min={0} max={100} value={job.nEvals} onChange={(e) => setJob({ nEvals: Math.max(0, Number(e.target.value) || 0) })} /></label>
              <label className="field"><span>Learning rate</span><input className="input num" type="number" step="any" value={job.learningRate} onChange={(e) => setJob({ learningRate: Number(e.target.value) || 1e-5 })} /></label>
              {job.method === 'dpo'
                ? <label className="field"><span>DPO beta</span><input className="input num" type="number" step={0.05} min={0.05} max={0.9} value={job.dpoBeta} onChange={(e) => setJob({ dpoBeta: Number(e.target.value) || 0.1 })} /></label>
                : <label className="field"><span>train_on_inputs</span><select className="input" value={job.trainOnInputs} onChange={(e) => setJob({ trainOnInputs: e.target.value as JobSettings['trainOnInputs'] })}><option value="auto">auto (assistant / completion only)</option><option value="false">false</option><option value="true">true (also learn prompts)</option></select></label>}
              <label className="field"><span>Model suffix</span><input className="input" placeholder="support-bot-v3" value={job.suffix} onChange={(e) => setJob({ suffix: e.target.value.replace(/[^\w.-]/g, '-').slice(0, 40) })} /></label>
            </div>
          </div>
        </div>
      </div>

      <div className="panel-h"><h2>Cost and time</h2><span className="spacer" /><span className="tiny faint">Prices checked {RULES_CHECKED} · <a href={SOURCES.pricing} target="_blank" rel="noreferrer">together.ai/pricing</a></span></div>
      {cost && t ? (
        <div className="card pad">
          <div className="stats">
            <div className="stat" style={{ background: 'var(--accent-bg)', borderColor: 'transparent' }}>
              <div className="label">Estimated cost</div>
              <div className="v num">{cost.total === null ? 'n/a' : fmtUsd(cost.total)}</div>
              <div className="s">{cost.pricePerM === null ? cost.note : cost.minApplied ? `Minimum charge for ${model.name}` : `$${cost.pricePerM} per 1M tokens`}</div>
            </div>
            <div className="stat"><div className="label">Billed tokens</div><div className="v num">{fmtTokens(cost.billedTokens)}</div><div className="s">{fmtTokens(t.train)} × {job.epochs} epochs{r.val && job.nEvals ? ` + ${fmtTokens(t.val)} × ${job.nEvals} evals` : ''}</div></div>
            <div className="stat"><div className="label">Training time</div><div className="v num">~{fmtDuration(cost.hours)}</div><div className="s">plus queue time, typically under an hour</div></div>
          </div>
          <div className="small muted" style={{ marginTop: 16, display: 'grid', gap: 6 }}>
            <div className="note"><Icon name="check" size={13} /><span>Formula from the pricing page: training tokens × epochs, plus validation tokens × number of evaluations, subject to the per-model minimum ({fmtUsd(cost.minCharge)}).</span></div>
            <div className="note"><Icon name="check" size={13} /><span>Each example counts at most max_seq_length tokens{t.perSide ? '; DPO counts both the preferred and non-preferred side' : ''}.{!t.exact && ' Token totals are extrapolated from a sample.'}</span></div>
            <div className="row wrap-row" style={{ gap: 6 }}><Icon name="bolt" size={13} /> Time is an assumption, not a quote: Together does not publish throughput. Assuming
              <input className="input num" type="number" style={{ width: 100, height: 28 }} value={Math.round(tput ?? cost.throughput)} onChange={(e) => setTput(Math.max(100, Number(e.target.value) || 0))} aria-label="Assumed throughput in tokens per second" />
              tokens/s{tput !== null && <button className="btn ghost small" onClick={() => setTput(null)}>reset ({fmtInt(assumedThroughput(model.activeB))} base)</button>}</div>
          </div>
        </div>
      ) : <div className="empty"><p>Token counts are needed for a cost estimate. Waiting for the tokenizer…</p></div>}
    </div>
  )
}
