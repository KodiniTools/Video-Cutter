<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import CropFrame from './CropFrame.vue'
import PositionFrame from './PositionFrame.vue'
import {
  fetchPreviewPlan,
  fetchPreviewStats,
  PREVIEW_UNSUPPORTED,
  type PreviewStats,
} from '@/lib/previewApi'
import { GRAPHICS_UNSUPPORTED } from '@/lib/graphicsApi'
import { formatTimeMs } from '@/lib/timeFormat'
import { PreviewEngine, previewSupported } from '@/preview/player'
import { useTimelineStore } from '@/stores/timeline'
import { graphicImages } from '@/timeline/graphics'
import {
  DEFAULT_NUDGE_MS,
  isNudgeStep,
  NUDGE_STEPS_MS,
  nudgeTime,
  type NudgeStepMs,
} from '@/timeline/nudge'
import { frameTime, MICROS_PER_SECOND, timeToSeconds, type TimelineDoc } from '@/timeline/model'

/**
 * Vorschau des Timeline-Editors. Das Bild kommt vollständig vom Server: Er
 * rendert die Timeline in kurzen Abschnitten, der Player hängt sie aneinander.
 * Nach einer Änderung werden nur die betroffenen Abschnitte neu geholt.
 */

/** So lange wird nach einer Änderung gewartet, bevor neu geplant wird. */
const PLAN_DELAY_MS = 250

const { t, locale } = useI18n()
const store = useTimelineStore()

const video = ref<HTMLVideoElement | null>(null)
/** Abschnitt unter dem Abspielkopf liegt in aktueller Fassung vor. */
const buffered = ref(false)
/** `unsupported`/`browser` oder eine Fehlermeldung im Klartext. */
const problem = ref<string | null>(null)
const stats = ref<PreviewStats | null>(null)

const empty = computed(() => store.duration <= 0)

// --- Abspielkopf genau verschieben (nur bei pausierter Wiedergabe) -----------

const NUDGE_STORAGE_KEY = 'videoCutter.nudgeStep'

function storedNudge(): NudgeStepMs {
  try {
    const v = Number(localStorage.getItem(NUDGE_STORAGE_KEY))
    return isNudgeStep(v) ? v : DEFAULT_NUDGE_MS
  } catch {
    return DEFAULT_NUDGE_MS
  }
}

/** Gewählte Schrittweite; bleibt im Browser gemerkt. */
const nudgeStep = ref<NudgeStepMs>(storedNudge())

function chooseNudge(step: NudgeStepMs): void {
  nudgeStep.value = step
  try {
    localStorage.setItem(NUDGE_STORAGE_KEY, String(step))
  } catch {
    // Gesperrter Speicher: Auswahl gilt nur für diese Sitzung.
  }
}

const canNudge = computed(() => !empty.value && !store.playing)

function nudge(dir: -1 | 1): void {
  if (!canNudge.value) return
  store.seek(
    nudgeTime(store.playhead, dir, nudgeStep.value, store.doc.settings.fps, store.duration),
  )
}

/**
 * Zum Anfang bzw. Ende spulen. Zum Anfang läuft die Wiedergabe weiter (von
 * vorn); am Ende gibt es nichts mehr abzuspielen, dort hält sie an.
 */
function jumpTo(where: 'start' | 'end'): void {
  if (empty.value) return
  if (where === 'end') store.playing = false
  store.seek(where === 'start' ? 0 : store.duration)
}
const frameSec = computed(() => 1 / store.doc.settings.fps)
const aspect = computed(() => `${store.doc.settings.width} / ${store.doc.settings.height}`)
/** Seitenverhältnis als Zahl: Die Bildfläche ist genau so breit, wie ihre Höhe erlaubt. */
const ratio = computed(() => store.doc.settings.width / store.doc.settings.height || 16 / 9)
/** Projektformat am Rahmen, z. B. „1080 × 1080“. */
const formatLabel = computed(() => `${store.doc.settings.width} × ${store.doc.settings.height}`)

// --- Raster (Drittel-Linien, nur Hilfe in der Vorschau – nie in der Datei) ---

const GRID_STORAGE_KEY = 'videoCutter.previewGrid'

