/** Per-record validation against Together's fine-tuning schema. */
import { LIMITS } from './rules.ts'
import { recordFormat, type Format } from './mapping.ts'
import { isObj } from './util.ts'

export type Severity = 'error' | 'warn'

export interface Issue {
  code: IssueCode
  sev: Severity
  msg: string
  path?: string
}

export type IssueCode =
  | 'E_JSON' | 'E_NOT_OBJECT' | 'E_UTF8' | 'E_OVERSIZE'
  | 'E_SCHEMA' | 'E_MIXED_FORMAT' | 'E_ROLE' | 'E_ROLE_ORDER' | 'E_EMPTY_TURN'
  | 'E_NO_ASSISTANT' | 'W_FINAL_NOT_ASSISTANT' | 'W_UNKNOWN_KEY' | 'E_WEIGHT' | 'E_DPO_OUTPUT'
  | 'W_WHITESPACE'

export const ISSUE_INFO: Record<IssueCode, { title: string; fix: string }> = {
  E_JSON: { title: 'Line is not valid JSON', fix: 'Drop the line, or fix the quoting at the source.' },
  E_NOT_OBJECT: { title: 'Line is JSON but not an object', fix: 'Every line must be a single {...} object.' },
  E_UTF8: { title: 'Invalid UTF-8 bytes', fix: 'Together requires UTF-8. Re-export as UTF-8 or drop the line.' },
  E_OVERSIZE: { title: 'Line cannot fit in max sequence length', fix: 'Truncate smartly or drop.' },
  E_SCHEMA: { title: 'Schema error', fix: 'Field missing or of the wrong type.' },
  E_MIXED_FORMAT: { title: 'Mixed dataset formats', fix: 'A file must use one format. The server rejects files that mix them.' },
  E_ROLE: { title: 'Unknown message role', fix: 'Roles are system, user, assistant and tool.' },
  E_ROLE_ORDER: { title: 'Role order breaks alternation', fix: 'Start with system or user, then alternate user and assistant.' },
  E_EMPTY_TURN: { title: 'Empty or whitespace-only turn', fix: 'Remove the turn or drop the example.' },
  E_NO_ASSISTANT: { title: 'No assistant turn to learn from', fix: 'Nothing in this example contributes to the loss.' },
  W_FINAL_NOT_ASSISTANT: { title: 'Conversation does not end with an assistant turn', fix: 'Trailing user turns are trained on nothing. Trim them.' },
  W_UNKNOWN_KEY: { title: 'Unknown key', fix: 'Not part of the documented schema. Strip it before upload.' },
  E_WEIGHT: { title: 'Invalid weight', fix: 'Message weight must be 0 or 1; sample weight must be a non-negative number.' },
  E_DPO_OUTPUT: { title: 'Preference output is malformed', fix: 'Each output needs exactly one assistant message.' },
  W_WHITESPACE: { title: 'Leading or trailing whitespace in a turn', fix: 'Trim it; whitespace becomes trained tokens.' },
}

const ROLES = new Set<string>(LIMITS.roles)
const MSG_KEYS = new Set<string>(LIMITS.messageKeys)

function textOf(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    // multimodal content parts: only the text parts count as text
    return content.map((p) => (isObj(p) && typeof p.text === 'string' ? p.text : '')).join('')
  }
  return null
}

