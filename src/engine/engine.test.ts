import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readJsonl, readCsv, readJson, sniffKind, fromBytes, type RawItem } from './parse.ts'
import { applyMapping, suggestMapping, toMessages } from './mapping.ts'
import { validateRecord } from './validate.ts'
import { detectLanguage, findPii, isRefusal, labelStats, minhash, nearDuplicateClusters, outlierBounds, redact, shingles, jaccard, sigSimilarity } from './quality.ts'
import { analyze, applyOps, cachedCounter, repairRecord, splitRows, stripUnknown, findLeaks, type Row } from './pipeline.ts'
import { countRecord, histogram, smartTruncate, tokenizeRecord, tokenStats, type TokenizerLike } from './tokens.ts'
import { estimateCost } from './cost.ts'
import { cliCommands, pythonCommands, datasetCard, DEFAULT_JOB, limitFor } from './exporters.ts'
import { compareVersions, histShift, statsOf } from './compare.ts'
import { messySupportSample } from './sample.ts'
import { rowsFromBytes } from './ingest.ts'
import { getModel, MODELS, TOGETHER_SDK_VERSION } from './rules.ts'

const enc = (s: string) => new TextEncoder().encode(s)
async function all<T>(g: AsyncIterable<T>): Promise<T[]> { const out: T[] = []; for await (const x of g) out.push(x); return out }

// A deterministic fake tokenizer: one token per word, ChatML-like template.
const fakeTk: TokenizerLike = {
  ids: (t) => t.split(/\s+/).filter(Boolean).map((w) => w.length),
  render: (msgs, o) => (msgs as { role: string; content: string }[]).map((m) => `<s> ${m.role} ${m.content} </s>`).join(' ') + (o?.addGenerationPrompt ? ' <s> assistant' : ''),
  eos: ' </s>',
}

const conv = (...turns: [string, string][]) => ({ messages: turns.map(([role, content]) => ({ role, content })) })
const row = (id: number, rec: Record<string, unknown> | null, label?: string): Row => ({ id, line: id + 1, bytes: 100, rec, label })

// ---------- parsing ----------

test('JSONL: line numbers survive blank lines, chunk splits and CRLF; bad lines are reported', async () => {
  const text = '{"text":"a"}\r\n\n{"text":"b"}\n{oops\n[1,2]\n{"text":"c"}'
  const items = await all(readJsonl(fromBytes(enc(text), 3)))
  assert.deepEqual(items.map((i) => i.line), [1, 3, 4, 5, 6])
  assert.equal(items[2].error, 'E_JSON')
  assert.equal(items[3].error, 'E_NOT_OBJECT')
  assert.deepEqual(items[4].value, { text: 'c' })
})

test('JSONL: invalid UTF-8 bytes are flagged but the line still parses', async () => {
  const good = enc('{"text":"caf')
  const bytes = new Uint8Array([...good, 0xff, ...enc('e"}\n')])
  const [it] = await all(readJsonl(fromBytes(bytes)))
  assert.equal(it.badUtf8, true)
  assert.ok(it.value)
})

test('CSV: quoted commas, escaped quotes and embedded newlines', async () => {
  const csv = 'question,answer\n"Hi, there","He said ""ok""\nthen left"\nq2,a2\n'
  const items = await all(readCsv(fromBytes(enc(csv), 5)))
  assert.equal(items.length, 2)
  assert.deepEqual(items[0].value, { question: 'Hi, there', answer: 'He said "ok"\nthen left' })
  assert.equal(items[0].line, 2)
  assert.equal(items[1].line, 4)
})

test('JSON: array or wrapped array; sniffing picks the right reader', () => {
  assert.equal(readJson('{"data":[{"a":1},{"a":2}]}').length, 2)
  assert.equal(sniffKind('x.txt', enc('[{"a":1}]')), 'json')
  assert.equal(sniffKind('x', enc('{"a":1}\n{"a":2}')), 'jsonl')
  assert.equal(sniffKind('x', enc('PAR1....')), 'parquet')
  assert.equal(sniffKind('data.csv', enc('a,b')), 'csv')
})

// ---------- mapping ----------

test('mapping: Together-native rows pass through untouched (identity)', () => {
  const m = suggestMapping(['messages', 'category'], [{ messages: [{ role: 'user', content: 'hi' }], category: 'x' }])
  assert.equal(m.identity, true)
  assert.equal(m.format, 'conversational')
  assert.equal(m.label, 'category')
})

