import { encodeWav, mixToMono } from './wav'

/** Kürzeste brauchbare Aufnahme in Sekunden. */
export const MIN_RECORDING_SEC = 0.3
export const RECORDING_TOO_SHORT = 'RECORDING_TOO_SHORT'

/** Kann dieser Browser mit dem Mikrofon aufnehmen? */
export function canRecord(): boolean {
  return (
    typeof MediaRecorder !== 'undefined' &&
    typeof AudioContext !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function'
  )
}

/**
 * Aufnahme des Browsers (WebM/Opus, MP4 …) in eine WAV-Datei wandeln. Die
 * Dateien des Browsers tragen oft keine Länge im Kopf; WAV hat eine genaue
 * Länge und der Server liest es ohne Umwege.
 */
export async function recordingToWav(recording: Blob, name: string): Promise<File> {
  const ctx = new AudioContext()
  try {
    const audio = await ctx.decodeAudioData(await recording.arrayBuffer())
    if (audio.duration < MIN_RECORDING_SEC) throw new Error(RECORDING_TOO_SHORT)
    const channels = Array.from({ length: audio.numberOfChannels }, (_, i) =>
      audio.getChannelData(i),
    )
    const wav = encodeWav(mixToMono(channels), audio.sampleRate)
    return new File([wav], name, { type: 'audio/wav' })
  } finally {
    void ctx.close().catch(() => {})
  }
}
