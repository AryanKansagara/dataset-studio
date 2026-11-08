import { useEffect, useRef, useState, type ReactNode } from 'react'
import { HIST_EDGES } from '../engine/tokens.ts'
import { toast } from '../lib/store.ts'
import { linkHandler } from '../router.ts'

// ---------- icons (inline, stroke-based) ----------

const P: Record<string, ReactNode> = {
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
  upload: <><path d="M12 16V4M7 9l5-5 5 5" /><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" /></>,
  download: <><path d="M12 4v12M7 11l5 5 5-5" /><path d="M4 18v1a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1" /></>,
  copy: <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h8" /></>,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  undo: <><path d="M9 14L4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></>,
  redo: <><path d="M15 14l5-5-5-5" /><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" /></>,
  sparkle: <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z" />,
  db: <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" /><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></>,
  hf: <><circle cx="12" cy="12" r="9" /><path d="M8.5 10h.01M15.5 10h.01M8.5 14.5c1 1.2 2.2 1.8 3.5 1.8s2.5-.6 3.5-1.8" /></>,
  file: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z" /><path d="M14 3v6h6" /></>,
  shield: <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3Z" />,
  layers: <><path d="M12 3l9 5-9 5-9-5 9-5Z" /><path d="M3 13l9 5 9-5" /></>,
  ruler: <><path d="M3 17L17 3l4 4L7 21l-4-4Z" /><path d="M7 13l2 2M10 10l2 2M13 7l2 2" /></>,
  split: <><path d="M6 3v6a6 6 0 0 0 6 6h0a6 6 0 0 1 6 6v0" /><path d="M18 3v6M3 21h18" /></>,
  scale: <><path d="M12 3v18M5 7h14M5 7l-3 7a3 3 0 0 0 6 0L5 7ZM19 7l-3 7a3 3 0 0 0 6 0l-3-7Z" /></>,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></>,
  chat: <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z" />,
  trash: <><path d="M4 7h16M10 11v6M14 11v6" /><path d="M6 7l1 13h10l1-13M9 7V4h6v3" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  git: <><circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="9" r="2.5" /><path d="M6 8.5v7M18 11.5c0 3-3 4-9.5 5" /></>,
  printer: <><path d="M6 9V3h12v6" /><rect x="3" y="9" width="18" height="8" rx="2" /><path d="M7 14h10v7H7z" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></>,
  key: <><circle cx="8" cy="15" r="4" /><path d="M10.8 12.2L20 3M16 7l3 3" /></>,
  bolt: <path d="M13 2L4 14h7l-1 8 9-12h-7l1-8Z" />,
}

export function Icon({ name, size = 16, stroke = 1.6 }: { name: keyof typeof P | string; size?: number; stroke?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {P[name]}
    </svg>
  )
}

export function Monogram() {
  return <span className="mono-badge" aria-hidden="true"><b>DS</b></span>
}

