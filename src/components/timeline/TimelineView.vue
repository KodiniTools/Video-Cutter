<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { followScroll } from '@/timeline/follow'
import TimelineClip, { type ClipGrab } from './TimelineClip.vue'
import TrackHeader from './TrackHeader.vue'
import GraphicGallery from './GraphicGallery.vue'
import MarkerEffect from './MarkerEffect.vue'
import { addImageAsset, getImageAsset, IMAGE_ACCEPT, ImageAssetError } from '@/lib/imageAssets'
import { DEFAULT_TEXT_DURATION, DEFAULT_TEXT_STYLE } from '@/lib/textOverlay'
import type { GraphicSymbol } from '@/lib/graphicOverlay'
import { formatTimeMs } from '@/lib/timeFormat'
import { MAX_ZOOM, MIN_ZOOM, useTimelineStore } from '@/stores/timeline'
import { useTimelineBeatsStore } from '@/stores/timelineBeats'
import { useTextDefaultStore } from '@/stores/textDefault'
import {
  clipGraphic,
  DEFAULT_GRAPHIC_DURATION,
  isTimelineGraphicKind,
  newGraphicData,
  newImageData,
  TIMELINE_GRAPHIC_KINDS,
  type TimelineGraphicKind,
} from '@/timeline/graphics'
import { fitZoom, pxToTime, rulerTicks, timeToPx } from '@/timeline/layout'
import { chapterList } from '@/timeline/markers'
import {
  findClip,
  frameTime,
  markerClipIds,
  MAX_MARKER_LABEL,
  MICROS_PER_SECOND,
  emptyTrackIds,
  timeToSeconds,
  type Clip,
  type Marker,
  type OpError,
  type Time,
  type TrackKind,
  secondsToTime,
} from '@/timeline/model'

/**
 * Mehrspur-Timeline: Lineal, Spuren mit Clips, Abspielkopf, Zoom und Auswahl.
 * Clips lassen sich ziehen (auch auf eine andere Spur gleicher Art), an den
 * Rändern trimmen, am Abspielkopf teilen und löschen – per Maus und Tastatur.
 */
const { t, locale } = useI18n()
const store = useTimelineStore()

/** Breite der Spalte mit den Spurnamen (px). */
const HEADER_WIDTH = 150
/** Freier Platz hinter dem letzten Clip (px), mindestens. */
const TAIL = 240
const TRACK_HEIGHT: Record<TrackKind, number> = { video: 56, audio: 48, overlay: 48 }
const ZOOM_STEP = 1.5

const scroller = ref<HTMLDivElement | null>(null)
const viewportWidth = ref(800)
const scrollLeft = ref(0)
let observer: ResizeObserver | null = null

const laneViewport = computed(() => Math.max(100, viewportWidth.value - HEADER_WIDTH))
// Hinter dem Ende bleibt eine halbe Ansicht frei, damit der Abspielkopf auch
// dort in der Mitte stehen kann.
const contentWidth = computed(() =>
  Math.ceil(
    Math.max(
      timeToPx(store.duration, store.zoom) + Math.max(TAIL, laneViewport.value / 2),
      laneViewport.value,
    ),
  ),
)
const playheadLeft = computed(() => HEADER_WIDTH + timeToPx(store.playhead, store.zoom))

/** Nur die Striche im sichtbaren Bereich (lange Timelines hätten sonst Zehntausende). */
const ticks = computed(() =>
  rulerTicks(
    store.zoom,
    pxToTime(scrollLeft.value - 200, store.zoom),
    pxToTime(Math.min(contentWidth.value, scrollLeft.value + laneViewport.value + 200), store.zoom),
  ).map((tick) => ({ ...tick, left: timeToPx(tick.time, store.zoom) })),
)

// Takt-Raster der Musik (nur der sichtbare Ausschnitt, sonst wären es Tausende Linien).
const beats = useTimelineBeatsStore()
const beatLines = computed(() => {
  const from = pxToTime(scrollLeft.value - 200, store.zoom)
  const to = pxToTime(scrollLeft.value + laneViewport.value + 200, store.zoom)
  return beats.visibleTimes
    .filter((time) => time >= from && time <= to)
    .map((time) => ({ time, left: timeToPx(time, store.zoom) }))
})

const timeText = computed(
  () =>
    `${formatTimeMs(timeToSeconds(store.playhead))} / ${formatTimeMs(timeToSeconds(store.duration))}`,
)

function measure(): void {
  const el = scroller.value
  if (!el) return
  if (el.clientWidth > 0) viewportWidth.value = el.clientWidth
  scrollLeft.value = el.scrollLeft
}

// Der Scroll-Bereich entsteht erst mit der ersten Spur: Breite dann messen und beobachten.
watch(
  scroller,
  (el) => {
    observer?.disconnect()
    observer = null
    if (!el) return
    measure()
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(measure)
      observer.observe(el)
    }
  },
  { immediate: true, flush: 'post' },
)
onBeforeUnmount(() => observer?.disconnect())

// --- Abspielkopf -------------------------------------------------------------

function seekFromEvent(event: PointerEvent): void {
  const ruler = event.currentTarget as HTMLElement
  store.seek(pxToTime(event.clientX - ruler.getBoundingClientRect().left, store.zoom))
}

function onRulerDown(event: PointerEvent): void {
  if (event.button !== 0) return
  ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
  seekFromEvent(event)
}

