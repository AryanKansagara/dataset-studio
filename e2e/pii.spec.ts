import { test, expect } from './test.ts'
import { chat, check, exportAll, file, importFile, jsonl, quality, step } from './helpers.ts'

test('PII outside the message text blocks the export and is gone from the file after Redact all (#4)', async ({ page }) => {
  await importFile(page, file('t.jsonl', jsonl(chat(['user', 'Hello'], ['assistant', 'Hi.']), { messages: [{ role: 'user', content: 'Send it' }, { role: 'assistant', content: 'Sent.', reasoning_content: 'sam@acme.io', tool_calls: [{ id: '1', type: 'function', function: { name: 'send', arguments: '{"to":"jo@acme.io"}' } }] }], customer: 'lee@acme.io' })), 2)
  await step(page, 'Export')
  await expect(check(page)).toContainText('1 rows contain PII or secrets')
  await step(page, 'Quality')
  await quality(page, 'PII and secrets').getByRole('button', { name: 'Redact all' }).click()
  await expect(quality(page, 'PII and secrets').locator('.big')).toHaveText('0')
  const out = JSON.stringify(await exportAll(page))
  expect(out).not.toContain('@acme.io')
  expect(out.match(/\[EMAIL\]/g)).toHaveLength(3)
})
