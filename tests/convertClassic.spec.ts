import { describe, it, expect } from 'vitest'
import type { MediaView } from '@/lib/mediaApi'
import { parseProjectState } from '@/lib/projectState'
import { convertClassicProject } from '@/timeline/convertClassic'
import { validateDoc, type Clip, type TimelineDoc } from '@/timeline/model'
import { parseTimelineProject, usedImageIds } from '@/timeline/projectFile'

const view = (id: string, over: Partial<MediaView> = {}): MediaView => ({
  id,
  name: `${id}.mp4`,
  size: 1000,
  duration: 10,
  width: 1280,
  height: 720,
  hasAudio: true,
  fps: 25,
  ...over,
})
const S = 1_000_000
const item = (media: string, over: Record<string, unknown> = {}) => ({
  media,
  name: `${media}.mp4`,
  start: 0,
  end: null,
  include: true,
  texts: [],
  graphics: [],
  ...over,
})
/** Stand wie vom Server (roh) -> gelesen wie beim Öffnen. */
const classic = (raw: Record<string, unknown>) =>
  parseProjectState({ version: 1, anim: { animation: 'none' }, ...raw })
const track = (doc: TimelineDoc, kind: string) => doc.tracks.filter((t) => t.kind === kind)
const clips = (doc: TimelineDoc, kind: string): Clip[] =>
  track(doc, kind).flatMap((t) => [...t.clips])
const brief = (list: Clip[]) =>
  list.map((c) => [
    'asset' in c ? c.asset : c.kind,
    c.start / S,
    c.duration / S,
    ...('sourceIn' in c ? [c.sourceIn / S, c.speed] : []),
  ])

