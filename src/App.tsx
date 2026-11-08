import { lazy, Suspense, useEffect } from 'react'
import { usePath } from './router.ts'
import { Footer, Header, Page, Toasts } from './ui/Shell.tsx'
import { A } from './ui/common.tsx'
import Landing from './ui/Landing.tsx'
import { loadProjects, settings$ } from './lib/store.ts'
import { initAuth } from './lib/sync.ts'

const Studio = lazy(() => import('./ui/Studio.tsx'))
const Docs = lazy(() => import('./ui/Docs.tsx'))
const Settings = lazy(() => import('./ui/Settings.tsx'))

function NotFound() {
  return (
    <Page>
      <div className="notfound">
        <div className="big">404</div>
        <h1 style={{ fontSize: 28, margin: '18px 0 10px' }}>This line failed validation.</h1>
        <p className="muted">There's no page at <code>{location.pathname}</code>.</p>
        <div className="row" style={{ justifyContent: 'center', marginTop: 24 }}><A href="/" className="btn secondary">Home</A><A href="/app" className="btn">Open the studio</A></div>
      </div>
    </Page>
  )
}

const TITLES: [RegExp, string][] = [[/^\/app/, 'Studio'], [/^\/docs/, 'Docs'], [/^\/settings/, 'Settings']]

export default function App() {
  const path = usePath()
  useEffect(() => {
    void loadProjects().then(() => initAuth())
    if (settings$.get().reduceMotion) document.documentElement.classList.add('reduce-motion')
  }, [])
  useEffect(() => {
    const t = TITLES.find(([re]) => re.test(path))
    document.title = t ? `${t[1]} · Dataset Studio` : 'Dataset Studio · fine-tuning data that actually trains'
  }, [path])

  let page
  if (path === '/') page = <Landing />
  else if (path === '/app' || path.startsWith('/app/')) page = <Studio path={path} />
  else if (path === '/docs') page = <Docs />
  else if (path === '/settings') page = <Settings />
  else page = <NotFound />

  return (
    <>
      <Header />
      <Suspense fallback={<Page><div className="skeleton" style={{ height: 240, marginTop: 32 }} /></Page>}>{page}</Suspense>
      {path !== '/' && <Footer />}
      <Toasts />
    </>
  )
}
