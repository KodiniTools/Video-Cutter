<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { storeToRefs } from 'pinia'
import { useAudioFadeStore } from '@/stores/audioFade'
import {
  AUDIO_FADE_CURVES,
  FADE_STEP_SEC,
  MAX_FADE_SEC,
  MIN_FADE_SEC,
  fadePath,
  type AudioFadeCurve,
} from '@/lib/audioFade'

/**
 * Seitenleisten-Karte „Ton ein- und ausblenden": Dauer und Kurve je Seite.
 * Die Einstellung gilt für jedes Schneiden und Zusammenfügen (siehe Store).
 */
defineProps<{
  busy: boolean
  /** Hat das markierte Video Ton? `null` = kein Video markiert. */
  hasAudio: boolean | null
}>()

const { t } = useI18n()
const store = useAudioFadeStore()
const { settings } = storeToRefs(store)

const SIDES = [
  { key: 'fadeIn', label: 'audioFade.fadeIn', out: false },
  { key: 'fadeOut', label: 'audioFade.fadeOut', out: true },
] as const

function formatSec(s: number): string {
  return `${s.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`
}
</script>

<template>
  <section class="card fade-panel">
    <div class="card-head">
      <h3 class="panel-title">{{ t('audioFade.title') }}</h3>
    </div>

    <div
      v-for="side in SIDES"
      :key="side.key"
      class="fade-side"
      :class="{ off: !settings[side.key].enabled }"
    >
      <label class="check-row">
        <input
          type="checkbox"
          :checked="settings[side.key].enabled"
          :disabled="busy"
          :data-test="`${side.key}-enabled`"
          @change="store.update(side.key, { enabled: ($event.target as HTMLInputElement).checked })"
        />
        <span>{{ t(side.label) }}</span>
      </label>

      <template v-if="settings[side.key].enabled">
        <div class="field-row">
          <label :for="`${side.key}-duration`" class="field-label">
            {{ t('audioFade.duration') }}
          </label>
          <span class="field-value">{{ formatSec(settings[side.key].duration) }}</span>
        </div>
        <input
          :id="`${side.key}-duration`"
          class="range"
          type="range"
          :min="MIN_FADE_SEC"
          :max="MAX_FADE_SEC"
          :step="FADE_STEP_SEC"
          :value="settings[side.key].duration"
          :disabled="busy"
          @input="
            store.update(side.key, {
              duration: Number(($event.target as HTMLInputElement).value),
            })
          "
        />

        <div class="curve-row">
          <label :for="`${side.key}-curve`" class="field-label">{{ t('audioFade.curve') }}</label>
          <select
            :id="`${side.key}-curve`"
            class="input"
            :value="settings[side.key].curve"
            :disabled="busy"
            :data-test="`${side.key}-curve`"
            @change="
              store.update(side.key, {
                curve: ($event.target as HTMLSelectElement).value as AudioFadeCurve,
              })
            "
          >
            <option v-for="c in AUDIO_FADE_CURVES" :key="c" :value="c">
              {{ t(`audioFade.curves.${c}`) }}
            </option>
          </select>
          <svg class="curve" viewBox="-2 -2 64 28" aria-hidden="true">
            <path class="curve-base" d="M0,24 L60,24" />
            <path class="curve-line" :d="fadePath(settings[side.key].curve, side.out)" />
          </svg>
        </div>
      </template>
    </div>

    <p v-if="hasAudio === false && store.active" class="hint warn" role="status">
      {{ t('audioFade.noAudio') }}
    </p>
    <p class="hint">{{ t('audioFade.hint') }}</p>
  </section>
</template>

<style scoped>
.card {
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  padding: 12px;
  background: var(--ds-surface-1);
}
.fade-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.card-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.panel-title {
  margin: 0;
  font-size: var(--ds-text-sm);
  color: var(--ds-text-2);
}
.fade-side {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.check-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: var(--ds-text-md);
  cursor: pointer;
}
.check-row input {
  margin-top: 3px;
  accent-color: var(--ds-accent);
}
.field-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.field-label {
  font-size: var(--ds-text-sm);
  color: var(--ds-text-2);
}
.field-value {
  font-size: var(--ds-text-sm);
  font-weight: var(--ds-weight-semibold);
  font-variant-numeric: tabular-nums;
}
.range {
  width: 100%;
  accent-color: var(--ds-accent);
  cursor: pointer;
}
.range:disabled {
  cursor: not-allowed;
}
.curve-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.input {
  flex: 1;
  min-width: 0;
  padding: 6px 8px;
  border: 1px solid var(--ds-border-strong);
  border-radius: var(--ds-radius-sm);
  background: var(--ds-surface-0);
  color: var(--ds-text);
  font: inherit;
  font-size: var(--ds-text-sm);
}
.input:focus-visible {
  outline: none;
  border-color: var(--ds-accent);
  box-shadow: var(--ds-focus-ring);
}
.curve {
  flex: none;
  width: 64px;
  height: 28px;
}
.curve-base {
  fill: none;
  stroke: var(--ds-border-strong);
  stroke-width: 1;
}
.curve-line {
  fill: none;
  stroke: var(--ds-accent);
  stroke-width: 2;
  stroke-linejoin: round;
  stroke-linecap: round;
}
.hint {
  margin: 0;
  font-size: var(--ds-text-xs);
  color: var(--ds-text-2);
}
.hint.warn {
  color: var(--ds-danger);
}
</style>
