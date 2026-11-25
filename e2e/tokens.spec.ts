import { parquetReadObjects } from 'hyparquet'
import { test, expect } from './test.ts'
import { chat, check, downloaded, exportAll, file, importFile, jsonl, lines, setModel, stat, statNote, step } from './helpers.ts'
import { serveTokenizer } from './hub.ts'

// Worked by hand with the stand-in tokenizer of hub.ts: each message costs 3 tokens plus one per word.
//   row 1: user 2 words (5) + assistant 1 (4)            =   9
//   row 2: user 1 (4)       + assistant 3 (6)            =  10
//   row 3: user 4 (7)       + assistant 2 (5)            =  12
//   row 4: user 1 (4) + assistant 1 (4) + user 1 (4) + assistant 180 (183) = 195
// Total 226, sorted 9 10 12 195: median 11, p95 at position 2.85 = 12 + 0.85 x 183 = 167.55 -> 168.
// At a limit of 128: 1 row over, 195 - 128 = 67 tokens cut. Training tokens 9 + 10 + 12 + 128 = 159.
const four = file('four.jsonl', jsonl(
  chat(['user', 'a b'], ['assistant', 'a']),
  chat(['user', 'a'], ['assistant', 'b a q']),
  chat(['user', 'a b a b'], ['assistant', 'q q']),
  chat(['user', 'q'], ['assistant', 'a'], ['user', 'b'], ['assistant', 'b '.repeat(180).trim()]),
))

test('token totals, the limit and the bill match the hand calculation', async ({ page, context }) => {
  await serveTokenizer(context)
  await importFile(page, four, 4)
  await step(page, 'Tokens')
  await expect(stat(page, 'Tokens')).toHaveText('226')
  await expect(stat(page, 'Median · p95')).toHaveText('11/ 168')
  await expect(statNote(page, 'Median · p95')).toHaveText('Max 195')
  await expect(stat(page, 'Over the limit')).toHaveText('0')
  await page.getByLabel('max_seq_length').fill('128')
  await expect(stat(page, 'Over the limit')).toHaveText('1')
  await expect(stat(page, 'Tokens cut')).toHaveText('67')

  await step(page, 'Split & cost')
  await page.getByRole('slider').fill('0')
  // 159 tokens x 3 epochs = 477, far below the $4 minimum of Qwen3.5 9B
  await expect(stat(page, 'Billed tokens')).toHaveText('477')
  await expect(stat(page, 'Estimated cost')).toHaveText('$4.00')
  await expect(statNote(page, 'Estimated cost')).toHaveText('Minimum charge for Qwen3.5 9B')
  // 159 x 100,000 = 15.9M tokens x $0.34 per million = $5.406
  await page.getByLabel('Epochs').fill('100000')
  await expect(stat(page, 'Billed tokens')).toHaveText('15.90M')
  await expect(stat(page, 'Estimated cost')).toHaveText('$5.41')
  // full fine-tuning: 15.9 x $0.38 = $6.042
  await page.getByRole('button', { name: 'Full', exact: true }).click()
  await expect(stat(page, 'Estimated cost')).toHaveText('$6.04')
  // 15.9M tokens at the assumed 6,000 tokens/s x 0.6 for full = 4,416.7 s = 1.2 h
  await expect(stat(page, 'Training time')).toHaveText('~1.2 h')
})

test('smart truncation drops the oldest exchange and keeps the final answer', async ({ page, context }) => {
  await serveTokenizer(context)
  await importFile(page, four, 4)
  await step(page, 'Tokens')
  // without its first exchange row 4 is 4 + 183 = 187 tokens
  await page.getByLabel('max_seq_length').fill('187')
  await expect(stat(page, 'Over the limit')).toHaveText('1')
  await page.getByRole('button', { name: 'Truncate smartly' }).click()
  await expect(stat(page, 'Over the limit')).toHaveText('0')
  await expect(statNote(page, 'Median · p95')).toHaveText('Max 187')
  const out = await exportAll(page)
  expect(out).toHaveLength(4)
  expect(out[3]).toEqual(chat(['user', 'b'], ['assistant', 'b '.repeat(180).trim()]))
  await expect(check(page)).toContainText('Everything fits in 187 tokens')
})

