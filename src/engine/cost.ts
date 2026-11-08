/** Cost and runtime estimates from published per-token prices. */
import { assumedThroughput, type Method, type ModelSpec } from './rules.ts'

export interface CostInput {
  model: ModelSpec
  method: Method
  lora: boolean
  epochs: number
  nEvals: number
  trainTokens: number
  valTokens: number
  /** tokens/second override; defaults to the assumption table */
  throughput?: number
}

export interface CostEstimate {
  pricePerM: number | null
  billedTokens: number
  raw: number
  minCharge: number
  total: number | null
  minApplied: boolean
  hours: number
  throughput: number
  note: string
}

export function pricePerMillion(model: ModelSpec, method: Method, lora: boolean): number | null {
  const p = model.price
  if (!p) return null
  if (lora) return method === 'dpo' ? p.loraDpo : p.loraSft
  const v = method === 'dpo' ? p.fullDpo : p.fullSft
  return v ?? null
}

/** Billed tokens = training tokens x epochs + validation tokens x number of evaluations (pricing page). */
export function estimateCost(i: CostInput): CostEstimate {
  const price = pricePerMillion(i.model, i.method, i.lora)
  const billed = i.trainTokens * i.epochs + (i.nEvals > 0 ? i.valTokens * i.nEvals : 0)
  const raw = price === null ? 0 : (billed / 1e6) * price
  const minCharge = i.model.price?.min ?? 0
  const total = price === null ? null : Math.max(raw, minCharge)
  const throughput = i.throughput ?? assumedThroughput(i.model.activeB) * (i.lora ? 1 : 0.6) * (i.method === 'dpo' ? 0.5 : 1)
  const hours = billed / throughput / 3600
  return {
    pricePerM: price, billedTokens: billed, raw, minCharge, total, minApplied: price !== null && raw < minCharge, hours, throughput,
    note: price === null ? `${i.lora ? 'LoRA' : 'Full'} ${i.method.toUpperCase()} pricing for ${i.model.name} is not listed on the pricing page.` : '',
  }
}

export function fmtUsd(n: number): string {
  return n < 10 ? `$${n.toFixed(2)}` : `$${Math.round(n).toLocaleString('en-US')}`
}

export function fmtDuration(hours: number): string {
  if (hours < 1 / 60) return 'under a minute'
  if (hours < 1) return `${Math.round(hours * 60)} min`
  if (hours < 48) return `${hours.toFixed(1)} h`
  return `${(hours / 24).toFixed(1)} days`
}
