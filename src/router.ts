import { useSyncExternalStore } from 'react'

const subs = new Set<() => void>()
const notify = () => subs.forEach((s) => s())
window.addEventListener('popstate', notify)

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  if (to === location.pathname + location.search) return
  if (opts.replace) history.replaceState(null, '', to)
  else history.pushState(null, '', to)
  notify()
  if (!opts.replace) window.scrollTo({ top: 0 })
}

export function usePath(): string {
  return useSyncExternalStore((s) => { subs.add(s); return () => { subs.delete(s) } }, () => location.pathname, () => '/')
}

/** Intercept same-origin <a href> clicks so links stay client-side. */
export function linkHandler(e: React.MouseEvent<HTMLAnchorElement>) {
  const a = e.currentTarget
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || a.target === '_blank') return
  const url = new URL(a.href)
  if (url.origin !== location.origin) return
  e.preventDefault()
  navigate(url.pathname + url.search)
}
