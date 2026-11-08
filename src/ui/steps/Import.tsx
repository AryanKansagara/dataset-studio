import { useEffect, useRef, useState } from 'react'
import { Icon, Progress, fmtBytes, fmtInt } from '../common.tsx'
import { engine, type HfInfo, type Source } from '../../lib/engine.ts'
import { toast, type Project, type SourceInfo } from '../../lib/store.ts'
import { navigate } from '../../router.ts'
import { applyMapping, FORMAT_LABEL, type Format, type Mapping } from '../../engine/mapping.ts'
import { validateRecord } from '../../engine/validate.ts'
import { SAMPLE_HF_ID, SAMPLE_HF_SPLIT } from '../../engine/sample.ts'
import type { Peek } from '../../engine/ingest.ts'
import { setSource, useSession } from '../session.ts'

type Peeked = Peek & { name: string; size: number }

export function ImportStep({ project, reattach }: { project: Project; reattach: boolean }) {
  const session = useSession()
  const [peek, setPeek] = useState<{ src: Source; info: SourceInfo; data: Peeked; file?: File } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [hf, setHf] = useState('')
  const [hfInfo, setHfInfo] = useState<HfInfo | null>(null)
  const [hfPick, setHfPick] = useState({ config: '', split: '', maxRows: 50000 })
  const [drag, setDrag] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const auto = useRef(false)
  const { s } = session

  const doPeek = async (src: Source, info: SourceInfo, file?: File) => {
    setBusy('Reading a preview')
    try {
      const data = await engine.peek(src)
      setPeek({ src, info: { ...info, size: data.size || info.size }, data, file })
      return data
    } catch (e) { toast((e as Error).message, 'error'); return null } finally { setBusy(null) }
  }

  const doImport = async (src: Source, info: SourceInfo, mapping: Mapping, file?: File) => {
    setBusy('Importing')
    try {
      await setSource(project, info, mapping, file)
      navigate(`/app/p/${project.id}/validate`)
    } catch (e) { toast((e as Error).message, 'error') } finally { setBusy(null) }
  }

  // "Try the sample" lands here with ?sample=1: preview + import straight away
  useEffect(() => {
    if (auto.current || !new URLSearchParams(location.search).get('sample') || project.source) return
    auto.current = true
    void (async () => {
      const info: SourceInfo = { kind: 'sample', name: 'support-chats-messy.jsonl', size: 0 }
      const data = await doPeek({ kind: 'sample' }, info)
      if (data) await doImport({ kind: 'sample' }, { ...info, size: data.size }, data.suggested)
    })()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const onFile = (f: File | undefined) => {
    if (!f) return
    if (reattach && project.mapping) { void session.load(f); return }
    void doPeek({ kind: 'file', file: f }, { kind: 'file', name: f.name, size: f.size }, f)
  }

  const fetchHf = async (id = hf.trim()) => {
    if (!/^[\w.-]+\/[\w.-]+$/.test(id)) { toast('Use the form owner/dataset, e.g. HuggingFaceH4/no_robots', 'error'); return }
    setBusy('Listing splits on Hugging Face')
    try {
      const info = await engine.hfInfo(id)
      setHfInfo(info)
      const first = info.configs.find((c) => c.split === (id === SAMPLE_HF_ID ? SAMPLE_HF_SPLIT : 'train')) ?? info.configs[0]
      setHfPick({ config: first.config, split: first.split, maxRows: 50000 })
      setHf(id)
    } catch (e) { toast((e as Error).message, 'error') } finally { setBusy(null) }
  }

  const peekHf = () => {
    const info: SourceInfo = { kind: 'hf', name: `hf://${hf} (${hfPick.config}/${hfPick.split})`, size: 0, dataset: hf, config: hfPick.config, split: hfPick.split, maxRows: hfPick.maxRows }
    void doPeek({ kind: 'hf', dataset: hf, config: hfPick.config, split: hfPick.split, maxRows: 200 }, info)
  }

  if (busy || s.phase === 'loading') return <Progress label={s.progress?.phase ?? busy ?? 'Working'} value={s.progress?.done} total={s.progress?.total} />

  if (peek) return <MappingStep peek={peek} onCancel={() => setPeek(null)} onImport={(m) => void doImport({ ...peek.src, ...(peek.src.kind === 'hf' ? { maxRows: peek.info.maxRows } : {}) } as Source, peek.info, m, peek.file)} />

  return (
    <div className="grid" style={{ gap: 18 }}>
      {reattach && project.source && (
        <div className="card pad" style={{ borderColor: 'var(--accent)' }}>
          <div className="row"><Icon name="file" /><b>Re-attach {project.source.name}</b></div>
          <p className="muted small" style={{ marginTop: 6 }}>Source files over 300 MB (or from another device) are not stored in the browser. Pick the same file again; the saved mapping and fix pipeline will be re-applied.</p>
        </div>
      )}
      {project.source && !reattach && s.phase === 'ready' && (
        <div className="card pad">
          <div className="row wrap-row">
            <div>
              <div className="label">Current source</div>
              <div style={{ fontWeight: 500, marginTop: 6 }}>{project.source.name}</div>
              <div className="small muted">{project.format ? FORMAT_LABEL[project.format] : ''}{project.source.rows !== undefined ? ` · ${fmtInt(project.source.rows)} rows` : ''}{project.source.size ? ` · ${fmtBytes(project.source.size)}` : ''}{project.mapping?.label ? ` · label column “${project.mapping.label}”` : ''}</div>
            </div>
            <span className="spacer" />
            <button className="btn secondary small" onClick={() => {
              const src = project.source!.kind === 'sample' ? { kind: 'sample' as const } : project.source!.kind === 'hf' ? { kind: 'hf' as const, dataset: project.source!.dataset!, config: project.source!.config, split: project.source!.split, maxRows: 200 } : null
              if (src) void doPeek(src, project.source!)
              else fileInput.current?.click()
            }}>Change mapping</button>
          </div>
          <p className="tiny faint" style={{ marginTop: 10 }}>Importing a new source resets this project's fix pipeline. Saved versions are kept for comparison.</p>
        </div>
      )}
      <div className="import-grid">
        <div
          className={`drop${drag ? ' on' : ''}`}
          role="button" tabIndex={0}
          onClick={() => fileInput.current?.click()}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.current?.click() } }}
          onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); onFile(e.dataTransfer.files[0]) }}
        >
          <div style={{ display: 'grid', placeItems: 'center', gap: 10 }}>
            <span className="ico" style={{ width: 44, height: 44, borderRadius: 10, display: 'grid', placeItems: 'center', background: 'var(--accent-bg)', color: 'var(--accent)' }}><Icon name="upload" size={20} /></span>
            <div style={{ fontSize: 18, fontWeight: 500 }}>{reattach ? 'Drop the source file again' : 'Drop a file or click to browse'}</div>
            <div className="small muted">JSONL · JSON · CSV / TSV · Parquet. Streams in a background worker; 500 MB is fine.</div>
          </div>
          <input ref={fileInput} type="file" hidden accept=".jsonl,.ndjson,.json,.csv,.tsv,.parquet,.txt" onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = '' }} />
        </div>
        <div className="grid" style={{ gap: 14 }}>
          <div className="card pad">
            <div className="row"><Icon name="hf" /><b>Hugging Face dataset</b></div>
            <form onSubmit={(e) => { e.preventDefault(); void fetchHf() }} className="row" style={{ marginTop: 12 }}>
              <input className="input" placeholder="owner/dataset" value={hf} onChange={(e) => { setHf(e.target.value); setHfInfo(null) }} aria-label="Hugging Face dataset id" />
              <button className="btn secondary" type="submit">Fetch</button>
            </form>
            {hfInfo ? (
              <div className="grid" style={{ gap: 10, marginTop: 12 }}>
                <div className="row wrap-row">
                  <label className="field" style={{ flex: 2, minWidth: 160 }}><span>Config / split</span>
                    <select className="input" value={`${hfPick.config}/${hfPick.split}`} onChange={(e) => { const [config, split] = e.target.value.split('/'); setHfPick((p) => ({ ...p, config, split })) }}>
                      {hfInfo.configs.map((c) => <option key={`${c.config}/${c.split}`} value={`${c.config}/${c.split}`}>{c.config} / {c.split} ({fmtBytes(c.files.reduce((a, f) => a + f.size, 0))})</option>)}
                    </select>
                  </label>
                  <label className="field" style={{ flex: 1, minWidth: 110 }}><span>Max rows</span><input className="input num" type="number" min={10} step={1000} value={hfPick.maxRows} onChange={(e) => setHfPick((p) => ({ ...p, maxRows: Math.max(10, Number(e.target.value) || 0) }))} /></label>
                </div>
                <button className="btn" onClick={peekHf}>Preview &amp; map</button>
              </div>
            ) : (
              <p className="tiny faint" style={{ marginTop: 10 }}>Reads the dataset's parquet export directly from the Hub with range requests. Public datasets only. <button className="btn ghost small" style={{ padding: 0, height: 'auto', textTransform: 'none', letterSpacing: 0, fontFamily: 'var(--font)', fontSize: 12, textDecoration: 'underline' }} onClick={() => void fetchHf(SAMPLE_HF_ID)}>Try {SAMPLE_HF_ID}</button></p>
            )}
          </div>
          <div className="card pad">
            <div className="row"><Icon name="sparkle" /><b>Messy sample</b></div>
            <p className="small muted" style={{ marginTop: 8 }}>1,200 synthetic support chats with planted problems: duplicates, leaked keys, broken turns, refusals, three languages, giant log pastes, invalid bytes.</p>
            <button className="btn secondary" style={{ marginTop: 12 }} onClick={() => void doPeek({ kind: 'sample' }, { kind: 'sample', name: 'support-chats-messy.jsonl', size: 0 })}>Use the sample</button>
          </div>
        </div>
      </div>
      <p className="small faint">Not sure how to export your data? <a href="/docs#export" onClick={(e) => { e.preventDefault(); navigate('/docs#export') }}>The docs show exact SQL and export steps</a>.</p>
    </div>
  )
}

