import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyze, type Op, type Row } from './pipeline.ts'
import { findPii, findPiiInRecord, redact, redactRecord, type PiiKind } from './quality.ts'

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

test('PII: secrets as env vars and JSON, GitHub fine-grained tokens and E.164 numbers (#11)', () => {
  for (const [text, want] of [
    ['AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY', 'AWS_SECRET_ACCESS_KEY=[SECRET]'],
    ['export OPENAI_API_KEY=abcdef1234567890 # x', 'export OPENAI_API_KEY=[SECRET] # x'],
    ['client_secret=abcdefghijklmnop1234', 'client_secret=[SECRET]'],
    ['DB_PASSWORD="abcdefghijkl!1"', 'DB_PASSWORD="[SECRET]"'],
    ['{"password": "correcthorse12345"}', '{"password": "[SECRET]"}'],
    ['{"clientSecret":"abcdefghijkl#12","n":1}', '{"clientSecret":"[SECRET]","n":1}'],
    [String.raw`body "{\"api_key\": \"abcdef1234567890\"}"`, String.raw`body "{\"api_key\": \"[SECRET]\"}"`],
    ['github_pat_' + '11ABCDEFG0'.repeat(4), '[SECRET]'],
    ['Ring +14155550132.', 'Ring [PHONE].'],
    ['{"password":"longer.name1@acme.io"}', '{"password":"[EMAIL]"}'],
    ['password: abcdefghijkl1', '[SECRET]'],
    ['+1 415-555-0132', '[PHONE]'],
  ]) {
    assert.equal(redact(text).text, want)
    assert.equal(findPii(want).length, 0, want)
  }
})

test('PII: card redaction keeps the text around it (#11)', () => {
  assert.equal(redact('Card 4111 1111 1111 1111 was charged').text, 'Card [CARD] was charged')
  assert.equal(redact('Card 4111-1111-1111-1111 - ok').text, 'Card [CARD] - ok')
  assert.equal(redact('4111111111111111').text, '[CARD]')
})

test('PII: order numbers, versions and prose stay (#11)', () => {
  for (const s of ['passwords are long', 'The password policy: use something memorable', 'order #PC-12345', 'order 100000012345', 'v1.22.333.4444', 'x = 1+14155550132', '+123456789.5', '+1 point',
    '"tokens": 123456789012', 'max_tokens=100000000000', '{"token_type": "authorization_code"}', 'secretary: abcdefghijklmnop', 'client_secret=', 'token_count=123456789012'])
    assert.equal(redact(s).text, s)
})

test('PII: a secret next to a bare card number in tool arguments is redacted and the JSON stays valid (#11)', () => {
  assert.equal(argsOf(redactRecord(call('{"card":4111111111111111,"password":"correcthorse12345"}'), ALL)), '{"card":"[CARD]","password":"[SECRET]"}')
  assert.equal(argsOf(redactRecord(call('{"password": "correcthorse12345"}'), ALL)), '{"password": "[SECRET]"}')
})
