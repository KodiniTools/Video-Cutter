<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { formatSpeedFactor, SPEED_STEPS, speedFactor } from '@/lib/clipSpeed'
import { formatTimeMs } from '@/lib/timeFormat'
import { useTimelineStore } from '@/stores/timeline'
import {
  CLIP_TRANSITIONS,
  FADE_CURVES,
  MAX_CLIP_FADE,
  MAX_CLIP_GAIN,
  MAX_TRANSITION,
  MIN_CROP_SIZE,
  MIN_LAYOUT_SCALE,
  MIN_TRANSITION,
  repeatLimit,
  secondsToTime,
  timeToSeconds,
  type AudioClip,
  type ClipLayout,
  type ClipTransitionPreset,
  type FadeCurve,
  type VideoClip,
} from '@/timeline/model'

/**
 * Einstellungen des markierten Video- bzw. Ton-Clips: Tempo (gilt für Bild
 * und verknüpften Ton gemeinsam), Lautstärke und Blende des Ton-Clips,
 * Zuschnitt, Lage im Bild (Bild-in-Bild) und Übergang des Video-Clips. Jede Änderung
 * geht ins Dokument; die Vorschau rendert den betroffenen Abschnitt neu.
 */
const { t, locale } = useI18n()
const store = useTimelineStore()

/** Markiert ist genau ein Clip oder ein verknüpftes Paar aus Bild und Ton. */
const clips = computed<(VideoClip | AudioClip)[]>(() => {
  const all = store.selectedClips
  if (all.length === 0 || all.length > 2) return []
  const media = all.filter(
    (c): c is VideoClip | AudioClip => c.kind === 'video' || c.kind === 'audio',
  )
  if (media.length !== all.length) return []
  if (media.length === 2 && (!media[0].linkGroup || media[0].linkGroup !== media[1].linkGroup)) {
    return []
  }
  return media
})
const main = computed(() => clips.value[0] ?? null)
const audio = computed(() => clips.value.find((c): c is AudioClip => c.kind === 'audio') ?? null)
const name = computed(() => (main.value ? (store.doc.assets[main.value.asset]?.name ?? '') : ''))

/** Stufen wie im bisherigen Editor (−2,5 … +2,5); der Clip trägt den Faktor. */
const steps = SPEED_STEPS.map((step) => ({ step, factor: speedFactor(step) }))
const step = computed(() => {
  const speed = main.value?.speed ?? 1
  return steps.find((s) => Math.abs(s.factor - speed) < 1e-6)?.step ?? null
})
const speedLabel = (s: number) => formatSpeedFactor(s, locale.value)
/** Tempo außerhalb der Stufen (z. B. aus einem anderen Stand): nur anzeigen. */
const customSpeed = computed(() =>
  step.value === null && main.value
    ? `${main.value.speed.toLocaleString(locale.value, { maximumFractionDigits: 2 })}×`
    : '',
)

/** Spätere Clips mitverschieben, wenn sich die Länge ändert. */
const ripple = ref(true)
const failed = ref(false)
watch(main, () => (failed.value = false))

function onSpeed(e: Event): void {
  commit()
  const clip = main.value
  const picked = Number((e.target as HTMLSelectElement).value)
  if (!clip || !Number.isFinite(picked)) return
  failed.value = !store.setClipSpeed(clip.id, speedFactor(picked), { ripple: ripple.value })
}

const gainPercent = computed(() => Math.round((audio.value?.gain ?? 1) * 100))
let editing = false

/** Regler ziehen: bis `commit` ein einziger Rückgängig-Schritt. */
function onGain(e: Event): void {
  const clip = audio.value
  if (!clip) return
  if (!editing) {
    store.beginGesture()
    editing = true
  }
  store.setClipGain(clip.id, Number((e.target as HTMLInputElement).value) / 100)
}

function commit(): void {
  if (!editing) return
  editing = false
  store.endGesture()
}

// --- Ton-Blende --------------------------------------------------------------

const FADE_SIDES = ['in', 'out'] as const
type FadeSide = (typeof FADE_SIDES)[number]
const fadeOf = (side: FadeSide) => (side === 'in' ? audio.value?.fadeIn : audio.value?.fadeOut)
const fadeSeconds = (side: FadeSide) => timeToSeconds(fadeOf(side)?.duration ?? 0)
/** Beide Blenden zusammen passen in den Clip (höchstens 10 s je Seite). */
const maxFadeSeconds = (side: FadeSide) => {
  const clip = audio.value
  if (!clip) return 0
  const other = fadeOf(side === 'in' ? 'out' : 'in')?.duration ?? 0
  const room = Math.max(0, Math.min(MAX_CLIP_FADE, clip.duration - other))
  return Math.floor(timeToSeconds(room) * 10) / 10
}
const fadeLabel = (side: FadeSide) =>
  fadeSeconds(side).toLocaleString(locale.value, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })

