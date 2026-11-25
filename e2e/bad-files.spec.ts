import { test, expect } from './test.ts'
import { check, choose, file, importButton, importFile, jsonl, newProject, rule, stat, step } from './helpers.ts'
import { parquet } from './hub.ts'

const OK = { prompt: 'p', completion: 'c' }

for (const [name, f] of Object.entries({
  'an empty file': file('empty.jsonl', ''),
  'a CSV with only a header': file('head.csv', 'prompt,completion\n'),
  'a JSONL file with no readable line': file('bad.jsonl', '{oops\n{again\n'),
  'a truncated JSON document': file('cut.json', JSON.stringify([OK, OK], null, 2).slice(0, -20)),
})) {
  test(`${name} cannot be imported`, async ({ page }) => {
    await newProject(page)
    await choose(page, f)
    await expect(page.getByText(/0 columns · first 0 rows shown/)).toBeVisible()
    await expect(importButton(page)).toBeDisabled()
  })
}

test('a truncated Parquet file and a text file named .parquet are refused with a message', async ({ page }) => {
  await newProject(page)
  await choose(page, file('cut.parquet', parquet({ text: ['a', 'b'] }).subarray(0, 40)))
  await expect(page.locator('.toasts, .toast').first()).toContainText(/parquet/i)
  await expect(importButton(page)).toHaveCount(0)
  await choose(page, file('fake.parquet', 'prompt,completion\na,b\n'))
  await expect(page.locator('.toasts, .toast').last()).toContainText(/parquet/i)
  await expect(importButton(page)).toHaveCount(0)
})

test('a JSONL file cut in the middle of its last line reports that line and is not ready', async ({ page }) => {
  await importFile(page, file('cut.jsonl', jsonl(OK, { prompt: 'p2', completion: 'c2' }).slice(0, -9)), 2)
  await expect(rule(page, 'E_JSON').locator('td.num')).toHaveText('1')
  await expect(page.locator('tr', { hasText: 'Line is not valid JSON' }).last()).toContainText('2')
  await step(page, 'Export')
  await expect(check(page)).toContainText('1 rows still fail schema validation')
  await expect(page.getByText(/\d+ blocking/)).toBeVisible()
})

test('a JSON array in a .jsonl file is reported, not read as data', async ({ page }) => {
  await newProject(page)
  await choose(page, file('arr.jsonl', JSON.stringify([OK])))
  await expect(page.getByText('1 unparseable lines in the preview')).toBeVisible()
  await expect(importButton(page)).toBeDisabled()
})

test('a pre-tokenized Parquet file is refused with the reason', async ({ page }) => {
  await newProject(page)
  await choose(page, file('tok.parquet', parquet({ input_ids: ['1 2'] })))
  await expect(page.getByText('already pre-tokenized (input_ids)')).toBeVisible()
})

test('numeric and missing fields are schema errors', async ({ page }) => {
  await importFile(page, file('n.jsonl', jsonl(OK, { prompt: 5, completion: 'c' }, { prompt: 'p', completion: null })), 3)
  await expect(rule(page, 'E_SCHEMA').locator('td.num')).toHaveText('2')
  await expect(stat(page, 'Clean')).toHaveText('1')
})
