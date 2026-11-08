// Together AI fine-tuning rules, limits and prices.
// Everything here was read from Together's public docs, pricing page and the
// together-py SDK source on RULES_CHECKED. Re-check the sources before relying
// on a number for a large job; Together updates these pages often.

export const RULES_CHECKED = '2026-11-07'

export const SOURCES = {
  dataPrep: 'https://docs.together.ai/docs/fine-tuning-data-preparation',
  models: 'https://docs.together.ai/docs/fine-tuning-models',
  pricing: 'https://www.together.ai/pricing',
  quickstart: 'https://docs.together.ai/docs/fine-tuning/quickstart',
  preference: 'https://docs.together.ai/docs/fine-tuning/preference-tuning',
  checkerFaq: 'https://support.together.ai/articles/4829553598-can-i-check-if-my-training-file-is-formatted-correctly',
  sdkConstants: 'https://github.com/togethercomputer/together-py/blob/main/src/together/lib/constants.py',
  sdkChecks: 'https://github.com/togethercomputer/together-py/blob/main/src/together/lib/utils/files.py',
  pypi: 'https://pypi.org/project/together/',
} as const

/** Python SDK + CLI version the generated commands are pinned to (PyPI, released 2026-11-04). */
export const TOGETHER_SDK_VERSION = '3.1.1'

export const LIMITS = {
  /** Docs: "File size limit: 100 GB for either format." The SDK's client-side check (MAX_FILE_SIZE_GB) still rejects above 50.1 GiB, so that is the effective limit when uploading with the CLI/SDK. */
  maxFileBytesDocs: 100 * 1024 ** 3,
  maxFileBytesSdk: 50.1 * 1024 ** 3,
  /** SDK MIN_SAMPLES */
  minSamples: 1,
  /** Message roles accepted by the SDK (POSSIBLE_ROLES_CONVERSATION). */
  roles: ['system', 'user', 'assistant', 'tool'] as const,
  /** Root keys per format (JSONL_REQUIRED_COLUMNS_MAP + extras + documented sample weight). */
  rootKeys: {
    conversational: ['messages', 'tools', 'weight'],
    instruction: ['prompt', 'completion', 'weight'],
    preference: ['input', 'preferred_output', 'non_preferred_output', 'weight'],
    text: ['text', 'weight'],
  },
  /** Keys a message object may carry (docs: tool calling, reasoning, per-message weight). */
  messageKeys: ['role', 'content', 'weight', 'tool_calls', 'tool_call_id', 'name', 'reasoning', 'reasoning_content'],
  /** Parquet must be pre-tokenized with these columns (PARQUET_EXPECTED_COLUMNS); input_ids is required. */
  parquetColumns: ['input_ids', 'attention_mask', 'labels', 'position_ids'],
  /** Lines this many times larger (in bytes) than max_seq_length cannot fit even at a generous 8 bytes/token. */
  oversizeBytesPerToken: 8,
} as const

export type Method = 'sft' | 'dpo'

export interface ModelSpec {
  id: string
  name: string
  org: string
  /** Max sequence length for SFT and DPO, LoRA (tokens). */
  ctxSft: number
  ctxDpo: number
  full: boolean
  /** USD per 1M tokens. LoRA = pricing table 1, full = table 2. null = not listed. */
  price: { loraSft: number; loraDpo: number; fullSft?: number; fullDpo?: number; min: number } | null
  /** Ungated Hugging Face repo with tokenizer.json (+ chat template). null = no JS tokenizer available. */
  tokenizer: string | null
  /** Active parameters in billions, used only for the rough runtime estimate. */
  activeB: number
}

