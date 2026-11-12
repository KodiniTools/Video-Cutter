import { execFile } from 'node:child_process'
import { config } from '../config'

/** Für das Zusammenfügen relevante Eckdaten einer Mediendatei. */
export interface MediaInfo {
  /** Angezeigte Breite/Höhe in px (Rotation bereits berücksichtigt), 0 = unbekannt. */
  width: number
  height: number
  /** Enthält die Datei eine Tonspur? */
  hasAudio: boolean
  /** Dauer in Sekunden, 0 = unbekannt. */
  duration: number
}

interface ProbeStream {
  codec_type?: string
  width?: number
  height?: number
  tags?: { rotate?: string }
  side_data_list?: Array<{ rotation?: number | string }>
}

/**
 * Wertet die JSON-Ausgabe von ffprobe aus. Rein (ohne Prozess) und daher
 * direkt testbar. Hochkant-Videos (Rotation ±90°) liefern ffprobe-Maße VOR der
 * Drehung – FFmpeg dreht beim Dekodieren automatisch, also Breite/Höhe tauschen.
 */
export function parseProbeOutput(json: string): MediaInfo {
  let data: { streams?: ProbeStream[]; format?: { duration?: string } }
  try {
    data = JSON.parse(json) as typeof data
  } catch {
    throw new Error('ffprobe lieferte ungültige Daten.')
  }
  const streams = Array.isArray(data.streams) ? data.streams : []
  const video = streams.find((s) => s.codec_type === 'video')
  const hasAudio = streams.some((s) => s.codec_type === 'audio')

  let width = Number(video?.width) || 0
  let height = Number(video?.height) || 0
  const rotation = Number(
    video?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ??
      video?.tags?.rotate ??
      0,
  )
  if (Number.isFinite(rotation) && Math.abs(rotation) % 180 === 90) {
    ;[width, height] = [height, width]
  }

  const d = Number(data.format?.duration)
  return { width, height, hasAudio, duration: Number.isFinite(d) && d > 0 ? d : 0 }
}

/** Liest Auflösung, Tonspur und Dauer per ffprobe (spawn ohne Shell). */
export function probeMedia(filePath: string): Promise<MediaInfo> {
  return new Promise((resolve, reject) => {
    execFile(
      config.ffprobePath,
      [
        '-v',
        'error',
        '-show_entries',
        'stream=codec_type,width,height:stream_tags=rotate:stream_side_data=rotation:format=duration',
        '-of',
        'json',
        filePath,
      ],
      { timeout: 30_000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          reject(new Error('Video konnte nicht analysiert werden.'))
          return
        }
        try {
          resolve(parseProbeOutput(stdout))
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)))
        }
      },
    )
  })
}
