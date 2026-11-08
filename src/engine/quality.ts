/** Quality checks: duplicates (exact + MinHash near-duplicates), PII and secrets,
 * boilerplate refusals, language mix, answer length outliers, label imbalance. */
import type { Format } from './mapping.ts'
import { fnv32, hash53, isObj, quantile } from './util.ts'

// ---------- text extraction ----------

function contentText(c: unknown): string {
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map((p) => (isObj(p) && typeof p.text === 'string' ? p.text : '')).join('')
  return ''
}

const msgsOf = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isObj) : [])

/** All trainable-or-not text in a record, used for dedupe and PII scans. */
export function fullText(rec: Record<string, unknown>, fmt: Format): string {
  switch (fmt) {
    case 'conversational': return msgsOf(rec.messages).map((m) => `${m.role}: ${contentText(m.content)}`).join('\n')
    case 'instruction': return `${rec.prompt ?? ''}\n${rec.completion ?? ''}`
    case 'preference': {
      const input = isObj(rec.input) ? msgsOf(rec.input.messages) : []
      return [...input, ...msgsOf(rec.preferred_output), ...msgsOf(rec.non_preferred_output)].map((m) => contentText(m.content)).join('\n')
    }
    default: return String(rec.text ?? '')
  }
}

/** Text used for near-duplicate detection: everything except a shared system prompt. */
export function dedupeText(rec: Record<string, unknown>, fmt: Format): string {
  if (fmt === 'conversational') return msgsOf(rec.messages).filter((m) => m.role !== 'system').map((m) => contentText(m.content)).join('\n')
  return fullText(rec, fmt)
}

/** Text that identifies the *input* side, for leakage checks (same prompt in train and validation). */
export function promptText(rec: Record<string, unknown>, fmt: Format): string {
  switch (fmt) {
    case 'conversational': {
      const msgs = msgsOf(rec.messages)
      return msgs.filter((m) => m.role === 'user').map((m) => contentText(m.content)).join('\n')
    }
    case 'instruction': return String(rec.prompt ?? '')
    case 'preference': return isObj(rec.input) ? msgsOf(rec.input.messages).map((m) => contentText(m.content)).join('\n') : ''
    default: return String(rec.text ?? '')
  }
}

/** The target the model learns to produce (final assistant turn / completion). */
export function answerText(rec: Record<string, unknown>, fmt: Format): string {
  switch (fmt) {
    case 'conversational': {
      const msgs = msgsOf(rec.messages).filter((m) => m.role === 'assistant')
      return msgs.length ? contentText(msgs[msgs.length - 1].content) : ''
    }
    case 'instruction': return String(rec.completion ?? '')
    case 'preference': return contentText(msgsOf(rec.preferred_output)[0]?.content)
    default: return String(rec.text ?? '')
  }
}

export const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

export const exactKey = (rec: Record<string, unknown>, fmt: Format) => hash53(normalize(fullText(rec, fmt)))

// ---------- MinHash near duplicates ----------

export const MINHASH_PERMS = 64
const BANDS = 16
const ROWS_PER_BAND = MINHASH_PERMS / BANDS
const SEEDS_A = new Uint32Array(MINHASH_PERMS)
const SEEDS_B = new Uint32Array(MINHASH_PERMS)
{
  let s = 0x9e3779b9
  for (let i = 0; i < MINHASH_PERMS; i++) {
    s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) >>> 0; SEEDS_A[i] = s | 1
    s = Math.imul(s ^ (s >>> 12), 0x297a2d39) >>> 0; SEEDS_B[i] = s
  }
}

/** Shingles: word 3-grams, or character 5-grams for short / unspaced (CJK) text. */
export function shingles(text: string): Set<number> {
  const t = normalize(text.replace(/[^\p{L}\p{N}\s]+/gu, ' '))
  const out = new Set<number>()
  const words = t.split(' ').filter(Boolean)
  if (words.length >= 8) {
    for (let i = 0; i + 3 <= words.length; i++) out.add(fnv32(words[i] + ' ' + words[i + 1] + ' ' + words[i + 2]))
  } else {
    for (let i = 0; i + 5 <= t.length; i++) out.add(fnv32(t.slice(i, i + 5)))
    if (!out.size && t) out.add(fnv32(t))
  }
  return out
}

