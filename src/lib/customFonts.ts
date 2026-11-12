import { ref } from 'vue'
import { API_BASE } from './apiBase'

/**
 * Eigene Schriften für Text-Einblendungen. Die Dateien liegen in
 * src/assets/fonts; der Server liest denselben Ordner (deploy.sh kopiert ihn)
 * und liefert über GET /api/fonts, welche Schriften er einbrennen kann – samt
 * Messwerten, damit die Vorschau genau so groß und hoch sitzt wie im Video.
 * Angeboten werden nur Schriften, die Server UND Frontend kennen.
 */

/** Antwort-Eintrag von GET /api/fonts. */
export interface CustomFontInfo {
  key: string
  file: string
  group: string
  label: string
  weight: number
  italic: boolean
  lineRatio: number
  shift: number
}

/** Eigene Schrift mit URL der Datei im Frontend-Build. */
export interface CustomFont extends CustomFontInfo {
  url: string
  /** Familienname der Vorschau (@font-face). */
  css: string
}

// Alle Schriftdateien des Ordners; Vite liefert sie erst bei Bedarf aus.
const FILE_URLS = import.meta.glob('../assets/fonts/*.{woff2,woff,ttf,otf}', {
  query: '?url',
  import: 'default',
  eager: true,
}) as Record<string, string>

const urlByFile = new Map(
  Object.entries(FILE_URLS).map(([p, url]) => [p.slice(p.lastIndexOf('/') + 1), url]),
)

export function fontFileUrl(file: string): string | undefined {
  return urlByFile.get(file)
}

const num = (v: unknown, def: number) => (typeof v === 'number' && Number.isFinite(v) ? v : def)

/** Prüft die Server-Antwort; unbrauchbare Einträge und fehlende Dateien entfallen. */
export function parseFontList(data: unknown): CustomFont[] {
  const list = (data as { fonts?: unknown } | null)?.fonts
  if (!Array.isArray(list)) return []
  const out: CustomFont[] = []
  for (const raw of list) {
    const d = (raw ?? {}) as Record<string, unknown>
    if (typeof d.key !== 'string' || !d.key.startsWith('f:') || typeof d.file !== 'string') continue
    const url = fontFileUrl(d.file)
    if (!url) continue
    out.push({
      key: d.key,
      file: d.file,
      group: typeof d.group === 'string' ? d.group : d.key.slice(2),
      label: typeof d.label === 'string' ? d.label : 'Regular',
      weight: num(d.weight, 400),
      italic: d.italic === true,
      lineRatio: num(d.lineRatio, 1.2),
      shift: num(d.shift, 0),
      url,
      css: `VCF ${d.key.slice(2)}`,
    })
  }
  return out
}

/** Gruppiert nach Familie, Schnitte nach Stärke (aufrecht vor kursiv). */
export function groupFonts(fonts: CustomFont[]): { group: string; fonts: CustomFont[] }[] {
  const groups = new Map<string, CustomFont[]>()
  for (const f of fonts) groups.set(f.group, [...(groups.get(f.group) ?? []), f])
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([group, list]) => ({
      group,
      fonts: [...list].sort((a, b) => a.weight - b.weight || Number(a.italic) - Number(b.italic)),
    }))
}

// --- Laden (einmal pro Sitzung) ---------------------------------------------

const fonts = ref<CustomFont[]>([])
const byKey = new Map<string, CustomFont>()
let loading: Promise<void> | null = null

export function getCustomFont(key: string): CustomFont | undefined {
  return byKey.get(key)
}

/** Holt die Schriftliste vom Server. Fehler -> nur die Standardschriften. */
export function loadCustomFonts(): Promise<void> {
  if (!loading) {
    loading = (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/fonts`)
        if (!res.ok) return // altes Backend: keine eigenen Schriften
        const list = parseFontList(await res.json())
        byKey.clear()
        for (const f of list) byKey.set(f.key, f)
        fonts.value = list
      } catch {
        /* offline/alter Server: Standardschriften genügen */
      }
    })()
  }
  return loading
}

const registered = new Set<string>()

/** Registriert die Schrift für die Vorschau (lädt die Datei erst jetzt). */
export function ensureFontFace(f: CustomFont): void {
  if (registered.has(f.key) || typeof FontFace === 'undefined' || !document.fonts) return
  registered.add(f.key)
  const face = new FontFace(f.css, `url(${f.url})`)
  document.fonts.add(face)
  face.load().catch(() => registered.delete(f.key))
}

export function useCustomFonts() {
  return { fonts, loadCustomFonts }
}
