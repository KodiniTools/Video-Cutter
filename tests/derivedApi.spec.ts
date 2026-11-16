import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DERIVED_MEDIA_GONE,
  DERIVED_UNSUPPORTED,
  derivedBusy,
  derivedFailed,
  ensureDerived,
  fetchDerivedStatus,
  fetchPeaks,
  parseDerivedStatus,
  stripTileStyle,
} from '@/lib/derivedApi'
import { waveformBars } from '@/lib/waveform'

const ready = {
  peaks: { state: 'ready', rate: 50, count: 2244 },
  strip: { state: 'ready', interval: 1, count: 45, columns: 10, tileWidth: 160, tileHeight: 90 },
  proxy: { state: 'ready', width: 960, height: 540 },
}

describe('parseDerivedStatus', () => {
  it('übernimmt eine vollständige Antwort', () => {
    const s = parseDerivedStatus(ready)
    expect(s.peaks).toEqual({ state: 'ready', rate: 50, count: 2244 })
    expect(s.strip.columns).toBe(10)
    expect(s.proxy).toEqual({ state: 'ready', progress: 0, width: 960, height: 540 })
    expect(derivedBusy(s)).toBe(false)
    expect(derivedFailed(s)).toBe(false)
  })

  it('ist robust gegen fehlende oder unsinnige Werte', () => {
    const s = parseDerivedStatus({
      peaks: { state: 'quatsch', rate: -1 },
      strip: null,
      proxy: { state: 'running', progress: 250 },
    })
    expect(s.peaks).toEqual({ state: 'missing', rate: 0, count: 0 })
    expect(s.strip.state).toBe('missing')
    expect(s.proxy).toMatchObject({ state: 'running', progress: 100 })
    expect(derivedBusy(s)).toBe(true)
    expect(parseDerivedStatus(undefined).proxy.state).toBe('missing')
    expect(derivedFailed(parseDerivedStatus({ strip: { state: 'error' } }))).toBe(true)
  })
})

describe('stripTileStyle', () => {
  const strip = parseDerivedStatus(ready).strip

  it('rechnet Lage und Größe des Kachelbilds auf die Kastenbreite um', () => {
    // 45 Bilder, 10 Spalten -> 5 Zeilen; Kachel 160x90 auf 80 px Breite = Faktor 0,5.
    expect(stripTileStyle('abc', strip, 23, 80)).toEqual({
      backgroundImage: 'url("/api/media/abc/strip")',
      backgroundSize: '800px 225px',
      backgroundPosition: '-240px -90px',
    })
  })

  it('begrenzt den Index und liefert null, solange der Streifen fehlt', () => {
    expect(stripTileStyle('abc', strip, 999, 160)?.backgroundPosition).toBe('-640px -360px')
    expect(stripTileStyle('abc', strip, -5, 160)?.backgroundPosition).toBe('0px 0px')
    expect(stripTileStyle('abc', { ...strip, state: 'running' }, 0, 160)).toBeNull()
    expect(stripTileStyle('abc', parseDerivedStatus({}).strip, 0, 160)).toBeNull()
  })
})

describe('waveformBars', () => {
  it('nimmt je Balken den lautesten Wert', () => {
    expect(waveformBars(new Uint8Array([0, 255, 51, 0, 0, 102]), 3)).toEqual([1, 0.2, 0.4])
  })

  it('kommt mit mehr Balken als Werten und leeren Eingaben zurecht', () => {
    expect(waveformBars(new Uint8Array([255, 0]), 4)).toEqual([1, 1, 0, 0])
    expect(waveformBars(null, 10)).toEqual([])
    expect(waveformBars(new Uint8Array(0), 10)).toEqual([])
    expect(waveformBars(new Uint8Array([1]), 0)).toEqual([])
    expect(waveformBars(new Uint8Array([1]), Number.NaN)).toEqual([])
  })
})

describe('Server-Aufrufe', () => {
  afterEach(() => vi.unstubAllGlobals())

  const respond = (status: number, body: unknown) =>
    vi.fn(() =>
      Promise.resolve(
        new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
      ),
    )

  it('POST startet, GET fragt ab', async () => {
    const fetchMock = respond(202, ready)
    vi.stubGlobal('fetch', fetchMock)
    expect((await ensureDerived('a b')).proxy.state).toBe('ready')
    expect(fetchMock).toHaveBeenCalledWith('/api/media/a%20b/derived', {
      method: 'POST',
      signal: undefined,
    })
    await fetchDerivedStatus('x')
    expect(fetchMock).toHaveBeenLastCalledWith('/api/media/x/derived', { signal: undefined })
  })

  it('unterscheidet altes Backend, fehlendes Video und andere Fehler', async () => {
    vi.stubGlobal('fetch', respond(404, { error: 'Nicht gefunden.' }))
    await expect(ensureDerived('x')).rejects.toThrow(DERIVED_UNSUPPORTED)
    vi.stubGlobal('fetch', respond(404, '<html>'))
    await expect(ensureDerived('x')).rejects.toThrow(DERIVED_UNSUPPORTED)
    vi.stubGlobal('fetch', respond(404, { error: 'Video nicht gefunden.' }))
    await expect(fetchDerivedStatus('x')).rejects.toThrow(DERIVED_MEDIA_GONE)
    vi.stubGlobal('fetch', respond(500, {}))
    await expect(fetchDerivedStatus('x')).rejects.toThrow('Serverfehler (500).')
    vi.stubGlobal('fetch', respond(429, {}))
    await expect(fetchDerivedStatus('x')).rejects.toThrow('Zu viele Anfragen')
  })

  it('lädt die Wellenform als Bytes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(new Uint8Array([1, 2, 250])))),
    )
    expect([...(await fetchPeaks('x'))]).toEqual([1, 2, 250])
  })
})
