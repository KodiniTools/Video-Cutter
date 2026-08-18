import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { isAppleMobile, canShareFile, saveFile } from '@/lib/download'

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
