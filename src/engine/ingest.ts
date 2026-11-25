/** Source rows -> canonical rows, plus the peek used by the mapping step. */
import { applyMapping, columnsOf, suggestMapping, type Mapping } from './mapping.ts'
import { decodeLine, readCsv, readJson, readJsonl, fromBytes, type FileKind, type RawItem } from './parse.ts'
import type { Row } from './pipeline.ts'

export function toRow(item: RawItem, id: number, mapping: Mapping): Row {
  if (item.error || !item.value) return { id, line: item.line, bytes: item.bytes, rec: null, parseError: item.error ?? 'E_JSON', parseMessage: item.message, badUtf8: item.badUtf8, raw: item.text }
  const { rec, label } = applyMapping(item.value as Record<string, unknown>, mapping)
  return { id, line: item.line, bytes: item.bytes || JSON.stringify(rec).length + 1, rec, label, badUtf8: item.badUtf8 }
}

export async function* readItems(kind: Exclude<FileKind, 'parquet'>, chunks: AsyncIterable<Uint8Array>): AsyncGenerator<RawItem> {
  if (kind === 'jsonl') yield* readJsonl(chunks)
  else if (kind === 'csv') yield* readCsv(chunks)
  else {
    const parts: Uint8Array[] = []
    for await (const c of chunks) parts.push(c)
    const { text, badUtf8 } = decodeLine(new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer()))
    yield* readJson(text, badUtf8)
  }
}

export interface Peek {
  kind: FileKind
  columns: string[]
  sample: Record<string, unknown>[]
  suggested: Mapping
  parseErrors: number
  /** Why there is nothing to map, when no row could be read. */
  problem?: string
}

/** Says why no row could be read. */
function noRows(kind: FileKind, items: RawItem[], name: string, blank: boolean, more: boolean): string {
  const bad = items.find((i) => i.error)
  if (!bad) return blank ? `${name} is empty.` : kind === 'csv' ? `${name} has no data rows under the header.` : `${name} has no rows.`
  const what = bad.error === 'E_NOT_OBJECT' ? 'is not a JSON object' : bad.error === 'E_CSV' ? `could not be read. ${bad.message}` : `is not valid JSON${bad.detail ? `: ${bad.detail}` : ''}`
  return `${name} has no readable row${more ? ` among its first ${items.length}` : ''}. ${kind === 'json' && bad.error === 'E_NOT_OBJECT' ? 'Row' : 'Line'} ${bad.line} ${what}${/[.]$/.test(what) ? '' : '.'}`
}

export function peekFrom(kind: FileKind, items: RawItem[], name = 'The file', blank = false, more = false): Peek {
  const sample = items.filter((i) => i.value).map((i) => i.value as Record<string, unknown>)
  const columns = columnsOf(sample)
  return { kind, columns, sample: sample.slice(0, 25), suggested: suggestMapping(columns, sample), parseErrors: items.filter((i) => i.error).length, problem: sample.length ? undefined : noRows(kind, items, name, blank, more) }
}

/** Convenience for tests and the hero: bytes -> rows in one go. */
export async function rowsFromBytes(kind: Exclude<FileKind, 'parquet'>, bytes: Uint8Array, mapping?: Mapping): Promise<{ rows: Row[]; mapping: Mapping }> {
  const items: RawItem[] = []
  for await (const it of readItems(kind, fromBytes(bytes))) items.push(it)
  const m = mapping ?? peekFrom(kind, items.slice(0, 200)).suggested
  return { rows: items.map((it, i) => toRow(it, i, m)), mapping: m }
}
