import { test, expect } from './test.ts'
import { chat, file, importFile, jsonl, stat, step } from './helpers.ts'
import { serveTokenizer } from './hub.ts'

test('a row the chat template rejects stops the Parquet export with its line number (#6)', async ({ page, context }) => {
  await serveTokenizer(context, "{% for m in messages %}{% if m['content'] == 'bad' %}{{ raise_exception('no') }}{% endif %}<s> {{ m['role'] }} {{ m['content'] }} </s>\n{% endfor %}{% if add_generation_prompt %}<s> assistant{% endif %}")
  await importFile(page, file('two.jsonl', jsonl(chat(['user', 'q'], ['assistant', 'a']), chat(['user', 'bad'], ['assistant', 'a']))), 2)
  await step(page, 'Tokens')
  await expect(stat(page, 'Tokens')).toBeVisible()
  await step(page, 'Export')
  await page.getByRole('button', { name: 'Parquet' }).click()
  let downloads = 0
  page.on('download', () => { downloads++ })
  await page.getByRole('button', { name: 'Everything in one file' }).click()
  await expect(page.getByText(/Parquet export stopped at line 2: the chat template rejects this row/)).toBeVisible()
  expect(downloads).toBe(0)
})
