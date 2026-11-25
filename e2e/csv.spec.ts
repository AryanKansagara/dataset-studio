import { test, expect } from './test.ts'
import { check, exportAll, file, importFile, step } from './helpers.ts'

test('damaged CSV rows block the export checklist and are dropped by Fix all (#2)', async ({ page }) => {
  await importFile(page, file('r.csv', 'prompt,completion\nq1,a1\nq2,Hello, world\n'), 2)
  await expect(page.locator('tr', { hasText: 'Row has 3 cells but the header has 2' })).toContainText('3')
  await step(page, 'Export')
  await expect(check(page)).toContainText('1 rows still fail schema validation')
  await step(page, 'Validate')
  await page.getByRole('button', { name: 'Fix all' }).click()
  expect(await exportAll(page)).toEqual([{ prompt: 'q1', completion: 'a1' }])
})
