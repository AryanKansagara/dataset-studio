import { test, expect } from './test.ts'
import { choose, exportAll, field, file, importButton, importFile, jsonl, newProject, stat, step } from './helpers.ts'
import { parquet, serveDataset } from './hub.ts'

const QA = [{ prompt: 'What is the capital of Peru?', completion: 'Lima.' }, { prompt: 'How many legs has a spider?', completion: 'Eight, always.' }]

for (const [name, f] of Object.entries({
  'JSONL': file('a.jsonl', jsonl(...QA)),
  'JSONL with a BOM, CRLF and blank lines': file('a.jsonl', '﻿' + QA.map((r) => JSON.stringify(r) + '\r\n\r\n').join('')),
  'JSON array': file('a.json', JSON.stringify(QA, null, 2)),
  'JSON object holding the array': file('a.json', JSON.stringify({ data: QA }, null, 2)),
  'JSON Lines named .json': file('a.json', jsonl(...QA)),
  'CSV with quoted commas': file('a.csv', 'prompt,completion\nWhat is the capital of Peru?,Lima.\nHow many legs has a spider?,"Eight, always."\n'),
  'CSV with a BOM, CRLF and semicolons': file('a.csv', '﻿prompt;completion\r\nWhat is the capital of Peru?;Lima.\r\nHow many legs has a spider?;Eight, always.\r\n'),
  'TSV': file('a.tsv', 'prompt\tcompletion\nWhat is the capital of Peru?\tLima.\nHow many legs has a spider?\tEight, always.\n'),
  'Parquet': file('a.parquet', parquet({ prompt: QA.map((r) => r.prompt), completion: QA.map((r) => r.completion) })),
})) {
  test(`${name} imports to the same two records`, async ({ page }) => {
    await importFile(page, f, 2)
    await expect(stat(page, 'Rows with errors')).toHaveText('0')
    await expect(stat(page, 'Clean')).toHaveText('2')
    expect(await exportAll(page)).toEqual(QA)
  })
}

test('question/answer columns become a conversation, with a fixed system prompt and a label column that is not exported', async ({ page }) => {
  await newProject(page)
  await choose(page, file('tickets.csv', 'question,answer,topic\nWhere is it?,On its way.,shipping\nCan I pay later?,Yes.,billing\n'))
  await expect(page.getByLabel('User column')).toHaveValue('question')
  await expect(page.getByLabel('Assistant column')).toHaveValue('answer')
  await expect(page.getByLabel('Label column')).toHaveValue('topic')
  await page.getByLabel('Fixed system prompt').fill('Be kind.')
  await importButton(page).click()
  await expect(stat(page, 'Examples')).toHaveText('2')
  expect(await exportAll(page)).toEqual([
    { messages: [{ role: 'system', content: 'Be kind.' }, { role: 'user', content: 'Where is it?' }, { role: 'assistant', content: 'On its way.' }] },
    { messages: [{ role: 'system', content: 'Be kind.' }, { role: 'user', content: 'Can I pay later?' }, { role: 'assistant', content: 'Yes.' }] },
  ])
})

test('ShareGPT conversations, Alpaca rows and preference pairs map to their Together formats', async ({ page }) => {
  await importFile(page, file('s.jsonl', jsonl({ id: 'x1', conversations: [{ from: 'human', value: 'hi' }, { from: 'gpt', value: 'hello' }] })), 1)
  expect(await exportAll(page)).toEqual([{ messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }] }])

  await importFile(page, file('alpaca.json', JSON.stringify([{ instruction: 'Add.', input: '1 2', output: '3' }])), 1, 'Alpaca')
  expect(await exportAll(page)).toEqual([{ prompt: 'Add.\n\n1 2', completion: '3' }])

  await importFile(page, file('dpo.jsonl', jsonl({ prompt: 'Best fruit?', chosen: 'Mango.', rejected: 'Dirt.' })), 1, 'Pairs')
  expect(await exportAll(page)).toEqual([{
    input: { messages: [{ role: 'user', content: 'Best fruit?' }] },
    preferred_output: [{ role: 'assistant', content: 'Mango.' }], non_preferred_output: [{ role: 'assistant', content: 'Dirt.' }],
  }])
})

test('changing the format by hand updates the live preview', async ({ page }) => {
  await newProject(page)
  await choose(page, file('a.csv', 'body,reply\nfirst,second\n'))
  await page.getByRole('group', { name: 'Target format' }).getByRole('button', { name: 'Generic text' }).click()
  await field(page, 'Text').selectOption('reply')
  await expect(page.locator('pre.code').first()).toContainText('"text": "second"')
  await importButton(page).click()
  await expect(stat(page, 'Examples')).toHaveText('1')
  expect(await exportAll(page)).toEqual([{ text: 'second' }])
})

test('a public Hugging Face dataset imports through its Parquet export', async ({ page, context }) => {
  await serveDataset(context, 'acme/tiny', parquet({ question: ['1?', '2?', '3?'], answer: ['one', 'two', 'three'] }))
  await newProject(page)
  await page.getByLabel('Hugging Face dataset id').fill('acme/missing')
  await page.getByRole('button', { name: 'Fetch' }).click()
  await expect(page.getByText('Dataset "acme/missing" was not found or is gated/private')).toBeVisible()
  await page.getByLabel('Hugging Face dataset id').fill('acme/tiny')
  await page.getByRole('button', { name: 'Fetch' }).click()
  await page.getByRole('button', { name: 'Preview & map' }).click()
  await importButton(page).click()
  await expect(stat(page, 'Examples')).toHaveText('3')
  await step(page, 'Import & map')
  await expect(page.getByText('hf://acme/tiny (default/train)').first()).toBeVisible()
})
