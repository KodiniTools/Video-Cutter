<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  MAX_SPEED_STEP,
  SPEED_STEP,
  formatSpeedFactor,
  formatSpeedStep,
  speedFactor,
} from '@/lib/clipSpeed'
import { formatTimeMs } from '@/lib/timeFormat'

/**
 * Seitenleisten-Karte „Tempo": das ganze markierte Video schneller oder
 * langsamer machen – eigenständig, ohne Schneiden/Zusammenfügen. Die Stufe
 * (−2,5 … +2,5, wie in der Videoliste) wirkt sofort auf den Player (Vorschau);
 * „Tempo anwenden" lässt den Server das Video neu erzeugen.
 */
const props = defineProps<{
  /** Gewählte Stufe (0 = normal). */
  step: number
  /** Dauer des markierten Videos (Sekunden), 0 = keins/unbekannt. */
  duration: number
  /** Gibt es ein fertig hochgeladenes, markiertes Video? */
  canApply: boolean
  busy: boolean
  /** Läuft gerade „Tempo anwenden"? */
  applying: boolean
  progressLabel: string
  /** Gerade fertig geworden (Hinweis „Herunterladen"). */
  done: boolean
}>()

const emit = defineEmits<{
  (e: 'update:step', step: number): void
  (e: 'apply'): void
}>()

const { t, locale } = useI18n()

const stepText = computed(() => formatSpeedStep(props.step, locale.value))
const factorText = computed(() => formatSpeedFactor(props.step, locale.value))
const newLength = computed(() =>
  props.duration > 0 ? props.duration / speedFactor(props.step) : 0,
)

function onInput(ev: Event): void {
  emit('update:step', Number((ev.target as HTMLInputElement).value))
}
</script>

<template>
  <section class="card speed-panel">
    <div class="card-head">
      <h3 class="panel-title">{{ t('videoSpeed.title') }}</h3>
    </div>
    <p class="hint">{{ t('videoSpeed.intro') }}</p>

    <div class="speed-head">
      <label class="speed-label" for="video-speed">{{ t('videoSpeed.label') }}</label>
      <output class="speed-value" :class="{ changed: step !== 0 }" for="video-speed">
        {{ stepText }} · {{ factorText }}
      </output>
      <button
        class="btn tiny ghost"
        type="button"
        :disabled="step === 0 || busy"
        :title="t('videoSpeed.reset')"
        :aria-label="t('videoSpeed.reset')"
        @click="emit('update:step', 0)"
      >
        ↺
      </button>
    </div>
    <input
      id="video-speed"
      class="speed-range"
      type="range"
      :min="-MAX_SPEED_STEP"
      :max="MAX_SPEED_STEP"
      :step="SPEED_STEP"
      :value="step"
      :disabled="busy || !canApply"
      :aria-valuetext="`${stepText} (${factorText})`"
      @input="onInput"
    />
    <div class="speed-scale" aria-hidden="true">
      <span>−{{ MAX_SPEED_STEP.toLocaleString(locale) }}</span>
      <span>0</span>
      <span>+{{ MAX_SPEED_STEP.toLocaleString(locale) }}</span>
    </div>

    <p v-if="!canApply" class="hint">{{ t('videoSpeed.noVideo') }}</p>
    <p v-else-if="step !== 0 && newLength > 0" class="hint length">
      {{
        t('videoSpeed.newLength', {
          len: formatTimeMs(newLength),
          old: formatTimeMs(duration),
        })
      }}
    </p>

    <button
      class="btn primary apply"
      type="button"
      :disabled="!canApply || step === 0 || busy"
      :title="t('videoSpeed.applyHint')"
      @click="emit('apply')"
    >
      <template v-if="applying">{{ progressLabel }}</template>
      <template v-else>{{ t('videoSpeed.apply') }}</template>
    </button>
    <p v-if="done" class="hint done" role="status">{{ t('videoSpeed.done') }}</p>
  </section>
</template>

<style scoped>
.card {
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  padding: 12px;
  background: var(--ds-surface-1);
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
.btn {
  appearance: none;
  border: 1px solid var(--ds-border-strong);
  background: var(--ds-surface-2);
  color: var(--ds-text);
  padding: 9px 14px;
  border-radius: var(--ds-radius-md);
  font-size: var(--ds-text-md);
  cursor: pointer;
}
.btn:hover:not(:disabled) {
  border-color: var(--ds-accent);
}
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.btn:focus-visible {
  outline: none;
  box-shadow: var(--ds-focus-ring);
}
.btn.tiny {
  padding: 4px 8px;
  font-size: var(--ds-text-sm);
}
.btn.ghost {
  background: transparent;
}
.btn.primary {
  background: var(--ds-accent);
  color: var(--ds-on-accent);
  font-weight: var(--ds-weight-semibold);
}
.btn.primary:hover:not(:disabled) {
  background: var(--ds-accent-hover);
  border-color: var(--ds-accent-hover);
}
.speed-panel {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.hint {
  margin: 0;
  font-size: var(--ds-text-xs);
  line-height: 1.5;
  color: var(--ds-text-2);
}
.hint.length {
  font-family: var(--ds-font-mono);
}
.hint.done {
  color: var(--ds-success, var(--ds-accent));
}
.speed-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
}
.speed-label {
  flex: 1;
  font-size: var(--ds-text-xs);
  color: var(--ds-text-2);
}
.speed-value {
  font-family: var(--ds-font-mono);
  font-size: var(--ds-text-xs);
  color: var(--ds-text-2);
}
.speed-value.changed {
  color: var(--ds-accent);
  font-weight: var(--ds-weight-semibold);
}
.speed-range {
  width: 100%;
  margin: 0;
  accent-color: var(--ds-accent);
}
.speed-scale {
  display: flex;
  justify-content: space-between;
  font-family: var(--ds-font-mono);
  font-size: 10px;
  color: var(--ds-text-2);
}
.apply {
  margin-top: 4px;
}
</style>