function checkMessages(msgs: unknown, path: string, out: Issue[], opts: { requireFinalAssistant: boolean; allowLeadingAssistant?: boolean }) {
  if (!Array.isArray(msgs)) { out.push({ code: 'E_SCHEMA', sev: 'error', msg: `${path} must be a list of messages`, path }); return }
  if (msgs.length === 0) { out.push({ code: 'E_SCHEMA', sev: 'error', msg: `${path} is empty`, path }); return }
  let prev = ''
  let assistants = 0
  msgs.forEach((m, i) => {
    const p = `${path}[${i}]`
    if (!isObj(m)) { out.push({ code: 'E_SCHEMA', sev: 'error', msg: `${p} must be an object`, path: p }); return }
    const role = m.role
    if (typeof role !== 'string') { out.push({ code: 'E_SCHEMA', sev: 'error', msg: `${p} is missing "role"`, path: p }); return }
    if (!ROLES.has(role)) out.push({ code: 'E_ROLE', sev: 'error', msg: `${p}.role "${role}" is not one of system, user, assistant, tool`, path: p })
    for (const k of Object.keys(m)) if (!MSG_KEYS.has(k)) out.push({ code: 'W_UNKNOWN_KEY', sev: 'warn', msg: `${p} has unknown key "${k}"`, path: `${p}.${k}` })
    const hasTools = role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0
    const text = textOf(m.content)
    if (text === null && !hasTools) {
      if (m.content === undefined || m.content === null) out.push({ code: 'E_SCHEMA', sev: 'error', msg: `${p} is missing "content"`, path: p })
      else out.push({ code: 'E_SCHEMA', sev: 'error', msg: `${p}.content must be a string`, path: p })
    } else if (text !== null && !hasTools) {
      if (text.trim() === '') out.push({ code: 'E_EMPTY_TURN', sev: 'error', msg: `${p} (${role}) is ${text.length ? 'whitespace only' : 'empty'}`, path: p })
      else if (text !== text.trim() && /^\s{2,}|\s{2,}$/.test(text)) out.push({ code: 'W_WHITESPACE', sev: 'warn', msg: `${p} (${role}) has leading/trailing whitespace`, path: p })
    }
    if ('weight' in m && m.weight !== 0 && m.weight !== 1) out.push({ code: 'E_WEIGHT', sev: 'error', msg: `${p}.weight must be 0 or 1`, path: p })
    // ordering
    if (i === 0) {
      if (role !== 'system' && role !== 'user' && !(opts.allowLeadingAssistant && role === 'assistant'))
        out.push({ code: 'E_ROLE_ORDER', sev: 'error', msg: `Conversation starts with "${role}"; it must start with system or user`, path: p })
    } else if (role === 'system') {
      out.push({ code: 'E_ROLE_ORDER', sev: 'error', msg: `${p}: system message after the start`, path: p })
    } else if (role === 'user' && prev === 'user') {
      out.push({ code: 'E_ROLE_ORDER', sev: 'error', msg: `${p}: two user turns in a row`, path: p })
    } else if (role === 'assistant' && (prev === 'assistant' || prev === 'system')) {
      out.push({ code: 'E_ROLE_ORDER', sev: 'error', msg: `${p}: assistant follows ${prev}`, path: p })
    } else if (role === 'tool' && prev !== 'assistant' && prev !== 'tool') {
      out.push({ code: 'E_ROLE_ORDER', sev: 'error', msg: `${p}: tool result without a preceding assistant tool call`, path: p })
    }
    if (role === 'assistant') assistants++
    prev = role
  })
  if (opts.requireFinalAssistant) {
    if (assistants === 0) out.push({ code: 'E_NO_ASSISTANT', sev: 'error', msg: 'No assistant message: nothing to train on', path })
    else if (prev !== 'assistant') out.push({ code: 'W_FINAL_NOT_ASSISTANT', sev: 'warn', msg: `Last message is "${prev}", not assistant`, path })
  }
}

function checkUnknownRoot(rec: Record<string, unknown>, fmt: Format, out: Issue[]) {
  const allowed = new Set<string>(LIMITS.rootKeys[fmt])
  for (const k of Object.keys(rec)) if (!allowed.has(k)) out.push({ code: 'W_UNKNOWN_KEY', sev: 'warn', msg: `Unknown top-level key "${k}"`, path: k })
  if ('weight' in rec && (typeof rec.weight !== 'number' || !(rec.weight >= 0))) out.push({ code: 'E_WEIGHT', sev: 'error', msg: 'Sample weight must be a non-negative number', path: 'weight' })
}

