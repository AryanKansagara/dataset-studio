import type { BrowserContext } from '@playwright/test'
import { parquetWriteBuffer } from 'hyparquet-writer'

const cors = { 'access-control-allow-origin': '*', 'access-control-expose-headers': '*' }

/** A tokenizer small enough to count by hand: one token per space-separated word. */
export const VOCAB = { '[UNK]': 0, '<s>': 1, '</s>': 2, user: 3, assistant: 4, q: 5, a: 6, b: 7 }
const TOKENIZER = {
  version: '1.0', truncation: null, padding: null, added_tokens: [], normalizer: null,
  pre_tokenizer: { type: 'WhitespaceSplit' }, post_processor: null, decoder: null,
  model: { type: 'WordPiece', unk_token: '[UNK]', continuing_subword_prefix: '##', max_input_chars_per_word: 1000, vocab: VOCAB },
}
/** Every message costs 3 tokens ("<s>", the role, "</s>") plus one per word. */
export const TEMPLATE = "{% for m in messages %}<s> {{ m['role'] }} {{ m['content'] }} </s>\n{% endfor %}{% if add_generation_prompt %}<s> assistant{% endif %}"

/** Serves the stand-in tokenizer for every model repo on the Hub. */
export async function serveTokenizer(context: BrowserContext, template = TEMPLATE) {
  await context.route(/^https:\/\/huggingface\.co\/.*\/resolve\/main\//, (route) => {
    const file = route.request().url().split('/').pop()
    if (file === 'tokenizer.json') return route.fulfill({ json: TOKENIZER, headers: cors })
    if (file === 'tokenizer_config.json') return route.fulfill({ json: { tokenizer_class: 'PreTrainedTokenizerFast', eos_token: ' </s>', chat_template: template }, headers: cors })
    return route.fulfill({ status: 404, body: '', headers: cors })
  })
}

export const parquet = (columns: Record<string, string[]>) =>
  Buffer.from(parquetWriteBuffer({ columnData: Object.entries(columns).map(([name, data]) => ({ name, data, type: 'STRING' as const })) }))

/** Serves one public dataset (a single Parquet file, with range requests) the way the Hub does. */
export async function serveDataset(context: BrowserContext, dataset: string, file: Buffer) {
  const url = `https://huggingface.co/datasets/${dataset}/resolve/refs%2Fconvert%2Fparquet/default/train/0000.parquet`
  await context.route(/^https:\/\/datasets-server\.huggingface\.co\/parquet/, (route) => {
    if (new URL(route.request().url()).searchParams.get('dataset') !== dataset) return route.fulfill({ status: 404, json: { error: 'The dataset does not exist.' }, headers: cors })
    return route.fulfill({ json: { parquet_files: [{ config: 'default', split: 'train', url, size: file.length }] }, headers: cors })
  })
  await context.route(/0000\.parquet$/, (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...cors, 'access-control-allow-headers': '*' } })
    const m = /bytes=(\d*)-(\d*)/.exec(route.request().headers().range ?? '')
    if (!m) return route.fulfill({ body: file, headers: cors })
    const start = m[1] ? Number(m[1]) : file.length - Number(m[2])
    const end = m[1] && m[2] ? Math.min(Number(m[2]) + 1, file.length) : file.length
    return route.fulfill({ status: 206, body: file.subarray(start, end), headers: { ...cors, 'content-range': `bytes ${start}-${end - 1}/${file.length}` } })
  })
}
