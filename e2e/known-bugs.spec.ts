import { parquetReadObjects } from 'hyparquet'
import { test, expect } from './test.ts'
import { chat, check, choose, downloaded, exportAll, file, importButton, importFile, jsonl, newProject, quality, rule, setModel, stat, step } from './helpers.ts'
import { serveTokenizer } from './hub.ts'

// Open bugs. Each test states the correct behaviour and is expected to fail until the issue is fixed;
// when it starts to pass, the suite goes red: remove `.fail`.
const issue = (n: number) => `https://github.com/AryanKansagara/dataset-studio/issues/${n}`
const cardCount = (page: Parameters<typeof quality>[0], t: string) => quality(page, t).locator('.big')

test(`an escaped quote on a 64 KB boundary does not corrupt a CSV row (${issue(2)})`, async ({ page }) => {
  // The browser hands the file over in chunks that end on even offsets. Every row here is 6,006 bytes and starts on an even
  // offset, so every "" pair starts on an odd one and any chunk that ends inside a prompt splits a pair.
  let csv = 'prompt,completion\n'
  while (csv.length < 4 << 20) csv += '"' + '""'.repeat(3000) + '",ok\n'
  const n = csv.split('\n').length - 2
  await importFile(page, file('q.csv', csv), n)
  const out = await exportAll(page)
  expect(out.every((r) => r.completion === 'ok')).toBe(true)
  expect(out.every((r) => r.prompt === '"'.repeat(3000))).toBe(true)
})

test(`an unclosed quote is reported, not read as one long cell (${issue(2)})`, async ({ page }) => {
  await newProject(page)
  await choose(page, file('u.csv', 'prompt,completion\nq1,a1\n"q2,a2\nq3,a3\nq4,a4\n'))
  await importButton(page).click()
  await expect(page.getByText('Findings by rule')).toBeVisible()
  await expect(rule(page, 'E_CSV')).toBeVisible()
})

test(`a row with more cells than the header is reported, not cut (${issue(2)})`, async ({ page }) => {
  await importFile(page, file('r.csv', 'prompt,completion\nq1,a1\nq2,Hello, world\n'), 2)
  await expect(rule(page, 'E_CSV').locator('td.num')).toHaveText('1')
})

test(`two columns with the same name are both kept (${issue(2)})`, async ({ page }) => {
  await newProject(page)
  await choose(page, file('d.csv', 'text,text\nfirst,second\n'))
  await expect(importButton(page)).toBeVisible()
  await expect(page.locator('.preview-cols')).toContainText('first', { timeout: 2000 })
})

test(`a Latin-1 CSV is reported as invalid UTF-8 (${issue(2)})`, async ({ page }) => {
  await importFile(page, file('l.csv', Buffer.from('prompt,completion\ncafé,open\ntea,closed\n', 'latin1')), 2)
  await expect(rule(page, 'E_UTF8').locator('td.num')).toHaveText('1')
})

test(`an unparseable line is not a label class (${issue(3)})`, async ({ page }) => {
  // 50 A, 50 B and one broken line: balanced, so there is nothing to downsample.
  const rows = [...Array(100).keys()].map((i) => ({ prompt: `Case ${i * 7919}`, completion: `Reply ${i * 104729}`, label: i % 2 ? 'A' : 'B' }))
  await importFile(page, file('l.jsonl', jsonl(...rows, '{broken')), 101)
  await step(page, 'Quality')
  await expect(cardCount(page, 'Label balance')).toHaveText('1.0:1')
})

test(`PII in tool-call arguments, reasoning and extra keys is found (${issue(4)})`, async ({ page }) => {
  await importFile(page, file('t.jsonl', jsonl(
    { messages: [{ role: 'user', content: 'Send it' }, { role: 'assistant', content: 'Sent.', tool_calls: [{ id: '1', type: 'function', function: { name: 'send', arguments: '{"to":"jo@acme.io"}' } }] }, { role: 'tool', tool_call_id: '1', content: 'ok' }, { role: 'assistant', content: 'Done.' }] },
    { messages: [{ role: 'user', content: 'Think' }, { role: 'assistant', content: 'Ok.', reasoning_content: 'They are sam@acme.io' }] },
    { ...chat(['user', 'Hello'], ['assistant', 'Hi.']), customer: 'lee@acme.io' },
  )), 3)
  await step(page, 'Quality')
  await expect(cardCount(page, 'PII and secrets')).toHaveText('3')
})

