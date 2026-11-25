import { test, expect } from './test.ts'
import { stat } from './helpers.ts'

test('"Try the sample" makes one project per click, again after a delete, and not on reload (#7)', async ({ page }) => {
  for (let i = 0; i < 2; i++) {
    if (!i) await page.goto('/app')
    await page.getByRole('link', { name: 'Try the sample' }).click()
    await expect(stat(page, 'Examples')).toHaveText('1,200')
    await page.reload()
    await expect(stat(page, 'Examples')).toHaveText('1,200')
    await page.getByRole('link', { name: '← Projects' }).click()
    await expect(page.getByRole('link', { name: /^Open Support bot/ })).toHaveCount(1)
    await page.getByRole('button', { name: /^Delete Support bot/ }).click()
    await expect(page.getByRole('heading', { name: 'Turn a raw export into a file that trains.' })).toBeVisible()
  }
})
