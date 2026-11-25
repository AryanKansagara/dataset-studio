import { test, expect } from './test.ts'
import { chat, check, downloaded, file, importFile, jsonl, setModel, step } from './helpers.ts'

const ten = file('ten.jsonl', jsonl(...[...Array(10).keys()].map((i) => chat(['user', `Case ${i * 7919}`], ['assistant', `Reply ${i * 104729}`]))))

test('the commands follow the job settings', async ({ page }) => {
  await importFile(page, ten, 10, 'Support bot')
  await step(page, 'Split & cost')
  await page.getByLabel('Epochs').fill('4')
  await page.getByLabel('Evaluations (n_evals)').fill('2')
  await page.getByLabel('Model suffix').fill('my bot')
  await page.getByLabel('max_seq_length').fill('4096')
  await step(page, 'Export')
  const code = page.locator('.codebox pre')
  await expect(code).toContainText('together[cli]==3.1.1')
  await expect(code).toContainText(`tg fine-tuning create \\
  --training-file support-bot.train.jsonl \\
  --validation-file support-bot.validation.jsonl \\
  --n-evals 2 \\
  --model "Qwen/Qwen3.5-9B" \\
  --lora \\
  --n-epochs 4 \\
  --learning-rate 0.00001 \\
  --train-on-inputs auto \\
  --max-seq-length 4096 \\
  --random-seed 42 \\
  --suffix "my-bot"`)
  await page.getByRole('tab', { name: 'Python SDK' }).click()
  for (const s of ['file="support-bot.train.jsonl"', 'validation_file=val.id', 'n_evals=2', 'model="Qwen/Qwen3.5-9B"', 'lora=True', 'n_epochs=4', 'train_on_inputs="auto"', 'max_seq_length=4096', 'suffix="my-bot"'])
    await expect(code).toContainText(s)
})

test('preference data becomes a DPO job and cannot be exported as Parquet', async ({ page }) => {
  await importFile(page, file('dpo.jsonl', jsonl({ prompt: 'Best?', chosen: 'This.', rejected: 'That.' })), 1)
  await step(page, 'Export')
  await expect(page.locator('.codebox pre')).toContainText('--training-method dpo')
  await expect(page.locator('.codebox pre')).toContainText('--dpo-beta 0.1')
  await expect(page.locator('.codebox pre')).not.toContainText('--train-on-inputs')
  await expect(page.getByRole('button', { name: 'Parquet' })).toBeDisabled()
})

test('the dataset card states the real counts and the report prints', async ({ page }) => {
  await page.addInitScript(() => { window.print = () => { document.title = 'printed' } })
  await importFile(page, ten, 10, 'Support bot')
  await setModel(page, 'Kimi K2.6')
  await step(page, 'Export')
  const { name, text } = await downloaded(page, page.getByRole('button', { name: 'Dataset card (.md)' }))
  expect(name).toBe('support-bot.README.md')
  for (const s of ['# Support bot', '| Source | ten.jsonl |', '| Examples | 10 (train 9, validation 1, seed 42) |', '`moonshotai/Kimi-K2.6` (LoRA SFT)', 'No fixes applied', '- Validation: 0 rows with errors, 0 with warnings only'])
    expect(text).toContain(s)
  await page.getByRole('button', { name: 'Print report' }).click()
  await expect(page).toHaveTitle('printed')
  await expect(page.locator('.print-only')).toContainText('| Examples | 10')
})

test('the checklist blocks on leaked secrets', async ({ page }) => {
  await importFile(page, file('s.jsonl', jsonl({ prompt: 'mail jo@acme.io', completion: 'ok then' })), 1)
  await step(page, 'Export')
  await expect(check(page)).toContainText('1 rows contain PII or secrets')
  await expect(page.getByText(/\d+ blocking/)).toBeVisible()
})

test('exporting saves the pipeline as a version, and versions compare and restore', async ({ page }) => {
  await importFile(page, file('v.jsonl', jsonl(chat(['user', 'One'], ['assistant', 'Uno']), chat(['user', 'one'], ['assistant', 'uno']), chat(['user', 'Two'], ['assistant', 'Dos']))), 3)
  await setModel(page, 'Kimi K2.6')
  await step(page, 'Quality')
  await page.getByRole('button', { name: 'Remove duplicates' }).click()
  await expect(page.getByText('fix applied')).toBeVisible()
  await page.getByRole('button', { name: 'Save version' }).click()
  await page.getByLabel('Label', { exact: true }).fill('deduped')
  await page.getByRole('dialog').getByRole('button', { name: 'Save version' }).click()
  await step(page, 'Versions')
  await expect(page.getByRole('heading', { name: 'v1 → v2' })).toBeVisible()
  await expect(page.locator('tr', { has: page.locator('td', { hasText: /^Examples$/ }) })).toHaveText('Examples32−1')
  await expect(page.locator('tr', { has: page.locator('td', { hasText: /^Exact duplicates$/ }) })).toHaveText('Exact duplicates10−1')
  await expect(page.locator('tr', { hasText: 'Remove exact duplicates' })).toContainText('lines 2')
  await page.locator('tr', { hasText: 'Imported' }).getByRole('button', { name: 'Restore' }).click()
  await expect(page.getByText('Restored the v1 pipeline.')).toBeVisible()
  await step(page, 'Validate')
  await expect(page.locator('.stat', { hasText: 'Examples' }).first()).toContainText('3')
})
