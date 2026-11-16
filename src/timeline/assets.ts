import type { MediaView } from '@/lib/mediaApi'
import { secondsToTime, type AssetRef } from './model'

/** Hochgeladenes Video bzw. hochgeladene Tondatei der Server-Bibliothek als Medium der Timeline. */
export function assetFromMedia(media: MediaView): AssetRef {
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
