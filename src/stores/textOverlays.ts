import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  DEFAULT_TEXT_DURATION,
  DEFAULT_TEXT_STYLE,
  MAX_TEXT_OVERLAYS,
  MAX_TEXT_SIZE,
  MIN_TEXT_DURATION,
  MIN_TEXT_SIZE,
  type TextOverlay,
  type TextOverlayData,
} from '@/lib/textOverlay'

const EMPTY: TextOverlay[] = []

/**
 * Text-Einblendungen je Bibliotheks-Video (Schlüssel = lokale Listen-ID).
 * Beim Wechsel des Videos bleiben die Texte erhalten; nach dem Einbrennen
 * werden sie für dieses Video geleert (sie sind dann Teil des Bildes).
 */
export const useTextOverlayStore = defineStore('textOverlays', () => {
  const byItem = ref<Record<number, TextOverlay[]>>({})
  /** Video, dessen Texte gerade bearbeitet werden (= markiertes Video). */
  const itemId = ref<number | null>(null)
  const selectedId = ref<number | null>(null)
  let nextId = 1

  const overlays = computed<TextOverlay[]>(() =>
    itemId.value === null ? [] : (byItem.value[itemId.value] ?? []),
  )
  const selected = computed(() => overlays.value.find((o) => o.id === selectedId.value) ?? null)
  const canAdd = computed(() => itemId.value !== null && overlays.value.length < MAX_TEXT_OVERLAYS)

  function setItem(id: number | null): void {
    if (itemId.value === id) return
    itemId.value = id
    selectedId.value = null
  }

  function write(list: TextOverlay[]): void {
    if (itemId.value === null) return
    byItem.value = { ...byItem.value, [itemId.value]: list }
  }

  /**
   * Neuer Text ab `at` (Sekunden). Übernimmt das Design des zuletzt gewählten
   * Textes, damit mehrere Untertitel einheitlich aussehen.
   */
  function add(at: number, duration: number, text: string): TextOverlay | null {
    if (!canAdd.value) return null
    const total = duration > 0 ? duration : Infinity
    let start = Math.max(0, at)
    // Am Videoende: Bereich nach vorne verschieben, damit er gültig bleibt.
    if (total - start < MIN_TEXT_DURATION) start = Math.max(0, total - DEFAULT_TEXT_DURATION)
    const end = Math.min(total, start + DEFAULT_TEXT_DURATION)
    const template = selected.value ?? overlays.value[overlays.value.length - 1] ?? null
    const { x, y, font, size, color, style, accent, animation } = template ?? DEFAULT_TEXT_STYLE
    const o: TextOverlay = {
      id: nextId++,
      text,
      start,
      end,
      x,
      y,
      font,
      size,
      color,
      style,
      accent,
      animation,
    }
    write([...overlays.value, o])
    selectedId.value = o.id
    return o
  }

  /**
   * Fügt viele Texte auf einmal hinzu (z. B. KI-Untertitel). Design wie der
   * zuletzt gewählte Text, sonst Untertitel-Standard (unten, ohne Animation).
   * `replace` verwirft vorher alle Texte des Videos. Liefert die Anzahl.
   */
  function addMany(cues: { start: number; end: number; text: string }[], replace: boolean): number {
    if (itemId.value === null) return 0
    const base = replace ? [] : overlays.value
    const template = replace
      ? null
      : (selected.value ?? overlays.value[overlays.value.length - 1] ?? null)
    const { x, y, font, size, color, style, accent, animation } = template ?? {
      ...DEFAULT_TEXT_STYLE,
      animation: 'none' as const,
    }
    const room = Math.max(0, MAX_TEXT_OVERLAYS - base.length)
    const added: TextOverlay[] = cues.slice(0, room).map((c) => ({
      id: nextId++,
      text: c.text,
      start: Math.max(0, c.start),
      end: c.end,
      x,
      y,
      font,
      size,
      color,
      style,
      accent,
      animation,
    }))
    write([...base, ...added].sort((a, b) => a.start - b.start))
    selectedId.value = null
    return added.length
  }

  /** Ändert einen Text; Werte werden in gültige Bereiche gebracht. */
  function update(id: number, patch: Partial<TextOverlayData>): void {
    write(
      overlays.value.map((o) => {
        if (o.id !== id) return o
        const n = { ...o, ...patch }
        n.x = Math.min(1, Math.max(0, n.x))
        n.y = Math.min(1, Math.max(0, n.y))
        n.size = Math.min(MAX_TEXT_SIZE, Math.max(MIN_TEXT_SIZE, n.size))
        n.start = Math.max(0, n.start)
        return n
      }),
    )
  }

  function remove(id: number): void {
    write(overlays.value.filter((o) => o.id !== id))
    if (selectedId.value === id) selectedId.value = null
  }

  function select(id: number | null): void {
    selectedId.value = id !== null && overlays.value.some((o) => o.id === id) ? id : null
  }

  /** Texte eines bestimmten Videos (für Rückgängig/Wiederholen). */
  function listFor(id: number): TextOverlay[] {
    return byItem.value[id] ?? EMPTY
  }

  /** Ersetzt die Texte eines bestimmten Videos (Rückgängig/Wiederholen). */
  function setListFor(id: number, list: TextOverlay[]): void {
    const next = { ...byItem.value }
    if (list.length) next[id] = list
    else delete next[id]
    byItem.value = next
    if (itemId.value === id && !list.some((o) => o.id === selectedId.value)) {
      selectedId.value = null
    }
  }

  /** Alle Texte eines Videos verwerfen (z. B. nach dem Einbrennen oder Löschen). */
  function clearItem(id: number): void {
    if (!(id in byItem.value)) return
    const next = { ...byItem.value }
    delete next[id]
    byItem.value = next
    if (itemId.value === id) selectedId.value = null
  }

  return {
    overlays,
    selected,
    selectedId,
    itemId,
    canAdd,
    setItem,
    add,
    addMany,
    update,
    remove,
    select,
    clearItem,
    listFor,
    setListFor,
  }
})
