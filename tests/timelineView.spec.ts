import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { i18n } from '@/i18n'
import TimelineView from '@/components/timeline/TimelineView.vue'
import { useMediaPoolStore } from '@/stores/mediaPool'
import { useTimelineStore } from '@/stores/timeline'
import { secondsToTime as s, type Clip } from '@/timeline/model'

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
    expect(wrapper.get('[data-testid=timeline-playhead]').attributes('style')).toBe('left: 402px;')

    ruler.dispatchEvent(pointer('pointermove', { clientX: 400, buttons: 1 }))
    expect(store.playhead).toBe(s(4))
    // Bewegen ohne gedrückte Taste ändert nichts.
    ruler.dispatchEvent(pointer('pointermove', { clientX: 900, buttons: 0 }))
    expect(store.playhead).toBe(s(4))
    wrapper.unmount()
  })

  it('markiert Clips samt verknüpftem Ton: Klick ersetzt, Strg-Klick ergänzt, leere Spur hebt auf', async () => {
    const store = fill()
    const wrapper = mountView()
    await nextTick()
    const [first, second] = wrapper.findAll('.track')[0].findAll('.clip')
    const firstAudio = wrapper.findAll('.track')[1].findAll('.clip')[0]
    first.element.dispatchEvent(pointer('pointerdown'))
    window.dispatchEvent(pointer('pointerup'))
    expect(store.selection).toEqual([
      first.attributes('data-clip'),
      firstAudio.attributes('data-clip'),
    ])
    second.element.dispatchEvent(pointer('pointerdown', { ctrlKey: true }))
    expect(store.selection).toHaveLength(4)
    await nextTick()
    expect(wrapper.findAll('.clip.selected')).toHaveLength(4)
    second.element.dispatchEvent(pointer('pointerdown', { ctrlKey: true }))
    expect(store.selection).toHaveLength(2)

    wrapper.find('.lane').element.dispatchEvent(pointer('pointerdown'))
    expect(store.selection).toEqual([])
    wrapper.unmount()
  })

  it('zieht einen Clip samt Ton, rastet ein und zählt als ein Schritt', async () => {
    const store = fill()
    const wrapper = mountView()
    await nextTick()
    const starts = () => store.doc.tracks.map((tr) => tr.clips.map((c) => c.start))
    const second = wrapper.findAll('.track')[0].findAll('.clip')[1]
    second.element.dispatchEvent(pointer('pointerdown', { clientX: 1100 }))
    // Unter der Schwelle: nur markiert, nichts bewegt.
    window.dispatchEvent(pointer('pointermove', { clientX: 1102 }))
    expect(starts()).toEqual([
      [0, s(10)],
      [0, s(10)],
    ])
    window.dispatchEvent(pointer('pointermove', { clientX: 1400 }))
    window.dispatchEvent(pointer('pointermove', { clientX: 1612 }))
    // +512 px = 5,12 s bei 100 px/s, auf dem 25-fps-Raster.
    expect(starts()).toEqual([
      [0, s(15.12)],
      [0, s(15.12)],
    ])
    // Zurück in die Nähe des ersten Clips: rastet an dessen Ende ein; belegte Stelle wird abgelehnt.
    window.dispatchEvent(pointer('pointermove', { clientX: 1105 }))
    expect(starts()[0]).toEqual([0, s(10)])
    window.dispatchEvent(pointer('pointermove', { clientX: 800 }))
    expect(starts()[0]).toEqual([0, s(10)])
    window.dispatchEvent(pointer('pointermove', { clientX: 1300 }))
    window.dispatchEvent(pointer('pointerup'))
    expect(starts()[0]).toEqual([0, s(12)])
    store.undo()
    expect(starts()).toEqual([
      [0, s(10)],
      [0, s(10)],
    ])
    wrapper.unmount()
  })

  it('trimmt an den Griffen bis zu den Grenzen von Quelle und Nachbarn', async () => {
    const store = fill()
    const wrapper = mountView()
    await nextTick()
    const video = () => store.doc.tracks[0].clips.map((c) => [c.start, c.duration])
    const first = wrapper.findAll('.track')[0].findAll('.clip')[0]
    first.get('.handle.end').element.dispatchEvent(pointer('pointerdown', { clientX: 1000 }))
    window.dispatchEvent(pointer('pointermove', { clientX: 700 }))
    expect(video()[0]).toEqual([0, s(7)])
    // Über die Quelle hinaus (10 s) bzw. in den Nachbarn hinein geht es nicht.
    window.dispatchEvent(pointer('pointermove', { clientX: 1500 }))
    expect(video()[0]).toEqual([0, s(10)])
    window.dispatchEvent(pointer('pointermove', { clientX: 600 }))
    window.dispatchEvent(pointer('pointerup'))
    expect(video()[0]).toEqual([0, s(6)])
    // Der verknüpfte Ton bleibt unberührt (versetzte Schnitte möglich).
    expect(store.doc.tracks[1].clips[0].duration).toBe(s(10))

    first.get('.handle.start').element.dispatchEvent(pointer('pointerdown', { clientX: 0 }))
    window.dispatchEvent(pointer('pointermove', { clientX: 200 }))
    window.dispatchEvent(pointer('pointerup'))
    expect(video()[0]).toEqual([s(2), s(4)])
    expect((store.doc.tracks[0].clips[0] as { sourceIn: number }).sourceIn).toBe(s(2))
    store.undo()
    store.undo()
    expect(video()[0]).toEqual([0, s(10)])
    wrapper.unmount()
  })

  it('teilt und löscht per Knopf und Tastatur, Esc bricht das Ziehen ab', async () => {
    const store = fill()
    const wrapper = mountView()
    await nextTick()
    const count = () => store.doc.tracks.map((tr) => tr.clips.length)
    const key = (k: string, init: KeyboardEventInit = {}) =>
      wrapper.element.dispatchEvent(
        new KeyboardEvent('keydown', { key: k, bubbles: true, ...init }),
      )

    // Ohne Auswahl teilt „Teilen“ alles unter dem Abspielkopf.
    expect(wrapper.get('[data-testid=timeline-split]').attributes('disabled')).toBeDefined()
    store.seek(s(4))
    await nextTick()
    await wrapper.get('[data-testid=timeline-split]').trigger('click')
    expect(count()).toEqual([3, 3])
    key('z', { ctrlKey: true })
    expect(count()).toEqual([2, 2])
    key('s')
    expect(count()).toEqual([3, 3])

    // Erstes Stück markieren und mit Lücke löschen, dann mit Nachrücken.
    const first = wrapper.findAll('.track')[0].findAll('.clip')[0]
    first.element.dispatchEvent(pointer('pointerdown'))
    window.dispatchEvent(pointer('pointerup'))
    key('Delete')
    expect(store.doc.tracks[0].clips.map((c) => c.start)).toEqual([s(4), s(10)])
    key('z', { ctrlKey: true })
    store.selectClip(store.doc.tracks[0].clips[0].id)
    await nextTick()
    await wrapper.get('[data-testid=timeline-ripple-delete]').trigger('click')
    expect(store.doc.tracks.map((tr) => tr.clips.map((c) => c.start))).toEqual([
      [0, s(6)],
      [0, s(6)],
    ])

    // Abspielkopf bildweise, Anfang/Ende.
    key('End')
    expect(store.playhead).toBe(s(16))
    key('ArrowLeft')
    expect(store.playhead).toBe(s(15.96))
    key('ArrowRight', { shiftKey: true })
    expect(store.playhead).toBe(s(16.96))
    key('Home')
    expect(store.playhead).toBe(0)

    // Esc während des Ziehens stellt den Stand vom Beginn wieder her.
    const last = wrapper.findAll('.track')[0].findAll('.clip')[1]
    last.element.dispatchEvent(pointer('pointerdown', { clientX: 700 }))
    window.dispatchEvent(pointer('pointermove', { clientX: 1200 }))
    expect(store.doc.tracks[0].clips[1].start).toBe(s(11))
    const undoable = store.canUndo
    key('Escape')
    expect(store.doc.tracks[0].clips[1].start).toBe(s(6))
    window.dispatchEvent(pointer('pointermove', { clientX: 1300 }))
    expect(store.doc.tracks[0].clips[1].start).toBe(s(6))
    expect(store.canUndo).toBe(undoable)

    // Ohne Clip unter dem Abspielkopf: Hinweis statt Wirkung.
    store.select([])
    store.seek(s(30))
    key('s')
    await nextTick()
    expect(wrapper.text()).toContain('Unter dem Abspielkopf liegt kein Clip')
    wrapper.unmount()
  })

  it('verwaltet Spuren: anlegen, umbenennen, verschieben, sperren, stumm, entfernen', async () => {
    const store = fill()
    const wrapper = mountView()
    await nextTick()
    const names = () => wrapper.findAll('.track .track-name').map((n) => n.text())
    await wrapper.get('[data-testid=timeline-add-video]').trigger('click')
    await wrapper.get('[data-testid=timeline-add-audio]').trigger('click')
    expect(names()).toEqual(['V2', 'V1', 'A1', 'A2'])
    // „+ Ebene“: leere Ebene oben, als Ziel markiert; 🎯 hebt das Ziel auf.
    await wrapper.get('[data-testid=timeline-add-overlay]').trigger('click')
    expect(names()).toEqual(['E1', 'V2', 'V1', 'A1', 'A2'])
    const target = () => wrapper.findAll('.track')[0].get('[data-action=target]')
    expect(target().attributes('aria-pressed')).toBe('true')
    expect(wrapper.findAll('.track')[0].attributes('data-target')).toBe('true')
    await target().trigger('click')
    expect(store.activeOverlayTarget).toBeNull()
    expect(target().attributes('aria-pressed')).toBe('false')
    expect(wrapper.findAll('.track')[1].find('[data-action=target]').exists()).toBe(false)
    store.undo()
    await nextTick()
    expect(names()).toEqual(['V2', 'V1', 'A1', 'A2'])

    // Umbenennen per Doppelklick; Esc verwirft, Enter übernimmt.
    const first = () => wrapper.findAll('.track')[0]
    await first().get('.track-name').trigger('dblclick')
    await first().get('.name-input').setValue('Verworfen')
    await first().get('.name-input').trigger('keydown', { key: 'Escape' })
    expect(names()[0]).toBe('V2')
    await first().get('.track-name').trigger('dblclick')
    await first().get('.name-input').setValue('  Titel  ')
    // Tippen im Namensfeld löst keine Timeline-Kürzel aus (S = Teilen).
    store.seek(s(4))
    await first().get('.name-input').trigger('keydown', { key: 's' })
    expect(store.doc.tracks[1].clips).toHaveLength(2)
    await first().get('.name-input').trigger('keydown', { key: 'Enter' })
    expect(names()[0]).toBe('Titel')

    // Verschieben: oberste Spur kann nicht weiter nach oben.
    expect(first().get('[aria-label="Titel nach oben"]').attributes('disabled')).toBeDefined()
    await first().get('[aria-label="Titel nach unten"]').trigger('click')
    expect(names()).toEqual(['V1', 'Titel', 'A1', 'A2'])

    // Sperren: keine Griffe mehr, Ziehen wirkungslos, Entfernen gesperrt.
    const v1 = () => wrapper.findAll('.track')[0]
    await v1().get('[data-action=lock]').trigger('click')
    expect(v1().attributes('data-locked')).toBe('true')
    expect(v1().find('.handle').exists()).toBe(false)
    expect(v1().get('[data-action=remove]').attributes('disabled')).toBeDefined()
    v1()
      .findAll('.clip')[1]
      .element.dispatchEvent(pointer('pointerdown', { clientX: 1100 }))
    window.dispatchEvent(pointer('pointermove', { clientX: 1500 }))
    window.dispatchEvent(pointer('pointerup'))
    expect(store.doc.tracks[0].clips[1].start).toBe(s(10))
    await v1().get('[data-action=lock]').trigger('click')

    // Stumm/Ausblenden je nach Spur-Art.
    const a1 = () => wrapper.findAll('.track')[2]
    expect(a1().find('[data-action=hide]').exists()).toBe(false)
    await a1().get('[data-action=mute]').trigger('click')
    expect(a1().attributes('data-off')).toBe('true')
    expect(store.doc.tracks[2]).toMatchObject({ muted: true })
    await v1().get('[data-action=hide]').trigger('click')
    expect(store.doc.tracks[0]).toMatchObject({ hidden: true })

    // Entfernen samt Clips, rückgängig machbar.
    await a1().get('[data-action=remove]').trigger('click')
    expect(names()).toEqual(['V1', 'Titel', 'A2'])
    // Der Knopf ist mit der Spur verschwunden: Die Tastatur bleibt bei der Timeline.
    await nextTick()
    expect(document.activeElement).toBe(wrapper.element)
    wrapper.element.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }),
    )
    await nextTick()
    expect(names()).toEqual(['V1', 'Titel', 'A1', 'A2'])
    expect(store.doc.tracks[2].clips).toHaveLength(2)
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

    // jsdom misst keine Breite -> Standard 800 px, davon 150 px Spurnamen.
    await wrapper.get('[data-testid=timeline-fit]').trigger('click')
    expect(store.zoom).toBeCloseTo(((800 - 150) * 0.95) / 20, 5)
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

  it('Galerie „+ Form / Emoji“: Formen, Symbole und Emojis als Kacheln', async () => {
    const store = useTimelineStore()
    const wrapper = mountView()
    await nextTick()
    const toggle = wrapper.get('[data-testid=timeline-add-graphic]')
    const gallery = () => wrapper.find('[data-testid=graphic-gallery]')
    expect(gallery().exists()).toBe(false)
    await toggle.trigger('click')
    expect(gallery().findAll('.pick[data-pick]')).toHaveLength(5 + 8 + 24)

    // Symbol: gleich das gewählte Symbol, Galerie schließt, Clip ist markiert.
    await gallery().get('[data-pick="symbol:star"]').trigger('click')
    expect(gallery().exists()).toBe(false)
    const clips = () => store.doc.tracks.flatMap((t): Clip[] => t.clips)
    expect(clips()[0]).toMatchObject({ kind: 'graphic', data: { kind: 'symbol', symbol: 'star' } })
    expect(store.selection).toEqual([clips()[0].id])

    // Form und Emoji aus der Schnellauswahl.
    store.seek(s(4))
    await toggle.trigger('click')
    await gallery().get('[data-pick=arrow]').trigger('click')
    store.seek(s(8))
    await toggle.trigger('click')
    await gallery().get('[data-pick="emoji:🔥"]').trigger('click')
    expect(clips().map((c) => (c.kind === 'graphic' ? c.data.kind : ''))).toEqual([
      'symbol',
      'arrow',
      'emoji',
    ])
    expect(clips()[2]).toMatchObject({ data: { emoji: '🔥' } })

    // Eigenes Emoji; Tippen löst keine Timeline-Kürzel aus, Esc schließt nur die Galerie.
    store.seek(s(12))
    await toggle.trigger('click')
    const field = gallery().get('[data-testid=graphic-gallery-emoji]')
    await field.setValue(' 🦊 ')
    await field.trigger('keydown', { key: 'm' })
    expect(store.doc.markers).toHaveLength(0)
    await field.trigger('keydown', { key: 'Enter' })
    expect(clips()[3]).toMatchObject({ data: { kind: 'emoji', emoji: '🦊' } })
    await toggle.trigger('click')
    await gallery().trigger('keydown', { key: 'Escape' })
    expect(gallery().exists()).toBe(false)
    expect(clips()).toHaveLength(4)

    // Ein Schritt je Element im Verlauf.
    store.undo()
    expect(clips()).toHaveLength(3)
    wrapper.unmount()
  })
})
