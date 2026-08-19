import { ref } from 'vue'
import type { TrimMode } from '@/lib/ffmpegCommand'
import type { CutOperation } from '@/stores/videoEditor'

/**
 * Basis-URL des Backends.
 * - Produktion: VITE_API_BASE=/video-cutter -> Aufrufe unter /video-cutter/api/*
 * - Entwicklung: leer lassen, Vite proxyt /api auf den Dev-Server.
 */
const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? ''

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
    xhr.open('POST', `${API_BASE}/api/cut`)

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded, e.total)
    }

    xhr.onload = () => {
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

    xhr.onerror = () => reject(new Error('Upload fehlgeschlagen (Netzwerkfehler).'))
    xhr.onabort = () => reject(new Error('Upload abgebrochen.'))

    xhr.send(form)
  })
}

/** Wartet via SSE bis der Job fertig ist; aktualisiert `progress`. */
function waitForJob(jobId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const source = new EventSource(`${API_BASE}/api/cut/${jobId}/events`)
    let settled = false

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
        source.close()
        resolve()
      } else if (data.state === 'error') {
        settled = true
        source.close()
        reject(new Error(data.error ?? 'Serverseitiger Schnitt fehlgeschlagen.'))
      }
    }

    source.onerror = () => {
      if (settled) return
      settled = true
      source.close()
      reject(new Error('Verbindung zum Server unterbrochen.'))
    }
  })
}

/**
 * Schneidet ein Video serverseitig.
 * @param duration  Länge der Auswahl in Sekunden (end - start).
 * @param operation 'keep' behält die Auswahl, 'remove' entfernt sie.
 * @param total     Gesamtdauer des Videos (nur für 'remove' nötig).
 */
async function cut(
  file: File,
  start: number,
  duration: number,
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
  try {
    const form = new FormData()
    form.append('video', file)
    form.append('start', String(start))
    form.append('duration', String(duration))
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

    // Upload fertig -> serverseitige Verarbeitung (Fortschritt via SSE).
    phase.value = 'process'
    progress.value = 0
    await waitForJob(jobId)

    const download = await fetch(`${API_BASE}/api/cut/${jobId}/download`)
    if (!download.ok) throw new Error(await readError(download))
    return await download.blob()
  } finally {
    isProcessing.value = false
    phase.value = 'idle'
  }
}

export function useServerCut() {
  return { isProcessing, progress, phase, uploadedBytes, totalBytes, bytesPerSec, cut }
}
