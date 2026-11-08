/** Source rows -> canonical rows, plus the peek used by the mapping step. */
import { applyMapping, columnsOf, suggestMapping, type Mapping } from './mapping.ts'
import { readCsv, readJson, readJsonl, fromBytes, type FileKind, type RawItem } from './parse.ts'
import type { Row } from './pipeline.ts'

export function toRow(item: RawItem, id: number, mapping: Mapping): Row {
  if (item.error || !item.value) return { id, line: item.line, bytes: item.bytes, rec: null, parseError: item.error ?? 'E_JSON', badUtf8: item.badUtf8, raw: item.text }
  const { rec, label } = applyMapping(item.value as Record<string, unknown>, mapping)
  return { id, line: item.line, bytes: item.bytes || JSON.stringify(rec).length + 1, rec, label, badUtf8: item.badUtf8 }
}

export async function* readItems(kind: Exclude<FileKind, 'parquet'>, chunks: AsyncIterable<Uint8Array>): AsyncGenerator<RawItem> {
  if (kind === 'jsonl') yield* readJsonl(chunks)
  else if (kind === 'csv') yield* readCsv(chunks)
  else {
    const parts: Uint8Array[] = []
    for await (const c of chunks) parts.push(c)
    const text = new TextDecoder().decode(await new Blob(parts as BlobPart[]).arrayBuffer())
    yield* readJson(text)
  }
}

export interface Peek {
  kind: FileKind
  columns: string[]
  sample: Record<string, unknown>[]
  suggested: Mapping
  parseErrors: number
}

export function peekFrom(kind: FileKind, items: RawItem[]): Peek {
  const sample = items.filter((i) => i.value).map((i) => i.value as Record<string, unknown>)
  const columns = columnsOf(sample)
  return { kind, columns, sample: sample.slice(0, 25), suggested: suggestMapping(columns, sample), parseErrors: items.filter((i) => i.error).length }
}

/** Convenience for tests and the hero: bytes -> rows in one go. */
export async function rowsFromBytes(kind: Exclude<FileKind, 'parquet'>, bytes: Uint8Array, mapping?: Mapping): Promise<{ rows: Row[]; mapping: Mapping }> {
  const items: RawItem[] = []
  for await (const it of readItems(kind, fromBytes(bytes))) items.push(it)
  const m = mapping ?? peekFrom(kind, items.slice(0, 200)).suggested
  return { rows: items.map((it, i) => toRow(it, i, m)), mapping: m }
}