export function minhash(sh: Set<number>): Uint32Array {
  const sig = new Uint32Array(MINHASH_PERMS).fill(0xffffffff)
  for (const x of sh) {
    for (let i = 0; i < MINHASH_PERMS; i++) {
      let h = Math.imul(x ^ SEEDS_B[i], SEEDS_A[i])
      h ^= h >>> 16
      h = h >>> 0
      if (h < sig[i]) sig[i] = h
    }
  }
  return sig
}

export function sigSimilarity(a: Uint32Array, b: Uint32Array): number {
  let eq = 0
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) eq++
  return eq / a.length
}

export function jaccard(a: Set<number>, b: Set<number>): number {
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter || 1)
}

/** Union-find clusters of near-duplicates via LSH banding. Returns cluster id per index (-1 = singleton). */
export function nearDuplicateClusters(sigs: Uint32Array[], threshold: number): Int32Array {
  const n = sigs.length
  const parent = new Int32Array(n).map((_, i) => i)
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x] } return x }
  for (let b = 0; b < BANDS; b++) {
    const buckets = new Map<string, number>()
    for (let i = 0; i < n; i++) {
      const s = sigs[i]
      let key = ''
      for (let r = 0; r < ROWS_PER_BAND; r++) key += s[b * ROWS_PER_BAND + r].toString(36) + '.'
      const j = buckets.get(key)
      if (j === undefined) buckets.set(key, i)
      else if (find(i) !== find(j) && sigSimilarity(s, sigs[j]) >= threshold) parent[find(i)] = find(j)
    }
  }
  const size = new Map<number, number>()
  for (let i = 0; i < n; i++) { const r = find(i); size.set(r, (size.get(r) ?? 0) + 1) }
  const out = new Int32Array(n)
  for (let i = 0; i < n; i++) { const r = find(i); out[i] = (size.get(r) ?? 0) > 1 ? r : -1 }
  return out
}

// ---------- PII and secrets ----------

export type PiiKind = 'email' | 'phone' | 'card' | 'secret' | 'ip'

export const PII_LABEL: Record<PiiKind, string> = { email: 'Email address', phone: 'Phone number', card: 'Card number', secret: 'API key / secret', ip: 'IP address' }

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-(?:proj-|ant-[a-z0-9]+-)?[A-Za-z0-9_-]{20,}/g,      // OpenAI / Anthropic style
  /\bAKIA[0-9A-Z]{16}\b/g,                                  // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,                         // GitHub tokens
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,                       // Slack
  /\bhf_[A-Za-z0-9]{30,}\b/g,                                // Hugging Face
  /\bAIza[0-9A-Za-z_-]{35}\b/g,                              // Google API key
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,        // Stripe
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
  /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/g,
  /\b(?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*["']?[A-Za-z0-9_\-/+=]{12,}["']?/gi,
]
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g
const PHONE = /(?<![\w.]|\d[\s.-])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?|\d{2,4}[\s.-])\d{3,4}[\s.-]\d{3,4}(?!\w|[\s.-]\d)/g
const CARD = /\b(?:\d[ -]?){13,19}\b/g
const IPV4 = /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g

function luhn(digits: string): boolean {
  let sum = 0
  let alt = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48
    if (alt) { d *= 2; if (d > 9) d -= 9 }
    sum += d
    alt = !alt
  }
  return sum % 10 === 0
}

export interface PiiHit { kind: PiiKind; start: number; end: number; text: string }

export function findPii(text: string): PiiHit[] {
  const hits: PiiHit[] = []
  const add = (kind: PiiKind, re: RegExp, ok: (s: string) => boolean = () => true) => {
    re.lastIndex = 0
    for (let m; (m = re.exec(text)); ) if (ok(m[0])) hits.push({ kind, start: m.index, end: m.index + m[0].length, text: m[0] })
  }
  for (const re of SECRET_PATTERNS) add('secret', re)
  add('email', EMAIL)
  add('card', CARD, (s) => { const d = s.replace(/\D/g, ''); return d.length >= 13 && d.length <= 19 && luhn(d) })
  add('phone', PHONE, (s) => { const d = s.replace(/\D/g, ''); return d.length >= 9 && d.length <= 15 })
  add('ip', IPV4, (s) => !/^(?:0|127|255)\./.test(s) && s.split('.').length === 4)
  // keep the earliest, longest non-overlapping hits (a secret beats a phone inside it)
  hits.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start))
  const out: PiiHit[] = []
  let end = -1
  for (const h of hits) if (h.start >= end) { out.push(h); end = h.end }
  return out
}

