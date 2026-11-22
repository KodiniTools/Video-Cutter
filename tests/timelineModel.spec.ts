import { describe, expect, it } from 'vitest'
import {
  addTrack,
  appendMedia,
  createDoc,
  docDuration,
  findClip,
  frameIndex,
  insertClip,
  insertOverlayClip,
  isMusicTrack,
  moveTrack,
  nextTrackName,
  moveClip,
  putAsset,
  removeAsset,
  removeClip,
  removeTrack,
  secondsToTime,
  snapPoints,
  snapTime,
  snapToFrame,
  splitClip,
  trimClip,
  updateClipData,
  updateSettings,
  masterVolume,
  updateTrack,
  validateDoc,
  type AudioClip,
  type OpResult,
  type TimelineDoc,
  type VideoClip,
} from '@/timeline/model'

const s = secondsToTime

/** Friert das Dokument tief ein: jeder schreibende Zugriff eines Befehls würde werfen. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const v of Object.values(value)) deepFreeze(v)
  }
  return value
}

function unwrap(r: OpResult): TimelineDoc {
  if (!r.ok) throw new Error(`Befehl abgelehnt: ${r.error}`)
  expect(validateDoc(r.doc)).toEqual([])
  return deepFreeze(r.doc)
}

function errorOf(r: OpResult): string | null {
  return r.ok ? null : r.error
}

const video = (id: string, start: number, duration: number, extra: Partial<VideoClip> = {}) =>
  ({
    id,
    kind: 'video',
    asset: 'vid',
    start: s(start),
    duration: s(duration),
    sourceIn: 0,
    speed: 1,
    ...extra,
  }) satisfies VideoClip

const audio = (id: string, start: number, duration: number, extra: Partial<AudioClip> = {}) =>
  ({
    id,
    kind: 'audio',
    asset: 'vid',
    start: s(start),
    duration: s(duration),
    sourceIn: 0,
    speed: 1,
    gain: 1,
    ...extra,
  }) satisfies AudioClip

/** V1 + A1 mit einem 10-s-Video als Quelle. */
function baseDoc(): TimelineDoc {
  let doc = createDoc()
  doc = putAsset(doc, { id: 'vid', kind: 'video', name: 'a.mp4', duration: s(10), hasAudio: true })
  doc = putAsset(doc, { id: 'img', kind: 'image', name: 'b.png', duration: null })
  doc = unwrap(addTrack(doc, { id: 'A1', kind: 'audio', name: 'Ton' }))
  doc = unwrap(addTrack(doc, { id: 'V1', kind: 'video', name: 'Video' }))
  return doc
}

const starts = (doc: TimelineDoc, trackId: string) =>
  doc.tracks.find((t) => t.id === trackId)!.clips.map((c) => [c.id, c.start, c.duration])

describe('Zeit', () => {
  it('rechnet Sekunden in ganze Mikrosekunden um', () => {
    expect(s(1.5)).toBe(1_500_000)
    expect(s(0.1 + 0.2)).toBe(300_000)
    expect(s(Number.NaN)).toBe(0)
  })

  it('rastet auf das Bildraster ein (auch 29,97 fps)', () => {
    expect(snapToFrame(s(1.02), 25)).toBe(s(1.04))
    expect(frameIndex(snapToFrame(s(3.2), 29.97), 29.97)).toBe(96)
    expect(snapToFrame(1234, 0)).toBe(1234)
  })
})

describe('Spuren', () => {
  it('legt neue Spuren oben an und lehnt doppelte IDs ab', () => {
    const doc = baseDoc()
    expect(doc.tracks.map((t) => t.id)).toEqual(['V1', 'A1'])
    expect(errorOf(addTrack(doc, { id: 'V1', kind: 'video', name: 'x' }))).toBe('duplicate-id')
    const more = unwrap(addTrack(doc, { id: 'T1', kind: 'overlay', name: 'Text' }, 99))
    expect(more.tracks.map((t) => t.id)).toEqual(['V1', 'A1', 'T1'])
  })

  it('ändert nur Felder, die die Spur-Art kennt', () => {
    const doc = unwrap(updateTrack(baseDoc(), 'V1', { hidden: true, muted: true, name: 'Haupt' }))
    expect(doc.tracks[0]).toMatchObject({ hidden: true, name: 'Haupt' })
    expect('muted' in doc.tracks[0]).toBe(false)
  })

  it('entfernt gesperrte Spuren nicht', () => {
    const doc = unwrap(updateTrack(baseDoc(), 'V1', { locked: true }))
    expect(errorOf(removeTrack(doc, 'V1'))).toBe('track-locked')
    expect(unwrap(removeTrack(doc, 'A1')).tracks.map((t) => t.id)).toEqual(['V1'])
    expect(errorOf(removeTrack(doc, 'nope'))).toBe('track-not-found')
  })
})

