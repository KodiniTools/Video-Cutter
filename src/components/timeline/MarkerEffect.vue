<script setup lang="ts">
import { computed, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import RangeSpinner from './RangeSpinner.vue'
import { useTimelineStore } from '@/stores/timeline'
import {
  DEFAULT_MARKER_EFFECTS,
  MARKER_EFFECTS,
  MAX_EFFECT_DURATION,
  MAX_STROBE_RATE,
  MIN_EFFECT_DURATION,
  MIN_EFFECT_INTENSITY,
  MIN_STROBE_RATE,
  secondsToTime,
  timeToSeconds,
  type Marker,
  type MarkerEffect,
  type MarkerEffectKind,
} from '@/timeline/model'

/**
 * Drop-Effekt eines Markers (wie der Beat-Drop im Visualizer): Art, Farbe,
 * Stärke, Dauer und beim Stroboskop die Blitze je Sekunde. Regler bilden
 * beim Ziehen einen Verlaufsschritt.
 */
const props = defineProps<{ marker: Marker }>()
const emit = defineEmits<{ rejected: [] }>()

const { t } = useI18n()
const store = useTimelineStore()

const effect = computed(() => props.marker.effect ?? null)
let editing = false

function apply(patch: Partial<MarkerEffect> | null): void {
  if (!store.setMarkerEffect(props.marker.id, patch)) emit('rejected')
}

function onKind(e: Event): void {
  commit()
  const value = (e.target as HTMLSelectElement).value
  if (!value) apply(null)
  else if ((MARKER_EFFECTS as readonly string[]).includes(value))
    apply({ kind: value as MarkerEffectKind })
}

function onColor(e: Event): void {
  commit()
  apply({ color: (e.target as HTMLInputElement).value })
}

/** Regler: der erste Schritt öffnet eine Geste, `change` schließt sie. */
function onSlide(patch: Partial<MarkerEffect>): void {
  if (!editing) {
    store.beginGesture()
    editing = true
  }
  apply(patch)
}
const value = (e: Event) => Number((e.target as HTMLInputElement).value)

function commit(): void {
  if (!editing) return
  editing = false
  store.endGesture()
}
onBeforeUnmount(commit)
</script>

<template>
  <div class="marker-effect" data-testid="marker-effect">
    <label class="field">
      <span class="caption">{{ t('timeline.marker.effect.title') }}</span>
      <select
        class="tool wide"
        data-testid="marker-effect-kind"
        :value="effect?.kind ?? ''"
        :title="t('timeline.marker.effect.hint')"
        @change="onKind"
        @keydown.stop
      >
        <option value="">{{ t('timeline.marker.effect.none') }}</option>
        <option v-for="k in MARKER_EFFECTS" :key="k" :value="k">
          {{ t(`timeline.marker.effect.kinds.${k}`) }}
        </option>
      </select>
    </label>
    <template v-if="effect">
      <label class="field">
        <span class="caption">{{ t('timeline.marker.effect.color') }}</span>
        <input
          type="color"
          class="color"
          data-testid="marker-effect-color"
          :value="effect.color"
          @change="onColor"
        />
      </label>
      <label class="field">
        <span class="caption">{{ t('timeline.marker.effect.intensity') }}</span>
        <RangeSpinner
          :min="MIN_EFFECT_INTENSITY"
          max="1"
          step="0.05"
          :scale="100"
          :value="effect.intensity"
          :reset="DEFAULT_MARKER_EFFECTS[effect.kind].intensity"
          data-testid="marker-effect-intensity"
          @input="onSlide({ intensity: value($event) })"
          @change="commit"
        />
        <span class="unit">%</span>
      </label>
      <label class="field">
        <span class="caption">{{ t('timeline.marker.effect.duration') }}</span>
        <RangeSpinner
          :min="timeToSeconds(MIN_EFFECT_DURATION)"
          :max="timeToSeconds(MAX_EFFECT_DURATION)"
          step="0.1"
          :value="timeToSeconds(effect.duration)"
          :reset="timeToSeconds(DEFAULT_MARKER_EFFECTS[effect.kind].duration)"
          data-testid="marker-effect-duration"
          @input="onSlide({ duration: secondsToTime(value($event)) })"
          @change="commit"
        />
        <span class="unit">s</span>
      </label>
      <label v-if="effect.kind === 'strobe'" class="field">
        <span class="caption">{{ t('timeline.marker.effect.rate') }}</span>
        <RangeSpinner
          :min="MIN_STROBE_RATE"
          :max="MAX_STROBE_RATE"
          step="1"
          :value="effect.rate"
          :reset="DEFAULT_MARKER_EFFECTS[effect.kind].rate"
          data-testid="marker-effect-rate"
          @input="onSlide({ rate: value($event) })"
          @change="commit"
        />
        <span class="unit">{{ t('timeline.marker.effect.perSecond') }}</span>
      </label>
    </template>
  </div>
</template>

<style scoped>
.marker-effect {
  display: flex;
  flex-basis: 100%;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--ds-space-2) var(--ds-space-4);
}
.field {
  display: inline-flex;
  align-items: center;
  gap: var(--ds-space-2);
}
.caption,
.unit {
  font-size: var(--ds-text-sm);
  color: var(--ds-text-2);
}
.color {
  width: 36px;
  height: var(--ds-control-sm);
  padding: 0;
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  background: none;
  cursor: pointer;
}
</style>
