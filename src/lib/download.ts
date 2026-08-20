/**
 * Plattformübergreifender Datei-Download.
 *
 * Problem: Auf iOS/iPadOS-Safari löst `<a download>` mit einer Blob-URL keinen
 * echten Download aus, sondern öffnet die Datei im selben Tab.
 *
 * Strategie (in dieser Reihenfolge):
 *  0. Chromium (Desktop/Android) -> "Speichern unter"-Dialog
 *     (File System Access API): Nutzer wählt Ordner UND Namen selbst.
 *  1. iOS/iPadOS + Web Share (Level 2) -> nativer Teilen-Dialog
 *     ("In Dateien sichern" / "Video sichern").
 *  2. Alle übrigen Plattformen -> programmatischer `<a download>`-Klick.
 *  3. iOS ohne Teilen -> neuer Tab (dort per Halten -> "Sichern" speicherbar).
 *
 * WICHTIG: Muss aus einem Klick-Handler (Nutzergeste) aufgerufen werden,
 * damit `navigator.share` die nötige Aktivierung hat.
 */

export interface DownloadableFile {
  blob: Blob
  name: string
}

/** Erkennt iPhone/iPad/iPod inkl. iPadOS (meldet sich als "Macintosh"). */
export function isAppleMobile(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent || ''
  const iOS = /iPad|iPhone|iPod/.test(ua)
  const iPadOS =
    ua.includes('Macintosh') && typeof document !== 'undefined' && 'ontouchend' in document
  return iOS || iPadOS
}

/** Kann diese Datei über den nativen Dialog geteilt werden? */
export function canShareFile(file: File): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.canShare === 'function' &&
    typeof navigator.share === 'function' &&
    navigator.canShare({ files: [file] })
  )
}

async function shareFile(file: File): Promise<boolean> {
  try {
    await navigator.share({ files: [file], title: file.name })
    return true
  } catch (err) {
    // Abbruch durch den Nutzer gilt als erledigt (kein Fallback nötig).
    if (err instanceof DOMException && err.name === 'AbortError') return true
    return false
  }
}

// --- "Speichern unter"-Dialog (File System Access API) -------------------
// Nur Chromium (Chrome/Edge/Opera, Desktop + Android). Der Nutzer wählt
// Ordner UND Dateinamen selbst. Firefox/Safari/iOS: nicht verfügbar -> Fallback.

interface SavePickerType {
  description?: string
  accept: Record<string, string[]>
}
interface SavePickerOptions {
  suggestedName?: string
  types?: SavePickerType[]
}
interface WritableLike {
  write: (data: Blob) => Promise<void>
  close: () => Promise<void>
}
interface FileHandleLike {
  createWritable: () => Promise<WritableLike>
}
type ShowSaveFilePicker = (opts?: SavePickerOptions) => Promise<FileHandleLike>

function fileExtension(name: string): string {
  const m = /\.([a-zA-Z0-9]{1,5})$/.exec(name)
  return m ? m[1].toLowerCase() : ''
}

/**
 * Öffnet den nativen "Speichern unter"-Dialog und schreibt den Blob dorthin.
 * @returns true, wenn gespeichert ODER vom Nutzer abgebrochen wurde (kein
 *          weiterer Fallback nötig); false, wenn die API fehlt/fehlschlägt.
 */
async function savePickerDownload(blob: Blob, name: string): Promise<boolean> {
  const picker = (window as unknown as { showSaveFilePicker?: ShowSaveFilePicker })
    .showSaveFilePicker
  if (typeof picker !== 'function') return false

  const mime = blob.type || 'video/mp4'
  const ext = fileExtension(name)
  const types: SavePickerType[] = ext
    ? [{ description: 'Video', accept: { [mime]: [`.${ext}`] } }]
    : []

  try {
    const handle = await picker({ suggestedName: name, types })
    const writable = await handle.createWritable()
    await writable.write(blob)
    await writable.close()
    return true
  } catch (err) {
    // Nutzer hat den Dialog abgebrochen -> als erledigt behandeln.
    if (err instanceof DOMException && err.name === 'AbortError') return true
    // Sonstiger Fehler -> Aufrufer soll den klassischen Download versuchen.
    return false
  }
}

function anchorDownload(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.rel = 'noopener'
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  // Verzögert aufräumen, damit der Klick sicher verarbeitet wurde.
  setTimeout(() => {
    a.remove()
    URL.revokeObjectURL(url)
  }, 1000)
}

function openInNewTab(blob: Blob): void {
  const url = URL.createObjectURL(blob)
  window.open(url, '_blank', 'noopener')
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/**
 * Speichert die Datei mit der jeweils zuverlässigsten Methode.
 * @returns true, wenn ein Weg ausgeführt wurde.
 */
export async function saveFile({ blob, name }: DownloadableFile): Promise<boolean> {
  const file = new File([blob], name, { type: blob.type || 'video/mp4' })
  const apple = isAppleMobile()

  // 0) "Speichern unter"-Dialog (Chromium): Nutzer wählt Ort + Name selbst.
  if (!apple) {
    if (await savePickerDownload(blob, name)) return true
  }

  // 1) iOS/iPadOS: nativer Teilen-Dialog
  if (apple && canShareFile(file)) {
    if (await shareFile(file)) return true
  }

  // 2) Desktop/Android ohne Picker: klassischer Download
  if (!apple) {
    anchorDownload(blob, name)
    return true
  }

  // 3) iOS ohne Teilen (oder abgelehnt): neuer Tab als Ausweg
  openInNewTab(blob)
  return true
}