function onRulerMove(event: PointerEvent): void {
  // Nur bei gedrückter Haupttaste (Ziehen über das Lineal).
  if (event.buttons & 1) seekFromEvent(event)
}

// Die Timeline folgt dem Abspielkopf: beim Abspielen steht er in der Mitte,
// pausiert bleibt die Ansicht stehen (siehe followScroll).
watch(
  () => [store.playhead, store.playing] as const,
  () => {
    const el = scroller.value
    if (!el) return
    const target = followScroll({
      playheadPx: timeToPx(store.playhead, store.zoom),
      viewport: laneViewport.value,
      contentWidth: contentWidth.value,
      scrollLeft: el.scrollLeft,
      playing: store.playing,
    })
    if (target === null) return
    el.scrollLeft = target
    measure()
  },
  { flush: 'post' },
)

// --- Zoom ----------------------------------------------------------------------

/** Zoom ändern und die Stelle unter `anchorPx` (im sichtbaren Bereich) festhalten. */
function zoomTo(next: number, anchorPx = 0): void {
  const el = scroller.value
  const before = store.zoom
  store.setZoom(next)
  if (!el || store.zoom === before) return
  const target = (el.scrollLeft + anchorPx) * (store.zoom / before) - anchorPx
  void nextTick(() => {
    el.scrollLeft = Math.max(0, target)
    measure()
  })
}

function onWheel(event: WheelEvent): void {
  if (!event.ctrlKey && !event.metaKey) return
  event.preventDefault()
  const el = scroller.value
  const anchor = el
    ? Math.max(0, event.clientX - el.getBoundingClientRect().left - HEADER_WIDTH)
    : 0
  zoomTo(store.zoom * (event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP), anchor)
}

function fit(): void {
  store.setZoom(fitZoom(store.duration, laneViewport.value, MIN_ZOOM, MAX_ZOOM))
  void nextTick(() => {
    if (scroller.value) scroller.value.scrollLeft = 0
    measure()
  })
}

// --- Auswahl und Ziehen ----------------------------------------------------

/** Ab so vielen Pixeln Bewegung gilt ein gedrückter Zeiger als Ziehen. */
const DRAG_THRESHOLD = 3

interface Drag {
  id: string
  mode: ClipGrab
  pointerId: number
  startX: number
  startScroll: number
  /** Zeit des gegriffenen Rands bzw. Clip-Beginns beim Greifen. */
  origin: Time
  active: boolean
}
let drag: Drag | null = null
const dragging = ref(false)

function onGrab(id: string, mode: ClipGrab, event: PointerEvent): void {
  root.value?.focus({ preventScroll: true })
  const toggle = event.ctrlKey || event.metaKey || event.shiftKey
  if (toggle) return store.selectClip(id, true)
  if (!store.selection.includes(id)) store.selectClip(id)
  const loc = findClip(store.doc, id)
  if (!loc || loc.track.locked) return
  const clip = loc.clip
  drag = {
    id,
    mode,
    pointerId: event.pointerId,
    startX: event.clientX,
    startScroll: scroller.value?.scrollLeft ?? 0,
    origin: mode === 'end' ? clip.start + clip.duration : clip.start,
    active: false,
  }
  window.addEventListener('pointermove', onDragMove)
  window.addEventListener('pointerup', onDragEnd)
  window.addEventListener('pointercancel', onDragCancel)
}

function onDragMove(event: PointerEvent): void {
  if (!drag) return
  const scrolled = (scroller.value?.scrollLeft ?? 0) - drag.startScroll
  const dx = event.clientX - drag.startX + scrolled
  if (!drag.active) {
    if (Math.abs(dx) < DRAG_THRESHOLD) return
    drag.active = true
    dragging.value = true
    store.beginGesture()
  }
  const time = drag.origin + Math.round((dx / store.zoom) * MICROS_PER_SECOND)
  if (drag.mode === 'move') store.dragClipTo(drag.id, time, trackAt(event))
  else store.dragTrimTo(drag.id, drag.mode, time)
}

/** Spur unter dem Zeiger (für das Ziehen auf eine andere Spur). */
function trackAt(event: PointerEvent): string | undefined {
  if (typeof document.elementFromPoint !== 'function') return undefined
  const el = document.elementFromPoint(event.clientX, event.clientY)
  return el?.closest<HTMLElement>('[data-track]')?.dataset.track
}

function stopDrag(): void {
  window.removeEventListener('pointermove', onDragMove)
  window.removeEventListener('pointerup', onDragEnd)
  window.removeEventListener('pointercancel', onDragCancel)
  drag = null
  dragging.value = false
}

function onDragEnd(): void {
  if (drag?.active) store.endGesture()
  stopDrag()
}

function onDragCancel(): void {
  if (drag?.active) store.cancelGesture()
  stopDrag()
}

onBeforeUnmount(onDragCancel)

// --- Befehle (Knöpfe und Tastatur) ------------------------------------------

const root = ref<HTMLElement | null>(null)
/** Warum der letzte Befehl nichts bewirkt hat (kurzer Hinweis in der Leiste). */
const hint = ref('')

const HINTS: Partial<Record<OpError, string>> = {
  'track-locked': 'timeline.hint.locked',
  'too-short': 'timeline.hint.tooShort',
  'invalid-time': 'timeline.hint.nothingAtPlayhead',
  overlap: 'timeline.hint.overlap',
  'too-many': 'timeline.hint.tooManyMarkers',
}

