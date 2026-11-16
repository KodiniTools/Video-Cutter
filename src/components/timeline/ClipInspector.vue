<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { formatSpeedFactor, SPEED_STEPS, speedFactor } from '@/lib/clipSpeed'
import { formatTimeMs } from '@/lib/timeFormat'
import { useTimelineStore } from '@/stores/timeline'
import { MAX_CLIP_GAIN, timeToSeconds, type AudioClip, type VideoClip } from '@/timeline/model'

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