describe('removeAsset', () => {
  it('meldet ein unbenutztes Medium ab, ein verwendetes nicht', () => {
    const doc = unwrap(insertClip(baseDoc(), 'V1', video('a', 0, 2)))
    expect(errorOf(removeAsset(doc, 'vid'))).toBe('asset-in-use')
    expect(errorOf(removeAsset(doc, 'nope'))).toBe('asset-not-found')
    expect(Object.keys(unwrap(removeAsset(doc, 'img')).assets)).toEqual(['vid'])
    expect(unwrap(removeAsset(unwrap(removeClip(doc, 'a')), 'vid')).assets.vid).toBeUndefined()
  })
})

describe('insertClip', () => {
  it('fügt sortiert ein und verändert die Eingabe nicht', () => {
    let doc = baseDoc()
    doc = unwrap(insertClip(doc, 'V1', video('b', 5, 2)))
    doc = unwrap(insertClip(doc, 'V1', video('a', 0, 2)))
    expect(starts(doc, 'V1')).toEqual([
      ['a', 0, s(2)],
      ['b', s(5), s(2)],
    ])
    expect(docDuration(doc)).toBe(s(7))
  })

  it('lehnt Überlappung, falsche Spur-Art und ungültige Werte ab', () => {
    const doc = unwrap(insertClip(baseDoc(), 'V1', video('a', 0, 2)))
    expect(errorOf(insertClip(doc, 'V1', video('b', 1.5, 2)))).toBe('overlap')
    // Direkt anschließen ist erlaubt.
    expect(insertClip(doc, 'V1', video('b', 2, 2)).ok).toBe(true)
    expect(errorOf(insertClip(doc, 'A1', video('b', 3, 2)))).toBe('kind-mismatch')
    expect(errorOf(insertClip(doc, 'V1', video('a', 3, 2)))).toBe('duplicate-id')
    expect(errorOf(insertClip(doc, 'V1', video('b', 3, 0.01)))).toBe('too-short')
    expect(errorOf(insertClip(doc, 'V1', video('b', 3.0000001, 2, { start: 0.5 })))).toBe(
      'invalid-time',
    )
    expect(errorOf(insertClip(doc, 'V1', video('b', 3, 2, { asset: 'x' })))).toBe('asset-not-found')
    expect(errorOf(insertClip(doc, 'V1', video('b', 3, 2, { speed: 8 })))).toBe('invalid-time')
    expect(errorOf(insertClip(doc, 'nope', video('b', 3, 2)))).toBe('track-not-found')
  })

  it('achtet auf das Ende der Quelle, auch mit Tempo', () => {
    const doc = baseDoc()
    expect(errorOf(insertClip(doc, 'V1', video('a', 0, 11)))).toBe('out-of-source')
    expect(errorOf(insertClip(doc, 'V1', video('a', 0, 6, { speed: 2 })))).toBe('out-of-source')
    expect(insertClip(doc, 'V1', video('a', 0, 5, { speed: 2 })).ok).toBe(true)
    // Halbes Tempo: 10 s Quelle reichen für 20 s auf der Timeline.
    expect(insertClip(doc, 'V1', video('a', 0, 20, { speed: 0.5 })).ok).toBe(true)
    // Standbilder sind beliebig lang.
    expect(insertClip(doc, 'V1', video('a', 0, 60, { kind: 'still', asset: 'img' })).ok).toBe(true)
  })

  it('lehnt Änderungen an gesperrten Spuren ab', () => {
    const doc = unwrap(updateTrack(baseDoc(), 'V1', { locked: true }))
    expect(errorOf(insertClip(doc, 'V1', video('a', 0, 2)))).toBe('track-locked')
  })
})

