import type { Locator } from '@playwright/test'
import { test, expect } from './test.ts'
import { field, file, importButton, importFile, jsonl, newProject, stat, step } from './helpers.ts'
import { parquet, serveDataset, serveTokenizer } from './hub.ts'

/** Replaces the value key by key and leaves the field. */
async function type(input: Locator, text: string, leave = true) {
  await input.selectText()
  await input.pressSequentially(text)
  await expect(input).toHaveValue(text)
  if (leave) await input.blur()
}

test('typed values are used exactly and out-of-range ones are clamped when the field is left (#8)', async ({ page, context }) => {
  await serveTokenizer(context)
  await importFile(page, file('d.jsonl', jsonl({ prompt: 'q', chosen: 'a', rejected: 'b' })), 1)
  await step(page, 'Split & cost')
  const maxSeq = page.getByLabel('max_seq_length'), lr = page.getByLabel('Learning rate'), epochs = page.getByLabel('Epochs'), evals = page.getByLabel('Evaluations (n_evals)'), beta = page.getByLabel('DPO beta')
  const limit = page.locator('.toolbar')
  await type(maxSeq, '4096')
  await expect(limit).toContainText('limit 4,096 tokens')
  await type(lr, '0.0002')
  await type(epochs, '12')
  await type(evals, '10')
  await type(beta, '0.25')
  for (const [f, v] of [[maxSeq, '4096'], [lr, '0.0002'], [epochs, '12'], [evals, '10'], [beta, '0.25']] as const) await expect(f).toHaveValue(v)
  await step(page, 'Export')
  for (const s of ['--max-seq-length 4096', '--learning-rate 0.0002', '--n-epochs 12', '--dpo-beta 0.25']) await expect(page.locator('.codebox pre')).toContainText(s)

  await step(page, 'Split & cost')
  await type(maxSeq, '4', false)
  await expect(limit).toContainText('limit 4,096 tokens') // not 128 while typing
  await maxSeq.blur()
  await expect(maxSeq).toHaveValue('128')
  await type(maxSeq, '99999999')
  await expect(maxSeq).toHaveValue('49152')
  await maxSeq.fill('')
  await expect(limit).toContainText('limit 49,152 tokens')
  await maxSeq.blur()
  await expect(maxSeq).toHaveValue('')
  for (const [f, bad, good] of [[lr, '0', '0.00001'], [lr, '-1', '0.00001'], [epochs, '0', '1'], [epochs, '2.6', '3'], [evals, '-3', '0'], [beta, '5', '0.9'], [beta, '0', '0.05']] as const) {
    await type(f, bad)
    await expect(f).toHaveValue(good)
  }
  await type(epochs, '7')
  await epochs.fill('')
  await epochs.blur()
  await expect(epochs).toHaveValue('7') // an emptied field keeps its value

  const speed = page.getByLabel('Assumed throughput')
  await type(speed, '25000')
  await expect(speed).toHaveValue('25000')
  await type(speed, '5')
  await expect(speed).toHaveValue('100')
})

test('the Hugging Face row limit can be typed and limits the import (#8)', async ({ page, context }) => {
  const n = [...Array(40).keys()].map(String)
  await serveDataset(context, 'acme/tiny', parquet({ question: n.map((i) => `${i}?`), answer: n.map((i) => `answer ${i}`) }))
  await newProject(page)
  await page.getByLabel('Hugging Face dataset id').fill('acme/tiny')
  await page.getByRole('button', { name: 'Fetch' }).click()
  await type(field(page, 'Max rows'), '5000')
  await expect(field(page, 'Max rows')).toHaveValue('5000')
  await type(field(page, 'Max rows'), '25', false)
  await page.getByRole('button', { name: 'Preview & map' }).click()
  await importButton(page).click()
  await expect(stat(page, 'Examples')).toHaveText('25')
})
