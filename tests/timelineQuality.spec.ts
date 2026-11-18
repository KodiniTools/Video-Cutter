import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const api = vi.hoisted(() => ({
  result: null as unknown,
  error: null as Error | null,
  calls: 0,
}))
vi.mock('@/lib/qualityApi', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/qualityApi')>()
  return {
    ...real,
    measureLoudness: () => {
      api.calls++
      return api.error ? Promise.reject(api.error) : Promise.resolve(api.result)
    },
  }
})

import QualityCheck from '@/components/timeline/QualityCheck.vue'
import ExportDialog from '@/components/timeline/ExportDialog.vue'
import { i18n } from '@/i18n'
import { loudnessDoc, QUALITY_UNSUPPORTED } from '@/lib/qualityApi'
import { useTimelineStore } from '@/stores/timeline'
import { createDoc, type TimelineDoc } from '@/timeline/model'
import {
  audioHints,
  documentHints,
  filmDuration,
  parseLoudness,
  readSeconds,
  type LoudnessMeasure,
} from '@/timeline/quality'

const s = (sec: number) => Math.round(sec * 1_000_000)

/** Dokument mit einem Video, seinem Ton und optionalen Texten. */
function doc(opts: {
  video?: Array<{
    id: string
    start: number
    dur: number
    src?: number
    asset?: string
    transition?: boolean
    hold?: boolean
  }>
  audio?: Array<{ id: string; start: number; dur: number; fadeIn?: boolean; fadeOut?: boolean }>
  texts?: Array<{ id: string; start: number; dur: number; data: Record<string, unknown> }>
}): TimelineDoc {
  const d = createDoc({ width: 1920, height: 1080, fps: 25 })
  d.assets = {
    m1: { id: 'm1', kind: 'video', name: 'a.mp4', duration: s(60), hasAudio: true },
    m2: { id: 'm2', kind: 'video', name: 'b.mp4', duration: s(60), hasAudio: true },
  }
  d.tracks = [
    {
      id: 'E1',
      kind: 'overlay',
      name: 'E1',
      locked: false,
      hidden: false,
      clips: (opts.texts ?? []).map((t) => ({
        id: t.id,
        kind: 'text' as const,
        start: s(t.start),
        duration: s(t.dur),
        data: t.data,
      })),
    },
    {
      id: 'V1',
      kind: 'video',
      name: 'V1',
      locked: false,
      hidden: false,
      clips: (opts.video ?? []).map((v) => ({
        id: v.id,
        kind: 'video' as const,
        asset: v.asset ?? 'm1',
        start: s(v.start),
        duration: s(v.dur),
        sourceIn: s(v.src ?? v.start),
        speed: 1,
        ...(v.transition ? { transitionIn: { preset: 'fade' as const, duration: s(0.5) } } : {}),
        ...(v.hold ? { hold: true } : {}),
      })),
    },
    {
      id: 'A1',
      kind: 'audio',
      name: 'A1',
      locked: false,
      muted: false,
      solo: false,
      volume: 1,
      clips: (opts.audio ?? []).map((a) => ({
        id: a.id,
        kind: 'audio' as const,
        asset: 'm1',
        start: s(a.start),
        duration: s(a.dur),
        sourceIn: 0,
        speed: 1,
        gain: 1,
        ...(a.fadeIn ? { fadeIn: { duration: s(0.5), curve: 'tri' as const } } : {}),
        ...(a.fadeOut ? { fadeOut: { duration: s(0.5), curve: 'tri' as const } } : {}),
      })),
    },
  ]
  return d
}

/** Messung: `levels` je Sekunde (LUFS), daraus 10 Schritte je Sekunde. */
function measure(levels: number[], over: Partial<LoudnessMeasure> = {}): LoudnessMeasure {
  const momentary = levels.flatMap((v) => new Array(10).fill(v) as number[])
  return {
    integrated: -16,
    range: 4,
    truePeak: -2,
    step: 0.1,
    momentary,
    peak: momentary.map((v) => (v <= -60 ? -99 : -6)),
    ...over,
  }
}

