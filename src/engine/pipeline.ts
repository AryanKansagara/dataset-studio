/** Rows, fix operations (the undo-able pipeline), train/validation split and the full analysis report. */
import type { Format } from './mapping.ts'
import { validateRecord, hasError, type Issue, type IssueCode, ISSUE_INFO } from './validate.ts'
import {
  answerText, dedupeText, detectLanguage, exactKey, findPii, fullText, isRefusal, labelStats, mapText, minhash,
  nearDuplicateClusters, normalize, outlierBounds, promptText, redact, shingles, type LabelStats, type PiiKind,
} from './quality.ts'
import { countRecord, smartTruncate, tokenStats, type TokenizerLike, type TokenStats } from './tokens.ts'
import { LIMITS } from './rules.ts'
import { hash53, isObj, keyedUnit } from './util.ts'

export interface Row {
  id: number
  line: number
  bytes: number
  rec: Record<string, unknown> | null
  label?: string
  parseError?: 'E_JSON' | 'E_NOT_OBJECT'
  badUtf8?: boolean
  raw?: string
}

export type Op =
  | { type: 'dropInvalid' }
  | { type: 'repairStructure' }
  | { type: 'stripUnknownKeys' }
  | { type: 'dedupeExact' }
  | { type: 'dedupeNear'; threshold: number }
  | { type: 'redactPii'; kinds: PiiKind[] }
  | { type: 'dropRefusals' }
  | { type: 'filterLanguage'; keep: string[] }
  | { type: 'dropOutliers' }
  | { type: 'truncate'; limit: number }
  | { type: 'rebalance'; maxRatio: number }
  | { type: 'dropLeakage' }
  | { type: 'dropRows'; ids: number[]; reason: string }

export const OP_LABEL: Record<Op['type'], string> = {
  dropInvalid: 'Drop rows that still fail validation',
  repairStructure: 'Repair turn structure',
  stripUnknownKeys: 'Strip unknown keys',
  dedupeExact: 'Remove exact duplicates',
  dedupeNear: 'Remove near-duplicates',
  redactPii: 'Redact PII and secrets',
  dropRefusals: 'Drop boilerplate refusals',
  filterLanguage: 'Keep selected languages',
  dropOutliers: 'Drop answer-length outliers',
  truncate: 'Truncate to max sequence length',
  rebalance: 'Downsample majority labels',
  dropLeakage: 'Drop validation rows leaked from train',
  dropRows: 'Drop selected rows',
}

export function describeOp(op: Op): string {
  switch (op.type) {
    case 'dedupeNear': return `${OP_LABEL[op.type]} (similarity ≥ ${op.threshold})`
    case 'redactPii': return `${OP_LABEL[op.type]} (${op.kinds.join(', ')})`
    case 'filterLanguage': return `${OP_LABEL[op.type]} (${op.keep.join(', ')})`
    case 'truncate': return `${OP_LABEL[op.type]} (${op.limit.toLocaleString()} tokens)`
    case 'rebalance': return `${OP_LABEL[op.type]} (max ${op.maxRatio}:1)`
    case 'dropRows': return `Drop ${op.ids.length} row${op.ids.length === 1 ? '' : 's'}: ${op.reason}`
    default: return OP_LABEL[op.type]
  }
}

export interface SplitSettings { valFraction: number; seed: number; stratify: boolean }

export interface LogEntry { op: Op; label: string; dropped: number; modified: number; droppedLines: number[] }

export interface PipelineCtx {
  format: Format
  split: SplitSettings
  tokenizer?: TokenizerLike | null
  /** cached per-record token counter (max side) */
  tokens?: (rec: Record<string, unknown>) => number
}

// ---------- validation ----------

const ISSUE_CACHE = new WeakMap<object, Issue[]>()

export function rowIssues(row: Row, fmt: Format, limit?: number): Issue[] {
  const out: Issue[] = []
  if (row.parseError) out.push({ code: row.parseError, sev: 'error', msg: ISSUE_INFO[row.parseError].title })
  if (row.badUtf8) out.push({ code: 'E_UTF8', sev: 'error', msg: 'Line contains bytes that are not valid UTF-8' })
  if (limit && row.bytes > limit * LIMITS.oversizeBytesPerToken)
    out.push({ code: 'E_OVERSIZE', sev: 'error', msg: `${(row.bytes / 1024).toFixed(0)} KB line cannot fit ${limit.toLocaleString()} tokens` })
  if (row.rec) {
    let v = ISSUE_CACHE.get(row.rec)
    if (!v) { v = validateRecord(row.rec, fmt); ISSUE_CACHE.set(row.rec, v) }
    out.push(...v)
  }
  return out
}