const REDACT: Record<PiiKind, string> = { email: '[EMAIL]', phone: '[PHONE]', card: '[CARD]', secret: '[SECRET]', ip: '[IP]' }

export function redact(text: string, kinds?: Set<PiiKind>): { text: string; n: number } {
  const hits = findPii(text).filter((h) => !kinds || kinds.has(h.kind))
  if (!hits.length) return { text, n: 0 }
  let out = ''
  let pos = 0
  for (const h of hits) { out += text.slice(pos, h.start) + REDACT[h.kind]; pos = h.end }
  return { text: out + text.slice(pos), n: hits.length }
}

/** Apply a string transform to every text field of a record (message contents, prompt, completion, text). */
export function mapText(rec: Record<string, unknown>, fmt: Format, f: (s: string) => string): Record<string, unknown> {
  const mapMsgs = (v: unknown) => Array.isArray(v) ? v.map((m) => (isObj(m) && typeof m.content === 'string' ? { ...m, content: f(m.content) } : m)) : v
  switch (fmt) {
    case 'conversational': return { ...rec, messages: mapMsgs(rec.messages) }
    case 'instruction': return { ...rec, prompt: typeof rec.prompt === 'string' ? f(rec.prompt) : rec.prompt, completion: typeof rec.completion === 'string' ? f(rec.completion) : rec.completion }
    case 'preference': return {
      ...rec,
      input: isObj(rec.input) ? { ...rec.input, messages: mapMsgs(rec.input.messages) } : rec.input,
      preferred_output: mapMsgs(rec.preferred_output),
      non_preferred_output: mapMsgs(rec.non_preferred_output),
    }
    default: return { ...rec, text: typeof rec.text === 'string' ? f(rec.text) : rec.text }
  }
}

// ---------- refusals ----------

