import { describe, expect, it } from 'vitest'
import { createMemoryHistory } from 'vue-router'
import { createAppRouter } from '@/router'

async function go(path: string) {
  const router = createAppRouter(createMemoryHistory())
  await router.push(path)
  await router.isReady()
  return router.currentRoute.value
}

describe('Router', () => {
  it('zeigt unter / den Editor mit Timeline', async () => {
    expect((await go('/')).name).toBe('timeline')
  })

  it('zeigt unter /classic den bisherigen Editor', async () => {
    expect((await go('/classic')).name).toBe('classic')
  })

  it('leitet die frühere Adresse /editor auf / um', async () => {
    const route = await go('/editor')
    expect(route.name).toBe('timeline')
    expect(route.path).toBe('/')
  })

  it('leitet unbekannte Adressen zum Editor', async () => {
    const route = await go('/gibt/es/nicht')
    expect(route.name).toBe('timeline')
    expect(route.path).toBe('/')
  })
})
