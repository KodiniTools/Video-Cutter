import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import VoiceRecorder from '@/components/timeline/VoiceRecorder.vue'
import { i18n } from '@/i18n'
import { encodeWav, mixToMono } from '@/lib/wav'
import type { MediaView } from '@/lib/mediaApi'
import { useMediaPoolStore } from '@/stores/mediaPool'
import { useTimelineStore } from '@/stores/timeline'
import {
  addTrack,
  appendMedia,
  createDoc,
  insertAudioAt,
  putAsset,
  updateTrack,
  validateDoc,
  type AssetRef,
  type Clip,
  type OpResult,
  type TimelineDoc,
} from '@/timeline/model'

vi.mock('@/lib/voiceRecording', () => ({
  RECORDING_TOO_SHORT: 'RECORDING_TOO_SHORT',
  canRecord: vi.fn(() => true),
  recordingToWav: vi.fn(async (_blob: Blob, name: string) => new File(['x'], name)),
}))
import { canRecord, recordingToWav } from '@/lib/voiceRecording'

const S = 1_000_000
const video = (id: string, seconds = 10): AssetRef => ({
  id,
  kind: 'video',
  name: `${id}.mp4`,
  duration: seconds * S,
  width: 1280,
  height: 720,
  fps: 25,
  hasAudio: true,
})
const sound = (id: string, seconds = 4): AssetRef => ({
  id,
  kind: 'audio',
  name: `${id}.wav`,
  duration: seconds * S,
  hasAudio: true,
})
const must = (r: OpResult): TimelineDoc => {
  if (!r.ok) throw new Error(r.error)
  return r.doc
}
/** Je Ton-Spur: `[Name, [Medium, Beginn in s] …]`. */
const audioLanes = (doc: TimelineDoc) =>
  doc.tracks
    .filter((t) => t.kind === 'audio')
    .map((t) => [t.name, ...t.clips.map((c) => [c.asset, c.start / S])])

