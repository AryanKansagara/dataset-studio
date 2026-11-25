import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readCsv, fromBytes, type RawItem } from './parse.ts'

const enc = (s: string) => new TextEncoder().encode(s)
async function csvItems(s: string | Uint8Array, chunk = 1 << 16): Promise<RawItem[]> {
  const out: RawItem[] = []
  for await (const x of readCsv(fromBytes(typeof s === 'string' ? enc(s) : s, chunk))) out.push(x)
  return out
}

test('CSV: the rows do not depend on where the chunks end', async () => {
  const text = '﻿prompt,completion\r\n"say ""hi, you"" now","a, b"\r\n\r\n"ein\n""Wort"" ü",\u{1F600}\r\n"""",x""y\r\nlast,"""q"""'
  const whole = await csvItems(text)
  assert.deepEqual(whole.map((i) => i.value), [
    { prompt: 'say "hi, you" now', completion: 'a, b' }, { prompt: 'ein\n"Wort" ü', completion: '\u{1F600}' },
    { prompt: '"', completion: 'x""y' }, { prompt: 'last', completion: '"q"' },
  ])
  assert.deepEqual(whole.map((i) => i.line), [2, 4, 6, 7])
  for (let n = 1; n < enc(text).length; n++) assert.deepEqual(await csvItems(text, n), whole, `chunks of ${n}`)
})

test('CSV: unclosed quotes and rows that do not match the header are errors on their own line', async () => {
  const cut = await csvItems('prompt,completion\nq1,a1\n"q2,a2\nq3,a3\n')
  assert.deepEqual(cut.map((i) => [i.line, i.error]), [[2, undefined], [3, 'E_CSV']])
  const rag = await csvItems('prompt,completion\nq1,Hello, world\nq2\nq3,a3\nq4,a4,\n')
  assert.deepEqual(rag.map((i) => [i.line, i.error]), [[2, 'E_CSV'], [3, 'E_CSV'], [4, undefined], [5, undefined]])
  assert.equal(rag[0].message, 'Row has 3 cells but the header has 2')
  // columns without a name may be missing from a row
  assert.deepEqual((await csvItems('a,b,\n1,2\n3,4,x\n')).map((i) => i.value), [{ a: '1', b: '2', column_3: '' }, { a: '3', b: '4', column_3: 'x' }])
})

test('CSV: invalid UTF-8 is flagged on the right row and repeated column names are kept', async () => {
  const bytes = new Uint8Array([...enc('prompt,completion\ncaf'), 0xe9, ...enc(',open\ntea,closed\n')])
  assert.deepEqual((await csvItems(bytes)).map((i) => i.badUtf8), [true, undefined])
  assert.deepEqual((await csvItems('text,text,text_2\na,b,c\n'))[0].value, { text: 'a', text_2: 'b', text_2_2: 'c' })
})
