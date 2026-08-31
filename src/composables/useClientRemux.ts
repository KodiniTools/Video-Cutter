/**
 * Client-seitiger „Copy"-Remux (Prototyp).
 *
 * Für den verlustfreien Einzel-Ausschnitt (siehe {@link isClientRemuxEligible})
 * schneidet der Browser das Video selbst: MP4Box.js parst den Container, wir
 * kopieren die bereits kodierten Samples des keyframe-ausgerichteten Fensters
 * (KEIN Re-Encode) in eine neue MP4 und geben sie als Blob zurück. Damit
 * entfällt der komplette Upload/Download – analog zum Audio-Cutter, der WAV/MP3
 * lokal erzeugt.
 *
 * Sicherheitsnetz: Wirft der Remux (unbekannter Codec, exotischer Container,
 * Speicher), fällt der Aufrufer auf den Server-Schnitt zurück. Der Fast-Path
 * ist damit reine Beschleunigung, nie ein Korrektheitsrisiko.
 *
 * Grenzen des Prototyps (siehe docs/client-remux-plan.md):
 *  - nur ISO-BMFF (MP4/MOV), Codecs mit bekannter Konfig-Box (AVC/HEVC/AV1/…),
 *  - Datei + Samples liegen im RAM (kein Streaming) → sehr große Dateien besser
 *    weiterhin am Server,
 *  - Ausgabe ist fragmentiertes MP4 (spielt überall, gewünschtenfalls später
 *    „flach" schreiben).
 */
import { ref } from 'vue'
import { createFile, type ISOFile, type MP4Info, type MP4Sample, type MP4Track } from 'mp4box'
import { selectSampleWindow, selectAudioWindow, type TimedSample } from '@/lib/remux'

/** Codec-Konfig-Boxen, die wir unverändert in den Ziel-Track übernehmen. */
const CONFIG_BOX_TYPES = new Set(['avcC', 'hvcC', 'vpcC', 'av1C', 'esds', 'dvcC', 'dvvC'])

export interface RemuxOptions {
  signal?: AbortSignal
  onProgress?: (fraction: number) => void
}

export interface RemuxResult {
  blob: Blob
  /** Tatsächliche (keyframe-ausgerichtete) Start-/Endzeit in Sekunden. */
  startTime: number
  endTime: number
}

// Singleton-Fortschritt für die UI (analog useServerCut).
const isProcessing = ref(false)
const progress = ref(0)

let activeController: AbortController | null = null

/** Bricht einen laufenden Remux ab. */
function cancel(): void {
  activeController?.abort()
}

/** Sucht die Codec-Konfigurations-Box in einem stsd-Eintrag. */
function findConfigBox(entry: { boxes: Array<{ type: string }> }): { type: string } | null {
  for (const box of entry.boxes) {
    if (CONFIG_BOX_TYPES.has(box.type)) return box
  }
  return null
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Abgebrochen.', 'AbortError')
}

/** Parst die Datei und liefert Info + geladenes ISOFile. */
function parseFile(file: File): Promise<{ input: ISOFile; info: MP4Info }> {
  return new Promise((resolve, reject) => {
    const input = createFile(true)
    input.onError = (e) => reject(new Error(`MP4Box: ${e}`))
    input.onReady = (info) => resolve({ input, info })
    file
      .arrayBuffer()
      .then((buf) => {
        const ab = buf as ArrayBuffer & { fileStart?: number }
        ab.fileStart = 0
        input.appendBuffer(ab)
        // Kein flush(): würde Puffer verwerfen, die die Sample-Extraktion braucht.
      })
      .catch(reject)
  })
}

/** Zieht ALLE Samples der gewünschten Tracks aus dem geparsten ISOFile. */
function extractSamples(input: ISOFile, trackIds: number[]): Map<number, MP4Sample[]> {
  const collected = new Map<number, MP4Sample[]>()
  for (const id of trackIds) collected.set(id, [])
  input.onSamples = (id, _user, samples) => {
    const arr = collected.get(id)
    if (arr) for (const s of samples) arr.push(s)
  }
  for (const id of trackIds)
    input.setExtractionOptions(id, null, { nbSamples: Number.MAX_SAFE_INTEGER })
  input.start()
  input.flush() // stellt sicher, dass die letzten Samples ausgeliefert werden
  return collected
}

