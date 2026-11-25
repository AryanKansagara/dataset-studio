import { test, expect } from './test.ts'
import { chat, exportAll, file, importFile, jsonl, log, quality, stat, step } from './helpers.ts'

const big = (card: ReturnType<typeof quality>) => card.locator('.big')

test('PII and secrets: one row per kind is found, and redaction rewrites only the hits', async ({ page }) => {
  // 4111 1111 1111 1111 passes the Luhn check (digits from the left: 4x2=8, then 1x2=2 seven times, plus 1 eight times: 8+14+8 = 30);
  // 1234 5678 9012 3456 does not (its sum is 64), so it stays.
  await importFile(page, file('pii.jsonl', jsonl(
    { prompt: 'Write to jo@acme.io please', completion: 'Sent it.' },
    { prompt: 'Ring +1 415-555-0132 today', completion: 'Called them.' },
    { prompt: 'They charged card 4111 1111 1111 1111.', completion: 'Refunded it.' },
    { prompt: 'Card 1234 5678 9012 3456 is a fake', completion: 'Noted.' },
    { prompt: 'Login from 10.1.2.3 failed', completion: 'Blocked that.' },
    { prompt: 'The key sk-proj-abcdefghijklmnopqrstuvwx leaked', completion: 'Rotated.' },
  )), 6)
  await step(page, 'Quality')
  const card = quality(page, 'PII and secrets')
  await expect(big(card)).toHaveText('5')
  for (const k of ['Email address · 1', 'Phone number · 1', 'Card number · 1', 'IP address · 1', 'API key / secret · 1']) await expect(card).toContainText(k)
  await card.getByRole('button', { name: 'Redact all' }).click()
  await expect(big(card)).toHaveText('0')
  expect((await exportAll(page)).map((r) => r.prompt)).toEqual([
    'Write to [EMAIL] please', 'Ring [PHONE] today', 'They charged card [CARD].', 'Card 1234 5678 9012 3456 is a fake', 'Login from [IP] failed', 'The key [SECRET] leaked',
  ])
})

test('near-duplicates, refusals, language mix and length outliers are found and fixed', async ({ page }) => {
  const q = (i: number) => `Question number ${['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'][i]} concerns the ${['lamp', 'desk', 'sofa', 'door', 'roof', 'sink', 'wall', 'oven'][i]} that you sold to me`
  const a = (i: number) => `You can return the ${['lamp', 'desk', 'sofa', 'door', 'roof', 'sink', 'wall', 'oven'][i]} to us for a refund.`
  await importFile(page, file('q.jsonl', jsonl(
    ...[...Array(8).keys()].map((i) => chat(['user', q(i)], ['assistant', a(i)])),
    chat(['user', 'The lamp is broken and I would like to have it replaced by your team this week!'], ['assistant', 'We will replace the broken lamp for you within this very week.']),
    chat(['user', 'The lamp is broken and I would like to have it replaced by your team this week'], ['assistant', 'We will replace the broken lamp for you within this very week!']),
    chat(['user', 'What is the weather in the town that I live in?'], ['assistant', 'As an AI language model, I cannot check the weather for you.']),
    chat(['user', '¿Dónde está el pedido que compré para mi casa?'], ['assistant', 'El pedido está en camino y llega por la mañana.']),
    chat(['user', 'Tell me the story of the house that you have for this'], ['assistant', 'The story of the house is this. '.repeat(40).trim()]),
  )), 13)
  await step(page, 'Quality')
  for (const [title, n, fix, left] of [
    ['Near-duplicates', '1', 'Keep one per cluster', 12],
    ['Boilerplate refusals', '1', 'Drop refusals', 11],
    ['Language mix', '1', 'Keep 1 language', 10],
    ['Answer length outliers', '1', 'Drop outliers', 9],
  ] as const) {
    const card = quality(page, title)
    await expect(big(card), title).toHaveText(n)
    await card.getByRole('button', { name: fix }).click()
    await expect(big(card), title).toHaveText('0')
    await step(page, 'Validate')
    await expect(stat(page, 'Examples')).toHaveText(`${left}of 13`)
    await step(page, 'Quality')
  }
  await expect(log(page)).toHaveCount(4)
})

// 24 rows of A and 6 of B: 4.0 to 1. Capping at 2:1 keeps 12 of A and all 6 of B = 18.
test('label balance is measured and downsampled to the chosen ratio', async ({ page }) => {
  const rows = [...Array(30).keys()].map((i) => ({ prompt: `Case ${i * 7919}`, completion: `Reply ${i * 104729}`, label: i % 5 ? 'A' : 'B' }))
  await importFile(page, file('l.jsonl', jsonl(...rows)), 30)
  await step(page, 'Quality')
  const card = quality(page, 'Label balance')
  await expect(big(card)).toHaveText('4.0:1')
  await card.getByRole('combobox').selectOption('2')
  await card.getByRole('button', { name: 'Downsample majority' }).click()
  await expect(big(card)).toHaveText('2.0:1')
  const out = await exportAll(page)
  expect(out).toHaveLength(18)
  expect(out.every((r) => !('label' in r))).toBe(true)
})

test('train/validation leakage is found and dropped', async ({ page }) => {
  // 20 copies of one question with different answers, 10% validation = 2 rows, and both repeat a training prompt.
  const rows = [...Array(20).keys()].map((i) => ({ prompt: 'Which planet is closest to the sun in our system?', completion: `Answer ${'abcdefghijklmnopqrst'[i].repeat(40)}` }))
  await importFile(page, file('leak.jsonl', jsonl(...rows)), 20)
  await step(page, 'Quality')
  const card = quality(page, 'Train / validation leakage')
  await expect(big(card)).toHaveText('2')
  await card.getByRole('button', { name: 'Drop leaked rows' }).click()
  await expect(big(card)).toHaveText('0')
  expect(await exportAll(page)).toHaveLength(18)
})
