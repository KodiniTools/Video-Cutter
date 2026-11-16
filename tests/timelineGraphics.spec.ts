import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { MissingGraphicsError, parseMissingGraphics, uploadGraphic } from '@/lib/graphicsApi'
import { registerImageAssetForTest } from '@/lib/imageAssets'
import { parsePreviewPlan } from '@/lib/previewApi'
import { startRender } from '@/lib/renderApi'
import { useTimelineStore } from '@/stores/timeline'
import {
  clipGraphic,
  GraphicImages,
  isDrawable,
  newGraphicData,
  newImageData,
  TIMELINE_GRAPHIC_KINDS,
} from '@/timeline/graphics'
import { createDoc, type TimelineDoc } from '@/timeline/model'

const s = (seconds: number) => Math.round(seconds * 1_000_000)

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

afterEach(() => vi.unstubAllGlobals())

describe('clipGraphic', () => {
  it('füllt Fehlendes mit dem Standard der Art und hält Grenzen ein', () => {
    const g = clipGraphic({ kind: 'arrow', w: 9, rotation: 'schief', x: 0.2 })
    expect(g).toMatchObject({ kind: 'arrow', w: 2, rotation: 0, x: 0.2, y: 0.5, animSpeed: 1 })
    expect(g.strokeWidth).toBeGreaterThan(0)
  })

  it('fällt bei unbekannter Art auf das Rechteck zurück und kennt Bilder', () => {
    expect(clipGraphic({ kind: 'video' }).kind).toBe('rect')
    expect(clipGraphic({}).kind).toBe('rect')
    expect(clipGraphic(newImageData('img-x'))).toMatchObject({
      kind: 'image',
      image: 'img-x',
      strokeWidth: 0,
      opacity: 1,
    })
    expect(clipGraphic({ ...newImageData('img-x'), cropL: 0.9, opacity: 0 })).toMatchObject({
      cropL: 0.45,
      opacity: 0.05,
    })
    for (const kind of TIMELINE_GRAPHIC_KINDS)
      expect(clipGraphic(newGraphicData(kind))).toMatchObject({ kind, x: 0.5, y: 0.5 })
  })

  it('hält ein Emoji ohne Zeichen für nicht zeichenbar', () => {
    expect(isDrawable(clipGraphic({ kind: 'emoji', emoji: ' ' }))).toBe(false)
    expect(isDrawable(clipGraphic({ kind: 'emoji', emoji: '🚀' }))).toBe(true)
    expect(isDrawable(clipGraphic({ kind: 'rect' }))).toBe(true)
    // Bilder nur, solange sie im Browser geladen sind.
    expect(isDrawable(clipGraphic(newImageData('fehlt')))).toBe(false)
    registerImageAssetForTest({
      id: 'img-test',
      name: 'logo.png',
      source: {} as CanvasImageSource,
      width: 400,
      height: 200,
    })
    expect(isDrawable(clipGraphic(newImageData('img-test')))).toBe(true)
  })
})

describe('Store: Grafik anlegen', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('legt die Grafik am Abspielkopf auf eine Ebenen-Spur und markiert sie', () => {
    const store = useTimelineStore()
    store.seek(s(1))
    const id = store.addGraphic(newGraphicData('ellipse'), s(3))
    expect(id).not.toBeNull()
    expect(store.selection).toEqual([id])
    expect(store.doc.tracks[0]).toMatchObject({ kind: 'overlay', name: 'G1' })
    expect(store.doc.tracks[0].clips[0]).toMatchObject({
      kind: 'graphic',
      start: s(1),
      duration: s(3),
      data: { kind: 'ellipse', x: 0.5, y: 0.5 },
    })
    // Zur selben Zeit: Der Text braucht eine eigene Spur darüber.
    store.addText({ text: 'Hallo' }, s(3))
    expect(store.doc.tracks.map((t) => t.name)).toEqual(['T1', 'G1'])
    store.undo()
    store.undo()
    expect(store.doc.tracks).toHaveLength(0)
  })
})

