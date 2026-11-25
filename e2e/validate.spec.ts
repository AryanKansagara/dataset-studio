import { test, expect } from './test.ts'
import { chat, check, downloaded, exportAll, file, importFile, jsonl, log, rule, stat, statNote, step } from './helpers.ts'

// Worked by hand. One problem per line:
//   1 fine   2 broken JSON   3 empty assistant turn   4 a JSON list   5 blank (skipped)   6 unknown key
//   7 ends on a user turn   8 the same as line 1 apart from case and spaces   9 role "customer"   10 a 0xff byte
// 9 examples. Errors: 2, 3, 4, 9, 10 = 5. Warnings only: 6, 7 = 2. Clean: 1, 8 = 2 = 22%.
const text = jsonl(
  chat(['user', 'Where is my parcel?'], ['assistant', 'It left the depot.']),
  '{"messages": [{"role": "user"',
  chat(['user', 'Refund me'], ['assistant', '']),
  '[1, 2]',
  '',
  { ...chat(['user', 'Change the address'], ['assistant', 'Done for you.']), ticket: 7 },
  chat(['user', 'Is it open?'], ['assistant', 'Until six.'], ['user', 'hello?']),
  chat(['user', 'WHERE is  my parcel?'], ['assistant', 'it left the depot.']),
  chat(['customer', 'Hi there'], ['assistant', 'Hello!']),
)
const last = Buffer.from(JSON.stringify(chat(['user', 'Caf? hours'], ['assistant', 'Nine to five.'])) + '\n')
last[last.indexOf('?')] = 0xff
const messy = file('messy.jsonl', Buffer.concat([Buffer.from(text), last]))

test('the line-numbered report names every planted problem', async ({ page }) => {
  await importFile(page, messy, 9)
  await expect(stat(page, 'Rows with errors')).toHaveText('5')
  await expect(stat(page, 'Warnings only')).toHaveText('2')
  await expect(stat(page, 'Clean')).toHaveText('2')
  await expect(statNote(page, 'Clean')).toHaveText('22% of examples')
  for (const [code, n] of Object.entries({ E_JSON: 1, E_NOT_OBJECT: 1, E_UTF8: 1, E_EMPTY_TURN: 1, E_ROLE: 1, E_ROLE_ORDER: 1, W_UNKNOWN_KEY: 1, W_FINAL_NOT_ASSISTANT: 1 }))
    await expect(rule(page, code).locator('td.num'), code).toHaveText(String(n))

  const { name, text: csv } = await downloaded(page, page.getByRole('button', { name: 'CSV' }))
  expect(name).toBe('E2E-validation.csv')
  expect(csv.split('\n')[0]).toBe('"line","severity","code","message"')
  const rows = csv.split('\n').slice(1).map((l) => l.split(',').slice(0, 3).join(' ').replace(/"/g, ''))
  expect(rows.sort()).toEqual([
    '2 error E_JSON', '3 error E_EMPTY_TURN', '4 error E_NOT_OBJECT', '6 warn W_UNKNOWN_KEY', '7 warn W_FINAL_NOT_ASSISTANT',
    '9 error E_ROLE', '9 error E_ROLE_ORDER', '10 error E_UTF8',
  ].sort())

  await page.getByLabel('Filter by rule').selectOption('E_ROLE')
  await expect(page.getByText('1 of 1 shown')).toBeVisible()
})

// Fix all: 7 loses its last turn and 6 its extra key. 3 has no answer left. 2, 3, 4, 9 and 10 still fail and are dropped.
// Left: lines 1, 6, 7, 8 = 4 rows. Removing exact duplicates then drops 8 (the same as 1) = 3 rows.
test('Fix all, duplicates, undo and redo, and the exported records', async ({ page }) => {
  await importFile(page, messy, 9)
  await page.getByRole('button', { name: 'Fix all' }).click()
  await expect(stat(page, 'Examples')).toHaveText('4of 9')
  await expect(stat(page, 'Clean')).toHaveText('4')
  await expect(log(page)).toHaveCount(3)

  await step(page, 'Quality')
  await page.getByRole('button', { name: 'Remove duplicates' }).click()
  await expect(log(page)).toHaveCount(4)
  await expect(log(page).last()).toContainText('lines 8')

  const done = [
    chat(['user', 'Where is my parcel?'], ['assistant', 'It left the depot.']),
    chat(['user', 'Change the address'], ['assistant', 'Done for you.']),
    chat(['user', 'Is it open?'], ['assistant', 'Until six.']),
  ]
  expect(await exportAll(page)).toEqual(done)
  await expect(check(page)).toContainText('Every row matches the documented schema')

  await page.getByRole('button', { name: 'Undo', exact: true }).first().click()
  await step(page, 'Validate')
  await expect(stat(page, 'Examples')).toHaveText('4of 9')
  // "Fix all" is three fixes but one undo step
  await page.getByRole('button', { name: 'Undo', exact: true }).first().click()
  await expect(stat(page, 'Examples')).toHaveText('9')
  await page.getByRole('button', { name: 'Redo', exact: true }).first().click()
  await expect(stat(page, 'Examples')).toHaveText('4of 9')
  await page.keyboard.press('Control+Shift+z')
  expect(await exportAll(page)).toEqual(done)
})

test('a row opens in the drawer with its findings and can be dropped by hand', async ({ page }) => {
  await importFile(page, messy, 9)
  await page.locator('tr.click', { hasText: 'is empty' }).last().click()
  const drawer = page.getByRole('dialog')
  await expect(drawer).toContainText('Line 3')
  await expect(drawer).toContainText('E_EMPTY_TURN')
  await drawer.getByRole('button', { name: 'Drop row' }).click()
  await expect(stat(page, 'Examples')).toHaveText('8of 9')
  await expect(log(page)).toContainText('line 3 removed by hand')
})

test('markup in the data is shown as text', async ({ page }) => {
  const x = '<img src=x onerror="document.title=\'pwned\'">'
  await importFile(page, file('x.jsonl', jsonl({ messages: [{ role: x, content: x }, { role: 'assistant', content: x }] })), 1)
  await page.locator('tr.click', { hasText: 'onerror' }).last().click()
  await expect(page.getByRole('dialog')).toContainText(x)
  await expect(page.locator('img[src=x]')).toHaveCount(0)
  await expect(page).not.toHaveTitle('pwned')
})

test('the report is searched by message text or by line number (#17)', async ({ page }) => {
  // lines 1 and 12 have an empty prompt, the others an empty completion
  await importFile(page, file('s.jsonl', jsonl(...[...Array(12).keys()].map((i) => (i === 0 || i === 11 ? { prompt: '', completion: `c${i}` } : { prompt: `p${i}`, completion: '' })))), 12)
  const search = page.getByLabel('Search issues')
  for (const [q, n] of [['', 12], ['prompt', 2], [' PROMPT ', 2], ['completion', 10], ['nothing like it', 0], ['12', 1], ['1', 4], ['#12', 1], ['line 12', 1], ['99', 0], ['prompt 12', 0], ['  ', 12]] as const) {
    await search.fill(q)
    await expect(page.getByText(`${n} of ${n} shown`)).toBeVisible()
  }
  await search.fill('nothing like it')
  await expect(page.getByText('No matching findings.')).toBeVisible()
})
