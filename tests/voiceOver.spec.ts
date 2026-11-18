import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const api = vi.hoisted(() => ({
  status: { transcribe: true, claude: true, image: false, voice: true as boolean | null },
  calls: [] as { action: string; body: Record<string, unknown> }[],
  results: {} as Record<string, unknown>,
  voices: [] as unknown[],
}))
vi.mock('@/lib/aiApi', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/aiApi')>()
  return {
    ...real,
    fetchAiStatus: () => Promise.resolve(api.status),
    fetchVoices: () => Promise.resolve(real.parseVoices({ voices: api.voices })),
    runAiJob: (action: string, body: Record<string, unknown>, parse: (d: unknown) => unknown) => {
      api.calls.push({ action, body })
      return {
        promise: Promise.resolve().then(() => parse(api.results[action])),
        cancel: () => {},
      }
    },
  }
})
// Die Medienliste fragt sonst den Server nach abgeleiteten Dateien.
vi.mock('@/lib/mediaApi', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/mediaApi')>()
  return { ...real, fetchDerivedStatus: () => new Promise(() => {}) }
})

import VoiceOverForm from '@/components/timeline/VoiceOverForm.vue'
import { i18n } from '@/i18n'
import { parseScript, parseVoiceOver, parseVoices, SCRIPT_LANGUAGES } from '@/lib/aiApi'
import { useMediaPoolStore } from '@/stores/mediaPool'
import { useTimelineStore } from '@/stores/timeline'

const S = 1_000_000

describe('aiApi: KI-Sprecher', () => {
  it('prüft Stimmen, Text und Ergebnis', () => {
    expect(parseVoices({ voices: [{ id: 'a', name: 'Anna' }, { name: 'ohne id' }, 3] })).toEqual([
      { id: 'a', name: 'Anna', category: '', description: '', previewUrl: '' },
    ])
    expect(parseVoices(null)).toEqual([])
    expect(parseScript({ text: 'Hallo' })).toBe('Hallo')
    expect(() => parseScript({ text: ' ' })).toThrow()
    expect(parseVoiceOver({ media: { id: 'm1', kind: 'audio', duration: 3 } }).kind).toBe('audio')
    expect(SCRIPT_LANGUAGES).not.toContain('auto')
    expect(SCRIPT_LANGUAGES).toContain('hr')
  })
})

describe('VoiceOverForm', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    i18n.global.locale.value = 'de'
    api.status = { transcribe: true, claude: true, image: false, voice: true }
    api.calls = []
    api.results = {}
    api.voices = [
      { id: 'v1', name: 'Anna', description: 'female', previewUrl: '' },
      { id: 'v2', name: 'Ben' },
    ]
    try {
      localStorage.clear()
    } catch {
      /* ohne Speicher */
    }
  })

  it('ohne Schlüssel: Hinweis, Schreiben geht, Vertonen nicht', async () => {
    api.status = { ...api.status, voice: false }
    const w = mount(VoiceOverForm, { global: { plugins: [i18n] } })
    await flushPromises()
    expect(w.find('[data-testid=voice-over-no-key]').text()).toContain('ELEVENLABS_API_KEY')
    expect(w.find('[data-testid=voice-over-speak]').exists()).toBe(false)
    expect(w.find('[data-testid=voice-over-write-run]').exists()).toBe(true)
  })

  it('altes Backend ohne KI-Sprecher: Hinweis „veraltet“', async () => {
    api.status = { ...api.status, voice: null }
    const w = mount(VoiceOverForm, { global: { plugins: [i18n] } })
    await flushPromises()
    expect(w.find('[data-testid=voice-over-outdated]').exists()).toBe(true)
  })

  it('Claude schreibt und übersetzt, alter Text lässt sich zurückholen', async () => {
    const w = mount(VoiceOverForm, { global: { plugins: [i18n] } })
    await flushPromises()
    await w.get('[data-testid=voice-over-language]').setValue('hr')
    await w.get('[data-testid=voice-over-idea]').setValue('Intro')
    api.results.script = { text: 'Bok svima.' }
    await w.get('[data-testid=voice-over-write-run]').trigger('click')
    await flushPromises()
    expect(api.calls[0]).toEqual({
      action: 'script',
      body: { mode: 'write', idea: 'Intro', language: 'hr', seconds: 30 },
    })
    const text = w.get('[data-testid=voice-over-text]').element as HTMLTextAreaElement
    expect(text.value).toBe('Bok svima.')

    await w.get('[data-testid=voice-over-language]').setValue('en')
    api.results.script = { text: 'Hello everyone.' }
    await w.get('[data-testid=voice-over-translate]').trigger('click')
    await flushPromises()
    expect(api.calls[1].body).toEqual({ mode: 'translate', text: 'Bok svima.', language: 'en' })
    expect(text.value).toBe('Hello everyone.')
    await w.get('[data-testid=voice-over-restore]').trigger('click')
    expect(text.value).toBe('Bok svima.')
  })

  it('vertont und legt die Tondatei am Abspielkopf auf eine Ton-Spur', async () => {
    const timeline = useTimelineStore()
    const pool = useMediaPoolStore()
    timeline.seek(4 * S)
    const w = mount(VoiceOverForm, { global: { plugins: [i18n] } })
    await flushPromises()
    expect((w.get('[data-testid=voice-over-voice]').element as HTMLSelectElement).value).toBe('v1')
    await w.get('[data-testid=voice-over-voice]').setValue('v2')
    await w.get('[data-testid=voice-over-text]').setValue('Hallo Welt')
    api.results['voice-over'] = {
      media: {
        id: 'voice1',
        name: 'KI-Sprecher Ben.mp3',
        kind: 'audio',
        duration: 2.5,
        hasAudio: true,
      },
    }
    await w.get('[data-testid=voice-over-speak]').trigger('click')
    await flushPromises()

    expect(api.calls[0]).toEqual({
      action: 'voice-over',
      body: { text: 'Hallo Welt', voiceId: 'v2', voiceName: 'Ben', speed: 1, stability: 0.5 },
    })
    expect(pool.byAsset('voice1')).toBeTruthy()
    const clips = timeline.doc.tracks.flatMap((t) =>
      t.clips.filter((c) => c.asset === 'voice1').map((c) => ({ kind: t.kind, start: c.start })),
    )
    expect(clips).toEqual([{ kind: 'audio', start: 4 * S }])
    expect(w.get('[data-testid=voice-over-notice]').text()).toContain('KI-Sprecher Ben.mp3')
  })

  it('zu langer Text sperrt das Vertonen', async () => {
    const w = mount(VoiceOverForm, { global: { plugins: [i18n] } })
    await flushPromises()
    await w.get('[data-testid=voice-over-text]').setValue('x'.repeat(5001))
    expect(w.get('[data-testid=voice-over-speak]').attributes('disabled')).toBeDefined()
    expect(w.get('[data-testid=voice-over-count]').classes()).toContain('over')
  })
})
