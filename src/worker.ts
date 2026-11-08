/// <reference lib="webworker" />
/** The engine runs here so a 500 MB file never blocks the UI. Files stream in
 * chunks; raw rows never leave this worker except as exported files. */
import { sniffKind, type FileKind, type RawItem } from './engine/parse.ts'
import { peekFrom, readItems, toRow, type Peek } from './engine/ingest.ts'
import { columnsOf, suggestMapping, type Format, type Mapping } from './engine/mapping.ts'
import { analyze, cachedCounter, rowIssues, type Op, type PipelineResult, type Report, type Row, type SplitSettings } from './engine/pipeline.ts'
import { renderRecord, tokenizeRecord, countRecord } from './engine/tokens.ts'
import { majorityFormat } from './engine/validate.ts'
import { messySupportSample } from './engine/sample.ts'
import { toJsonl } from './engine/exporters.ts'
import { loadTokenizer, clearTokenizerCache, type LoadedTokenizer } from './lib/tokenizer.ts'

export type Source =
  | { kind: 'file'; file: File }
  | { kind: 'sample' }
  | { kind: 'hf'; dataset: string; config?: string; split?: string; maxRows?: number }

export interface HfInfo { configs: { config: string; split: string; files: { url: string; size: number }[] }[] }

const ctx = self as unknown as DedicatedWorkerGlobalScope

let base: Row[] = []
let format: Format = 'conversational'
let tokenizer: LoadedTokenizer | null = null
let tokenizerModel = ''
let counter: ((rec: Record<string, unknown>) => number) | undefined
let last: { result: PipelineResult; report: Report } | null = null

let reqId = 0
const progress = (phase: string, done: number, total: number) => ctx.postMessage({ t: 'progress', id: reqId, phase, done, total })

// ---------- sources ----------

async function* streamFile(file: Blob, from = 0): AsyncGenerator<Uint8Array> {
  const reader = file.slice(from).stream().getReader()
  let done = from
  let lastTick = 0
  for (;;) {
    const r = await reader.read()
    if (r.done) break
    done += r.value.length
    if (done - lastTick > 4 << 20 || done === file.size) { progress('Reading', done, file.size); lastTick = done }
    yield r.value
  }
}

async function* bytesStream(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < bytes.length; i += 1 << 16) { progress('Reading', i, bytes.length); yield bytes.subarray(i, i + (1 << 16)) }
}

let compressorsP: Promise<unknown> | null = null
const compressors = () => (compressorsP ??= import('hyparquet-compressors').then((m) => m.compressors))

async function parquetItems(file: { byteLength: number; slice(s: number, e?: number): Promise<ArrayBuffer> | ArrayBuffer }, maxRows: number, startLine = 0): Promise<RawItem[]> {
  const { parquetMetadataAsync, parquetReadObjects } = await import('hyparquet')
  const meta = await parquetMetadataAsync(file)
  const n = Math.min(Number(meta.num_rows), maxRows)
  const out: RawItem[] = []
  const step = 5000
  for (let s = 0; s < n; s += step) {
    const rows = await parquetReadObjects({ file, metadata: meta, rowStart: s, rowEnd: Math.min(n, s + step), compressors: (await compressors()) as never })
    rows.forEach((v, i) => out.push({ line: startLine + s + i + 1, bytes: 0, value: plain(v) }))
    progress('Reading parquet', s + rows.length, n)
  }
  return out
}

/** Parquet readers return BigInt for INT64; JSON can't hold those. */
function plain(v: unknown): unknown {
  if (typeof v === 'bigint') return Number(v)
  if (Array.isArray(v)) return v.map(plain)
  if (v && typeof v === 'object' && !(v instanceof Date)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]))
  return v
}

async function hfInfo(dataset: string): Promise<HfInfo> {
  const res = await fetch(`https://datasets-server.huggingface.co/parquet?dataset=${encodeURIComponent(dataset)}`)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(res.status === 401 || res.status === 404 ? `Dataset "${dataset}" was not found or is gated/private (${body.error ?? res.status}).` : `Hugging Face returned ${res.status}: ${body.error ?? res.statusText}`)
  }
  const data = await res.json() as { parquet_files: { config: string; split: string; url: string; size: number }[] }
  const groups = new Map<string, HfInfo['configs'][number]>()
  for (const f of data.parquet_files) {
    const k = `${f.config}/${f.split}`
    const g = groups.get(k) ?? { config: f.config, split: f.split, files: [] }
    g.files.push({ url: f.url, size: f.size })
    groups.set(k, g)
  }
  if (!groups.size) throw new Error('No parquet export is available for this dataset yet.')
  return { configs: [...groups.values()] }
}

