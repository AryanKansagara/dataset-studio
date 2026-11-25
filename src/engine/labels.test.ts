import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyze, type Op, type Row } from './pipeline.ts'

const ctx = { format: 'instruction' as const, split: { valFraction: 0, seed: 1, stratify: true } }
const row = (id: number, label?: string, completion = `a${id}`): Row => ({ id, line: id + 1, bytes: 9, rec: { prompt: `q${id}`, completion }, label })
const broken = (id: number): Row => ({ id, line: id + 1, bytes: 9, rec: null, parseError: 'E_JSON' })
const run = (rows: Row[], ops: Op[] = []) => analyze(rows, ops, ctx, { limit: 999 }).report
const many = (n: number, from: number, label?: string, c?: string) => [...Array(n)].map((_, i) => row(from + i, label, c))

test('labels: unparseable, missing and blank labels are not a class (#3)', () => {
  const rows = [...many(50, 0, 'A'), ...many(50, 50, 'B'), broken(100), row(101), row(102, ''), row(103, '  ')]
  const l = run(rows).quality.labels
  assert.deepEqual([l.labels, l.ratio, l.source], [[['A', 50], ['B', 50]], 1, 'column'])
  assert.equal(run(rows, [{ type: 'rebalance', maxRatio: 1 }]).rows, 104)
})

test('labels: downsampling caps the classes and keeps unlabelled rows (#3)', () => {
  const rows = [...many(24, 0, 'A'), ...many(6, 24, 'B'), row(30)]
  const r = run(rows, [{ type: 'rebalance', maxRatio: 2 }])
  assert.equal(r.rows, 19) // 12 A + 6 B + 1 unlabelled
  assert.deepEqual(r.quality.labels.labels, [['A', 12], ['B', 6]])
})

test('labels: the same for classes taken from short answers (#3)', () => {
  const rows = [...many(30, 0, undefined, 'yes'), ...many(30, 30, undefined, 'no'), broken(60), broken(61)]
  const l = run(rows).quality.labels
  assert.deepEqual([l.source, l.ratio, l.labels.length], ['answer', 1, 2])
  assert.equal(run(rows, [{ type: 'rebalance', maxRatio: 1 }]).rows, 62)
})

test('labels: a column of blanks is no label column (#3)', () => {
  assert.equal(run([row(0, ''), row(1, ' ')]).quality.labels.source, 'none')
})