export function A({ href, children, className, onClick, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  return <a href={href} className={className} onClick={(e) => { onClick?.(e); linkHandler(e) }} {...rest}>{children}</a>
}

// ---------- charts ----------

const fmtTok = (n: number) => (n >= 1024 ? `${Math.round(n / 1024)}k` : String(n))

/** Token-length histogram on a log2 axis with the max-sequence-length line. */
export function Histogram({ counts, compare, limit, height = 180, labels, width = 640 }: { counts: number[]; compare?: number[]; limit?: number; height?: number; labels?: [string, string]; width?: number }) {
  const W = width
  const H = height
  const padL = 34, padB = 22, padT = 16
  // trim empty tails but always show the limit
  let first = counts.findIndex((c, i) => c > 0 || (compare?.[i] ?? 0) > 0)
  let lastI = counts.length - 1 - [...counts].reverse().findIndex((c, i) => c > 0 || (compare?.[counts.length - 1 - i] ?? 0) > 0)
  if (first < 0) { first = 6; lastI = 14 }
  if (limit) {
    const li = Math.floor((Math.log2(limit) - 3) * 2)
    first = Math.min(first, li - 1)
    lastI = Math.max(lastI, li + 1)
  }
  first = Math.max(0, first - 1)
  lastI = Math.min(counts.length - 1, lastI + 1)
  const bins = lastI - first + 1
  const bw = (W - padL) / bins
  const rawMax = Math.max(0, ...counts.slice(first, lastI + 1), ...(compare ?? []).slice(first, lastI + 1))
  const max = rawMax > 0 ? rawMax : 1
  const y = (v: number) => padT + (H - padB - padT) * (1 - v / max)
  const xOfTokens = (t: number) => padL + ((Math.log2(Math.max(t, 1)) - 3) * 2 - first) * bw
  const ticks = []
  for (let i = first; i <= lastI + 1; i += 2) ticks.push(i)
  return (
    <svg className="hist" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Token length histogram${limit ? `, max sequence length ${limit}` : ''}`}>
      {[0.25, 0.5, 0.75, 1].map((f) => <line key={f} className="grid" x1={padL} x2={W} y1={y(max * f)} y2={y(max * f)} />)}
      <text className="axis" x={padL - 6} y={y(max) + 3} textAnchor="end">{max >= 1000 ? `${(max / 1000).toFixed(1)}k` : max <= 1 && compare ? `${Math.round(max * 100)}%` : max}</text>
      <text className="axis" x={padL - 6} y={H - padB + 3} textAnchor="end">0</text>
      {counts.slice(first, lastI + 1).map((c, k) => {
        const i = first + k
        const over = limit !== undefined && HIST_EDGES[i] >= limit
        const w = compare ? bw / 2 - 1 : bw - 2
        return (
          <g key={i}>
            <rect className={`bar${over ? ' over' : ''}`} x={padL + k * bw + 1} width={Math.max(w, 1)} y={c > 0 ? Math.min(y(c), H - padB - 3) : y(c)} height={c > 0 ? Math.max(3, H - padB - y(c)) : 0} rx={1.5}>
              <title>{`${HIST_EDGES[i].toLocaleString()}–${HIST_EDGES[i + 1].toLocaleString()} tokens: ${c < 1 && c > 0 ? `${(c * 100).toFixed(1)}%` : c}`}</title>
            </rect>
            {compare && <rect className="bar b2" x={padL + k * bw + bw / 2} width={Math.max(w, 1)} y={compare[i] > 0 ? Math.min(y(compare[i]), H - padB - 3) : y(0)} height={compare[i] > 0 ? Math.max(3, H - padB - y(compare[i])) : 0} rx={1.5} />}
          </g>
        )
      })}
      {ticks.map((i) => <text key={i} className="axis" x={padL + (i - first) * bw} y={H - 6} textAnchor="middle">{fmtTok(HIST_EDGES[i])}</text>)}
      {limit && (
        <g>
          <line className="limit" x1={xOfTokens(limit)} x2={xOfTokens(limit)} y1={4} y2={H - padB} />
          <text className="limit-label" x={xOfTokens(limit) - 5} y={11} textAnchor="end">max_seq_length {fmtTok(limit)}</text>
        </g>
      )}
      {labels && <text className="axis" x={W} y={10} textAnchor="end">{labels[0]}</text>}
    </svg>
  )
}

export function Bars({ items, total, alt }: { items: [string, number][]; total?: number; alt?: Set<string> }) {
  const max = total ?? Math.max(1, ...items.map((i) => i[1]))
  return (
    <div className="bars">
      {items.map(([k, v]) => (
        <div className="b" key={k}>
          <span className="lbl" title={k}>{k}</span>
          <div className="track2"><div className={`fill${alt?.has(k) ? ' alt' : ''}`} style={{ width: `${(v / max) * 100}%` }} /></div>
          <span className="num tiny muted" style={{ textAlign: 'right' }}>{v.toLocaleString()}</span>
        </div>
      ))}
    </div>
  )
}

export function Sparkline({ values, color = 'var(--accent)' }: { values: number[]; color?: string }) {
  if (values.length < 2) return <svg className="spark" viewBox="0 0 100 30" />
  const max = Math.max(...values, 1)
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${28 - (v / max) * 26}`).join(' ')
  return (
    <svg className="spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

// ---------- overlays ----------

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    ref.current?.querySelector<HTMLElement>('input,button,select,textarea')?.focus()
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', k)
    return () => { window.removeEventListener('keydown', k); prev?.focus?.() }
  }, [onClose])
  return (
    <div className="modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  )
}

export function Drawer({ title, children, onClose, extra }: { title: ReactNode; children: ReactNode; onClose: () => void; extra?: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  return (
    <>
      <div className="drawer-bg" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true">
        <header>
          <div style={{ fontWeight: 500 }}>{title}</div>
          <div className="spacer" />
          {extra}
          <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </header>
        <div className="body">{children}</div>
      </aside>
    </>
  )
}

export function CopyButton({ text, label = 'Copy', className = 'btn small secondary' }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button className={className} onClick={async () => {
      try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1400) } catch { toast('Clipboard is blocked in this browser. Select the text and copy manually.', 'error') }
    }}>
      <Icon name={done ? 'check' : 'copy'} size={13} /> {done ? 'Copied' : label}
    </button>
  )
}

export function Progress({ value, total, label }: { value?: number; total?: number; label: string }) {
  const pct = total ? Math.min(100, (100 * (value ?? 0)) / total) : 0
  return (
    <div className="busy" role="status" aria-live="polite">
      <span className="spinner" />
      <span style={{ minWidth: 150 }}>{label}{total ? ` · ${Math.round(pct)}%` : ''}</span>
      <div className={`progress${total ? '' : ' indet'}`}><div style={{ width: `${pct}%` }} /></div>
    </div>
  )
}

export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

export const fmtInt = (n: number) => Math.round(n).toLocaleString('en-US')
export function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}
export function fmtTokens(n: number) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1e4) return `${(n / 1e3).toFixed(1)}k`
  return fmtInt(n)
}
export function timeAgo(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`
  return new Date(iso).toLocaleDateString()
}
