import { test, expect } from './test.ts'
import { chat, check, file, importFile, jsonl, setModel, stat, step } from './helpers.ts'
import { serveTokenizer } from './hub.ts'

const big = file('big.jsonl', jsonl(chat(['user', 'q'], ['assistant', 'a']), chat(['user', 'q'], ['assistant', 'a'], ['user', 'q'], ['assistant', 'b '.repeat(300).trim()])))

test('a failed tokenizer blocks the export checklist, and an estimate is worded as one (#5)', async ({ page }) => {
  await importFile(page, big, 2)
  await step(page, 'Export')
  await expect(check(page)).toContainText('Token lengths were not checked: the tokenizer failed to load')
  await expect(page.getByText('1 blocking')).toBeVisible()
  await expect(page.getByText('ready', { exact: true })).toHaveCount(0)
  await setModel(page, 'Kimi K2.6')
  await expect(check(page)).toContainText('No example found over 32,768 tokens (estimated: no exact tokenizer for this model)')
  await expect(page.getByText('ready', { exact: true })).toBeVisible()
})

test('a truncate fix that could not run is named after a reload without the tokenizer (#5)', async ({ page, context }) => {
  await serveTokenizer(context)
  await importFile(page, big, 2)
  await step(page, 'Tokens')
  await page.getByLabel('max_seq_length').fill('310')
  await page.getByRole('button', { name: 'Truncate smartly' }).click()
  await expect(stat(page, 'Over the limit')).toHaveText('0')
  await step(page, 'Export')
  await expect(check(page)).toContainText('Everything fits in 310 tokens')
  await page.evaluate(() => caches.delete('dataset-studio-tokenizers-v1'))
  await context.route(/^https:\/\/huggingface\.co\//, (r) => r.abort())
  await page.reload()
  await expect(check(page)).toContainText('The truncate fix has not been applied')
  await expect(page.getByText('1 blocking')).toBeVisible()
})
