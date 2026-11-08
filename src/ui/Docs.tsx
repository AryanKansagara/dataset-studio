import { useEffect } from 'react'
import { A } from './common.tsx'
import { Page } from './Shell.tsx'
import { LIMITS, MODELS, RULES_CHECKED, SOURCES, TOGETHER_SDK_VERSION } from '../engine/rules.ts'
import { ISSUE_INFO, type IssueCode } from '../engine/validate.ts'

const SQL_PG = `-- export.sql: one JSON object per resolved conversation, in Together's conversational format.
-- Assumes messages(conversation_id, author_type, body, created_at, is_internal_note).
SELECT json_build_object(
  'messages',
  jsonb_build_array(jsonb_build_object('role', 'system', 'content', 'You are Acme support.'))
    || jsonb_agg(
         jsonb_build_object(
           'role', CASE WHEN m.author_type = 'agent' THEN 'assistant' ELSE 'user' END,
           'content', m.body)
         ORDER BY m.created_at),
  'category', c.category            -- optional: map it as the label column
)
FROM conversations c
JOIN messages m ON m.conversation_id = c.id
WHERE c.status = 'resolved' AND NOT m.is_internal_note
GROUP BY c.id, c.category;

-- Run it unaligned and tuples-only, so each row is exactly one JSON line:
--   psql "$DATABASE_URL" -At -f export.sql > support.jsonl
-- Avoid COPY ... TO in text format: it escapes backslashes and corrupts "\\n" inside JSON.`

const SQL_BQ = `EXPORT DATA OPTIONS (
  uri = 'gs://my-bucket/finetune/support-*.json',
  format = 'JSON',          -- newline-delimited JSON, one object per line
  overwrite = true
) AS
SELECT
  ARRAY_CONCAT(
    [STRUCT('system' AS role, 'You are Acme support.' AS content)],
    ARRAY_AGG(STRUCT(IF(author_type = 'agent', 'assistant', 'user') AS role, body AS content) ORDER BY created_at)
  ) AS messages,
  ANY_VALUE(category) AS category
FROM \`project.support.messages\`
WHERE NOT is_internal_note
GROUP BY conversation_id;`

const PANDAS = `import pandas as pd

df = pd.read_csv("tickets.csv")            # any columns; map them in the studio
df.to_json("tickets.jsonl", orient="records", lines=True, force_ascii=False)

# or keep it as Parquet (Dataset Studio reads it in the browser)
df.to_parquet("tickets.parquet", index=False)`

const LOGS = `# Chat logs your app already sent to an LLM (OpenAI-style request + response):
import json
with open("train.jsonl", "w", encoding="utf-8") as out:
    for rec in logs:                                # your log store
        msgs = rec["request"]["messages"] + [rec["response"]["choices"][0]["message"]]
        out.write(json.dumps({"messages": msgs}, ensure_ascii=False) + "\\n")`

const SECTIONS = [
  ['how', 'How it works'],
  ['export', 'Getting your data out'],
  ['formats', 'Formats and mapping'],
  ['checks', 'What is checked'],
  ['rules', 'Rules, limits and prices'],
  ['cost', 'Cost and time estimates'],
  ['privacy', 'Privacy and sync'],
  ['limits', 'Known limits'],
] as const