function onFade(side: FadeSide, e: Event): void {
  const clip = audio.value
  if (!clip) return
  if (!editing) {
    store.beginGesture()
    editing = true
  }
  const seconds = Number((e.target as HTMLInputElement).value)
  store.setClipFade(clip.id, side, { duration: secondsToTime(seconds) })
}

function onFadeCurve(side: FadeSide, e: Event): void {
  commit()
  const clip = audio.value
  const fade = fadeOf(side)
  if (!clip || !fade) return
  const curve = (e.target as HTMLSelectElement).value as FadeCurve
  store.setClipFade(clip.id, side, { duration: fade.duration, curve })
}

// --- Schleife ------------------------------------------------------------------

/** Nur eigenständige Ton-Clips (Musik), nicht der Ton eines Videos. */
const canRepeat = computed(() => audio.value !== null && !audio.value.linkGroup)
/** Bis hierhin würde wiederholt; `null` = nichts zu füllen. */
const repeatUntil = computed(() => (audio.value ? repeatLimit(store.doc, audio.value.id) : null))

function onRepeat(): void {
  commit()
  if (audio.value && repeatUntil.value !== null) store.repeatClip(audio.value.id)
}

// --- Zuschnitt (Ränder in Anteilen der Quelle) ------------------------------

const video = computed(() => clips.value.find((c): c is VideoClip => c.kind === 'video') ?? null)
const CROP_SIDES = ['left', 'right', 'top', 'bottom'] as const
type CropSide = (typeof CROP_SIDES)[number]

/** Abgeschnittene Ränder des Clips (0 = nichts). */
const margins = computed<Record<CropSide, number>>(() => {
  const c = video.value?.crop
  if (!c) return { left: 0, right: 0, top: 0, bottom: 0 }
  return {
    left: c.x,
    right: Math.max(0, 1 - c.x - c.width),
    top: c.y,
    bottom: Math.max(0, 1 - c.y - c.height),
  }
})
const cropped = computed(() => CROP_SIDES.some((side) => margins.value[side] > 0))
const percent = (v: number) => Math.round(v * 1000) / 10
/** So viel darf ein Rand höchstens wegnehmen (der Rest bleibt mindestens sichtbar). */
const maxMargin = (side: CropSide) => {
  const m = margins.value
  const other =
    side === 'left' ? m.right : side === 'right' ? m.left : side === 'top' ? m.bottom : m.top
  return Math.max(0, 1 - MIN_CROP_SIZE - other)
}

function onCrop(side: CropSide, e: Event): void {
  const clip = video.value
  if (!clip) return
  if (!editing) {
    store.beginGesture()
    editing = true
  }
  const value = Number((e.target as HTMLInputElement).value) / 100
  const m = { ...margins.value, [side]: Math.min(maxMargin(side), Math.max(0, value)) }
  store.setClipCrop(clip.id, {
    x: m.left,
    y: m.top,
    width: 1 - m.left - m.right,
    height: 1 - m.top - m.bottom,
  })
}

function resetCrop(): void {
  commit()
  if (video.value) store.setClipCrop(video.value.id, null)
}

// --- Bild-in-Bild (Größe, Lage, Deckkraft) -----------------------------------

const LAYOUT_FIELDS = ['scale', 'opacity', 'x', 'y'] as const
type LayoutField = (typeof LAYOUT_FIELDS)[number]
const FULL_LAYOUT: ClipLayout = { x: 0.5, y: 0.5, scale: 1, opacity: 1 }
const layout = computed<ClipLayout>(() => video.value?.layout ?? FULL_LAYOUT)
const hasLayout = computed(() => video.value?.layout !== undefined)
const layoutMin = (field: LayoutField) => (field === 'scale' ? MIN_LAYOUT_SCALE * 100 : 0)
/** In voller Größe gibt es nichts zu verschieben. */
const layoutDisabled = (field: LayoutField) =>
  (field === 'x' || field === 'y') && layout.value.scale >= 1

