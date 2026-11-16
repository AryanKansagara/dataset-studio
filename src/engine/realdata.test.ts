// Layouts of public Hugging Face datasets, as returned by the datasets-server rows API and parquet export
// (checked 2026-11-16). Text is shortened; keys, nesting and quirks match the real rows.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyMapping, suggestMapping } from './mapping.ts'
import { validateRecord } from './validate.ts'
import { rowsFromBytes } from './ingest.ts'
import { getModel } from './rules.ts'
import { estimateCost } from './cost.ts'

const map = (rows: Record<string, unknown>[]) => {
  const m = suggestMapping(Object.keys(rows[0]), rows)
  return { m, recs: rows.map((r) => applyMapping(r, m)) }
}
const codes = (rec: Record<string, unknown>, fmt: Parameters<typeof validateRecord>[1]) => validateRecord(rec, fmt).map((i) => i.code)

test('tatsu-lab/alpaca: the pre-rendered "text" column does not hide instruction/input/output', () => {
  const row = { instruction: 'Give three tips for staying healthy.', input: '', output: '1. Eat a balanced diet.', text: 'Below is an instruction that describes a task. ...' }
  const { m, recs } = map([row])
  assert.equal(m.format, 'instruction')
  assert.equal(m.identity, false)
  assert.deepEqual(recs[0].rec, { prompt: 'Give three tips for staying healthy.', completion: '1. Eat a balanced diet.' })
})

test('HuggingFaceH4/no_robots: metadata columns are dropped, category becomes the label', () => {
  const row = { prompt: 'Please summarize...', prompt_id: '627a77298b', messages: [{ content: 'Please summarize...', role: 'user' }, { content: 'Scientists hope to...', role: 'assistant' }], category: 'Summarize' }
  const { m, recs } = map([row])
  assert.equal(m.format, 'conversational')
  assert.equal(m.identity, false)
  assert.deepEqual(Object.keys(recs[0].rec), ['messages'])
  assert.equal(recs[0].label, 'Summarize')
  assert.deepEqual(codes(recs[0].rec, 'conversational'), [])
})

test('trl-lib/ultrafeedback_binarized: whole-conversation chosen/rejected map to DPO, not chat', () => {
  const row = {
    chosen: [{ content: 'Write Snake in pygame', role: 'user' }, { content: 'Sure, here is an outline', role: 'assistant' }],
    rejected: [{ content: 'Write Snake in pygame', role: 'user' }, { content: 'Snake is a classic game', role: 'assistant' }],
    score_chosen: 6, score_rejected: 4,
  }
  const { m, recs } = map([row])
  assert.equal(m.format, 'preference')
  assert.deepEqual(recs[0].rec, {
    input: { messages: [{ content: 'Write Snake in pygame', role: 'user' }] },
    preferred_output: [{ content: 'Sure, here is an outline', role: 'assistant' }],
    non_preferred_output: [{ content: 'Snake is a classic game', role: 'assistant' }],
  })
  assert.deepEqual(codes(recs[0].rec, 'preference'), [])
})

test('argilla/distilabel-intel-orca-dpo-pairs: input + system columns, and a JSON-looking answer stays text', () => {
  const row = {
    system: 'You are an AI assistant.', input: 'Convert the sentence to RDF triplets.',
    chosen: '[\n  ["AFC Ajax (amateurs)", "has ground", "Sportpark De Toekomst"]\n]', rejected: ' Sure! Here are the triplets.',
    labelling_prompt: [{ content: 'You are a helpful and precise assistant for checking the quality of the answer.', role: 'system' }, { content: '[Question] ...', role: 'user' }],
    rating: [10, 7], status: 'tie',
  }
  const { m, recs } = map([row])
  assert.equal(m.format, 'preference')
  assert.equal(m.prompt, 'input')
  assert.equal(m.system, 'system')
  const rec = recs[0].rec as { input: { messages: { role: string; content: string }[] }; preferred_output: { content: string }[] }
  assert.deepEqual(rec.input.messages.map((x) => x.role), ['system', 'user'])
  assert.equal(rec.preferred_output[0].content, row.chosen)
  assert.deepEqual(codes(recs[0].rec, 'preference'), [])
})