export default function Docs() {
  useEffect(() => {
    if (location.hash) setTimeout(() => document.getElementById(location.hash.slice(1))?.scrollIntoView(), 50)
  }, [])
  return (
    <Page>
      <div className="page-title"><div><span className="tag">Docs</span><h1 style={{ marginTop: 10 }}>Using Dataset Studio</h1><p className="muted" style={{ marginTop: 10 }}>Rules and prices checked {RULES_CHECKED} against Together's docs and the together-py {TOGETHER_SDK_VERSION} source.</p></div></div>
      <div className="doc-layout">
        <nav className="toc" aria-label="On this page">{SECTIONS.map(([id, t]) => <a key={id} href={`#${id}`}>{t}</a>)}</nav>
        <article className="doc">
          <h2 id="how" style={{ marginTop: 0 }}>How it works</h2>
          <p>Dataset Studio is a local-first workbench for one job: getting a dataset into a shape that a Together AI fine-tuning job will accept and learn well from. Files are parsed in a Web Worker, in streaming chunks, so large exports stay responsive. Nothing is uploaded.</p>
          <ol>
            <li><b>Import</b> a JSONL, JSON, CSV/TSV or Parquet file, or a public Hugging Face dataset by id.</li>
            <li><b>Map</b> columns to one of Together's formats. Data already in Together's schema passes through untouched so every key is validated.</li>
            <li><b>Validate</b> against the documented schema with a line-numbered report.</li>
            <li><b>Count tokens</b> with the target model's real tokenizer and chat template, and see what gets cut at max_seq_length.</li>
            <li><b>Fix</b> quality problems with one click each. Every fix is logged and can be undone; saving a run creates a version.</li>
            <li><b>Split, price and export</b>: a seeded split, a dated cost estimate, the files, a dataset card and the exact commands.</li>
          </ol>

          <h2 id="export">Getting your data out</h2>
          <p>Most fine-tuning data starts life as support conversations, app logs or an instruction spreadsheet. The fastest path is to export one JSON object per example; Dataset Studio maps whatever columns you have.</p>
          <h3>Postgres (support chats)</h3>
          <pre className="code">{SQL_PG}</pre>
          <p>Exclude internal notes and bot handoff messages. Keep a category column if you have one: it drives the stratified split and the label-balance check.</p>
          <h3>BigQuery</h3>
          <pre className="code">{SQL_BQ}</pre>
          <p>BigQuery's JSON export is newline-delimited. Download the shards and import them one at a time, or concatenate them first (<code>cat support-*.json &gt; support.jsonl</code>).</p>
          <h3>Spreadsheets, CSV and pandas</h3>
          <pre className="code">{PANDAS}</pre>
          <p>CSV works directly: quoted fields, embedded newlines and <code>,</code> <code>;</code> or tab delimiters are detected. Question/answer columns become a single-turn chat; instruction/input/output columns become prompt/completion.</p>
          <h3>Helpdesk exports</h3>
          <p>Helpdesks such as Zendesk and Intercom export tickets as JSON or CSV from their admin data-export pages (an account admin has to request it, and large accounts receive a download link by email). Export the ticket comments with their author type, then either import the export directly and map the columns, or load it into a database and use the SQL above to build one conversation per line.</p>
          <h3>Your app's LLM logs</h3>
          <pre className="code">{LOGS}</pre>
          <h3>Hugging Face</h3>
          <p>Paste a dataset id like <code>HuggingFaceH4/no_robots</code>. The studio lists the configs and splits from the Hub's datasets-server parquet export and reads only the rows it needs with HTTP range requests. Gated and private datasets are not supported (they need a token).</p>

          <h2 id="formats">Formats and mapping</h2>
          <ul>
            <li><b>Conversational</b>: <code>{'{"messages": [{"role": "system" | "user" | "assistant" | "tool", "content": "..."}]}'}</code>, optional <code>tools</code>, per-message <code>weight</code> 0 or 1, and assistant <code>tool_calls</code> / <code>reasoning</code>.</li>
            <li><b>Instruction</b>: <code>{'{"prompt": "...", "completion": "..."}'}</code>.</li>
            <li><b>Preference (DPO)</b>: <code>{'{"input": {"messages": [...]}, "preferred_output": [assistant msg], "non_preferred_output": [assistant msg]}'}</code>.</li>
            <li><b>Generic text</b>: <code>{'{"text": "..."}'}</code>.</li>
          </ul>
          <p>A file must use one format; Together rejects files that mix them. ShareGPT (<code>from</code>/<code>value</code>) conversations and JSON-encoded message columns are converted automatically. Parquet export from the studio is <i>pre-tokenized</i> (<code>input_ids</code>, <code>attention_mask</code>, <code>labels</code>), which is what Together expects for Parquet; it is not offered for DPO, which Together does not support pre-tokenized.</p>

          <h2 id="checks">What is checked</h2>
          <table className="t">
            <thead><tr><th>Code</th><th>Check</th><th>Fix</th></tr></thead>
            <tbody>{(Object.keys(ISSUE_INFO) as IssueCode[]).map((c) => <tr key={c}><td className="mono tiny">{c}</td><td className="small">{ISSUE_INFO[c].title}</td><td className="small muted">{ISSUE_INFO[c].fix}</td></tr>)}</tbody>
          </table>
          <p style={{ marginTop: 14 }}>Quality checks: exact duplicates (normalised text hash), near-duplicates (MinHash, 64 permutations, 16 LSH bands, word 3-grams), train/validation leakage (shared prompts or near-duplicates across the split), PII and secrets (emails, phones, Luhn-checked cards, IPs, sk- style provider keys, AWS/GitHub/Slack/Hugging Face/Google/Stripe keys, JWTs, private keys), boilerplate refusals, language mix (script + stopword detection), answer-length outliers (robust log-scale bounds) and label imbalance. Oversize lines are flagged before tokenization when they cannot fit max_seq_length even at {LIMITS.oversizeBytesPerToken} bytes per token.</p>
          <p>The SDK's own client-side check only confirms UTF-8 and one JSON object per line; schema validation happens on Together's servers after upload (<a href={SOURCES.sdkChecks} target="_blank" rel="noreferrer">source</a>). Together's support article also notes that its checker <a href={SOURCES.checkerFaq} target="_blank" rel="noreferrer">does not catch every error</a>.</p>

          <h2 id="rules">Rules, limits and prices</h2>
          <p>Checked {RULES_CHECKED}. Sources: <a href={SOURCES.dataPrep} target="_blank" rel="noreferrer">data preparation</a>, <a href={SOURCES.models} target="_blank" rel="noreferrer">supported models</a>, <a href={SOURCES.pricing} target="_blank" rel="noreferrer">pricing</a>, <a href={SOURCES.preference} target="_blank" rel="noreferrer">preference tuning</a>, <a href={SOURCES.sdkConstants} target="_blank" rel="noreferrer">SDK constants</a>.</p>
          <ul>
            <li>File size: the docs state 100 GB; the {TOGETHER_SDK_VERSION} SDK's client check still caps uploads at 50.1 GiB.</li>
            <li>Minimum examples: {LIMITS.minSamples} (SDK <code>MIN_SAMPLES</code>).</li>
            <li>Conversations start with system or user, then alternate user and assistant. Loss is computed on assistant turns (or the completion) unless <code>train_on_inputs</code> is true.</li>
            <li>Preference outputs each contain exactly one assistant message; half the DPO context is used per side.</li>
            <li>Packing is on by default for JSONL and has no effect on Parquet.</li>
          </ul>
          <div className="card" style={{ overflow: 'auto', marginTop: 14 }}>
            <table className="t">
              <thead><tr><th>Model</th><th className="r">SFT ctx</th><th className="r">DPO ctx</th><th className="r">LoRA SFT</th><th className="r">LoRA DPO</th><th className="r">Full SFT</th><th className="r">Min</th><th>Tokenizer</th></tr></thead>
              <tbody>{MODELS.map((m) => (
                <tr key={m.id}><td><div style={{ fontWeight: 500 }}>{m.name}</div><div className="mono tiny faint">{m.id}</div></td>
                  <td className="r num">{m.ctxSft.toLocaleString()}</td><td className="r num">{m.ctxDpo.toLocaleString()}</td>
                  <td className="r num">{m.price ? `$${m.price.loraSft}` : '—'}</td><td className="r num">{m.price ? `$${m.price.loraDpo}` : '—'}</td>
                  <td className="r num">{m.price?.fullSft ? `$${m.price.fullSft}` : '—'}</td><td className="r num">{m.price ? `$${m.price.min}` : '—'}</td>
                  <td className="mono tiny muted">{m.tokenizer ?? 'estimate (no JS tokenizer)'}</td></tr>
              ))}</tbody>
            </table>
          </div>
          <p className="small" style={{ marginTop: 8 }}>Prices are USD per 1M tokens. Tokenizers load from the listed ungated Hugging Face repos (community mirrors where the official repo is gated) and are cached by the browser.</p>

          <h2 id="cost">Cost and time estimates</h2>
          <p>Together bills the tokens processed: training tokens × epochs, plus validation tokens × the number of evaluations, subject to a per-model minimum charge. Dataset Studio counts each example at most max_seq_length tokens (what is actually trained), and both sides of a DPO pair. Time estimates use an assumed throughput by model size because Together does not publish one; you can override it on the Split &amp; cost step. Queue time is typically under an hour according to the quickstart.</p>

          <h2 id="privacy">Privacy and sync</h2>
          <p>Without an account, everything stays in this browser: projects in IndexedDB, source files up to 300 MB stored alongside so a project reopens without re-importing. Signing in (optional, email and password) syncs project settings, column mappings, fix pipelines and version stats so you can pick up on another device. Raw rows and source files are never synced; on a new device you re-attach the file and the saved pipeline is re-applied. You can export everything as JSON, delete your cloud data, or delete your account from the account menu.</p>

          <h2 id="limits">Known limits</h2>
          <ul>
            <li>Language detection covers English, Spanish, French, German, Portuguese and Italian by stopwords, and CJK, Cyrillic, Arabic and Devanagari by script.</li>
            <li>Kimi models use a tiktoken tokenizer that does not load in the browser, so their counts are estimates.</li>
            <li>Multimodal (image) content parts are validated for structure but images are not inspected.</li>
            <li>Near-duplicate detection on more than a few hundred thousand rows takes a while; it runs in the worker so the page stays usable.</li>
          </ul>
          <p style={{ marginTop: 24 }}><A href="/app" className="btn">Open the studio</A></p>
        </article>
      </div>
    </Page>
  )
}
