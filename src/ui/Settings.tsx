import { useState } from 'react'
import { A, Icon, Modal, download, fmtInt } from './common.tsx'
import { Page, useTheme } from './Shell.tsx'
import { exportAllData, projects$, saveSettings, settings$, toast, useObs, wipeLocal } from '../lib/store.ts'
import { auth$ } from '../lib/sync.ts'
import { engine } from '../lib/engine.ts'
import { MODELS } from '../engine/rules.ts'

export default function Settings() {
  const s = useObs(settings$)
  const projects = useObs(projects$) ?? []
  const a = useObs(auth$)
  const [mode, toggle] = useTheme()
  const [wipe, setWipe] = useState(false)
  return (
    <Page>
      <div className="page-title"><div><span className="tag">Preferences</span><h1 style={{ marginTop: 10 }}>Settings</h1></div></div>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16, alignItems: 'start' }}>
        <section className="card pad grid" style={{ gap: 16 }}>
          <h3>Defaults for new projects</h3>
          <label className="field"><span>Target model</span>
            <select className="input" value={s.defaultModel} onChange={(e) => saveSettings({ defaultModel: e.target.value })}>
              {MODELS.map((m) => <option key={m.id} value={m.id}>{m.name} · {m.org}</option>)}
            </select>
          </label>
          <div className="map-grid">
            <label className="field"><span>Validation share</span><input className="input num" type="number" min={0} max={0.5} step={0.01} value={s.valFraction} onChange={(e) => saveSettings({ valFraction: Math.min(0.5, Math.max(0, Number(e.target.value))) })} /></label>
            <label className="field"><span>Seed</span><input className="input num" type="number" value={s.seed} onChange={(e) => saveSettings({ seed: Number(e.target.value) || 0 })} /></label>
            <label className="field"><span>Epochs</span><input className="input num" type="number" min={1} value={s.epochs} onChange={(e) => saveSettings({ epochs: Math.max(1, Number(e.target.value) || 1) })} /></label>
          </div>
          <label className="switch"><input type="checkbox" checked={s.exactTokens} onChange={(e) => saveSettings({ exactTokens: e.target.checked })} />Count tokens for every row (otherwise datasets over 20,000 rows are sampled)</label>
        </section>

        <section className="card pad grid" style={{ gap: 16 }}>
          <h3>Appearance</h3>
          <div className="row"><span style={{ flex: 1 }}>Theme</span>
            <div className="seg" role="group" aria-label="Theme">
              <button aria-pressed={mode === 'light'} onClick={() => mode !== 'light' && toggle()}>Light</button>
              <button aria-pressed={mode === 'dark'} onClick={() => mode !== 'dark' && toggle()}>Dark</button>
            </div>
          </div>
          <label className="switch"><input type="checkbox" checked={s.reduceMotion} onChange={(e) => { saveSettings({ reduceMotion: e.target.checked }); document.documentElement.classList.toggle('reduce-motion', e.target.checked) }} />Reduce motion (the system setting is always respected)</label>
          <h3 style={{ marginTop: 8 }}>Keyboard</h3>
          <table className="t"><tbody>
            <tr><td><kbd>1</kbd>…<kbd>7</kbd></td><td className="small">Jump between steps in a project</td></tr>
            <tr><td><kbd>⌘/Ctrl</kbd> <kbd>Z</kbd></td><td className="small">Undo the last fix (<kbd>⇧</kbd> to redo)</td></tr>
            <tr><td><kbd>?</kbd></td><td className="small">Shortcut help</td></tr>
          </tbody></table>
        </section>

        <section className="card pad grid" style={{ gap: 14 }}>
          <h3>Your data</h3>
          <p className="small muted">{fmtInt(projects.length)} project{projects.length === 1 ? '' : 's'} in this browser. {a.email ? `Syncing settings and stats as ${a.email}.` : 'Not signed in: nothing leaves this device.'}</p>
          <div className="row wrap-row">
            <button className="btn secondary" onClick={async () => download(await exportAllData(), `dataset-studio-export-${new Date().toISOString().slice(0, 10)}.json`)}><Icon name="download" size={14} /> Export all (JSON)</button>
            <button className="btn secondary" onClick={async () => { await engine.clearCache(); toast('Tokenizer cache cleared.', 'success') }}>Clear tokenizer cache</button>
          </div>
          <button className="btn danger" onClick={() => setWipe(true)}><Icon name="trash" size={14} /> Delete local projects</button>
          <p className="tiny faint">Account actions (sign in, delete cloud data, delete account) are in the account menu at the top right. See <A href="/docs#privacy">privacy and sync</A>.</p>
        </section>
      </div>
      {wipe && (
        <Modal title="Delete all local projects?" onClose={() => setWipe(false)}>
          <p className="muted">Removes every project and stored source file from this browser. {a.email ? 'Synced copies in your account are not affected; they will download again on next sync.' : 'This cannot be undone. Export first if you want a backup.'}</p>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 18 }}>
            <button className="btn secondary" onClick={() => setWipe(false)}>Cancel</button>
            <button className="btn danger" onClick={async () => { await wipeLocal(); setWipe(false); toast('Local projects deleted.') }}>Delete</button>
          </div>
        </Modal>
      )}
    </Page>
  )
}
