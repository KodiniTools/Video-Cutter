import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryHistory } from 'vue-router'
import { createAppRouter } from '@/router'
import { enableTimelineEditor, TIMELINE_EDITOR_KEY } from '@/lib/featureFlags'

async function go(path: string) {
  const router = createAppRouter(createMemoryHistory())
  await router.push(path)
  await router.isReady()
  return router.currentRoute.value
}

describe('Router', () => {
  afterEach(() => localStorage.removeItem(TIMELINE_EDITOR_KEY))

  it('zeigt unter / den bisherigen Editor', async () => {
    expect((await go('/')).name).toBe('classic')
  })

  it('leitet /editor ohne Freischaltung zum bisherigen Editor', async () => {
    const route = await go('/editor')
    expect(route.name).toBe('classic')
    expect(route.path).toBe('/')
  })

  it('öffnet /editor nach Freischaltung', async () => {
    localStorage.setItem(TIMELINE_EDITOR_KEY, '1')
    expect((await go('/editor')).name).toBe('timeline')
  })

  it('öffnet /editor nach dem Schalter in der Kopfzeile', async () => {
    expect(enableTimelineEditor()).toBe(true)
    expect(localStorage.getItem(TIMELINE_EDITOR_KEY)).toBe('1')
    expect((await go('/editor')).name).toBe('timeline')
  })

  it('leitet unbekannte Adressen zum bisherigen Editor', async () => {
    expect((await go('/gibt/es/nicht')).name).toBe('classic')
  })
})
