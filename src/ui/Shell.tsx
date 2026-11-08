import { useEffect, useRef, useState, type ReactNode } from 'react'
import { A, Icon, Modal, Monogram, download } from './common.tsx'
import { dismissToast, exportAllData, toast, toasts$, useObs } from '../lib/store.ts'
import { auth$, deleteAccount, deleteCloudData, signIn, signOut, signUp, syncAll, type SyncStatus } from '../lib/sync.ts'
import { usePath } from '../router.ts'

export function useTheme(): ['light' | 'dark', () => void] {
  const [mode, setMode] = useState<'light' | 'dark'>(() => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'))
  const toggle = () => {
    const next = mode === 'dark' ? 'light' : 'dark'
    document.documentElement.dataset.theme = next
    localStorage.setItem('themeMode', next)
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', next === 'dark' ? '#010120' : '#ffffff')
    setMode(next)
  }
  return [mode, toggle]
}

const SYNC_LABEL: Record<SyncStatus, string> = { 'signed-out': 'Local only', syncing: 'Syncing', synced: 'Synced', offline: 'Offline', error: 'Sync failed' }

function AccountMenu() {
  const a = useObs(auth$)
  const [open, setOpen] = useState(false)
  const [dialog, setDialog] = useState<null | 'signin' | 'signup' | 'delete-cloud' | 'delete-account'>(null)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const f = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', f)
    document.addEventListener('keydown', k)
    return () => { document.removeEventListener('mousedown', f); document.removeEventListener('keydown', k) }
  }, [open])
  const exportData = async () => { download(await exportAllData(), `dataset-studio-export-${new Date().toISOString().slice(0, 10)}.json`); toast('Exported all projects as JSON.', 'success') }
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className="icon-btn" aria-haspopup="menu" aria-expanded={open} aria-label="Account" onClick={() => setOpen((o) => !o)}>
        <Icon name="user" />
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="head">
            {a.email ? <><div className="small faint">Signed in as</div><div style={{ fontWeight: 500, wordBreak: 'break-all' }}>{a.email}</div></>
              : <><div style={{ fontWeight: 500 }}>Working locally</div><div className="small muted" style={{ marginTop: 4 }}>Projects live in this browser. Sign in to sync them across devices. Raw rows never leave your device.</div></>}
            {a.email && <div className={`sync-pill ${a.status}`} style={{ paddingLeft: 0, marginTop: 6 }}><span className="dot" />{SYNC_LABEL[a.status]}{a.error ? `: ${a.error}` : ''}</div>}
          </div>
          <hr />
          {!a.email && <>
            <button className="item" role="menuitem" onClick={() => { setDialog('signin'); setOpen(false) }}><Icon name="key" /> Sign in</button>
            <button className="item" role="menuitem" onClick={() => { setDialog('signup'); setOpen(false) }}><Icon name="plus" /> Create account</button>
          </>}
          {a.email && <button className="item" role="menuitem" onClick={() => { void syncAll(); setOpen(false) }}><Icon name="redo" /> Sync now</button>}
          <button className="item" role="menuitem" onClick={() => { void exportData(); setOpen(false) }}><Icon name="download" /> Export all my data (JSON)</button>
          <A className="item" href="/settings" onClick={() => setOpen(false)}><Icon name="settings" /> Settings</A>
          {a.email && <>
            <hr />
            <button className="item" role="menuitem" onClick={() => { void signOut(); setOpen(false) }}><Icon name="arrow" /> Sign out</button>
            <button className="item danger" role="menuitem" onClick={() => { setDialog('delete-cloud'); setOpen(false) }}><Icon name="trash" /> Delete my cloud data</button>
            <button className="item danger" role="menuitem" onClick={() => { setDialog('delete-account'); setOpen(false) }}><Icon name="trash" /> Delete my account</button>
          </>}
        </div>
      )}
      {(dialog === 'signin' || dialog === 'signup') && <AuthDialog mode={dialog} onClose={() => setDialog(null)} onSwitch={(m) => setDialog(m)} />}
      {dialog === 'delete-cloud' && <Confirm title="Delete cloud data?" body="Removes every synced Dataset Studio project from the cloud. Projects on this device stay." cta="Delete cloud data" onClose={() => setDialog(null)} run={async () => { await deleteCloudData(); toast('Cloud data deleted. Local projects are untouched.', 'success') }} />}
      {dialog === 'delete-account' && <Confirm title="Delete your account?" body="Deletes your account and all synced projects permanently. Projects on this device stay and keep working signed out." cta="Delete account" onClose={() => setDialog(null)} run={async () => { await deleteAccount(); toast('Account deleted.', 'success') }} />}
    </div>
  )
}

