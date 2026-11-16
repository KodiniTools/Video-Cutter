<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { formatSpeedFactor, SPEED_STEPS, speedFactor } from '@/lib/clipSpeed'
import { formatTimeMs } from '@/lib/timeFormat'
import { useTimelineStore } from '@/stores/timeline'
import {
  MAX_CLIP_GAIN,
  MIN_CROP_SIZE,
  timeToSeconds,
  type AudioClip,
  type VideoClip,
} from '@/timeline/model'

/**
 * Einstellungen des markierten Video- bzw. Ton-Clips: Tempo (gilt für Bild
 * und verknüpften Ton gemeinsam) und Lautstärke des Ton-Clips. Jede Änderung
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
  grid-template-columns: 4.5em minmax(0, 1fr) 3.5em;
  align-items: center;
  gap: var(--ds-space-2);
}
.value {
  text-align: right;
  font-variant-numeric: tabular-nums;
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
