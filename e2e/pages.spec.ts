import { test, expect } from './test.ts'
import { log, quality, rule, stat, step } from './helpers.ts'
import { messySupportSample } from '../src/engine/sample.ts'

test('landing page, docs, settings, 404 and an unknown project render', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /Valid JSONL is not/ })).toBeVisible()
  await expect(page.getByLabel(/Live demo/)).toContainText('rows checked')
  await page.goto('/docs#formats')
  await expect(page.getByRole('heading', { name: 'Formats and mapping' })).toBeVisible()
  await page.goto('/nope')
  await expect(page.getByRole('heading', { name: 'This line failed validation.' })).toBeVisible()
  await page.goto('/app/p/not-a-project/validate')
  await expect(page.getByRole('heading', { name: 'Project not found' })).toBeVisible()
})

test('the messy sample: the problems the generator planted are the ones reported, and fixing leaves no errors', async ({ page }) => {
  const { planted, rows } = messySupportSample()
  await page.goto('/')
  await page.getByRole('link', { name: 'Try the messy sample' }).first().click()
  await expect(stat(page, 'Examples')).toHaveText(rows.toLocaleString('en-US'))
  await expect(rule(page, 'E_JSON').locator('td.num')).toHaveText(String(planted.broken_json))
  await expect(rule(page, 'E_UTF8').locator('td.num')).toHaveText(String(planted.invalid_utf8))
  await page.getByRole('button', { name: 'Fix all' }).click()
  await expect(stat(page, 'Rows with errors')).toHaveText('0')
  await step(page, 'Quality')
  await expect(quality(page, 'PII and secrets').locator('.big')).not.toHaveText('0')
  await quality(page, 'PII and secrets').getByRole('button', { name: 'Redact all' }).click()
  await expect(quality(page, 'PII and secrets').locator('.big')).toHaveText('0')
  await expect(log(page)).toHaveCount(4)
})

test('keyboard: digits change step, ? opens help, Escape closes it', async ({ page }) => {
  await page.goto('/app?sample=1')
  await expect(stat(page, 'Examples')).toBeVisible()
  await page.keyboard.press('4')
  await expect(page).toHaveURL(/\/quality$/)
  await page.keyboard.press('?')
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})
