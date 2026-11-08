import { Hero } from './Hero.tsx'
import { A, Icon } from './common.tsx'
import { Footer } from './Shell.tsx'
import { MODELS, RULES_CHECKED, SOURCES, TOGETHER_SDK_VERSION } from '../engine/rules.ts'
import { cliCommands, DEFAULT_JOB } from '../engine/exporters.ts'

function highlight(code: string) {
  return code.split('\n').map((l, i) => {
    if (l.trimStart().startsWith('#')) return <div key={i} className="c">{l}</div>
    const parts = l.split(/(".*?"|--[a-z-]+)/g)
    return <div key={i}>{parts.map((p, j) => p.startsWith('--') ? <span key={j} className="f">{p}</span> : p.startsWith('"') ? <span key={j} className="s">{p}</span> : p)}</div>
  })
}

const CHECKS = [
  { icon: 'layers', title: 'Schema, line by line', body: 'Conversational, instruction, preference and text formats. Role order, empty or whitespace turns, a missing final assistant turn, unknown keys, bad weights, non-UTF-8 bytes. Every finding has a line number.' },
  { icon: 'ruler', title: 'Real tokens, real template', body: "Counts with the target model's own tokenizer and chat template, then shows how many examples and tokens get cut at max_seq_length, with smart truncation that drops whole turns." },
  { icon: 'git', title: 'Duplicates and leakage', body: 'Exact and MinHash near-duplicates, plus validation rows that leak from train. A seeded, stratified split you can reproduce next month.' },
  { icon: 'shield', title: 'PII and secrets', body: 'Emails, phone numbers, card numbers, API keys and private keys, redacted in one click before anything leaves your laptop.' },
  { icon: 'chat', title: 'Refusals and language mix', body: 'Boilerplate "as an AI language model" answers and stray languages that quietly teach the wrong behaviour.' },
  { icon: 'scale', title: 'Outliers and imbalance', body: 'Answer-length outliers and label imbalance for classification-style data, with seeded downsampling.' },
]