async function hfItems(src: Extract<Source, { kind: 'hf' }>, maxRows: number): Promise<RawItem[]> {
  const info = await hfInfo(src.dataset)
  const pick = info.configs.find((c) => c.config === (src.config ?? c.config) && c.split === (src.split ?? 'train')) ?? info.configs.find((c) => c.split === 'train') ?? info.configs[0]
  const { asyncBufferFromUrl, cachedAsyncBuffer } = await import('hyparquet')
  const out: RawItem[] = []
  for (const f of pick.files) {
    if (out.length >= maxRows) break
    const buf = cachedAsyncBuffer(await asyncBufferFromUrl({ url: f.url, byteLength: f.size }))
    out.push(...(await parquetItems(buf, maxRows - out.length, out.length)))
  }
  return out
}

async function fileKind(file: File): Promise<FileKind> {
  const head = new Uint8Array(await file.slice(0, 8192).arrayBuffer())
  return sniffKind(file.name, head)
}

async function peek(src: Source): Promise<Peek & { name: string; size: number }> {
  if (src.kind === 'sample') {
    const s = messySupportSample()
    const items: RawItem[] = []
    for await (const it of readItems('jsonl', bytesStream(s.bytes.subarray(0, 200_000)))) { items.push(it); if (items.length >= 200) break }
    return { ...peekFrom('jsonl', items), name: 'support-chats-messy.jsonl', size: s.bytes.length }
  }
  if (src.kind === 'hf') {
    const items = await hfItems(src, 200)
    return { ...peekFrom('parquet', items), name: `hf://${src.dataset}`, size: 0 }
  }
  const kind = await fileKind(src.file)
  let items: RawItem[] = []
  if (kind === 'parquet') {
    items = await parquetItems({ byteLength: src.file.size, slice: (s, e) => src.file.slice(s, e).arrayBuffer() }, 200)
    if (items[0] && typeof items[0].value === 'object' && items[0].value && 'input_ids' in (items[0].value as object))
      throw new Error('This Parquet file is already pre-tokenized (input_ids). Upload it to Together as-is; Dataset Studio works on text before tokenization.')
  } else if (kind === 'json') {
    for await (const it of readItems('json', streamFile(src.file))) { items.push(it); if (items.length >= 200) break }
  } else {
    for await (const it of readItems(kind, streamFile(src.file.slice(0, 1 << 20) as File))) { items.push(it); if (items.length >= 200) break }
  }
  return { ...peekFrom(kind, items), name: src.file.name, size: src.file.size }
}

async function ingest(src: Source, mapping: Mapping): Promise<{ rows: number; format: Format; parseErrors: number; formatGuess: Format | null; columns: string[] }> {
  base = []
  last = null
  let items: AsyncIterable<RawItem> | RawItem[]
  if (src.kind === 'sample') items = readItems('jsonl', bytesStream(messySupportSample().bytes))
  else if (src.kind === 'hf') items = await hfItems(src, src.maxRows ?? 50_000)
  else {
    const kind = await fileKind(src.file)
    items = kind === 'parquet'
      ? await parquetItems({ byteLength: src.file.size, slice: (s, e) => src.file.slice(s, e).arrayBuffer() }, Number.MAX_SAFE_INTEGER)
      : readItems(kind, streamFile(src.file))
  }
  let id = 0
  let parseErrors = 0
  const sampleCols: Record<string, unknown>[] = []
  for await (const it of items as AsyncIterable<RawItem>) {
    if (it.error) parseErrors++
    else if (sampleCols.length < 50) sampleCols.push(it.value as Record<string, unknown>)
    base.push(toRow(it, id++, mapping))
    if (id % 20000 === 0) progress('Mapping rows', id, 0)
  }
  format = mapping.identity ? majorityFormat(base.filter((r) => r.rec).map((r) => r.rec!)) ?? mapping.format : mapping.format
  counter = tokenizer ? cachedCounter(format, tokenizer) : undefined
  return { rows: base.length, format, parseErrors, formatGuess: suggestMapping(columnsOf(sampleCols), sampleCols).format, columns: columnsOf(sampleCols) }
}

async function setTokenizer(model: string) {
  if (tokenizer && tokenizerModel === model) return describeTk()
  tokenizer = null
  counter = undefined
  tokenizer = await loadTokenizer(model, (loaded, total, file) => progress(`Downloading ${file}`, loaded, total))
  tokenizerModel = model
  counter = cachedCounter(format, tokenizer)
  return describeTk()
}

const describeTk = () => ({ repo: tokenizer?.repo ?? '', hasTemplate: !!tokenizer?.hasTemplate, approximate: !!tokenizer?.approximate })