describe('convertClassicProject', () => {
  it('legt die Videos hintereinander auf V1, den Ton verknüpft auf A1', () => {
    const r = convertClassicProject(
      classic({ items: [item('a', { start: 2, end: 6 }), item('b')] }),
      { a: view('A'), b: view('B', { duration: 5 }) },
    )
    const doc = r.state.doc
    expect(validateDoc(doc)).toEqual([])
    expect(doc.tracks.map((t) => [t.kind, t.name])).toEqual([
      ['video', 'V1'],
      ['audio', 'A1'],
    ])
    expect(brief(clips(doc, 'video'))).toEqual([
      ['A', 0, 4, 2, 1],
      ['B', 4, 5, 0, 1],
    ])
    expect(brief(clips(doc, 'audio'))).toEqual(brief(clips(doc, 'video')))
    const [v1, v2] = clips(doc, 'video')
    const [a1, a2] = clips(doc, 'audio')
    expect(v1.linkGroup).toBeTruthy()
    expect(v1.linkGroup).toBe(a1.linkGroup)
    expect(v2.linkGroup).toBe(a2.linkGroup)
    expect(v1.linkGroup).not.toBe(v2.linkGroup)
    expect(doc.settings).toMatchObject({ width: 1280, height: 720, fps: 25 })
    expect(r.skipped).toEqual([])
    expect(r.missingMedia).toBe(0)
    // Das Ergebnis ist ein gültiger Stand des neuen Editors.
    expect(parseTimelineProject(JSON.parse(JSON.stringify(r.state))).doc).toEqual(doc)
  })

  it('Tempo: Länge auf der Timeline = verwendete Länge / Faktor', () => {
    const r = convertClassicProject(
      classic({
        items: [item('a', { start: 1, end: 9, speed: 1 }), item('b', { speed: -1, end: 4 })],
      }),
      { a: view('A'), b: view('B') },
    )
    expect(brief(clips(r.state.doc, 'video'))).toEqual([
      ['A', 0, 4, 1, 2],
      ['B', 4, 8, 0, 0.5],
    ])
    expect(validateDoc(r.state.doc)).toEqual([])
  })

  it('Stumm und Videos ohne Ton bekommen keinen Ton-Clip', () => {
    const r = convertClassicProject(
      classic({ items: [item('a', { muted: true }), item('b'), item('c')] }),
      { a: view('A'), b: view('B', { hasAudio: false }), c: view('C') },
    )
    const doc = r.state.doc
    expect(brief(clips(doc, 'audio'))).toEqual([['C', 20, 10, 0, 1]])
    const [va, vb, vc] = clips(doc, 'video')
    expect(va.linkGroup).toBeUndefined()
    expect(vb.linkGroup).toBeUndefined()
    expect(vc.linkGroup).toBe(clips(doc, 'audio')[0].linkGroup)
  })

  it('„Von“ im Gesamtvideo: früher kürzt den Vorgänger, später lässt eine Lücke', () => {
    const r = convertClassicProject(
      classic({ items: [item('a'), item('b', { at: 6 }), item('c', { at: 20 })] }),
      { a: view('A'), b: view('B'), c: view('C') },
    )
    expect(brief(clips(r.state.doc, 'video'))).toEqual([
      ['A', 0, 6, 0, 1],
      ['B', 6, 10, 0, 1],
      ['C', 20, 10, 0, 1],
    ])
    // Die Lücke hinter B zeigt wie bisher dessen letztes Bild.
    expect(r.skipped).toEqual([])
    expect(clips(r.state.doc, 'video').map((c) => ('hold' in c ? c.hold : false))).toEqual([
      false,
      true,
      false,
    ])
    expect(validateDoc(r.state.doc)).toEqual([])
  })

  it('Videos ohne Häkchen und fehlende Videos', () => {
    const r = convertClassicProject(
      classic({ items: [item('a', { include: false }), item('b'), item('weg')] }),
      { a: view('A'), b: view('B') },
    )
    expect(brief(clips(r.state.doc, 'video'))).toEqual([['B', 0, 10, 0, 1]])
    // Das Video ohne Häkchen bleibt in der Medienliste.
    expect(Object.keys(r.state.doc.assets).sort()).toEqual(['A', 'B'])
    expect(Object.keys(r.media).sort()).toEqual(['A', 'B'])
    expect(r.missingMedia).toBe(1)

    // Kein Häkchen gesetzt (Einzelbearbeitung): alle Videos verwenden.
    const single = convertClassicProject(classic({ items: [item('a', { include: false })] }), {
      a: view('A'),
    })
    expect(brief(clips(single.state.doc, 'video'))).toEqual([['A', 0, 10, 0, 1]])

    const none = convertClassicProject(classic({ items: [item('weg')] }), {})
    expect(none.state.doc.tracks).toEqual([])
    expect(none.missingMedia).toBe(1)
  })

  it('Texte und Grafiken: Zeiten im Originalvideo -> Timeline, auf den Clip begrenzt', () => {
    const text = (t: string, start: number, end: number) => ({ text: t, start, end, size: 0.08 })
    const r = convertClassicProject(
      classic({
        items: [
          item('a', { start: 2, end: 6 }),
          item('b', {
            speed: 1, // 2×
            texts: [
              text('Mitte', 2, 4),
              text('Überlappt', 3, 6),
              text('Rand', 8, 99),
              text('  ', 1, 2),
            ],
            graphics: [
              { kind: 'emoji', emoji: '👉', start: 0, end: 2, animSpeed: 2 },
              { kind: 'image', image: 'img7', start: 4, end: 8 },
            ],
          }),
        ],
        images: {
          img7: { asset: 'a'.repeat(64), name: 'foto.png', type: 'image/png' },
          unbenutzt: { asset: 'b'.repeat(64), name: 'x.png', type: 'image/png' },
        },
      }),
      { a: view('A'), b: view('B') },
    )
    const doc = r.state.doc
    expect(validateDoc(doc)).toEqual([])
    // Video b beginnt bei 4 s und läuft doppelt so schnell (10 s -> 5 s).
    const overlay = clips(doc, 'overlay')
    const of = (kind: string) =>
      overlay
        .filter((c) => c.kind === kind)
        .map((c) => [c.start / S, c.duration / S])
        .sort((x, y) => x[0] - y[0])
    expect(of('text')).toEqual([
      [5, 1],
      [5.52, 1.48], // 5,5 s liegt bei 25 Bildern/s nicht auf dem Raster
      [8, 1],
    ])
    expect(of('graphic')).toEqual([
      [4, 1],
      [6, 2],
    ])
    // Überlappende Einblendungen liegen auf verschiedenen Spuren.
    expect(track(doc, 'overlay').length).toBeGreaterThanOrEqual(2)
    const mitte = overlay.find((c) => 'data' in c && c.data.text === 'Mitte')
    expect(mitte && 'data' in mitte ? mitte.data : null).toMatchObject({
      text: 'Mitte',
      size: 0.08,
    })
    expect(mitte && 'data' in mitte ? Object.keys(mitte.data) : []).not.toContain('start')
    const emoji = overlay.find((c) => 'data' in c && c.data.kind === 'emoji')
    expect(emoji && 'data' in emoji ? emoji.data : null).toMatchObject({
      emoji: '👉',
      animSpeed: 2,
    })
    expect(usedImageIds(doc)).toEqual(['img7'])
    expect(r.state.images.img7.asset).toBe('a'.repeat(64))
  })

  it('Ausgabeformat und was noch nicht übernommen wird', () => {
    const r = convertClassicProject(
      classic({
        items: [item('a'), item('b')],
        seams: [{ from: 0, to: 1, preset: 'slide' }],
        output: { aspect: '9:16', fill: 'blur' },
        music: { asset: 'c'.repeat(64), name: 'musik.mp3', type: 'audio/mpeg' },
        audioFade: { fadeIn: { enabled: true, duration: 2, curve: 'tri' } },
        editor: { startTime: 0, endTime: 5, crop: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 } },
      }),
      { a: view('A'), b: view('B') },
    )
    expect(r.state.doc.settings).toMatchObject({ width: 1080, height: 1920, fps: 25 })
    expect(r.skipped.sort()).toEqual(['crop', 'music'])
    // Übergang der Nahtstelle liegt am Anfang des zweiten Clips (Dauer aus der Animation).
    expect(
      clips(r.state.doc, 'video').map((c) => ('transitionIn' in c ? c.transitionIn : null)),
    ).toEqual([null, { preset: 'slide', duration: 2_000_000 }])
    // Ton-Blende: Einblenden am ersten Ton-Clip .
    const sound = clips(r.state.doc, 'audio') as { fadeIn?: unknown; fadeOut?: unknown }[]
    expect(sound[0].fadeIn).toEqual({ duration: 2_000_000, curve: 'tri' })
    expect(sound.every((c) => c.fadeOut === undefined)).toBe(true)
    expect(sound.slice(1).every((c) => c.fadeIn === undefined)).toBe(true)
    // Ohne Ton-Clip (alles stumm) bleibt die Blende „nicht übernommen“.
    const silent = convertClassicProject(
      classic({
        items: [item('a', { muted: true })],
        audioFade: { fadeOut: { enabled: true, duration: 1, curve: 'exp' } },
      }),
      { a: view('A') },
    )
    expect(silent.skipped).toEqual(['audioFade'])
    // Ist das Video markiert, wandert der Zuschnitt an seinen Clip.
    const withSelection = convertClassicProject(
      classic({
        items: [item('a'), item('b')],
        selected: 1,
        editor: { startTime: 0, endTime: 5, crop: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 } },
      }),
      { a: view('A'), b: view('B') },
    )
    expect(withSelection.skipped).toEqual([])
    expect(
      clips(withSelection.state.doc, 'video').map((c) => ('crop' in c ? c.crop : null)),
    ).toEqual([null, { x: 0.1, y: 0.1, width: 0.5, height: 0.5 }])
    // Die Clips überlappen nicht: Der Übergang liegt im zweiten Clip.
    expect(brief(clips(r.state.doc, 'video'))).toEqual([
      ['A', 0, 10, 0, 1],
      ['B', 10, 10, 0, 1],
    ])

    // Globale Animation zählt als Übergang, sobald zwei Videos zusammenkommen.
    const global = convertClassicProject(
      parseProjectState({ version: 1, items: [item('a'), item('b')], anim: { animation: 'fade' } }),
      { a: view('A'), b: view('B') },
    )
    expect(global.skipped).toEqual([])
    expect(
      clips(global.state.doc, 'video').map((c) => ('transitionIn' in c ? c.transitionIn : null)),
    ).toEqual([null, { preset: 'fade', duration: 2_000_000 }])
    // Eine Nahtstelle mit „kein Übergang“ gewinnt gegen die globale Animation.
    const cut = convertClassicProject(
      parseProjectState({
        version: 1,
        items: [item('a'), item('b')],
        seams: [{ from: 0, to: 1, preset: 'none' }],
        anim: { animation: 'fade' },
      }),
      { a: view('A'), b: view('B') },
    )
    expect(clips(cut.state.doc, 'video').every((c) => !('transitionIn' in c))).toBe(true)
    const one = convertClassicProject(
      parseProjectState({ version: 1, items: [item('a')], anim: { animation: 'fade' } }),
      { a: view('A') },
    )
    expect(one.skipped).toEqual([])
  })

  it('krumme Bildraten und Zeiten bleiben gültig (Bildraster, Quellende)', () => {
    const r = convertClassicProject(
      classic({
        items: [
          item('a', { start: 0.333, end: 7.777, speed: 1.5 }),
          item('b', { start: 1.01, speed: -2.5, at: 2.9 }),
        ],
      }),
      { a: view('A', { fps: 29.97, duration: 7.78 }), b: view('B', { duration: 3.123 }) },
    )
    expect(validateDoc(r.state.doc)).toEqual([])
    expect(clips(r.state.doc, 'video')).toHaveLength(2)
  })

  it('Hintergrundmusik: eigene Spur ab 0, Schleife, Blende und Lautstärken', () => {
    const song = view('M', { name: 'musik.mp3', duration: 3, width: 0, height: 0, kind: 'audio' })
    const music = { asset: 'c'.repeat(64), name: 'musik.mp3', type: 'audio/mpeg' }
    const r = convertClassicProject(
      classic({
        items: [item('a', { end: 8 })],
        music: { ...music, volume: 0.4, originalVolume: 0.5 },
      }),
      { a: view('A') },
      song,
    )
    const doc = r.state.doc
    expect(validateDoc(doc)).toEqual([])
    expect(r.skipped).toEqual([])
    expect(Object.keys(r.media).sort()).toEqual(['A', 'M'])
    expect(doc.assets.M.kind).toBe('audio')
    const [original, lane] = track(doc, 'audio')
    expect(original.clips.map((c) => ('gain' in c ? c.gain : null))).toEqual([0.5])
    // 8 s Video, 3 s Musik in Schleife: 3 + 3 + 2 s.
    expect(brief([...lane.clips])).toEqual([
      ['M', 0, 3, 0, 1],
      ['M', 3, 3, 0, 1],
      ['M', 6, 2, 0, 1],
    ])
    const sound = lane.clips as { gain: number; fadeIn?: unknown; fadeOut?: unknown }[]
    expect(sound.map((c) => c.gain)).toEqual([0.4, 0.4, 0.4])
    // Blende 2 s (ein Viertel von 8 s) am Anfang und am Ende der Musik.
    expect(sound.map((c) => c.fadeIn)).toEqual([
      { duration: 2_000_000, curve: 'tri' },
      undefined,
      undefined,
    ])
    expect(sound.map((c) => c.fadeOut)).toEqual([
      undefined,
      undefined,
      { duration: 2_000_000, curve: 'tri' },
    ])

    // Ohne Schleife und Blende, längere Musik: auf die Länge des Videos gekürzt.
    const plain = convertClassicProject(
      classic({ items: [item('a', { end: 8 })], music: { ...music, loop: false, fade: false } }),
      { a: view('A') },
      { ...song, duration: 30 },
    )
    const second = track(plain.state.doc, 'audio')[1].clips as Clip[]
    expect(brief(second)).toEqual([['M', 0, 8, 0, 1]])
    expect('fadeIn' in second[0] || 'fadeOut' in second[0]).toBe(false)
    expect(track(plain.state.doc, 'audio')[0].clips.map((c) => ('gain' in c ? c.gain : 0))).toEqual(
      [1],
    )

    // Musik nicht ladbar: ausgelassen und gemeldet.
    const none = convertClassicProject(classic({ items: [item('a')], music }), { a: view('A') })
    expect(none.skipped).toEqual(['music'])
    expect(track(none.state.doc, 'audio')).toHaveLength(1)
  })
})
