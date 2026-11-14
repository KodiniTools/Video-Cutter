import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'
import {
  playJumpTarget,
  reachedRangeEnd,
  useListRangePlayback,
  type ListRange,
} from '@/composables/useListRangePlayback'

describe('playJumpTarget / reachedRangeEnd', () => {
  const r: ListRange = { from: 6, to: 10 }
  it('außerhalb des Bereichs -> Sprung an Von, innerhalb -> bleiben', () => {
    expect(playJumpTarget(0, r, 0)).toBe(6)
    expect(playJumpTarget(12, r, 0)).toBe(6)
    expect(playJumpTarget(10, r, 0)).toBe(6) // am Ende angehalten -> von vorn
    expect(playJumpTarget(9.99, r, 0)).toBe(6) // letztes Bild (dort hält die Wiedergabe)
    expect(playJumpTarget(299.5 / 30, r, 30)).toBeCloseTo(180.5 / 30, 6)
    expect(playJumpTarget(6, r, 0)).toBeNull()
    expect(playJumpTarget(8, r, 0)).toBeNull()
  })
  it('mit Bildrate: Sprung in die Bildmitte', () => {
    expect(playJumpTarget(0, r, 25)).toBeCloseTo(150.5 / 25, 6)
  })
  it('offenes Ende (bis Dateiende) hält nie an', () => {
    expect(reachedRangeEnd(100, { from: 6, to: Infinity }, 0)).toBe(false)
    expect(playJumpTarget(100, { from: 6, to: Infinity }, 0)).toBeNull()
    expect(reachedRangeEnd(9.9, r, 0)).toBe(false)
    expect(reachedRangeEnd(10, r, 0)).toBe(true)
  })
})

function fakeVideo() {
  const el = document.createElement('video')
  let paused = true
  Object.defineProperty(el, 'paused', { get: () => paused })
  el.play = vi.fn(() => {
    paused = false
    el.dispatchEvent(new Event('play'))
    return Promise.resolve()
  })
  el.pause = vi.fn(() => {
    paused = true
  })
  el.currentTime = 0
  return el
}

describe('useListRangePlayback', () => {
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

  function setup(initial: ListRange | null = { from: 6, to: 10 }) {
    const el = fakeVideo()
    const range = ref<ListRange | null>(initial)
    const suspended = ref(false)
    const seek = vi.fn((s: number) => (el.currentTime = s))
    let api!: ReturnType<typeof useListRangePlayback>
    mount(
      defineComponent({
        setup() {
          api = useListRangePlayback({
            video: ref<HTMLVideoElement | null>(el),
            range,
            fps: ref(0),
            seek,
            suspended: () => suspended.value,
          })
          return () => h('div')
        },
      }),
    )
    return { el, range, suspended, seek, api }
  }

  it('Abspielen startet bei Von und hält bei Bis an', () => {
    const { el, seek } = setup()
    void el.play()
    expect(seek).toHaveBeenLastCalledWith(6)
    el.currentTime = 8
    flushFrame()
    expect(el.pause).not.toHaveBeenCalled()
    el.currentTime = 10.02
    flushFrame()
    expect(el.pause).toHaveBeenCalledTimes(1)
    expect(seek).toHaveBeenLastCalledWith(9.99)
    // Erneut abspielen: wieder ab Von statt sofort wieder anzuhalten.
    void el.play()
    expect(seek).toHaveBeenLastCalledWith(6)
  })

  it('ungekürzter Clip: Player bleibt unberührt', () => {
    const { el, seek } = setup(null)
    void el.play()
    el.currentTime = 50
    flushFrame()
    expect(seek).not.toHaveBeenCalled()
    expect(el.pause).not.toHaveBeenCalled()
  })

  it('greift nicht ein, solange die Auswahl-Vorschau läuft', () => {
    const { el, seek, suspended } = setup()
    suspended.value = true
    void el.play()
    el.currentTime = 12
    flushFrame()
    expect(seek).not.toHaveBeenCalled()
    expect(el.pause).not.toHaveBeenCalled()
  })

  it('Von geändert (pausiert) -> zeigt das neue Startbild; laufend nicht', async () => {
    const { el, range, seek } = setup()
    range.value = { from: 7, to: 10 }
    await nextTick()
    expect(seek).toHaveBeenLastCalledWith(7)
    void el.play()
    seek.mockClear()
    range.value = { from: 8, to: 10 }
    await nextTick()
    expect(seek).not.toHaveBeenCalled()
  })
})