function onLayout(field: LayoutField, e: Event): void {
  const clip = video.value
  if (!clip) return
  if (!editing) {
    store.beginGesture()
    editing = true
  }
  const value = Number((e.target as HTMLInputElement).value) / 100
  store.setClipLayout(clip.id, { ...layout.value, [field]: value })
}

/** Abstand zum Bildrand beim Legen in eine Ecke (Anteil des Projektformats). */
const CORNER_MARGIN = 0.03
const CORNERS = ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'] as const
type Corner = (typeof CORNERS)[number]

/** In eine Ecke legen; ein Clip in voller Größe wird dabei auf ein Drittel verkleinert. */
function toCorner(corner: Corner): void {
  commit()
  const clip = video.value
  if (!clip) return
  const scale = layout.value.scale >= 1 ? 0.33 : layout.value.scale
  const near = CORNER_MARGIN + scale / 2
  store.setClipLayout(clip.id, {
    ...layout.value,
    scale,
    x: corner === 'topLeft' || corner === 'bottomLeft' ? near : 1 - near,
    y: corner === 'topLeft' || corner === 'topRight' ? near : 1 - near,
  })
}

function resetLayout(): void {
  commit()
  if (video.value) store.setClipLayout(video.value.id, null)
}

// --- Übergang am Anfang ------------------------------------------------------

const transition = computed(() => video.value?.transitionIn ?? null)
const transitionSeconds = computed(() =>
  transition.value ? timeToSeconds(transition.value.duration) : 1,
)
const transitionLabel = computed(() =>
  transitionSeconds.value.toLocaleString(locale.value, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }),
)

function onTransitionPreset(e: Event): void {
  commit()
  const clip = video.value
  if (!clip) return
  const value = (e.target as HTMLSelectElement).value
  store.setClipTransition(clip.id, value === '' ? null : { preset: value as ClipTransitionPreset })
}

function onTransitionDuration(e: Event): void {
  const clip = video.value
  const current = transition.value
  if (!clip || !current) return
  if (!editing) {
    store.beginGesture()
    editing = true
  }
  const seconds = Number((e.target as HTMLInputElement).value)
  store.setClipTransition(clip.id, {
    preset: current.preset,
    duration: secondsToTime(seconds),
  })
}

function onHold(e: Event): void {
  commit()
  if (video.value) store.setClipHold(video.value.id, (e.target as HTMLInputElement).checked)
}

const timing = computed(() => {
  const clip = main.value
  if (!clip) return ''
  const used = Math.round(clip.duration * clip.speed)
  return t('timeline.clipInspector.timing', {
    length: formatTimeMs(timeToSeconds(clip.duration)),
    from: formatTimeMs(timeToSeconds(clip.sourceIn)),
    to: formatTimeMs(timeToSeconds(clip.sourceIn + used)),
  })
})

onBeforeUnmount(commit)
</script>