describe('moveClip', () => {
  it('verschiebt in der Zeit und auf eine andere Spur', () => {
    let doc = unwrap(insertClip(baseDoc(), 'V1', video('a', 0, 2)))
    doc = unwrap(addTrack(doc, { id: 'V2', kind: 'video', name: 'V2' }))
    doc = unwrap(moveClip(doc, 'a', { start: s(4), trackId: 'V2' }))
    expect(starts(doc, 'V1')).toEqual([])
    expect(starts(doc, 'V2')).toEqual([['a', s(4), s(2)]])
  })

  it('lehnt Überlappung, negative Zeit und falsche Spur ab', () => {
    let doc = unwrap(insertClip(baseDoc(), 'V1', video('a', 0, 2)))
    doc = unwrap(insertClip(doc, 'V1', video('b', 3, 2)))
    expect(errorOf(moveClip(doc, 'b', { start: s(1) }))).toBe('overlap')
    expect(errorOf(moveClip(doc, 'b', { start: -1 }))).toBe('invalid-time')
    expect(errorOf(moveClip(doc, 'b', { start: s(6), trackId: 'A1' }))).toBe('kind-mismatch')
    expect(errorOf(moveClip(doc, 'x', { start: 0 }))).toBe('clip-not-found')
    // Ein Clip darf über seine eigene alte Lage hinweg rücken.
    expect(starts(unwrap(moveClip(doc, 'b', { start: s(2.5) })), 'V1')[1]).toEqual([
      'b',
      s(2.5),
      s(2),
    ])
  })

  it('nimmt verknüpfte Clips mit und scheitert als Ganzes', () => {
    let doc = unwrap(insertClip(baseDoc(), 'V1', video('v', 2, 2, { linkGroup: 'g' })))
    doc = unwrap(insertClip(doc, 'A1', audio('a', 2, 2, { linkGroup: 'g' })))
    const moved = unwrap(moveClip(doc, 'v', { start: s(5) }))
    expect(starts(moved, 'A1')).toEqual([['a', s(5), s(2)]])
    // Verknüpfter Ton würde vor 0 landen bzw. kollidieren -> nichts bewegt sich.
    const blocked = unwrap(insertClip(doc, 'A1', audio('x', 6, 2)))
    expect(errorOf(moveClip(blocked, 'v', { start: s(5) }))).toBe('overlap')
    // Ohne Verknüpfung bewegt sich nur das Bild.
    const alone = unwrap(moveClip(blocked, 'v', { start: s(5) }, { linked: false }))
    expect(starts(alone, 'A1')[0]).toEqual(['a', s(2), s(2)])
    // Gesperrte Spur eines verknüpften Clips blockiert.
    const locked = unwrap(updateTrack(doc, 'A1', { locked: true }))
    expect(errorOf(moveClip(locked, 'v', { start: s(5) }))).toBe('track-locked')
  })
})

describe('trimClip', () => {
  it('zieht den Anfang: Quell-Beginn rückt mit, Ende bleibt', () => {
    let doc = unwrap(insertClip(baseDoc(), 'V1', video('a', 2, 4, { sourceIn: s(1) })))
    doc = unwrap(trimClip(doc, 'a', 'start', s(3)))
    expect(findClip(doc, 'a')!.clip).toMatchObject({ start: s(3), duration: s(3), sourceIn: s(2) })
    // Zurück über den Quell-Anfang hinaus geht nicht.
    expect(errorOf(trimClip(doc, 'a', 'start', s(0.5)))).toBe('out-of-source')
    expect(unwrap(trimClip(doc, 'a', 'start', s(1))).tracks[0].clips[0]).toMatchObject({
      start: s(1),
      sourceIn: 0,
    })
  })

  it('rechnet beim Anfang das Tempo ein', () => {
    let doc = unwrap(insertClip(baseDoc(), 'V1', video('a', 0, 4, { speed: 2 })))
    doc = unwrap(trimClip(doc, 'a', 'start', s(1)))
    expect(findClip(doc, 'a')!.clip).toMatchObject({ start: s(1), duration: s(3), sourceIn: s(2) })
  })

  it('zieht das Ende bis höchstens zum Quell-Ende und zum Nachbarn', () => {
    let doc = unwrap(insertClip(baseDoc(), 'V1', video('a', 0, 4, { sourceIn: s(2) })))
    expect(unwrap(trimClip(doc, 'a', 'end', s(8))).tracks[0].clips[0].duration).toBe(s(8))
    expect(errorOf(trimClip(doc, 'a', 'end', s(8.5)))).toBe('out-of-source')
    doc = unwrap(insertClip(doc, 'V1', video('b', 5, 2, { sourceIn: s(4) })))
    expect(errorOf(trimClip(doc, 'a', 'end', s(6)))).toBe('overlap')
    expect(errorOf(trimClip(doc, 'a', 'end', s(0.01)))).toBe('too-short')
    expect(errorOf(trimClip(doc, 'a', 'start', s(3.99)))).toBe('too-short')
    expect(errorOf(trimClip(doc, 'b', 'start', s(3)))).toBe('overlap')
  })

  it('lässt Standbilder frei verlängern und verknüpfte Clips unberührt', () => {
    let doc = unwrap(
      insertClip(
        baseDoc(),
        'V1',
        video('p', 2, 2, { kind: 'still', asset: 'img', linkGroup: 'g' }),
      ),
    )
    doc = unwrap(insertClip(doc, 'A1', audio('a', 2, 2, { linkGroup: 'g' })))
    doc = unwrap(trimClip(doc, 'p', 'start', 0))
    doc = unwrap(trimClip(doc, 'p', 'end', s(100)))
    expect(findClip(doc, 'p')!.clip).toMatchObject({ start: 0, duration: s(100), sourceIn: 0 })
    expect(findClip(doc, 'a')!.clip).toMatchObject({ start: s(2), duration: s(2) })
  })
})

