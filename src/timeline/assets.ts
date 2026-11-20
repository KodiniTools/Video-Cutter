import type { MediaView } from '@/lib/mediaApi'
import { secondsToTime, type AssetRef } from './model'

/**
 * Hochgeladenes Video, Tondatei oder Bild der Server-Bibliothek als Medium der
 * Timeline. Bilder haben keine Länge; Bild-Clips (Grafiken der Art `image`)
 * verweisen über `data.image` auf sie.
 */
export function assetFromMedia(media: MediaView): AssetRef {
  if (media.kind === 'image')
    return {
      id: media.id,
      kind: 'image',
      name: media.name,
      duration: null,
      width: media.width,
      height: media.height,
    }
  if (media.kind === 'audio')
    return {
      id: media.id,
      kind: 'audio',
      name: media.name,
      duration: secondsToTime(media.duration),
      hasAudio: true,
    }
  return {
    id: media.id,
    kind: 'video',
    name: media.name,
    duration: secondsToTime(media.duration),
    width: media.width,
    height: media.height,
    fps: media.fps,
    hasAudio: media.hasAudio,
  }
}