test('teknium/OpenHermes-2.5: ShareGPT turns with "weight": null convert without weight errors', () => {
  const row = { category: 'orca', conversations: [{ from: 'human', value: 'Every day, a tree drops 7 leaves...', weight: null }, { from: 'gpt', value: "Here's the logic...", weight: null }], system_prompt: null, model: null }
  const { m, recs } = map([row])
  assert.equal(m.messages, 'conversations')
  assert.deepEqual(recs[0].rec.messages, [{ role: 'user', content: 'Every day, a tree drops 7 leaves...' }, { role: 'assistant', content: "Here's the logic..." }])
  assert.deepEqual(codes(recs[0].rec, 'conversational'), [])
})

test('databricks-dolly-15k as CSV: quoted multi-line context, category label, instruction format', async () => {
  const csv = 'instruction,context,response,category\r\n"When did Virgin Australia start operating?","Virgin Australia, the trading name of ""Virgin Australia Airlines"", is an airline.\nIt commenced services on 31 August 2000.","Virgin Australia commenced services on 31 August 2000.",closed_qa\r\nWhich is a species of fish? Tope or Rope,,Tope,classification\r\n'
  const { rows, mapping } = await rowsFromBytes('csv', new TextEncoder().encode(csv))
  assert.equal(mapping.format, 'instruction')
  assert.equal(mapping.label, 'category')
  assert.equal(rows.length, 2)
  assert.equal(rows[0].rec!.prompt, 'When did Virgin Australia start operating?\n\nVirgin Australia, the trading name of "Virgin Australia Airlines", is an airline.\nIt commenced services on 31 August 2000.')
  assert.equal(rows[1].rec!.prompt, 'Which is a species of fish? Tope or Rope')
  assert.equal(rows[1].label, 'classification')
})

test('real-data defects are caught: identical DPO pair and an empty rejected answer (ultrafeedback rows 31 and 59)', () => {
  const same = { chosen: [{ role: 'user', content: 'Pick A-D' }, { role: 'assistant', content: 'C' }], rejected: [{ role: 'user', content: 'Pick A-D' }, { role: 'assistant', content: 'C' }] }
  const empty = { chosen: [{ role: 'user', content: 'cook : ?' }, { role: 'assistant', content: 'pan' }], rejected: [{ role: 'user', content: 'cook : ?' }, { role: 'assistant', content: '' }] }
  const { recs } = map([same, empty])
  assert.ok(codes(recs[0].rec, 'preference').includes('E_DPO_OUTPUT'))
  assert.ok(codes(recs[1].rec, 'preference').includes('E_EMPTY_TURN'))
})

test('Together-shaped DPO rows with an extra id column keep their input messages', () => {
  const row = { id: 7, input: { messages: [{ role: 'user', content: 'Hi' }] }, preferred_output: [{ role: 'assistant', content: 'Hello!' }], non_preferred_output: [{ role: 'assistant', content: 'What.' }] }
  const { m, recs } = map([row])
  assert.equal(m.format, 'preference')
  assert.deepEqual(recs[0].rec, { input: { messages: [{ role: 'user', content: 'Hi' }] }, preferred_output: [{ role: 'assistant', content: 'Hello!' }], non_preferred_output: [{ role: 'assistant', content: 'What.' }] })
})

test('pricing page rows checked 2026-11-16: GLM 5.1 and Kimi K2.7 Code, with their minimum charge', () => {
  const glm = getModel('zai-org/GLM-5.1')
  assert.equal(glm.id, 'zai-org/GLM-5.1')
  const c = estimateCost({ model: glm, method: 'dpo', lora: true, epochs: 2, nEvals: 0, trainTokens: 1_000_000, valTokens: 0 })
  assert.equal(c.raw, 200)
  const k = estimateCost({ model: getModel('moonshotai/Kimi-K2.7-Code'), method: 'sft', lora: true, epochs: 1, nEvals: 0, trainTokens: 1_000_000, valTokens: 0 })
  assert.equal(k.total, 60)
  assert.ok(k.minApplied)
})
