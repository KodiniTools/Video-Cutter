import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import LibraryRow from '@/components/LibraryRow.vue'
import { i18n } from '@/i18n'
import type { LibraryItem } from '@/stores/library'
import type { TimelineEntry } from '@/lib/mergeTimeline'
import { MEDIA_UNSUPPORTED } from '@/lib/mediaApi'

const file = new File([new Uint8Array([0])], 'intro.mp4', { type: 'video/mp4' })
const clip = (over: Partial<LibraryItem> = {}): LibraryItem => ({
  id: 1,
  mediaId: '00000000-0000-4000-8000-000000000001',
  file,
  name: 'intro.mp4',
  size: 1,
  duration: 10,
  width: 640,
  height: 360,
  hasAudio: true,
  fps: 25,
  start: 2,
  end: 6,
  at: null,
  include: true,
  status: 'ready',
  progress: 1,
  error: '',
  ...over,
})

function mountRow(c = clip(), disabled = false, selected = false) {
  return mount(LibraryRow, {
    props: { item: c, index: 1, selected, canUp: false, canDown: false, disabled },
    global: { plugins: [i18n] },
    attachTo: document.body,
  })
}

describe('LibraryRow – Vorschau', () => {
  const create = vi.fn(() => 'blob:clip')
  const revoke = vi.fn()

  beforeEach(() => {
    i18n.global.locale.value = 'de'
    create.mockClear()
    revoke.mockClear()
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }))
  })
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('zeigt das Vorschaubild am Startpunkt und gibt die Blob-URL beim Entfernen frei', () => {
    const w = mountRow()
    expect(create).toHaveBeenCalledTimes(1)
    expect(w.find('video.thumb').attributes('src')).toBe('blob:clip#t=2.000')
    w.unmount()
    expect(revoke).toHaveBeenCalledWith('blob:clip')
  })

  it('Vorschaubild folgt dem Startpunkt', async () => {
    const w = mountRow()
    await w.setProps({ item: clip({ start: 4.5 }) })
    expect(w.find('video.thumb').attributes('src')).toBe('blob:clip#t=4.500')
    // Keine neue Blob-URL für dieselbe Zeile.
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('Mini-Player: öffnet am Startpunkt, setzt Von/Bis auf die Wiedergabeposition', async () => {
    const w = mountRow()
    expect(w.find('video.player').exists()).toBe(false)
    await w.find('button.thumb-btn').trigger('click')
    await w.vm.$nextTick()
    const player = w.find('video.player')
    expect(player.exists()).toBe(true)
    const el = player.element as HTMLVideoElement
    expect(el.currentTime).toBe(2)

    el.currentTime = 3.25
    const [fromBtn, toBtn] = w.findAll('.preview-actions button')
    await fromBtn.trigger('click')
    el.currentTime = 7.5
    await toBtn.trigger('click')
    expect(w.emitted('start')).toEqual([[3.25]])
    expect(w.emitted('end')).toEqual([[7.5]])

    // „Bereich abspielen" springt an den Start und hält am Ende an.
    const play = vi.spyOn(el, 'play').mockImplementation(() => Promise.resolve())
    const pause = vi.spyOn(el, 'pause').mockImplementation(() => {})
    await w.findAll('.preview-actions button')[2].trigger('click')
    expect(play).toHaveBeenCalled()
    expect(el.currentTime).toBe(2)
    el.currentTime = 6.2
    await player.trigger('timeupdate')
    expect(pause).toHaveBeenCalled()
    expect(el.currentTime).toBe(6)

    await w.find('button.thumb-btn').trigger('click')
    expect(w.find('video.player').exists()).toBe(false)
  })

  it('gesperrt (busy): Von/Bis-Buttons deaktiviert', async () => {
    const w = mountRow(clip(), true)
    await w.find('button.thumb-btn').trigger('click')
    await w.vm.$nextTick()
    const btns = w.findAll('.preview-actions button')
    expect(btns[0].attributes('disabled')).toBeDefined()
    expect(btns[1].attributes('disabled')).toBeDefined()
  })

  it('neue Datei (Schnitt-Ergebnis) -> neue Blob-URL, alte wird freigegeben', async () => {
    create.mockReturnValueOnce('blob:a').mockReturnValueOnce('blob:b')
    const w = mountRow()
    const other = new File([new Uint8Array([1])], 'intro_cut.mp4', { type: 'video/mp4' })
    await w.setProps({ item: clip({ file: other, start: 0 }) })
    expect(w.find('video.thumb').attributes('src')).toBe('blob:b#t=0.000')
    expect(revoke).toHaveBeenCalledWith('blob:a')
  })
})