function Confirm({ title, body, cta, onClose, run }: { title: string; body: string; cta: string; onClose: () => void; run: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  return (
    <Modal title={title} onClose={onClose}>
      <p className="muted">{body}</p>
      <div className="row" style={{ marginTop: 20, justifyContent: 'flex-end' }}>
        <button className="btn secondary" onClick={onClose}>Cancel</button>
        <button className="btn danger" disabled={busy} onClick={async () => { setBusy(true); try { await run(); onClose() } catch (e) { toast((e as Error).message, 'error'); setBusy(false) } }}>{busy ? 'Working…' : cta}</button>
      </div>
    </Modal>
  )
}

function AuthDialog({ mode, onClose, onSwitch }: { mode: 'signin' | 'signup'; onClose: () => void; onSwitch: (m: 'signin' | 'signup') => void }) {
  const [email, setEmail] = useState('')
  const [pw, setPw] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true); setErr('')
    try {
      await (mode === 'signin' ? signIn(email, pw) : signUp(email, pw))
      toast(mode === 'signin' ? 'Signed in. Projects are syncing.' : 'Account created. Projects are syncing.', 'success')
      onClose()
    } catch (e2) {
      const m = (e2 as Error).message
      setErr(/fetch/i.test(m) ? 'Could not reach the sync server. Everything still works locally.' : m)
      setBusy(false)
    }
  }
  return (
    <Modal title={mode === 'signin' ? 'Sign in' : 'Create an account'} onClose={onClose}>
      <p className="muted small">Optional. Syncs project settings, fix pipelines and version stats. Your raw rows and files stay on this device.</p>
      <form onSubmit={submit} className="grid" style={{ marginTop: 16, gap: 12 }}>
        <label className="field"><span>Email</span><input className="input" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label className="field"><span>Password</span><input className="input" type="password" required minLength={6} autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} value={pw} onChange={(e) => setPw(e.target.value)} /></label>
        {err && <div className="badge err" style={{ height: 'auto', padding: '8px 10px', borderRadius: 6, whiteSpace: 'normal' }} role="alert">{err}</div>}
        <button className="btn" disabled={busy} type="submit">{busy ? 'Working…' : mode === 'signin' ? 'Sign in' : 'Create account'}</button>
        <button type="button" className="btn ghost" onClick={() => onSwitch(mode === 'signin' ? 'signup' : 'signin')}>{mode === 'signin' ? 'No account? Create one' : 'Have an account? Sign in'}</button>
      </form>
    </Modal>
  )
}

export function Header() {
  const [mode, toggle] = useTheme()
  const path = usePath()
  const a = useObs(auth$)
  const cur = (p: string) => (path === p || (p !== '/' && path.startsWith(p)) ? 'page' : undefined)
  return (
    <div className="topbar">
      <a className="skip" href="#main">Skip to content</a>
      <nav className="nav" aria-label="Main">
        <A href="/" className="brand"><Monogram /><span>Dataset Studio</span></A>
        <div className="nav-links">
          <A href="/app" aria-current={cur('/app')}>Studio</A>
          <A href="/docs" aria-current={cur('/docs')}>Docs</A>
          <A href="/settings" aria-current={cur('/settings')}>Settings</A>
        </div>
        <div className="spacer" />
        {a.email && <span className={`sync-pill hide-sm ${a.status}`} title={a.error ?? ''}><span className="dot" />{SYNC_LABEL[a.status]}</span>}
        <button className="icon-btn" onClick={toggle} aria-label={`Switch to ${mode === 'dark' ? 'light' : 'dark'} mode`} title="Toggle theme">
          <Icon name={mode === 'dark' ? 'sun' : 'moon'} />
        </button>
        <AccountMenu />
        {!path.startsWith('/app') && <A href="/app" className="btn hide-sm">Open studio</A>}
      </nav>
    </div>
  )
}

export function Footer() {
  return (
    <footer className="footer">
      <div className="wrap">
        <span className="row" style={{ gap: 8 }}><Monogram /> Dataset Studio</span>
        <span>Built by Aryan Kansagara. Independent project, not affiliated with Together AI.</span>
        <span className="spacer" />
        <A href="/docs">Docs</A>
        <A href="/docs#rules">Rules &amp; prices</A>
        <A href="/settings">Settings</A>
      </div>
    </footer>
  )
}

export function Toasts() {
  const ts = useObs(toasts$)
  return (
    <div className="toasts" aria-live="polite">
      {ts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
          {t.kind === 'success' && <Icon name="check" />}
          <span>{t.text}</span>
          {t.action && <button className="act" onClick={() => { t.action!.run(); dismissToast(t.id) }}>{t.action.label}</button>}
          <button className="x" aria-label="Dismiss" onClick={() => dismissToast(t.id)} style={{ marginLeft: t.action ? 0 : 'auto' }}><Icon name="x" size={14} /></button>
        </div>
      ))}
    </div>
  )
}

export function Page({ children }: { children: ReactNode }) {
  return <main id="main" className="app-main"><div className="wrap">{children}</div></main>
}