const REFUSAL = [
  /\bas an ai(?: language model| assistant)?\b/i,
  /\bi(?:'m| am) (?:sorry|afraid),? (?:but )?i (?:can(?:'|no)t|cannot|am unable to|won't)\b/i,
  /\bi (?:can(?:'|no)t|cannot|am unable to|won't) (?:help|assist|provide|comply|fulfil+) (?:with )?(?:that|this|your request)/i,
  /\bi(?:'m| am) not able to (?:help|assist|provide) (?:with )?(?:that|this)/i,
  /\bmy (?:guidelines|programming) (?:do not|don't) allow\b/i,
  /\bi do not have (?:the ability|access) to\b.*\b(?:real[- ]time|browse|internet)\b/i,
]

export function isRefusal(answer: string): boolean {
  const head = answer.slice(0, 400)
  return REFUSAL.some((re) => re.test(head))
}

// ---------- language ----------

const STOP: Record<string, string[]> = {
  en: ['the', 'and', 'is', 'to', 'you', 'of', 'it', 'for', 'your', 'that', 'this', 'with', 'can', 'have', 'i'],
  es: ['el', 'la', 'de', 'que', 'y', 'en', 'los', 'por', 'su', 'para', 'una', 'es', 'con', 'no', 'mi'],
  fr: ['le', 'la', 'les', 'de', 'et', 'est', 'pour', 'vous', 'une', 'des', 'que', 'pas', 'dans', 'je', 'votre'],
  de: ['der', 'die', 'und', 'ist', 'nicht', 'das', 'ich', 'sie', 'mit', 'ein', 'eine', 'zu', 'auf', 'für', 'ihr'],
  pt: ['o', 'a', 'de', 'que', 'e', 'não', 'para', 'um', 'uma', 'com', 'você', 'seu', 'meu', 'por', 'os'],
  it: ['il', 'di', 'che', 'e', 'la', 'per', 'non', 'un', 'una', 'sono', 'con', 'mi', 'ho', 'del', 'gli'],
}
const STOP_SETS = Object.fromEntries(Object.entries(STOP).map(([k, v]) => [k, new Set(v)]))

export const LANG_NAME: Record<string, string> = {
  en: 'English', es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese', it: 'Italian',
  zh: 'Chinese', ja: 'Japanese', ko: 'Korean', ru: 'Cyrillic script', ar: 'Arabic', hi: 'Devanagari', und: 'Undetermined',
}

export function detectLanguage(text: string): string {
  const t = text.slice(0, 2000)
  let han = 0, kana = 0, hangul = 0, cyr = 0, arab = 0, deva = 0, latin = 0
  for (const ch of t) {
    const c = ch.codePointAt(0)!
    if (c >= 0x4e00 && c <= 0x9fff) han++
    else if (c >= 0x3040 && c <= 0x30ff) kana++
    else if (c >= 0xac00 && c <= 0xd7af) hangul++
    else if (c >= 0x0400 && c <= 0x04ff) cyr++
    else if (c >= 0x0600 && c <= 0x06ff) arab++
    else if (c >= 0x0900 && c <= 0x097f) deva++
    else if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 0xc0 && c <= 0x24f)) latin++
  }
  const nonLatin = Math.max(han + kana, hangul, cyr, arab, deva)
  if (nonLatin > latin * 0.5 && nonLatin > 3) {
    if (kana > 0 && kana + han === nonLatin) return 'ja'
    if (han === nonLatin) return 'zh'
    if (hangul === nonLatin) return 'ko'
    if (cyr === nonLatin) return 'ru'
    if (arab === nonLatin) return 'ar'
    return 'hi'
  }
  const words = t.toLowerCase().match(/[a-zà-ÿ']+/g) ?? []
  if (words.length < 3) return 'und'
  let best = 'und'
  let bestScore = 0
  for (const [lang, set] of Object.entries(STOP_SETS)) {
    let s = 0
    for (const w of words) if (set.has(w)) s++
    if (s > bestScore) { bestScore = s; best = lang }
  }
  return bestScore >= 2 || bestScore / words.length > 0.1 ? best : 'und'
}

// ---------- length outliers ----------

/** Robust outliers on log length: |log(x) - median| > k * MAD (scaled). Returns [low, high] bounds. */
export function outlierBounds(lengths: number[], k = 3.5): { lo: number; hi: number; median: number } {
  const logs = lengths.filter((x) => x > 0).map(Math.log).sort((a, b) => a - b)
  if (logs.length < 8) return { lo: 0, hi: Infinity, median: 0 }
  const med = quantile(logs, 0.5)
  const dev = logs.map((x) => Math.abs(x - med)).sort((a, b) => a - b)
  const mad = Math.max(quantile(dev, 0.5) * 1.4826, 0.25)
  // never call something an outlier unless it is also far from the median in absolute terms
  return { lo: Math.min(Math.exp(med - k * mad), Math.exp(med) / 8), hi: Math.max(Math.exp(med + k * mad), Math.exp(med) * 8), median: Math.exp(med) }
}

// ---------- labels ----------

export interface LabelStats { labels: [string, number][]; ratio: number; classification: boolean; source: 'column' | 'answer' | 'none' }

/** Label distribution from an explicit label column, or from short answers when the data looks like classification. */
export function labelStats(explicit: (string | undefined)[], answers: string[]): LabelStats {
  let source: LabelStats['source'] = 'none'
  let values: string[] = []
  if (explicit.some((x) => x !== undefined)) { source = 'column'; values = explicit.map((x) => x ?? '(none)') }
  else {
    const short = answers.map((a) => a.trim()).filter((a) => a && a.length <= 40 && a.split(/\s+/).length <= 4)
    const distinct = new Set(short.map((a) => a.toLowerCase()))
    if (answers.length >= 20 && short.length >= answers.length * 0.9 && distinct.size <= Math.max(2, Math.min(30, answers.length / 5))) {
      source = 'answer'
      values = answers.map((a) => a.trim().toLowerCase())
    }
  }
  const counts = new Map<string, number>()
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1)
  const labels = [...counts].sort((a, b) => b[1] - a[1])
  const ratio = labels.length > 1 ? labels[0][1] / labels[labels.length - 1][1] : 1
  return { labels, ratio, classification: source === 'answer', source }
}
