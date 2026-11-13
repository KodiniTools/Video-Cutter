import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { mount } from '@vue/test-utils'
import {
  AI_UNSUPPORTED,
  parseAiStatus,
  parseSubtitles,
  parseSuggestions,
  parseTranscript,
  runAiJob,
} from '@/lib/aiApi'
import { useTextOverlayStore } from '@/stores/textOverlays'
import { useVideoEditorStore } from '@/stores/videoEditor'
import { useAiStore } from '@/stores/ai'
import { MAX_TEXT_OVERLAYS } from '@/lib/textOverlay'
import AiPanel from '@/components/AiPanel.vue'
import { i18n } from '@/i18n'

describe('aiApi: Ergebnisse prüfen', () => {
  it('Status: altes Backend ohne `ai` -> null', () => {
    expect(parseAiStatus({ status: 'ok' })).toBeNull()
    expect(parseAiStatus({ ai: { transcribe: true, claude: false } })).toEqual({
      transcribe: true,
      claude: false,
    })
  })

  it('Transkript, Untertitel und Vorschläge werden bereinigt', () => {
    expect(parseTranscript({ language: 'de', words: 3, text: 'a b c' })).toEqual({
      language: 'de',
      words: 3,
      text: 'a b c',
    })
    expect(
      parseSubtitles({
        cues: [{ start: 1, end: 2, text: 'ok' }, { start: 2, end: 1, text: 'x' }, null],
        truncated: true,
      }),
    ).toEqual({ cues: [{ start: 1, end: 2, text: 'ok' }], truncated: true })
    expect(
      parseSuggestions({
        suggestions: [
          { start: 1, end: 2, kind: 'pause', text: '', reason: '' },
          { start: 3, end: 4, kind: 'quatsch' },
          { start: 5, end: 5 },
        ],
      }),
    ).toEqual([
      { start: 1, end: 2, kind: 'pause', text: '', reason: '' },
      { start: 3, end: 4, kind: 'filler', text: '', reason: '' },
    ])
  })
})

describe('runAiJob', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('404 der Route = Backend veraltet', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(JSON.stringify({ error: 'Nicht gefunden.' }), { status: 404 }),
      ),
    )
    await expect(runAiJob('transcribe', {}, parseTranscript).promise).rejects.toThrow(
      AI_UNSUPPORTED,
    )
  })

  it('liefert das Ergebnis aus dem SSE-Strom', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ jobId: 'j1' }), { status: 202 })),
    )
    class FakeES {
      onmessage: ((ev: { data: string }) => void) | null = null
      onerror: (() => void) | null = null
      constructor(public url: string) {
        setTimeout(() => {
          this.onmessage?.({ data: JSON.stringify({ state: 'processing', progress: 40 }) })
          this.onmessage?.({
            data: JSON.stringify({
              state: 'done',
              result: { language: 'de', words: 2, text: 'a b' },
            }),
          })
        }, 0)
      }
      close(): void {}
    }
    vi.stubGlobal('EventSource', FakeES)
    const seen: number[] = []
    const r = runAiJob('transcribe', { mediaId: 'm' }, parseTranscript, (p) => seen.push(p))
    await expect(r.promise).resolves.toEqual({ language: 'de', words: 2, text: 'a b' })
    expect(seen).toContain(40)
  })
})

describe('Stores: KI-Ergebnisse übernehmen', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('addMany fügt Untertitel sortiert hinzu, ersetzt optional, beachtet das Limit', () => {
    const texts = useTextOverlayStore()
    expect(texts.addMany([{ start: 0, end: 1, text: 'x' }], false)).toBe(0) // kein Video gewählt
    texts.setItem(1)
    texts.add(5, 10, 'alt')
    const n = texts.addMany(
      [
        { start: 2, end: 3, text: 'B' },
        { start: 0, end: 1, text: 'A' },
      ],
      false,
    )
    expect(n).toBe(2)
    expect(texts.overlays.map((o) => o.text)).toEqual(['A', 'B', 'alt'])
    texts.addMany([{ start: 0, end: 1, text: 'neu' }], true)
    expect(texts.overlays.map((o) => o.text)).toEqual(['neu'])
    expect(texts.overlays[0].animation).toBe('none')
    const many = Array.from({ length: MAX_TEXT_OVERLAYS + 5 }, (_, i) => ({
      start: i,
      end: i + 0.5,
      text: `t${i}`,
    }))
    expect(texts.addMany(many, true)).toBe(MAX_TEXT_OVERLAYS)
  })

  it('addRemoveRanges stellt auf Entfernen und ergänzt ohne Duplikate', () => {
    const editor = useVideoEditorStore()
    editor.segments = [{ start: 0, end: 5 }] // „Behalten"-Liste wird ersetzt
    editor.addRemoveRanges([
      { start: 3, end: 4 },
      { start: 1, end: 2 },
      { start: 1, end: 1.01 }, // zu kurz
    ])
    expect(editor.operation).toBe('remove')
    expect(editor.segments).toEqual([
      { start: 1, end: 2 },
      { start: 3, end: 4 },
    ])
    editor.addRemoveRanges([
      { start: 1, end: 2 },
      { start: 6, end: 7 },
    ])
    expect(editor.segments.length).toBe(3)
  })

  it('KI-Daten gelten nur für dieselbe Server-Datei', () => {
    const ai = useAiStore()
    expect(ai.dataFor(1, 'm1')).toBeNull()
  })
})

describe('AiPanel', () => {
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => vi.unstubAllGlobals())

  const mountPanel = () =>
    mount(AiPanel, {
      props: { itemId: 1, mediaId: 'm1', ready: true, hasAudio: true, busy: false },
      global: { plugins: [i18n] },
    })

  it('meldet ein veraltetes Backend', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ status: 'ok' }))),
    )
    const w = mountPanel()
    await vi.waitFor(() => expect(w.text()).toContain('veraltet'))
  })

  it('zeigt fehlende Einrichtung und sperrt Claude-Funktionen', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ai: { transcribe: true, claude: false } }))),
    )
    const w = mountPanel()
    await vi.waitFor(() => expect(w.text()).toContain('ANTHROPIC_API_KEY'))
    const btn = w.findAll('button').find((b) => b.text() === 'Sprache erkennen')
    expect(btn?.attributes('disabled')).toBeUndefined()
  })
})
