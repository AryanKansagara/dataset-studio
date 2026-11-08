/** Export artifacts: JSONL text, upload + fine-tune commands, dataset card. */
import type { Format } from './mapping.ts'
import { FORMAT_LABEL } from './mapping.ts'
import { getModel, RULES_CHECKED, SOURCES, TOGETHER_SDK_VERSION, type Method } from './rules.ts'
import type { Report } from './pipeline.ts'
import { estimateCost, fmtDuration, fmtUsd } from './cost.ts'
import { LANG_NAME, PII_LABEL } from './quality.ts'

export interface JobSettings {
  model: string
  method: Method
  lora: boolean
  epochs: number
  nEvals: number
  maxSeq: number | null
  trainOnInputs: 'auto' | 'true' | 'false'
  suffix: string
  seed: number
  dpoBeta: number
  learningRate: number
}

export const DEFAULT_JOB: JobSettings = {
  model: 'Qwen/Qwen3.5-9B', method: 'sft', lora: true, epochs: 3, nEvals: 5, maxSeq: null,
  trainOnInputs: 'auto', suffix: '', seed: 42, dpoBeta: 0.1, learningRate: 1e-5,
}

export function toJsonl(recs: Iterable<Record<string, unknown>>): string {
  let out = ''
  for (const r of recs) out += JSON.stringify(r) + '\n'
  return out
}

export interface CommandFiles { train: string; val: string | null }

const q = (s: string) => `"${s.replace(/"/g, '\\"')}"`

export function limitFor(job: JobSettings): number {
  const m = getModel(job.model)
  const ctx = job.method === 'dpo' ? m.ctxDpo : m.ctxSft
  return job.maxSeq ? Math.min(job.maxSeq, ctx) : ctx
}

export function cliCommands(job: JobSettings, files: CommandFiles, format: Format): string {
  const lines = [
    `# Together CLI, pinned to the SDK version these commands were checked against`,
    `uv tool install "together[cli]==${TOGETHER_SDK_VERSION}"   # or: pip install "together==${TOGETHER_SDK_VERSION}"`,
    `export TOGETHER_API_KEY=...`,
    ``,
    `# 1. Client-side check (UTF-8 and one JSON object per line; the schema is validated server-side after upload)`,
    `tg files check ${files.train}`,
    ...(files.val ? [`tg files check ${files.val}`] : []),
    ``,
    `# 2. Create the job. Local paths are uploaded first; you can also pass file ids from \`tg files upload\`.`,
  ]
  const flags: string[] = [`--training-file ${files.train}`]
  if (files.val) flags.push(`--validation-file ${files.val}`, `--n-evals ${job.nEvals}`)
  flags.push(`--model ${q(job.model)}`)
  if (job.lora) flags.push('--lora')
  flags.push(`--n-epochs ${job.epochs}`, `--learning-rate ${job.learningRate}`)
  if (job.method === 'dpo') flags.push('--training-method dpo', `--dpo-beta ${job.dpoBeta}`)
  else if (format === 'conversational' || format === 'instruction') flags.push(`--train-on-inputs ${job.trainOnInputs}`)
  if (job.maxSeq) flags.push(`--max-seq-length ${job.maxSeq}`)
  flags.push(`--random-seed ${job.seed}`)
  if (job.suffix) flags.push(`--suffix ${q(job.suffix)}`)
  lines.push('tg fine-tuning create \\', ...flags.map((f, i) => `  ${f}${i < flags.length - 1 ? ' \\' : ''}`))
  lines.push('', '# 3. Follow the job', 'tg fine-tuning list-events <JOB_ID>')
  return lines.join('\n')
}

export function pythonCommands(job: JobSettings, files: CommandFiles, format: Format): string {
  const args: string[] = [`    training_file=train.id,`]
  if (files.val) args.push(`    validation_file=val.id,`, `    n_evals=${job.nEvals},`)
  args.push(`    model=${q(job.model)},`)
  args.push(`    lora=${job.lora ? 'True' : 'False'},`, `    n_epochs=${job.epochs},`, `    learning_rate=${job.learningRate},`)
  if (job.method === 'dpo') args.push(`    training_method="dpo",`, `    dpo_beta=${job.dpoBeta},`)
  else if (format === 'conversational' || format === 'instruction') args.push(`    train_on_inputs=${job.trainOnInputs === 'auto' ? '"auto"' : job.trainOnInputs === 'true' ? 'True' : 'False'},`)
  if (job.maxSeq) args.push(`    max_seq_length=${job.maxSeq},`)
  args.push(`    random_seed=${job.seed},`)
  if (job.suffix) args.push(`    suffix=${q(job.suffix)},`)
  return [
    `# pip install "together==${TOGETHER_SDK_VERSION}"`,
    `from together import Together`,
    ``,
    `client = Together()  # reads TOGETHER_API_KEY`,
    ``,
    `train = client.files.upload(file=${q(files.train)}, purpose="fine-tune", check=True)`,
    ...(files.val ? [`val = client.files.upload(file=${q(files.val)}, purpose="fine-tune", check=True)`] : []),
    ``,
    `# Server-side schema validation runs after upload: wait for COMPLETED`,
    `print(client.files.retrieve(train.id))`,
    ``,
    `job = client.fine_tuning.create(`,
    ...args,
    `)`,
    `print(job.id, job.status)`,
  ].join('\n')
}

