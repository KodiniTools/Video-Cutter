import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'

const runAiJob = vi.fn()
const fetchGeneratedImage = vi.fn()
const saveFile = vi.fn(async (_f: { blob: Blob; name: string }) => true)
vi.mock('@/lib/download', () => ({ saveFile: (f: { blob: Blob; name: string }) => saveFile(f) }))

vi.mock('@/lib/aiApi', async (orig) => {
  const real = await orig<typeof import('@/lib/aiApi')>()
  return {
    ...real,
    runAiJob: (...a: unknown[]) => runAiJob(...a),
    fetchGeneratedImage: (...a: unknown[]) => fetchGeneratedImage(...a),
    fetchAiStatus: async () => ({ transcribe: false, claude: true, image: true }),
  }
})

import StillAiImage from '@/components/StillAiImage.vue'
import { parseGeneratedImages, parseImagePrompt } from '@/lib/aiApi'

const before = { mediaId: 'a'.repeat(32), time: 4.9, name: 'intro.mp4' }

function mountIt(over: Record<string, unknown> = {}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  return mount(StillAiImage, {
    props: { width: 1920, height: 1080, before, after: null, disabled: false, ...over },
    global: { plugins: [i18n, pinia] },
  })
}

beforeEach(() => {
  runAiJob.mockReset()
  fetchGeneratedImage.mockReset()
  globalThis.URL.createObjectURL = vi.fn(() => `blob:${Math.random()}`)
  globalThis.URL.revokeObjectURL = vi.fn()
})

describe('StillAiImage', () => {
  it('Claude schreibt den Prompt mit Stil, Größe und Nachbarclip', async () => {
    runAiJob.mockReturnValue({ promise: Promise.resolve('Ruhiger Berg'), cancel: vi.fn() })
    const w = mountIt()
    await flushPromises()
    await w.find('[data-test=still-ai-idea]').setValue('Berg')
    await w.find('[data-test=still-ai-style]').setValue('photo')
    await w.find('[data-test=still-ai-write]').trigger('click')
    await flushPromises()
    const [action, body] = runAiJob.mock.calls[0]
    expect(action).toBe('image-prompt')
    expect(body).toMatchObject({
      idea: 'Berg',
      style: 'photo',
      width: 1920,
      height: 1080,
      before: { mediaId: before.mediaId, time: 4.9 },
    })
    expect(body.after).toBeUndefined()
    expect((w.find('[data-test=still-ai-prompt]').element as HTMLTextAreaElement).value).toBe(
      'Ruhiger Berg',
    )
  })

  it('ohne Kontext und ohne Stichworte kein Prompt-Auftrag', async () => {
    const w = mountIt({ before: null })
    await flushPromises()
    expect(w.find('[data-test=still-ai-write]').attributes('disabled')).toBeDefined()
  })

  it('erzeugt Varianten und meldet die erste als Auswahl, Klick wählt eine andere', async () => {
    const f1 = new File(['1'], 'v1.png', { type: 'image/png' })
    const f2 = new File(['2'], 'v2.png', { type: 'image/png' })
    runAiJob.mockReturnValue({
      promise: Promise.resolve({ images: [{ id: 'x' }, { id: 'y' }], failed: 0 }),
      cancel: vi.fn(),
    })
    fetchGeneratedImage.mockResolvedValueOnce(f1).mockResolvedValueOnce(f2)
    const w = mountIt()
    await flushPromises()
    await w.find('[data-test=still-ai-prompt]').setValue('Berg im Nebel')
    await w.find('[data-test=still-ai-count]').setValue('2')
    await w.find('[data-test=still-ai-generate]').trigger('click')
    await flushPromises()
    expect(runAiJob.mock.calls[0][0]).toBe('images')
    expect(runAiJob.mock.calls[0][1]).toMatchObject({ prompt: 'Berg im Nebel', count: 2 })
    expect(w.findAll('[data-test=still-ai-variant]')).toHaveLength(2)
    expect(w.emitted('pick')?.[0]).toEqual([f1])
    await w.findAll('[data-test=still-ai-variant]')[1].trigger('click')
    expect(w.emitted('pick')?.[1]).toEqual([f2])
    expect(w.emitted('busy')).toEqual([[true], [false]])
    // ⬇ speichert genau diese Variante, ohne die Auswahl zu ändern
    await w.findAll('[data-test=still-ai-download]')[0].trigger('click')
    await flushPromises()
    expect(saveFile).toHaveBeenCalledWith({ blob: f1, name: 'v1.png' })
    expect(w.emitted('pick')).toHaveLength(2)
  })

  it('zeigt Fehler des Servers', async () => {
    runAiJob.mockImplementation(() => ({
      promise: Promise.reject(new Error('Die Bilderzeugung ist nicht eingerichtet')),
      cancel: vi.fn(),
    }))
    const w = mountIt()
    await flushPromises()
    await w.find('[data-test=still-ai-prompt]').setValue('x')
    await w.find('[data-test=still-ai-generate]').trigger('click')
    await flushPromises()
    expect(w.find('[role=alert]').text()).toContain('nicht eingerichtet')
  })
})

describe('aiApi: Bild-Ergebnisse prüfen', () => {
  it('parseImagePrompt / parseGeneratedImages', () => {
    expect(parseImagePrompt({ prompt: ' a ' })).toBe('a')
    expect(() => parseImagePrompt({})).toThrow()
    expect(
      parseGeneratedImages({ images: [{ id: 'a', mime: 'image/png' }, { x: 1 }], failed: 1 }),
    ).toMatchObject({ images: [{ id: 'a', mime: 'image/png' }], failed: 1 })
    expect(() => parseGeneratedImages({ images: [] })).toThrow()
  })
})