export default function Landing() {
  const cmd = cliCommands({ ...DEFAULT_JOB, suffix: 'support-bot-v3', maxSeq: 8192 }, { train: 'train.jsonl', val: 'validation.jsonl' }, 'conversational')
  const shown = cmd.split('\n').slice(9).join('\n')
  const featured = ['Qwen/Qwen3.5-9B', 'meta-llama/Meta-Llama-3.1-8B-Instruct-Reference', 'openai/gpt-oss-20b', 'google/gemma-4-31B-it', 'meta-llama/Llama-3.3-70B-Instruct-Reference', 'deepseek-ai/DeepSeek-V3.1']
  return (
    <>
      <main id="main">
        <section className="hero">
          <div className="wrap hero-inner">
            <div>
              <span className="pill-label">Fine-tuning data · for Together AI</span>
              <h1>Valid JSONL is not<span className="dim">the same as trainable data.</span></h1>
              <p className="lede">Dataset Studio turns a raw export into a fine-tuning file that will actually train: checked line by line, counted with your model's real tokenizer, deduplicated, scrubbed of secrets, split and priced. Then it hands you the exact commands.</p>
              <div className="ctas">
                <A href="/app?sample=1" className="btn">Try the messy sample</A>
                <A href="/app" className="btn secondary">Import your data</A>
              </div>
              <div className="fine">
                <span><Icon name="shield" size={14} /> Runs in your browser</span>
                <span><Icon name="bolt" size={14} /> 500 MB files stay responsive</span>
                <span><Icon name="user" size={14} /> No account needed</span>
              </div>
            </div>
            <Hero />
          </div>
        </section>

        <section className="section">
          <div className="wrap">
            <div className="section-head">
              <span className="tag">The pain</span>
              <h2>The file checker passes. The job still breaks.</h2>
              <p>Upload-time checks catch broken JSON. They don't catch the data problems that waste a training run or ship a worse model.</p>
            </div>
            <div className="evidence">
              <div className="card">
                <q>Together's own help center says its training-file checker does not catch every error, and points you to support if a job fails after the data loads.</q>
                <div className="src">Source · <a href={SOURCES.checkerFaq} target="_blank" rel="noreferrer">Together support article</a></div>
              </div>
              <div className="card">
                <q>The SDK's local check confirms UTF-8 and one JSON object per line. Schema, roles and lengths are only validated on the server, after the upload.</q>
                <div className="src">Source · <a href={SOURCES.sdkChecks} target="_blank" rel="noreferrer">together-py files.py</a> · <a href={SOURCES.dataPrep} target="_blank" rel="noreferrer">data prep docs</a></div>
              </div>
              <div className="card">
                <q>ML engineers describe fine-tuning sets that are perfectly valid JSONL and still broken training data, and format errors and timeouts while cleaning large files.</q>
                <div className="src">Source · r/LLMDevs discussion, “valid JSONL and still broken training data”</div>
              </div>
            </div>
          </div>
        </section>

        <section className="section">
          <div className="wrap">
            <div className="section-head">
              <span className="tag">What it checks</span>
              <h2>Everything between “parses” and “trains well”.</h2>
              <p>Each check comes with a one-click fix and an undo log. Every fix run becomes a version you can compare later.</p>
            </div>
            <div className="checks">
              {CHECKS.map((c) => (
                <div key={c.title}>
                  <span className="ico"><Icon name={c.icon} /></span>
                  <h3>{c.title}</h3>
                  <p>{c.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="section">
          <div className="wrap">
            <div className="section-head">
              <span className="tag">Workflow</span>
              <h2>From a messy export to a running job.</h2>
            </div>
            <div className="steps">
              <div><h4>Import</h4><p>JSONL, JSON, CSV, Parquet, or a Hugging Face dataset id.</p></div>
              <div><h4>Map</h4><p>Turn any columns into messages, prompt and completion, or preference pairs.</p></div>
              <div><h4>Validate</h4><p>Line-numbered report against Together's documented rules.</p></div>
              <div><h4>Fix</h4><p>Repair, dedupe, redact, truncate and rebalance, with undo.</p></div>
              <div><h4>Split &amp; price</h4><p>Seeded, stratified split. Cost from tokens × epochs at the published price.</p></div>
              <div><h4>Export</h4><p>JSONL or pre-tokenized Parquet, a dataset card, and the exact commands.</p></div>
            </div>
          </div>
        </section>

        <section className="dark-band" data-theme="dark">
          <div className="wrap split-2">
            <div>
              <span className="tag">Ready to upload</span>
              <h2 style={{ fontSize: 'clamp(30px,3.6vw,44px)', margin: '14px 0 16px' }}>The exact commands, with the right flags.</h2>
              <p className="muted" style={{ fontSize: 17 }}>Generated from your model, method, split and max sequence length, pinned to <code>together=={TOGETHER_SDK_VERSION}</code>. Python SDK version included. DPO gets <code>--training-method dpo</code>; chat data gets <code>--train-on-inputs</code>.</p>
              <div className="row" style={{ marginTop: 24 }}><A href="/app?sample=1" className="btn">See it on the sample</A></div>
            </div>
            <pre className="code" aria-label="Example generated CLI command">{highlight(shown)}</pre>
          </div>
        </section>

        <section className="section">
          <div className="wrap">
            <div className="section-head">
              <span className="tag">Dated rules</span>
              <h2>Limits and prices straight from Together's docs.</h2>
              <p>Checked {RULES_CHECKED}. Every number links to its source, and the studio flags its assumptions.</p>
            </div>
            <div className="card" style={{ overflow: 'auto' }}>
              <table className="t">
                <thead><tr><th>Model</th><th className="r">SFT context</th><th className="r">DPO context</th><th className="r">LoRA SFT / 1M tok</th><th className="r">Min charge</th><th>Tokenizer</th></tr></thead>
                <tbody>
                  {featured.map((id) => MODELS.find((m) => m.id === id)!).map((m) => (
                    <tr key={m.id}>
                      <td><div style={{ fontWeight: 500 }}>{m.name}</div><div className="mono tiny faint">{m.id}</div></td>
                      <td className="r num">{m.ctxSft.toLocaleString()}</td>
                      <td className="r num">{m.ctxDpo.toLocaleString()}</td>
                      <td className="r num">${m.price?.loraSft.toFixed(2)}</td>
                      <td className="r num">${m.price?.min.toFixed(2)}</td>
                      <td className="mono tiny muted">{m.tokenizer}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="tiny faint" style={{ marginTop: 10 }}>Sources: <a href={SOURCES.models} target="_blank" rel="noreferrer">fine-tuning models</a> · <a href={SOURCES.pricing} target="_blank" rel="noreferrer">pricing</a> · <A href="/docs#rules">all {MODELS.length} models</A></p>
          </div>
        </section>

        <div className="wrap">
          <div className="cta-band">
            <h2>Find the problems before the GPU hours do.</h2>
            <div className="row wrap-row">
              <A href="/app?sample=1" className="btn">Try the messy sample</A>
              <A href="/docs" className="btn secondary">Read the docs</A>
            </div>
          </div>
        </div>
      </main>
      <Footer />
    </>
  )
}
