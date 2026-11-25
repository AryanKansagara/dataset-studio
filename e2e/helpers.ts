import { expect, type Locator, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'

export type Upload = { name: string; mimeType: string; buffer: Buffer }
export const file = (name: string, content: string | Uint8Array): Upload => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(content as string) })
export const jsonl = (...rows: unknown[]) => rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r)) + '\n').join('')
export const chat = (...turns: [string, string][]) => ({ messages: turns.map(([role, content]) => ({ role, content })) })

export async function newProject(page: Page, name = 'E2E') {
  await page.goto('/app')
  await page.getByRole('button', { name: /^(Import your data|New project)$/ }).click()
  await page.getByLabel('Name').fill(name)
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page).toHaveURL(/\/app\/p\/[0-9a-f-]+\/import$/)
}

/** Chooses a file on the import step; stops at the mapping preview. */
export const choose = (page: Page, f: Upload) => page.locator('input[type=file]').setInputFiles(f)
export const importButton = (page: Page) => page.getByRole('button', { name: 'Import & check' })

/** New project -> choose file -> accept the suggested mapping -> validation report. */
export async function importFile(page: Page, f: Upload, examples: number, name = 'E2E') {
  await newProject(page, name)
  await choose(page, f)
  await expect(importButton(page)).toBeEnabled()
  await importButton(page).click()
  await expect(page).toHaveURL(/\/validate$/)
  await expect(stat(page, 'Examples')).toHaveText(new RegExp(`^${examples}(of .*)?$`))
}

/** A select or input of the mapping form, by its caption. */
export const field = (page: Page, caption: string) => page.locator('label.field', { has: page.locator('span', { hasText: exact(caption) }) }).locator('select, input')
const exact = (s: string) => new RegExp('^' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i')
export const stat = (page: Page, label: string) => page.locator('.stat', { has: page.locator('.label', { hasText: exact(label) }) }).locator('.v')
export const statNote = (page: Page, label: string) => page.locator('.stat', { has: page.locator('.label', { hasText: exact(label) }) }).locator('.s')
export const quality = (page: Page, title: string) => page.locator('.qcard', { has: page.locator('h3', { hasText: exact(title) }) })
export const check = (page: Page) => page.locator('.check-list')
export const log = (page: Page) => page.locator('.log .e')

export async function step(page: Page, name: string) {
  await page.getByRole('navigation', { name: 'Steps' }).getByRole('link', { name }).click()
}
/** The row of "Findings by rule" for one code. */
export const rule = (page: Page, code: string) => page.locator('tr', { has: page.locator('.mono', { hasText: exact(code) }) })

export async function downloaded(page: Page, click: Locator) {
  const [d] = await Promise.all([page.waitForEvent('download'), click.click()])
  const bytes = await readFile(await d.path())
  return { name: d.suggestedFilename(), bytes, text: bytes.toString('utf8') }
}
export const lines = (text: string) => text.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
/** "Everything in one file" on the Export step. */
export async function exportAll(page: Page) {
  await step(page, 'Export')
  return lines((await downloaded(page, page.getByRole('button', { name: 'Everything in one file' }))).text)
}
/** Switches the target model. The Kimi models have no browser tokenizer, so they need no network. */
export const setModel = (page: Page, name: string) => page.getByLabel('Target model').selectOption({ label: name })
