/** Deterministic synthetic support-chat dataset with planted problems. */
import { rng } from './util.ts'

const SYSTEM = 'You are Nova, the support assistant for Parcelly, an online store. Be concise, friendly and accurate.'

type Cat = 'billing' | 'shipping' | 'account' | 'technical' | 'refund'
// imbalanced on purpose
const CAT_WEIGHTS: [Cat, number][] = [['billing', 0.52], ['shipping', 0.22], ['account', 0.12], ['technical', 0.1], ['refund', 0.04]]

const ITEMS = ['wireless earbuds', 'standing desk', 'espresso grinder', 'running shoes', 'smart thermostat', 'phone case', 'yoga mat', 'mechanical keyboard', 'air purifier', 'backpack']
const NAMES = ['Maya', 'Jordan', 'Priya', 'Lucas', 'Aiko', 'Sam', 'Elena', 'Omar', 'Grace', 'Theo', 'Nina', 'Ravi']

const Q: Record<Cat, ((o: string, item: string) => string)[]> = {
  billing: [
    (o) => `I was charged twice for order ${o}. Can you fix this?`,
    (o) => `Why is there a $4.99 fee on my invoice for ${o}?`,
    () => `My card keeps getting declined at checkout even though it works everywhere else.`,
    (o, i) => `Can I change the payment method on order ${o} for the ${i}?`,
    () => `Do you offer invoices with my company VAT number on them?`,
  ],
  shipping: [
    (o) => `Where is my order ${o}? Tracking hasn't updated in four days.`,
    (_, i) => `Do you ship the ${i} to Canada, and how long does it take?`,
    (o) => `The courier says ${o} was delivered but nothing is at my door.`,
    () => `Can I switch to express shipping after I already ordered?`,
  ],
  account: [
    () => `I can't log in. The reset email never arrives.`,
    () => `How do I delete my account and all my data?`,
    () => `Can I merge two accounts that I accidentally created?`,
  ],
  technical: [
    (_, i) => `My ${i} won't pair with my phone after the update.`,
    (_, i) => `The app crashes when I open the order page for the ${i}.`,
    () => `Your website shows a blank page on checkout in Safari.`,
  ],
  refund: [
    (o, i) => `The ${i} from ${o} arrived broken. I want a refund.`,
    (o) => `How long does a refund take for order ${o}?`,
  ],
}

const A: Record<Cat, ((o: string, item: string, n: string) => string)[]> = {
  billing: [
    (o) => `Sorry about that! I can see two charges for ${o}. One is a pre-authorization that drops off within 3 business days, so you'll only be billed once. If it is still there after that, reply here and I'll refund it right away.`,
    () => `That $4.99 is the small-order fee for orders under $25. It is listed at checkout, but I understand it is easy to miss. I've added a one-time credit to your account for your next order.`,
    () => `Declines at checkout usually come from the bank's fraud filter on a new merchant. Please try once more, then approve the prompt in your banking app. If it still fails, PayPal and Apple Pay both work too.`,
    (o) => `Yes. Open ${o} in Orders, choose "Payment", and pick a new card. The change applies before the order ships; after that we'd need to refund and recharge.`,
    () => `Yes. Add your VAT number under Account > Billing details and every new invoice will include it. For past invoices, tell me the order numbers and I'll reissue them.`,
  ],
  shipping: [
    (o) => `Thanks for your patience. ${o} is with the carrier and scanned at the regional hub yesterday; the tracking page lags a day or two. It should arrive within 2 business days. If not, I'll send a replacement.`,
    (_, i) => `We do ship the ${i} to Canada. Standard delivery takes 5 to 8 business days and duties are included in the price at checkout.`,
    (o) => `I'm sorry. Please check with neighbours and your building's mailroom first. If ${o} hasn't turned up in 48 hours, I'll open a carrier claim and ship a replacement at no cost.`,
    () => `If the order hasn't been packed yet, yes. Go to Orders, select it, and choose "Upgrade shipping". You'll only pay the difference.`,
  ],
  account: [
    () => `Reset emails sometimes land in spam or promotions. I've just triggered a new one; it is valid for 30 minutes. If it doesn't show up, tell me and I'll verify you another way.`,
    () => `You can delete your account under Account > Privacy > Delete account. We remove personal data within 30 days, except invoices we must keep for tax reasons.`,
    () => `We can merge them. Reply with the email address on the account you want to keep and I'll move your order history over.`,
  ],
  technical: [
    (_, i) => `Let's get your ${i} paired again: turn Bluetooth off and on, then hold the pairing button for 10 seconds until the light blinks white. Forget the old device on your phone and pair from scratch.`,
    () => `Thanks for reporting it. A fix ships in today's app update (version 5.2.1). Until then, the website works for the same order page.`,
    () => `This is a known Safari issue with an extension blocking our payment frame. Try disabling content blockers for parcelly.com, or use a private window.`,
  ],
  refund: [
    (o, i) => `I'm sorry the ${i} arrived damaged. I've started a full refund for ${o}; you'll get an email with a prepaid return label, and no need to return the broken item if it's unsafe.`,
    () => `Refunds are issued the same day the return is scanned and take 3 to 5 business days to appear on your statement, depending on your bank.`,
  ],
}