function run(command: () => boolean): void {
  if (command()) hint.value = ''
  else {
    const key = store.lastError ? HINTS[store.lastError] : undefined
    hint.value = key ? t(key) : ''
  }
  // Verschwindet der gedrückte Knopf (z. B. Spur entfernt), bliebe die Tastatur
  // sonst ohne Ziel: nach dem Neuzeichnen Fokus zurück auf die Timeline.
  void nextTick(() => {
    const el = root.value
    if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true })
  })
}

/** Anzahl leerer Spuren, die sich entfernen lassen (Knopf „Leere Spuren löschen“). */
const emptyTracks = computed(() => emptyTrackIds(store.doc).length)

const split = () => run(() => store.splitAtPlayhead())
const remove = (ripple: boolean) => run(() => store.removeSelection({ ripple }))

const textDefault = useTextDefaultStore()

const insertText = (): boolean =>
  store.addText(
    // Gespeicherter Text-Standard des Nutzers geht vor.
    { ...DEFAULT_TEXT_STYLE, animSpeed: 1, ...textDefault.value, text: t('text.defaultText') },
    secondsToTime(DEFAULT_TEXT_DURATION),
  ) !== null

/** Text am Abspielkopf anlegen; die Einstellungen stehen danach neben der Vorschau. */
function addText(): void {
  run(insertText)
}

/** Form, Symbol oder Emoji am Abspielkopf anlegen (Auswahl aus der Galerie). */
function addGraphic(
  kind: TimelineGraphicKind,
  extra: { symbol?: GraphicSymbol; emoji?: string },
): void {
  run(
    () =>
      store.addGraphic(
        { ...newGraphicData(kind), ...extra },
        secondsToTime(DEFAULT_GRAPHIC_DURATION),
      ) !== null,
  )
}

const imageInput = ref<HTMLInputElement | null>(null)
const imageBusy = ref(false)
/** Marker, an den das nächste geladene Bild kommt (`null` = an den Abspielkopf). */
let imageForMarker: string | null = null

function pickImage(markerId: string | null): void {
  imageForMarker = markerId
  imageInput.value?.click()
}

/** Eigenes Bild laden und am Abspielkopf als Clip anlegen. */
async function addImage(e: Event): Promise<void> {
  const el = e.target as HTMLInputElement
  const file = el.files?.[0]
  el.value = ''
  if (!file || imageBusy.value) return
  imageBusy.value = true
  // Über die Marker-Zeile geöffnet: Bild am Marker anlegen und binden.
  const markerId = imageForMarker
  imageForMarker = null
  try {
    const asset = await addImageAsset(file)
    const insert = () =>
      store.addGraphic(newImageData(asset.id), secondsToTime(DEFAULT_GRAPHIC_DURATION)) !== null
    run(() => (markerId ? store.addAtMarker(markerId, insert) : insert()))
  } catch (err) {
    hint.value =
      err instanceof ImageAssetError
        ? t(`graphics.image.errors.${err.code}`, { name: file.name })
        : t('graphics.image.errors.decode', { name: file.name })
  } finally {
    imageBusy.value = false
  }
}

// --- Marker --------------------------------------------------------------------

/** Angeklickter Marker: Name und Löschen stehen dann in der Marker-Zeile. */
const selectedMarkerId = ref<string | null>(null)
const selectedMarker = computed(
  () => store.doc.markers.find((m) => m.id === selectedMarkerId.value) ?? null,
)
const markers = computed(() => {
  // Anzahl gebundener Clips je Marker (für das Zeichen am Fähnchen).
  const bound = new Map<string, number>()
  for (const track of store.doc.tracks)
    for (const c of track.clips as Clip[])
      if (c.marker) bound.set(c.marker, (bound.get(c.marker) ?? 0) + 1)
  return store.doc.markers.map((m) => ({
    marker: m,
    left: timeToPx(m.at, store.zoom),
    bound: bound.get(m.id) ?? 0,
  }))
})
const markerTime = (m: Marker) => formatTimeMs(timeToSeconds(m.at))
const copyNote = ref('')

function addMarker(): void {
  run(() => {
    const id = store.addMarkerAtPlayhead()
    if (id) selectedMarkerId.value = id
    return id !== null
  })
  void nextTick(() => markerName.value?.focus())
}
const markerName = ref<HTMLInputElement | null>(null)

function pickMarker(m: Marker): void {
  selectedMarkerId.value = m.id
  store.seek(m.at)
}

function jumpMarker(dir: -1 | 1): void {
  const id = store.jumpToMarker(dir)
  if (id) selectedMarkerId.value = id
}

function renameMarker(event: Event): void {
  const m = selectedMarker.value
  if (m) run(() => store.updateMarker(m.id, { label: (event.target as HTMLInputElement).value }))
}

function removeMarker(id: string): void {
  run(() => store.removeMarker(id))
  if (selectedMarkerId.value === id) selectedMarkerId.value = null
}

/** Clips am angeklickten Marker (wie die Elemente eines Beat-Drop-Markers im Visualizer). */
const markerElements = computed(() => {
  const m = selectedMarker.value
  if (!m) return []
  return markerClipIds(store.doc, m.id).flatMap((id) => {
    const loc = findClip(store.doc, id)
    if (!loc) return []
    const offset = loc.clip.start - m.at
    return [{ id, name: elementName(loc.clip), offset }]
  })
})

