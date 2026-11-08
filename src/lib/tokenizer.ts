/** Loads a model's real tokenizer (tokenizer.json + tokenizer_config.json + chat
 * template) from the Hugging Face Hub, caches the files with the Cache API, and
 * adapts it to the engine's TokenizerLike. Works in the main thread and in workers. */
import type { TokenizerLike } from '../engine/tokens.ts'
import { getModel } from '../engine/rules.ts'

const CACHE = 'dataset-studio-tokenizers-v1'

type Progress = (loaded: number, total: number, file: string) => void

async function fetchCached(url: string, onProgress?: Progress, optional = false): Promise<Response | null> {
  let cache: Cache | null = null
  try { cache = await caches.open(CACHE) } catch { /* no Cache API (private mode / node) */ }
  const hit = cache && (await cache.match(url))
  if (hit) return hit
  const res = await fetch(url)
  if (!res.ok) {
    if (optional) return null
    throw new Error(`${res.status} fetching ${url.split('/resolve/')[0].split('huggingface.co/')[1]}: ${res.status === 401 ? 'gated repository' : res.statusText}`)
  }
  const total = Number(res.headers.get('content-length')) || 0
  const reader = res.body!.getReader()
  const parts: Uint8Array[] = []
  let loaded = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
    loaded += value.length
    onProgress?.(loaded, total, url.split('/').pop()!)
  }
  const body = new Blob(parts as BlobPart[])
  const out = new Response(body, { headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' } })
  if (cache) await cache.put(url, out.clone()).catch(() => {})
  return out
}

const tokenString = (t: unknown): string | undefined => (typeof t === 'string' ? t : t && typeof t === 'object' && 'content' in t ? String((t as { content: unknown }).content) : undefined)

export interface LoadedTokenizer extends TokenizerLike {
  repo: string
  hasTemplate: boolean
  approximate: boolean
}

/** Rough fallback (about 3.6 characters per token) for models without a JS-loadable tokenizer. */
function approximate(): LoadedTokenizer {
  return {
    repo: '', hasTemplate: false, approximate: true, render: null,
    ids: (t) => new Array(Math.ceil(t.length / 3.6)).fill(0),
  }
}

const memo = new Map<string, Promise<LoadedTokenizer>>()

export function loadTokenizer(modelId: string, onProgress?: Progress): Promise<LoadedTokenizer> {
  const repo = getModel(modelId).tokenizer
  if (!repo) return Promise.resolve(approximate())
  let p = memo.get(repo)
  if (!p) {
    p = load(repo, onProgress)
    memo.set(repo, p)
    p.catch(() => memo.delete(repo))
  }
  return p
}

async function load(repo: string, onProgress?: Progress): Promise<LoadedTokenizer> {
  const base = `https://huggingface.co/${repo}/resolve/main/`
  const [{ Tokenizer }, { Template }] = await Promise.all([import('@huggingface/tokenizers'), import('@huggingface/jinja')])
  const [tj, tc, tmplRes] = await Promise.all([
    fetchCached(base + 'tokenizer.json', onProgress).then((r) => r!.json()),
    fetchCached(base + 'tokenizer_config.json').then((r) => r!.json()),
    fetchCached(base + 'chat_template.jinja', undefined, true),
  ])
  const tok = new Tokenizer(tj, tc)
  let templateSrc: string | null = tmplRes ? await tmplRes.text() : null
  if (!templateSrc && typeof tc.chat_template === 'string') templateSrc = tc.chat_template
  if (!templateSrc && Array.isArray(tc.chat_template)) templateSrc = tc.chat_template.find((t: { name: string }) => t.name === 'default')?.template ?? null
  const bos = tokenString(tc.bos_token) ?? ''
  const eos = tokenString(tc.eos_token) ?? ''
  const template = templateSrc ? new Template(templateSrc) : null
  return {
    repo,
    hasTemplate: !!template,
    approximate: false,
    eos,
    ids: (text) => tok.encode(text, { add_special_tokens: false }).ids,
    render: template
      ? (messages, opts) => template.render({
        messages, tools: opts?.tools, add_generation_prompt: !!opts?.addGenerationPrompt,
        bos_token: bos, eos_token: eos, pad_token: tokenString(tc.pad_token) ?? '', unk_token: tokenString(tc.unk_token) ?? '',
      })
      : null,
  }
}

export async function clearTokenizerCache(): Promise<void> {
  memo.clear()
  try { await caches.delete(CACHE) } catch { /* ignore */ }
}