<template>
  <section v-if="main" class="inspector" data-testid="clip-inspector" @focusout="commit">
    <h3>{{ t('timeline.clipInspector.title') }}</h3>
    <p class="name" :title="name">{{ name }}</p>
    <p class="hint" data-testid="clip-timing">{{ timing }}</p>
    <label class="field">
      <span>{{ t('timeline.clipInspector.speed') }}</span>
      <select :value="step ?? ''" data-testid="clip-speed" @change="onSpeed">
        <option v-if="step === null" value="" disabled>{{ customSpeed }}</option>
        <option v-for="s in steps" :key="s.step" :value="s.step">
          {{ speedLabel(s.step)
          }}{{ s.step === 0 ? ` (${t('timeline.clipInspector.normal')})` : '' }}
        </option>
      </select>
    </label>
    <label class="check">
      <input v-model="ripple" type="checkbox" data-testid="clip-speed-ripple" />
      <span>{{ t('timeline.clipInspector.ripple') }}</span>
    </label>
    <p v-if="failed" class="hint warn" role="alert" data-testid="clip-speed-error">
      {{ t('timeline.clipInspector.noRoom') }}
    </p>
    <label v-if="audio" class="field">
      <span>{{ t('timeline.clipInspector.gain') }} {{ gainPercent }} %</span>
      <input
        type="range"
        min="0"
        :max="MAX_CLIP_GAIN * 100"
        step="5"
        :value="gainPercent"
        data-testid="clip-gain"
        @input="onGain"
        @change="commit"
      />
    </label>
    <fieldset v-if="audio" class="crop" data-testid="clip-fade">
      <legend>{{ t('timeline.clipInspector.fade') }}</legend>
      <template v-for="side in FADE_SIDES" :key="side">
        <label class="side">
          <span>{{ t(`timeline.clipInspector.fadeSides.${side}`) }}</span>
          <input
            type="range"
            min="0"
            :max="maxFadeSeconds(side)"
            step="0.1"
            :value="fadeSeconds(side)"
            :data-testid="`clip-fade-${side}`"
            @input="onFade(side, $event)"
            @change="commit"
          />
          <span class="value">{{ fadeLabel(side) }} s</span>
        </label>
        <label v-if="fadeOf(side)" class="side curve">
          <span>{{ t('audioFade.curve') }}</span>
          <select
            :value="fadeOf(side)?.curve"
            :data-testid="`clip-fade-${side}-curve`"
            @change="onFadeCurve(side, $event)"
          >
            <option v-for="c in FADE_CURVES" :key="c" :value="c">
              {{ t(`audioFade.curves.${c}`) }}
            </option>
          </select>
        </label>
      </template>
      <p class="hint">{{ t('timeline.clipInspector.fadeHint') }}</p>
    </fieldset>
    <template v-if="canRepeat">
      <button
        type="button"
        class="repeat"
        :disabled="repeatUntil === null"
        data-testid="clip-repeat"
        @click="onRepeat"
      >
        {{ t('timeline.clipInspector.repeat') }}
      </button>
      <p class="hint">
        {{
          repeatUntil === null
            ? t('timeline.clipInspector.repeatNone')
            : t('timeline.clipInspector.repeatHint', {
                time: formatTimeMs(timeToSeconds(repeatUntil)),
              })
        }}
      </p>
    </template>
    <fieldset v-if="video" class="crop" data-testid="clip-transition">
      <legend>{{ t('timeline.clipInspector.transition') }}</legend>
      <label class="side curve">
        <span>{{ t('timeline.clipInspector.transitionType') }}</span>
        <select
          :value="transition?.preset ?? ''"
          data-testid="clip-transition-preset"
          @change="onTransitionPreset"
        >
          <option value="">{{ t('anim.none') }}</option>
          <option v-for="p in CLIP_TRANSITIONS" :key="p" :value="p">{{ t(`anim.${p}`) }}</option>
        </select>
      </label>
      <label v-if="transition" class="side">
        <span>{{ t('timeline.clipInspector.transitionDuration') }}</span>
        <input
          type="range"
          :min="timeToSeconds(MIN_TRANSITION) * 2"
          :max="timeToSeconds(MAX_TRANSITION)"
          step="0.1"
          :value="transitionSeconds"
          data-testid="clip-transition-duration"
          @input="onTransitionDuration"
          @change="commit"
        />
        <span class="value">{{ transitionLabel }} s</span>
      </label>
      <p class="hint">{{ t('timeline.clipInspector.transitionHint') }}</p>
    </fieldset>
    <label v-if="video" class="check">
      <input
        type="checkbox"
        :checked="video.hold === true"
        data-testid="clip-hold"
        @change="onHold"
      />
      <span>{{ t('timeline.clipInspector.hold') }}</span>
    </label>
    <p v-if="video" class="hint">{{ t('timeline.clipInspector.holdHint') }}</p>
    <fieldset v-if="video" class="crop" data-testid="clip-crop">
      <legend>{{ t('timeline.clipInspector.crop') }}</legend>
      <label v-for="side in CROP_SIDES" :key="side" class="side">
        <span>{{ t(`timeline.clipInspector.cropSides.${side}`) }}</span>
        <input
          type="range"
          min="0"
          :max="Math.round(maxMargin(side) * 100)"
          step="1"
          :value="Math.round(margins[side] * 100)"
          :data-testid="`clip-crop-${side}`"
          @input="onCrop(side, $event)"
          @change="commit"
        />
        <span class="value">{{ percent(margins[side]) }} %</span>
      </label>
      <button
        v-if="cropped"
        type="button"
        class="plain"
        data-testid="clip-crop-reset"
        @click="resetCrop"
      >
        {{ t('timeline.clipInspector.cropReset') }}
      </button>
      <p class="hint">{{ t('timeline.clipInspector.cropHint') }}</p>
    </fieldset>
    <fieldset v-if="video" class="crop" data-testid="clip-layout">
      <legend>{{ t('timeline.clipInspector.layout') }}</legend>
      <label v-for="field in LAYOUT_FIELDS" :key="field" class="side">
        <span>{{ t(`timeline.clipInspector.layoutFields.${field}`) }}</span>
        <input
          type="range"
          :min="layoutMin(field)"
          max="100"
          step="1"
          :value="Math.round(layout[field] * 100)"
          :disabled="layoutDisabled(field)"
          :data-testid="`clip-layout-${field}`"
          @input="onLayout(field, $event)"
          @change="commit"
        />
        <span class="value">{{ Math.round(layout[field] * 100) }} %</span>
      </label>
      <div class="corners">
        <span>{{ t('timeline.clipInspector.layoutCorner') }}</span>
        <button
          v-for="corner in CORNERS"
          :key="corner"
          type="button"
          class="corner"
          :title="t(`timeline.clipInspector.layoutCorners.${corner}`)"
          :aria-label="t(`timeline.clipInspector.layoutCorners.${corner}`)"
          :data-testid="`clip-layout-${corner}`"
          @click="toCorner(corner)"
        >
          <span :class="['dot', corner]" aria-hidden="true"></span>
        </button>
      </div>
      <button
        v-if="hasLayout"
        type="button"
        class="plain"
        data-testid="clip-layout-reset"
        @click="resetLayout"
      >
        {{ t('timeline.clipInspector.layoutReset') }}
      </button>
      <p class="hint">{{ t('timeline.clipInspector.layoutHint') }}</p>
    </fieldset>
    <p class="hint">
      {{ audio ? t('timeline.clipInspector.hint') : t('timeline.clipInspector.hintNoAudio') }}
    </p>
  </section>