describe('GraphicImages', () => {
  function docWith(...datas: Array<Record<string, unknown>>): TimelineDoc {
    const doc = createDoc()
    return {
      ...doc,
      tracks: [
        {
          id: 'G1',
          kind: 'overlay',
          name: 'G1',
          locked: false,
          hidden: false,
          clips: datas.map((data, i) => ({
            id: `g${i}`,
            kind: 'graphic' as const,
            start: s(i * 2),
            duration: s(1),
            data,
          })),
        },
      ],
    }
  }
  const setup = () => {
    let n = 0
    const draw = vi.fn(async () => new Blob(['png']))
    const upload = vi.fn(async () => ({ id: `id${++n}` }))
    return { images: new GraphicImages(upload, draw), draw, upload }
  }

  it('lässt Dokumente ohne Grafiken unverändert', async () => {
    const { images, draw } = setup()
    const doc = createDoc()
    expect(await images.prepare(doc)).toBe(doc)
    expect(draw).not.toHaveBeenCalled()
  })

  it('zeichnet gleiches Aussehen nur einmal und schreibt die ID nur in die Kopie', async () => {
    const { images, draw, upload } = setup()
    const rect = newGraphicData('rect')
    // Zweiter Clip: gleiche Form an anderer Stelle mit anderer Animation.
    const doc = docWith(rect, { ...rect, x: 0.2, animation: 'pop' }, newGraphicData('arrow'))
    const sent = await images.prepare(doc)
    expect(draw).toHaveBeenCalledTimes(2)
    expect(upload).toHaveBeenCalledTimes(2)
    const datas = sent.tracks[0].clips.map((c) => (c as { data: Record<string, unknown> }).data)
    expect(datas[0]).toEqual({
      kind: 'rect',
      x: 0.5,
      y: 0.5,
      animation: 'fade',
      loop: 'none',
      animSpeed: 1,
      png: 'id1',
      renderHeight: doc.settings.height,
    })
    expect(datas[1]).toMatchObject({ png: 'id1', x: 0.2, animation: 'pop' })
    expect(datas[2]).toMatchObject({ png: 'id2', kind: 'arrow' })
    expect((doc.tracks[0].clips[0] as { data: Record<string, unknown> }).data.png).toBeUndefined()

    // Noch einmal: nichts neu zeichnen. Andere Projekthöhe: neues Bild.
    await images.prepare(doc)
    expect(draw).toHaveBeenCalledTimes(2)
    await images.prepare({ ...doc, settings: { ...doc.settings, height: 720 } })
    expect(draw).toHaveBeenCalledTimes(4)
  })

  it('lässt Emojis ohne Zeichen aus und lädt Vergessenes neu hoch', async () => {
    const { images, upload } = setup()
    const doc = docWith({ ...newGraphicData('emoji'), emoji: '' }, newGraphicData('ellipse'))
    const sent = await images.prepare(doc)
    expect((sent.tracks[0].clips[0] as { data: Record<string, unknown> }).data.png).toBeUndefined()
    expect(sent.tracks[0].clips[1]).toMatchObject({ data: { png: 'id1' } })
    images.forget(['anderes'])
    await images.prepare(doc)
    expect(upload).toHaveBeenCalledTimes(1)
    images.forget(['id1'])
    expect((await images.prepare(doc)).tracks[0].clips[1]).toMatchObject({ data: { png: 'id2' } })
  })

  it('zeichnet Bilder je Bearbeitung neu und lässt nicht geladene aus', async () => {
    const { images, draw } = setup()
    registerImageAssetForTest({
      id: 'img-a',
      name: 'a.png',
      source: {} as CanvasImageSource,
      width: 400,
      height: 200,
    })
    const image = newImageData('img-a')
    const doc = docWith(image, { ...image, cropL: 0.2 }, newImageData('img-weg'))
    const sent = await images.prepare(doc)
    expect(draw).toHaveBeenCalledTimes(2)
    const pngs = sent.tracks[0].clips.map((c) => (c as { data: Record<string, unknown> }).data.png)
    expect(pngs).toEqual(['id1', 'id2', undefined])
    expect(sent.tracks[0].clips[0]).toMatchObject({ data: { kind: 'image' } })
  })

  it('reicht Fehler weiter und versucht es beim nächsten Mal erneut', async () => {
    const upload = vi
      .fn<() => Promise<{ id: string }>>()
      .mockRejectedValueOnce(new Error('kaputt'))
      .mockResolvedValue({ id: 'ok' })
    const images = new GraphicImages(upload, async () => new Blob(['png']))
    const doc = docWith(newGraphicData('rect'))
    await expect(images.prepare(doc)).rejects.toThrow('kaputt')
    expect((await images.prepare(doc)).tracks[0].clips[0]).toMatchObject({ data: { png: 'ok' } })
  })
})

describe('Server-Antworten', () => {
  it('liest fehlende Grafiken aus Plan und Export', async () => {
    expect(parseMissingGraphics(['a', 1, '', 'b'])).toEqual(['a', 'b'])
    expect(parseMissingGraphics('a')).toEqual([])
    expect(parsePreviewPlan({ segments: [], missingGraphics: ['x'] }).missingGraphics).toEqual([
      'x',
    ])
    expect(parsePreviewPlan({ segments: [] }).missingGraphics).toEqual([])

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(409, { error: 'Grafik fehlt.', missingGraphics: ['x'] })),
    )
    const error = await startRender(createDoc(), { quality: 'standard', name: 'a' }).catch(
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(MissingGraphicsError)
    expect((error as MissingGraphicsError).ids).toEqual(['x'])
  })

  it('lädt ein PNG hoch und erkennt ein veraltetes Backend', async () => {
    const fetchMock = vi.fn(async () => json(200, { id: 'abc', width: 10, height: 5 }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await uploadGraphic(new Blob(['x']))).toEqual({ id: 'abc', width: 10, height: 5 })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/api/graphics')
    expect(init.headers).toEqual({ 'Content-Type': 'image/png' })

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(404, { error: 'Nicht gefunden.' })),
    )
    await expect(uploadGraphic(new Blob(['x']))).rejects.toThrow('GRAPHICS_UNSUPPORTED')
  })
})
