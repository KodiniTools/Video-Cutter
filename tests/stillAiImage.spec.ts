import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'

const runAiJob = vi.fn()
const fetchGeneratedImage = vi.fn()
const fetchAiModels = vi.fn()
const saveFile = vi.fn(async (_f: { blob: Blob; name: string }) => true)
vi.mock('@/lib/download', () => ({ saveFile: (f: { blob: Blob; name: string }) => saveFile(f) }))

vi.mock('@/lib/aiApi', async (orig) => {
  const real = await orig<typeof import('@/lib/aiApi')>()
  return {
    ...real,
    runAiJob: (...a: unknown[]) => runAiJob(...a),
    fetchGeneratedImage: (...a: unknown[]) => fetchGeneratedImage(...a),
    fetchAiStatus: async () => ({ transcribe: false, claude: true, image: true }),
    fetchAiModels: () => fetchAiModels(),
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
  fetchAiModels.mockReset().mockResolvedValue(null)
  localStorage.clear()
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

  it('Modus Video: eigener Prompt-Auftrag mit Länge; fertiges Video wird gemeldet', async () => {
    const media = {
      id: 'm1',
      name: 'KI-Video_6s.mp4',
      size: 1,
      duration: 6,
      width: 1280,
      height: 720,
      hasAudio: true,
      fps: 24,
    }
    runAiJob
      .mockReturnValueOnce({ promise: Promise.resolve('Kamerafahrt über Berge'), cancel: vi.fn() })
      .mockReturnValueOnce({
        promise: Promise.resolve({ media, saved: 1, galleryError: '' }),
        cancel: vi.fn(),
      })
    const w = mountIt()
    await flushPromises()
    await w.find('[data-test=still-ai-prompt]').setValue('Bild-Prompt')
    await w.find('[data-test=still-ai-mode-video]').trigger('click')
    // Jeder Modus hat seinen eigenen Prompt; statt Varianten gibt es die Länge.
    expect((w.find('[data-test=still-ai-prompt]').element as HTMLTextAreaElement).value).toBe('')
    expect(w.find('[data-test=still-ai-count]').exists()).toBe(false)
    await w.find('[data-test=still-ai-duration]').setValue('6')
    await w.find('[data-test=still-ai-idea]').setValue('Berge')
    await w.find('[data-test=still-ai-write]').trigger('click')
    await flushPromises()
    expect(runAiJob.mock.calls[0][0]).toBe('video-prompt')
    expect(runAiJob.mock.calls[0][1]).toMatchObject({ idea: 'Berge', duration: 6 })
    await w.find('[data-test=still-ai-generate]').trigger('click')
    await flushPromises()
    expect(runAiJob.mock.calls[1][0]).toBe('video')
    expect(runAiJob.mock.calls[1][1]).toEqual({
      prompt: 'Kamerafahrt über Berge',
      width: 1920,
      height: 1080,
      duration: 6,
    })
    expect(w.emitted('video')).toEqual([[media]])
    expect(w.emitted('pick')).toBeUndefined()
    await w.find('[data-test=still-ai-mode-image]').trigger('click')
    expect((w.find('[data-test=still-ai-prompt]').element as HTMLTextAreaElement).value).toBe(
      'Bild-Prompt',
    )
  })

  it('Modellauswahl je Modus: Standard vorgewählt, Wahl geht mit und wird gemerkt', async () => {
    fetchAiModels.mockResolvedValue({
      image: { default: 'img-a-image', models: ['img-a-image', 'img-b-image'] },
      video: { default: 'omni-a', models: ['omni-a', 'omni-b'] },
    })
    localStorage.setItem('vc.aiModel.video', 'omni-b')
    localStorage.setItem('vc.aiModel.image', 'nicht-mehr-da')
    const f1 = new File(['1'], 'v1.png', { type: 'image/png' })
    runAiJob.mockReturnValue({
      promise: Promise.resolve({ images: [{ id: 'x' }], failed: 0, model: 'img-b-image' }),
      cancel: vi.fn(),
    })
    fetchGeneratedImage.mockResolvedValue(f1)
    const w = mountIt()
    await flushPromises()
    const sel = () => w.find('[data-test=still-ai-model]').element as HTMLSelectElement
    // Gemerktes, nicht mehr angebotenes Modell -> Standard
    expect(sel().value).toBe('img-a-image')
    expect(sel().options[0].text).toContain('Standard')
    await w.find('[data-test=still-ai-model]').setValue('img-b-image')
    expect(localStorage.getItem('vc.aiModel.image')).toBe('img-b-image')
    await w.find('[data-test=still-ai-prompt]').setValue('Berg')
    await w.find('[data-test=still-ai-generate]').trigger('click')
    await flushPromises()
    expect(runAiJob.mock.calls[0][1]).toMatchObject({ model: 'img-b-image' })
    expect(w.find('[data-test=still-ai-used-model]').text()).toContain('img-b-image')
    await w.find('[data-test=still-ai-mode-video]').trigger('click')
    expect(sel().value).toBe('omni-b')
    expect([...sel().options].map((o) => o.value)).toEqual(['omni-a', 'omni-b'])
  })

  it('altes Backend ohne Modellliste: kein Auswahlfeld, kein model im Auftrag', async () => {
    runAiJob.mockReturnValue({
      promise: Promise.resolve({ images: [{ id: 'x' }], failed: 0 }),
      cancel: vi.fn(),
    })
    fetchGeneratedImage.mockResolvedValue(new File(['1'], 'v1.png', { type: 'image/png' }))
    const w = mountIt()
    await flushPromises()
    expect(w.find('[data-test=still-ai-model]').exists()).toBe(false)
    await w.find('[data-test=still-ai-prompt]').setValue('Berg')
    await w.find('[data-test=still-ai-generate]').trigger('click')
    await flushPromises()
    expect(runAiJob.mock.calls[0][1]).not.toHaveProperty('model')
    expect(w.find('[data-test=still-ai-used-model]').exists()).toBe(false)
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