// ---------- structural repair ----------

/** Fix what can be fixed mechanically: trim whitespace, drop empty turns, merge consecutive
 * same-role turns, drop leading assistant turns, trim trailing non-assistant turns. */
export function repairRecord(rec: Record<string, unknown>, fmt: Format): Record<string, unknown> {
  const trim = mapText(rec, fmt, (s) => s.trim())
  if (fmt !== 'conversational' || !Array.isArray(trim.messages)) return trim
  const out: Record<string, unknown>[] = []
  for (const m of trim.messages) {
    if (!isObj(m)) continue
    const hasTools = Array.isArray(m.tool_calls) && m.tool_calls.length > 0
    if (typeof m.content === 'string' && !m.content && !hasTools) continue
    const prev = out[out.length - 1]
    if (prev && prev.role === m.role && (m.role === 'user' || m.role === 'assistant') && typeof prev.content === 'string' && typeof m.content === 'string' && !hasTools) {
      out[out.length - 1] = { ...prev, content: `${prev.content}\n\n${m.content}` }
      continue
    }
    if (m.role === 'system' && out.length > 0) continue
    out.push(m)
  }
  const sys = out[0]?.role === 'system' ? 1 : 0
  while (out.length > sys && out[sys].role === 'assistant') out.splice(sys, 1)
  while (out.length && out[out.length - 1].role !== 'assistant' && out.some((m) => m.role === 'assistant')) out.pop()
  return { ...trim, messages: out }
}

export function stripUnknown(rec: Record<string, unknown>, fmt: Format): Record<string, unknown> {
  const allowed = new Set<string>(LIMITS.rootKeys[fmt])
  const msgKeys = new Set<string>(LIMITS.messageKeys)
  const cleanMsgs = (v: unknown) => Array.isArray(v) ? v.map((m) => isObj(m) ? Object.fromEntries(Object.entries(m).filter(([k]) => msgKeys.has(k))) : m) : v
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(rec)) if (allowed.has(k)) out[k] = v
  if (fmt === 'conversational') out.messages = cleanMsgs(out.messages)
  if (fmt === 'preference') {
    if (isObj(out.input)) out.input = { messages: cleanMsgs(out.input.messages), ...(out.input.tools ? { tools: out.input.tools } : {}) }
    out.preferred_output = cleanMsgs(out.preferred_output)
    out.non_preferred_output = cleanMsgs(out.non_preferred_output)
  }
  return out
}

// ---------- split ----------

/** Seeded, stratified (by label when present) split. Returns ids of validation rows. */
export function splitRows(rows: Row[], s: SplitSettings): Set<number> {
  const val = new Set<number>()
  if (s.valFraction <= 0 || rows.length < 2) return val
  const groups = new Map<string, Row[]>()
  const strat = s.stratify && rows.some((r) => r.label !== undefined)
  for (const r of rows) {
    const k = strat ? r.label ?? '' : ''
    const g = groups.get(k)
    if (g) g.push(r)
    else groups.set(k, [r])
  }
  for (const g of groups.values()) {
    const sorted = g.map((r) => [keyedUnit(s.seed, r.id), r.id] as const).sort((a, b) => a[0] - b[0])
    const n = Math.round(g.length * s.valFraction)
    for (let i = 0; i < n; i++) val.add(sorted[i][1])
  }
  return val
}

// ---------- dedupe / leakage helpers ----------

function nearClusters(rows: Row[], fmt: Format, threshold: number): Int32Array {
  const sigs = rows.map((r) => minhash(shingles(r.rec ? dedupeText(r.rec, fmt) : '')))
  return nearDuplicateClusters(sigs, threshold)
}