describe('splitClip', () => {
  const ids = () => {
    let n = 0
    return () => `n${++n}`
  }

  it('teilt einen Clip; die rechte Hälfte setzt in der Quelle nahtlos fort', () => {
    let doc = unwrap(insertClip(baseDoc(), 'V1', video('a', 1, 4, { sourceIn: s(1), speed: 2 })))
    doc = unwrap(splitClip(doc, 'a', s(2.5), { ids: ids() }))
    expect(doc.tracks[0].clips).toMatchObject([
      { id: 'a', start: s(1), duration: s(1.5), sourceIn: s(1) },
      { id: 'n1', start: s(2.5), duration: s(2.5), sourceIn: s(4) },
    ])
  })

  it('teilt verknüpfte Clips mit und verknüpft die rechten Hälften neu', () => {
    let doc = unwrap(insertClip(baseDoc(), 'V1', video('v', 0, 4, { linkGroup: 'g' })))
    doc = unwrap(insertClip(doc, 'A1', audio('a', 0, 4, { linkGroup: 'g' })))
    doc = unwrap(splitClip(doc, 'v', s(1), { ids: ids() }))
    const [v1, v2] = doc.tracks[0].clips
    const [a1, a2] = doc.tracks[1].clips
    expect([v1.linkGroup, a1.linkGroup]).toEqual(['g', 'g'])
    expect(v2.linkGroup).toBe(a2.linkGroup)
    expect(v2.linkGroup).not.toBe('g')
    expect(v2.linkGroup).toBeTruthy()
    // Danach bewegen sich die rechten Hälften gemeinsam, die linken bleiben.
    const moved = unwrap(moveClip(doc, v2.id, { start: s(6) }))
    expect(starts(moved, 'A1').map((c) => c[1])).toEqual([0, s(6)])
  })

  it('teilt nur Clips, die die Stelle überdecken; einzelne rechte Hälfte ohne Gruppe', () => {
    let doc = unwrap(insertClip(baseDoc(), 'V1', video('v', 0, 4, { linkGroup: 'g' })))
    doc = unwrap(insertClip(doc, 'A1', audio('a', 0, 2, { linkGroup: 'g' })))
    doc = unwrap(splitClip(doc, 'v', s(3), { ids: ids() }))
    expect(doc.tracks[1].clips).toHaveLength(1)
    expect(doc.tracks[0].clips[1].linkGroup).toBeUndefined()
  })

  it('lehnt Stellen außerhalb, zu kurze Teile und gesperrte Spuren ab', () => {
    const doc = unwrap(insertClip(baseDoc(), 'V1', video('a', 1, 4)))
    expect(errorOf(splitClip(doc, 'a', s(1)))).toBe('invalid-time')
    expect(errorOf(splitClip(doc, 'a', s(5)))).toBe('invalid-time')
    expect(errorOf(splitClip(doc, 'a', s(1.01)))).toBe('too-short')
    expect(errorOf(splitClip(doc, 'a', s(2), { ids: () => 'a' }))).toBe('duplicate-id')
    const locked = unwrap(updateTrack(doc, 'V1', { locked: true }))
    expect(errorOf(splitClip(locked, 'a', s(2)))).toBe('track-locked')
  })
})

