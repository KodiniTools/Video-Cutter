<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  fetchPreviewPlan,
  fetchPreviewStats,
  PREVIEW_UNSUPPORTED,
  type PreviewStats,
} from '@/lib/previewApi'
import { formatTimeMs } from '@/lib/timeFormat'
import { PreviewEngine, previewSupported } from '@/preview/player'
import { useTimelineStore } from '@/stores/timeline'
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
const frameSec = computed(() => 1 / store.doc.settings.fps)
const aspect = computed(() => `${store.doc.settings.width} / ${store.doc.settings.height}`)
const timeLabel = computed(
  () =>
    `${formatTimeMs(timeToSeconds(store.playhead))} / ${formatTimeMs(timeToSeconds(store.duration))}`,
)
const message = computed(() => {
  if (problem.value === 'browser') return t('timelinePreview.browser')
  if (problem.value === PREVIEW_UNSUPPORTED) return t('timelinePreview.unsupported')
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
  try {
    const plan = await fetchPreviewPlan(store.doc, store.playhead, ctrl.signal)
    if (ctrl.signal.aborted || !engine) return
    problem.value = null
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

watch(
  () => store.doc,
  (next: TimelineDoc, prev: TimelineDoc) => {
    // Nur angemeldete Medien geändert: Das Bild bleibt gleich.
    if (next.tracks === prev.tracks && next.settings === prev.settings) return
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
    <div class="screen" :style="{ aspectRatio: aspect }">
      <video
        v-show="!empty"
        ref="video"
        playsinline
        preload="auto"
        data-testid="preview-video"
        @click="store.togglePlay()"
      />
      <p v-if="message" class="message" :class="{ over: !empty && !problem }" role="status">
        {{ message }}
      </p>
    </div>
    <div class="controls">
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
      <span class="time" data-testid="preview-time">{{ timeLabel }}</span>
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
.screen {
  position: relative;
  width: 100%;
  max-height: 60vh;
  margin: 0 auto;
  overflow: hidden;
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-lg);
  background: #000;
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
.speed {
  margin-left: auto;
  font-size: var(--ds-text-xs, var(--ds-text-sm));
  color: var(--ds-text-2);
}
</style>
