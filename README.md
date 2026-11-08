# Dataset Studio

Turn raw data into a Together AI fine-tuning file that will actually train.

Live: https://dataset-studio-sepia.vercel.app

## The pain

Together's upload-time check confirms the file is UTF-8 with one JSON object per line; the schema is validated on the server after upload, and Together's own support article says the checker does not catch every error. Files that are valid JSONL can still be broken training data: assistant turns that are empty, conversations that end on a user turn, duplicated examples that leak into validation, leaked API keys, boilerplate refusals, and examples silently cut at the model's max sequence length.

## What it does

- **Import** JSONL, JSON, CSV/TSV, Parquet, or a public Hugging Face dataset by id (datasets-server parquet export, range requests). Files stream through a Web Worker, so 500 MB stays responsive.
- **Map** any columns to Together's conversational, instruction, preference (DPO) or generic text format, with a live preview of the converted records.
- **Validate** against the documented schema with a line-numbered report: role order, empty or whitespace turns, missing final assistant turn, unknown roles and keys, weights, DPO outputs, non-UTF-8 bytes, oversize lines. CSV download of the report.
- **Count tokens** with the target model's real tokenizer and chat template (`@huggingface/tokenizers` + `@huggingface/jinja`, lazy-loaded from the Hub and cached), see what gets cut at `max_seq_length`, and truncate smartly at turn boundaries.
- **Quality checks** with one-click fixes and an undo log: exact and MinHash near-duplicates, train/validation leakage, PII and secrets, boilerplate refusals, language mix, answer-length outliers, label imbalance.
- **Split and price**: seeded, stratified split; cost from tokens × epochs (+ validation × evals) at the published price, with the per-model minimum; a clearly labelled runtime assumption.
- **Export** fixed JSONL or pre-tokenized Parquet (`input_ids`, `attention_mask`, `labels`), the exact `tg` CLI and Python SDK commands pinned to `together==3.1.1`, a dataset card, and a printable report.
- **Projects and versions** stored locally in IndexedDB; every saved pipeline run is a version with a compare view (row counts, token distribution shift, what was dropped and why).
- **Optional accounts** (Supabase email + password) sync settings, pipelines and version stats across devices. Raw rows never leave the browser.

Rules, context lengths and prices live in [`src/engine/rules.ts`](src/engine/rules.ts), dated with source links.

## Run locally

```bash
npm install
npm run dev      # http://localhost:4334
npm test         # engine tests (node --test)
npm run build
```

Copy `.env.example` to `.env` to enable sync (optional).
