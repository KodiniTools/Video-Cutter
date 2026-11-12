import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import AppendClipRow from '@/components/AppendClipRow.vue'
import { i18n } from '@/i18n'
import type { AppendClip } from '@/stores/videoEditor'

const clip = (over: Partial<AppendClip> = {}): AppendClip => ({
  id: 1,
  file: new File([new Uint8Array([0])], 'intro.mp4', { type: 'video/mp4' }),
  duration: 10,
  start: 2,
  end: 6,
  position: 'after',
  slot: null,
  ...over,
})

function mountRow(c = clip(), disabled = false) {
  return mount(AppendClipRow, {
    props: { clip: c, index: 1, canUp: false, canDown: false, disabled },
    global: { plugins: [i18n] },
    attachTo: document.body,
  })
}

describe('AppendClipRow – Vorschau', () => {
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
    await w.setProps({ clip: clip({ start: 4.5 }) })
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
})