const FIELDS: Record<Format, { key: keyof Mapping; label: string; optional?: boolean }[]> = {
  conversational: [{ key: 'messages', label: 'Messages column', optional: true }, { key: 'system', label: 'System column', optional: true }, { key: 'user', label: 'User column', optional: true }, { key: 'assistant', label: 'Assistant column', optional: true }],
  instruction: [{ key: 'prompt', label: 'Prompt' }, { key: 'input', label: 'Extra input (appended)', optional: true }, { key: 'completion', label: 'Completion' }],
  preference: [{ key: 'prompt', label: 'Prompt / context', optional: true }, { key: 'chosen', label: 'Preferred (chosen)' }, { key: 'rejected', label: 'Non-preferred (rejected)' }],
  text: [{ key: 'text', label: 'Text' }],
}

function MappingStep({ peek, onCancel, onImport }: { peek: { info: SourceInfo; data: Peeked }; onCancel: () => void; onImport: (m: Mapping) => void }) {
  const [m, setM] = useState<Mapping>(peek.data.suggested)
  const cols = peek.data.columns
  const sample = peek.data.sample
  const previews = sample.slice(0, 3).map((r) => { const { rec, label } = applyMapping(r, m); return { rec, label, issues: validateRecord(rec, m.format) } })
  const set = (patch: Partial<Mapping>) => setM((x) => ({ ...x, ...patch }))
  const ok = m.identity || (m.format === 'conversational' ? !!(m.messages || (m.user && m.assistant)) : FIELDS[m.format].every((f) => f.optional || m[f.key]))
  return (
    <div className="grid fade-in" style={{ gap: 18 }}>
      <div className="card pad">
        <div className="row wrap-row">
          <div>
            <div className="label">Preview</div>
            <div style={{ fontWeight: 500, marginTop: 6 }}>{peek.info.name}</div>
            <div className="small muted">{peek.data.kind.toUpperCase()}{peek.info.size ? ` · ${fmtBytes(peek.info.size)}` : ''} · {cols.length} columns · first {sample.length} rows shown{peek.data.parseErrors ? ` · ${peek.data.parseErrors} unparseable lines in the preview` : ''}</div>
          </div>
          <span className="spacer" />
          <button className="btn secondary" onClick={onCancel}>Back</button>
          <button className="btn" disabled={!ok} onClick={() => onImport(m)}>Import &amp; check <Icon name="arrow" size={13} /></button>
        </div>
      </div>

      <div className="card pad">
        <div className="panel-h" style={{ marginTop: 0 }}><h3>Column mapping</h3><span className="spacer" />{peek.data.suggested.identity && <span className="badge ok"><Icon name="check" size={11} /> already in Together's {peek.data.suggested.format} schema</span>}</div>
        <div className="seg" role="group" aria-label="Target format" style={{ flexWrap: 'wrap' }}>
          {(Object.keys(FORMAT_LABEL) as Format[]).map((f) => <button key={f} aria-pressed={m.format === f} onClick={() => set({ format: f, identity: f === peek.data.suggested.format && peek.data.suggested.identity })}>{FORMAT_LABEL[f].split(' (')[0]}</button>)}
        </div>
        <div style={{ marginTop: 16 }}>
          {peek.data.suggested.identity && m.format === peek.data.suggested.format && (
            <label className="switch" style={{ marginBottom: 14 }}>
              <input type="checkbox" checked={m.identity} onChange={(e) => set({ identity: e.target.checked })} />
              Use rows as-is (every key is validated, unknown keys are reported)
            </label>
          )}
          {!m.identity && (
            <div className="map-grid">
              {FIELDS[m.format].map((f) => (
                <label key={f.key} className="field"><span>{f.label}{f.optional ? ' · optional' : ''}</span>
                  <select className="input" value={(m[f.key] as string) ?? ''} onChange={(e) => set({ [f.key]: e.target.value || undefined } as Partial<Mapping>)}>
                    <option value="">{f.optional ? '(none)' : 'Choose a column'}</option>
                    {cols.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </label>
              ))}
            </div>
          )}
          <div className="map-grid" style={{ marginTop: 12 }}>
            {(m.format === 'conversational' || m.format === 'preference') && (
              <label className="field"><span>Fixed system prompt · optional</span><input className="input" placeholder="Added where a row has none" value={m.systemText ?? ''} onChange={(e) => set({ systemText: e.target.value || undefined })} /></label>
            )}
            <label className="field" title="Kept as metadata for the stratified split and balance check; not written to the exported file"><span>Label column · split &amp; balance only</span>
              <select className="input" value={m.label ?? ''} onChange={(e) => set({ label: e.target.value || undefined })}>
                <option value="">(none)</option>
                {cols.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
          </div>
          {m.format === 'conversational' && !m.identity && <p className="tiny faint" style={{ marginTop: 10 }}>Pick a messages column (OpenAI role/content or ShareGPT from/value, JSON strings are fine), or build one turn from user + assistant columns.</p>}
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14 }}>
        {previews.map((p, i) => (
          <div key={i} className="card" style={{ overflow: 'hidden' }}>
            <div className="row" style={{ padding: '10px 14px', borderBottom: '1px solid var(--line)' }}>
              <span className="label">Row {i + 1} → Together JSONL</span><span className="spacer" />
              {p.issues.length ? <span className={`badge ${p.issues.some((x) => x.sev === 'error') ? 'err' : 'warn'}`}>{p.issues.length} issue{p.issues.length > 1 ? 's' : ''}</span> : <span className="badge ok">valid</span>}
            </div>
            <pre className="code" style={{ borderRadius: 0, maxHeight: 220, whiteSpace: 'pre-wrap', wordBreak: 'break-word', border: 0 }}>{JSON.stringify(p.rec, null, 1).slice(0, 1200)}</pre>
            {p.issues.length > 0 && <div style={{ padding: '8px 14px' }} className="tiny muted">{p.issues.slice(0, 3).map((x, j) => <div key={j}>· {x.msg}</div>)}</div>}
          </div>
        ))}
      </div>

      <div>
        <div className="label" style={{ marginBottom: 8 }}>Source columns</div>
        <div className="preview-cols">
          <table className="t">
            <thead><tr><th>#</th>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
            <tbody>{sample.slice(0, 8).map((r, i) => <tr key={i}><td className="faint">{i + 1}</td>{cols.map((c) => <td key={c} title={typeof r[c] === 'string' ? (r[c] as string).slice(0, 400) : ''}>{typeof r[c] === 'string' ? (r[c] as string) : JSON.stringify(r[c])}</td>)}</tr>)}</tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
