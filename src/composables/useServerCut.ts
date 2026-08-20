import { ref } from 'vue'
import type { TrimMode } from '@/lib/ffmpegCommand'
import type { CutOperation } from '@/stores/videoEditor'

/**
 * Basis-URL des Backends.
 * - Produktion: VITE_API_BASE=/video-cutter -> Aufrufe unter /video-cutter/api/*
 * - Entwicklung: leer lassen, Vite proxyt /api auf den Dev-Server.
 */
const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? ''

/** Fehler-Kennung für einen vom Nutzer abgebrochenen Vorgang. */
export const CUT_CANCELLED = 'CUT_CANCELLED'

interface JobEvent {
  state: 'processing' | 'done' | 'error'
  progress: number
  error: string | null
}

/** Aktuelle Phase für die UI: Upload der Datei oder serverseitige Verarbeitung. */
export type CutPhase = 'idle' | 'upload' | 'process'

// Singleton-Zustand, damit die UI den Fortschritt beobachten kann.
const isProcessing = ref(false)
const progress = ref(0)
const phase = ref<CutPhase>('idle')
// Upload-Statistik (nur während phase === 'upload' aussagekräftig).
const uploadedBytes = ref(0)
const totalBytes = ref(0)
const bytesPerSec = ref(0)

// Handles auf den aktuell laufenden Vorgang (für "Abbrechen").
let currentXhr: XMLHttpRequest | null = null
let currentSource: EventSource | null = null
let currentJobId: string | null = null
let rejectActive: ((reason: Error) => void) | null = null

async function readError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: string }
    return data.error ?? `Serverfehler (${res.status}).`
  } catch {
    return `Serverfehler (${res.status}).`
  }
}

/**
 * Lädt die Datei per XHR hoch (im Gegensatz zu fetch liefert XHR echten
 * Upload-Fortschritt) und legt den Job an. Gibt die jobId zurück.
 */
function uploadForJob(
  form: FormData,
  onProgress: (loaded: number, total: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    currentXhr = xhr
    rejectActive = reject
    const cleanup = () => {
      if (currentXhr === xhr) currentXhr = null
      if (rejectActive === reject) rejectActive = null
    }
    xhr.open('POST', `${API_BASE}/api/cut`)

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded, e.total)
    }

    xhr.onload = () => {
      cleanup()
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const data = JSON.parse(xhr.responseText) as { jobId?: string }
          if (data.jobId) resolve(data.jobId)
          else reject(new Error('Ungültige Serverantwort (keine jobId).'))
        } catch {
          reject(new Error('Ungültige Serverantwort.'))
        }
      } else {
        let msg = `Serverfehler (${xhr.status}).`
        try {
          const data = JSON.parse(xhr.responseText) as { error?: string }
          if (data.error) msg = data.error
        } catch {
          /* Rohantwort ohne JSON – Standardmeldung behalten. */
        }
        reject(new Error(msg))
      }
    }

    xhr.onerror = () => {
      cleanup()
      reject(new Error('Upload fehlgeschlagen (Netzwerkfehler).'))
    }
    // Abbruch wird zentral über cancel() abgewickelt (rejectActive).
    xhr.onabort = () => cleanup()

    xhr.send(form)
  })
}

/** Wartet via SSE bis der Job fertig ist; aktualisiert `progress`. */
function waitForJob(jobId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const source = new EventSource(`${API_BASE}/api/cut/${jobId}/events`)
    currentSource = source
    rejectActive = reject
    let settled = false
    const cleanup = () => {
      if (currentSource === source) currentSource = null
      if (rejectActive === reject) rejectActive = null
    }

    source.onmessage = (ev) => {
      let data: JobEvent
      try {
        data = JSON.parse(ev.data) as JobEvent
      } catch {
        return // Heartbeat/Kommentarzeilen ignorieren
      }
      progress.value = data.progress
      if (data.state === 'done') {
        settled = true
        cleanup()
        source.close()
        resolve()
      } else if (data.state === 'error') {
        settled = true
        cleanup()
        source.close()
        reject(new Error(data.error ?? 'Serverseitiger Schnitt fehlgeschlagen.'))
      }
    }

    source.onerror = () => {
      if (settled) return
      settled = true
      cleanup()
      source.close()
      reject(new Error('Verbindung zum Server unterbrochen.'))
    }
  })
}

/** Bricht den laufenden Upload/Job ab (Nutzer-Aktion). */
function cancel(): void {
  const rej = rejectActive
  rejectActive = null
  if (currentXhr) {
    currentXhr.abort()
    currentXhr = null
  }
  if (currentSource) {
    currentSource.close()
    currentSource = null
  }
  // Serverseitigen Job beenden (laufenden ffmpeg-Prozess stoppen).
  if (currentJobId) {
    fetch(`${API_BASE}/api/cut/${currentJobId}`, { method: 'DELETE' }).catch(() => {})
  }
  rej?.(new Error(CUT_CANCELLED))
}

/** Ein Ausschnitt für den Server: Start + Länge in Sekunden. */
export interface CutSegment {
  start: number
  duration: number
}

/**
 * Schneidet ein Video serverseitig.
 * @param segments  Ein oder mehrere Ausschnitte ({ start, duration }).
 * @param operation 'keep' behält die Ausschnitte, 'remove' entfernt sie.
 * @param total     Gesamtdauer des Videos (nur für 'remove' nötig).
 */
async function cut(
  file: File,
  segments: CutSegment[],
  mode: TrimMode,
  operation: CutOperation = 'keep',
  total = 0,
): Promise<Blob> {
  isProcessing.value = true
  phase.value = 'upload'
  progress.value = 0
  uploadedBytes.value = 0
  totalBytes.value = 0
  bytesPerSec.value = 0
  currentJobId = null
  try {
    const form = new FormData()
    form.append('video', file)
    form.append('segments', JSON.stringify(segments))
    form.append('mode', mode)
    form.append('operation', operation)
    if (operation === 'remove') form.append('total', String(total))

    // Geglättete Upload-Geschwindigkeit aus den Fortschritts-Deltas.
    let lastTime = 0
    let lastLoaded = 0
    const jobId = await uploadForJob(form, (loaded, tot) => {
      progress.value = tot > 0 ? Math.round((loaded / tot) * 100) : 0
      uploadedBytes.value = loaded
      totalBytes.value = tot
      const now = performance.now()
      if (lastTime && now - lastTime > 300) {
        const inst = ((loaded - lastLoaded) / (now - lastTime)) * 1000 // Bytes/s
        bytesPerSec.value = bytesPerSec.value ? bytesPerSec.value * 0.7 + inst * 0.3 : inst
        lastTime = now
        lastLoaded = loaded
      } else if (!lastTime) {
        lastTime = now
        lastLoaded = loaded
      }
    })
    currentJobId = jobId

    // Upload fertig -> serverseitige Verarbeitung (Fortschritt via SSE).
    phase.value = 'process'
    progress.value = 0
    await waitForJob(jobId)

    const download = await fetch(`${API_BASE}/api/cut/${jobId}/download`)
    if (!download.ok) throw new Error(await readError(download))
    currentJobId = null
    return await download.blob()
  } finally {
    isProcessing.value = false
    phase.value = 'idle'
    currentJobId = null
  }
}

export function useServerCut() {
  return { isProcessing, progress, phase, uploadedBytes, totalBytes, bytesPerSec, cut, cancel }
}