test('mapping: question/answer columns become a chat with an optional system prompt', () => {
  const m = suggestMapping(['question', 'answer'], [{ question: 'q', answer: 'a' }])
  assert.equal(m.format, 'conversational')
  const { rec } = applyMapping({ question: 'q', answer: 'a' }, { ...m, systemText: 'Be nice' })
  assert.deepEqual(rec, { messages: [{ role: 'system', content: 'Be nice' }, { role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }] })
})

test('mapping: Alpaca instruction/input/output and chosen/rejected preference', () => {
  const m = suggestMapping(['instruction', 'input', 'output'], [{ instruction: 'Sum', input: '1 2', output: '3' }])
  assert.equal(m.format, 'instruction')
  assert.deepEqual(applyMapping({ instruction: 'Sum', input: '1 2', output: '3' }, m).rec, { prompt: 'Sum\n\n1 2', completion: '3' })
  const p = suggestMapping(['prompt', 'chosen', 'rejected'], [{ prompt: 'p', chosen: 'good', rejected: 'bad' }])
  assert.equal(p.format, 'preference')
  const rec = applyMapping({ prompt: 'p', chosen: 'good', rejected: 'bad' }, p).rec
  assert.deepEqual(validateRecord(rec, 'preference'), [])
})

test('mapping: fuzzy column names (customer_question / agent_answer) and a label column', () => {
  const m = suggestMapping(['ticket', 'customer_question', 'agent_answer', 'intent'], [{ ticket: 'T-1', customer_question: 'q', agent_answer: 'a', intent: 'billing' }])
  assert.equal(m.format, 'conversational')
  assert.equal(m.user, 'customer_question')
  assert.equal(m.assistant, 'agent_answer')
  assert.equal(m.label, 'intent')
})

test('mapping: ShareGPT conversations (from/value), including JSON-encoded CSV cells', () => {
  const msgs = toMessages(JSON.stringify([{ from: 'human', value: 'hi' }, { from: 'gpt', value: 'hello' }]))
  assert.deepEqual(msgs, [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }])
})

// ---------- validation ----------

test('validate: a clean conversation has no issues', () => {
  assert.deepEqual(validateRecord(conv(['system', 's'], ['user', 'u'], ['assistant', 'a']), 'conversational'), [])
})

test('validate: role order, empty turns, unknown roles and keys, missing final assistant', () => {
  const codes = (r: Record<string, unknown>) => validateRecord(r, 'conversational').map((i) => i.code)
  assert.ok(codes(conv(['assistant', 'hi'], ['user', 'u'], ['assistant', 'a'])).includes('E_ROLE_ORDER'))
  assert.ok(codes(conv(['user', 'u'], ['user', 'u2'], ['assistant', 'a'])).includes('E_ROLE_ORDER'))
  assert.ok(codes(conv(['user', '  '], ['assistant', 'a'])).includes('E_EMPTY_TURN'))
  assert.ok(codes(conv(['customer', 'u'], ['assistant', 'a'])).includes('E_ROLE'))
  assert.ok(codes(conv(['user', 'u'], ['assistant', 'a'], ['user', 'more?'])).includes('W_FINAL_NOT_ASSISTANT'))
  assert.ok(codes(conv(['user', 'u'])).includes('E_NO_ASSISTANT'))
  assert.ok(codes({ ...conv(['user', 'u'], ['assistant', 'a']), ticket: 1 }).includes('W_UNKNOWN_KEY'))
  assert.ok(codes({ messages: [{ role: 'user', content: 'u', weight: 2 }, { role: 'assistant', content: 'a' }] }).includes('E_WEIGHT'))
})

test('validate: tool calls may replace content; mixed formats are rejected', () => {
  const r = { messages: [{ role: 'user', content: 'weather?' }, { role: 'assistant', tool_calls: [{ id: '1', type: 'function', function: { name: 'w', arguments: '{}' } }] }, { role: 'tool', tool_call_id: '1', content: 'sunny' }, { role: 'assistant', content: 'Sunny.' }], tools: [] }
  assert.deepEqual(validateRecord(r, 'conversational'), [])
  assert.equal(validateRecord({ text: 'x' }, 'conversational')[0].code, 'E_MIXED_FORMAT')
})

test('validate: preference outputs need exactly one assistant message', () => {
  const bad = { input: { messages: [{ role: 'user', content: 'q' }] }, preferred_output: [{ role: 'assistant', content: 'a' }, { role: 'assistant', content: 'b' }], non_preferred_output: [{ role: 'assistant', content: 'c' }] }
  assert.ok(validateRecord(bad, 'preference').some((i) => i.code === 'E_DPO_OUTPUT'))
})

// ---------- quality ----------