/** Validation rows whose prompt or full text also appears (exactly or nearly) in train. */
export function findLeaks(rows: Row[], val: Set<number>, fmt: Format, threshold = 0.8): Set<number> {
  const trainKeys = new Set<number>()
  for (const r of rows) if (r.rec && !val.has(r.id)) { trainKeys.add(exactKey(r.rec, fmt)); const p = normalize(promptText(r.rec, fmt)); if (p.length > 20) trainKeys.add(hash53(p)) }
  const leaks = new Set<number>()
  for (const r of rows) {
    if (!r.rec || !val.has(r.id)) continue
    const p = normalize(promptText(r.rec, fmt))
    if (trainKeys.has(exactKey(r.rec, fmt)) || (p.length > 20 && trainKeys.has(hash53(p)))) leaks.add(r.id)
  }
  const withRec = rows.filter((r) => r.rec)
  const cl = nearClusters(withRec, fmt, threshold)
  const clusterHasTrain = new Set<number>()
  withRec.forEach((r, i) => { if (cl[i] >= 0 && !val.has(r.id)) clusterHasTrain.add(cl[i]) })
  withRec.forEach((r, i) => { if (cl[i] >= 0 && val.has(r.id) && clusterHasTrain.has(cl[i])) leaks.add(r.id) })
  return leaks
}

// ---------- applying ops ----------

export interface PipelineResult {
  rows: Row[]
  log: LogEntry[]
  /** id -> reason, for every row removed by the pipeline */
  dropped: Map<number, string>
  val: Set<number>
}

export function answerLength(r: Row, fmt: Format): number {
  return r.rec ? answerText(r.rec, fmt).length : 0
}

export function applyOps(base: Row[], ops: Op[], ctx: PipelineCtx): PipelineResult {
  let rows = base
  const log: LogEntry[] = []
  const dropped = new Map<number, string>()
  let pinnedVal: Set<number> | null = null
  const fmt = ctx.format
  for (const op of ops) {
    const reason = describeOp(op)
    let modified = 0
    const before = rows
    const keep = (pred: (r: Row, i: number) => boolean) => { rows = rows.filter(pred) }
    const modify = (f: (rec: Record<string, unknown>) => Record<string, unknown> | null) => {
      const out: Row[] = []
      for (const r of rows) {
        if (!r.rec) { out.push(r); continue }
        const next = f(r.rec)
        if (next === null) continue
        if (next !== r.rec && JSON.stringify(next) !== JSON.stringify(r.rec)) { modified++; out.push({ ...r, rec: next, bytes: JSON.stringify(next).length + 1 }) }
        else out.push(r)
      }
      rows = out
    }
    switch (op.type) {
      case 'dropInvalid': keep((r) => !hasError(rowIssues(r, fmt))); break
      case 'repairStructure': modify((rec) => repairRecord(rec, fmt)); break
      case 'stripUnknownKeys': modify((rec) => stripUnknown(rec, fmt)); break
      case 'dedupeExact': {
        const seen = new Set<number>()
        keep((r) => { if (!r.rec) return true; const k = exactKey(r.rec, fmt); if (seen.has(k)) return false; seen.add(k); return true })
        break
      }
      case 'dedupeNear': {
        const idx = rows.map((r, i) => (r.rec ? i : -1)).filter((i) => i >= 0)
        const cl = nearClusters(idx.map((i) => rows[i]), fmt, op.threshold)
        const seen = new Set<number>()
        const drop = new Set<number>()
        idx.forEach((ri, j) => { const c = cl[j]; if (c < 0) return; if (seen.has(c)) drop.add(ri); else seen.add(c) })
        keep((_, i) => !drop.has(i))
        break
      }
      case 'redactPii': { const kinds = new Set(op.kinds); modify((rec) => mapText(rec, fmt, (s) => redact(s, kinds).text)); break }
      case 'dropRefusals': keep((r) => !r.rec || !isRefusal(answerText(r.rec, fmt))); break
      case 'filterLanguage': { const k = new Set(op.keep); keep((r) => !r.rec || k.has(detectLanguage(fullText(r.rec, fmt)))); break }
      case 'dropOutliers': {
        const b = outlierBounds(rows.map((r) => answerLength(r, fmt)))
        keep((r) => { if (!r.rec) return true; const n = answerLength(r, fmt); return n === 0 || (n >= b.lo && n <= b.hi) })
        break
      }
      case 'truncate': {
        const tk = ctx.tokenizer
        if (!tk) break
        modify((rec) => (ctx.tokens && ctx.tokens(rec) <= op.limit ? rec : smartTruncate(rec, fmt, tk, op.limit)))
        break
      }
      case 'rebalance': {
        const ls = labelStats(rows.map((r) => r.label), rows.map((r) => (r.rec ? answerText(r.rec, fmt) : '')))
        if (ls.labels.length < 2) break
        const cap = Math.max(1, Math.ceil(ls.labels[ls.labels.length - 1][1] * op.maxRatio))
        const labelOf = (r: Row) => ls.source === 'column' ? r.label ?? '(none)' : (r.rec ? answerText(r.rec, fmt).trim().toLowerCase() : '')
        const groups = new Map<string, Row[]>()
        for (const r of rows) { const l = labelOf(r); const g = groups.get(l); if (g) g.push(r); else groups.set(l, [r]) }
        const keepIds = new Set<number>()
        for (const g of groups.values()) {
          g.map((r) => [keyedUnit(ctx.split.seed + 7, r.id), r.id] as const).sort((a, b) => a[0] - b[0]).slice(0, cap).forEach(([, id]) => keepIds.add(id))
        }
        keep((r) => keepIds.has(r.id))
        break
      }
      case 'dropLeakage': {
        const val = splitRows(rows, ctx.split)
        const leaks = findLeaks(rows, val, fmt)
        keep((r) => !leaks.has(r.id))
        for (const id of leaks) val.delete(id)
        pinnedVal = val
        break
      }
      case 'dropRows': { const ids = new Set(op.ids); keep((r) => !ids.has(r.id)); break }
    }
    const after = new Set(rows.map((r) => r.id))
    const droppedLines: number[] = []
    let nDropped = 0
    for (const r of before) if (!after.has(r.id)) { nDropped++; if (!dropped.has(r.id)) dropped.set(r.id, reason); if (droppedLines.length < 200) droppedLines.push(r.line) }
    log.push({ op, label: reason, dropped: nDropped, modified, droppedLines })
  }
  let val: Set<number>
  if (pinnedVal) { const live = new Set(rows.map((r) => r.id)); val = new Set([...pinnedVal].filter((id) => live.has(id))) }
  else val = splitRows(rows, ctx.split)
  return { rows, log, dropped, val }
}

