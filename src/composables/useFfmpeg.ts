import { ref } from 'vue'
import { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile, toBlobURL } from '@ffmpeg/util'
import { buildTrimArgs, getExtension, type TrimMode } from '@/lib/ffmpegCommand'

/**
 * Basis-URL des ffmpeg-core (Single-Thread, ESM).
 * Für Produktion selbst hosten und via VITE_FFMPEG_CORE_URL überschreiben,
 * damit keine externe CDN nötig ist (Privacy / Zuverlässigkeit).
 */
const CORE_BASE =
  (import.meta.env.VITE_FFMPEG_CORE_URL as string | undefined) ??
  'https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm'

// --- Singleton-Zustand auf Modulebene (eine FFmpeg-Instanz pro Tab) ---
let ffmpeg: FFmpeg | null = null
const isLoaded = ref(false)
const isLoading = ref(false)
const isProcessing = ref(false)
const progress = ref(0)
const logLine = ref('')

async function load(): Promise<void> {
  if (isLoaded.value || isLoading.value) return
  isLoading.value = true
  progress.value = 0
  try {
    const instance = new FFmpeg()
    instance.on('log', ({ message }) => {
      logLine.value = message
    })
    instance.on('progress', ({ progress: p }) => {
      progress.value = Math.min(100, Math.max(0, Math.round(p * 100)))
    })
    // toBlobURL umgeht COEP-Probleme mit fremden Origins.
    await instance.load({
      coreURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, 'application/wasm'),
    })
    ffmpeg = instance
    isLoaded.value = true
  } finally {
    isLoading.value = false
  }
}

async function trim(file: File, start: number, end: number, mode: TrimMode): Promise<Blob> {
  if (!ffmpeg || !isLoaded.value) {
    throw new Error('FFmpeg ist nicht geladen.')
  }

  const inExt = getExtension(file.name)
  const outExt = mode === 'copy' ? inExt : 'mp4'
  const inputName = `input.${inExt}`
  const outputName = `output.${outExt}`

  isProcessing.value = true
  progress.value = 0
  try {
    await ffmpeg.writeFile(inputName, await fetchFile(file))
    const args = buildTrimArgs({ inputName, outputName, start, end, mode })

    const code = await ffmpeg.exec(args)
    if (typeof code === 'number' && code !== 0) {
      throw new Error(`FFmpeg-Fehler (Exit-Code ${code}). Bei "copy" evtl. inkompatibler Container – versuche den Modus "genau".`)
    }

    const data = await ffmpeg.readFile(outputName)
    if (typeof data === 'string' || data.length === 0) {
      throw new Error('FFmpeg hat keine Ausgabedatei erzeugt.')
    }

    // Aufräumen im virtuellen FS (Fehler hier sind unkritisch).
    await ffmpeg.deleteFile(inputName).catch(() => {})
    await ffmpeg.deleteFile(outputName).catch(() => {})

    const mime = outExt === 'mp4' ? 'video/mp4' : `video/${outExt}`
    return new Blob([new Uint8Array(data)], { type: mime })
  } finally {
    isProcessing.value = false
  }
}

export function useFfmpeg() {
  return { isLoaded, isLoading, isProcessing, progress, logLine, load, trim }
}