// jsdom kennt kein Canvas: Die Prüfung schätzt dann die Textbreite.
HTMLCanvasElement.prototype.getContext = (() =>
  null) as typeof HTMLCanvasElement.prototype.getContext

const kinds = (hints: Array<{ kind: string }>) => hints.map((h) => h.kind)

describe('documentHints', () => {
  it('meldet Lücken ohne Bild, auch am Ende hinter dem letzten Video', () => {
    const d = doc({
      video: [
        { id: 'v1', start: 0, dur: 2 },
        { id: 'v2', start: 3, dur: 2, src: 10 },
      ],
      audio: [{ id: 'a1', start: 0, dur: 6 }],
    })
    const gaps = documentHints(d).filter((h) => h.kind === 'gap')
    expect(gaps.map((g) => [g.at, g.end])).toEqual([
      [s(2), s(3)],
      [s(5), s(6)],
    ])
  })

  it('Standbild in der Lücke (hold) gilt als Bild', () => {
    const d = doc({
      video: [
        { id: 'v1', start: 0, dur: 2, hold: true },
        { id: 'v2', start: 3, dur: 2, src: 10 },
      ],
    })
    expect(kinds(documentHints(d))).not.toContain('gap')
  })

  it('erkennt Blitzer und Sprünge im selben Video (ohne Übergang)', () => {
    const d = doc({
      video: [
        { id: 'v1', start: 0, dur: 2, src: 0 },
        { id: 'v2', start: 2, dur: 2, src: 5 },
        { id: 'v3', start: 4, dur: 0.2, src: 20 },
        { id: 'v4', start: 4.2, dur: 2, src: 30, transition: true },
        { id: 'v5', start: 6.2, dur: 2, src: 0, asset: 'm2' },
      ],
    })
    const hints = documentHints(d)
    const flash = hints.find((h) => h.kind === 'flashClip')
    expect(flash).toMatchObject({ clipId: 'v3', at: s(4), params: { frames: 5 } })
    const jumps = hints.filter((h) => h.kind === 'jumpCut')
    // v1→v2 (3 s ausgelassen) und v2→v3; v4 hat einen Übergang, v5 ist ein anderes Video.
    expect(jumps.map((j) => j.clipId)).toEqual(['v2', 'v3'])
    expect(jumps[0].params.s).toBe(3)
    // Warnungen vor Hinweisen.
    expect(hints[0].severity).toBe('warn')
  })

  it('Text zu kurz zum Lesen', () => {
    expect(readSeconds('Hi')).toBe(1)
    expect(readSeconds('Ein ziemlich langer Satz zum Lesen')).toBeCloseTo(0.5 + 29 / 15)
    const d = doc({
      texts: [
        { id: 't1', start: 1, dur: 0.8, data: { text: 'Hallo' } },
        { id: 't2', start: 3, dur: 3, data: { text: 'Hallo' } },
      ],
    })
    const short = documentHints(d).filter((h) => h.kind === 'textShort')
    expect(short).toHaveLength(1)
    expect(short[0]).toMatchObject({ clipId: 't1', params: { shown: 0.8, need: 1, text: 'Hallo' } })
  })

  it('Text außerhalb des sicheren Bereichs bzw. über den Bildrand', () => {
    const fixed = () => 100 // 100 px bei Schriftgröße 1000·size → Breite 0,1 / Bildseitenverhältnis
    const d = doc({
      texts: [
        { id: 'mitte', start: 0, dur: 5, data: { text: 'Mitte', x: 0.5, y: 0.5, size: 0.06 } },
        { id: 'rand', start: 0, dur: 5, data: { text: 'Rand', x: 0.5, y: 0.96, size: 0.06 } },
        { id: 'raus', start: 0, dur: 5, data: { text: 'Raus', x: 0.99, y: 0.5, size: 0.06 } },
        {
          id: 'key',
          start: 10,
          dur: 5,
          data: {
            text: 'Wandert',
            x: 0.5,
            y: 0.5,
            size: 0.06,
            keys: [
              { at: 0, x: 0.5, y: 0.5, scale: 1 },
              { at: s(2), x: 0.5, y: 0.06, scale: 1 },
            ],
          },
        },
      ],
    })
    const hints = documentHints(d, { measure: fixed, lineRatio: () => 1.2 })
    const byClip = Object.fromEntries(
      hints.filter((h) => h.kind.startsWith('text')).map((h) => [h.clipId, h]),
    )
    expect(byClip.mitte).toBeUndefined()
    expect(byClip.rand.kind).toBe('textUnsafe')
    expect(byClip.raus.kind).toBe('textOutside')
    // Sprungziel = der Keyframe, an dem der Text am weitesten draußen ist.
    expect(byClip.key).toMatchObject({ kind: 'textUnsafe', at: s(12) })
  })

  it('versteckte Ebenen werden nicht geprüft', () => {
    const d = doc({ texts: [{ id: 't1', start: 0, dur: 0.3, data: { text: 'x', x: 1 } }] })
    ;(d.tracks[0] as { hidden: boolean }).hidden = true
    expect(documentHints(d)).toEqual([])
  })
})