// Context lengths: fine-tuning-models page (LoRA table). DPO note from the
// preference-tuning page: "half the context length is used for the preferred
// response and half for the non-preferred", which the DPO column already
// reflects, so DPO rows are checked per side against ctxDpo.
export const MODELS: ModelSpec[] = [
  { id: 'Qwen/Qwen3.5-9B', name: 'Qwen3.5 9B', org: 'Qwen', ctxSft: 65536, ctxDpo: 49152, full: true, price: { loraSft: 0.34, loraDpo: 0.84, fullSft: 0.38, fullDpo: 0.94, min: 4 }, tokenizer: 'Qwen/Qwen3.5-9B', activeB: 9 },
  { id: 'Qwen/Qwen3.5-4B', name: 'Qwen3.5 4B', org: 'Qwen', ctxSft: 131072, ctxDpo: 65536, full: true, price: { loraSft: 0.34, loraDpo: 0.84, fullSft: 0.38, fullDpo: 0.94, min: 4 }, tokenizer: 'Qwen/Qwen3.5-4B', activeB: 4 },
  { id: 'Qwen/Qwen3.5-27B', name: 'Qwen3.5 27B', org: 'Qwen', ctxSft: 131072, ctxDpo: 65536, full: true, price: { loraSft: 1.05, loraDpo: 2.62, fullSft: 1.16, fullDpo: 2.88, min: 4 }, tokenizer: 'Qwen/Qwen3.5-27B', activeB: 27 },
  { id: 'Qwen/Qwen3.6-27B', name: 'Qwen3.6 27B', org: 'Qwen', ctxSft: 131072, ctxDpo: 65536, full: true, price: { loraSft: 1.05, loraDpo: 2.62, fullSft: 1.16, fullDpo: 2.88, min: 4 }, tokenizer: 'Qwen/Qwen3.6-27B', activeB: 27 },
  { id: 'Qwen/Qwen3.8-27B', name: 'Qwen3.8 27B', org: 'Qwen', ctxSft: 131072, ctxDpo: 65536, full: true, price: { loraSft: 1.05, loraDpo: 2.62, min: 4 }, tokenizer: 'Qwen/Qwen3.8-27B', activeB: 27 },
  { id: 'Qwen/Qwen3.5-35B-A3B', name: 'Qwen3.5 35B A3B', org: 'Qwen', ctxSft: 65536, ctxDpo: 32768, full: false, price: { loraSft: 1.05, loraDpo: 2.62, min: 4 }, tokenizer: 'Qwen/Qwen3.5-35B-A3B', activeB: 3 },
  { id: 'Qwen/Qwen3.6-35B-A3B', name: 'Qwen3.6 35B A3B', org: 'Qwen', ctxSft: 65536, ctxDpo: 32768, full: false, price: { loraSft: 1.05, loraDpo: 2.62, min: 4 }, tokenizer: 'Qwen/Qwen3.6-35B-A3B', activeB: 3 },
  { id: 'Qwen/Qwen3.5-122B-A10B', name: 'Qwen3.5 122B A10B', org: 'Qwen', ctxSft: 65536, ctxDpo: 32768, full: false, price: { loraSft: 4.2, loraDpo: 10.5, min: 10 }, tokenizer: 'Qwen/Qwen3.5-122B-A10B', activeB: 10 },
  { id: 'Qwen/Qwen3.5-397B-A17B', name: 'Qwen3.5 397B A17B', org: 'Qwen', ctxSft: 32768, ctxDpo: 16384, full: false, price: { loraSft: 5.6, loraDpo: 14, min: 22 }, tokenizer: 'Qwen/Qwen3.5-397B-A17B', activeB: 17 },
  { id: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Reference', name: 'Llama 3.1 8B Instruct', org: 'Meta', ctxSft: 131072, ctxDpo: 65536, full: true, price: { loraSft: 0.34, loraDpo: 0.84, fullSft: 0.38, fullDpo: 0.94, min: 4 }, tokenizer: 'unsloth/Meta-Llama-3.1-8B-Instruct', activeB: 8 },
  { id: 'meta-llama/Llama-3.3-70B-Instruct-Reference', name: 'Llama 3.3 70B Instruct', org: 'Meta', ctxSft: 24576, ctxDpo: 12288, full: true, price: { loraSft: 2.03, loraDpo: 5.08, fullSft: 2.24, fullDpo: 5.6, min: 4 }, tokenizer: 'unsloth/Llama-3.3-70B-Instruct', activeB: 70 },
  { id: 'meta-llama/Llama-4-Scout-17B-16E-Instruct', name: 'Llama 4 Scout', org: 'Meta', ctxSft: 65536, ctxDpo: 12288, full: false, price: { loraSft: 2.1, loraDpo: 5.25, min: 6 }, tokenizer: 'unsloth/Llama-4-Scout-17B-16E-Instruct', activeB: 17 },
  { id: 'meta-llama/Llama-4-Maverick-17B-128E-Instruct', name: 'Llama 4 Maverick', org: 'Meta', ctxSft: 16384, ctxDpo: 24576, full: false, price: { loraSft: 5.6, loraDpo: 14, min: 16 }, tokenizer: 'unsloth/Llama-4-Maverick-17B-128E-Instruct', activeB: 17 },
  { id: 'google/gemma-4-31B-it', name: 'Gemma 4 31B IT', org: 'Google', ctxSft: 49152, ctxDpo: 24576, full: true, price: { loraSft: 1.05, loraDpo: 2.62, fullSft: 1.16, fullDpo: 2.88, min: 4 }, tokenizer: 'google/gemma-4-31B-it', activeB: 31 },
  { id: 'google/gemma-4-26B-A4B-it', name: 'Gemma 4 26B A4B IT', org: 'Google', ctxSft: 49152, ctxDpo: 24576, full: false, price: { loraSft: 1.05, loraDpo: 2.62, min: 4 }, tokenizer: 'google/gemma-4-26B-A4B-it', activeB: 4 },
  { id: 'openai/gpt-oss-20b', name: 'gpt-oss 20B', org: 'OpenAI', ctxSft: 131072, ctxDpo: 65536, full: false, price: { loraSft: 0.4, loraDpo: 1, min: 4 }, tokenizer: 'openai/gpt-oss-20b', activeB: 4 },
  { id: 'openai/gpt-oss-120b', name: 'gpt-oss 120B', org: 'OpenAI', ctxSft: 65536, ctxDpo: 32768, full: false, price: { loraSft: 2.5, loraDpo: 6.25, min: 6 }, tokenizer: 'openai/gpt-oss-120b', activeB: 5 },
  { id: 'mistralai/Mixtral-8x7B-Instruct-v0.1', name: 'Mixtral 8x7B Instruct', org: 'Mistral', ctxSft: 32768, ctxDpo: 16384, full: true, price: { loraSft: 1.05, loraDpo: 2.62, fullSft: 1.16, fullDpo: 2.88, min: 4 }, tokenizer: 'mistralai/Mixtral-8x7B-Instruct-v0.1', activeB: 13 },
  { id: 'deepseek-ai/DeepSeek-V3.1', name: 'DeepSeek V3.1', org: 'DeepSeek', ctxSft: 65536, ctxDpo: 32768, full: false, price: { loraSft: 7, loraDpo: 17.5, min: 20 }, tokenizer: 'deepseek-ai/DeepSeek-V3.1', activeB: 37 },
  { id: 'deepseek-ai/DeepSeek-V4-Flash-0731', name: 'DeepSeek V4 Flash 0731', org: 'DeepSeek', ctxSft: 131072, ctxDpo: 32768, full: false, price: { loraSft: 6, loraDpo: 15, min: 12 }, tokenizer: 'deepseek-ai/DeepSeek-V4-Flash-0731', activeB: 13 },
  { id: 'zai-org/GLM-5.2', name: 'GLM 5.2', org: 'Z.ai', ctxSft: 50688, ctxDpo: 25344, full: false, price: { loraSft: 40, loraDpo: 100, min: 60 }, tokenizer: 'zai-org/GLM-5.2', activeB: 40 },
  { id: 'moonshotai/Kimi-K2.6', name: 'Kimi K2.6', org: 'Moonshot AI', ctxSft: 32768, ctxDpo: 16384, full: false, price: { loraSft: 15, loraDpo: 37.5, min: 60 }, tokenizer: null, activeB: 32 },
]

export const DEFAULT_MODEL = 'Qwen/Qwen3.5-9B'

export function getModel(id: string): ModelSpec {
  return MODELS.find((m) => m.id === id) ?? MODELS[0]
}

/** Rough training throughput assumption (tokens/second for one job) by active size.
 * Together does not publish throughput; this is a planning number, editable in the UI.
 * Calibrated loosely against the quickstart's "roughly 20 to 40 minutes" for its example. */
export function assumedThroughput(activeB: number): number {
  if (activeB <= 5) return 9000
  if (activeB <= 10) return 6000
  if (activeB <= 20) return 3500
  if (activeB <= 40) return 2200
  return 1200
}