test(`Export does not claim that everything fits when no token was counted (${issue(5)})`, async ({ page }) => {
  await importFile(page, file('big.jsonl', jsonl(chat(['user', 'word '.repeat(90000)], ['assistant', 'Ok then.']))), 1)
  await step(page, 'Tokens')
  await expect(page.getByRole('heading', { name: 'Tokenizer failed to load' })).toBeVisible()
  await step(page, 'Export')
  await expect(check(page)).toBeVisible()
  await expect(check(page)).not.toContainText('Everything fits', { timeout: 1000 })
})

const parquetRows = async (page: Parameters<typeof quality>[0]) => {
  await step(page, 'Tokens')
  await expect(stat(page, 'Tokens')).toBeVisible()
  await step(page, 'Export')
  await page.getByRole('button', { name: 'Parquet' }).click()
  const { bytes } = await downloaded(page, page.getByRole('button', { name: 'Everything in one file' }))
  return await parquetReadObjects({ file: new Uint8Array(bytes).buffer as ArrayBuffer }) as { input_ids: number[]; labels: number[] }[]
}

test(`Parquet never trains on the prompt when the template's generation prompt is not a prefix (${issue(6)})`, async ({ page, context }) => {
  // Like Gemma 4: the generation prompt adds an empty thinking block that the finished conversation does not have.
  await serveTokenizer(context, "{% for m in messages %}<s> {{ m['role'] }} {{ m['content'] }} </s>\n{% endfor %}{% if add_generation_prompt %}<s> assistant q{% endif %}")
  await importFile(page, file('one.jsonl', jsonl(chat(['user', 'q'], ['assistant', 'a b']))), 1)
  const [row] = await parquetRows(page)
  expect(row.input_ids).toEqual([1, 3, 5, 2, 1, 4, 6, 7, 2])
  expect(row.labels).toEqual([-100, -100, -100, -100, -100, -100, 6, 7, 2])
})

