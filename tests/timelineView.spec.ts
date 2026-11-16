import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { i18n } from '@/i18n'
import TimelineView from '@/components/timeline/TimelineView.vue'
import { useMediaPoolStore } from '@/stores/mediaPool'
import { useTimelineStore } from '@/stores/timeline'
import { secondsToTime as s } from '@/timeline/model'

vi.mock('@/lib/mediaApi', () => ({
  UPLOAD_ABORTED: 'UPLOAD_ABORTED',
  uploadMedia: vi.fn(),
  deleteMedia: vi.fn(() => Promise.resolve()),
}))

function mountView() {
  return mount(TimelineView, { global: { plugins: [i18n] }, attachTo: document.body })
}

/** Zeiger-Ereignis mit Koordinaten (jsdom kennt PointerEvent nicht vollständig). */
function pointer(type: string, init: MouseEventInit = {}): MouseEvent {
  return new MouseEvent(type, { bubbles: true, button: 0, ...init })
}

describe('Timeline-Ansicht', () => {
  beforeEach(() => setActivePinia(createPinia()))

  function fill() {
    const store = useTimelineStore()
    store.putAsset({
      id: 'vid',
      kind: 'video',
      name: 'a.mp4',
      duration: s(10),
      width: 1920,
      height: 1080,
      fps: 25,
      hasAudio: true,
    })
    store.appendMedia('vid')
    store.appendMedia('vid')
    return store
  }

  it('zeigt den Leerzustand und sperrt Knöpfe ohne Wirkung', () => {
    const wrapper = mountView()
    expect(wrapper.text()).toContain('Noch keine Clips')
    expect(wrapper.find('[data-testid=timeline-ruler]').exists()).toBe(false)
    expect(wrapper.get('[aria-label="Rückgängig"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[aria-label="Wiederholen"]').attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })

  it('legt Clips nach Zeit und Zoom auf ihre Spuren', async () => {
    const store = fill()
    const wrapper = mountView()
    await nextTick()
    const tracks = wrapper.findAll('.track')
    expect(tracks.map((t) => t.attributes('data-kind'))).toEqual(['video', 'audio'])
    expect(tracks.map((t) => t.find('.track-name').text())).toEqual(['V1', 'A1'])

    const clips = tracks[0].findAll('.clip')
    expect(clips.map((c) => c.attributes('style'))).toEqual([
      'left: 0px; width: 1000px;',
      'left: 1000px; width: 1000px;',
    ])
    expect(tracks[1].findAll('.clip')).toHaveLength(2)
    expect(wrapper.get('[data-testid=timeline-time]').text()).toBe('00:00.000 / 00:20.000')

    store.setZoom(50)
    await nextTick()
    expect(wrapper.findAll('.track')[0].findAll('.clip')[1].attributes('style')).toBe(
      'left: 500px; width: 500px;',
    )
    wrapper.unmount()
  })

  it('setzt den Abspielkopf per Klick und Ziehen auf dem Lineal (Bildraster)', async () => {
    const store = fill()
    const wrapper = mountView()
    await nextTick()
    const ruler = wrapper.get('[data-testid=timeline-ruler]').element
    ruler.dispatchEvent(pointer('pointerdown', { clientX: 251 }))
    // 251 px bei 100 px/s = 2,51 s -> nächstes Bild bei 25 fps = 2,52 s.
    expect(store.playhead).toBe(s(2.52))
    await nextTick()
    expect(wrapper.get('[data-testid=timeline-playhead]').attributes('style')).toBe('left: 348px;')

    ruler.dispatchEvent(pointer('pointermove', { clientX: 400, buttons: 1 }))
    expect(store.playhead).toBe(s(4))
    // Bewegen ohne gedrückte Taste ändert nichts.
    ruler.dispatchEvent(pointer('pointermove', { clientX: 900, buttons: 0 }))
    expect(store.playhead).toBe(s(4))
    wrapper.unmount()
  })

  it('markiert Clips: Klick ersetzt, Strg-Klick ergänzt, Klick auf die leere Spur hebt auf', async () => {
    const store = fill()
    const wrapper = mountView()
    await nextTick()
    const [first, second] = wrapper.findAll('.track')[0].findAll('.clip')
    first.element.dispatchEvent(pointer('pointerdown'))
    expect(store.selection).toEqual([first.attributes('data-clip')])
    second.element.dispatchEvent(pointer('pointerdown', { ctrlKey: true }))
    expect(store.selection).toHaveLength(2)
    await nextTick()
    expect(wrapper.findAll('.clip.selected')).toHaveLength(2)
    second.element.dispatchEvent(pointer('pointerdown', { ctrlKey: true }))
    expect(store.selection).toEqual([first.attributes('data-clip')])

    wrapper.find('.lane').element.dispatchEvent(pointer('pointerdown'))
    expect(store.selection).toEqual([])
    wrapper.unmount()
  })

  it('zoomt per Knopf und Strg+Mausrad, „Alles zeigen“ passt die Dauer ein', async () => {
    const store = fill()
    const wrapper = mountView()
    await nextTick()
    await wrapper.get('[aria-label="Vergrößern"]').trigger('click')
    expect(store.zoom).toBe(150)
    await wrapper.get('[aria-label="Verkleinern"]').trigger('click')
    expect(store.zoom).toBe(100)

    const scroller = wrapper.get('.scroller').element
    const plain = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true })
    scroller.dispatchEvent(plain)
    expect(store.zoom).toBe(100)
    expect(plain.defaultPrevented).toBe(false)
    const ctrl = new WheelEvent('wheel', {
      deltaY: -100,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    })
    scroller.dispatchEvent(ctrl)
    expect(store.zoom).toBe(150)
    expect(ctrl.defaultPrevented).toBe(true)

    // jsdom misst keine Breite -> Standard 800 px, davon 96 px Spurnamen.
    await wrapper.get('button.wide').trigger('click')
    expect(store.zoom).toBeCloseTo(((800 - 96) * 0.95) / 20, 5)
    wrapper.unmount()
  })

  it('macht rückgängig und wiederholt über die Werkzeugleiste', async () => {
    const store = fill()
    const wrapper = mountView()
    await nextTick()
    await wrapper.get('[aria-label="Rückgängig"]').trigger('click')
    expect(store.duration).toBe(s(10))
    await wrapper.get('[aria-label="Wiederholen"]').trigger('click')
    expect(store.duration).toBe(s(20))
    wrapper.unmount()
  })

  it('zeigt Vorschaubilder und Wellenform, sobald die Medienliste sie kennt', async () => {
    const store = fill()
    const pool = useMediaPoolStore()
    pool.items.push({
      key: 'k',
      name: 'a.mp4',
      size: 1,
      state: 'ready',
      progress: 1,
      error: null,
      media: {
        id: 'vid',
        name: 'a.mp4',
        size: 1,
        duration: 10,
        width: 1920,
        height: 1080,
        hasAudio: true,
        fps: 25,
      },
      prepare: 'done',
      derived: {
        peaks: { state: 'ready', rate: 50, count: 500 },
        strip: {
          state: 'ready',
          interval: 1,
          count: 10,
          columns: 10,
          tileWidth: 160,
          tileHeight: 90,
        },
        proxy: { state: 'ready', progress: 0, width: 960, height: 540 },
      },
      peaks: new Uint8Array(500).fill(100),
    })
    const wrapper = mountView()
    await nextTick()
    const video = wrapper.findAll('.track')[0].findAll('.clip')[0]
    // Spurhöhe 56 px -> Bilder 100 px breit, 1000 px Clip -> 10 Bilder.
    const thumbs = video.findAll('.thumb')
    expect(thumbs).toHaveLength(10)
    expect(thumbs[3].attributes('style')).toContain('left: 300px')
    expect(thumbs[3].attributes('style')).toContain('background-position: -300px 0px')
    expect(video.find('.label').text()).toBe('a.mp4')
    expect(wrapper.findAll('.track')[1].findAll('canvas')).toHaveLength(2)
    expect(store.doc.tracks[0].clips).toHaveLength(2)
    wrapper.unmount()
  })
})
