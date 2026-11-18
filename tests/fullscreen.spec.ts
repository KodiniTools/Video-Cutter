import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { useFullscreen } from '@/composables/useFullscreen'

/** jsdom kennt keine Fullscreen-API: einfache Nachbildung am document. */
function installFakeFullscreen(enabled = true) {
  let current: Element | null = null
  const fire = () => document.dispatchEvent(new Event('fullscreenchange'))
  Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: enabled })
  Object.defineProperty(document, 'fullscreenElement', {
    configurable: true,
    get: () => current,
  })
  const request = vi.fn(async function (this: Element) {
    // Die API hängt am Element: `this` ist das Element, das ins Vollbild geht.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    current = this
    fire()
  })
  const exit = vi.fn(async () => {
    current = null
    fire()
  })
  Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', {
    configurable: true,
    value: request,
  })
  Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exit })
  return {
    request,
    exit,
    /** Wie Esc: Der Browser beendet das Vollbild selbst. */
    browserExit: () => {
      current = null
      fire()
    },
  }
}

function removeFakeFullscreen() {
  for (const key of ['fullscreenEnabled', 'fullscreenElement', 'exitFullscreen']) {
    delete (document as unknown as Record<string, unknown>)[key]
  }
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).requestFullscreen
}

const Host = defineComponent({
  setup() {
    const el = ref<HTMLElement | null>(null)
    const fs = useFullscreen(el)
    return { el, ...fs }
  },
  render() {
    return h('div', { ref: 'el' }, [
      h('button', { onClick: this.toggle }, this.active ? 'aus' : 'an'),
    ])
  },
})

describe('useFullscreen', () => {
  afterEach(removeFakeFullscreen)

  describe('mit Fullscreen-API', () => {
    let fake: ReturnType<typeof installFakeFullscreen>
    beforeEach(() => {
      fake = installFakeFullscreen()
    })

    it('schaltet das eigene Element ein und wieder aus', async () => {
      const w = mount(Host, { attachTo: document.body })
      expect(w.vm.supported).toBe(true)
      expect(w.vm.active).toBe(false)

      await w.vm.toggle()
      await nextTick()
      expect(fake.request).toHaveBeenCalledTimes(1)
      expect(document.fullscreenElement).toBe(w.element)
      expect(w.vm.active).toBe(true)
      expect(w.text()).toBe('aus')

      await w.vm.toggle()
      await nextTick()
      expect(fake.exit).toHaveBeenCalledTimes(1)
      expect(w.vm.active).toBe(false)
      w.unmount()
    })

    it('folgt dem Browser, wenn Esc das Vollbild beendet', async () => {
      const w = mount(Host, { attachTo: document.body })
      await w.vm.toggle()
      expect(w.vm.active).toBe(true)
      fake.browserExit()
      await nextTick()
      expect(w.vm.active).toBe(false)
      w.unmount()
    })

    it('Ablehnung durch den Browser: kein Fehler, bleibt aus', async () => {
      fake.request.mockImplementationOnce(async () => {
        throw new TypeError('Permissions check failed')
      })
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const w = mount(Host, { attachTo: document.body })
      await expect(w.vm.toggle()).resolves.toBeUndefined()
      expect(w.vm.active).toBe(false)
      expect(warn).toHaveBeenCalled()
      warn.mockRestore()
      w.unmount()
    })
  })

  it('ohne Fullscreen-API: nicht unterstützt (Knopf bleibt verborgen)', () => {
    const w = mount(Host, { attachTo: document.body })
    expect(w.vm.supported).toBe(false)
    w.unmount()
  })

  it('Vollbild gesperrt (fullscreenEnabled false): nicht unterstützt', () => {
    installFakeFullscreen(false)
    const w = mount(Host, { attachTo: document.body })
    expect(w.vm.supported).toBe(false)
    w.unmount()
  })
})
