import { useState } from 'react'
import { CopyButton, Icon, download, fmtInt, fmtTokens } from '../common.tsx'
import { toast, type Project } from '../../lib/store.ts'
import { engine } from '../../lib/engine.ts'
import { cliCommands, datasetCard, limitFor, pythonCommands } from '../../engine/exporters.ts'
import { getModel, RULES_CHECKED, TOGETHER_SDK_VERSION } from '../../engine/rules.ts'
import { estimateCost, fmtUsd } from '../../engine/cost.ts'
import { useSession } from '../session.ts'
import { A } from '../common.tsx'

export function ExportStep({ project }: { project: Project }) {
  const session = useSession()
  const r = session.s.report!
  const [kind, setKind] = useState<'jsonl' | 'parquet'>('jsonl')
  const [tab, setTab] = useState<'cli' | 'python' | 'card'>('cli')
  const [busy, setBusy] = useState<string | null>(null)
  const slug = project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'dataset'
  const ext = kind === 'jsonl' ? 'jsonl' : 'parquet'
  const files = { train: `${slug}.train.${ext}`, val: r.val > 0 ? `${slug}.validation.${ext}` : null }
  const job = { ...project.job, suffix: project.job.suffix || slug.slice(0, 30) }
  const limit = limitFor(project.job)
  const last = project.versions[project.versions.length - 1]
  const dirty = !last || JSON.stringify(last.ops) !== JSON.stringify(project.ops) || JSON.stringify(last.split) !== JSON.stringify(project.split)
  const card = datasetCard({ name: project.name, source: project.source?.name ?? '', job, report: r, versionLabel: dirty ? `v${(last?.n ?? 0) + 1} (unsaved)` : `v${last.n} · ${last.label}`, createdAt: new Date().toISOString() })
  const cli = cliCommands(job, files, r.format)
  const py = pythonCommands(job, files, r.format)
  const t = r.tokens
  const cost = t ? estimateCost({ model: getModel(job.model), method: job.method, lora: job.lora, epochs: job.epochs, nEvals: r.val ? job.nEvals : 0, trainTokens: t.train, valTokens: t.val }) : null

  const checks: { ok: boolean; warn?: boolean; text: string }[] = [
    { ok: r.issues.rowsWithErrors === 0, text: r.issues.rowsWithErrors ? `${fmtInt(r.issues.rowsWithErrors)} rows still fail schema validation` : 'Every row matches the documented schema' },
    { ok: !(r.issues.byCode.W_UNKNOWN_KEY), warn: true, text: r.issues.byCode.W_UNKNOWN_KEY ? `${fmtInt(r.issues.byCode.W_UNKNOWN_KEY)} rows carry undocumented keys` : 'No undocumented keys' },
    { ok: !t || t.over === 0, text: t?.over ? `${fmtInt(t.over)} examples exceed ${fmtInt(limit)} tokens and will be cut` : `Everything fits in ${fmtInt(limit)} tokens` },
    { ok: r.quality.pii.rows === 0, text: r.quality.pii.rows ? `${fmtInt(r.quality.pii.rows)} rows contain PII or secrets` : 'No PII or secrets detected' },
    { ok: r.quality.leakage.rows === 0, text: r.quality.leakage.rows ? `${fmtInt(r.quality.leakage.rows)} validation rows leak from train` : 'No train/validation leakage' },
    { ok: r.quality.exactDup.rows === 0, warn: true, text: r.quality.exactDup.rows ? `${fmtInt(r.quality.exactDup.rows)} exact duplicates` : 'No exact duplicates' },
    { ok: r.rows >= 1, text: `${fmtInt(r.rows)} examples (minimum 1)` },
  ]
  const blocking = checks.filter((c) => !c.ok && !c.warn).length

  const save = async (part: 'train' | 'val' | 'all') => {
    setBusy(part)
    try {
      if (dirty) { const v = await session.commit(`Export ${new Date().toLocaleDateString()}`); if (v) toast(`Saved v${v.n} for this export.`, 'success') }
      const blob = await engine.export({ kind, part, trainOnInputs: job.trainOnInputs === 'true', limit })
      download(blob, part === 'all' ? `${slug}.${ext}` : part === 'train' ? files.train : files.val!)
    } catch (e) { toast((e as Error).message, 'error') } finally { setBusy(null) }
  }

  return (
    <div className="fade-in">
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
        <div className="card pad">
          <div className="panel-h" style={{ marginTop: 0 }}><h3>Ready to upload?</h3><span className="spacer" />{blocking ? <span className="badge err">{blocking} blocking</span> : <span className="badge ok"><Icon name="check" size={11} /> ready</span>}</div>
          <div className="check-list">
            {checks.map((c, i) => (
              <div key={i}><span style={{ color: c.ok ? 'var(--ok)' : c.warn ? 'var(--warn)' : 'var(--err)' }}><Icon name={c.ok ? 'check' : 'x'} size={15} /></span>{c.text}</div>
            ))}
          </div>
          {blocking > 0 && <p className="tiny faint" style={{ marginTop: 10 }}>You can still export; fix these in <A href={`/app/p/${project.id}/validate`}>Validate</A>, <A href={`/app/p/${project.id}/tokens`}>Tokens</A> and <A href={`/app/p/${project.id}/quality`}>Quality</A> first for a cleaner run.</p>}
        </div>
        <div className="card pad">
          <div className="panel-h" style={{ marginTop: 0 }}><h3>Download</h3><span className="spacer" />
            <div className="seg" role="group" aria-label="File format">
              <button aria-pressed={kind === 'jsonl'} onClick={() => setKind('jsonl')}>JSONL</button>
              <button aria-pressed={kind === 'parquet'} onClick={() => setKind('parquet')} disabled={r.format === 'preference'} title={r.format === 'preference' ? 'Together does not accept pre-tokenized Parquet for DPO' : ''}>Parquet</button>
            </div>
          </div>
          <p className="small muted">{kind === 'jsonl' ? `${r.format} JSONL, one example per line, exactly as Together expects.` : `Pre-tokenized with ${session.s.tk?.repo ?? 'the model tokenizer'}: input_ids, attention_mask and labels (−100 masks ${job.trainOnInputs === 'true' ? 'nothing' : 'non-assistant tokens'}), cut at ${fmtInt(limit)}. Packing does not apply to Parquet.`}</p>
          <div className="grid" style={{ gap: 8, marginTop: 14 }}>
            <button className="btn" disabled={!!busy} onClick={() => void save('train')}><Icon name="download" size={14} /> <span className="fname">{busy === 'train' ? 'Preparing…' : files.train}</span><span>· {fmtInt(r.train)} rows</span></button>
            {files.val && <button className="btn secondary" disabled={!!busy} onClick={() => void save('val')}><Icon name="download" size={14} /> <span className="fname">{busy === 'val' ? 'Preparing…' : files.val}</span><span>· {fmtInt(r.val)} rows</span></button>}
            <div className="row wrap-row">
              <button className="btn ghost small" disabled={!!busy} onClick={() => void save('all')}>Everything in one file</button>
              <button className="btn ghost small" onClick={() => download(new Blob([card], { type: 'text/markdown' }), `${slug}.README.md`)}>Dataset card (.md)</button>
              <button className="btn ghost small" onClick={() => window.print()}><Icon name="printer" size={13} /> Print report</button>
            </div>
          </div>
          {t && cost?.total != null && <p className="tiny faint" style={{ marginTop: 12 }}>{fmtTokens(t.train)} training tokens · about {fmtUsd(cost.total)} for {job.epochs} epochs on {getModel(job.model).name} (prices checked {RULES_CHECKED}).</p>}
        </div>
      </div>

      <div className="panel-h"><h2>Upload and train</h2><span className="spacer" /><span className="badge accent">together=={TOGETHER_SDK_VERSION}</span></div>
      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'cli'} onClick={() => setTab('cli')}>CLI</button>
          <button role="tab" aria-selected={tab === 'python'} onClick={() => setTab('python')}>Python SDK</button>
          <button role="tab" aria-selected={tab === 'card'} onClick={() => setTab('card')}>Dataset card</button>
        </div>
        <div className="codebox">
          <span className="copy"><CopyButton text={tab === 'cli' ? cli : tab === 'python' ? py : card} /></span>
          <pre className="code" style={{ borderRadius: 0, maxHeight: 460, border: 0, whiteSpace: tab === 'card' ? 'pre-wrap' : 'pre' }}>{tab === 'cli' ? cli : tab === 'python' ? py : card}</pre>
        </div>
      </div>
      <p className="tiny faint" style={{ marginTop: 8 }}>Flags verified against the together CLI source ({TOGETHER_SDK_VERSION}). Together runs full schema validation after upload; check that the file reaches COMPLETED before the job starts.</p>
      <div className="print-only"><h2>{project.name}</h2><pre>{card}</pre><pre>{cli}</pre></div>
    </div>
  )
}