test('PII: emails, phones, Luhn-valid cards and API keys are found and redacted; order numbers are not', () => {
  const t = 'mail jo@acme.io or +1 415-555-0132, card 4111 1111 1111 1111, key sk-proj-abcdefghijklmnopqrstuvwx, AKIAIOSFODNN7EXAMPLE, order #PC-12345, card 1234 5678 9012 3456'
  const kinds = findPii(t).map((h) => h.kind)
  assert.deepEqual(kinds.sort(), ['card', 'email', 'phone', 'secret', 'secret'].sort())
  const out = redact(t).text
  assert.ok(out.includes('[EMAIL]') && out.includes('[SECRET]') && out.includes('#PC-12345'))
  assert.ok(!out.includes('jo@acme.io'))
})

test('MinHash: near-duplicates cluster, unrelated texts do not', () => {
  const a = 'Where is my order? Tracking has not updated in four days and I am getting worried about it.'
  const b = 'Where is my order?? Tracking has not updated in four days and I am getting worried about it.'
  const c = 'How do I delete my account and all of my personal data from your service permanently?'
  const sa = shingles(a), sb = shingles(b), sc = shingles(c)
  assert.ok(jaccard(sa, sb) > 0.7)
  const sigs = [minhash(sa), minhash(sb), minhash(sc)]
  assert.ok(sigSimilarity(sigs[0], sigs[1]) > 0.6)
  const cl = nearDuplicateClusters(sigs, 0.6)
  assert.equal(cl[0], cl[1])
  assert.equal(cl[2], -1)
})

test('refusals, language detection, outlier bounds and label stats', () => {
  assert.ok(isRefusal('As an AI language model, I cannot access your account.'))
  assert.ok(!isRefusal('Sure, here is how to reset it.'))
  assert.equal(detectLanguage('¿Dónde está mi pedido? El seguimiento no se actualiza desde hace días para mi casa.'), 'es')
  assert.equal(detectLanguage('我的订单什么时候到？物流信息好几天没有更新了。'), 'zh')
  assert.equal(detectLanguage('Where is my order and when will it arrive at the house?'), 'en')
  const lens = [...Array(50)].map((_, i) => 200 + i * 3).concat([5, 40000])
  const b = outlierBounds(lens)
  assert.ok(b.lo > 5 && b.hi < 40000)
  const ls = labelStats([], [...Array(30)].map((_, i) => (i < 27 ? 'positive' : 'negative')))
  assert.equal(ls.source, 'answer')
  assert.equal(ls.ratio, 9)
})

// ---------- pipeline ----------

test('repair: trims, merges same-role turns, drops leading assistant and trailing user turns', () => {
  const rec = conv(['system', 's'], ['assistant', 'Hi!'], ['user', ' a '], ['user', 'b'], ['assistant', 'x'], ['user', 'still there?'])
  const out = repairRecord(rec, 'conversational')
  assert.deepEqual(out.messages, [{ role: 'system', content: 's' }, { role: 'user', content: 'a\n\nb' }, { role: 'assistant', content: 'x' }])
  assert.deepEqual(validateRecord(out, 'conversational'), [])
})

test('strip unknown keys keeps only documented fields', () => {
  const out = stripUnknown({ messages: [{ role: 'user', content: 'u', ts: 1 }, { role: 'assistant', content: 'a' }], category: 'x', weight: 1 }, 'conversational')
  assert.deepEqual(out, { messages: [{ role: 'user', content: 'u' }, { role: 'assistant', content: 'a' }], weight: 1 })
})

test('split: seeded, stable, stratified by label, exact fraction per stratum', () => {
  const rows = [...Array(100)].map((_, i) => row(i, conv(['user', `q${i}`], ['assistant', 'a']), i < 80 ? 'big' : 'small'))
  const s = { valFraction: 0.1, seed: 42, stratify: true }
  const v1 = splitRows(rows, s)
  assert.equal(v1.size, 10)
  assert.equal([...v1].filter((id) => id >= 80).length, 2)
  assert.deepEqual([...splitRows(rows, s)].sort(), [...v1].sort())
  assert.notDeepEqual([...splitRows(rows, { ...s, seed: 7 })].sort(), [...v1].sort())
})

test('leakage: validation rows that duplicate train are found and dropped by the op', () => {
  const rows = [...Array(40)].map((_, i) => row(i, conv(['user', `Unique question number ${i} about my parcel order status today`], ['assistant', `a${i}`])))
  for (let i = 40; i < 60; i++) rows.push(row(i, conv(['user', 'The very same repeated question about my parcel order status today'], ['assistant', 'same'])))
  const split = { valFraction: 0.25, seed: 1, stratify: false }
  const val = splitRows(rows, split)
  assert.ok(findLeaks(rows, val, 'conversational').size > 0)
  const res = applyOps(rows, [{ type: 'dropLeakage' }], { format: 'conversational', split })
  assert.equal(findLeaks(res.rows, res.val, 'conversational').size, 0)
})

