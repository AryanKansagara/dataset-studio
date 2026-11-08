/** Token counting with the target model's tokenizer + chat template, truncation
 * stats, smart truncation, and pre-tokenized (Parquet) encoding with loss masks. */
import type { Format } from './mapping.ts'
import { isObj, quantile } from './util.ts'

export interface TokenizerLike {
  ids(text: string): number[]
  /** Render a conversation with the model's chat template. null = model has no template. */
  render: ((messages: unknown[], opts?: { tools?: unknown; addGenerationPrompt?: boolean }) => string) | null
  eos?: string
}

const contentText = (c: unknown) => typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (isObj(p) && typeof p.text === 'string' ? p.text : '')).join('') : ''

/** Plain role-tagged fallback when a model has no chat template (base models). */
export function plainRender(messages: unknown[]): string {
  return messages.map((m) => (isObj(m) ? `${m.role}: ${contentText(m.content)}` : '')).join('\n') + '\n'
}

export function renderConversation(tk: TokenizerLike, messages: unknown[], tools?: unknown, addGenerationPrompt = false): string {
  if (tk.render) {
    try { return tk.render(messages, { tools, addGenerationPrompt }) } catch { /* template rejected the shape; fall back */ }
  }
  return plainRender(messages) + (addGenerationPrompt ? 'assistant: ' : '')
}

/** Rendered text(s) whose token count is checked against the limit. Preference rows have two sides. */
export function renderRecord(rec: Record<string, unknown>, fmt: Format, tk: TokenizerLike): string[] {
  switch (fmt) {
    case 'conversational': return [renderConversation(tk, Array.isArray(rec.messages) ? rec.messages : [], rec.tools)]
    case 'instruction': return [`${rec.prompt ?? ''}${rec.completion ?? ''}${tk.eos ?? ''}`]
    case 'preference': {
      const input = isObj(rec.input) && Array.isArray(rec.input.messages) ? rec.input.messages : []
      const tools = isObj(rec.input) ? rec.input.tools : undefined
      const a = Array.isArray(rec.preferred_output) ? rec.preferred_output : []
      const b = Array.isArray(rec.non_preferred_output) ? rec.non_preferred_output : []
      return [renderConversation(tk, [...input, ...a], tools), renderConversation(tk, [...input, ...b], tools)]
    }
    default: return [`${rec.text ?? ''}${tk.eos ?? ''}`]
  }
}

/** Tokens for one record: per side counts (1 side except preference). */
export function countRecord(rec: Record<string, unknown>, fmt: Format, tk: TokenizerLike): number[] {
  return renderRecord(rec, fmt, tk).map((s) => tk.ids(s).length)
}

// ---------- histogram on a log2 axis ----------

export const HIST_EDGES: number[] = Array.from({ length: 33 }, (_, i) => Math.round(2 ** (3 + i / 2))) // 8 .. 524288

export function histogram(values: ArrayLike<number>): number[] {
  const counts = new Array(HIST_EDGES.length - 1).fill(0)
  for (let i = 0; i < values.length; i++) {
    const v = Math.max(values[i], 1)
    let b = Math.floor((Math.log2(v) - 3) * 2)
    if (b < 0) b = 0
    if (b > counts.length - 1) b = counts.length - 1
    counts[b]++
  }
  return counts
}

export interface TokenStats {
  n: number
  total: number
  /** billable tokens after truncation (each example counts at most `limit`) */
  billable: number
  p50: number
  p95: number
  max: number
  mean: number
  limit: number
  over: number
  cut: number
  hist: number[]
}

export function tokenStats(perRow: number[], limit: number): TokenStats {
  const sorted = Float64Array.from(perRow).sort()
  let total = 0, over = 0, cut = 0, billable = 0
  for (const v of perRow) {
    total += v
    billable += Math.min(v, limit)
    if (v > limit) { over++; cut += v - limit }
  }
  return {
    n: perRow.length, total, billable, limit, over, cut,
    p50: Math.round(quantile(sorted, 0.5)), p95: Math.round(quantile(sorted, 0.95)), max: sorted.length ? sorted[sorted.length - 1] : 0,
    mean: perRow.length ? total / perRow.length : 0, hist: histogram(perRow),
  }
}

// ---------- smart truncation ----------

/** Make a record fit `limit` tokens without cutting mid-turn where possible.
 * conversational: drop the oldest user/assistant exchanges (system prompt kept).
 * instruction: keep the end of the prompt (closest to the answer), completion intact.
 * text: keep the head. preference: drop oldest exchanges from the shared input.
 * Returns null if it cannot fit (e.g. the final answer alone is too long). */