test(`Parquet masks assistant turns with weight 0 (${issue(6)})`, async ({ page, context }) => {
  await serveTokenizer(context)
  await importFile(page, file('w.jsonl', jsonl({ messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a', weight: 0 }, { role: 'user', content: 'q' }, { role: 'assistant', content: 'b' }] })), 1)
  const [row] = await parquetRows(page)
  // <s> user q </s> <s> assistant a </s> <s> user q </s> <s> assistant | b </s>
  expect(row.labels).toEqual([...Array(14).fill(-100), 7, 2])
})

test(`"Try the sample" on an empty workspace opens the sample (${issue(7)})`, async ({ page }) => {
  await page.goto('/app')
  await page.getByRole('link', { name: 'Try the sample' }).click()
  await expect(stat(page, 'Examples')).toHaveText('1,200')
})

test(`max_seq_length and the learning rate can be typed (${issue(8)})`, async ({ page }) => {
  await importFile(page, file('a.jsonl', jsonl({ prompt: 'p', completion: 'c' })), 1)
  await step(page, 'Split & cost')
  await page.getByLabel('max_seq_length').pressSequentially('4096')
  await page.getByLabel('Learning rate').selectText()
  await page.getByLabel('Learning rate').pressSequentially('0.0002')
  await page.getByLabel('Epochs').click()
  await expect(page.getByLabel('max_seq_length')).toHaveValue('4096', { timeout: 2000 })
  await expect(page.getByLabel('Learning rate')).toHaveValue('0.0002', { timeout: 2000 })
})

test(`a Full job's CLI command asks for full fine-tuning (${issue(9)})`, async ({ page }) => {
  await importFile(page, file('a.jsonl', jsonl({ prompt: 'p', completion: 'c' })), 1)
  await step(page, 'Split & cost')
  await page.getByRole('button', { name: 'Full', exact: true }).click()
  await step(page, 'Export')
  await expect(page.locator('.codebox pre')).toContainText('--no-lora', { timeout: 2000 })
})

test(`the command's max_seq_length never exceeds the model's (${issue(9)})`, async ({ page }) => {
  await importFile(page, file('a.jsonl', jsonl({ prompt: 'p', completion: 'c' })), 1)
  await setModel(page, 'Qwen3.5 4B')
  await page.getByLabel('max_seq_length').fill('131072')
  await setModel(page, 'Qwen3.5 9B')
  await step(page, 'Export')
  await expect(page.locator('.codebox pre')).toContainText('--max-seq-length 65536', { timeout: 2000 })
})

test(`a DPO pair is billed for its two sides, not twice for the longer one (${issue(10)})`, async ({ page, context }) => {
  await serveTokenizer(context)
  // chosen side: user q (4) + assistant 100 words (103) = 107; rejected side: 4 + 4 = 8; together 115
  await importFile(page, file('d.jsonl', jsonl({ prompt: 'q', chosen: 'a '.repeat(100).trim(), rejected: 'b' })), 1)
  await step(page, 'Split & cost')
  await page.getByRole('slider').fill('0')
  await page.getByLabel('Epochs').fill('1')
  await expect(stat(page, 'Billed tokens')).toHaveText('115', { timeout: 5000 })
})

test(`secrets written as env vars or JSON, and E.164 phone numbers, are found (${issue(11)})`, async ({ page }) => {
  await importFile(page, file('s.jsonl', jsonl(
    { prompt: 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY', completion: 'Rotate it.' },
    { prompt: 'config is {"password": "correcthorse12345"}', completion: 'Change it.' },
    { prompt: 'client_secret=abcdefghijklmnop1234', completion: 'Revoke it.' },
    { prompt: 'Ring me on +14155550132', completion: 'Will do.' },
  )), 4)
  await step(page, 'Quality')
  await expect(cardCount(page, 'PII and secrets')).toHaveText('4', { timeout: 3000 })
})

test(`redacting a card keeps the space after it (${issue(11)})`, async ({ page }) => {
  await importFile(page, file('c.jsonl', jsonl({ prompt: 'Card 4111 1111 1111 1111 was charged', completion: 'ok then' })), 1)
  await step(page, 'Quality')
  await page.getByRole('button', { name: 'Redact all' }).click()
  await expect(cardCount(page, 'PII and secrets')).toHaveText('0')
  expect((await exportAll(page))[0].prompt).toBe('Card [CARD] was charged')
})

test(`rows that differ only in their tool calls are not duplicates (${issue(12)})`, async ({ page }) => {
  const call = (city: string) => ({ messages: [{ role: 'user', content: 'Weather there?' }, { role: 'assistant', content: '', tool_calls: [{ id: '1', type: 'function', function: { name: 'weather', arguments: `{"city":"${city}"}` } }] }] })
  await importFile(page, file('t.jsonl', jsonl(call('Oslo'), call('Lima'))), 2)
  await step(page, 'Quality')
  await expect(cardCount(page, 'Exact duplicates')).toHaveText('0', { timeout: 3000 })
})

test(`JSON Lines in a .json file reads when the first record is over 4 KB (${issue(13)})`, async ({ page }) => {
  await importFile(page, file('long.json', jsonl({ prompt: 'p'.repeat(5000), completion: 'c' }, { prompt: 'p', completion: 'c' })), 2)
})

test(`a minified {"data": [...]} document reads as its rows (${issue(13)})`, async ({ page }) => {
  await importFile(page, file('min.json', JSON.stringify({ data: [{ prompt: 'p', completion: 'c' }, { prompt: 'q', completion: 'd' }] })), 2)
})

test(`many small labels still get the requested validation share (${issue(14)})`, async ({ page }) => {
  // 100 labels with 4 rows each: 10% of 400 is 40 validation rows.
  const rows = [...Array(400).keys()].map((i) => ({ prompt: `Case ${i * 7919}`, completion: `Reply ${i * 104729}`, label: `L${i % 100}` }))
  await importFile(page, file('s.jsonl', jsonl(...rows)), 400)
  await step(page, 'Split & cost')
  await expect(page.locator('.legend')).toContainText('Validation 40', { timeout: 3000 })
})

test(`the download button counts the rows that are in the file (${issue(15)})`, async ({ page }) => {
  await importFile(page, file('c.jsonl', jsonl({ prompt: 'p', completion: 'c' }, '{broken', '[1]')), 3)
  await step(page, 'Export')
  await expect(page.getByRole('button', { name: 'e2e.train.jsonl' })).toContainText('· 1 rows', { timeout: 3000 })
})

test.fail(`an empty file says that it is empty (${issue(16)})`, async ({ page }) => {
  await newProject(page)
  await choose(page, file('empty.jsonl', ''))
  await expect(importButton(page).or(page.getByText(/empty|no rows/i)).first()).toBeVisible()
  await expect(page.getByText(/is empty|no rows|no readable/i).first()).toBeVisible({ timeout: 2000 })
})

test.fail(`searching the validation report by text filters it (${issue(17)})`, async ({ page }) => {
  await importFile(page, file('s.jsonl', jsonl({ prompt: '', completion: 'c' }, { prompt: 'p', completion: 'c', ticket: 1 })), 2)
  await page.getByLabel('Search issues').fill('ticket')
  await expect(page.getByText('1 of 1 shown')).toBeVisible({ timeout: 2000 })
})
