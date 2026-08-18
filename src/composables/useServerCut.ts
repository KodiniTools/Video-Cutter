import { ref } from 'vue'
import type { TrimMode } from '@/lib/ffmpegCommand'

/**
 * Basis-URL des Backends.
 * - Produktion: VITE_API_BASE=/videoschneiden -> Aufrufe unter /videoschneiden/api/*
 * - Entwicklung: leer lassen, Vite proxyt /api auf den Dev-Server.
 */
const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? ''

interface JobEvent {
  state: 'processing' | 'done' | 'error'
  progress: number
  error: string | null
}

// Singleton-Zustand, damit die UI den Fortschritt beobachten kann.
const isProcessing = ref(false)
const progress = ref(0)

async function readError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: string }
    return data.error ?? `Serverfehler (${res.status}).`
  } catch {
    return `Serverfehler (${res.status}).`
  }
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
 * @param duration Länge des Ausschnitts in Sekunden (end - start).
 */
async function cut(file: File, start: number, duration: number, mode: TrimMode): Promise<Blob> {
  isProcessing.value = true
  progress.value = 0
  try {
    const form = new FormData()
    form.append('video', file)
    form.append('start', String(start))
    form.append('duration', String(duration))
    form.append('mode', mode)

    const res = await fetch(`${API_BASE}/api/cut`, { method: 'POST', body: form })
    if (!res.ok) throw new Error(await readError(res))

    const { jobId } = (await res.json()) as { jobId: string }
    await waitForJob(jobId)

    const download = await fetch(`${API_BASE}/api/cut/${jobId}/download`)
    if (!download.ok) throw new Error(await readError(download))
    return await download.blob()
  } finally {
    isProcessing.value = false
  }
}

export function useServerCut() {
  return { isProcessing, progress, cut }
}