describe('removeClip', () => {
  function three(): TimelineDoc {
    let doc = unwrap(insertClip(baseDoc(), 'V1', video('a', 0, 2)))
    doc = unwrap(insertClip(doc, 'V1', video('b', 3, 2)))
    doc = unwrap(insertClip(doc, 'V1', video('c', 6, 2)))
    return doc
  }

  it('löscht ohne Ripple und lässt die Lücke stehen', () => {
    expect(starts(unwrap(removeClip(three(), 'b')), 'V1')).toEqual([
      ['a', 0, s(2)],
      ['c', s(6), s(2)],
    ])
  })

  it('schließt mit Ripple genau die Länge des gelöschten Clips', () => {
    expect(starts(unwrap(removeClip(three(), 'b', { ripple: true })), 'V1')).toEqual([
      ['a', 0, s(2)],
      ['c', s(4), s(2)],
    ])
  })

  it('löscht verknüpfte Clips mit; Ripple verschiebt alle Spuren gleich', () => {
    let doc = unwrap(insertClip(baseDoc(), 'V1', video('v', 0, 2, { linkGroup: 'g' })))
    doc = unwrap(insertClip(doc, 'A1', audio('a', 0, 2, { linkGroup: 'g' })))
    doc = unwrap(insertClip(doc, 'V1', video('v2', 2, 2)))
    doc = unwrap(insertClip(doc, 'A1', audio('a2', 3, 2)))
    const out = unwrap(removeClip(doc, 'v', { ripple: true }))
    expect(starts(out, 'V1')).toEqual([['v2', 0, s(2)]])
    expect(starts(out, 'A1')).toEqual([['a2', s(1), s(2)]])
    const single = unwrap(removeClip(doc, 'v', { linked: false }))
    expect(starts(single, 'A1')).toHaveLength(2)
  })

  it('hält beim Ripple spätere Bild-/Ton-Paare zusammen (versetzter Schnitt)', () => {
    // Bild vorn gekürzt (1–4 s), Ton ungekürzt (0–4 s); dahinter ein Paar ab 4 s.
    let doc = unwrap(insertClip(baseDoc(), 'V1', video('v', 1, 3, { linkGroup: 'g' })))
    doc = unwrap(insertClip(doc, 'A1', audio('a', 0, 4, { linkGroup: 'g' })))
    doc = unwrap(insertClip(doc, 'V1', video('v2', 4, 2, { linkGroup: 'h' })))
    doc = unwrap(insertClip(doc, 'A1', audio('a2', 4, 2, { linkGroup: 'h' })))
    const out = unwrap(removeClip(doc, 'v', { ripple: true }))
    expect(starts(out, 'V1')).toEqual([['v2', 0, s(2)]])
    expect(starts(out, 'A1')).toEqual([['a2', 0, s(2)]])

    // Liegt auf einer Spur davor noch ein Clip, rückt alles nur so weit wie dort Platz ist.
    const blocked = unwrap(insertClip(doc, 'V1', video('vor', 0, 0.5)))
    const out2 = unwrap(removeClip(blocked, 'v', { ripple: true }))
    expect(starts(out2, 'V1')).toEqual([
      ['vor', 0, s(0.5)],
      ['v2', s(0.5), s(2)],
    ])
    expect(starts(out2, 'A1')).toEqual([['a2', s(0.5), s(2)]])
    expect(validateDoc(out2)).toEqual([])

    // Gesperrte Spuren bleiben stehen.
    let lockedDoc = unwrap(insertClip(baseDoc(), 'V1', video('x', 8, 1)))
    lockedDoc = unwrap(insertClip(lockedDoc, 'A1', audio('a', 0, 4)))
    lockedDoc = unwrap(insertClip(lockedDoc, 'A1', audio('a2', 4, 2)))
    lockedDoc = unwrap(updateTrack(lockedDoc, 'V1', { locked: true }))
    const out3 = unwrap(removeClip(lockedDoc, 'a', { ripple: true }))
    expect(starts(out3, 'V1')).toEqual([['x', s(8), s(1)]])
    expect(starts(out3, 'A1')).toEqual([['a2', 0, s(2)]])
  })

  it('lehnt gesperrte Spuren und unbekannte Clips ab', () => {
    const locked = unwrap(updateTrack(three(), 'V1', { locked: true }))
    expect(errorOf(removeClip(locked, 'b'))).toBe('track-locked')
    expect(errorOf(removeClip(three(), 'x'))).toBe('clip-not-found')
  })
})

