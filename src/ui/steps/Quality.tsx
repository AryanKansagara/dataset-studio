import { useState, type ReactNode } from 'react'
import { Bars, Icon, fmtInt } from '../common.tsx'
import type { Project } from '../../lib/store.ts'
import type { Example, Op } from '../../engine/pipeline.ts'
import { LANG_NAME, PII_LABEL, type PiiKind } from '../../engine/quality.ts'
import { useSession } from '../session.ts'
import { useOpenRow } from '../Project.tsx'
import { FixLog } from './FixLog.tsx'

function QCard({ icon, title, count, unit = 'rows', tone, children, examples, fix, applied, help }: {
  icon: string; title: string; count: number | string; unit?: string; tone: 'ok' | 'warn' | 'err' | 'info'; children?: ReactNode
  examples?: Example[]; fix?: ReactNode; applied?: boolean; help: string
}) {
  const openRow = useOpenRow()
  const color = tone === 'ok' ? 'var(--ok)' : tone === 'err' ? 'var(--err)' : tone === 'warn' ? 'var(--warn)' : 'var(--ink)'
  return (
    <div className="card qcard fade-in">
      <div className="top">
        <span className="ico" style={{ width: 34, height: 34, borderRadius: 8, display: 'grid', placeItems: 'center', background: 'var(--panel-2)', border: '1px solid var(--line)', flex: 'none' }}><Icon name={icon} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3>{title}</h3>
          <div className="small muted">{help}</div>
        </div>
        <div style={{ textAlign: 'right' }}><div className="big" style={{ color }}>{typeof count === 'number' ? fmtInt(count) : count}</div><div className="tiny faint">{unit}</div></div>
      </div>
      {children}
      {examples && examples.length > 0 && (
        <div className="ex">
          {examples.slice(0, 12).map((e) => (
            <button key={`${e.id}-${e.extra}`} onClick={() => openRow(e.id)}>
              <span className="ln">L{e.line}</span><span className="tx">{e.text || '(empty)'}</span>{e.extra && <span className="mono tiny faint" style={{ flex: 'none' }}>{e.extra}</span>}
            </button>
          ))}
        </div>
      )}
      {(fix || applied) && <div className="foot">{applied ? <span className="applied"><Icon name="check" size={13} /> fix applied</span> : fix}</div>}
    </div>
  )
}