describe('audioHints', () => {
  const base = () =>
    doc({ video: [{ id: 'v1', start: 0, dur: 10 }], audio: [{ id: 'a1', start: 0, dur: 10 }] })

  it('Gesamtlautheit zu leise/laut, aber nicht beim Angleichen', () => {
    const d = base()
    const quiet = measure(new Array(10).fill(-25), { integrated: -25 })
    expect(kinds(audioHints(d, quiet))).toEqual(['loudnessLow'])
    expect(audioHints(d, quiet, { normalized: true })).toEqual([])
    const loud = measure(new Array(10).fill(-7), { integrated: -7 })
    expect(audioHints(d, loud)[0]).toMatchObject({ kind: 'loudnessHigh', params: { lufs: -7 } })
  })

  it('übersteuerte Stellen als Bereich', () => {
    const m = measure(new Array(10).fill(-16))
    m.peak[30] = 0.4
    m.peak[32] = 1.2
    const clip = audioHints(base(), m).filter((h) => h.kind === 'clipping')
    expect(clip).toHaveLength(1)
    expect(clip[0]).toMatchObject({ at: s(3), end: s(3.3), params: { db: 1.2 } })
  })

  it('Stille ab 2 s und deutlich leisere Stellen', () => {
    const levels = [-16, -16, -70, -70, -70, -16, -40, -40, -40, -40, -16, -16]
    const hints = audioHints(base(), measure(levels))
    const silence = hints.find((h) => h.kind === 'silence')
    // Gemessen erst, wenn das 400-ms-Fenster ganz still ist: Beginn 0,3 s früher.
    expect(silence).toMatchObject({ at: s(1.7), end: s(5), params: { s: 3.3 } })
    const quiet = hints.find((h) => h.kind === 'quiet')
    expect(quiet?.at).toBeGreaterThanOrEqual(s(5.5))
    expect(quiet?.end).toBeLessThanOrEqual(s(10.5))
    expect(audioHints(base(), measure([-16, -70, -16])).map((h) => h.kind)).not.toContain('silence')
  })

  it('kein Ton: nur ein Hinweis', () => {
    expect(kinds(audioHints(base(), measure(new Array(5).fill(-70))))).toEqual(['noAudio'])
  })

  it('abrupter Sprung an harter Clip-Grenze, nicht mit Blende', () => {
    const levels = [-16, -16, -16, -16, -16, -70, -70, -70]
    // Ende des Films: kein Hinweis (dort endet alles).
    expect(kinds(audioHints(base(), measure(new Array(10).fill(-16))))).toEqual([])
    const hard = doc({
      video: [{ id: 'v1', start: 0, dur: 8 }],
      audio: [{ id: 'a1', start: 0, dur: 5 }],
    })
    const jump = audioHints(hard, measure(levels)).find((h) => h.kind === 'audioJump')
    expect(jump).toMatchObject({ at: s(5), clipId: 'a1', params: { dir: 'down', lu: 54 } })
    const soft = doc({
      video: [{ id: 'v1', start: 0, dur: 8 }],
      audio: [{ id: 'a1', start: 0, dur: 5, fadeOut: true }],
    })
    expect(kinds(audioHints(soft, measure(levels)))).not.toContain('audioJump')
    // Gleich laut weiter (z. B. nächster Clip): kein Sprung.
    expect(kinds(audioHints(hard, measure(new Array(8).fill(-16))))).not.toContain('audioJump')
  })

  it('parseLoudness prüft die Antwort', () => {
    const m = measure([-16])
    expect(parseLoudness(m)).toEqual(m)
    expect(parseLoudness({ ...m, peak: [] })).toBeNull()
    expect(parseLoudness(null)).toBeNull()
  })
})

