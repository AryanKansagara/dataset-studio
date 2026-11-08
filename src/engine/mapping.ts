/** Column mapping: turn arbitrary rows into one of Together's four JSONL formats. */
import { isObj } from './util.ts'

export type Format = 'conversational' | 'instruction' | 'preference' | 'text'

export const FORMAT_LABEL: Record<Format, string> = {
  conversational: 'Conversational (messages)',
  instruction: 'Instruction (prompt / completion)',
  preference: 'Preference / DPO',
  text: 'Generic text',
}

export interface Mapping {
  format: Format
  /** Rows already use Together's schema: pass them through untouched so every key gets validated. */
  identity: boolean
  /** conversational: a column holding a list of messages (OpenAI or ShareGPT style). */
  messages?: string
  /** conversational from flat columns */
  system?: string
  user?: string
  assistant?: string
  /** fixed system prompt added to every conversation that has none */
  systemText?: string
  /** instruction */
  prompt?: string
  input?: string
  completion?: string
  /** preference */
  chosen?: string
  rejected?: string
  /** generic text */
  text?: string
  /** optional label / category column for stratified splits and imbalance checks */
  label?: string
}

/** Which Together format a single record looks like (by its keys). */
export function recordFormat(rec: Record<string, unknown>): Format | null {
  if ('messages' in rec) return 'conversational'
  if ('preferred_output' in rec || 'non_preferred_output' in rec) return 'preference'
  if ('prompt' in rec && 'completion' in rec) return 'instruction'
  if ('text' in rec) return 'text'
  return null
}

const NAME_HINTS: Record<string, string[]> = {
  messages: ['messages', 'conversations', 'conversation', 'chat', 'dialog', 'dialogue', 'turns'],
  system: ['system', 'system_prompt', 'instructions'],
  user: ['question', 'user', 'query', 'customer', 'customer_message', 'human', 'request', 'input_text'],
  assistant: ['answer', 'assistant', 'agent', 'agent_reply', 'reply', 'response', 'gpt', 'bot'],
  prompt: ['prompt', 'instruction', 'question', 'query', 'source'],
  input: ['input', 'context'],
  completion: ['completion', 'output', 'response', 'answer', 'target', 'summary'],
  chosen: ['chosen', 'preferred', 'preferred_output', 'better', 'response_a'],
  rejected: ['rejected', 'non_preferred', 'non_preferred_output', 'worse', 'response_b'],
  text: ['text', 'content', 'document', 'body'],
  label: ['label', 'category', 'class', 'intent', 'topic', 'tag'],
}

function pick(cols: string[], key: string, taken: Set<string>): string | undefined {
  const lower = cols.map((c) => c.toLowerCase())
  // exact names first, then names that contain a hint as a word (customer_question, agentAnswer)
  for (const hint of NAME_HINTS[key]) {
    const i = lower.indexOf(hint)
    if (i >= 0 && !taken.has(cols[i])) { taken.add(cols[i]); return cols[i] }
  }
  const words = cols.map((c) => c.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/))
  for (const hint of NAME_HINTS[key]) {
    const i = words.findIndex((w, j) => w.includes(hint) && !taken.has(cols[j]))
    if (i >= 0) { taken.add(cols[i]); return cols[i] }
  }
  return undefined
}

function looksLikeMessages(v: unknown): boolean {
  let x = v
  if (typeof x === 'string' && x.trimStart().startsWith('[')) { try { x = JSON.parse(x) } catch { return false } }
  return Array.isArray(x) && x.length > 0 && x.every((m) => isObj(m) && (('role' in m && 'content' in m) || ('from' in m && 'value' in m)))
}

/** Suggest a mapping from column names and a few sample rows. */
export function suggestMapping(columns: string[], sample: Record<string, unknown>[]): Mapping {
  const first = sample.find(isObj) ?? {}
  const fmt = recordFormat(first)
  const taken = new Set<string>()
  const label = () => {
    const l = pick(columns, 'label', new Set(taken))
    return l && !['messages', 'prompt', 'completion', 'text'].includes(l) ? l : undefined
  }
  if (fmt && (fmt !== 'conversational' || looksLikeMessages(first.messages)) && (fmt !== 'text' || typeof first.text === 'string')) {
    return { format: fmt, identity: true, label: label() }
  }
  const msgCol = columns.find((c) => sample.some((r) => looksLikeMessages(r[c])))
  if (msgCol) { taken.add(msgCol); return { format: 'conversational', identity: false, messages: msgCol, system: pick(columns, 'system', taken), label: label() } }
  const chosen = pick(columns, 'chosen', taken)
  const rejected = pick(columns, 'rejected', taken)
  if (chosen && rejected) return { format: 'preference', identity: false, chosen, rejected, prompt: pick(columns, 'prompt', taken), label: label() }
  const completion = pick(columns, 'completion', new Set(taken))
  const promptCol = pick(columns, 'prompt', new Set(taken))
  if (promptCol && completion && promptCol !== completion) {
    taken.add(promptCol); taken.add(completion)
    const input = pick(columns, 'input', taken)
    // instruction/input/output (Alpaca) style -> instruction; question/answer -> chat
    if (['instruction', 'prompt'].includes(promptCol.toLowerCase()) || input)
      return { format: 'instruction', identity: false, prompt: promptCol, input, completion, label: label() }
    return { format: 'conversational', identity: false, user: promptCol, assistant: completion, system: pick(columns, 'system', taken), label: label() }
  }
  const user = pick(columns, 'user', taken)
  const assistant = pick(columns, 'assistant', taken)
  if (user && assistant) return { format: 'conversational', identity: false, user, assistant, system: pick(columns, 'system', taken), label: label() }
  const avgLen = (c: string) => sample.reduce((a, r) => a + (typeof r[c] === 'string' ? (r[c] as string).length : 0), 0)
  const text = pick(columns, 'text', taken) ?? [...columns].sort((a, b) => avgLen(b) - avgLen(a))[0]
  return { format: 'text', identity: false, text, label: label() }
}