describe('WAV', () => {
  it('mischt Kanäle zu einem', () => {
    const one = new Float32Array([0.5, -0.5])
    expect(mixToMono([one])).toBe(one)
    expect([...mixToMono([new Float32Array([1, 0]), new Float32Array([0, -1])])]).toEqual([
      0.5, -0.5,
    ])
    expect(mixToMono([])).toHaveLength(0)
  })

  it('schreibt Kopf und 16-Bit-Werte, begrenzt Übersteuerung', () => {
    const view = new DataView(encodeWav(new Float32Array([0, 1, -1, 2, -0.5]), 48000))
    const text = (at: number) =>
      String.fromCharCode(...[0, 1, 2, 3].map((i) => view.getUint8(at + i)))
    expect([text(0), text(8), text(12), text(36)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data'])
    expect(view.byteLength).toBe(44 + 10)
    expect(view.getUint32(4, true)).toBe(36 + 10)
    expect([view.getUint16(20, true), view.getUint16(22, true)]).toEqual([1, 1])
    expect([view.getUint32(24, true), view.getUint32(28, true)]).toEqual([48000, 96000])
    expect(view.getUint32(40, true)).toBe(10)
    expect([0, 1, 2, 3, 4].map((i) => view.getInt16(44 + i * 2, true))).toEqual([
      0, 32767, -32768, 32767, -16384,
    ])
  })
})

describe('insertAudioAt', () => {
  const base = () => {
    let doc = putAsset(putAsset(putAsset(createDoc(), video('v')), sound('musik', 20)), sound('r'))
    doc = must(appendMedia(doc, 'v'))
    return must(appendMedia(doc, 'musik'))
  }

  it('legt die Aufnahme auf eine neue Ton-Spur, wenn die Musik-Spur dort belegt ist', () => {
    const doc = must(insertAudioAt(base(), 'r', 3 * S))
    expect(audioLanes(doc)).toEqual([
      ['A1', ['v', 0]],
      ['A2', ['musik', 0]],
      ['A3', ['r', 3]],
    ])
    expect(validateDoc(doc)).toEqual([])
    // Die zweite Aufnahme nutzt dieselbe Spur, solange die Stelle frei ist.
    const two = must(insertAudioAt(putAsset(doc, sound('r2')), 'r2', 7 * S))
    expect(audioLanes(two)[2]).toEqual(['A3', ['r', 3], ['r2', 7]])
    // Überlappt sie, entsteht eine weitere Spur.
    const three = must(insertAudioAt(putAsset(doc, sound('r2')), 'r2', 5 * S))
    expect(audioLanes(three)[3]).toEqual(['A4', ['r2', 5]])
  })

  it('nutzt eine freie Stelle hinter der Musik, aber keine abgesenkte oder gesperrte Spur', () => {
    const doc = base()
    expect(audioLanes(must(insertAudioAt(doc, 'r', 20 * S)))[1]).toEqual([
      'A2',
      ['musik', 0],
      ['r', 20],
    ])
    const music = doc.tracks.find((t) => t.name === 'A2')!
    const ducked = must(updateTrack(doc, music.id, { duck: 0.7 }))
    expect(audioLanes(must(insertAudioAt(ducked, 'r', 20 * S)))[2]).toEqual(['A3', ['r', 20]])
    const locked = must(updateTrack(doc, music.id, { locked: true }))
    expect(audioLanes(must(insertAudioAt(locked, 'r', 20 * S)))[2]).toEqual(['A3', ['r', 20]])
  })

  it('nutzt eine leere Ton-Spur, nicht die Ton-Spur der Videos', () => {
    const doc = must(addTrack(base(), { id: 'leer', kind: 'audio', name: 'Sprache' }, 99))
    expect(audioLanes(must(insertAudioAt(doc, 'r', 12 * S)))).toEqual([
      ['A1', ['v', 0]],
      ['A2', ['musik', 0]],
      ['Sprache', ['r', 12]],
    ])
  })

  it('lehnt Unbekanntes, Videos und ungültige Zeiten ab', () => {
    const doc = base()
    expect(insertAudioAt(doc, 'x', 0)).toMatchObject({ ok: false, error: 'asset-not-found' })
    expect(insertAudioAt(doc, 'v', 0)).toMatchObject({ ok: false, error: 'kind-mismatch' })
    expect(insertAudioAt(doc, 'r', -1)).toMatchObject({ ok: false, error: 'invalid-time' })
    expect(insertAudioAt(doc, 'r', 1.5)).toMatchObject({ ok: false, error: 'invalid-time' })
  })
})

describe('Store', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('insertAudioAt markiert den neuen Clip und ist ein Rückgängig-Schritt', () => {
    const store = useTimelineStore()
    store.putAsset(video('v'))
    store.putAsset(sound('r'))
    store.appendMedia('v')
    expect(store.insertAudioAt('r', 2 * S)).toBe(true)
    const clip = store.doc.tracks.flatMap((t): Clip[] => t.clips).find((c) => c.asset === 'r')
    expect(clip?.start).toBe(2 * S)
    expect(store.selection).toEqual([clip?.id])
    store.undo()
    expect(store.doc.tracks.flatMap((t): Clip[] => t.clips).some((c) => c.asset === 'r')).toBe(
      false,
    )
    expect(store.insertAudioAt('fehlt', 0)).toBe(false)
  })
})

describe('VoiceRecorder', () => {
  class FakeRecorder {
    static last: FakeRecorder | null = null
    state = 'inactive'
    mimeType = 'audio/webm'
    ondataavailable: ((e: { data: Blob }) => void) | null = null
    onstop: (() => void) | null = null
    onerror: (() => void) | null = null
    constructor(public stream: unknown) {
      FakeRecorder.last = this
    }
    start() {
      this.state = 'recording'
    }
    stop() {
      this.state = 'inactive'
      this.ondataavailable?.({ data: new Blob(['abc']) })
      this.onstop?.()
    }
  }
  const stopTrack = vi.fn()
  const getUserMedia = vi.fn()

  beforeEach(() => {
    setActivePinia(createPinia())
    stopTrack.mockClear()
    getUserMedia.mockReset()
    getUserMedia.mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] })
    vi.mocked(canRecord).mockReturnValue(true)
    vi.mocked(recordingToWav).mockClear()
    vi.stubGlobal('MediaRecorder', FakeRecorder)
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  const render = () => mount(VoiceRecorder, { global: { plugins: [i18n] } })
  const media: MediaView = {
    id: 'm1',
    name: 'Aufnahme.wav',
    size: 10,
    duration: 2,
    width: 0,
    height: 0,
    fps: 0,
    hasAudio: true,
    kind: 'audio',
  } as MediaView

  it('nimmt auf, lädt hoch und legt die Aufnahme an die Stelle des Abspielkopfs beim Start', async () => {
    const timeline = useTimelineStore()
    const pool = useMediaPoolStore()
    const add = vi.spyOn(pool, 'add').mockImplementation(() => {})
    timeline.putAsset(video('v'))
    timeline.appendMedia('v')
    timeline.seek(3 * S)
    const w = render()
    await w.get('[data-testid=voice-start]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid=voice-stop]').exists()).toBe(true)
    // Der Abspielkopf wandert während der Aufnahme weiter.
    timeline.seek(6 * S)
    await w.get('[data-testid=voice-stop]').trigger('click')
    await flushPromises()
    expect(stopTrack).toHaveBeenCalled()
    expect(recordingToWav).toHaveBeenCalledTimes(1)
    expect(add).toHaveBeenCalledTimes(1)
    const [files, onReady] = add.mock.calls[0]
    expect(files[0].name).toMatch(/^Aufnahme \d\d-\d\d-\d\d\.wav$/)
    timeline.putAsset({ ...sound('m1', 2) })
    onReady?.(media)
    const clip = timeline.doc.tracks.flatMap((t): Clip[] => t.clips).find((c) => c.asset === 'm1')
    expect(clip?.start).toBe(3 * S)
    expect(w.find('[data-testid=voice-start]').exists()).toBe(true)
  })

  it('Verwerfen lädt nichts hoch', async () => {
    const add = vi.spyOn(useMediaPoolStore(), 'add').mockImplementation(() => {})
    const w = render()
    await w.get('[data-testid=voice-start]').trigger('click')
    await flushPromises()
    await w.get('[data-testid=voice-discard]').trigger('click')
    await flushPromises()
    expect(add).not.toHaveBeenCalled()
    expect(recordingToWav).not.toHaveBeenCalled()
    expect(stopTrack).toHaveBeenCalled()
    expect(w.find('[data-testid=voice-start]').exists()).toBe(true)
  })

  it('meldet verweigertes Mikrofon, zu kurze Aufnahme und fehlende Unterstützung', async () => {
    const add = vi.spyOn(useMediaPoolStore(), 'add').mockImplementation(() => {})
    getUserMedia.mockRejectedValueOnce(
      Object.assign(new Error('nein'), { name: 'NotAllowedError' }),
    )
    const w = render()
    await w.get('[data-testid=voice-start]').trigger('click')
    await flushPromises()
    expect(w.get('[data-testid=voice-error]').text()).toContain('nicht erlaubt')

    vi.mocked(recordingToWav).mockRejectedValueOnce(new Error('RECORDING_TOO_SHORT'))
    await w.get('[data-testid=voice-start]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid=voice-error]').exists()).toBe(false)
    await w.get('[data-testid=voice-stop]').trigger('click')
    await flushPromises()
    expect(w.get('[data-testid=voice-error]').text()).toContain('zu kurz')
    expect(add).not.toHaveBeenCalled()

    vi.mocked(canRecord).mockReturnValue(false)
    await w.get('[data-testid=voice-start]').trigger('click')
    await flushPromises()
    expect(w.get('[data-testid=voice-error]').text()).toContain('Browser')
  })
})
