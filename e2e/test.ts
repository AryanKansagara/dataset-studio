import { expect, test as base } from '@playwright/test'

// Every test is signed out and offline:
//  - requests to the app itself pass through;
//  - Google Fonts (linked from index.html) is stubbed with an empty response;
//  - Hugging Face (tokenizers, public datasets) is refused unless a test serves its own small stand-in (see hub.ts);
//  - anything else, including Supabase, is aborted and fails the test.
// Uncaught page errors also fail the test.
const FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com'])
const HF_HOSTS = new Set(['huggingface.co', 'datasets-server.huggingface.co'])

export const test = base.extend<{ blocked: string[]; pageErrors: string[] }>({
  blocked: [async ({ context }, use) => {
    const blocked: string[] = []
    await context.route(/^https?:\/\//, (route) => {
      const url = new URL(route.request().url())
      if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return route.continue()
      if (FONT_HOSTS.has(url.hostname)) return route.fulfill({ status: 200, contentType: url.hostname === 'fonts.googleapis.com' ? 'text/css' : 'font/woff2', body: '' })
      if (!HF_HOSTS.has(url.hostname)) blocked.push(`${url.protocol}//${url.host}${url.pathname}`)
      return route.abort('blockedbyclient')
    })
    await use(blocked)
    expect(blocked, 'the app must not call any other host').toEqual([])
  }, { auto: true }],

  pageErrors: [async ({ page }, use) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await use(errors)
    expect(errors, 'uncaught page errors').toEqual([])
  }, { auto: true }],
})

export { expect }
