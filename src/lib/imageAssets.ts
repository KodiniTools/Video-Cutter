/**
 * Hochgeladene Bilder (JPEG, PNG, WebP) für Bild-Einblendungen.
 *
 * Die Bilder bleiben im Browser: Sie werden einmal dekodiert und hier unter
 * einer ID abgelegt. Eine Grafik vom Typ `image` verweist nur auf diese ID;
 * beim Einbrennen zeichnet der Browser das bearbeitete Bild (Zuschnitt,
 * Größe, Rahmen, Drehung …) als PNG, genau wie bei Formen. Der Server sieht
 * also nie das Original, nur das fertige PNG mit Alphakanal.
 */

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const
export const IMAGE_ACCEPT = IMAGE_TYPES.join(',')
/** Größte Bilddatei (Bytes). */
export const MAX_IMAGE_FILE_BYTES = 30 * 1024 * 1024
/** Größte Kantenlänge des Originals (px). */
export const MAX_IMAGE_DIM = 12000

export interface ImageAsset {
  id: string
  name: string
  source: CanvasImageSource
  width: number
  height: number
  /** Originaldatei (zum Speichern im Projekt). */
  file?: File
}

export class ImageAssetError extends Error {
  constructor(
    public readonly code: 'type' | 'size' | 'decode' | 'dim',
    message: string,
  ) {
    super(message)
    this.name = 'ImageAssetError'
  }
}

const assets = new Map<string, ImageAsset>()
let counter = 0

export function getImageAsset(id: string): ImageAsset | undefined {
  return id ? assets.get(id) : undefined
}

export function hasImageAsset(id: string): boolean {
  return !!id && assets.has(id)
}

/** Prüft Typ und Größe; wirft ImageAssetError. */
export function checkImageFile(file: { type: string; size: number }): void {
  if (!(IMAGE_TYPES as readonly string[]).includes(file.type)) {
    throw new ImageAssetError('type', 'Nur JPEG, PNG oder WebP.')
  }
  if (file.size > MAX_IMAGE_FILE_BYTES) throw new ImageAssetError('size', 'Bild zu groß.')
}

async function decode(file: File): Promise<{ source: CanvasImageSource; w: number; h: number }> {
  // createImageBitmap beachtet die EXIF-Ausrichtung (Handyfotos).
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' })
      return { source: bmp, w: bmp.width, h: bmp.height }
    } catch {
      // Fallback unten (z. B. ältere Browser ohne Optionen).
    }
  }
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    return { source: img, w: img.naturalWidth, h: img.naturalHeight }
  } catch {
    URL.revokeObjectURL(url)
    throw new ImageAssetError('decode', 'Bild kann nicht gelesen werden.')
  }
  // Die Object-URL bleibt bestehen, solange das Bild genutzt wird (siehe prune).
}

/** Datei prüfen, dekodieren und registrieren. Liefert das Asset. */
export async function addImageAsset(file: File): Promise<ImageAsset> {
  checkImageFile(file)
  const { source, w, h } = await decode(file)
  if (!(w > 0 && h > 0)) throw new ImageAssetError('decode', 'Bild kann nicht gelesen werden.')
  if (w > MAX_IMAGE_DIM || h > MAX_IMAGE_DIM) {
    release(source)
    throw new ImageAssetError('dim', 'Bild zu groß.')
  }
  const asset: ImageAsset = {
    id: `img${++counter}`,
    name: file.name,
    source,
    width: w,
    height: h,
    file,
  }
  assets.set(asset.id, asset)
  return asset
}

function release(source: CanvasImageSource): void {
  if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) source.close()
  else if (typeof HTMLImageElement !== 'undefined' && source instanceof HTMLImageElement) {
    if (source.src.startsWith('blob:')) URL.revokeObjectURL(source.src)
  }
}

/** Gibt alle Bilder frei, auf die keine Grafik mehr verweist. */
export function pruneImageAssets(used: Iterable<string>): void {
  const keep = new Set(used)
  for (const [id, a] of assets) {
    if (keep.has(id)) continue
    release(a.source)
    assets.delete(id)
  }
}

/** Nur für Tests: Asset direkt registrieren. */
export function registerImageAssetForTest(asset: ImageAsset): void {
  assets.set(asset.id, asset)
}
