import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { DEFAULT_TEXT_DURATION } from '@/lib/textOverlay'
import {
  MAX_GRAPHICS,
  MIN_GRAPHIC_DURATION,
  clampGraphic,
  defaultGraphic,
  type GraphicAddExtra,
  type GraphicData,
  type GraphicKind,
  type GraphicOverlay,
} from '@/lib/graphicOverlay'
import { pruneImageAssets } from '@/lib/imageAssets'

const EMPTY: GraphicOverlay[] = []

/**
 * Grafik-Einblendungen (Formen, Linien, Symbole, Emojis) je Bibliotheks-Video
 * – aufgebaut wie der Text-Store: bleiben beim Videowechsel erhalten und
 * werden nach dem Einbrennen für dieses Video geleert.
 */
export const useGraphicOverlayStore = defineStore('graphicOverlays', () => {
  const byItem = ref<Record<number, GraphicOverlay[]>>({})
  const itemId = ref<number | null>(null)
  const selectedId = ref<number | null>(null)
  let nextId = 1
  /** Bilder, die (z. B. der Rückgängig-Verlauf) noch braucht, obwohl keine Grafik sie nutzt. */
  let retainedImages: ReadonlySet<string> = new Set()

  const overlays = computed<GraphicOverlay[]>(() =>
    itemId.value === null ? [] : (byItem.value[itemId.value] ?? []),
  )
  const selected = computed(() => overlays.value.find((o) => o.id === selectedId.value) ?? null)
  const canAdd = computed(() => itemId.value !== null && overlays.value.length < MAX_GRAPHICS)

  function setItem(id: number | null): void {
    if (itemId.value === id) return
    itemId.value = id
    selectedId.value = null
  }

  function write(list: GraphicOverlay[]): void {
    if (itemId.value === null) return
    const hadImages = overlays.value.some((o) => o.kind === 'image')
    byItem.value = { ...byItem.value, [itemId.value]: list }
    if (hadImages) pruneUnusedImages()
  }

  /** Bilder freigeben, die keine Grafik (in keinem Video) mehr nutzt. */
  function pruneUnusedImages(): void {
    const used: string[] = [...retainedImages]
    for (const list of Object.values(byItem.value)) {
      for (const o of list) if (o.kind === 'image') used.push(o.image)
    }
    pruneImageAssets(used)
  }

  /**
   * Neue Grafik ab `at` (Sekunden), in der Bildmitte. Farben/Kontur übernimmt
   * sie von der zuletzt gewählten Grafik derselben Art (einheitlicher Look).
   */
  function add(
    kind: GraphicKind,
    at: number,
    duration: number,
    extra: GraphicAddExtra = {},
  ): GraphicOverlay | null {
    if (!canAdd.value) return null
    const total = duration > 0 ? duration : Infinity
    let start = Math.max(0, at)
    if (total - start < MIN_GRAPHIC_DURATION) start = Math.max(0, total - DEFAULT_TEXT_DURATION)
    const end = Math.min(total, start + DEFAULT_TEXT_DURATION)
    const same = [...overlays.value].reverse().find((o) => o.kind === kind)
    const look = same
      ? (({ id: _id, start: _s, end: _e, x: _x, y: _y, ...rest }) => rest)(same)
      : defaultGraphic(kind)
    const g: GraphicOverlay = clampGraphic({
      ...look,
      ...extra,
      kind,
      id: nextId++,
      start,
      end,
      x: 0.5,
      y: 0.5,
    })
    write([...overlays.value, g])
    selectedId.value = g.id
    return g
  }

  /** Ändert eine Grafik; Werte werden in gültige Bereiche gebracht. */
  function update(id: number, patch: Partial<GraphicData>): void {
    write(overlays.value.map((o) => (o.id === id ? clampGraphic({ ...o, ...patch }) : o)))
  }

  /** Kopie (leicht versetzt) – praktisch für mehrere gleiche Markierungen. */
  function duplicate(id: number): void {
    const o = overlays.value.find((x) => x.id === id)
    if (!o || !canAdd.value) return
    const copy = clampGraphic({ ...o, id: nextId++, x: o.x + 0.03, y: o.y + 0.03 })
    write([...overlays.value, copy])
    selectedId.value = copy.id
  }

  function remove(id: number): void {
    write(overlays.value.filter((o) => o.id !== id))
    if (selectedId.value === id) selectedId.value = null
  }

  function select(id: number | null): void {
    selectedId.value = id !== null && overlays.value.some((o) => o.id === id) ? id : null
  }

  /** Grafiken eines bestimmten Videos (für Rückgängig/Wiederholen). */
  function listFor(id: number): GraphicOverlay[] {
    return byItem.value[id] ?? EMPTY
  }

  /** Ersetzt die Grafiken eines bestimmten Videos (Rückgängig/Wiederholen). */
  function setListFor(id: number, list: GraphicOverlay[]): void {
    const next = { ...byItem.value }
    if (list.length) next[id] = list
    else delete next[id]
    byItem.value = next
    if (itemId.value === id && !list.some((o) => o.id === selectedId.value)) {
      selectedId.value = null
    }
    pruneUnusedImages()
  }

  /**
   * Hält Bilder vor, die der Verlauf noch braucht (gelöschte Bild-Grafik
   * wiederherstellen). Nicht mehr benötigte werden dabei freigegeben.
   */
  function setRetainedImages(ids: Iterable<string>): void {
    retainedImages = new Set(ids)
    pruneUnusedImages()
  }

  /** Übernimmt gespeicherte Grafiken (Projekt öffnen) mit neuen IDs. */
  function importFor(id: number, list: GraphicOverlay[]): void {
    setListFor(
      id,
      list.map((o) => clampGraphic({ ...o, id: nextId++ })),
    )
  }

  function clearItem(id: number): void {
    if (!(id in byItem.value)) return
    const next = { ...byItem.value }
    delete next[id]
    byItem.value = next
    if (itemId.value === id) selectedId.value = null
    pruneUnusedImages()
  }

  return {
    overlays,
    selected,
    selectedId,
    itemId,
    canAdd,
    setItem,
    add,
    update,
    duplicate,
    remove,
    select,
    clearItem,
    listFor,
    setListFor,
    importFor,
    setRetainedImages,
  }
})
