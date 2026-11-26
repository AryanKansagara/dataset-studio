import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyze, applyOps, findLeaks, type Row } from './pipeline.ts'
import type { Format } from './mapping.ts'

const rows = (recs: Record<string, unknown>[]): Row[] => recs.map((rec, i) => ({ id: i, line: i + 1, bytes: 9, rec }))
const ctx = (format: Format) => ({ format, split: { valFraction: 0, seed: 1, stratify: false } })
const dups = (format: Format, ...recs: Record<string, unknown>[]) => {
  const q = analyze(rows(recs), [], ctx(format), { limit: 99 }).report.quality
  const kept = (type: 'dedupeExact' | 'dedupeNear') => applyOps(rows(recs), [type === 'dedupeNear' ? { type, threshold: 0.8 } : { type }], ctx(format)).rows.length
  assert.equal(recs.length - kept('dedupeExact'), q.exactDup.rows)
  return { exact: q.exactDup.rows, near: q.nearDup.rows, keptByNear: kept('dedupeNear') }
}
const call = (args: unknown, id = '1', user = 'What is the weather like there at the moment, please?', content: string | null = '') =>
  ({ messages: [{ role: 'user', content: user }, { role: 'assistant', content, tool_calls: [{ id, type: 'function', function: { name: 'weather', arguments: args } }] }] })

test('duplicates: rows that differ in a tool call are neither exact nor near-duplicates (#12)', () => {
  assert.deepEqual(dups('conversational', call('{"city":"Oslo"}'), call('{"city":"Lima"}')), { exact: 0, near: 0, keptByNear: 2 })
  const other = call('{"city":"Oslo"}')
  other.messages[1].tool_calls![0].function.name = 'forecast'
  assert.equal(dups('conversational', call('{"city":"Oslo"}'), other).exact, 0)
  assert.equal(dups('conversational', call('{"id":12345678901234567890}'), call('{"id":12345678901234567891}')).exact, 0)
  // a file name differs by its case
  assert.equal(dups('conversational', call('{"f":"A"}'), call('{"f":"a"}')).exact, 0)
})

test('duplicates: the same tool call is one, whatever its id, spacing, key order or encoding (#12)', () => {
  const same = [call('{"a":1,"b":{"c":[2]}}'), call('{ "b": {"c":[2]}, "a": 1 }', '2'), call({ b: { c: [2] }, a: 1 }, '3', undefined, null)]
  assert.equal(dups('conversational', ...same).exact, 2)
  assert.equal(dups('conversational', call('not json'), call('not json')).exact, 1)
  // near-duplicate text around the same call is still near
  assert.equal(dups('conversational', call('{}'), call('{}', '1', 'What is the weather like there at the moment, please??')).near, 1)
})

test('duplicates: field and turn boundaries count (#12)', () => {
  assert.equal(dups('instruction', { prompt: 'a b', completion: 'c' }, { prompt: 'a', completion: 'b c' }).exact, 0)
  assert.equal(dups('instruction', { prompt: 'A  b', completion: 'c' }, { prompt: 'a b ', completion: 'C' }).exact, 1)
  const pref = (q: string, a: string, b: string) => ({ input: { messages: [{ role: 'user', content: q }] }, preferred_output: [{ role: 'assistant', content: a }], non_preferred_output: [{ role: 'assistant', content: b }] })
  assert.equal(dups('preference', pref('q', 'a b', 'c'), pref('q', 'a', 'b c')).exact, 0)
  assert.equal(dups('preference', pref('q', 'a', 'b'), pref('Q', 'a', 'b')).exact, 1)
  const chat = (...t: [string, unknown][]) => ({ messages: t.map(([role, content]) => ({ role, content })) })
  assert.equal(dups('conversational', chat(['user', 'q user: r'], ['assistant', 'a']), chat(['user', 'q'], ['user', 'r'], ['assistant', 'a'])).exact, 0)
  assert.equal(dups('conversational', chat(['user', 'q'], ['assistant', 'a']), chat(['user', [{ type: 'text', text: 'Q' }]], ['assistant', ' a'])).exact, 1)
})

test('duplicates: rows without text are never near-duplicates (#12)', () => {
  const emoji = (s: string) => ({ messages: [{ role: 'user', content: s }, { role: 'assistant', content: s }] })
  assert.deepEqual(dups('conversational', emoji('👍'), emoji('🎉'), call('{"n":1}', '1', '', ''), call('{"n":2}', '1', '', '')), { exact: 0, near: 0, keptByNear: 4 })
  assert.equal(findLeaks(rows([emoji('👍'), emoji('🎉')]), new Set([1]), 'conversational').size, 0)
  assert.equal(findLeaks(rows([emoji('👍'), emoji('👍')]), new Set([1]), 'conversational').size, 1)
})

test('duplicates: a validation row with a trained prompt still leaks when only its tool call differs (#12)', () => {
  assert.equal(findLeaks(rows([call('{"city":"Oslo"}', '1', 'Weather there?'), call('{"city":"Lima"}', '1', 'Weather there?')]), new Set([1]), 'conversational').size, 1)
})