function storedGrid(): boolean {
  try {
    return localStorage.getItem(GRID_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

const showGrid = ref(storedGrid())

function toggleGrid(): void {
  showGrid.value = !showGrid.value
  try {
    localStorage.setItem(GRID_STORAGE_KEY, showGrid.value ? '1' : '0')
  } catch {
    // Gesperrter Speicher: Auswahl gilt nur für diese Sitzung.
  }
}

// --- Volle Auflösung (Vorschau in Projektgröße, wie die Ausgabedatei) --------

const FULL_STORAGE_KEY = 'videoCutter.previewFull'

function storedFull(): boolean {
  try {
    return localStorage.getItem(FULL_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

/** Gewünscht: Vorschau in voller Auflösung. Normalfall ist die schnelle, kleine Vorschau. */
const fullRes = ref(storedFull())
/** Der Server kennt die volle Auflösung nicht (veraltetes Backend). */
const fullUnsupported = ref(false)

function toggleFull(): void {
  fullRes.value = !fullRes.value
  fullUnsupported.value = false
  try {
    localStorage.setItem(FULL_STORAGE_KEY, fullRes.value ? '1' : '0')
  } catch {
    // Gesperrter Speicher: Auswahl gilt nur für diese Sitzung.
  }
  schedulePlan(0)
}

const timeLabel = computed(
  () =>
    `${formatTimeMs(timeToSeconds(store.playhead))} / ${formatTimeMs(timeToSeconds(store.duration))}`,
)
const message = computed(() => {
  if (problem.value === 'browser') return t('timelinePreview.browser')
  if (problem.value === PREVIEW_UNSUPPORTED || problem.value === GRAPHICS_UNSUPPORTED)
    return t('timelinePreview.unsupported')
  if (problem.value) return problem.value
  if (empty.value) return t('timelinePreview.empty')
  return buffered.value ? '' : t('timelinePreview.rendering')
})
const speedLabel = computed(() => {
  const s = stats.value
  if (!s || !s.rendered || !s.avgMs) return ''
  const fmt = (v: number) =>
    v.toLocaleString(locale.value, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  return t('timelinePreview.speed', { sec: fmt(s.avgMs / 1000), speed: fmt(s.speed) })
})

let engine: PreviewEngine | null = null
let planTimer: ReturnType<typeof setTimeout> | undefined
let planCtrl: AbortController | null = null
let statsAt = 0
let raf = 0
/** Letzter Abspielkopf, den der Player selbst gesetzt hat (kein Sprung nötig). */
let synced = -1

function refreshBuffered(): void {
  buffered.value = !!engine && engine.isBuffered(store.playhead)
}

/** Bild zur Zeit `time` (µs) zeigen: mitten ins Bild zielen, damit Rundung nicht das vorige trifft. */
function showFrame(time: number, force = false): void {
  const el = video.value
  if (!el || empty.value) return
  const end = timeToSeconds(store.duration)
  const target = Math.max(
    0,
    Math.min(timeToSeconds(time), end - frameSec.value) + frameSec.value / 2,
  )
  if (force || Math.abs(el.currentTime - target) > 1e-4) el.currentTime = target
}

function loadStats(): void {
  const now = Date.now()
  if (now - statsAt < 3000) return
  statsAt = now
  fetchPreviewStats()
    .then((s) => (stats.value = s))
    .catch(() => undefined)
}

async function requestPlan(): Promise<void> {
  planCtrl?.abort()
  planCtrl = null
  if (!engine) return
  if (empty.value) {
    engine.setPlan(null)
    refreshBuffered()
    return
  }
  const ctrl = (planCtrl = new AbortController())
  const full = fullRes.value
  try {
    // Formen und Emojis zeichnet der Browser: Bilder vorab hochladen. Hat der
    // Server eines nicht mehr (Zwischenspeicher geleert), noch einmal.
    let plan = await fetchPreviewPlan(
      await graphicImages.prepare(store.doc),
      store.playhead,
      ctrl.signal,
      full,
    )
    for (let retry = 0; retry < 2 && plan.missingGraphics.length > 0; retry++) {
      if (ctrl.signal.aborted) return
      graphicImages.forget(plan.missingGraphics)
      plan = await fetchPreviewPlan(
        await graphicImages.prepare(store.doc),
        store.playhead,
        ctrl.signal,
        full,
      )
    }
    if (ctrl.signal.aborted || !engine) return
    problem.value = null
    // Altes Backend übergeht den Wunsch und liefert weiter die kleine Vorschau.
    fullUnsupported.value = full && !plan.full
    engine.setPlan(plan)
    engine.setPosition(store.playhead)
    refreshBuffered()
  } catch (e) {
    if (ctrl.signal.aborted) return
    problem.value = e instanceof Error ? e.message : String(e)
  }
}

function schedulePlan(delay = PLAN_DELAY_MS): void {
  clearTimeout(planTimer)
  planTimer = setTimeout(() => void requestPlan(), delay)
}

function stopLoop(): void {
  if (raf) cancelAnimationFrame(raf)
  raf = 0
}

/** Während des Abspielens folgt der Abspielkopf dem Bild. */
function tick(): void {
  raf = 0
  const el = video.value
  if (!el || !store.playing) return
  const fps = store.doc.settings.fps
  if (el.currentTime >= timeToSeconds(store.duration) - frameSec.value / 2) {
    store.seek(store.duration)
    synced = store.playhead
    store.playing = false
    return
  }
  store.seek(frameTime(Math.floor(el.currentTime * fps + 1e-3), fps))
  synced = store.playhead
  raf = requestAnimationFrame(tick)
}

watch(
  () => store.playing,
  (on) => {
    const el = video.value
    stopLoop()
    if (!el) return
    if (!on) {
      el.pause()
      showFrame(store.playhead)
      return
    }
    if (!engine || empty.value || problem.value) {
      store.playing = false
      return
    }
    // Am Ende angekommen: von vorn.
    if (store.playhead >= store.duration - Math.round(frameSec.value * MICROS_PER_SECOND))
      store.seek(0)
    synced = store.playhead
    engine.setPosition(store.playhead)
    showFrame(store.playhead)
    el.play().catch(() => undefined)
    raf = requestAnimationFrame(tick)
  },
)

watch(
  () => store.playhead,
  (time) => {
    engine?.setPosition(time)
    refreshBuffered()
    if (time !== synced) showFrame(time)
  },
)

/** Drop-Effekte der Marker als Vergleichswert (Zeit + Effekt). */
const effectsOf = new WeakMap<TimelineDoc, string>()
function markerEffects(doc: TimelineDoc): string {
  let key = effectsOf.get(doc)
  if (key === undefined) {
    key = JSON.stringify(doc.markers.filter((m) => m.effect).map((m) => [m.at, m.effect]))
    effectsOf.set(doc, key)
  }
  return key
}

watch(
  () => store.doc,
  (next: TimelineDoc, prev: TimelineDoc) => {
    // Nur angemeldete Medien, Marker-Namen o. Ä. geändert: Das Bild bleibt gleich.
    // Drop-Effekte an Markern ändern das Bild (auch beim Verschieben).
    if (
      next.tracks === prev.tracks &&
      next.settings === prev.settings &&
      markerEffects(next) === markerEffects(prev)
    )
      return
    if (empty.value) store.playing = false
    schedulePlan()
  },
)

onMounted(() => {
  const el = video.value
  if (!el) return
  if (!previewSupported()) {
    problem.value = 'browser'
    return
  }
  engine = new PreviewEngine(el, {
    onChange: () => {
      const had = buffered.value
      refreshBuffered()
      // Neu geladenes Bild unter dem ruhenden Abspielkopf anzeigen.
      if (buffered.value && !had && !store.playing) showFrame(store.playhead, true)
      if (buffered.value) loadStats()
    },
    onGone: () => schedulePlan(0),
    onError: (e) => {
      problem.value = e instanceof Error ? e.message : String(e)
    },
  })
  schedulePlan(0)
})

onBeforeUnmount(() => {
  clearTimeout(planTimer)
  planCtrl?.abort()
  stopLoop()
  store.playing = false
  engine?.destroy()
  engine = null
})
</script>

<template>
  <section class="preview" data-testid="preview-player">
    <div class="backdrop" data-testid="preview-backdrop">
      <span v-if="!empty" class="format" data-testid="preview-format">{{ formatLabel }}</span>
      <div
        class="screen"
        data-testid="preview-screen"
        :style="{ aspectRatio: aspect, '--screen-ratio': String(ratio) }"
      >
        <video
          v-show="!empty"
          ref="video"
          playsinline
          preload="auto"
          data-testid="preview-video"
          @click="store.togglePlay()"
        />
        <PositionFrame v-if="!empty && !problem && !store.cropEditing" />
        <CropFrame v-if="!empty" />
        <div v-if="showGrid && !empty" class="grid" aria-hidden="true" data-testid="preview-grid">
          <i class="v" style="left: 33.333%"></i>
          <i class="v" style="left: 66.667%"></i>
          <i class="h" style="top: 33.333%"></i>
          <i class="h" style="top: 66.667%"></i>
        </div>
        <p v-if="message" class="message" :class="{ over: !empty && !problem }" role="status">
          {{ message }}
        </p>
      </div>
    </div>
    <div class="controls">
      <button
        type="button"
        class="play jump"
        data-testid="preview-to-start"
        :disabled="empty || store.playhead <= 0"
        :title="t('timelinePreview.toStartTitle')"
        :aria-label="t('timelinePreview.toStart')"
        @click="jumpTo('start')"
      >
        ⏮
      </button>
      <button
        type="button"
        class="play"
        data-testid="preview-play"
        :disabled="empty || !!problem"
        :title="t(store.playing ? 'timelinePreview.pauseTitle' : 'timelinePreview.playTitle')"
        :aria-label="t(store.playing ? 'timelinePreview.pause' : 'timelinePreview.play')"
        @click="store.togglePlay()"
      >
        {{ store.playing ? '❚❚' : '▶' }}
      </button>
      <button
        type="button"
        class="play jump"
        data-testid="preview-to-end"
        :disabled="empty || store.playhead >= store.duration"
        :title="t('timelinePreview.toEndTitle')"
        :aria-label="t('timelinePreview.toEnd')"
        @click="jumpTo('end')"
      >
        ⏭
      </button>
      <span class="time" data-testid="preview-time">{{ timeLabel }}</span>
      <div
        class="nudge"
        role="group"
        :aria-label="t('timelinePreview.nudge.label')"
        data-testid="preview-nudge"
      >
        <button
          type="button"
          class="nudge-move back"
          data-testid="preview-nudge-back"
          :disabled="!canNudge || store.playhead <= 0"
          :title="t('timelinePreview.nudge.backTitle', { ms: nudgeStep })"
          :aria-label="t('timelinePreview.nudge.backTitle', { ms: nudgeStep })"
          @click="nudge(-1)"
        >
          −
        </button>
        <button
          v-for="step in NUDGE_STEPS_MS"
          :key="step"
          type="button"
          class="nudge-step"
          :class="{ active: step === nudgeStep }"
          :aria-pressed="step === nudgeStep"
          :data-testid="`preview-nudge-${step}`"
          :title="t('timelinePreview.nudge.stepTitle', { ms: step })"
          @click="chooseNudge(step)"
        >
          {{ step }} ms
        </button>
        <button
          type="button"
          class="nudge-move forward"
          data-testid="preview-nudge-forward"
          :disabled="!canNudge || store.playhead >= store.duration"
          :title="t('timelinePreview.nudge.forwardTitle', { ms: nudgeStep })"
          :aria-label="t('timelinePreview.nudge.forwardTitle', { ms: nudgeStep })"
          @click="nudge(1)"
        >
          +
        </button>
      </div>
      <button
        type="button"
        class="grid-toggle"
        :class="{ active: showGrid }"
        :aria-pressed="showGrid"
        data-testid="preview-grid-toggle"
        :title="t('timelinePreview.gridTitle')"
        @click="toggleGrid"
      >
        {{ t('timelinePreview.grid') }}
      </button>
      <button
        type="button"
        class="grid-toggle"
        :class="{ active: fullRes }"
        :aria-pressed="fullRes"
        data-testid="preview-full-toggle"
        :title="t('timelinePreview.fullTitle')"
        @click="toggleFull"
      >
        {{ t('timelinePreview.full') }}
      </button>
      <span v-if="fullUnsupported" class="full-note" role="status" data-testid="preview-full-note">
        {{ t('timelinePreview.fullUnsupported') }}
      </span>
      <span v-if="speedLabel" class="speed" data-testid="preview-speed">{{ speedLabel }}</span>
    </div>
  </section>
</template>

<style scoped>
.preview {
  display: flex;
  flex-direction: column;
  gap: var(--ds-space-2);
  min-width: 0;
}
/* Fläche um das Bild: zeigt, wo das gewählte Format endet (auch bei schwarzem
   Hintergrund). Gehört nur zur Vorschau, nie zur Ausgabedatei. */
.backdrop {
  position: relative;
  display: flex;
  justify-content: center;
  padding: var(--ds-space-3);
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-lg);
  background-color: var(--ds-surface-2);
  background-image:
    linear-gradient(45deg, var(--ds-surface-3) 25%, transparent 25%),
    linear-gradient(-45deg, var(--ds-surface-3) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, var(--ds-surface-3) 75%),
    linear-gradient(-45deg, transparent 75%, var(--ds-surface-3) 75%);
  background-position:
    0 0,
    0 8px,
    8px -8px,
    -8px 0;
  background-size: 16px 16px;
}
.format {
  position: absolute;
  top: var(--ds-space-1);
  left: var(--ds-space-2);
  z-index: 1;
  padding: 0 var(--ds-space-1);
  border-radius: var(--ds-radius-md);
  background: var(--ds-surface-1);
  color: var(--ds-text-2);
  font-family: var(--ds-font-mono);
  font-size: var(--ds-text-xs);
  pointer-events: none;
}
/* Die Bildfläche hat genau das Seitenverhältnis des Formats: so breit wie
   möglich, aber nie höher als --screen-max-h (keine schwarzen Ränder, die wie
   Bildinhalt aussehen). Der Rahmen ist ein outline und nimmt dem Bild nichts. */
.screen {
  --screen-max-h: 60vh;
  position: relative;
  flex: none;
  width: min(100%, calc(var(--screen-max-h) * var(--screen-ratio, 1.7778)));
  overflow: hidden;
  outline: 2px solid var(--ds-accent);
  outline-offset: 0;
  background: #000;
}
.grid {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.grid i {
  position: absolute;
  background: rgb(255 255 255 / 70%);
  box-shadow: 0 0 0 1px rgb(0 0 0 / 35%);
}
.grid .v {
  top: 0;
  bottom: 0;
  width: 1px;
}
.grid .h {
  left: 0;
  right: 0;
  height: 1px;
}
.grid-toggle {
  height: var(--ds-control-sm);
  padding: 0 var(--ds-space-2);
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  background: var(--ds-surface-2);
  color: var(--ds-text);
  font-size: var(--ds-text-sm);
  cursor: pointer;
}
.grid-toggle.active {
  border-color: var(--ds-accent);
  background: var(--ds-accent);
  color: var(--ds-on-accent);
}
.grid-toggle:hover:not(.active) {
  border-color: var(--ds-accent);
}
.grid-toggle:focus-visible {
  outline: none;
  box-shadow: var(--ds-focus-ring);
}
.screen video {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  cursor: pointer;
}
.message {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0;
  padding: var(--ds-space-4);
  color: #d0d0d0;
  font-size: var(--ds-text-sm);
  text-align: center;
}
.message.over {
  inset: auto 0 0 0;
  padding: var(--ds-space-2);
  background: rgb(0 0 0 / 55%);
  color: #fff;
}
.controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--ds-space-3);
}
.play {
  min-width: var(--ds-control-md, 40px);
  height: var(--ds-control-sm);
  padding: 0 var(--ds-space-3);
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  background: var(--ds-surface-2);
  color: var(--ds-text);
  cursor: pointer;
}
.play.jump {
  min-width: 0;
  padding: 0 var(--ds-space-2);
}
.play:hover:not(:disabled) {
  border-color: var(--ds-accent);
}
.play:disabled {
  opacity: 0.45;
  cursor: default;
}
.play:focus-visible {
  outline: none;
  box-shadow: var(--ds-focus-ring);
}
.time {
  font-family: var(--ds-font-mono);
  font-size: var(--ds-text-sm);
  font-variant-numeric: tabular-nums;
  color: var(--ds-text-2);
}
.nudge {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--ds-space-1);
}
.nudge button {
  height: var(--ds-control-sm);
  padding: 0 var(--ds-space-2);
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  background: var(--ds-surface-2);
  color: var(--ds-text);
  font-family: var(--ds-font-mono);
  font-size: var(--ds-text-sm);
  cursor: pointer;
}
.nudge-move {
  min-width: var(--ds-control-sm);
  font-weight: var(--ds-weight-semibold);
}
/* Wie die Feinschritt-Knöpfe: zurück rot, vor grün. */
.nudge-move.back {
  border-color: var(--ds-danger);
  color: var(--ds-danger);
}
.nudge-move.forward {
  border-color: var(--ds-success);
  color: var(--ds-success);
}
.nudge-step.active {
  border-color: var(--ds-accent);
  background: var(--ds-accent);
  color: var(--ds-on-accent);
}
.nudge button:hover:not(:disabled):not(.active) {
  border-color: var(--ds-accent);
}
.nudge button:disabled {
  opacity: 0.45;
  cursor: default;
}
.nudge button:focus-visible {
  outline: none;
  box-shadow: var(--ds-focus-ring);
}
.full-note {
  font-size: 0.75rem;
  color: var(--ds-danger, #c0392b);
}

.speed {
  margin-left: auto;
  font-size: var(--ds-text-xs, var(--ds-text-sm));
  color: var(--ds-text-2);
}
</style>