/** MP4Sample[] -> TimedSample[] (Zeiten in Sekunden) für die reine Fensterlogik. */
function toTimed(samples: MP4Sample[]): TimedSample[] {
  return samples.map((s) => ({
    cts: s.cts / s.timescale,
    dts: s.dts / s.timescale,
    isSync: !!s.is_sync,
  }))
}

/** Fügt einen Track aus Original-Konfig + Samplefenster in die Ausgabe ein. */
function copyTrack(
  input: ISOFile,
  output: ISOFile,
  track: MP4Track,
  samples: MP4Sample[],
  first: number,
  last: number,
  signal?: AbortSignal,
): void {
  const trak = input.getTrackById(track.id)
  const entry = trak?.mdia.minf.stbl.stsd.entries[0]
  if (!entry) throw new Error(`Track ${track.id}: kein stsd-Eintrag.`)
  const description = findConfigBox(entry)
  if (!description) throw new Error(`Track ${track.id}: unbekannte Codec-Konfig (${entry.type}).`)

  const isVideo = track.type === 'video' || !!track.video
  const width = track.video?.width ?? track.track_width ?? 0
  const height = track.video?.height ?? track.track_height ?? 0

  const newTrackId = output.addTrack({
    type: entry.type,
    timescale: track.timescale,
    description,
    ...(isVideo
      ? { width, height }
      : {
          samplerate: track.audio?.sample_rate,
          channel_count: track.audio?.channel_count,
          samplesize: track.audio?.sample_size,
        }),
  })
  if (newTrackId === undefined)
    throw new Error(`Track ${track.id}: addTrack fehlgeschlagen (${entry.type}).`)

  // Zeiten auf den Fensteranfang normieren (erstes Sample startet bei 0).
  const baseline = samples[first].dts
  for (let i = first; i <= last; i++) {
    throwIfAborted(signal)
    const s = samples[i]
    output.addSample(newTrackId, s.data, {
      duration: s.duration,
      dts: Math.max(0, s.dts - baseline),
      cts: Math.max(0, s.cts - baseline),
      is_sync: s.is_sync,
    })
  }
}

/**
 * Remuxt [startSec, endSec] client-seitig zu einer neuen MP4.
 * @throws Error bei nicht unterstütztem Material; DOMException('AbortError') bei Abbruch.
 */
async function remux(
  file: File,
  startSec: number,
  endSec: number,
  opts: RemuxOptions = {},
): Promise<RemuxResult> {
  const controller = new AbortController()
  activeController = controller
  const signal = opts.signal
    ? (AbortSignal.any?.([opts.signal, controller.signal]) ?? controller.signal)
    : controller.signal

  isProcessing.value = true
  progress.value = 0
  try {
    throwIfAborted(signal)
    const { input, info } = await parseFile(file)

    const videoTrack = info.tracks.find((t) => t.type === 'video' || !!t.video)
    if (!videoTrack) throw new Error('Keine Video-Spur gefunden.')
    const audioTrack = info.tracks.find((t) => t.type === 'audio' || !!t.audio)

    const trackIds = [videoTrack.id, ...(audioTrack ? [audioTrack.id] : [])]
    const collected = extractSamples(input, trackIds)
    throwIfAborted(signal)

    const videoSamples = collected.get(videoTrack.id) ?? []
    if (videoSamples.length === 0) throw new Error('Keine Video-Samples extrahiert.')

    const win = selectSampleWindow(toTimed(videoSamples), startSec, endSec)
    if (!win) throw new Error('Kein keyframe-ausgerichtetes Fenster gefunden.')

    const output = createFile(true)
    copyTrack(input, output, videoTrack, videoSamples, win.firstIndex, win.lastIndex, signal)
    progress.value = 60

    if (audioTrack) {
      const audioSamples = collected.get(audioTrack.id) ?? []
      const awin = selectAudioWindow(toTimed(audioSamples), win.startTime, win.endTime)
      if (awin) {
        copyTrack(input, output, audioTrack, audioSamples, awin.firstIndex, awin.lastIndex, signal)
      }
    }
    progress.value = 90

    throwIfAborted(signal)
    const buffer = output.getBuffer()
    progress.value = 100
    opts.onProgress?.(1)

    return {
      blob: new Blob([buffer], { type: 'video/mp4' }),
      startTime: win.startTime,
      endTime: win.endTime,
    }
  } finally {
    isProcessing.value = false
    if (activeController === controller) activeController = null
  }
}

export function useClientRemux() {
  return { isProcessing, progress, remux, cancel }
}