test('undo log: ops are recorded with drop counts and the source lines that were dropped', () => {
  const rows = [row(0, conv(['user', 'q'], ['assistant', 'a'])), row(1, conv(['user', 'q'], ['assistant', 'a'])), row(2, null)]
  rows[2].parseError = 'E_JSON'
  const res = applyOps(rows, [{ type: 'dedupeExact' }, { type: 'dropInvalid' }], { format: 'conversational', split: { valFraction: 0, seed: 1, stratify: false } })
  assert.equal(res.rows.length, 1)
  assert.deepEqual(res.log.map((l) => [l.dropped, l.droppedLines]), [[1, [2]], [1, [3]]])
  assert.equal(res.dropped.size, 2)
})

test('rebalance caps majority labels at maxRatio x minority', () => {
  const rows = [...Array(60)].map((_, i) => row(i, conv(['user', `q${i}`], ['assistant', `a${i}`]), i < 50 ? 'a' : 'b'))
  const res = applyOps(rows, [{ type: 'rebalance', maxRatio: 2 }], { format: 'conversational', split: { valFraction: 0, seed: 3, stratify: false } })
  assert.equal(res.rows.filter((r) => r.label === 'a').length, 20)
  assert.equal(res.rows.filter((r) => r.label === 'b').length, 10)
})

// ---------- tokens ----------

test('tokens: chat template counts, stats flag rows over the limit and the tokens cut', () => {
  const rec = conv(['user', 'one two three'], ['assistant', 'four five'])
  assert.deepEqual(countRecord(rec, 'conversational', fakeTk), [11]) // 5 content words + 6 template tokens
  const st = tokenStats([10, 20, 30, 200], 100)
  assert.equal(st.over, 1)
  assert.equal(st.cut, 100)
  assert.equal(st.billable, 160)
  assert.equal(histogram([8, 9, 1000]).reduce((a, b) => a + b, 0), 3)
})

test('smart truncation drops the oldest exchanges, keeps the system prompt, and gives up when the answer alone is too long', () => {
  const long = 'w '.repeat(50)
  const rec = conv(['system', 'sys'], ['user', long], ['assistant', long], ['user', 'short q'], ['assistant', 'short a'])
  const out = smartTruncate(rec, 'conversational', fakeTk, 30)!
  assert.deepEqual((out.messages as { content: string }[]).map((m) => m.content), ['sys', 'short q', 'short a'])
  assert.equal(smartTruncate(conv(['user', 'q'], ['assistant', long]), 'conversational', fakeTk, 20), null)
  const ins = smartTruncate({ prompt: long + 'END', completion: 'ans' }, 'instruction', fakeTk, 10)!
  assert.ok(String(ins.prompt).endsWith('END'))
})

test('pre-tokenized encoding masks everything except assistant turns', () => {
  const t = tokenizeRecord(conv(['user', 'a b c'], ['assistant', 'd e']), 'conversational', fakeTk, false, 1000)
  assert.equal(t.input_ids.length, t.labels.length)
  const trained = t.labels.filter((l) => l !== -100).length
  assert.ok(trained > 0 && trained < t.labels.length)
  const all = tokenizeRecord(conv(['user', 'a b c'], ['assistant', 'd e']), 'conversational', fakeTk, true, 1000)
  assert.equal(all.labels.filter((l) => l === -100).length, 0)
})

// ---------- cost / export ----------

test('cost: tokens x epochs + validation x evals at the published price, with the minimum charge', () => {
  const m = getModel('Qwen/Qwen3.5-9B')
  const c = estimateCost({ model: m, method: 'sft', lora: true, epochs: 3, nEvals: 5, trainTokens: 10_000_000, valTokens: 500_000 })
  assert.equal(c.billedTokens, 32_500_000)
  assert.ok(Math.abs(c.total! - 32.5 * 0.34) < 1e-9)
  const small = estimateCost({ model: m, method: 'sft', lora: true, epochs: 1, nEvals: 0, trainTokens: 1000, valTokens: 0 })
  assert.equal(small.total, 4)
  assert.equal(small.minApplied, true)
  assert.equal(estimateCost({ model: getModel('Qwen/Qwen3.5-35B-A3B'), method: 'sft', lora: false, epochs: 1, nEvals: 0, trainTokens: 1, valTokens: 0 }).total, null)
})