describe('LibraryRow – Aktionen und Status', () => {
  beforeEach(() => {
    i18n.global.locale.value = 'de'
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() }),
    )
  })

  it('Klick auf den Namen markiert, Häkchen und 🗑 melden sich', async () => {
    const w = mountRow(clip(), false, true)
    expect(w.classes()).toContain('selected')
    expect(w.find('button.info').attributes('aria-pressed')).toBe('true')
    await w.find('button.info').trigger('click')
    expect(w.emitted('select')).toHaveLength(1)
    await w.find('.include input').setValue(false)
    expect(w.emitted('include')).toEqual([[false]])
    await w.find('button.remove').trigger('click')
    expect(w.emitted('remove')).toHaveLength(1)
  })

  it('Von/Bis nur bei „Beim Zusammenfügen verwenden"', () => {
    expect(mountRow(clip()).find('.range').exists()).toBe(true)
    expect(
      mountRow(clip({ include: false }))
        .find('.range')
        .exists(),
    ).toBe(false)
  })

  it('Upload läuft: Fortschritt; Fehler: Meldung (altes Backend übersetzt) + erneut', async () => {
    const up = mountRow(clip({ status: 'uploading', progress: 0.42, mediaId: null }))
    expect(up.find('.upload-bar').attributes('aria-valuenow')).toBe('42')
    expect(up.text()).toContain('42 %')

    const err = mountRow(clip({ status: 'error', error: MEDIA_UNSUPPORTED, mediaId: null }))
    expect(err.find('.status.error').text()).toContain('Backend ist veraltet')
    await err.find('button.retry').trigger('click')
    expect(err.emitted('retry')).toHaveLength(1)
  })

  describe('Von/Bis im Gesamtvideo, „Clip ab"', () => {
    // Wie in der Meldung: Bild-Clip 0–5 s, danach Video 14,729 s lang.
    const video = (over: Partial<LibraryItem> = {}) =>
      clip({ duration: 14.729, start: 0, end: null, ...over })
    const entry = (over: Partial<TimelineEntry> = {}): TimelineEntry => ({
      start: 5,
      end: 19.729,
      used: 14.729,
      hold: 0,
      minStart: 0.05,
      ...over,
    })
    function mountWith(item = video(), e: TimelineEntry | null = entry(), first = false) {
      return mount(LibraryRow, {
        props: {
          item,
          index: 2,
          selected: false,
          canUp: true,
          canDown: false,
          disabled: false,
          entry: e,
          first,
        },
        global: { plugins: [i18n] },
      })
    }
    // setValue löst „input" und „change" aus (wie Verlassen des Feldes).
    const typeInto = (w: ReturnType<typeof mountWith>, which: 0 | 1, value: string) =>
      w.findAll('.range input')[which].setValue(value)
    const clipFrom = (w: ReturnType<typeof mountWith>) => w.find('.clip-from input')

    it('zeigt Von/Bis im Gesamtvideo; erster Clip: Von gesperrt', () => {
      const w = mountWith()
      const [from, to] = w.findAll('.range input')
      expect((from.element as HTMLInputElement).value).toBe('00:05.000')
      expect((to.element as HTMLInputElement).value).toBe('00:19.729')
      expect(from.attributes('disabled')).toBeUndefined()
      expect(
        mountWith(video(), entry({ start: 0 }), true)
          .find('.range input')
          .attributes('disabled'),
      ).toBeDefined()
    })

    it('Von setzt die Position im Gesamtvideo (auch „mm:ss:mmm"); leer = direkt danach', async () => {
      const w = mountWith()
      await typeInto(w, 0, '00:06:000')
      await typeInto(w, 0, '')
      expect(w.emitted('at')).toEqual([[6], [null]])
      expect(w.find('.range-note').exists()).toBe(false)
    })

    it('Bis im Gesamtvideo wird in das Ende im Clip umgerechnet', async () => {
      const w = mountWith(video({ start: 2 }), entry({ start: 5, end: 17.729, used: 12.729 }))
      await typeInto(w, 1, '00:10.000')
      // 2 s im Clip + (10 − 5) s = 7 s im Clip
      expect(w.emitted('end')).toEqual([[7]])
    })

    it('Bis 00:19:729 passt genau (5 s + 14,729 s), kein Hinweis', async () => {
      const w = mountWith()
      await typeInto(w, 1, '00:19:729')
      expect(w.emitted('end')![0][0]).toBeCloseTo(14.729, 6)
      expect(w.find('.range-note').exists()).toBe(false)
    })

    it('Bis hinter dem Clip-Ende: Hinweis und auf das Clip-Ende begrenzt', async () => {
      const w = mountWith()
      await typeInto(w, 1, '00:25.000')
      expect(w.emitted('end')![0][0]).toBeCloseTo(14.729, 6)
      const note = w.find('.range-note').text()
      expect(note).toContain('00:25.000')
      expect(note).toContain('00:19.729')
    })

    it('Bis vor Von, Von vor dem vorigen Clip und ungültige Zeiten werden gemeldet', async () => {
      const w = mountWith(video(), entry({ minStart: 0.05 }))
      await typeInto(w, 1, '00:04.000')
      expect(w.find('.range-note').text()).toContain('00:05.000')
      await typeInto(w, 0, '00:19:72')
      expect(w.find('.range-note').text()).toContain('00:19:72')
      const w2 = mountWith(video(), entry({ minStart: 2.05 }))
      await typeInto(w2, 0, '1')
      expect(w2.emitted('at')).toEqual([[1]])
      expect(w2.find('.range-note').text()).toContain('00:02.050')
    })

    it('„Clip ab" kürzt den Anfang (Zeit im Clip)', async () => {
      const w = mountWith()
      await clipFrom(w).setValue('00:03.500')
      expect(w.emitted('start')).toEqual([[3.5]])
      await clipFrom(w).setValue('20')
      expect(w.find('.range-note').text()).toContain('00:14.729')
    })

    it('Hinweis auf Standbild bzw. Abschneiden durch den nächsten Clip', () => {
      expect(
        mountWith(video(), entry({ hold: 1 }))
          .find('.entry-info')
          .text(),
      ).toContain('00:01.000')
      expect(
        mountWith(video(), entry({ used: 10, end: 15 }))
          .find('.entry-info')
          .text(),
      ).toContain('00:15.000')
      expect(mountWith().find('.entry-info').exists()).toBe(false)
    })

    it('↺ setzt zurück und löscht den Hinweis; aktiv auch, wenn nur Von gesetzt ist', async () => {
      const w = mountWith(video({ at: 6 }))
      const reset = w.find('.range button')
      expect(reset.attributes('disabled')).toBeUndefined()
      await typeInto(w, 0, 'abc')
      expect(w.find('.range-note').exists()).toBe(true)
      await reset.trigger('click')
      expect(w.emitted('reset')).toHaveLength(1)
      expect(w.find('.range-note').exists()).toBe(false)
    })

    it('ohne Lage (Länge unbekannt) sind Von/Bis gesperrt', () => {
      const inputs = mountWith(video(), null).findAll('.range input')
      expect(inputs.every((i) => i.attributes('disabled') !== undefined)).toBe(true)
    })
  })
})
