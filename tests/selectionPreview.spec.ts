import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'
import {
  END_PREVIEW_LEAD,
  previewAction,
  restartTime,
  useSelectionPreview,
} from '@/composables/useSelectionPreview'
import { lastFrameSeekTime } from '@/lib/frameTime'

describe('lastFrameSeekTime', () => {
  it('Ende auf Bildanfang -> Mitte des Bildes davor', () => {
    // 25 fps: Bild 50 beginnt bei 2,0 s und gehört NICHT mehr zur Auswahl.
    expect(lastFrameSeekTime(1, 2, 25)).toBeCloseTo(49.5 / 25, 6)
  })
  it('ms-gerundeter Bildanfang (29,97 fps) zählt als Bildanfang', () => {
    const fps = 30000 / 1001
    const end = Math.round((96 / fps) * 1000) / 1000 // 3.203
    expect(lastFrameSeekTime(0, end, fps)).toBeCloseTo(95.5 / fps, 6)
  })
  it('Ende mitten im Bild -> dieses Bild ist das letzte', () => {
    expect(lastFrameSeekTime(0, 2.02, 25)).toBeCloseTo(50.5 / 25, 6)
  })
  it('nie vor dem Anfang, ohne fps 10 ms vor Ende', () => {
    expect(lastFrameSeekTime(2.03, 2.035, 25)).toBe(2.03)
    expect(lastFrameSeekTime(1, 3, 0)).toBeCloseTo(2.99, 6)
  })
})

describe('previewAction / restartTime', () => {
  it('läuft bis kurz vor Ende, dann stop bzw. loop', () => {
    expect(previewAction(1.9, 2, false, 25)).toBe('play')
    expect(previewAction(1.99, 2, false, 25)).toBe('stop')
    expect(previewAction(2.5, 2, true, 25)).toBe('loop')
  })
  it('Neustart: Anfang-Regler ab Anfang, Ende-Regler kurz vor Ende', () => {
    expect(restartTime('start', 1, 10, 0)).toBe(1)
    expect(restartTime('end', 1, 10, 0)).toBe(10 - END_PREVIEW_LEAD)
    expect(restartTime('end', 9, 10, 0)).toBe(9)
    expect(restartTime('start', 1, 10, 25)).toBeCloseTo(25.5 / 25, 6)
  })
})

/** Minimaler Player-Ersatz: play/pause + pause-Ereignis wie im Browser (asynchron). */
function fakeVideo() {
  const el = document.createElement('video')
  let paused = true
  Object.defineProperty(el, 'paused', { get: () => paused })
  el.play = vi.fn(() => {
    paused = false
    return Promise.resolve()
  })
  el.pause = vi.fn(() => {
    if (paused) return
    paused = true
    queueMicrotask(() => el.dispatchEvent(new Event('pause')))
  })
  el.currentTime = 0
  return el
}

describe('useSelectionPreview', () => {
  let frames: FrameRequestCallback[] = []
  beforeEach(() => {
    frames = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb))
    vi.stubGlobal('cancelAnimationFrame', () => {})
  })
  afterEach(() => vi.unstubAllGlobals())
  const flushFrame = () => {
    const f = frames
    frames = []
    f.forEach((cb) => cb(0))
  }

  function setup() {
    const el = fakeVideo()
    const video = ref<HTMLVideoElement | null>(el)
    const start = ref(1)
    const end = ref(3)
    const seek = vi.fn((s: number) => (el.currentTime = s))
    let api!: ReturnType<typeof useSelectionPreview>
    mount(
      defineComponent({
        setup() {
          api = useSelectionPreview({ video, start, end, fps: ref(0), seek })
          return () => h('div')
        },
      }),
    )
    return { el, start, end, seek, api }
  }

  it('spielt ab Anfang und hält am letzten Bild an', async () => {
    const { el, seek, api } = setup()
    api.play()
    await nextTick()
    await Promise.resolve()
    expect(seek).toHaveBeenLastCalledWith(1)
    expect(api.active.value).toBe(true)
    el.currentTime = 2.5
    flushFrame()
    expect(el.paused).toBe(false)
    el.currentTime = 3.01
    flushFrame()
    expect(el.paused).toBe(true)
    expect(seek).toHaveBeenLastCalledWith(2.99)
    expect(api.active.value).toBe(false)
  })

  it('Schleife springt zurück zum Anfang', async () => {
    const { el, seek, api } = setup()
    api.loop.value = true
    api.play()
    await Promise.resolve()
    el.currentTime = 3.2
    flushFrame()
    expect(seek).toHaveBeenLastCalledWith(1)
    expect(el.paused).toBe(false)
    expect(api.active.value).toBe(true)
  })

  it('Reglerziehen hält an, Loslassen spielt mit neuem Bereich weiter', async () => {
    const { el, end, seek, api } = setup()
    api.play()
    await Promise.resolve()
    api.holdForEdit()
    await Promise.resolve() // pause-Ereignis (intern) darf die Vorschau nicht beenden
    expect(el.paused).toBe(true)
    expect(api.active.value).toBe(true)
    end.value = 8
    api.rangeEdited('end')
    expect(seek).toHaveBeenLastCalledWith(8 - END_PREVIEW_LEAD)
    expect(el.paused).toBe(false)
  })

  it('Pause von außen beendet die Vorschau, Bereichsänderung startet dann nichts', async () => {
    const { el, api } = setup()
    api.play()
    await Promise.resolve()
    el.pause()
    await Promise.resolve()
    expect(api.active.value).toBe(false)
    vi.mocked(el.play).mockClear()
    api.rangeEdited('start')
    expect(el.play).not.toHaveBeenCalled()
  })
})