describe('appendMedia', () => {
  const counter = () => {
    let n = 0
    return () => `n${++n}`
  }
  function empty(): TimelineDoc {
    let doc = createDoc()
    doc = putAsset(doc, {
      id: 'vid',
      kind: 'video',
      name: 'a.mp4',
      duration: s(10),
      width: 1080,
      height: 1920,
      fps: 25,
      hasAudio: true,
    })
    doc = putAsset(doc, { id: 'stumm', kind: 'video', name: 's.mp4', duration: s(4) })
    doc = putAsset(doc, { id: 'img', kind: 'image', name: 'b.png', duration: null })
    doc = putAsset(doc, {
      id: 'lied',
      kind: 'audio',
      name: 'l.mp3',
      duration: s(30),
      hasAudio: true,
    })
    return doc
  }

  it('legt Tondateien auf eine eigene Musik-Spur ab 0, weitere dahinter', () => {
    const ids = counter()
    let doc = unwrap(appendMedia(empty(), 'vid', { ids }))
    doc = unwrap(appendMedia(doc, 'lied', { ids }))
    expect(doc.tracks.map((t) => [t.kind, t.name, t.clips.length])).toEqual([
      ['video', 'V1', 1],
      ['audio', 'A1', 1],
      ['audio', 'A2', 1],
    ])
    // Die Musik läuft unter dem Video mit, unverknüpft und ohne das Projekt zu ändern.
    const music = doc.tracks[2].clips[0]
    expect(music).toMatchObject({
      kind: 'audio',
      asset: 'lied',
      start: 0,
      duration: s(30),
      gain: 1,
    })
    expect(music.linkGroup).toBeUndefined()
    expect(isMusicTrack(doc, doc.tracks[2])).toBe(true)
    expect(isMusicTrack(doc, doc.tracks[1])).toBe(false)

    doc = unwrap(appendMedia(doc, 'lied', { ids }))
    expect(doc.tracks[2].clips.map((c) => c.start)).toEqual([0, s(30)])
    // Das nächste Video landet hinter dem ersten Video, nicht hinter der Musik.
    doc = unwrap(appendMedia(doc, 'vid', { ids }))
    expect(doc.tracks[0].clips.map((c) => c.start)).toEqual([0, s(10)])
    expect(doc.tracks[1].clips.map((c) => c.start)).toEqual([0, s(10)])
    expect(doc.tracks).toHaveLength(3)
  })

  it('Musik zuerst: Das Video beginnt trotzdem bei 0 auf einer eigenen Ton-Spur', () => {
    const ids = counter()
    let doc = unwrap(appendMedia(empty(), 'lied', { ids }))
    expect(doc.tracks.map((t) => t.name)).toEqual(['A1'])
    expect(doc.settings).toMatchObject({ width: 1920, height: 1080 })
    doc = unwrap(appendMedia(doc, 'vid', { ids }))
    // Das erste Video bestimmt das Format, auch wenn schon Musik liegt.
    expect(doc.settings).toMatchObject({ width: 1080, height: 1920, fps: 25 })
    expect(doc.tracks.map((t) => [t.name, t.clips[0].start])).toEqual([
      ['V1', 0],
      ['A1', 0],
      ['A2', 0],
    ])
    expect(doc.tracks[2].clips[0].asset).toBe('vid')
    expect(validateDoc(doc)).toEqual([])
  })

  it('legt in einer leeren Timeline Spuren an und übernimmt Größe und Bildrate', () => {
    const doc = unwrap(appendMedia(empty(), 'vid', { ids: counter() }))
    expect(doc.tracks.map((t) => [t.kind, t.name])).toEqual([
      ['video', 'V1'],
      ['audio', 'A1'],
    ])
    expect(doc.settings).toMatchObject({ width: 1080, height: 1920, fps: 25 })
    const [v] = doc.tracks[0].clips
    const [a] = doc.tracks[1].clips
    expect(v).toMatchObject({ kind: 'video', asset: 'vid', start: 0, duration: s(10), sourceIn: 0 })
    expect(a).toMatchObject({ kind: 'audio', asset: 'vid', start: 0, duration: s(10), gain: 1 })
    expect(v.linkGroup).toBeTruthy()
    expect(v.linkGroup).toBe(a.linkGroup)
  })

  it('hängt weitere Videos hinten an und lässt die Projekt-Einstellungen stehen', () => {
    const ids = counter()
    let doc = unwrap(appendMedia(empty(), 'stumm', { ids }))
    // Ohne Ton: nur die Bild-Spur, kein verknüpfter Clip; ohne Maße bleibt der Standard.
    expect(doc.tracks.map((t) => t.name)).toEqual(['V1'])
    expect(doc.tracks[0].clips[0].linkGroup).toBeUndefined()
    expect(doc.settings).toMatchObject({ width: 1920, height: 1080, fps: 30 })

    doc = unwrap(appendMedia(doc, 'vid', { ids }))
    expect(doc.settings).toMatchObject({ width: 1920, height: 1080, fps: 30 })
    expect(doc.tracks.map((t) => t.name)).toEqual(['V1', 'A1'])
    expect(starts(doc, doc.tracks[0].id).map((c) => c[1])).toEqual([0, s(4)])
    // Der Ton beginnt gemeinsam mit seinem Bild, nicht bei 0.
    expect(doc.tracks[1].clips[0].start).toBe(s(4))
  })

  it('weicht gesperrten Spuren auf neue aus', () => {
    let doc = unwrap(appendMedia(empty(), 'vid', { ids: counter() }))
    doc = unwrap(updateTrack(doc, doc.tracks[0].id, { locked: true }))
    const ids = (() => {
      let n = 0
      return () => `m${++n}`
    })()
    doc = unwrap(appendMedia(doc, 'vid', { ids }))
    expect(doc.tracks.map((t) => [t.name, t.clips.length])).toEqual([
      ['V2', 1],
      ['V1', 1],
      ['A1', 2],
    ])
    // Bild und Ton liegen wieder gleichauf: hinter dem Ton auf A1.
    expect(doc.tracks[0].clips[0].start).toBe(s(10))
    expect(doc.tracks[2].clips[1].start).toBe(s(10))
  })

  it('lehnt Unbekanntes und Bilder ab', () => {
    expect(errorOf(appendMedia(empty(), 'nope'))).toBe('asset-not-found')
    expect(errorOf(appendMedia(empty(), 'img'))).toBe('kind-mismatch')
  })
})