test('pre-tokenized Parquet holds the hand-worked ids and masks everything but the answer', async ({ page, context }) => {
  await serveTokenizer(context)
  await importFile(page, file('one.jsonl', jsonl(chat(['user', 'q'], ['assistant', 'a b']))), 1)
  await step(page, 'Tokens')
  await expect(stat(page, 'Tokens')).toHaveText('9')
  await step(page, 'Export')
  await page.getByRole('button', { name: 'Parquet' }).click()
  const { bytes, name } = await downloaded(page, page.getByRole('button', { name: 'Everything in one file' }))
  expect(name).toBe('e2e.parquet')
  const rows = await parquetReadObjects({ file: new Uint8Array(bytes).buffer as ArrayBuffer })
  // <s> user q </s> <s> assistant | a b </s>
  expect(rows).toEqual([{ input_ids: [1, 3, 5, 2, 1, 4, 6, 7, 2], attention_mask: [1, 1, 1, 1, 1, 1, 1, 1, 1], labels: [-100, -100, -100, -100, -100, -100, 6, 7, 2] }])
})

test('models without a browser tokenizer give a labelled estimate of 3.6 characters per token, and no Parquet', async ({ page }) => {
  // "p" x 30 + "c" x 6 = 36 characters = 10 tokens
  await importFile(page, file('e.jsonl', jsonl({ prompt: 'p'.repeat(30), completion: 'c'.repeat(6) })), 1)
  await setModel(page, 'Kimi K2.6')
  await expect(page.locator('.toolbar').getByText('estimate')).toBeVisible()
  await step(page, 'Tokens')
  await expect(stat(page, 'Tokens')).toHaveText('10')
  await step(page, 'Export')
  await page.getByRole('button', { name: 'Parquet' }).click()
  await page.getByRole('button', { name: 'Everything in one file' }).click()
  await expect(page.getByText('Parquet export needs the exact tokenizer for this model.')).toBeVisible()
})

test('a tokenizer that cannot be downloaded is named as the problem', async ({ page }) => {
  await importFile(page, four, 4)
  await step(page, 'Tokens')
  await expect(page.getByRole('heading', { name: 'Tokenizer failed to load' })).toBeVisible()
  await step(page, 'Split & cost')
  await expect(page.getByText('Token counts are needed for a cost estimate.')).toBeVisible()
})

// 20 rows of A and 10 of B at 10% = 2 + 1 in validation.
test('the stratified split is 27 and 3, disjoint, complete and repeatable', async ({ page }) => {
  const rows = [...Array(30).keys()].map((i) => ({ prompt: `Case ${i * 7919}`, completion: `Reply ${i * 104729}`, label: i < 20 ? 'A' : 'B' }))
  await importFile(page, file('split.jsonl', jsonl(...rows)), 30)
  await step(page, 'Split & cost')
  await expect(page.locator('.legend')).toContainText('Train 27')
  await expect(page.locator('.legend')).toContainText('Validation 3')
  await expect(page.locator('tr', { hasText: /^A/ })).toHaveText('A20210%')
  await expect(page.locator('tr', { hasText: /^B/ })).toHaveText('B10110%')
  await step(page, 'Export')
  const get = async (n: string) => lines((await downloaded(page, page.getByRole('button', { name: n }))).text).map((r) => r.prompt as string)
  const train = await get('e2e.train.jsonl'), val = await get('e2e.validation.jsonl')
  expect(train).toHaveLength(27)
  expect(val).toHaveLength(3)
  expect([...train, ...val].sort()).toEqual(rows.map((r) => r.prompt).sort())
  expect(await get('e2e.validation.jsonl')).toEqual(val)
  await step(page, 'Split & cost')
  await page.getByLabel('Seed').fill('7')
  await step(page, 'Export')
  await expect(async () => expect(await get('e2e.validation.jsonl')).not.toEqual(val)).toPass()
})

// Worked by hand: q + 100 words = 4 + 103 = 107, q + b = 4 + 4 = 8, both sides 115. At a limit of 128 nothing is cut; the second
// pair is 4 + 153 = 157 and 8: 165 in total, 29 cut, 136 billed. Together 280 tokens, 115 + 136 = 251 billed for one epoch.
test('DPO pairs: totals and the bill count both sides, each cut at the limit (#10)', async ({ page, context }) => {
  await serveTokenizer(context)
  const pair = (n: number) => ({ prompt: 'q', chosen: 'a '.repeat(n).trim(), rejected: 'b' })
  await importFile(page, file('dpo.jsonl', jsonl(pair(100), pair(150))), 2)
  await step(page, 'Tokens')
  await page.getByLabel('max_seq_length').fill('128')
  await page.getByLabel('max_seq_length').blur()
  await expect(stat(page, 'Tokens')).toHaveText('280')
  await expect(stat(page, 'Tokens cut')).toHaveText('29')
  await expect(stat(page, 'Over the limit')).toHaveText('1')
  await expect(statNote(page, 'Median · p95')).toHaveText('Max 157 per side')
  await step(page, 'Split & cost')
  await page.getByRole('slider').fill('0')
  await page.getByLabel('Epochs').fill('1')
  await expect(stat(page, 'Billed tokens')).toHaveText('251')
})