function parseMaybeJson(v: unknown): unknown {
  if (typeof v === 'string') {
    const t = v.trimStart()
    if (t.startsWith('[') || t.startsWith('{')) { try { return JSON.parse(v) } catch { /* keep as string */ } }
  }
  return v
}

const SHAREGPT_ROLES: Record<string, string> = { human: 'user', user: 'user', gpt: 'assistant', assistant: 'assistant', bot: 'assistant', model: 'assistant', system: 'system', tool: 'tool', function_response: 'tool' }

/** Normalise a messages value (OpenAI or ShareGPT style, possibly JSON-encoded). Unknown shapes are kept so validation can report them. */
export function toMessages(v: unknown): unknown {
  const x = parseMaybeJson(v)
  if (!Array.isArray(x)) return x
  return x.map((m) => {
    if (isObj(m) && !('role' in m) && 'from' in m) {
      const { from, value, ...rest } = m
      return { role: SHAREGPT_ROLES[String(from).toLowerCase()] ?? String(from), content: value, ...rest }
    }
    return m
  })
}

const str = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v))

function outputMessages(v: unknown): unknown {
  const x = parseMaybeJson(v)
  if (Array.isArray(x)) {
    const msgs = toMessages(x) as unknown[]
    // chosen/rejected given as whole conversations: keep only the final assistant turn
    const last = msgs[msgs.length - 1]
    return isObj(last) ? [last] : msgs
  }
  if (isObj(x) && 'role' in x) return [x]
  return [{ role: 'assistant', content: str(x) }]
}

export interface Mapped { rec: Record<string, unknown>; label?: string }

/** Apply a mapping to one source row. */
export function applyMapping(row: Record<string, unknown>, m: Mapping): Mapped {
  const label = m.label && row[m.label] !== undefined && row[m.label] !== null ? str(row[m.label]) : undefined
  if (m.identity) {
    let rec = m.format === 'conversational' && 'messages' in row ? { ...row, messages: toMessages(row.messages) } : row
    // the label column is metadata for splitting/balance, not part of the training record
    if (m.label && m.label in rec) { rec = { ...rec }; delete rec[m.label] }
    if (m.systemText && m.format === 'conversational') return { rec: withSystem(rec, m.systemText), label }
    return { rec, label }
  }
  let rec: Record<string, unknown>
  switch (m.format) {
    case 'conversational': {
      if (m.messages) {
        rec = { messages: toMessages(row[m.messages]) }
        if (m.system && row[m.system]) rec = withSystem(rec, str(row[m.system]))
      } else {
        const msgs: unknown[] = []
        if (m.system && str(row[m.system]).trim()) msgs.push({ role: 'system', content: str(row[m.system]) })
        msgs.push({ role: 'user', content: str(m.user ? row[m.user] : '') })
        msgs.push({ role: 'assistant', content: str(m.assistant ? row[m.assistant] : '') })
        rec = { messages: msgs }
      }
      if (m.systemText) rec = withSystem(rec, m.systemText)
      break
    }
    case 'instruction': {
      const p = str(m.prompt ? row[m.prompt] : '')
      const inp = m.input ? str(row[m.input]) : ''
      rec = { prompt: inp.trim() ? `${p}\n\n${inp}` : p, completion: str(m.completion ? row[m.completion] : '') }
      break
    }
    case 'preference': {
      const pv = m.prompt ? parseMaybeJson(row[m.prompt]) : ''
      let messages = Array.isArray(pv) ? (toMessages(pv) as unknown[]) : [{ role: 'user', content: str(pv) }]
      // chosen/rejected given as full conversations: the shared prefix is the input
      const ch = parseMaybeJson(m.chosen ? row[m.chosen] : '')
      if (!m.prompt && Array.isArray(ch)) messages = (toMessages(ch) as unknown[]).slice(0, -1)
      if (m.systemText && !(isObj(messages[0]) && messages[0].role === 'system')) messages = [{ role: 'system', content: m.systemText }, ...messages]
      rec = { input: { messages }, preferred_output: outputMessages(ch), non_preferred_output: outputMessages(m.rejected ? row[m.rejected] : '') }
      break
    }
    default:
      rec = { text: str(m.text ? row[m.text] : '') }
  }
  return { rec, label }
}

function withSystem(rec: Record<string, unknown>, system: string): Record<string, unknown> {
  const msgs = rec.messages
  if (!Array.isArray(msgs)) return rec
  if (isObj(msgs[0]) && msgs[0].role === 'system') return rec
  return { ...rec, messages: [{ role: 'system', content: system }, ...msgs] }
}

/** Columns seen across sample rows, in first-seen order. */
export function columnsOf(rows: Record<string, unknown>[]): string[] {
  const seen = new Set<string>()
  for (const r of rows) for (const k of Object.keys(r)) seen.add(k)
  return [...seen]
}