function runAnalyze(p: { ops: Op[]; split: SplitSettings; limit: number; exactTokens: boolean; nearThreshold: number }) {
  if (counter) {
    // warm the token cache with progress before the synchronous analysis
    const sample = p.exactTokens ? 0 : 20000
    const live = base.filter((r) => r.rec)
    const step = sample && live.length > sample ? live.length / sample : 1
    const todo = Math.min(live.length, sample || live.length)
    for (let i = 0, k = 0; i < live.length; i += step, k++) {
      counter(live[Math.floor(i)].rec!)
      if (k % 500 === 0) progress('Counting tokens', k, todo)
    }
  }
  progress('Running checks', 0, 1)
  const { report, result } = analyze(base, p.ops, { format, split: p.split, tokenizer, tokens: counter }, { limit: p.limit, tokenSample: p.exactTokens ? 0 : 20000, nearThreshold: p.nearThreshold })
  last = { report, result }
  return report
}

function rowDetail(rowId: number, limit: number) {
  const fromResult = last?.result.rows.find((r) => r.id === rowId)
  const row = fromResult ?? base.find((r) => r.id === rowId)
  if (!row) return null
  const original = base.find((r) => r.id === rowId) ?? null
  const issues = rowIssues(row, format, limit)
  let rendered: string[] | null = null
  let tokens: number[] | null = null
  if (row.rec && tokenizer) { rendered = renderRecord(row.rec, format, tokenizer); tokens = countRecord(row.rec, format, tokenizer) }
  return {
    row: { ...row, rec: row.rec }, original: original && original.rec !== row.rec ? original : null,
    issues, rendered, tokens, dropped: last && !fromResult ? last.result.dropped.get(rowId) ?? null : null,
    split: last && fromResult ? (last.result.val.has(rowId) ? 'validation' : 'train') : null,
  }
}

async function exportFile(p: { kind: 'jsonl' | 'parquet'; part: 'train' | 'val' | 'all'; trainOnInputs: boolean; limit: number }): Promise<Blob> {
  if (!last) throw new Error('Run the checks first.')
  const { rows, val } = last.result
  const pick = rows.filter((r) => r.rec && (p.part === 'all' || (p.part === 'val') === val.has(r.id)))
  if (p.kind === 'jsonl') {
    const parts: string[] = []
    for (let i = 0; i < pick.length; i += 5000) parts.push(toJsonl(pick.slice(i, i + 5000).map((r) => r.rec!)))
    return new Blob(parts, { type: 'application/jsonl' })
  }
  if (format === 'preference') throw new Error('Together does not accept pre-tokenized Parquet for preference (DPO) training. Export JSONL instead.')
  if (!tokenizer || tokenizer.approximate) throw new Error('Parquet export needs the exact tokenizer for this model.')
  const input_ids: number[][] = []
  const attention_mask: number[][] = []
  const labels: number[][] = []
  pick.forEach((r, i) => {
    const t = tokenizeRecord(r.rec!, format, tokenizer!, p.trainOnInputs, p.limit)
    input_ids.push(t.input_ids)
    attention_mask.push(t.input_ids.map(() => 1))
    labels.push(t.labels)
    if (i % 500 === 0) progress('Tokenizing for Parquet', i, pick.length)
  })
  const { parquetWriteBuffer } = await import('hyparquet-writer')
  const list = (name: string) => [
    { name, repetition_type: 'REQUIRED' as const, converted_type: 'LIST' as const, num_children: 1 },
    { name: 'list', repetition_type: 'REPEATED' as const, num_children: 1 },
    { name: 'element', type: 'INT32' as const, repetition_type: 'REQUIRED' as const },
  ]
  const buf = parquetWriteBuffer({
    columnData: [{ name: 'input_ids', data: input_ids }, { name: 'attention_mask', data: attention_mask }, { name: 'labels', data: labels }],
    schema: [{ name: 'root', num_children: 3 }, ...list('input_ids'), ...list('attention_mask'), ...list('labels')] as never,
  })
  return new Blob([buf], { type: 'application/vnd.apache.parquet' })
}

ctx.onmessage = async (e: MessageEvent) => {
  const m = e.data
  reqId = m.id
  const id = m.id
  try {
    let data: unknown
    switch (m.t) {
      case 'peek': data = await peek(m.source); break
      case 'hfInfo': data = await hfInfo(m.dataset); break
      case 'ingest': data = await ingest(m.source, m.mapping); break
      case 'tokenizer': data = await setTokenizer(m.model); break
      case 'analyze': data = runAnalyze(m); break
      case 'row': data = rowDetail(m.rowId, m.limit); break
      case 'export': data = await exportFile(m); break
      case 'clearCache': await clearTokenizerCache(); data = true; break
      default: throw new Error(`unknown message ${m.t}`)
    }
    ctx.postMessage({ t: 'result', id, data })
  } catch (err) {
    ctx.postMessage({ t: 'error', id, message: err instanceof Error ? err.message : String(err) })
  }
}
