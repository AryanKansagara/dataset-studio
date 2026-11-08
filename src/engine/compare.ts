/** Compact per-version stats (what gets stored and synced) and version comparison. */
import type { Report } from './pipeline.ts'
import type { IssueCode } from './validate.ts'

export interface VersionStats {
  rows: number
  baseRows: number
  train: number
  val: number
  errors: number
  warnings: number
  issues: Partial<Record<IssueCode, number>>
  tokens: { total: number; p50: number; p95: number; max: number; over: number; cut: number; limit: number; hist: number[]; exact: boolean } | null
  quality: { exactDup: number; nearDup: number; pii: number; refusals: number; minorityLang: number; outliers: number; leakage: number; labelRatio: number }
  dropped: { reason: string; count: number; lines: number[] }[]
  labels: [string, number][]
}

export function statsOf(r: Report): VersionStats {
  const q = r.quality
  return {
    rows: r.rows, baseRows: r.baseRows, train: r.train, val: r.val,
    errors: r.issues.rowsWithErrors, warnings: r.issues.rowsWithWarnings, issues: r.issues.byCode,
    tokens: r.tokens ? { total: r.tokens.total, p50: r.tokens.p50, p95: r.tokens.p95, max: r.tokens.max, over: r.tokens.over, cut: r.tokens.cut, limit: r.tokens.limit, hist: r.tokens.hist, exact: r.tokens.exact } : null,
    quality: {
      exactDup: q.exactDup.rows, nearDup: q.nearDup.rows, pii: q.pii.rows, refusals: q.refusals.rows,
      minorityLang: q.language.minorityRows, outliers: q.outliers.low + q.outliers.high, leakage: q.leakage.rows, labelRatio: q.labels.ratio,
    },
    dropped: r.dropped.map((d) => ({ ...d, lines: d.lines.slice(0, 50) })),
    labels: q.labels.labels.slice(0, 20),
  }
}

export interface Delta { key: string; label: string; a: number; b: number; better: 'up' | 'down' | 'none' }

/** Normalised histograms (share of rows per bin) and the total variation distance between them. */
export function histShift(a: number[], b: number[]): { a: number[]; b: number[]; tvd: number } {
  const sa = a.reduce((x, y) => x + y, 0) || 1
  const sb = b.reduce((x, y) => x + y, 0) || 1
  const na = a.map((x) => x / sa)
  const nb = b.map((x) => x / sb)
  let tvd = 0
  for (let i = 0; i < Math.max(na.length, nb.length); i++) tvd += Math.abs((na[i] ?? 0) - (nb[i] ?? 0))
  return { a: na, b: nb, tvd: tvd / 2 }
}

export function compareVersions(a: VersionStats, b: VersionStats): Delta[] {
  const d: Delta[] = [
    { key: 'rows', label: 'Examples', a: a.rows, b: b.rows, better: 'none' },
    { key: 'train', label: 'Train', a: a.train, b: b.train, better: 'none' },
    { key: 'val', label: 'Validation', a: a.val, b: b.val, better: 'none' },
    { key: 'errors', label: 'Rows with errors', a: a.errors, b: b.errors, better: 'down' },
    { key: 'warnings', label: 'Rows with warnings', a: a.warnings, b: b.warnings, better: 'down' },
    { key: 'exactDup', label: 'Exact duplicates', a: a.quality.exactDup, b: b.quality.exactDup, better: 'down' },
    { key: 'nearDup', label: 'Near-duplicates', a: a.quality.nearDup, b: b.quality.nearDup, better: 'down' },
    { key: 'leakage', label: 'Leaked validation rows', a: a.quality.leakage, b: b.quality.leakage, better: 'down' },
    { key: 'pii', label: 'Rows with PII', a: a.quality.pii, b: b.quality.pii, better: 'down' },
    { key: 'refusals', label: 'Refusals', a: a.quality.refusals, b: b.quality.refusals, better: 'down' },
    { key: 'outliers', label: 'Length outliers', a: a.quality.outliers, b: b.quality.outliers, better: 'down' },
  ]
  if (a.tokens && b.tokens) {
    d.push(
      { key: 'tokens', label: 'Total tokens', a: a.tokens.total, b: b.tokens.total, better: 'none' },
      { key: 'p95', label: 'p95 tokens / example', a: a.tokens.p95, b: b.tokens.p95, better: 'none' },
      { key: 'over', label: 'Over max length', a: a.tokens.over, b: b.tokens.over, better: 'down' },
    )
  }
  return d
}
