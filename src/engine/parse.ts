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
  error?: 'E_JSON' | 'E_NOT_OBJECT' | 'E_CSV'
  /** What exactly is wrong, when the error code alone does not say it. */
  message?: string
  /** What the JSON parser says, for the import preview. */
  detail?: string
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

/** sniffKind, but a file that starts with "{" is judged by its whole first line: more lines after a complete object are
 * JSON Lines, an object on its own is a document. */
export async function detectKind(name: string, head: Uint8Array, body: () => AsyncIterable<Uint8Array>): Promise<FileKind> {
  const kind = sniffKind(name, head)
  if (kind === 'csv' || kind === 'parquet' || /\.(jsonl|ndjson)$/i.test(name) || !new TextDecoder().decode(head).trimStart().startsWith('{')) return kind
  let first: string | null = null
  for await (const bytes of byteLines(body())) {
    const t = lossy.decode(bytes).trim()
    if (!t) continue
    if (first !== null) { try { JSON.parse(first); return 'jsonl' } catch { return kind } }
    first = t
  }
  return 'json'
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
    } catch (e) {
      item.error = 'E_JSON'
      item.text = t.slice(0, 400)
      item.detail = String((e as Error).message).slice(0, 200)
    }
    yield item
  }
}

/** Split a CSV byte stream into records (newlines inside quotes belong to the record). All the structural
 * characters are ASCII, so this works on bytes and does not depend on where the chunks end. */
async function* csvRecords(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<{ bytes: Uint8Array; line: number; delim: string; unclosed: boolean }> {
  let delim = 0
  let started = false
  let parts: Uint8Array[] = []
  let len = 0
  let line = 1
  let recLine = 1
  // where in a cell we are: at its start, in plain text, inside quotes, or just after a quote inside quotes
  let at: 'start' | 'text' | 'quoted' | 'quote' = 'start'
  /** The head of the file, up to at least the first newline: drops a BOM and picks the delimiter. */
  const begin = (buf: Uint8Array) => {
    if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) buf = buf.subarray(3)
    const nl = buf.indexOf(10)
    const first = new TextDecoder().decode(nl === -1 ? buf : buf.subarray(0, nl))
    const counts = [',', ';', '\t'].map((d) => [d, first.split(d).length] as const)
    delim = counts.sort((a, b) => b[1] - a[1])[0][0].charCodeAt(0)
    started = true
    return buf
  }
  const scan = function* (chunk: Uint8Array) {
    let start = 0
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i]
      if (at === 'quoted') {
        if (c === 34) at = 'quote'
        else if (c === 10) line++
        continue
      }
      if (at === 'quote' && c === 34) { at = 'quoted'; continue }
      if (c === 10) {
        line++
        const piece = chunk.subarray(start, i)
        yield { bytes: concat([...parts, piece], len + piece.length), line: recLine, delim: String.fromCharCode(delim), unclosed: false }
        parts = []; len = 0; start = i + 1; recLine = line; at = 'start'
      } else if (c === delim) at = 'start'
      else if (c === 13) { if (at === 'quote') at = 'text' }
      else at = at === 'start' && c === 34 ? 'quoted' : 'text'
    }
    if (start < chunk.length) { parts.push(chunk.slice(start)); len += chunk.length - start }
  }
  let head: Uint8Array[] = []
  const joinHead = () => concat(head, head.reduce((a, p) => a + p.length, 0))
  for await (const chunk of chunks) {
    if (started) { yield* scan(chunk); continue }
    head.push(chunk.slice())
    if (chunk.indexOf(10) === -1) continue
    yield* scan(begin(joinHead()))
    head = []
  }
  if (!started) yield* scan(begin(joinHead()))
  if (len) yield { bytes: concat(parts, len), line: recLine, delim: String.fromCharCode(delim), unclosed: (at as string) === 'quoted' }
}

function csvCells(text: string, delim: string): string[] {
  const row: string[] = []
  let field = ''
  let inQ = false
  let afterQ = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQ) {
      if (c !== '"') field += c
      else if (text[i + 1] === '"') { field += '"'; i++ }
      else { inQ = false; afterQ = true }
    } else if (c === '"' && field === '' && !afterQ) inQ = true
    else if (c === delim) { row.push(field); field = ''; afterQ = false }
    else if (c !== '\r') field += c
  }
  row.push(field)
  return row
}

/** RFC 4180 CSV (quoted fields, escaped quotes, newlines inside quotes). Auto-detects , ; or tab.
 * Rows that cannot be matched to the header are reported (E_CSV), never cut or padded. */