export interface CardInput {
  name: string
  source: string
  job: JobSettings
  report: Report
  versionLabel: string
  createdAt: string
}

export function datasetCard(c: CardInput): string {
  const r = c.report
  const m = getModel(c.job.model)
  const t = r.tokens
  const cost = t ? estimateCost({ model: m, method: c.job.method, lora: c.job.lora, epochs: c.job.epochs, nEvals: r.val ? c.job.nEvals : 0, trainTokens: t.train, valTokens: t.val }) : null
  const q2 = r.quality
  const lines = [
    `# ${c.name}`,
    ``,
    `Fine-tuning dataset prepared with Dataset Studio for Together AI.`,
    ``,
    `| | |`,
    `|---|---|`,
    `| Version | ${c.versionLabel} (${c.createdAt.slice(0, 10)}) |`,
    `| Source | ${c.source} |`,
    `| Format | ${FORMAT_LABEL[r.format]} |`,
    `| Examples | ${r.rows.toLocaleString()} (train ${r.train.toLocaleString()}, validation ${r.val.toLocaleString()}${r.stratified ? ', stratified' : ''}, seed ${c.job.seed}) |`,
    `| Target model | \`${m.id}\` (${c.job.lora ? 'LoRA' : 'full'} ${c.job.method.toUpperCase()}) |`,
  ]
  if (t) {
    lines.push(
      `| Tokens | ${t.total.toLocaleString()} total${t.exact ? '' : ` (estimated from ${t.sampled.toLocaleString()} sampled rows)`}; median ${t.p50}, p95 ${t.p95}, max ${t.max.toLocaleString()} |`,
      `| Max sequence length | ${t.limit.toLocaleString()}; ${t.over} examples over (${t.cut.toLocaleString()} tokens cut) |`,
    )
  }
  if (cost && cost.total !== null) lines.push(`| Estimated cost | ${fmtUsd(cost.total)} for ${c.job.epochs} epochs at $${cost.pricePerM}/1M tokens${cost.minApplied ? ' (minimum charge)' : ''}, about ${fmtDuration(cost.hours)} of training (assumption) |`)
  lines.push(
    ``,
    `## Processing`,
    ``,
    r.log.length ? r.log.map((l, i) => `${i + 1}. ${l.label}: ${l.dropped ? `${l.dropped} dropped` : ''}${l.dropped && l.modified ? ', ' : ''}${l.modified ? `${l.modified} modified` : ''}${!l.dropped && !l.modified ? 'no change' : ''}`).join('\n') : 'No fixes applied; data exported as imported.',
    ``,
    `## Remaining checks`,
    ``,
    `- Validation: ${r.issues.rowsWithErrors} rows with errors, ${r.issues.rowsWithWarnings} with warnings only`,
    `- Exact duplicates: ${q2.exactDup.rows}; near-duplicates: ${q2.nearDup.rows}`,
    `- Train/validation leakage: ${q2.leakage.rows} validation rows`,
    `- PII / secrets: ${q2.pii.rows} rows${Object.keys(q2.pii.byKind).length ? ` (${Object.entries(q2.pii.byKind).map(([k, n]) => `${PII_LABEL[k as keyof typeof PII_LABEL]} ${n}`).join(', ')})` : ''}`,
    `- Boilerplate refusals: ${q2.refusals.rows}`,
    `- Languages: ${q2.language.dist.slice(0, 6).map(([l, n]) => `${LANG_NAME[l] ?? l} ${n}`).join(', ')}`,
    `- Answer length outliers: ${q2.outliers.low} short, ${q2.outliers.high} long`,
  )
  if (q2.labels.labels.length > 1) lines.push(`- Labels (${q2.labels.source === 'column' ? 'label column' : 'answers'}): ${q2.labels.labels.slice(0, 10).map(([l, n]) => `${l} ${n}`).join(', ')}; imbalance ${q2.labels.ratio.toFixed(1)}:1`)
  lines.push(
    ``,
    `## Assumptions`,
    ``,
    `Rules, context lengths and prices as published by Together AI on ${RULES_CHECKED}:`,
    `- ${SOURCES.dataPrep}`,
    `- ${SOURCES.models}`,
    `- ${SOURCES.pricing}`,
    ``,
  )
  return lines.join('\n')
}
