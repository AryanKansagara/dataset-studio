/** Streaming readers for JSONL, CSV and JSON. Everything works on chunks so a
 * 500 MB file never needs to be decoded as one string. */

export type FileKind = 'jsonl' | 'json' | 'csv' | 'parquet'

export interface RawItem {
  /** 1-based line number (JSONL/CSV) or row number (JSON/Parquet). */
  line: number
  bytes: number
  value?: unknown
  /** Raw text of the line, kept only when it failed to parse (for the error report). */
  text?: string
  error?: 'E_JSON' | 'E_NOT_OBJECT'
  badUtf8?: boolean
}

export function sniffKind(name: string, head: Uint8Array): FileKind {
  const lower = name.toLowerCase()
  if (head[0] === 0x50 && head[1] === 0x41 && head[2] === 0x52 && head[3] === 0x31) return 'parquet'
  if (lower.endsWith('.parquet')) return 'parquet'
  if (lower.endsWith('.csv') || lower.endsWith('.tsv')) return 'csv'
  if (lower.endsWith('.jsonl') || lower.endsWith('.ndjson')) return 'jsonl'
  const text = new TextDecoder().decode(head.subarray(0, 4096)).trimStart()
  if (text.startsWith('[')) return 'json'
  if (text.startsWith('{')) {
    // A pretty-printed single JSON object spans lines; JSONL has one object per line.
    const first = text.split('\n', 1)[0].trim()
    try { JSON.parse(first); return 'jsonl' } catch { return lower.endsWith('.json') ? 'json' : 'jsonl' }
  }
  return 'csv'
}

const fatal = new TextDecoder('utf-8', { fatal: true })
const lossy = new TextDecoder('utf-8')

function concat(parts: Uint8Array[], total: number): Uint8Array {
  if (parts.length === 1) return parts[0]
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

/** Split a byte stream on \n. Yields each line's bytes (without the newline). */
export async function* byteLines(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  let parts: Uint8Array[] = []
  let partLen = 0
  for await (const chunk of chunks) {
    let start = 0
    for (;;) {
      const nl = chunk.indexOf(10, start)
      if (nl === -1) break
      const piece = chunk.subarray(start, nl)
      if (partLen) { parts.push(piece); yield concat(parts, partLen + piece.length); parts = []; partLen = 0 }
      else yield piece
      start = nl + 1
    }
    if (start < chunk.length) { const rest = chunk.slice(start); parts.push(rest); partLen += rest.length }
  }
  if (partLen) yield concat(parts, partLen)
}

export function decodeLine(bytes: Uint8Array): { text: string; badUtf8: boolean } {
  try { return { text: fatal.decode(bytes), badUtf8: false } }
  catch { return { text: lossy.decode(bytes), badUtf8: true } }
}

/** JSONL: one JSON object per non-blank line (blank lines are skipped, like the SDK checker). */
export async function* readJsonl(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<RawItem> {
  let line = 0
  for await (const bytes of byteLines(chunks)) {
    line++
    const { text, badUtf8 } = decodeLine(bytes)
    const t = text.trim()
    if (!t) continue
    const item: RawItem = { line, bytes: bytes.length + 1, badUtf8: badUtf8 || undefined }
    try {
      const v = JSON.parse(t)
      if (typeof v !== 'object' || v === null || Array.isArray(v)) { item.error = 'E_NOT_OBJECT'; item.text = t.slice(0, 400) }
      else item.value = v
    } catch {
      item.error = 'E_JSON'
      item.text = t.slice(0, 400)
    }
    yield item
  }
}

/** RFC 4180 CSV (quoted fields, escaped quotes, newlines inside quotes). Auto-detects , ; or tab. */
export async function* readCsv(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<RawItem> {
  const dec = new TextDecoder('utf-8')
  let header: string[] | null = null
  let delim = ''
  let field = ''
  let row: string[] = []
  let inQ = false
  let afterQ = false
  let line = 1
  let rowLine = 1
  let rowBytes = 0
  const out: RawItem[] = []
  const endRow = () => {
    row.push(field)
    field = ''
    if (!header) header = row.map((h, i) => h.trim() || `column_${i + 1}`)
    else if (!(row.length === 1 && row[0] === '')) {
      const value: Record<string, string> = {}
      header.forEach((h, i) => { value[h] = row[i] ?? '' })
      out.push({ line: rowLine, bytes: rowBytes, value })
    }
    row = []
    rowBytes = 0
    rowLine = line
  }
  const feed = (text: string) => {
    if (!delim) {
      const first = text.split('\n', 1)[0]
      const counts = [',', ';', '\t'].map((d) => [d, first.split(d).length] as const)
      delim = counts.sort((a, b) => b[1] - a[1])[0][0]
    }
    for (let i = 0; i < text.length; i++) {
      const c = text[i]
      rowBytes++
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++ } else { inQ = false; afterQ = true }
        } else { if (c === '\n') line++; field += c }
        continue
      }
      if (c === '"' && field === '' && !afterQ) { inQ = true; continue }
      if (c === delim) { row.push(field); field = ''; afterQ = false; continue }
      if (c === '\r') continue
      if (c === '\n') { line++; afterQ = false; endRow(); continue }
      field += c
    }
  }
  for await (const chunk of chunks) {
    feed(dec.decode(chunk, { stream: true }))
    while (out.length) yield out.shift()!
  }
  feed(dec.decode())
  if (field !== '' || row.length) endRow()
  while (out.length) yield out.shift()!
}

/** JSON document: an array of objects, or an object holding one array (e.g. {"data": [...]}). */
export function readJson(text: string): RawItem[] {
  let doc: unknown
  try { doc = JSON.parse(text) } catch (e) {
    return [{ line: 1, bytes: text.length, error: 'E_JSON', text: String((e as Error).message).slice(0, 200) }]
  }
  let arr: unknown[] | null = Array.isArray(doc) ? doc : null
  if (!arr && doc && typeof doc === 'object') {
    const inner = Object.values(doc as object).find(Array.isArray)
    arr = (inner as unknown[]) ?? [doc]
  }
  return (arr ?? []).map((v, i) => {
    const ok = typeof v === 'object' && v !== null && !Array.isArray(v)
    return ok ? { line: i + 1, bytes: 0, value: v } : { line: i + 1, bytes: 0, error: 'E_NOT_OBJECT' as const, text: JSON.stringify(v)?.slice(0, 200) }
  })
}

export async function* fromBytes(bytes: Uint8Array, chunk = 1 << 16): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < bytes.length; i += chunk) yield bytes.subarray(i, i + chunk)
}