/** Kurzname eines Clips für die Marker-Zeile. */
function elementName(clip: Clip): string {
  if (clip.kind === 'text') {
    const text = typeof clip.data.text === 'string' ? clip.data.text.split('\n')[0].trim() : ''
    return text || t('timeline.marker.elements.text')
  }
  if (clip.kind === 'graphic') {
    const g = clipGraphic(clip.data)
    if (g.kind === 'emoji') return g.emoji || t('graphics.kinds.emoji')
    if (g.kind === 'image') return getImageAsset(g.image)?.name ?? t('graphics.kinds.image')
    return g.kind === 'symbol' ? t(`graphics.symbols.${g.symbol}`) : t(`graphics.kinds.${g.kind}`)
  }
  if ('asset' in clip && clip.asset) return store.doc.assets[clip.asset]?.name ?? clip.kind
  return clip.kind
}

/** Abstand zum Marker, z. B. „+0,50 s“ (leer bei 0). */
function offsetText(offset: Time): string {
  if (offset === 0) return ''
  const s = timeToSeconds(Math.abs(offset)).toLocaleString(locale.value, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return `${offset > 0 ? '+' : '−'}${s} s`
}

/** Tondateien aus der Medienliste (können am Marker einsetzen). */
const audioAssets = computed(() =>
  Object.values(store.doc.assets).filter((a) => a.kind === 'audio' && a.duration !== null),
)

/** Auswahl „+ Am Marker“: Text, Form/Emoji, Bild oder Ton am Marker anlegen und binden. */
function addAtMarker(e: Event): void {
  const el = e.target as HTMLSelectElement
  const value = el.value
  el.value = ''
  const m = selectedMarker.value
  if (!m || !value) return
  if (value === 'text') run(() => store.addAtMarker(m.id, insertText))
  else if (value === 'image') pickImage(m.id)
  else if (value.startsWith('graphic:')) {
    const kind = value.slice('graphic:'.length)
    if (!isTimelineGraphicKind(kind)) return
    run(() =>
      store.addAtMarker(
        m.id,
        () =>
          store.addGraphic(newGraphicData(kind), secondsToTime(DEFAULT_GRAPHIC_DURATION)) !== null,
      ),
    )
  } else if (value.startsWith('audio:')) {
    const assetId = value.slice('audio:'.length)
    run(() => store.addAtMarker(m.id, () => store.insertAudioAt(assetId, m.at)))
  }
}

function bindSelection(): void {
  const m = selectedMarker.value
  if (m) run(() => store.bindSelectionToMarker(m.id))
}

function selectElement(id: string): void {
  store.select([id])
}

let markerDrag: {
  id: string
  pointerId: number
  startX: number
  originPx: number
  moved: boolean
} | null = null

function onMarkerDown(event: PointerEvent, m: Marker): void {
  if (event.button !== 0) return
  ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
  markerDrag = {
    id: m.id,
    pointerId: event.pointerId,
    startX: event.clientX,
    originPx: timeToPx(m.at, store.zoom),
    moved: false,
  }
}

function onMarkerMove(event: PointerEvent): void {
  const d = markerDrag
  if (!d || event.pointerId !== d.pointerId) return
  const dx = event.clientX - d.startX
  if (!d.moved) {
    if (Math.abs(dx) < 4) return
    d.moved = true
    store.beginGesture()
  }
  store.dragMarkerTo(d.id, pxToTime(d.originPx + dx, store.zoom))
}

function onMarkerUp(event: PointerEvent): void {
  const d = markerDrag
  if (!d || event.pointerId !== d.pointerId) return
  markerDrag = null
  if (d.moved) store.endGesture()
}

async function copyChapters(): Promise<void> {
  const text = chapterList(store.doc.markers, t('timeline.marker.chapter'))
  try {
    await navigator.clipboard.writeText(text)
    copyNote.value = t('timeline.marker.copied')
  } catch {
    copyNote.value = t('timeline.marker.copyFailed')
  }
}
watch(
  () => store.doc.markers,
  () => (copyNote.value = ''),
)

const canSplit = computed(() => store.splitTargets.length > 0)

function stepPlayhead(frames: number): void {
  const fps = store.doc.settings.fps
  const index = Math.round((store.playhead * fps) / MICROS_PER_SECOND) + frames
  store.seek(frameTime(Math.max(0, index), fps))
}

function onKeydown(event: KeyboardEvent): void {
  const mod = event.ctrlKey || event.metaKey
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key
  let handled = true
  if (key === 'Escape') {
    if (drag) onDragCancel()
    else store.select([])
  } else if (mod && key === 'z') {
    if (event.shiftKey) store.redo()
    else store.undo()
  } else if (mod && key === 'y') store.redo()
  else if (mod && key === 'a') store.selectAll()
  else if (mod || event.altKey) handled = false
  else if (key === 'Delete' || key === 'Backspace') remove(event.shiftKey)
  else if (key === 's') split()
  else if (key === 'm') addMarker()
  else if (key === ' ') store.togglePlay()
  else if (key === 'ArrowLeft')
    stepPlayhead(event.shiftKey ? -Math.round(store.doc.settings.fps) : -1)
  else if (key === 'ArrowRight')
    stepPlayhead(event.shiftKey ? Math.round(store.doc.settings.fps) : 1)
  else if (key === 'Home') store.seek(0)
  else if (key === 'End') store.seek(store.duration)
  else handled = false
  if (handled) event.preventDefault()
}
</script>

<template>
  <section
    ref="root"
    class="timeline"
    :class="{ dragging }"
    data-testid="timeline"
    tabindex="0"
    :aria-label="t('timeline.label')"
    @keydown="onKeydown"
  >
    <div class="toolbar">
      <button
        type="button"
        class="tool"
        :disabled="!store.canUndo"
        :title="t('timeline.undo')"
        :aria-label="t('timeline.undo')"
        @click="store.undo()"
      >
        ↶
      </button>
      <button
        type="button"
        class="tool"
        :disabled="!store.canRedo"
        :title="t('timeline.redo')"
        :aria-label="t('timeline.redo')"
        @click="store.redo()"
      >
        ↷
      </button>
      <button
        type="button"
        class="tool wide"
        data-testid="timeline-split"
        :disabled="!canSplit"
        :title="t('timeline.splitTitle')"
        @click="split"
      >
        {{ t('timeline.split') }}
      </button>
      <button
        v-if="store.canUnlink || !store.canLink"
        type="button"
        class="tool wide"
        data-testid="timeline-unlink"
        :disabled="!store.canUnlink"
        :title="t('timeline.unlinkTitle')"
        @click="run(() => store.unlinkSelection())"
      >
        {{ t('timeline.unlink') }}
      </button>
      <button
        v-else
        type="button"
        class="tool wide"
        data-testid="timeline-link"
        :title="t('timeline.linkTitle')"
        @click="run(() => store.linkSelection())"
      >
        {{ t('timeline.link') }}
      </button>
      <button
        type="button"
        class="tool wide"
        data-testid="timeline-delete"
        :disabled="!store.selection.length"
        :title="t('timeline.removeTitle')"
        @click="remove(false)"
      >
        {{ t('timeline.remove') }}
      </button>
      <button
        type="button"
        class="tool wide"
        data-testid="timeline-ripple-delete"
        :disabled="!store.selection.length"
        :title="t('timeline.rippleRemoveTitle')"
        @click="remove(true)"
      >
        {{ t('timeline.rippleRemove') }}
      </button>
      <label class="snap" :title="t('timeline.snapTitle')">
        <input v-model="store.snapping" type="checkbox" data-testid="timeline-snap" />
        {{ t('timeline.snap') }}
      </label>
      <button
        type="button"
        class="tool wide"
        data-testid="timeline-add-video"
        :title="t('timeline.addVideoTrackTitle')"
        @click="run(() => store.newTrack('video'))"
      >
        {{ t('timeline.addVideoTrack') }}
      </button>
      <button
        type="button"
        class="tool wide"
        data-testid="timeline-add-audio"
        :title="t('timeline.addAudioTrackTitle')"
        @click="run(() => store.newTrack('audio'))"
      >
        {{ t('timeline.addAudioTrack') }}
      </button>
      <button
        type="button"
        class="tool wide"
        data-testid="timeline-add-overlay"
        :title="t('timeline.addOverlayTrackTitle')"
        @click="run(() => store.newTrack('overlay'))"
      >
        {{ t('timeline.addOverlayTrack') }}
      </button>
      <button
        type="button"
        class="tool wide"
        data-testid="timeline-remove-empty"
        :disabled="emptyTracks === 0"
        :title="t('timeline.removeEmptyTracksTitle')"
        @click="run(() => store.removeEmptyTracks())"
      >
        {{ t('timeline.removeEmptyTracks') }}
      </button>
      <button
        type="button"
        class="tool wide"
        data-testid="timeline-add-text"
        :title="t('timeline.addTextTitle')"
        @click="addText"
      >
        {{ t('timeline.addText') }}
      </button>
      <GraphicGallery @add="addGraphic" />
      <button
        type="button"
        class="tool wide"
        data-testid="timeline-add-image"
        :title="t('timeline.addImageTitle')"
        :disabled="imageBusy"
        @click="pickImage(null)"
      >
        {{ imageBusy ? t('graphics.image.loading') : t('timeline.addImage') }}
      </button>
      <input
        ref="imageInput"
        type="file"
        hidden
        :accept="IMAGE_ACCEPT"
        data-testid="timeline-image-input"
        @change="addImage"
      />
      <button
        type="button"
        class="tool wide"
        data-testid="timeline-add-marker"
        :title="t('timeline.marker.addTitle')"
        @click="addMarker"
      >
        {{ t('timeline.marker.add') }}
      </button>
      <span class="time" data-testid="timeline-time">{{ timeText }}</span>
      <span v-if="hint" class="hint" role="status">{{ hint }}</span>
      <span class="spacer"></span>
      <button
        type="button"
        class="tool"
        :disabled="store.zoom <= MIN_ZOOM"
        :title="t('timeline.zoomOut')"
        :aria-label="t('timeline.zoomOut')"
        @click="zoomTo(store.zoom / ZOOM_STEP)"
      >
        −
      </button>
      <button
        type="button"
        class="tool"
        :disabled="store.zoom >= MAX_ZOOM"
        :title="t('timeline.zoomIn')"
        :aria-label="t('timeline.zoomIn')"
        @click="zoomTo(store.zoom * ZOOM_STEP)"
      >
        +
      </button>
      <button
        type="button"
        class="tool wide"
        data-testid="timeline-fit"
        :disabled="store.duration <= 0"
        @click="fit"
      >
        {{ t('timeline.fit') }}
      </button>
    </div>

    <div v-if="store.doc.markers.length" class="marker-bar" data-testid="marker-bar">
      <button
        type="button"
        class="tool"
        data-testid="timeline-prev-marker"
        :title="t('timeline.marker.prev')"
        :aria-label="t('timeline.marker.prev')"
        @click="jumpMarker(-1)"
      >
        ⇤
      </button>
      <button
        type="button"
        class="tool"
        data-testid="timeline-next-marker"
        :title="t('timeline.marker.next')"
        :aria-label="t('timeline.marker.next')"
        @click="jumpMarker(1)"
      >
        ⇥
      </button>
      <template v-if="selectedMarker">
        <span class="marker-at">{{
          t('timeline.marker.at', { time: markerTime(selectedMarker) })
        }}</span>
        <input
          ref="markerName"
          :key="selectedMarker.id"
          class="marker-name"
          type="text"
          data-testid="timeline-marker-name"
          :maxlength="MAX_MARKER_LABEL"
          :value="selectedMarker.label"
          :placeholder="t('timeline.marker.namePlaceholder')"
          :aria-label="t('timeline.marker.name')"
          @change="renameMarker"
          @keydown.stop
          @keydown.enter="($event.target as HTMLInputElement).blur()"
        />
        <select
          class="tool wide add-graphic"
          data-testid="timeline-marker-add"
          :title="t('timeline.marker.elements.addTitle')"
          :aria-label="t('timeline.marker.elements.addTitle')"
          :disabled="imageBusy"
          @change="addAtMarker"
          @keydown.stop
        >
          <option value="">{{ t('timeline.marker.elements.add') }}</option>
          <option value="text">{{ t('timeline.marker.elements.text') }}</option>
          <optgroup :label="t('timeline.marker.elements.graphics')">
            <option v-for="k in TIMELINE_GRAPHIC_KINDS" :key="k" :value="`graphic:${k}`">
              {{ t(`graphics.kinds.${k}`) }}
            </option>
          </optgroup>
          <option value="image">{{ t('timeline.marker.elements.image') }}</option>
          <optgroup v-if="audioAssets.length" :label="t('timeline.marker.elements.audio')">
            <option v-for="a in audioAssets" :key="a.id" :value="`audio:${a.id}`">
              {{ a.name }}
            </option>
          </optgroup>
        </select>
        <button
          type="button"
          class="tool wide"
          data-testid="timeline-marker-bind"
          :title="t('timeline.marker.elements.bindTitle')"
          :disabled="store.selection.length === 0"
          @click="bindSelection"
        >
          {{ t('timeline.marker.elements.bind') }}
        </button>
        <button
          type="button"
          class="tool wide"
          data-testid="timeline-marker-remove"
          :title="markerElements.length ? t('timeline.marker.elements.removeKeeps') : undefined"
          @click="removeMarker(selectedMarker.id)"
        >
          {{ t('timeline.marker.remove') }}
        </button>
        <span
          v-if="markerElements.length"
          class="marker-elements"
          data-testid="timeline-marker-elements"
        >
          <span class="marker-hint">{{ t('timeline.marker.elements.title') }}</span>
          <span
            v-for="el in markerElements"
            :key="el.id"
            class="marker-element"
            :class="{ active: store.selection.includes(el.id) }"
            :data-element="el.id"
          >
            <button
              type="button"
              class="element-pick"
              :title="t('timeline.marker.elements.pick')"
              @click="selectElement(el.id)"
            >
              {{ el.name
              }}<span v-if="el.offset" class="element-offset"> {{ offsetText(el.offset) }}</span>
            </button>
            <button
              type="button"
              class="element-unbind"
              data-testid="timeline-marker-unbind"
              :title="t('timeline.marker.elements.unbind')"
              :aria-label="t('timeline.marker.elements.unbindNamed', { name: el.name })"
              @click="run(() => store.unbindClip(el.id))"
            >
              ×
            </button>
          </span>
        </span>
        <MarkerEffect
          :key="selectedMarker.id"
          :marker="selectedMarker"
          @rejected="hint = t('timeline.marker.effect.rejected')"
        />
      </template>
      <span v-else class="marker-hint">{{ t('timeline.marker.selectHint') }}</span>
      <span class="spacer"></span>
      <span v-if="copyNote" class="marker-hint" role="status">{{ copyNote }}</span>
      <button
        type="button"
        class="tool wide"
        data-testid="timeline-copy-chapters"
        :title="t('timeline.marker.copyChaptersTitle')"
        @click="copyChapters"
      >
        {{ t('timeline.marker.copyChapters') }}
      </button>
    </div>

    <p v-if="!store.doc.tracks.length" class="empty">{{ t('timeline.empty') }}</p>

    <div v-else ref="scroller" class="scroller" @scroll="measure" @wheel="onWheel">
      <div class="grid" :style="{ width: `${HEADER_WIDTH + contentWidth}px` }">
        <div class="row ruler-row" :class="{ 'has-markers': markers.length > 0 }">
          <div class="head corner" :style="{ width: `${HEADER_WIDTH}px` }"></div>
          <div
            class="ruler"
            data-testid="timeline-ruler"
            :style="{ width: `${contentWidth}px` }"
            @pointerdown="onRulerDown"
            @pointermove="onRulerMove"
          >
            <span
              v-for="tick in ticks"
              :key="tick.time"
              class="tick"
              :class="{ major: tick.major }"
              :style="{ left: `${tick.left}px` }"
            >
              <span v-if="tick.label" class="tick-label">{{ tick.label }}</span>
            </span>
            <button
              v-for="m in markers"
              :key="m.marker.id"
              type="button"
              class="marker"
              :class="{ active: m.marker.id === selectedMarkerId, beat: m.marker.beat }"
              :data-marker="m.marker.id"
              :style="{ left: `${m.left}px` }"
              :title="m.marker.label || t('timeline.marker.unnamed')"
              :aria-label="
                t('timeline.marker.flag', {
                  name: m.marker.label || t('timeline.marker.unnamed'),
                  time: markerTime(m.marker),
                })
              "
              :aria-pressed="m.marker.id === selectedMarkerId"
              @pointerdown.stop="onMarkerDown($event, m.marker)"
              @pointermove.stop="onMarkerMove"
              @pointerup="onMarkerUp"
              @pointercancel="onMarkerUp"
              @click="pickMarker(m.marker)"
              @keydown.delete.stop.prevent="removeMarker(m.marker.id)"
            >
              <span class="marker-label">{{ m.marker.label }}</span>
              <span
                v-if="m.marker.effect"
                class="marker-count"
                data-testid="timeline-marker-fx"
                :title="t(`timeline.marker.effect.kinds.${m.marker.effect.kind}`)"
                >✦</span
              >
              <span
                v-if="m.bound"
                class="marker-count"
                data-testid="timeline-marker-count"
                :title="t('timeline.marker.elements.count', { count: m.bound })"
                >⚡{{ m.bound }}</span
              >
            </button>
          </div>
        </div>

        <div
          v-for="(track, index) in store.doc.tracks"
          :key="track.id"
          class="row track"
          :data-kind="track.kind"
          :data-track="track.id"
          :data-locked="track.locked"
          :data-off="track.kind === 'audio' ? track.muted : track.hidden"
          :data-target="store.activeOverlayTarget === track.id"
          :style="{ height: `${TRACK_HEIGHT[track.kind]}px` }"
        >
          <div class="head" :style="{ width: `${HEADER_WIDTH}px` }">
            <TrackHeader
              :track="track"
              :can-move-up="index > 0"
              :can-move-down="index < store.doc.tracks.length - 1"
              :is-target="store.activeOverlayTarget === track.id"
              @target="
                store.setOverlayTarget(store.activeOverlayTarget === track.id ? null : track.id)
              "
              @update="(patch) => run(() => store.updateTrack(track.id, patch))"
              @move="(delta) => run(() => store.moveTrack(track.id, index + delta))"
              @remove="run(() => store.removeTrack(track.id))"
            />
          </div>
          <div
            class="lane"
            :style="{ width: `${contentWidth}px` }"
            @pointerdown.self="store.select([])"
          >
            <TimelineClip
              v-for="clip in track.clips"
              :key="clip.id"
              :clip="clip"
              :zoom="store.zoom"
              :height="TRACK_HEIGHT[track.kind]"
              :selected="store.selection.includes(clip.id)"
              :locked="track.locked"
              @grab="onGrab"
            />
          </div>
        </div>

        <div
          v-for="m in markers"
          :key="m.marker.id"
          class="marker-line"
          :class="{ beat: m.marker.beat }"
          :style="{ left: `${HEADER_WIDTH + m.left}px` }"
        ></div>
        <div
          v-for="b in beatLines"
          :key="`beat-${b.time}`"
          class="beat-line"
          data-testid="timeline-beat-line"
          :style="{ left: `${HEADER_WIDTH + b.left}px` }"
        ></div>
        <div
          class="playhead"
          data-testid="timeline-playhead"
          :style="{ left: `${playheadLeft}px` }"
        ></div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.timeline {
  display: flex;
  flex-direction: column;
  gap: var(--ds-space-2);
  padding: var(--ds-space-3);
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-lg);
  background: var(--ds-surface-1);
}
.toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--ds-space-2);
}
.timeline:focus-visible {
  outline: none;
  box-shadow: var(--ds-focus-ring);
}
.timeline.dragging,
.timeline.dragging :deep(.clip) {
  cursor: grabbing;
}
.spacer {
  flex: 1;
}
.snap {
  display: inline-flex;
  align-items: center;
  gap: var(--ds-space-1);
  font-size: var(--ds-text-sm);
  color: var(--ds-text-2);
  cursor: pointer;
}
.hint {
  font-size: var(--ds-text-sm);
  color: var(--ds-danger);
}
.toolbar {
  flex-wrap: wrap;
}
.tool {
  min-width: var(--ds-control-sm);
  height: var(--ds-control-sm);
  padding: 0 var(--ds-space-2);
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  background: var(--ds-surface-2);
  color: var(--ds-text);
  cursor: pointer;
}
.tool.wide {
  padding: 0 var(--ds-space-3);
  font-size: var(--ds-text-sm);
}
.tool:hover:not(:disabled) {
  border-color: var(--ds-accent);
}
.tool:disabled {
  opacity: 0.45;
  cursor: default;
}
.tool:focus-visible {
  outline: none;
  box-shadow: var(--ds-focus-ring);
}
.time {
  margin-left: var(--ds-space-2);
  font-family: var(--ds-font-mono);
  font-size: var(--ds-text-sm);
  font-variant-numeric: tabular-nums;
  color: var(--ds-text-2);
}
.empty {
  margin: 0;
  padding: var(--ds-space-6);
  border: 1px dashed var(--ds-border);
  border-radius: var(--ds-radius-md);
  color: var(--ds-text-2);
  font-size: var(--ds-text-sm);
  text-align: center;
}
.scroller {
  overflow-x: auto;
  overflow-y: hidden;
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  background: var(--ds-surface-0);
}
.grid {
  position: relative;
}
.row {
  display: flex;
}
.row + .row {
  border-top: 1px solid var(--ds-border);
}
.head {
  position: sticky;
  left: 0;
  z-index: 3;
  flex: none;
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 0 var(--ds-space-2);
  border-right: 1px solid var(--ds-border);
  background: var(--ds-surface-2);
  box-sizing: border-box;
}
.track[data-locked='true'] .lane {
  background: repeating-linear-gradient(135deg, transparent 0 8px, var(--ds-surface-2) 8px 16px);
}
.track[data-off='true'] .lane {
  opacity: 0.45;
}
/* Ziel-Ebene für neue Texte, Formen und Bilder. */
.track[data-target='true'] .head {
  box-shadow: inset 3px 0 0 var(--ds-accent);
}
/* Bleibt oben stehen, wenn viele Spuren in der Höhe scrollen. */
.ruler-row {
  position: sticky;
  top: 0;
  z-index: 4;
  height: 28px;
  background: var(--ds-surface-0);
}
.ruler {
  position: relative;
  flex: none;
  cursor: pointer;
  touch-action: none;
  user-select: none;
}
.tick {
  position: absolute;
  bottom: 0;
  height: 6px;
  border-left: 1px solid var(--ds-border-strong);
}
.tick.major {
  height: 12px;
}
.tick-label {
  position: absolute;
  bottom: 12px;
  left: 3px;
  font-size: var(--ds-text-xs);
  font-variant-numeric: tabular-nums;
  color: var(--ds-text-2);
  white-space: nowrap;
}
.lane {
  position: relative;
  flex: none;
}
.marker-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--ds-space-2);
}
.marker-at,
.marker-hint {
  font-size: var(--ds-text-sm);
  color: var(--ds-text-2);
  font-variant-numeric: tabular-nums;
}
.marker-name {
  width: 220px;
  max-width: 100%;
  height: var(--ds-control-sm);
  padding: 0 var(--ds-space-2);
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  background: var(--ds-surface-0);
  color: var(--ds-text);
  font-size: var(--ds-text-sm);
}
.marker-elements {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--ds-space-1);
}
.marker-element {
  display: inline-flex;
  align-items: center;
  max-width: 220px;
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  background: var(--ds-surface-0);
  font-size: var(--ds-text-xs);
}
.marker-element.active {
  border-color: var(--ds-accent);
  background: var(--ds-accent-soft);
}
.element-pick,
.element-unbind {
  border: 0;
  background: none;
  color: var(--ds-text);
  font: inherit;
  cursor: pointer;
}
.element-pick {
  overflow: hidden;
  padding: 2px 6px;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.element-offset {
  color: var(--ds-text-2);
  font-variant-numeric: tabular-nums;
}
.element-unbind {
  padding: 2px 6px 2px 2px;
  color: var(--ds-text-2);
}
.element-unbind:hover {
  color: var(--ds-danger, var(--ds-text));
}
.element-pick:focus-visible,
.element-unbind:focus-visible,
.marker-name:focus-visible,
.marker:focus-visible {
  outline: none;
  box-shadow: var(--ds-focus-ring);
}
/* Mit Markern bekommt das Lineal oben einen eigenen Streifen für die Fähnchen. */
.ruler-row.has-markers {
  height: 44px;
}
.marker {
  position: absolute;
  top: 2px;
  z-index: 1;
  display: flex;
  align-items: center;
  height: 14px;
  min-width: 10px;
  max-width: 140px;
  padding: 0 4px;
  border: 0;
  border-left: 2px solid var(--ds-accent);
  border-radius: 0 var(--ds-radius-sm) var(--ds-radius-sm) 0;
  background: var(--ds-accent-soft);
  color: var(--ds-text);
  font-size: var(--ds-text-xs);
  line-height: 1;
  cursor: grab;
  touch-action: none;
}
.marker.active {
  background: var(--ds-accent);
  color: var(--ds-surface-0);
}
.marker-label {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.marker-count {
  flex: none;
  margin-left: 2px;
  font-variant-numeric: tabular-nums;
}
.marker-line {
  position: absolute;
  top: 0;
  bottom: 0;
  z-index: 1;
  width: 0;
  border-left: 1px dashed var(--ds-accent);
  opacity: 0.6;
  pointer-events: none;
}
/* Takt-Marker: schmales Fähnchen ohne Namen, leisere Linie. */
.marker.beat {
  min-width: 6px;
  padding: 0;
}
.marker-line.beat {
  opacity: 0.35;
}
/* Takt-Raster (noch nicht übernommen): feine Linien über allen Spuren. */
.beat-line {
  position: absolute;
  top: 0;
  bottom: 0;
  z-index: 1;
  width: 0;
  border-left: 1px solid var(--ds-success, #2e7d32);
  opacity: 0.45;
  pointer-events: none;
}
.playhead {
  position: absolute;
  top: 0;
  bottom: 0;
  z-index: 2;
  width: 2px;
  margin-left: -1px;
  background: var(--vc-playhead);
  pointer-events: none;
}
</style>
