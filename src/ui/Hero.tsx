/** Landing hero: sample rows flow through the real validators. Problem rows light up and get
 * fixed or dropped; the token histogram fills in against the max-sequence-length line.
 * Everything below is computed by the same engine the studio uses. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { messySupportSample } from '../engine/sample.ts'
import { rowsFromBytes } from '../engine/ingest.ts'
import { repairRecord, stripUnknown, type Row } from '../engine/pipeline.ts'
import { validateRecord, hasError, ISSUE_INFO } from '../engine/validate.ts'
import { answerText, detectLanguage, exactKey, findPii, isRefusal, minhash, shingles, sigSimilarity, dedupeText, promptText, LANG_NAME } from '../engine/quality.ts'
import { countRecord, histogram, smartTruncate, type TokenizerLike } from '../engine/tokens.ts'
import { getModel } from '../engine/rules.ts'
import { Histogram, fmtTokens } from './common.tsx'

const STAGES = ['Parse', 'Schema', 'Quality', 'PII', 'Tokens']
const LIMIT = 2048
const MODEL = 'Qwen/Qwen3.5-9B'
const LANES = 5

interface HeroRow {
  line: number
  text: string
  issueStage: number
  label: string
  outcome: 'ok' | 'fixed' | 'dropped'
  fixLabel: string
  rec: Record<string, unknown> | null
  tokens: number
}

const SHORT: Partial<Record<string, string>> = { E_ROLE_ORDER: 'bad role order', E_EMPTY_TURN: 'empty turn', W_FINAL_NOT_ASSISTANT: 'no final answer', E_ROLE: 'unknown role', W_UNKNOWN_KEY: 'unknown key', W_WHITESPACE: 'padded turn', E_NO_ASSISTANT: 'no assistant turn', E_SCHEMA: 'schema error' }

const estimateTk: TokenizerLike = { ids: (t) => new Array(Math.ceil(t.length / 3.6)).fill(0), render: null }

function classify(all: Row[]): HeroRow[] {
  const fmt = 'conversational' as const
  const seen = new Map<number, number>()
  const sigs: { sig: Uint32Array; line: number }[] = []
  const out: HeroRow[] = []
  for (const r of all) {
    const user = r.rec ? promptText(r.rec, fmt) : r.raw ?? ''
    const base: HeroRow = { line: r.line, text: user.replace(/\s+/g, ' ').slice(0, 70) || '(empty)', issueStage: -1, label: 'ok', outcome: 'ok', fixLabel: '', rec: null, tokens: 0 }
    if (r.parseError || r.badUtf8 || !r.rec) { out.push({ ...base, issueStage: 0, label: r.badUtf8 ? 'non-UTF-8 bytes' : 'invalid JSON', outcome: 'dropped', fixLabel: 'dropped' }); continue }
    // undocumented metadata keys are stripped here; the studio reports them as warnings
    const rec = stripUnknown(r.rec, fmt)
    const k = exactKey(rec, fmt)
    const sig = minhash(shingles(dedupeText(rec, fmt)))
    const dupOf = seen.get(k)
    const near = dupOf === undefined ? sigs.find((s) => sigSimilarity(s.sig, sig) >= 0.8) : undefined
    if (dupOf === undefined) seen.set(k, r.line)
    sigs.push({ sig, line: r.line })
    const issues = validateRecord(rec, fmt)
    if (issues.length) {
      const first = issues.find((i) => i.sev === 'error') ?? issues[0]
      const repaired = repairRecord(rec, fmt)
      const ok = !hasError(validateRecord(repaired, fmt))
      out.push({ ...base, issueStage: 1, label: SHORT[first.code] ?? ISSUE_INFO[first.code].title.toLowerCase(), outcome: ok ? 'fixed' : 'dropped', fixLabel: ok ? 'repaired' : 'dropped', rec: ok ? repaired : null })
      continue
    }
    const ans = answerText(rec, fmt)
    const lang = detectLanguage(ans + ' ' + user)
    const pii = findPii(user + ' ' + ans)
    let h: Partial<HeroRow> = {}
    if (dupOf !== undefined) h = { issueStage: 2, label: `duplicate of L${dupOf}`, outcome: 'dropped', fixLabel: 'deduped' }
    else if (near) h = { issueStage: 2, label: `near-dup of L${near.line}`, outcome: 'dropped', fixLabel: 'deduped' }
    else if (isRefusal(ans)) h = { issueStage: 2, label: 'boilerplate refusal', outcome: 'dropped', fixLabel: 'dropped' }
    else if (lang !== 'en' && lang !== 'und') h = { issueStage: 2, label: `language: ${LANG_NAME[lang] ?? lang}`, outcome: 'dropped', fixLabel: 'filtered' }
    else if (pii.length) h = { issueStage: 3, label: `${pii[0].kind === 'secret' ? 'API key' : pii[0].kind} found`, outcome: 'fixed', fixLabel: 'redacted' }
    out.push({ ...base, ...h, rec: h.outcome === 'dropped' ? null : rec })
  }
  return out
}

/** Pick a lively, deterministic subset: every problem kind, interleaved with clean rows. */
function curate(rows: HeroRow[], n = 34): HeroRow[] {
  const problems = rows.filter((r) => r.issueStage >= 0)
  const isLong = (r: HeroRow) => !!r.rec && JSON.stringify(r.rec).length > 20000
  const clean = rows.filter((r) => r.issueStage < 0 && !isLong(r))
  const long = rows.filter((r) => r.issueStage < 0 && isLong(r))
  const byLabel = new Map<string, HeroRow[]>()
  for (const p of problems) { const k = p.label.replace(/ of L\d+$/, '').replace(/^language: .*/, 'lang'); const g = byLabel.get(k) ?? []; g.push(p); byLabel.set(k, g) }
  const picked: HeroRow[] = long.slice(0, 1)
  for (let round = 0; picked.length < n * 0.55 && round < 4; round++) for (const g of byLabel.values()) if (g[round]) picked.push(g[round])
  const out: HeroRow[] = []
  let ci = 0
  picked.forEach((p) => { out.push(p); if (clean[ci]) out.push(clean[ci++]) })
  return out.slice(0, n)
}

