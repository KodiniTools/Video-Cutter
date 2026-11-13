import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  canvasSize,
  clampGraphic,
  defaultGraphic,
  graphicFrame,
  isValidGraphic,
  imageHeight,
  lookKey,
  serverGraphicBytes,
  shadowPad,
  shapeExtent,
  stackOrder,
  MAX_CROP,
  MAX_GRAPHICS,
  MIN_IMAGE_OPACITY,
  type GraphicData,
} from '@/lib/graphicOverlay'
import {
  ImageAssetError,
  checkImageFile,
  hasImageAsset,
  pruneImageAssets,
  registerImageAssetForTest,
} from '@/lib/imageAssets'
import { useGraphicOverlayStore } from '@/stores/graphicOverlays'

const g = (p: Partial<GraphicData> = {}): GraphicData => ({
  ...defaultGraphic('rect'),
  start: 1,
  end: 4,
  x: 0.5,
  y: 0.5,
  ...p,
})

describe('Grafik-Geometrie', () => {
  it('Rechteck: Kontur liegt zur Hälfte außen', () => {
    const e = shapeExtent(g({ w: 0.5, h: 0.2, strokeWidth: 0.01 }), 1000)
    expect(e).toEqual({ left: -255, right: 255, top: -105, bottom: 105 })
  })

  it('Bildgröße symmetrisch um den Mittelpunkt, Drehung vergrößert die Box', () => {
    const e = { left: -50, right: 50, top: -10, bottom: 30 }
    expect(canvasSize(e, 0)).toEqual({ width: 104, height: 64 })
    const r = canvasSize(e, 90)
    expect(r).toEqual({ width: 64, height: 104 })
    expect(canvasSize(e, 45).width).toBeGreaterThan(104 * 0.7)
  })

  it('Sprechblase: Zipfel ragt unten heraus', () => {
    const e = shapeExtent(g({ kind: 'bubble', w: 0.4, h: 0.2, strokeWidth: 0 }), 1000)
    expect(e.bottom).toBeGreaterThan(-e.top)
  })

  it('Pfeil: Spitze breiter als die Linie', () => {
    const e = shapeExtent(g({ kind: 'arrow', w: 0.3, strokeWidth: 0.01 }), 1000)
    expect(e.bottom).toBeGreaterThan(5)
  })
})

describe('clampGraphic / isValidGraphic', () => {
  it('bringt Werte in gültige Bereiche', () => {
    const c = clampGraphic(g({ x: 2, y: -1, w: 99, h: 0, rotation: 270, fillOpacity: 3 }))
    expect(c).toMatchObject({ x: 1, y: 0, w: 2, h: 0.02, rotation: -90, fillOpacity: 1 })
    expect(clampGraphic(g({ kind: 'line', strokeWidth: 0 })).strokeWidth).toBeGreaterThan(0)
    expect(clampGraphic(g({ rotation: -180 })).rotation).toBe(180)
  })

  it('Zeitbereich und Emoji-Inhalt', () => {
    expect(isValidGraphic(g(), 10)).toBe(true)
    expect(isValidGraphic(g({ start: 9.9, end: 12 }), 10)).toBe(false)
    expect(isValidGraphic(g({ kind: 'emoji', emoji: ' ' }), 10)).toBe(false)
  })

  it('Bild-Schlüssel ignoriert Position und Zeit', () => {
    expect(lookKey(g({ x: 0.1, start: 0 }), 720)).toBe(lookKey(g({ x: 0.9, start: 2 }), 720))
    expect(lookKey(g({ rotation: 10 }), 720)).not.toBe(lookKey(g(), 720))
  })
})

describe('graphicFrame (wie die FFmpeg-Filter des Servers)', () => {
  it('fade: 400 ms ein/aus, außerhalb unsichtbar', () => {
    const o = g({ animation: 'fade' })
    expect(graphicFrame(o, 0.5).visible).toBe(false)
    expect(graphicFrame(o, 1.2).opacity).toBeCloseTo(0.5)
    expect(graphicFrame(o, 2).opacity).toBe(1)
    expect(graphicFrame(o, 3.8).opacity).toBeCloseTo(0.5)
    expect(graphicFrame(o, 4).visible).toBe(false)
  })

  it('slide: gleitet in 500 ms von +6 % zur Position', () => {
    const o = g({ animation: 'slide' })
    expect(graphicFrame(o, 1).dy).toBeCloseTo(0.06)
    expect(graphicFrame(o, 1.25).dy).toBeCloseTo(0.03)
    expect(graphicFrame(o, 1.6).dy).toBe(0)
  })

  it('none: sofort voll sichtbar', () => {
    expect(graphicFrame(g({ animation: 'none' }), 1)).toEqual({ visible: true, opacity: 1, dy: 0 })
  })
})

