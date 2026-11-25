import { test, expect } from './test.ts'
import { check, choose, downloaded, file, importButton, importFile, jsonl, lines, newProject, rule, stat, step } from './helpers.ts'
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

test('broken lines stay in the report and are in no file, button, card or split (#15)', async ({ page }) => {
  const good = [...Array(10).keys()].map((i) => ({ prompt: `Case ${i * 7919}`, completion: `Reply ${i * 104729}` }))
  await importFile(page, file('mix.jsonl', jsonl(...good, ...Array(10).fill('{broken'))), 20)
  await expect(rule(page, 'E_JSON').locator('td.num')).toHaveText('10')
  await step(page, 'Split & cost')
  await expect(page.locator('.legend')).toContainText('Train 9Validation 1')
  await step(page, 'Export')
  await expect(check(page)).toContainText('10 examples (minimum 1)')
  for (const [name, n] of [['e2e.train.jsonl', 9], ['e2e.validation.jsonl', 1]] as const) {
    const b = page.getByRole('button', { name })
    await expect(b).toContainText(`· ${n} rows`)
    expect(lines((await downloaded(page, b)).text)).toHaveLength(n)
  }
  await page.getByRole('tab', { name: 'Dataset card' }).click()
  await expect(page.locator('.codebox pre')).toContainText('| Examples | 10 (train 9, validation 1, seed 42) |')
})

test('a file whose rows are all dropped or broken has no example to export (#15)', async ({ page }) => {
  await importFile(page, file('mix.jsonl', jsonl({ prompt: '', completion: '' }, '{broken')), 2)
  await page.getByRole('button', { name: 'Fix all' }).click()
  await step(page, 'Export')
  await expect(check(page)).toContainText('0 examples (minimum 1)')
  await expect(page.getByText(/\d+ blocking/)).toBeVisible()
})