describe('Ebenen-Clips (Text)', () => {
  const textClip = (id: string, start: number, duration: number) =>
    ({ id, kind: 'text', start: s(start), duration: s(duration), data: { text: 'Hallo' } }) as const

  it('legt bei Bedarf oben eine Ebenen-Spur an und nutzt sie weiter, solange Platz ist', () => {
    let doc = unwrap(insertOverlayClip(baseDoc(), textClip('t1', 0, 3), 'T1', 'ovl'))
    expect(doc.tracks[0]).toMatchObject({ id: 'ovl', kind: 'overlay', name: 'T1' })
    doc = unwrap(insertOverlayClip(doc, textClip('t2', 5, 2), 'T2'))
    expect(doc.tracks.filter((t) => t.kind === 'overlay')).toHaveLength(1)
    expect(starts(doc, 'ovl')).toEqual([
      ['t1', 0, s(3)],
      ['t2', s(5), s(2)],
    ])
    // Überlappung: zweite Ebenen-Spur darüber.
    doc = unwrap(insertOverlayClip(doc, textClip('t3', 1, 2), 'T2', 'ovl2'))
    expect(doc.tracks.slice(0, 2).map((t) => t.id)).toEqual(['ovl2', 'ovl'])
  })

  it('ändert Darstellungsdaten, ohne die Eingabe anzufassen', () => {
    const doc = unwrap(insertOverlayClip(baseDoc(), textClip('t1', 0, 3), 'T1', 'ovl'))
    const next = unwrap(updateClipData(doc, 't1', { text: 'Neu', size: 0.1, color: undefined }))
    const clip = next.tracks[0].clips[0]
    expect('data' in clip && clip.data).toEqual({ text: 'Neu', size: 0.1 })
    // Gleiche Werte: dasselbe Dokument.
    const same = updateClipData(next, 't1', { text: 'Neu' })
    expect(same.ok && same.doc === next).toBe(true)
  })

  it('lehnt unbekannte Clips, Medien-Clips und gesperrte Spuren ab', () => {
    const doc = unwrap(insertOverlayClip(baseDoc(), textClip('t1', 0, 3), 'T1', 'ovl'))
    expect(errorOf(updateClipData(doc, 'nix', { text: 'x' }))).toBe('clip-not-found')
    const media = doc.tracks.find((t) => t.kind === 'video')?.clips[0]
    if (media) expect(errorOf(updateClipData(doc, media.id, { text: 'x' }))).toBe('kind-mismatch')
    const locked = unwrap(updateTrack(doc, 'ovl', { locked: true }))
    expect(errorOf(updateClipData(locked, 't1', { text: 'x' }))).toBe('track-locked')
    // Gesperrte Ebenen-Spur wird übergangen: neue Spur.
    const more = unwrap(insertOverlayClip(locked, textClip('t2', 10, 1), 'T2', 'ovl2'))
    expect(more.tracks[0].id).toBe('ovl2')
  })
})

