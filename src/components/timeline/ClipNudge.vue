<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { formatTimeMs } from '@/lib/timeFormat'
import { useTimelineStore } from '@/stores/timeline'
import { nudgeSpan, timeToSeconds, type NudgeTarget, type OpError } from '@/timeline/model'

/**
 * Knopfleiste „Zeitlich verschieben“ für alles Markierte (Video, Ton, Texte,
 * Formen/Emojis, Bilder; auch mehrere zugleich): in Schritten von 5 bis
 * 1000 ms vor oder zurück, oder mit Anfang bzw. Ende an den Abspielkopf.
 * Verknüpfte Clips wandern mit; „Ganze Spur“ nimmt alle Clips der Spur mit.
 * Jeder Klick ist ein Rückgängig-Schritt.
 */
const { t } = useI18n()
const store = useTimelineStore()

/** Schritte in ms; die Leiste zeigt erst die rückwärts, dann die vorwärts. */
const STEPS_MS = [1000, 100, 10, 5] as const
const back = STEPS_MS.map((ms) => -ms)
const forward = [...STEPS_MS].reverse()

const wholeTracks = ref(false)
/** Nachbarn kürzen, statt an ihnen hängen zu bleiben (z. B. lückenlose Untertitel). */
const trimNeighbours = ref(false)
const error = ref<OpError | null>(null)

const span = computed(() =>
  nudgeSpan(store.doc, store.selection, { wholeTracks: wholeTracks.value }),
)
const range = computed(() =>
  span.value
    ? t('timeline.nudge.range', {
        from: formatTimeMs(timeToSeconds(span.value.start)),
        to: formatTimeMs(timeToSeconds(span.value.end)),
      })
    : '',
)

// Neue Auswahl: alter Hinweis gilt nicht mehr.
watch(
  () => store.selection,
  () => (error.value = null),
)

const ERRORS: Partial<Record<OpError, string>> = {
  overlap: 'timeline.nudge.overlap',
  'track-locked': 'timeline.hint.locked',
  'invalid-time': 'timeline.nudge.beforeZero',
}
const errorText = computed(() => {
  if (error.value === 'overlap' && trimNeighbours.value) return t('timeline.nudge.overlapTrim')
  const key = error.value ? ERRORS[error.value] : undefined
  return key ? t(key) : ''
})

function run(target: NudgeTarget): void {
  const opts = { wholeTracks: wholeTracks.value, trimNeighbours: trimNeighbours.value }
  error.value = store.nudgeSelection(target, opts) ? null : store.lastError
}

const label = (ms: number) => `${ms > 0 ? '+' : '−'}${Math.abs(ms)}`
</script>

<template>
  <section v-if="span" class="inspector" data-testid="clip-nudge">
    <h3>{{ t('timeline.nudge.title') }}</h3>
    <p class="hint" data-testid="clip-nudge-range">{{ range }}</p>
    <div class="steps" role="group" :aria-label="t('timeline.nudge.title')">
      <button
        v-for="ms in back"
        :key="ms"
        type="button"
        class="step back"
        :data-testid="`clip-nudge-back-${-ms}`"
        :disabled="span.start <= 0"
        :title="t('timeline.nudge.backTitle', { ms: -ms })"
        @click="run({ by: ms * 1000 })"
      >
        {{ label(ms) }}
      </button>
      <button
        v-for="ms in forward"
        :key="ms"
        type="button"
        class="step forward"
        :data-testid="`clip-nudge-forward-${ms}`"
        :title="t('timeline.nudge.forwardTitle', { ms })"
        @click="run({ by: ms * 1000 })"
      >
        {{ label(ms) }}
      </button>
    </div>
    <p class="hint unit">{{ t('timeline.nudge.unit') }}</p>
    <div class="align">
      <button
        type="button"
        class="action"
        data-testid="clip-nudge-start-at-playhead"
        :disabled="span.start === store.playhead"
        :title="t('timeline.nudge.startTitle')"
        @click="run({ startAt: store.playhead })"
      >
        ⇤ {{ t('timeline.nudge.start') }}
      </button>
      <button
        type="button"
        class="action"
        data-testid="clip-nudge-end-at-playhead"
        :disabled="span.end === store.playhead"
        :title="t('timeline.nudge.endTitle')"
        @click="run({ endAt: store.playhead })"
      >
        {{ t('timeline.nudge.end') }} ⇥
      </button>
    </div>
    <label class="check">
      <input v-model="wholeTracks" type="checkbox" data-testid="clip-nudge-whole-track" />
      <span>{{ t('timeline.nudge.wholeTrack') }}</span>
    </label>
    <label class="check">
      <input v-model="trimNeighbours" type="checkbox" data-testid="clip-nudge-trim-neighbours" />
      <span>{{ t('timeline.nudge.trimNeighbours') }}</span>
    </label>
    <p v-if="errorText" class="hint warn" role="alert" data-testid="clip-nudge-error">
      {{ errorText }}
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
.hint {
  margin: 0;
  color: var(--ds-text-2);
  font-size: var(--ds-text-xs);
  font-variant-numeric: tabular-nums;
}
.hint.unit {
  margin-top: calc(-1 * var(--ds-space-2));
}
.hint.warn {
  color: var(--ds-danger);
}
.steps {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--ds-space-1, 4px);
}
.step,
.action {
  padding: var(--ds-space-2) var(--ds-space-1, 4px);
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  background: var(--ds-surface-2);
  color: inherit;
  font: inherit;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}
/* Rückwärts rot, vorwärts grün – wie die Feinschritt-Knöpfe im bisherigen Editor. */
.step.back {
  border-color: color-mix(in srgb, var(--ds-danger) 55%, var(--ds-border));
  color: var(--ds-danger);
}
.step.forward {
  border-color: color-mix(in srgb, var(--ds-success) 55%, var(--ds-border));
  color: var(--ds-success);
}
.step:disabled,
.action:disabled {
  opacity: 0.45;
  cursor: default;
}
.align {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--ds-space-2);
}
.check {
  display: flex;
  align-items: center;
  gap: var(--ds-space-2);
}
</style>