export function smartTruncate(rec: Record<string, unknown>, fmt: Format, tk: TokenizerLike, limit: number): Record<string, unknown> | null {
  const fits = (r: Record<string, unknown>) => Math.max(...countRecord(r, fmt, tk)) <= limit
  if (fits(rec)) return rec
  if (fmt === 'conversational' || fmt === 'preference') {
    let msgs = (fmt === 'conversational' ? rec.messages : isObj(rec.input) ? rec.input.messages : []) as unknown[]
    if (!Array.isArray(msgs)) return null
    const make = (m: unknown[]) => fmt === 'conversational' ? { ...rec, messages: m } : { ...rec, input: { ...(rec.input as object), messages: m } }
    const sys = isObj(msgs[0]) && msgs[0].role === 'system' ? 1 : 0
    for (;;) {
      // remove the first exchange: everything up to and including the first assistant after the system prompt
      const rest = msgs.slice(sys)
      const firstA = rest.findIndex((m) => isObj(m) && m.role === 'assistant')
      const remaining = firstA >= 0 ? rest.slice(firstA + 1) : []
      const stillTrains = fmt === 'preference' ? remaining.some((m) => isObj(m) && m.role === 'user') : remaining.some((m) => isObj(m) && m.role === 'assistant')
      if (firstA < 0 || !stillTrains) return null
      msgs = [...msgs.slice(0, sys), ...remaining]
      const next = make(msgs)
      if (fits(next)) return next
    }
  }
  const key = fmt === 'instruction' ? 'prompt' : 'text'
  const s = String(rec[key] ?? '')
  // binary search the largest slice that fits
  let lo = 0, hi = s.length, best = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const cand = fmt === 'instruction' ? s.slice(s.length - mid) : s.slice(0, mid)
    if (fits({ ...rec, [key]: cand })) { best = mid; lo = mid + 1 } else hi = mid - 1
  }
  if (best <= 0) return null
  return { ...rec, [key]: fmt === 'instruction' ? s.slice(s.length - best) : s.slice(0, best) }
}

// ---------- pre-tokenized parquet rows ----------

export interface Tokenized { input_ids: number[]; labels: number[] }

/** Encode one record to input_ids + labels (-100 = masked from the loss), mirroring
 * train_on_inputs=false: only assistant turns / the completion are trained. */
export function tokenizeRecord(rec: Record<string, unknown>, fmt: Format, tk: TokenizerLike, trainOnInputs: boolean, limit: number): Tokenized {
  const segs: { text: string; train: boolean }[] = []
  if (fmt === 'conversational') {
    const msgs = (Array.isArray(rec.messages) ? rec.messages : []) as unknown[]
    const full = renderConversation(tk, msgs, rec.tools)
    let pos = 0
    msgs.forEach((m, i) => {
      if (!isObj(m) || m.role !== 'assistant') return
      const prefix = renderConversation(tk, msgs.slice(0, i), rec.tools, true)
      const endStr = renderConversation(tk, msgs.slice(0, i + 1), rec.tools)
      const start = prefix.length
      // spans are only trustworthy when the template renders prefixes as prefixes
      if (!full.startsWith(prefix) || !full.startsWith(endStr) || start < pos || start > endStr.length) return
      if (start > pos) segs.push({ text: full.slice(pos, start), train: false })
      segs.push({ text: full.slice(start, endStr.length), train: true })
      pos = endStr.length
    })
    if (pos < full.length) segs.push({ text: full.slice(pos), train: false })
    if (!segs.some((s) => s.train)) { segs.length = 0; segs.push({ text: full, train: true }) }
  } else if (fmt === 'instruction') {
    segs.push({ text: String(rec.prompt ?? ''), train: false }, { text: String(rec.completion ?? '') + (tk.eos ?? ''), train: true })
  } else {
    segs.push({ text: String(rec.text ?? '') + (tk.eos ?? ''), train: true })
  }
  const input_ids: number[] = []
  const labels: number[] = []
  for (const s of segs) {
    if (!s.text) continue
    const ids = tk.ids(s.text)
    for (const id of ids) { input_ids.push(id); labels.push(s.train || trainOnInputs ? id : -100) }
  }
  return { input_ids: input_ids.slice(0, limit), labels: labels.slice(0, limit) }
}