/** Validate one record against the dataset's chosen format. */
export function validateRecord(rec: Record<string, unknown>, fmt: Format): Issue[] {
  const out: Issue[] = []
  const own = recordFormat(rec)
  if (own && own !== fmt) {
    out.push({ code: 'E_MIXED_FORMAT', sev: 'error', msg: `Row is ${own} but the file is ${fmt}` })
    return out
  }
  switch (fmt) {
    case 'conversational':
      checkUnknownRoot(rec, fmt, out)
      if (!('messages' in rec)) out.push({ code: 'E_SCHEMA', sev: 'error', msg: 'Missing "messages"', path: 'messages' })
      else checkMessages(rec.messages, 'messages', out, { requireFinalAssistant: true })
      if ('tools' in rec && !Array.isArray(rec.tools)) out.push({ code: 'E_SCHEMA', sev: 'error', msg: '"tools" must be a list', path: 'tools' })
      break
    case 'instruction':
      checkUnknownRoot(rec, fmt, out)
      for (const k of ['prompt', 'completion'] as const) {
        const v = rec[k]
        if (typeof v !== 'string') out.push({ code: 'E_SCHEMA', sev: 'error', msg: `"${k}" must be a string`, path: k })
        else if (!v.trim()) out.push({ code: 'E_EMPTY_TURN', sev: 'error', msg: `"${k}" is ${v.length ? 'whitespace only' : 'empty'}`, path: k })
      }
      break
    case 'text':
      checkUnknownRoot(rec, fmt, out)
      if (typeof rec.text !== 'string') out.push({ code: 'E_SCHEMA', sev: 'error', msg: '"text" must be a string', path: 'text' })
      else if (!rec.text.trim()) out.push({ code: 'E_EMPTY_TURN', sev: 'error', msg: '"text" is empty', path: 'text' })
      break
    case 'preference': {
      checkUnknownRoot(rec, fmt, out)
      const input = rec.input
      if (!isObj(input)) out.push({ code: 'E_SCHEMA', sev: 'error', msg: '"input" must be an object with "messages"', path: 'input' })
      else {
        for (const k of Object.keys(input)) if (k !== 'messages' && k !== 'tools') out.push({ code: 'W_UNKNOWN_KEY', sev: 'warn', msg: `Unknown key "input.${k}"`, path: `input.${k}` })
        checkMessages(input.messages, 'input.messages', out, { requireFinalAssistant: false })
        const msgs = input.messages
        if (Array.isArray(msgs) && msgs.length && isObj(msgs[msgs.length - 1]) && msgs[msgs.length - 1].role !== 'user')
          out.push({ code: 'E_ROLE_ORDER', sev: 'error', msg: 'input.messages should end with a user turn', path: 'input.messages' })
      }
      for (const k of ['preferred_output', 'non_preferred_output'] as const) {
        const v = rec[k]
        if (!Array.isArray(v) || v.length !== 1 || !isObj(v[0]) || v[0].role !== 'assistant') {
          out.push({ code: 'E_DPO_OUTPUT', sev: 'error', msg: `"${k}" must be a list with exactly one assistant message`, path: k })
        } else {
          const t = textOf(v[0].content)
          if (t === null || !t.trim()) out.push({ code: 'E_EMPTY_TURN', sev: 'error', msg: `"${k}" assistant message is empty`, path: k })
        }
      }
      const a = JSON.stringify(rec.preferred_output)
      if (a && a === JSON.stringify(rec.non_preferred_output)) out.push({ code: 'E_DPO_OUTPUT', sev: 'error', msg: 'Preferred and non-preferred outputs are identical', path: 'preferred_output' })
      break
    }
  }
  return out
}

/** The majority format among records (ignoring rows that match none). */
export function majorityFormat(recs: Iterable<Record<string, unknown>>): Format | null {
  const counts = new Map<Format, number>()
  for (const r of recs) { const f = recordFormat(r); if (f) counts.set(f, (counts.get(f) ?? 0) + 1) }
  let best: Format | null = null
  let n = 0
  for (const [f, c] of counts) if (c > n) { best = f; n = c }
  return best
}

export const hasError = (issues: Issue[]) => issues.some((i) => i.sev === 'error')