export function QualityStep({ project }: { project: Project }) {
  const { s, applyOps, update } = useSession()
  const r = s.report!
  const q = r.quality
  const has = (t: Op['type']) => project.ops.some((o) => o.type === t)
  const fix = (label: string, ops: Op[]) => <button className="btn small" onClick={() => void applyOps(ops)}>{label}</button>
  const [keepLangs, setKeepLangs] = useState<Set<string>>(() => new Set([q.language.majority]))
  const [ratio, setRatio] = useState(3)
  const piiKinds = Object.keys(q.pii.byKind) as PiiKind[]
  const langTotal = q.language.dist.reduce((a, [, n]) => a + n, 0)
  const LANG_COLORS = ['var(--accent)', 'var(--orange)', '#2bb6c2', 'var(--magenta)', '#e3a008', '#8a8aa3']

  return (
    <div className="fade-in">
      <div className="qgrid">
        <QCard icon="copy" title="Exact duplicates" count={q.exactDup.rows} tone={q.exactDup.rows ? 'warn' : 'ok'} examples={q.exactDup.examples}
          help={`Identical examples (after normalising case and whitespace) in ${fmtInt(q.exactDup.groups)} groups. They over-weight a few answers and inflate epochs.`}
          applied={has('dedupeExact') && !q.exactDup.rows} fix={q.exactDup.rows ? fix('Remove duplicates', [{ type: 'dedupeExact' }]) : null} />

        <QCard icon="layers" title="Near-duplicates" count={q.nearDup.rows} tone={q.nearDup.rows ? 'warn' : 'ok'} examples={q.nearDup.examples}
          help={`MinHash over word 3-grams (64 permutations, LSH banding). ${fmtInt(q.nearDup.clusters)} clusters at similarity ≥ ${project.nearThreshold}.`}
          applied={has('dedupeNear') && !q.nearDup.rows}
          fix={<>
            <label className="row tiny muted" style={{ gap: 8 }}>Threshold
              <input type="range" min={0.6} max={0.95} step={0.05} value={project.nearThreshold} onChange={(e) => void update((p) => ({ ...p, nearThreshold: Number(e.target.value) }))} style={{ width: 110 }} aria-label="Near-duplicate threshold" />
              <span className="num mono">{project.nearThreshold.toFixed(2)}</span>
            </label>
            <span className="spacer" />
            {q.nearDup.rows > 0 && fix('Keep one per cluster', [{ type: 'dedupeNear', threshold: project.nearThreshold }])}
          </>} />

        <QCard icon="split" title="Train / validation leakage" count={q.leakage.rows} tone={q.leakage.rows ? 'err' : 'ok'} examples={q.leakage.examples}
          help="Validation rows whose prompt or full text also appears (exactly or nearly) in train. Leaks make eval loss look better than the model is."
          applied={has('dropLeakage') && !q.leakage.rows} fix={q.leakage.rows ? fix('Drop leaked rows', [{ type: 'dropLeakage' }]) : null} />

        <QCard icon="shield" title="PII and secrets" count={q.pii.rows} tone={q.pii.rows ? 'err' : 'ok'} examples={q.pii.examples}
          help="Emails, phone numbers, Luhn-valid card numbers, IPs, API keys, tokens and private keys anywhere in the example."
          applied={has('redactPii') && !q.pii.rows} fix={q.pii.rows ? fix('Redact all', [{ type: 'redactPii', kinds: piiKinds.length ? piiKinds : ['email', 'phone', 'card', 'secret', 'ip'] }]) : null}>
          {piiKinds.length > 0 && <div className="row wrap-row">{piiKinds.map((k) => <span key={k} className="badge err">{PII_LABEL[k]} · {q.pii.byKind[k]}</span>)}</div>}
        </QCard>

        <QCard icon="chat" title="Boilerplate refusals" count={q.refusals.rows} tone={q.refusals.rows ? 'warn' : 'ok'} examples={q.refusals.examples}
          help="Answers like “As an AI language model, I cannot…”. A few teach the model to refuse things it should do."
          applied={has('dropRefusals') && !q.refusals.rows} fix={q.refusals.rows ? fix('Drop refusals', [{ type: 'dropRefusals' }]) : null} />

        <QCard icon="globe" title="Language mix" count={q.language.minorityRows} tone={q.language.minorityRows ? 'warn' : 'ok'} examples={q.language.examples.map((e) => ({ ...e, extra: LANG_NAME[e.extra ?? ''] ?? e.extra }))}
          help={`Detected per example from scripts and stopwords. Majority: ${LANG_NAME[q.language.majority] ?? q.language.majority}. Rows in other languages are listed.`}
          applied={has('filterLanguage') && !q.language.minorityRows}
          fix={q.language.dist.length > 1 ? <>
            <div className="row wrap-row" style={{ gap: 6 }}>
              {q.language.dist.map(([l, n]) => (
                <label key={l} className="badge" style={{ cursor: 'pointer', background: keepLangs.has(l) ? 'var(--accent-bg)' : undefined, color: keepLangs.has(l) ? 'var(--accent)' : undefined }}>
                  <input type="checkbox" style={{ margin: 0 }} checked={keepLangs.has(l)} onChange={(e) => setKeepLangs((k) => { const x = new Set(k); if (e.target.checked) x.add(l); else x.delete(l); return x })} />
                  {LANG_NAME[l] ?? l} {n}
                </label>
              ))}
            </div>
            <span className="spacer" />
            {fix(`Keep ${keepLangs.size} language${keepLangs.size === 1 ? '' : 's'}`, [{ type: 'filterLanguage', keep: [...keepLangs] }])}
          </> : null}>
          <div className="stackbar" aria-label="Language distribution">
            {q.language.dist.map(([l, n], i) => <div key={l} title={`${LANG_NAME[l] ?? l}: ${n}`} style={{ width: `${(100 * n) / Math.max(1, langTotal)}%`, background: LANG_COLORS[i % LANG_COLORS.length] }} />)}
          </div>
        </QCard>

        <QCard icon="ruler" title="Answer length outliers" count={q.outliers.low + q.outliers.high} tone={q.outliers.low + q.outliers.high ? 'warn' : 'ok'} examples={q.outliers.examples}
          help={`Robust bounds on the target answer (median ${fmtInt(q.outliers.median)} chars, kept range ${fmtInt(q.outliers.lo)}–${q.outliers.hi === Infinity ? '∞' : fmtInt(q.outliers.hi)}). ${q.outliers.low} suspiciously short, ${q.outliers.high} suspiciously long.`}
          applied={has('dropOutliers') && !(q.outliers.low + q.outliers.high)} fix={q.outliers.low + q.outliers.high ? fix('Drop outliers', [{ type: 'dropOutliers' }]) : null} />

        <QCard icon="scale" title="Label balance" count={q.labels.labels.length > 1 ? `${q.labels.ratio.toFixed(1)}:1` : '—'} unit={q.labels.source === 'none' ? 'no labels' : 'largest : smallest'} tone={q.labels.ratio > 5 ? 'warn' : q.labels.labels.length > 1 ? 'ok' : 'info'}
          help={q.labels.source === 'column' ? `From the mapped label column. Classes are kept proportional in the split (stratified).` : q.labels.source === 'answer' ? 'Answers look like class labels (few distinct short values), so this is treated as classification data.' : 'No label column mapped and the answers do not look like class labels. Map a label column in Import to enable stratified splits.'}
          applied={has('rebalance') && q.labels.ratio <= ratio}
          fix={q.labels.labels.length > 1 && q.labels.ratio > 1.5 ? <>
            <label className="row tiny muted" style={{ gap: 8 }}>Cap at
              <select className="input" style={{ height: 30, width: 80 }} value={ratio} onChange={(e) => setRatio(Number(e.target.value))}>{[1, 2, 3, 5, 10].map((x) => <option key={x} value={x}>{x}:1</option>)}</select>
            </label>
            <span className="spacer" />
            {fix('Downsample majority', [{ type: 'rebalance', maxRatio: ratio }])}
          </> : null}>
          {q.labels.labels.length > 1 && <Bars items={q.labels.labels.slice(0, 8)} />}
        </QCard>
      </div>
      <FixLog />
    </div>
  )
}
