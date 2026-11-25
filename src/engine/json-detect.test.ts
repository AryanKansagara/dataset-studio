import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectKind, fromBytes, readJson } from './parse.ts'
import { readItems } from './ingest.ts'

const enc = (s: string) => new TextEncoder().encode(s)
/** Reads a file the way the worker does. */
async function load(name: string, content: string | Uint8Array, chunk = 1 << 16) {
  const bytes = typeof content === 'string' ? enc(content) : content
  const kind = await detectKind(name, bytes.subarray(0, 8192), () => fromBytes(bytes, chunk))
  const items = []
  if (kind !== 'parquet') for await (const it of readItems(kind, fromBytes(bytes, chunk))) items.push(it)
  return { kind, items, values: items.map((i) => i.value ?? i.error) }
}
const OK = { prompt: 'p', completion: 'c' }
const LONG = { prompt: 'p'.repeat(20000), completion: 'c' }
const CONV = { messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }] }
const SHAREGPT = { conversations: [{ from: 'human', value: 'q' }, { from: 'gpt', value: 'a' }] }

test('JSON Lines in a .json file reads whatever the length of its first record (#13)', async () => {
  for (const first of [OK, LONG]) for (const chunk of [7, 1 << 16]) {
    const r = await load('a.json', `${JSON.stringify(first)}\n${JSON.stringify(OK)}\n`, chunk)
    assert.equal(r.kind, 'jsonl')
    assert.deepEqual(r.values, [first, OK])
  }
  assert.deepEqual((await load('a.json', `﻿\n${JSON.stringify(LONG)}\r\n\r\n{broken\n`)).values, [LONG, 'E_JSON'])
  assert.deepEqual((await load('noext', `${JSON.stringify(LONG)}\n${JSON.stringify(OK)}`)).values, [LONG, OK])
})

test('{"data": [...]} is its rows and a single example is one row, minified or pretty-printed (#13)', async () => {
  const pref = { input: { messages: [] }, preferred_output: [{ role: 'assistant', content: 'a' }], non_preferred_output: [{ role: 'assistant', content: 'b' }] }
  for (const [doc, rows] of [
    [{ data: [OK, OK] }, [OK, OK]],
    [{ version: '1', data: [LONG] }, [LONG]],
    [{ columns: ['a'], rows: [OK] }, [OK]],
    [{ conversations: [CONV, CONV] }, [CONV, CONV]],
    [{ whatever: [OK, 5] }, [OK, 'E_NOT_OBJECT']],
    [{ data: [] }, []],
    [CONV, [CONV]], [SHAREGPT, [SHAREGPT]], [pref, [pref]], [OK, [OK]],
    [{ ...CONV, tools: [{ type: 'function' }] }, [{ ...CONV, tools: [{ type: 'function' }] }]],
    [{ tools: [{ type: 'function' }], ...CONV }, [{ tools: [{ type: 'function' }], ...CONV }]],
    [{ ...OK, tags: ['x', 'y'] }, [{ ...OK, tags: ['x', 'y'] }]],
    [{ ...OK, notes: [{ by: 'x' }] }, [{ ...OK, notes: [{ by: 'x' }] }]],
    [{ prompt: CONV.messages, chosen: CONV.messages, rejected: CONV.messages }, [{ prompt: CONV.messages, chosen: CONV.messages, rejected: CONV.messages }]],
  ] as const) for (const indent of [0, 2]) assert.deepEqual((await load('a.json', JSON.stringify(doc, null, indent))).values, rows)
  assert.deepEqual((await load('a.txt', JSON.stringify({ data: [OK] }) + '\n\n')).values, [OK])
  assert.deepEqual((await load('a.json', JSON.stringify([OK, 1]))).values, [OK, 'E_NOT_OBJECT'])
})

test('JSON documents: damaged ones are errors and invalid UTF-8 stays visible (#13)', async () => {
  assert.deepEqual((await load('a.json', '{"data":[{"prompt":"p"')).values, ['E_JSON'])
  assert.deepEqual((await load('a.json', '{"data":[{"prompt":"p"},\n{"pro')).values, ['E_JSON'])
  const latin1 = Uint8Array.from(Buffer.from('{"prompt":"caf\xe9","completion":"c"}', 'latin1'))
  assert.equal((await load('a.json', latin1)).items[0].badUtf8, true)
  assert.equal(readJson('[{"a":"�"}]')[0].badUtf8, undefined)
})