test('commands: pinned version and the right flags for SFT and DPO', () => {
  const sft = cliCommands({ ...DEFAULT_JOB, maxSeq: 4096, suffix: 'support-v2' }, { train: 'train.jsonl', val: 'validation.jsonl' }, 'conversational')
  assert.ok(sft.includes(`together[cli]==${TOGETHER_SDK_VERSION}`))
  for (const f of ['--training-file train.jsonl', '--validation-file validation.jsonl', '--n-evals 5', '--lora', '--n-epochs 3', '--train-on-inputs auto', '--max-seq-length 4096', '--suffix "support-v2"']) assert.ok(sft.includes(f), f)
  const dpo = pythonCommands({ ...DEFAULT_JOB, method: 'dpo' }, { train: 'train.jsonl', val: null }, 'preference')
  assert.ok(dpo.includes('training_method="dpo"') && dpo.includes('dpo_beta=0.1') && !dpo.includes('train_on_inputs'))
  assert.equal(limitFor({ ...DEFAULT_JOB, maxSeq: 999999 }), getModel(DEFAULT_JOB.model).ctxSft)
})

test('every model has a context length and a tokenizer repo or an explicit null', () => {
  for (const m of MODELS) { assert.ok(m.ctxSft > 0 && m.ctxDpo > 0, m.id); assert.ok(m.tokenizer === null || m.tokenizer.includes('/')) }
})

// ---------- end to end on the messy sample ----------

test('end to end: the messy sample surfaces every planted problem, and the fix pipeline clears them', async () => {
  const sample = messySupportSample(1200, 7)
  const { rows, mapping } = await rowsFromBytes('jsonl', sample.bytes)
  assert.equal(mapping.identity, true)
  assert.equal(mapping.label, 'category')
  const ctx = { format: 'conversational' as const, split: { valFraction: 0.1, seed: 42, stratify: true }, tokenizer: fakeTk, tokens: cachedCounter('conversational', fakeTk) }
  const { report } = analyze(rows, [], ctx, { limit: 4096 })
  const c = report.issues.byCode
  for (const code of ['E_JSON', 'E_UTF8', 'E_ROLE_ORDER', 'E_EMPTY_TURN', 'E_ROLE', 'W_FINAL_NOT_ASSISTANT', 'W_UNKNOWN_KEY'] as const) assert.ok((c[code] ?? 0) > 0, code)
  assert.ok(report.quality.exactDup.rows > 0)
  assert.ok(report.quality.nearDup.rows > 0)
  assert.ok(report.quality.pii.rows > 0)
  assert.ok(report.quality.refusals.rows > 0)
  assert.ok(report.quality.language.minorityRows > 0)
  assert.ok(report.quality.labels.ratio > 5)
  assert.ok(report.tokens!.over > 0)

  const ops = [
    { type: 'repairStructure' }, { type: 'stripUnknownKeys' }, { type: 'dropInvalid' }, { type: 'dedupeExact' },
    { type: 'dedupeNear', threshold: 0.8 }, { type: 'redactPii', kinds: ['email', 'phone', 'card', 'secret', 'ip'] },
    { type: 'dropRefusals' }, { type: 'filterLanguage', keep: ['en'] }, { type: 'truncate', limit: 4096 }, { type: 'dropLeakage' },
  ] as const
  const fixed = analyze(rows, ops as never, ctx, { limit: 4096 }).report
  assert.equal(fixed.issues.rowsWithErrors, 0)
  assert.equal(fixed.quality.exactDup.rows, 0)
  assert.equal(fixed.quality.pii.rows, 0)
  assert.equal(fixed.quality.refusals.rows, 0)
  assert.equal(fixed.quality.leakage.rows, 0)
  assert.equal(fixed.tokens!.over, 0)
  assert.ok(fixed.rows > 900)
  assert.ok(fixed.dropped.length > 0)

  const d = compareVersions(statsOf(report), statsOf(fixed))
  assert.ok(d.find((x) => x.key === 'errors')!.b < d.find((x) => x.key === 'errors')!.a)
  assert.ok(histShift(report.tokens!.hist, fixed.tokens!.hist).tvd >= 0)
  const card = datasetCard({ name: 'Support bot', source: 'sample', job: DEFAULT_JOB, report: fixed, versionLabel: 'v2', createdAt: '2026-11-07T00:00:00Z' })
  assert.ok(card.includes('# Support bot') && card.includes('Remove exact duplicates'))
})

test('sample is deterministic', () => {
  const a = messySupportSample(200, 3), b = messySupportSample(200, 3)
  assert.deepEqual(a.bytes, b.bytes)
  assert.deepEqual(a.planted, b.planted)
})

void ({} as RawItem)