describe('updateSettings', () => {
  it('ändert Größe, Bildrate und Hintergrund, ohne die Eingabe anzufassen', () => {
    const doc = createDoc()
    const r = updateSettings(doc, { width: 1080, height: 1920, fps: 25, background: '#FFAA00' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.doc.settings).toMatchObject({
      width: 1080,
      height: 1920,
      fps: 25,
      background: '#ffaa00',
      sampleRate: 48000,
    })
    expect(doc.settings.width).toBe(1920)
    expect(r.doc.tracks).toBe(doc.tracks)
  })

  it('liefert bei gleichen Werten dasselbe Dokument (kein leerer Schritt)', () => {
    const doc = createDoc()
    const r = updateSettings(doc, { width: 1920, fps: 30 })
    expect(r.ok && r.doc === doc).toBe(true)
  })

  it('Gesamtlautstärke: 0 … 2, 100 % lässt das Feld weg', () => {
    const doc = createDoc()
    const r = updateSettings(doc, { volume: 1.5 })
    expect(r.ok && r.doc.settings.volume).toBe(1.5)
    if (!r.ok) return
    expect(masterVolume(r.doc.settings)).toBe(1.5)
    const back = updateSettings(r.doc, { volume: 1 })
    expect(back.ok && 'volume' in back.doc.settings).toBe(false)
    expect(back.ok && masterVolume(back.doc.settings)).toBe(1)
    // Kein Unterschied -> dasselbe Dokument.
    expect(updateSettings(doc, { volume: 1 })).toEqual({ ok: true, doc })
    expect(updateSettings(r.doc, { volume: 1.5 })).toEqual({ ok: true, doc: r.doc })
    for (const volume of [-0.1, 2.5, Number.NaN])
      expect(updateSettings(doc, { volume })).toEqual({ ok: false, error: 'invalid-settings' })
  })

  it('lehnt ab, was der Server nicht annähme', () => {
    const doc = createDoc()
    for (const patch of [
      { width: 1081 },
      { height: 8 },
      { width: 4000 },
      { fps: 0 },
      { fps: 120 },
      { fps: Number.NaN },
      { background: 'rot' },
    ])
      expect(updateSettings(doc, patch)).toEqual({ ok: false, error: 'invalid-settings' })
  })
})

describe('Einrasten', () => {
  it('sammelt Clip-Ränder, Marker und Abspielkopf ohne ausgeschlossene Clips', () => {
    let doc = unwrap(insertClip(baseDoc(), 'V1', video('a', 1, 2)))
    doc = unwrap(insertClip(doc, 'V1', video('b', 5, 2)))
    doc = { ...doc, markers: [{ id: 'm', at: s(4), label: 'x' }] }
    expect(snapPoints(doc, { exclude: ['b'], playhead: s(9) })).toEqual([0, s(1), s(3), s(4), s(9)])
  })

  it('nimmt den nächsten Punkt nur innerhalb der Toleranz', () => {
    const points = [0, s(1), s(3)]
    expect(snapTime(s(1.04), points, s(0.05))).toEqual({ time: s(1), snapped: true })
    expect(snapTime(s(1.2), points, s(0.05))).toEqual({ time: s(1.2), snapped: false })
    expect(snapTime(s(2.1), points, s(2))).toEqual({ time: s(3), snapped: true })
    expect(snapTime(s(2), [], s(1))).toEqual({ time: s(2), snapped: false })
  })
})

describe('validateDoc', () => {
  it('meldet Überlappung, doppelte IDs und falsche Spur-Art in geladenen Dokumenten', () => {
    const doc = baseDoc()
    const broken: TimelineDoc = {
      ...doc,
      tracks: [
        {
          ...doc.tracks[0],
          clips: [video('a', 0, 3), video('a', 2, 2)],
        } as TimelineDoc['tracks'][0],
        {
          ...doc.tracks[1],
          clips: [video('z', 0, 1) as unknown as AudioClip],
        } as TimelineDoc['tracks'][1],
      ],
    }
    expect(validateDoc(broken)).toEqual(
      expect.arrayContaining([
        { error: 'duplicate-id', id: 'a' },
        { error: 'overlap', id: 'a' },
        { error: 'kind-mismatch', id: 'z' },
      ]),
    )
  })
})

describe('Spuren verwalten', () => {
  it('verschiebt Spuren in der Reihenfolge und begrenzt das Ziel', () => {
    let doc = unwrap(addTrack(baseDoc(), { id: 'V2', kind: 'video', name: 'V2' }))
    const order = (d: TimelineDoc) => d.tracks.map((tr) => tr.id)
    const before = order(doc)
    expect(before[0]).toBe('V2')
    doc = unwrap(moveTrack(doc, 'V2', 99))
    expect(order(doc)).toEqual([...before.slice(1), 'V2'])
    doc = unwrap(moveTrack(doc, 'V2', -3))
    expect(order(doc)).toEqual(before)
    // Gleiche Stelle: derselbe Stand, kein neuer Schritt.
    expect(unwrap(moveTrack(doc, 'V2', 0))).toBe(doc)
    expect(errorOf(moveTrack(doc, 'gibt-es-nicht', 0))).toBe('track-not-found')
    expect(errorOf(moveTrack(doc, 'V2', Number.NaN))).toBe('invalid-time')
  })

  it('liefert bei unveränderten Eigenschaften denselben Stand', () => {
    const doc = baseDoc()
    expect(unwrap(updateTrack(doc, 'V1', { locked: false }))).toBe(doc)
    expect(unwrap(updateTrack(doc, 'V1', { muted: true }))).toBe(doc)
    const locked = unwrap(updateTrack(doc, 'V1', { locked: true, name: 'Bild' }))
    expect(locked.tracks.find((tr) => tr.id === 'V1')).toMatchObject({ locked: true, name: 'Bild' })
  })

  it('findet den nächsten freien Spurnamen', () => {
    let doc = unwrap(addTrack(createDoc(), { kind: 'video', name: 'V1' }))
    doc = unwrap(addTrack(doc, { kind: 'video', name: 'V3' }))
    expect(nextTrackName(doc, 'V')).toBe('V2')
    expect(nextTrackName(doc, 'A')).toBe('A1')
  })
})