export async function* readCsv(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<RawItem> {
  let header: string[] | null = null
  let named = 0 // cells up to the last named column; the ones after it may be missing
  for await (const rec of csvRecords(chunks)) {
    const { text, badUtf8 } = decodeLine(rec.bytes)
    const row = csvCells(text, rec.delim)
    const item: RawItem = { line: rec.line, bytes: rec.bytes.length + 1, badUtf8: badUtf8 || undefined }
    const fail = (message: string) => ({ ...item, error: 'E_CSV' as const, message, text: text.slice(0, 400) })
    if (rec.unclosed) {
      yield fail('A quote opened in this row is never closed, so the rest of the file could not be read')
      continue
    }
    if (row.length === 1 && row[0] === '') continue
    if (!header) {
      const seen = new Set<string>()
      header = row.map((h, i) => {
        const base = h.trim() || `column_${i + 1}`
        let name = base
        for (let n = 2; seen.has(name); n++) name = `${base}_${n}`
        seen.add(name)
        return name
      })
      row.forEach((h, i) => { if (h.trim()) named = i + 1 })
      continue
    }
    if (row.length < named || row.slice(header.length).some((c) => c.trim())) {
      yield fail(`Row has ${row.length} cell${row.length === 1 ? '' : 's'} but the header has ${header.length}`)
      continue
    }
    const value: Record<string, string> = {}
    header.forEach((h, i) => { value[h] = row[i] ?? '' })
    yield { ...item, value }
  }
}

const JSON_TOKEN = /[{}[\],:]|"[^"\\\x00-\x1f]*(?:\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})[^"\\\x00-\x1f]*)*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y

/** Where a JSON document stops being valid: the parser's message does not always say. */
export function jsonErrorAt(text: string): number {
  const open: string[] = []
  let want: 'value' | 'value or ]' | 'key' | 'key or }' | ':' | ', or end' = 'value'
  let pos = 0
  for (;;) {
    while (' \t\r\n'.includes(text[pos] || 'x')) pos++
    JSON_TOKEN.lastIndex = pos
    const t = JSON_TOKEN.exec(text)?.[0]
    if (t === undefined) return pos
    const inside = open[open.length - 1]
    if (want === ', or end') {
      if (t === ',' && inside) want = inside === '{' ? 'key' : 'value'
      else if (inside && t === (inside === '{' ? '}' : ']')) open.pop()
      else return pos
    } else if (want === ':') {
      if (t !== ':') return pos
      want = 'value'
    } else if (want === 'key' || want === 'key or }') {
      if (t === '}' && want === 'key or }') { open.pop(); want = ', or end' }
      else if (t[0] === '"') want = ':'
      else return pos
    } else if (t === ']' && want === 'value or ]') { open.pop(); want = ', or end' }
    else if (t === '{') { open.push(t); want = 'key or }' }
    else if (t === '[') { open.push(t); want = 'value or ]' }
    else if (',:]}'.includes(t)) return pos
    else want = ', or end'
    pos += t.length
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
/** A list of chat turns is one value of an example, not a list of examples. */
const isTurns = (v: unknown) => Array.isArray(v) && v.every((m) => isObject(m) && (('role' in m && ('content' in m || 'tool_calls' in m)) || ('from' in m && 'value' in m)))
const WRAPPER_KEY = /^(?:data|rows|examples|train|records|items|instances)$/i
const EXAMPLE_KEY = /^(?:messages|conversations?|prompt|completion|instruction|output|question|answer|response|chosen|rejected|preferred_output|non_preferred_output|text)$/i

/** The rows of a JSON object: those in its list ({"data": [...]}), or the object itself when it is one example. */
function rowsOfObject(doc: Record<string, unknown>): unknown[] {
  const entries = Object.entries(doc)
  const named = entries.find(([k, v]) => WRAPPER_KEY.test(k) && Array.isArray(v))
  if (named) return named[1] as unknown[]
  if (entries.some(([k, v]) => EXAMPLE_KEY.test(k) && (typeof v === 'string' || isTurns(v)))) return [doc]
  return (entries.find(([, v]) => Array.isArray(v) && v.some(isObject) && !isTurns(v))?.[1] as unknown[] | undefined) ?? [doc]
}

/** JSON document: an array of objects, an object holding one array (e.g. {"data": [...]}), or one example. */
export function readJson(text: string, badUtf8 = false): RawItem[] {
  let doc: unknown
  try { doc = JSON.parse(text) } catch (e) {
    const detail = String((e as Error).message).slice(0, 200)
    return [{ line: text.slice(0, jsonErrorAt(text)).split('\n').length, bytes: text.length, error: 'E_JSON', text: detail, detail }]
  }
  const arr = Array.isArray(doc) ? doc : isObject(doc) ? rowsOfObject(doc) : []
  return arr.map((v, i) => {
    const bad = badUtf8 && JSON.stringify(v).includes('\ufffd') ? { badUtf8: true } : {}
    return isObject(v) ? { line: i + 1, bytes: 0, value: v, ...bad } : { line: i + 1, bytes: 0, error: 'E_NOT_OBJECT' as const, text: JSON.stringify(v)?.slice(0, 200), ...bad }
  })
}

export async function* fromBytes(bytes: Uint8Array, chunk = 1 << 16): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < bytes.length; i += chunk) yield bytes.subarray(i, i + chunk)
}
