import { describe, expect, it } from 'vitest'
import { losslessCheck } from '@/timeline/lossless'
import {
  appendMedia,
  createDoc,
  insertOverlayClips,
  moveClip,
  putAsset,
  removeClip,
  setClipCrop,
  setClipFade,
  setClipGain,
  setClipSpeed,
  trimClip,
  updateSettings,
  updateTrack,
  type AssetRef,
  type Clip,
  type OpResult,
  type TimelineDoc,
} from '@/timeline/model'

const S = 1_000_000
const asset = (id: string, hasAudio = true): AssetRef => ({
  id,
  kind: 'video',
  name: `${id}.mp4`,
  duration: 10 * S,
  width: 1280,
  height: 720,
  fps: 25,
  hasAudio,
})
const must = (r: OpResult): TimelineDoc => {
  if (!r.ok) throw new Error(r.error)
  return r.doc
}
const lane = (doc: TimelineDoc, kind: string): Clip[] =>
  doc.tracks.filter((t) => t.kind === kind).flatMap((t) => t.clips as Clip[])
const one = (): TimelineDoc => must(appendMedia(putAsset(createDoc(), asset('a')), 'a'))
const reason = (doc: TimelineDoc) => {
  const r = losslessCheck(doc)
  return r.ok ? null : r.reason
}

describe('losslessCheck', () => {
  it('geht mit genau einem unveränderten Clip, auch gekürzt', () => {
    const doc = one()
    expect(losslessCheck(doc)).toEqual({
      ok: true,
      asset: 'a',
      sourceIn: 0,
      duration: 10 * S,
      audio: true,
    })
    // Ende kürzen (Bild und Ton gemeinsam): weiter möglich.
    const [video] = lane(doc, 'video')
    const [audio] = lane(doc, 'audio')
    const shortVideo = must(trimClip(doc, video.id, 'end', 6 * S))
    // Nur das Bild gekürzt: Der Ton läuft länger, also neu kodieren.
    expect(reason(shortVideo)).toBe('audio')
    const trimmed = must(trimClip(shortVideo, audio.id, 'end', 6 * S))
    expect(losslessCheck(trimmed)).toMatchObject({ ok: true, duration: 6 * S, audio: true })
    // Video ohne Tonspur.
    const silent = must(appendMedia(putAsset(createDoc(), asset('b', false)), 'b'))
    expect(losslessCheck(silent)).toMatchObject({ ok: true, audio: false })
  })

  it('ohne Ton-Clip oder mit stummer Spur wird ohne Ton kopiert', () => {
    const doc = one()
    const [audio] = lane(doc, 'audio')
    expect(losslessCheck(must(removeClip(doc, audio.id, { linked: false })))).toMatchObject({
      ok: true,
      audio: false,
    })
    const track = doc.tracks.find((t) => t.kind === 'audio')!
    expect(losslessCheck(must(updateTrack(doc, track.id, { muted: true })))).toMatchObject({
      ok: true,
      audio: false,
    })
  })

  it('nennt den Grund, wenn neu kodiert werden muss', () => {
    const doc = one()
    const [video] = lane(doc, 'video')
    const [audio] = lane(doc, 'audio')
    expect(reason(createDoc())).toBe('clips')
    expect(reason(must(appendMedia(doc, 'a')))).toBe('clips')
    expect(reason(must(moveClip(doc, video.id, { start: S })))).toBe('clips')
    expect(reason(must(setClipSpeed(doc, video.id, 2)))).toBe('speed')
    expect(reason(must(setClipCrop(doc, video.id, { x: 0, y: 0, width: 0.5, height: 1 })))).toBe(
      'crop',
    )
    expect(reason(must(updateSettings(doc, { width: 1920, height: 1080 })))).toBe('format')
    expect(reason(must(setClipGain(doc, audio.id, 0.5)))).toBe('audio')
    expect(reason(must(setClipFade(doc, audio.id, 'in', { duration: S })))).toBe('audio')
    expect(reason(must(moveClip(doc, audio.id, { start: S }, { linked: false })))).toBe('audio')
    const track = doc.tracks.find((t) => t.kind === 'audio')!
    expect(reason(must(updateTrack(doc, track.id, { volume: 0.5 })))).toBe('audio')
    const text: Clip = { id: 't', kind: 'text', start: 0, duration: S, data: { text: 'x' } }
    expect(reason(must(insertOverlayClips(doc, [text], 'T1')))).toBe('overlays')
  })
})
