import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@/i18n'
import MergePreviewDialog from '@/components/MergePreviewDialog.vue'

function mountDialog(props: { src: string | null; mergeDisabled?: boolean }) {
  return mount(MergePreviewDialog, { props, global: { plugins: [i18n] } })
}

// jsdom kennt kein Abspielen.
vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})

describe('MergePreviewDialog', () => {
  it('ohne src geschlossen und ohne Video', () => {
    const w = mountDialog({ src: null })
    expect(w.find('dialog').attributes('open')).toBeUndefined()
    expect(w.find('video').exists()).toBe(false)
  })

  it('mit src offen, spielt die Vorschau und meldet Schließen/Zusammenfügen', async () => {
    const w = mountDialog({ src: 'blob:vorschau' })
    expect(w.find('dialog').attributes('open')).toBeDefined()
    expect(w.find('video').attributes('src')).toBe('blob:vorschau')
    const [close, merge] = w.findAll('.actions button')
    await close.trigger('click')
    await merge.trigger('click')
    expect(w.emitted('close')).toHaveLength(1)
    expect(w.emitted('merge')).toHaveLength(1)
  })

  it('Zusammenfügen lässt sich sperren; src = null schließt wieder', async () => {
    const w = mountDialog({ src: 'blob:x', mergeDisabled: true })
    expect(w.find('.actions .primary').attributes('disabled')).toBeDefined()
    await w.setProps({ src: null })
    expect(w.find('dialog').attributes('open')).toBeUndefined()
  })
})