</template>

<style scoped>
.inspector {
  display: flex;
  flex-direction: column;
  gap: var(--ds-space-3);
  padding: var(--ds-space-4);
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-lg);
  background: var(--ds-surface-1);
  font-size: var(--ds-text-sm);
}
h3 {
  margin: 0;
  font-size: var(--ds-text-md, var(--ds-text-sm));
  font-weight: var(--ds-weight-semibold);
}
.name {
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.field {
  display: flex;
  flex-direction: column;
  gap: var(--ds-space-1, 4px);
  min-width: 0;
  color: var(--ds-text-2);
}
.check {
  display: flex;
  align-items: center;
  gap: var(--ds-space-2);
  color: var(--ds-text-2);
}
.crop {
  display: flex;
  flex-direction: column;
  gap: var(--ds-space-2);
  margin: 0;
  padding: 0;
  border: 0;
  color: var(--ds-text-2);
}
.crop legend {
  padding: 0;
  margin-bottom: var(--ds-space-2);
}
.side {
  display: grid;
  grid-template-columns: 6em minmax(0, 1fr) 3.5em;
  align-items: center;
  gap: var(--ds-space-2);
}
.side.curve {
  grid-template-columns: 6em minmax(0, 1fr);
}
.value {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.corners {
  display: flex;
  align-items: center;
  gap: var(--ds-space-2);
}
.corner {
  position: relative;
  width: 2.4em;
  height: 1.6em;
  padding: 0;
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-sm);
  background: var(--ds-surface-2);
  cursor: pointer;
}
.dot {
  position: absolute;
  width: 40%;
  height: 40%;
  border-radius: 2px;
  background: var(--ds-accent);
}
.dot.topLeft {
  top: 2px;
  left: 2px;
}
.dot.topRight {
  top: 2px;
  right: 2px;
}
.dot.bottomLeft {
  bottom: 2px;
  left: 2px;
}
.dot.bottomRight {
  bottom: 2px;
  right: 2px;
}
.repeat {
  padding: var(--ds-space-2) var(--ds-space-3);
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  background: var(--ds-surface-2);
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.repeat:disabled {
  opacity: 0.5;
  cursor: default;
}
.plain {
  align-self: flex-start;
  padding: 0;
  border: 0;
  background: none;
  color: var(--ds-link);
  font: inherit;
  text-decoration: underline;
  cursor: pointer;
}
select {
  width: 100%;
  padding: var(--ds-space-2);
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  background: var(--ds-surface-2);
  color: var(--ds-text);
  font: inherit;
}
input[type='range'] {
  width: 100%;
  accent-color: var(--ds-accent);
}
select:focus-visible,
input:focus-visible {
  outline: none;
  box-shadow: var(--ds-focus-ring);
}
.hint {
  margin: 0;
  color: var(--ds-text-2);
  font-size: var(--ds-text-xs);
  font-variant-numeric: tabular-nums;
}
.hint.warn {
  color: var(--ds-danger);
}
</style>