describe('loudnessDoc', () => {
  it('schickt nur Bild- und Ton-Spuren, ohne Marker', () => {
    const d = doc({
      video: [{ id: 'v1', start: 0, dur: 2 }],
      texts: [{ id: 't', start: 0, dur: 9, data: { text: 'x' } }],
    })
    d.markers = [{ id: 'm', at: 0, label: 'K' }]
    const sent = loudnessDoc(d)
    expect(sent.tracks.map((t) => t.kind)).toEqual(['video', 'audio'])
    expect(sent.markers).toEqual([])
    // Die Länge des ganzen Films geht separat mit (Text länger als das Video).
    expect(filmDuration(d)).toBe(s(9))
  })
})

describe('QualityCheck im Export-Dialog', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    api.result = measure(new Array(6).fill(-25), { integrated: -25, truePeak: -3.2, range: 2 })
    api.error = null
    api.calls = 0
    i18n.global.locale.value = 'de'
  })

  function setup() {
    const store = useTimelineStore()
    const issues = store.load(
      doc({
        video: [{ id: 'v1', start: 0, dur: 5 }],
        audio: [{ id: 'a1', start: 0, dur: 6 }],
        texts: [{ id: 't1', start: 1, dur: 0.5, data: { text: 'Kurz' } }],
      }),
    )
    expect(issues).toEqual([])
    return store
  }

  it('zeigt Messung und Hinweise; „Zeigen“ springt und markiert den Clip', async () => {
    const store = setup()
    const w = mount(ExportDialog, { global: { plugins: [i18n] }, attachTo: document.body })
    await flushPromises()
    expect(api.calls).toBe(1)
    const box = w.get('[data-testid="quality-check"]')
    expect(box.get('[data-testid="quality-audio"]').text()).toContain('-25,0 LUFS')
    const items = box.findAll('li')
    expect(items.map((li) => li.attributes('data-kind'))).toEqual([
      'loudnessLow',
      'textShort',
      'gap',
    ])

    // Mit „Lautstärke angleichen“ entfällt der Hinweis zur Gesamtlautheit.
    await w.get('[data-testid="export-normalize"]').setValue(true)
    expect(box.findAll('li').map((li) => li.attributes('data-kind'))).toEqual(['textShort', 'gap'])

    await box.findAll('[data-testid="quality-jump"]')[0].trigger('click')
    expect(store.playhead).toBe(s(1))
    expect(store.selection).toEqual(['t1'])
    expect(w.emitted('close')).toHaveLength(1)
    w.unmount()
  })

  it('altes Backend: Hinweis statt Fehler, Dokument-Prüfung läuft trotzdem', async () => {
    setup()
    api.error = new Error(QUALITY_UNSUPPORTED)
    const w = mount(QualityCheck, { props: { normalized: false }, global: { plugins: [i18n] } })
    await flushPromises()
    expect(w.get('[data-testid="quality-audio"]').text()).toContain('veraltet')
    expect(w.findAll('li').map((li) => li.attributes('data-kind'))).toEqual(['textShort', 'gap'])
  })

  it('Fehler: erneut messen', async () => {
    setup()
    api.error = new Error('kaputt')
    const w = mount(QualityCheck, { props: { normalized: false }, global: { plugins: [i18n] } })
    await flushPromises()
    expect(w.get('[data-testid="quality-audio"]').text()).toContain('kaputt')
    api.error = null
    await w.get('[data-testid="quality-retry"]').trigger('click')
    await flushPromises()
    expect(api.calls).toBe(2)
    expect(w.get('[data-testid="quality-audio"]').text()).toContain('LUFS')
  })
})
