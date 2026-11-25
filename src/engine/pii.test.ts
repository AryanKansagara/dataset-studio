import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyze, type Op, type Row } from './pipeline.ts'
import { findPiiInRecord, redactRecord, type PiiKind } from './quality.ts'

const ALL = new Set<PiiKind>(['email', 'phone', 'card', 'secret', 'ip'])
const call = (args: string) => ({ messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'send', arguments: args } }] }] })
const argsOf = (r: Record<string, unknown>) => (r as ReturnType<typeof call>).messages[1].tool_calls![0].function.arguments

test('PII: every exported string is scanned and redacted (#4)', () => {
  const rec = {
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'I am a@acme.io' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,aaaa' } }], name: 'b@acme.io' },
      { role: 'assistant', content: 'ok', reasoning_content: 'c@acme.io', reasoning: 'd@acme.io', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{"to":"e@acme.io"}' } }] },
    ],
    tools: [{ type: 'function', function: { description: 'mails f@acme.io' } }], customer: { mail: 'g@acme.io' }, weight: 1,
  }
  assert.deepEqual(findPiiInRecord(rec).map((h) => h.text[0]).sort(), [...'abcdefg'])
  const out = redactRecord(rec, ALL)
  assert.equal(findPiiInRecord(out).length, 0)
  assert.equal(JSON.stringify(out), JSON.stringify(rec).replace(/[a-g]@acme\.io/g, '[EMAIL]'))
})

test('PII: redacted tool arguments stay valid JSON (#4)', () => {
  for (const [args, want] of [
    ['{"to": "jo@acme.io", "id": 12345678901234567890}', '{"to": "[EMAIL]", "id": 12345678901234567890}'],
    ['{"cmd":"token=abcdefghijkl123"}', '{"cmd":"[SECRET]"}'],
    ['{"t":"line\\njo@acme.io"}', '{"t":"line\\n[EMAIL]"}'],
    ['{"card":4111111111111111,"n":[1]}', '{"card":"[CARD]","n":[1]}'],
    ['not json jo@acme.io', 'not json [EMAIL]'],
    ['{"a": 1}', '{"a": 1}'],
  ]) {
    const got = argsOf(redactRecord(call(args), ALL))
    assert.equal(got, want)
    if (args[0] === '{') JSON.parse(got)
  }
})

test('PII: the report and "Redact all" agree on rows with no PII in their text (#4)', () => {
  const rows: Row[] = [call('{"to":"jo@acme.io"}'), { prompt: 'p', completion: 'c', email: 'x@acme.io' }].map((rec, i) => ({ id: i, line: i + 1, bytes: 9, rec }))
  const ctx = { format: 'conversational' as const, split: { valFraction: 0, seed: 1, stratify: false } }
  const op: Op = { type: 'redactPii', kinds: ['email'] }
  assert.equal(analyze(rows, [], ctx, { limit: 99 }).report.quality.pii.byKind.email, 2)
  const after = analyze(rows, [op], ctx, { limit: 99 }).report
  assert.equal(after.quality.pii.rows, 0)
  assert.equal(after.log[0].modified, 2)
})
