import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderRecord, tokenizeRecord, type TokenizerLike } from './tokens.ts'

type M = { role: string; content: string; weight?: number; tool_calls?: { function: { name: string; arguments: unknown } }[] }
type Render = (msgs: M[], gen: boolean) => string
// one token per character, so labels read back as text
const tk = (render: Render): TokenizerLike => ({ ids: (t) => [...t].map((c) => c.codePointAt(0)!), render: (m, o) => render(m as M[], !!o?.addGenerationPrompt) })
const trained = (rec: Record<string, unknown>, t: TokenizerLike, all = false) => {
  const r = tokenizeRecord(rec, 'conversational', t, all, 1e6)
  return r.labels.map((l, i) => (l === -100 ? '·' : String.fromCodePoint(r.input_ids[i]))).join('').split(/·+/).filter(Boolean)
}
const text = (rec: Record<string, unknown>, t: TokenizerLike) => String.fromCodePoint(...tokenizeRecord(rec, 'conversational', t, false, 1e6).input_ids)
const two = { messages: [{ role: 'user', content: 'Q1' }, { role: 'assistant', content: '<b>A1' }, { role: 'user', content: 'Q2' }, { role: 'assistant', content: 'A2' }] }

const plain: Render = (ms, gen) => ms.map((m) => `<|${m.role}|>${m.content}<|end|>`).join('') + (gen ? '<|assistant|>' : '')
// Gemma 4: the generation prompt has an empty thinking block that finished turns do not have
const gemma: Render = (ms, gen) => plain(ms, gen) + (gen ? '<|think|>' : '')
// Qwen 3.5: only the last assistant turn has a thinking block, and the generation prompt opens one
const qwen: Render = (ms, gen) => ms.map((m, i) => `<|${m.role}|>${m.role === 'assistant' && i === ms.length - 1 ? '<think>\n</think>' : ''}${m.content}<|end|>`).join('') + (gen ? '<|assistant|><think>' : '')
// gpt-oss: the last turn ends with another token than the earlier ones
const oss: Render = (ms, gen) => ms.map((m, i) => `<|${m.role}|>${m.content}${m.role === 'assistant' && i === ms.length - 1 ? '<|return|>' : '<|end|>'}`).join('') + (gen ? '<|assistant|>' : '')

test('Parquet labels: every assistant turn and nothing of the prompt, whatever the template does (#6)', () => {
  assert.deepEqual(trained(two, tk(plain)), ['<b>A1<|end|>', 'A2<|end|>'])
  assert.deepEqual(trained(two, tk(gemma)), ['<b>A1<|end|>', 'A2<|end|>'])
  assert.deepEqual(trained(two, tk(qwen)), ['<b>A1<|end|>', '\n</think>A2<|end|>'])
  assert.deepEqual(trained(two, tk(oss)), ['<b>A1<|end|>', 'A2<|return|>'])
  for (const t of [plain, gemma, qwen, oss]) assert.equal(text(two, tk(t)), t(two.messages, false))
})

test('Parquet labels: weight 0 is never trained, and a row with no assistant turn trains nothing (#6)', () => {
  const rec = { messages: two.messages.map((m, i) => (i === 1 ? { ...m, weight: 0 } : m)) }
  assert.deepEqual(trained(rec, tk(plain)), ['A2<|end|>'])
  assert.ok(!trained(rec, tk(plain), true).join('').includes('A1'))
  assert.deepEqual(trained({ messages: [{ role: 'user', content: 'Q' }] }, tk(plain)), [])
})

const toolRow = { messages: [{ role: 'user', content: 'Q' }, { role: 'assistant', content: '', tool_calls: [{ function: { name: 'f', arguments: '{"a":1}' } }] }, { role: 'tool', content: 'ok' }, { role: 'assistant', content: 'A' }] }
const objectArgs: Render = (ms, gen) => ms.map((m) => `<|${m.role}|>${m.content}${(m.tool_calls ?? []).map((c) => {
  if (typeof c.function.arguments === 'string') throw new Error('arguments must be a mapping')
  return `[${c.function.name} ${JSON.stringify(c.function.arguments)}]`
}).join('')}<|end|>`).join('') + (gen ? '<|assistant|>' : '')

test('Parquet labels: JSON-string tool arguments reach templates that want objects (#6)', () => {
  assert.deepEqual(trained(toolRow, tk(objectArgs)), ['[f {"a":1}]<|end|>', 'A<|end|>'])
  assert.ok(renderRecord(toolRow, 'conversational', tk(objectArgs))[0].includes('[f {"a":1}]'))
})

test('Parquet labels: rows that cannot be rendered or located throw (#6)', () => {
  const t = (r: Render, rec: Record<string, unknown>) => () => tokenizeRecord(rec, 'conversational', tk(r), false, 99)
  assert.throws(t(() => { throw new Error('roles must alternate') }, two), /rejects this row: roles must alternate/)
  // drops the content of the turn altogether
  assert.throws(t((ms, gen) => ms.map((m) => (m.role === 'user' ? m.content : '')).join('') + (gen ? '!' : ''), two), /message 2 \(assistant\)/)
  assert.throws(() => tokenizeRecord(toolRow, 'conversational', { ids: () => [], render: null }, false, 99), /no chat template/)
})