const OPENERS = ['', 'Hi, ', 'Hello, ', 'Hey there. ', 'Good morning. ', 'Hi team, ', 'Quick question: ', 'Hello again. ', 'Sorry to bother you, ', 'Urgent: ']
const CONTEXT = ['', ' I ordered it last week.', ' This is the second time this has happened.', ' I need it before the weekend.', ' My partner placed the order on our shared account.', ' I am a long-time customer.', ' I already tried the help center article.', ' It was a gift for my sister.', ' I am travelling until Friday.', ' The app shows something different from the website.', ' I have attached a screenshot in the earlier email.', ' Nobody answered on chat yesterday.']
const CLOSERS = ['', ' Thanks!', ' Thank you.', ' Appreciate it.', ' Please help.', ' Cheers.', ' Thanks in advance.']
const GREET = (n: string) => ['', `Hi ${n}, `, `Hello ${n}! `, `Thanks for reaching out, ${n}. `, `Hi there, `]
const TIPS = ['', ' You can also track everything under Orders in the app.', ' I have added a note to your account so the team has the full context.', ' If anything else comes up, just reply to this thread.', ' For faster help next time, the chat button in the app reaches us directly.', ' I have also emailed you a summary of this conversation.']
const SIGNOFF = ['', ' Have a great day!', ' Anything else I can help with?', ' Take care.', ' Hope that helps!']

const FOLLOW_UPS = ['Thanks! One more thing: can you send me a receipt?', 'Ok. And will I get an email confirmation?', 'Great, thank you.']
const FOLLOW_ANS = ['Of course, I have emailed the receipt to the address on your account.', 'Yes, you will get a confirmation email within a few minutes.', 'You are welcome! Anything else I can help with?']

const SPANISH = [
  ['¿Dónde está mi pedido? El seguimiento no se actualiza desde hace días.', 'Lo siento por la espera. Su pedido está en camino y debería llegar en dos días hábiles. Si no llega, le enviamos un reemplazo.'],
  ['Me cobraron dos veces por la misma compra.', 'Disculpe las molestias. Uno de los cargos es una preautorización que desaparece en tres días hábiles. Si no desaparece, se lo reembolsamos.'],
]
const GERMAN = [['Ich kann mich nicht anmelden, die E-Mail zum Zurücksetzen kommt nicht an.', 'Bitte prüfen Sie Ihren Spam-Ordner. Ich habe Ihnen gerade eine neue E-Mail geschickt, die 30 Minuten gültig ist.']]
const CHINESE = [['我的订单什么时候到？物流信息好几天没有更新了。', '很抱歉让您久等了。您的包裹已经在运输途中，预计两个工作日内送达。如果仍未收到，我们会免费补发。']]

const REFUSALS = [
  'As an AI language model, I cannot access your order history or billing details.',
  "I'm sorry, but I can't help with that request.",
  'I am unable to assist with that. Please contact customer support.',
]

const PII_SNIPPETS = (n: string) => [
  `my email is ${n.toLowerCase()}.miller@example.com`,
  `call me at +1 415-555-0132`,
  `here is my API key for the integration sk-live-4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c`,
  `our AWS key AKIAIOSFODNN7EXAMPLE stopped working`,
  `card 4111 1111 1111 1111 was charged`,
]

const LOG_LINE = (i: number) => `2026-10-${String((i % 28) + 1).padStart(2, '0')}T12:${String(i % 60).padStart(2, '0')}:07Z ERROR checkout-service request_id=${(i * 7919).toString(16)} payment_intent failed status=402 retry=${i % 5} upstream=stripe latency_ms=${200 + (i % 900)}`

export interface SampleInfo { bytes: Uint8Array; rows: number; planted: Record<string, number> }