describe('Grafik-Store', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('fügt je Video hinzu, übernimmt den Look derselben Art, leert nach dem Einbrennen', () => {
    const s = useGraphicOverlayStore()
    expect(s.add('rect', 0, 10)).toBeNull() // kein Video gewählt
    s.setItem(1)
    const a = s.add('rect', 2, 10)!
    expect(a).toMatchObject({ start: 2, end: 5, x: 0.5, y: 0.5 })
    s.update(a.id, { stroke: '#00ff00', x: 0.2 })
    const b = s.add('rect', 3, 10)!
    expect(b.stroke).toBe('#00ff00')
    expect(b.x).toBe(0.5)
    const e = s.add('emoji', 9.95, 10, { emoji: '🚀' })!
    expect(e.emoji).toBe('🚀')
    expect(e.end - e.start).toBeGreaterThanOrEqual(0.2)
    s.duplicate(b.id)
    expect(s.overlays).toHaveLength(4)
    s.setItem(2)
    expect(s.overlays).toHaveLength(0)
    s.setItem(1)
    s.clearItem(1)
    expect(s.overlays).toHaveLength(0)
  })

  it('Höchstzahl', () => {
    const s = useGraphicOverlayStore()
    s.setItem(1)
    for (let i = 0; i < MAX_GRAPHICS; i++) s.add('ellipse', 0, 10)
    expect(s.canAdd).toBe(false)
    expect(s.add('ellipse', 0, 10)).toBeNull()
  })
})

describe('Bilder (hochgeladene JPEG/PNG/WebP)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    pruneImageAssets([])
    registerImageAssetForTest({
      id: 'imgA',
      name: 'logo.png',
      source: {} as CanvasImageSource,
      width: 400,
      height: 200,
    })
  })

  const img = (p: Partial<GraphicData> = {}) =>
    g({ ...defaultGraphic('image'), image: 'imgA', ...p })

  it('Höhe folgt dem Seitenverhältnis nach dem Zuschnitt, Rahmen liegt außen', () => {
    expect(imageHeight(img({ w: 0.5 }))).toBeCloseTo(0.25)
    // Rechts 25 % weg -> 300x200 -> Höhe = 0.5 * 200/300
    expect(imageHeight(img({ w: 0.5, cropR: 0.25 }))).toBeCloseTo(1 / 3)
    const e = shapeExtent(img({ w: 0.5, strokeWidth: 0.01 }), 1000)
    expect(e).toEqual({ left: -260, right: 260, top: -135, bottom: 135 })
  })

  it('Schatten vergrößert das Bild symmetrisch, nur wenn aktiv', () => {
    expect(shadowPad(img(), 1000)).toBe(0)
    expect(shadowPad(img({ shadow: true }), 1000)).toBeGreaterThan(0)
    expect(shadowPad(g({ shadow: true }), 1000)).toBe(0) // nur Bilder
  })

  it('clamp: Zuschnitt, Deckkraft, Schalter', () => {
    const c = clampGraphic(
      img({ cropL: 0.9, cropT: -1, opacity: 0, flipX: 'x' as unknown as boolean }),
    )
    expect(c).toMatchObject({ cropL: MAX_CROP, cropT: 0, opacity: MIN_IMAGE_OPACITY, flipX: false })
  })

  it('ungültig ohne geladenes Bild; Look-Schlüssel enthält Bildwerte', () => {
    expect(isValidGraphic(img(), 10)).toBe(true)
    expect(isValidGraphic(img({ image: 'fehlt' }), 10)).toBe(false)
    expect(lookKey(img({ cropL: 0.1 }), 720)).not.toBe(lookKey(img(), 720))
    expect(lookKey(img({ opacity: 0.5 }), 720)).not.toBe(lookKey(img(), 720))
  })

  it('Ebenen: Bilder unten, sonst Reihenfolge der Liste', () => {
    const list = [g({ kind: 'arrow' }), img(), g({ kind: 'emoji' }), img({ w: 0.2 })]
    expect(stackOrder(list).map((o) => o.kind)).toEqual(['image', 'image', 'arrow', 'emoji'])
  })

  it('Store gibt Bilder frei, die keine Grafik mehr nutzt', () => {
    const s = useGraphicOverlayStore()
    s.setItem(1)
    const a = s.add('image', 0, 10, { image: 'imgA', w: 0.4 })!
    expect(a.w).toBe(0.4)
    s.duplicate(a.id)
    s.remove(a.id)
    expect(hasImageAsset('imgA')).toBe(true) // Kopie nutzt es noch
    s.clearItem(1)
    expect(hasImageAsset('imgA')).toBe(false)
  })

  it('PNG-Größe aus der Data-URL', () => {
    expect(serverGraphicBytes({ png: 'data:image/png;base64,AAAA' })).toBe(3)
    expect(serverGraphicBytes({ png: 'data:image/png;base64,AAA=' })).toBe(2)
  })
})

describe('checkImageFile', () => {
  it('nur JPEG/PNG/WebP bis 30 MB', () => {
    expect(() => checkImageFile({ type: 'image/webp', size: 1000 })).not.toThrow()
    expect(() => checkImageFile({ type: 'image/gif', size: 1000 })).toThrow(ImageAssetError)
    expect(() => checkImageFile({ type: 'image/png', size: 31 * 1024 * 1024 })).toThrow(
      ImageAssetError,
    )
  })
})
