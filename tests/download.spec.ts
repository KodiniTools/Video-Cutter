import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  isAppleMobile,
  canShareFile,
  saveFile,
  hasSavePicker,
  saveUrlWithPicker,
} from '@/lib/download'

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const WINDOWS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'

function setUserAgent(ua: string): void {
  Object.defineProperty(globalThis.navigator, 'userAgent', {
    value: ua,
    configurable: true,
  })
}

beforeEach(() => {
  // Object-URL in jsdom stubben.
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: () => 'blob:mock',
    revokeObjectURL: () => {},
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('isAppleMobile', () => {
  it('erkennt iPhone', () => {
    setUserAgent(IPHONE_UA)
    expect(isAppleMobile()).toBe(true)
  })
  it('ist false auf Windows', () => {
    setUserAgent(WINDOWS_UA)
    expect(isAppleMobile()).toBe(false)
  })
})

describe('canShareFile', () => {
  it('false ohne navigator.canShare', () => {
    const file = new File([new Uint8Array([1])], 'a.mp4', { type: 'video/mp4' })
    expect(canShareFile(file)).toBe(false)
  })
  it('true wenn canShare/​share vorhanden und zustimmen', () => {
    ;(navigator as unknown as { canShare: unknown }).canShare = () => true
    ;(navigator as unknown as { share: unknown }).share = () => Promise.resolve()
    const file = new File([new Uint8Array([1])], 'a.mp4', { type: 'video/mp4' })
    expect(canShareFile(file)).toBe(true)
    delete (navigator as unknown as { canShare?: unknown }).canShare
    delete (navigator as unknown as { share?: unknown }).share
  })
})

describe('saveFile', () => {
  it('nutzt auf Nicht-Apple den Anker-Download (a.click)', async () => {
    setUserAgent(WINDOWS_UA)
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'video/mp4' })

    const ok = await saveFile({ blob, name: 'clip_cut.mp4' })

    expect(ok).toBe(true)
    expect(clickSpy).toHaveBeenCalledTimes(1)
  })

  it('nutzt auf iPhone den nativen Teilen-Dialog', async () => {
    setUserAgent(IPHONE_UA)
    const shareSpy = vi.fn().mockResolvedValue(undefined)
    ;(navigator as unknown as { canShare: unknown }).canShare = () => true
    ;(navigator as unknown as { share: unknown }).share = shareSpy
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'video/mp4' })

    const ok = await saveFile({ blob, name: 'clip_cut.mp4' })

    expect(ok).toBe(true)
    expect(shareSpy).toHaveBeenCalledTimes(1)
    expect(clickSpy).not.toHaveBeenCalled()

    delete (navigator as unknown as { canShare?: unknown }).canShare
    delete (navigator as unknown as { share?: unknown }).share
  })
})

describe('saveUrlWithPicker', () => {
  type PickerFn = (opts?: unknown) => Promise<unknown>
  function setPicker(fn: PickerFn | undefined): void {
    ;(window as unknown as { showSaveFilePicker?: PickerFn }).showSaveFilePicker = fn
  }
  afterEach(() => setPicker(undefined))

  it('meldet unsupported ohne Dialog (Firefox/Safari)', async () => {
    expect(hasSavePicker()).toBe(false)
    expect(await saveUrlWithPicker('/x', 'a.mp4')).toBe('unsupported')
  })

  it('öffnet den Dialog vor dem Laden und schreibt die Antwort in die Datei', async () => {
    const order: string[] = []
    const write = vi.fn().mockResolvedValue(undefined)
    const close = vi.fn().mockResolvedValue(undefined)
    const picker = vi.fn(async () => {
      order.push('picker')
      return { createWritable: async () => ({ write, close }) }
    })
    setPicker(picker)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        order.push('fetch')
        return new Response(new Blob([new Uint8Array([1, 2])]), { status: 200 })
      }),
    )

    expect(hasSavePicker()).toBe(true)
    expect(await saveUrlWithPicker('/api/cut/1/download', 'film.mp4')).toBe('saved')
    expect(order).toEqual(['picker', 'fetch'])
    expect(picker).toHaveBeenCalledWith({
      suggestedName: 'film.mp4',
      types: [{ description: 'Video', accept: { 'video/mp4': ['.mp4'] } }],
    })
    expect(write).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('lädt nichts, wenn der Nutzer abbricht', async () => {
    setPicker(() => Promise.reject(new DOMException('abort', 'AbortError')))
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    expect(await saveUrlWithPicker('/x', 'a.mp4')).toBe('cancelled')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('fällt ohne Nutzergeste (SecurityError) auf unsupported zurück', async () => {
    setPicker(() => Promise.reject(new DOMException('no gesture', 'SecurityError')))
    expect(await saveUrlWithPicker('/x', 'a.mp4')).toBe('unsupported')
  })

  it('bricht die Datei ab und wirft, wenn der Server einen Fehler liefert', async () => {
    const abort = vi.fn().mockResolvedValue(undefined)
    const close = vi.fn()
    setPicker(async () => ({ createWritable: async () => ({ write: vi.fn(), close, abort }) }))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('weg', { status: 404 })),
    )
    await expect(saveUrlWithPicker('/x', 'a.mp4')).rejects.toThrow('HTTP 404')
    expect(abort).toHaveBeenCalledTimes(1)
    expect(close).not.toHaveBeenCalled()
  })
})