/** Build the messy sample. n = number of intended examples (lines may differ slightly). */
export function messySupportSample(n = 1200, seed = 7): SampleInfo {
  const r = rng(seed)
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)]
  const cat = (): Cat => { let x = r(); for (const [c, w] of CAT_WEIGHTS) { if ((x -= w) < 0) return c } return 'billing' }
  const order = () => `#PC-${10000 + Math.floor(r() * 89999)}`
  const lines: (string | Uint8Array)[] = []
  const planted: Record<string, number> = {}
  const plant = (k: string) => { planted[k] = (planted[k] ?? 0) + 1 }
  const made: string[] = []
  for (let i = 0; i < n; i++) {
    const c = cat()
    const o = order()
    const item = pick(ITEMS)
    const name = pick(NAMES)
    const qi = Math.floor(r() * Q[c].length)
    const user = pick(OPENERS) + Q[c][qi](o, item) + pick(CONTEXT) + pick(CLOSERS)
    const assistant = pick(GREET(name)) + A[c][Math.min(qi, A[c].length - 1)](o, item, name) + pick(TIPS) + pick(SIGNOFF)
    const msgs: Record<string, unknown>[] = [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }, { role: 'assistant', content: assistant }]
    if (r() < 0.25) { const f = Math.floor(r() * FOLLOW_UPS.length); msgs.push({ role: 'user', content: FOLLOW_UPS[f] }, { role: 'assistant', content: FOLLOW_ANS[f] }) }
    const rec: Record<string, unknown> = { messages: msgs, category: c }
    const x = r()
    // planted problems, by probability band
    if (x < 0.04) { const prev = made.length ? made[Math.floor(r() * made.length)] : null; if (prev) { lines.push(prev); plant('exact_duplicate'); continue } }
    else if (x < 0.07) {
      const prev = made.length ? JSON.parse(made[Math.floor(r() * made.length)]) : null
      if (prev) {
        const pm = prev.messages as Record<string, string>[]
        const u = pm.find((m) => m.role === 'user')
        if (u) u.content = u.content.replace(/#PC-\d+/, order()).replace(/\?$/, '??').replace('Can you', 'could you')
        lines.push(JSON.stringify(prev)); plant('near_duplicate'); continue
      }
    }
    else if (x < 0.09) { (msgs[2] as Record<string, unknown>).content = ''; plant('empty_assistant') }
    else if (x < 0.10) { (msgs[1] as Record<string, unknown>).content = '   \n  '; plant('whitespace_user') }
    else if (x < 0.12) { msgs.push({ role: 'user', content: 'Hello? Are you still there?' }); plant('missing_final_assistant') }
    else if (x < 0.13) { msgs.splice(1, 0, { role: 'assistant', content: 'Hi! How can I help you today?' }); plant('assistant_before_user') }
    else if (x < 0.14) { msgs.splice(2, 0, { role: 'user', content: 'Also, it is urgent.' }); plant('double_user') }
    else if (x < 0.15) { (msgs[1] as Record<string, unknown>).role = 'customer'; plant('unknown_role') }
    else if (x < 0.17) { (msgs[1] as Record<string, unknown>).timestamp = '2026-10-02T10:14:00Z'; rec.ticket_id = 40000 + i; plant('unknown_key') }
    else if (x < 0.205) { (msgs[1] as Record<string, unknown>).content = `${user} (${pick(PII_SNIPPETS(name))})`; plant('pii') }
    else if (x < 0.235) { (msgs[2] as Record<string, unknown>).content = pick(REFUSALS); plant('refusal') }
    else if (x < 0.265) { const [u, a] = pick(SPANISH); msgs[1] = { role: 'user', content: u }; msgs[2] = { role: 'assistant', content: a }; plant('spanish') }
    else if (x < 0.275) { const [u, a] = pick(GERMAN); msgs[1] = { role: 'user', content: u }; msgs[2] = { role: 'assistant', content: a }; plant('german') }
    else if (x < 0.285) { const [u, a] = pick(CHINESE); msgs[1] = { role: 'user', content: u }; msgs[2] = { role: 'assistant', content: a }; plant('chinese') }
    else if (x < 0.30) { (msgs[2] as Record<string, unknown>).content = 'ok'; plant('short_answer') }
    else if (x < 0.3025) {
      // giant pasted log: blows past the max sequence length
      const log = Array.from({ length: 1300 }, (_, k) => LOG_LINE(k + i)).join('\n')
      ;(msgs[1] as Record<string, unknown>).content = `Checkout fails, here are our logs:\n${log}`
      plant('oversize')
    }
    else if (x < 0.31) { lines.push(JSON.stringify(rec).slice(0, 90)); plant('broken_json'); continue }
    else if (x < 0.312) {
      const enc = new TextEncoder().encode(JSON.stringify(rec))
      const bad = new Uint8Array(enc.length + 2)
      const cut = enc.indexOf(0x2e) // first "."
      bad.set(enc.subarray(0, cut)); bad.set([0xff, 0xfe], cut); bad.set(enc.subarray(cut), cut + 2)
      lines.push(bad); plant('invalid_utf8'); continue
    }
    else if (x < 0.315) { (msgs[2] as Record<string, unknown>).content = `   ${assistant}   \n\n`; plant('padded_whitespace') }
    const s = JSON.stringify(rec)
    made.push(s)
    lines.push(s)
  }
  const enc = new TextEncoder()
  const parts = lines.map((l) => (typeof l === 'string' ? enc.encode(l + '\n') : new Uint8Array([...l, 10])))
  const total = parts.reduce((a, p) => a + p.length, 0)
  const bytes = new Uint8Array(total)
  let o = 0
  for (const p of parts) { bytes.set(p, o); o += p.length }
  return { bytes, rows: lines.length, planted }
}

export const SAMPLE_HF_ID = 'HuggingFaceH4/no_robots'
export const SAMPLE_HF_SPLIT = 'test'