// ---------- analysis report ----------

export interface IssueRow { id: number; line: number; code: IssueCode; sev: 'error' | 'warn'; msg: string }

export interface Example { id: number; line: number; text: string; extra?: string }

export interface Report {
  format: Format
  baseRows: number
  rows: number
  train: number
  val: number
  stratified: boolean
  issues: { byCode: Partial<Record<IssueCode, number>>; rowsWithErrors: number; rowsWithWarnings: number; list: IssueRow[]; truncatedList: boolean }
  quality: {
    exactDup: { rows: number; groups: number; examples: Example[] }
    nearDup: { rows: number; clusters: number; examples: Example[] }
    pii: { rows: number; byKind: Partial<Record<PiiKind, number>>; examples: Example[] }
    refusals: { rows: number; examples: Example[] }
    language: { dist: [string, number][]; majority: string; minorityRows: number; examples: Example[] }
    outliers: { lo: number; hi: number; median: number; low: number; high: number; examples: Example[] }
    labels: LabelStats & { valDist: [string, number][] }
    leakage: { rows: number; examples: Example[] }
  }
  tokens: (TokenStats & { exact: boolean; sampled: number; train: number; val: number; perSide: boolean; longest: Example[] }) | null
  sampleIds: number[]
  log: LogEntry[]
  dropped: { reason: string; count: number; lines: number[] }[]
}

const snippet = (s: string, n = 140) => (s.length > n ? s.slice(0, n - 1) + '…' : s).replace(/\s+/g, ' ')

export interface AnalyzeOptions {
  limit: number
  /** count tokens for at most this many rows (uniform sample), 0 = all */
  tokenSample?: number
  nearThreshold?: number
  issueListCap?: number
}

