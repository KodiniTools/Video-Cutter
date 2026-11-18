import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { DEFAULT_TEXT_STYLE } from '@/lib/textOverlay'
import { useTextDefaultStore } from '@/stores/textDefault'
import { useTimelineStore } from '@/stores/timeline'
import { createDoc, insertOverlayClips, type OverlayClip, type TimelineDoc } from '@/timeline/model'
import { subtitleStyle } from '@/timeline/subtitles'
import {
  matchesTextDefault,
  parseTextDefault,
  textDefaultPatch,
  textDefaultPatches,
} from '@/timeline/textDefault'

const S = 1_000_000
const BASE = { ...DEFAULT_TEXT_STYLE, animSpeed: 1 }
const CUSTOM = {
  ...BASE,
  font: 'f:Zodiak-Bold',
  size: 0.1,
  color: '#ff0000',
  style: 'box',
  animation: 'pop',
  animSpeed: 2,
  y: 0.2,
}
let n = 0
const text = (id: string, data: Record<string, unknown> = {}): OverlayClip => ({
  id,
  kind: 'text',
  start: n++ * S,
  duration: S,
  data: { ...BASE, text: id, ...data },
})
const docWith = (...clips: OverlayClip[]): TimelineDoc => {
  const r = insertOverlayClips(createDoc(), clips, 'T1')
  if (!r.ok) throw new Error(r.error)
  return r.doc
}

describe('Text-Standard (reine Funktionen)', () => {
  it('parseTextDefault: nimmt nur vollständige, gültige Einstellungen; Text gehört nicht dazu', () => {
    expect(parseTextDefault({ ...CUSTOM, text: 'Hallo', keys: [] })).toEqual(CUSTOM)
    // älterer Text ohne animSpeed = 1
    expect(parseTextDefault(DEFAULT_TEXT_STYLE)).toEqual(BASE)
    expect(parseTextDefault(null)).toBeNull()
    expect(parseTextDefault({ ...CUSTOM, color: 'rot' })).toBeNull()
    expect(parseTextDefault({ ...CUSTOM, size: 9 })).toBeNull()
    expect(parseTextDefault({ ...CUSTOM, font: 'comic' })).toBeNull()
    expect(parseTextDefault({ ...CUSTOM, x: 1.5 })).toBeNull()
    expect(parseTextDefault({ ...CUSTOM, animSpeed: 7 })).toBeNull()
  })

  it('textDefaultPatch: nur abweichende Felder; mit Keyframes bleibt die Position', () => {
    const def = parseTextDefault(CUSTOM)!
    expect(textDefaultPatch({ ...CUSTOM, text: 'a' }, def)).toEqual({})
    expect(matchesTextDefault({ ...CUSTOM, text: 'a' }, def)).toBe(true)
    expect(textDefaultPatch({ ...BASE, text: 'a' }, def)).toEqual({
      font: 'f:Zodiak-Bold',
      size: 0.1,
      color: '#ff0000',
      style: 'box',
      animation: 'pop',
      animSpeed: 2,
      y: 0.2,
    })
    const keyed = textDefaultPatch({ ...BASE, keys: [{ at: 0, x: 0.1, y: 0.1, scale: 1 }] }, def)
    expect(keyed.y).toBeUndefined()
    expect(keyed.color).toBe('#ff0000')
  })

  it('textDefaultPatches: alle abweichenden Texte, keine Grafiken, keine gesperrten Spuren', () => {
    const def = parseTextDefault(CUSTOM)!
    const graphic: OverlayClip = { ...text('g'), kind: 'graphic' }
    const doc = docWith(text('a'), text('b', CUSTOM), graphic)
    expect(textDefaultPatches(doc, def).map((p) => p.id)).toEqual(['a'])
    const locked = {
      ...doc,
      tracks: doc.tracks.map((t) => ({ ...t, locked: true })),
    } as TimelineDoc
    expect(textDefaultPatches(locked, def)).toEqual([])
  })

  it('subtitleStyle: gespeicherter Standard geht vor dem letzten Text', () => {
    const doc = docWith(text('a', { color: '#00ff00' }))
    expect(subtitleStyle(doc).color).toBe('#00ff00')
    expect(subtitleStyle(doc, parseTextDefault(CUSTOM))).toMatchObject(CUSTOM)
  })
})

describe('Text-Standard (Speicher + Timeline)', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('speichern bleibt über Sitzungen erhalten, aufheben löscht', () => {
    const store = useTextDefaultStore()
    expect(store.value).toBeNull()
    expect(store.save({ ...CUSTOM, color: 'kaputt' })).toBe(false)
    expect(store.value).toBeNull()
    expect(store.save({ ...CUSTOM, text: 'Hallo' })).toBe(true)
    expect(store.value).toEqual(CUSTOM)

    setActivePinia(createPinia())
    expect(useTextDefaultStore().value).toEqual(CUSTOM)
    useTextDefaultStore().clear()
    setActivePinia(createPinia())
    expect(useTextDefaultStore().value).toBeNull()
  })

  it('unbrauchbarer Speicherinhalt = kein Standard', () => {
    localStorage.setItem('videoCutter.textDefault', '{kaputt')
    expect(useTextDefaultStore().value).toBeNull()
  })

  it('auf alle Texte anwenden ist ein Rückgängig-Schritt; einzelne Änderung bleibt möglich', () => {
    const timeline = useTimelineStore()
    const a = timeline.addText({ ...BASE, text: 'a' }, S)!
    const b = timeline.addText({ ...BASE, text: 'b' }, S)!
    const def = parseTextDefault(CUSTOM)!
    timeline.updateClipsData(textDefaultPatches(timeline.doc, def))
    const data = (id: string) =>
      timeline.doc.tracks.flatMap((t) => t.clips as OverlayClip[]).find((c) => c.id === id)!.data
    expect(data(a)).toMatchObject({ ...CUSTOM, text: 'a' })
    expect(data(b)).toMatchObject({ ...CUSTOM, text: 'b' })

    timeline.updateClipData(b, { color: '#0000ff' })
    expect(data(b).color).toBe('#0000ff')
    expect(data(a).color).toBe('#ff0000')
    expect(textDefaultPatches(timeline.doc, def).map((p) => p.id)).toEqual([b])

    timeline.undo()
    timeline.undo()
    expect(data(a).color).toBe('#ffffff')
    expect(data(b).color).toBe('#ffffff')
  })
})