export function Hero() {
  const [rows, setRows] = useState<HeroRow[] | null>(null)
  const [tk, setTk] = useState<{ tk: TokenizerLike; exact: boolean }>({ tk: estimateTk, exact: false })
  const [tick, setTick] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const visible = useRef(true)
  const reduce = useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.classList.contains('reduce-motion'), [])

  useEffect(() => {
    let alive = true
    const s = messySupportSample(420, 5)
    void rowsFromBytes('jsonl', s.bytes).then(({ rows }) => { if (alive) setRows(curate(classify(rows))) })
    // fetch the real tokenizer after first paint (cached for the studio afterwards)
    const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection
    const t = setTimeout(() => {
      if (conn?.saveData) return
      void import('../lib/tokenizer.ts').then((m) => m.loadTokenizer(MODEL)).then((real) => { if (alive) setTk({ tk: real, exact: true }) }).catch(() => {})
    }, 1200)
    return () => { alive = false; clearTimeout(t) }
  }, [])

  useEffect(() => {
    const el = root.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => { visible.current = e.isIntersecting }, { threshold: 0.1 })
    io.observe(el)
    if (reduce) { setTick(26); return () => io.disconnect() }
    const id = setInterval(() => { if (visible.current && !document.hidden) setTick((t) => t + 1) }, 720)
    return () => { clearInterval(id); io.disconnect() }
  }, [reduce])

  // token counts with whichever tokenizer is ready (estimate first, then the real one)
  const counted = useMemo(() => rows?.map((r) => {
    if (!r.rec) return r
    const n = Math.max(...countRecord(r.rec, 'conversational', tk.tk))
    if (n <= LIMIT || r.outcome === 'dropped') return { ...r, tokens: n }
    const t = smartTruncate(r.rec, 'conversational', tk.tk, LIMIT)
    return { ...r, tokens: n, issueStage: r.issueStage < 0 ? 4 : r.issueStage, label: r.issueStage < 0 ? `${fmtTokens(n)} tok > max` : r.label, outcome: t ? (r.issueStage < 0 ? 'fixed' : r.outcome) : 'dropped', fixLabel: r.issueStage < 0 ? (t ? 'truncated' : 'dropped') : r.fixLabel } as HeroRow
  }) ?? null, [rows, tk])

  const N = counted?.length ?? 0
  const cycle = N + STAGES.length + 2
  const local = N ? tick % cycle : 0
  const live = counted ? counted.map((r, i) => ({ r, i, s: local - i })).filter((x) => x.s >= 0 && x.s <= STAGES.length) : []
  const done = counted ? counted.slice(0, Math.max(0, Math.min(N, local - STAGES.length + 1))) : []
  const reached = counted ? counted.slice(0, Math.max(0, Math.min(N, local - 3))).filter((r) => r.tokens > 0) : []
  const hist = histogram(reached.map((r) => r.tokens))
  const issues = done.filter((r) => r.issueStage >= 0)
  const hitStages = new Set(live.filter((x) => x.r.issueStage === x.s).map((x) => x.s))
  const model = getModel(MODEL)

  return (
    <div className="pipe" ref={root} aria-label="Live demo: sample rows flowing through Dataset Studio's validators">
      <div className="pipe-inner">
        <div className="pipe-head">
          <span className="lights"><i /><i /><i /></span>
          <span className="file">support-chats-messy.jsonl</span>
          <span className="spacer" />
          <span>{model.name} · {tk.exact ? 'real tokenizer' : 'estimating tokens…'}</span>
        </div>
        <div className="stages" aria-hidden="true">
          {STAGES.map((s, i) => <div key={s} className={hitStages.has(i) ? 'hit' : ''}>{s}</div>)}
        </div>
        <div className="track" aria-hidden="true">
          {!counted && <div className="skeleton" style={{ position: 'absolute', inset: 16 }} />}
          {live.map(({ r, i, s }) => {
            const atIssue = r.issueStage === s
            const past = r.issueStage >= 0 && s > r.issueStage
            const stopped = r.outcome === 'dropped' && past
            const x = Math.min(stopped ? r.issueStage : s, STAGES.length - 1)
            const cls = atIssue ? 'issue' : past ? (r.outcome === 'dropped' ? 'dropping dropped' : 'fixed') : ''
            const exiting = s >= STAGES.length
            return (
              <div key={`${i}-${Math.floor(tick / cycle)}`} className={`chip ${cls}`} style={{ transform: `translate(${x * 100}%, ${8 + (i % LANES) * 45 + (stopped ? 14 : 0)}px) translateX(${x * 12}px)`, opacity: exiting ? 0 : undefined }}>
                <div className="l1"><span>L{r.line}</span><span>{atIssue ? r.label : past ? r.fixLabel : s === 4 && r.tokens ? `${fmtTokens(r.tokens)} tok` : 'ok'}</span></div>
                <div className="l2">{r.text}</div>
              </div>
            )
          })}
        </div>
        <div className="pipe-bottom">
          <div>
            <div className="row" style={{ marginBottom: 4 }}>
              <span className="label">Tokens per example · log scale</span>
            </div>
            <Histogram counts={hist} limit={LIMIT} height={150} width={400} />
          </div>
          <div className="counters" aria-live="off">
            <div><b>{done.length}</b><span>rows checked</span></div>
            <div><b style={{ color: issues.length ? 'var(--warn)' : undefined }}>{issues.length}</b><span>problems</span></div>
            <div><b style={{ color: 'var(--ok)' }}>{issues.filter((r) => r.outcome === 'fixed').length}</b><span>fixed</span></div>
            <div><b>{issues.filter((r) => r.outcome === 'dropped').length}</b><span>dropped</span></div>
            <div style={{ gridColumn: 'span 2' }}><b>{fmtTokens(reached.reduce((a, r) => a + Math.min(r.tokens, LIMIT), 0))}</b><span>training tokens after fixes</span></div>
          </div>
        </div>
      </div>
    </div>
  )
}