/** Run the pipeline and every check. Pure: the worker and the landing hero both call this. */
export function analyze(base: Row[], ops: Op[], ctx: PipelineCtx, opt: AnalyzeOptions): { report: Report; result: PipelineResult } {
  const fmt = ctx.format
  const result = applyOps(base, ops, ctx)
  const { rows, val } = result
  const cap = opt.issueListCap ?? 5000

  // validation
  const byCode: Partial<Record<IssueCode, number>> = {}
  const list: IssueRow[] = []
  let rowsWithErrors = 0, rowsWithWarnings = 0, truncatedList = false
  for (const r of rows) {
    const issues = rowIssues(r, fmt, opt.limit)
    if (!issues.length) continue
    if (issues.some((i) => i.sev === 'error')) rowsWithErrors++
    else rowsWithWarnings++
    const seenCode = new Set<IssueCode>()
    for (const i of issues) {
      if (!seenCode.has(i.code)) { byCode[i.code] = (byCode[i.code] ?? 0) + 1; seenCode.add(i.code) }
      if (list.length < cap) list.push({ id: r.id, line: r.line, code: i.code, sev: i.sev, msg: i.msg })
      else truncatedList = true
    }
  }

  const live = rows.filter((r) => r.rec) as (Row & { rec: Record<string, unknown> })[]

  // exact duplicates
  const firstByKey = new Map<number, Row>()
  const exactEx: Example[] = []
  let exactRows = 0
  const groupKeys = new Set<number>()
  for (const r of live) {
    const k = exactKey(r.rec, fmt)
    const f = firstByKey.get(k)
    if (f) { exactRows++; groupKeys.add(k); if (exactEx.length < 30) exactEx.push({ id: r.id, line: r.line, text: snippet(answerText(r.rec, fmt) || fullText(r.rec, fmt)), extra: `same as line ${f.line}` }) }
    else firstByKey.set(k, r)
  }

  // near duplicates (excluding exact copies)
  const uniq = [...firstByKey.values()]
  const cl = nearClusters(uniq, fmt, opt.nearThreshold ?? 0.8)
  const firstInCluster = new Map<number, Row>()
  const nearEx: Example[] = []
  let nearRows = 0
  uniq.forEach((r, i) => {
    const c = cl[i]
    if (c < 0) return
    const f = firstInCluster.get(c)
    if (!f) { firstInCluster.set(c, r); return }
    nearRows++
    if (nearEx.length < 30 && r.rec) nearEx.push({ id: r.id, line: r.line, text: snippet(promptText(r.rec, fmt) || fullText(r.rec, fmt)), extra: `near line ${f.line}` })
  })

  // pii, refusals, language, answer lengths
  const piiBy: Partial<Record<PiiKind, number>> = {}
  const piiEx: Example[] = []
  let piiRows = 0
  const refEx: Example[] = []
  let refRows = 0
  const langCount = new Map<string, number>()
  const langOf = new Map<number, string>()
  for (const r of live) {
    const text = fullText(r.rec, fmt)
    const hits = findPii(text)
    if (hits.length) {
      piiRows++
      const kinds = new Set(hits.map((h) => h.kind))
      for (const k of kinds) piiBy[k] = (piiBy[k] ?? 0) + 1
      if (piiEx.length < 30) piiEx.push({ id: r.id, line: r.line, text: hits.map((h) => h.text.length > 12 ? h.text.slice(0, 6) + '…' + h.text.slice(-3) : h.text).join(', '), extra: [...kinds].join(', ') })
    }
    const ans = answerText(r.rec, fmt)
    if (fmt !== 'text' && isRefusal(ans)) { refRows++; if (refEx.length < 30) refEx.push({ id: r.id, line: r.line, text: snippet(ans) }) }
    const lang = detectLanguage(text)
    langOf.set(r.id, lang)
    langCount.set(lang, (langCount.get(lang) ?? 0) + 1)
  }
  const dist = [...langCount].sort((a, b) => b[1] - a[1])
  const majority = dist.find(([l]) => l !== 'und')?.[0] ?? 'und'
  const langEx: Example[] = []
  let minorityRows = 0
  for (const r of live) {
    const l = langOf.get(r.id)!
    if (l !== majority && l !== 'und') { minorityRows++; if (langEx.length < 30) langEx.push({ id: r.id, line: r.line, text: snippet(answerText(r.rec, fmt) || fullText(r.rec, fmt)), extra: l }) }
  }
  const lens = live.map((r) => answerLength(r, fmt))
  const ob = outlierBounds(lens)
  const outEx: Example[] = []
  let low = 0, high = 0
  live.forEach((r, i) => {
    const n = lens[i]
    if (n === 0) return
    if (n < ob.lo) low++
    else if (n > ob.hi) high++
    else return
    if (outEx.length < 30) outEx.push({ id: r.id, line: r.line, text: snippet(answerText(r.rec, fmt)), extra: `${n.toLocaleString()} chars` })
  })

  // labels
  const ls = labelStats(rows.map((r) => r.label), rows.map((r) => (r.rec ? answerText(r.rec, fmt) : '')))
  const valLabels = new Map<string, number>()
  if (ls.source !== 'none') for (const r of rows) if (val.has(r.id)) {
    const l = ls.source === 'column' ? r.label ?? '(none)' : (r.rec ? answerText(r.rec, fmt).trim().toLowerCase() : '')
    valLabels.set(l, (valLabels.get(l) ?? 0) + 1)
  }

  // leakage
  const leaks = findLeaks(rows, val, fmt, opt.nearThreshold ?? 0.8)
  const leakEx: Example[] = []
  for (const r of rows) if (leaks.has(r.id) && r.rec && leakEx.length < 30) leakEx.push({ id: r.id, line: r.line, text: snippet(promptText(r.rec, fmt)) })

  // tokens
  let tokens: Report['tokens'] = null
  if (ctx.tokens) {
    const sampleN = opt.tokenSample && live.length > opt.tokenSample ? opt.tokenSample : 0
    const pool = sampleN ? live.filter((r) => keyedUnit(99, r.id) < sampleN / live.length) : live
    const counts = pool.map((r) => ctx.tokens!(r.rec))
    const st = tokenStats(counts, opt.limit)
    const scale = sampleN ? live.length / Math.max(pool.length, 1) : 1
    let trainT = 0, valT = 0
    pool.forEach((r, i) => { const c = Math.min(counts[i], opt.limit) * (fmt === 'preference' ? 2 : 1); if (val.has(r.id)) valT += c; else trainT += c })
    const longest = pool.map((r, i) => [counts[i], r] as const).sort((a, b) => b[0] - a[0]).slice(0, 12)
      .map(([n, r]) => ({ id: r.id, line: r.line, text: snippet(promptText(r.rec, fmt) || fullText(r.rec, fmt)), extra: `${n.toLocaleString()} tokens` }))
    tokens = {
      ...st, exact: !sampleN, longest, sampled: pool.length, perSide: fmt === 'preference',
      total: Math.round(st.total * scale), billable: Math.round(st.billable * scale), over: Math.round(st.over * scale), cut: Math.round(st.cut * scale),
      train: Math.round(trainT * scale), val: Math.round(valT * scale),
    }
  }

  const dropAgg = new Map<string, { count: number; lines: number[] }>()
  const lineOf = new Map(base.map((r) => [r.id, r.line]))
  for (const [id, reason] of result.dropped) {
    const a = dropAgg.get(reason) ?? { count: 0, lines: [] }
    a.count++
    if (a.lines.length < 100) a.lines.push(lineOf.get(id) ?? 0)
    dropAgg.set(reason, a)
  }

  const report: Report = {
    format: fmt, baseRows: base.length, rows: rows.length, train: rows.length - val.size, val: val.size,
    stratified: ctx.split.stratify && rows.some((r) => r.label !== undefined),
    issues: { byCode, rowsWithErrors, rowsWithWarnings, list, truncatedList },
    quality: {
      exactDup: { rows: exactRows, groups: groupKeys.size, examples: exactEx },
      nearDup: { rows: nearRows, clusters: firstInCluster.size, examples: nearEx },
      pii: { rows: piiRows, byKind: piiBy, examples: piiEx },
      refusals: { rows: refRows, examples: refEx },
      language: { dist, majority, minorityRows, examples: langEx },
      outliers: { ...ob, low, high, examples: outEx },
      labels: { ...ls, valDist: [...valLabels].sort((a, b) => b[1] - a[1]) },
      leakage: { rows: leaks.size, examples: leakEx },
    },
    tokens,
    sampleIds: live.slice(0, 50).map((r) => r.id),
    log: result.log,
    dropped: [...dropAgg].map(([reason, a]) => ({ reason, ...a })).sort((a, b) => b.count - a.count),
  }
  return { report, result }
}

/** Token counter with a per-record cache (records are immutable, so a WeakMap is safe). */
export function cachedCounter(fmt: Format, tk: TokenizerLike): (rec: Record<string, unknown>) => number {
  const cache = new WeakMap<object, number>()
  return (rec) => {
    let n = cache.get(rec)
    if (n === undefined) { n = Math.max(...countRecord(rec, fmt, tk)); cache.set(rec, n) }
    return n
  }
}
