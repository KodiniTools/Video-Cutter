<script setup lang="ts">
import { computed, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import RangeSpinner from './RangeSpinner.vue'
import { formatTimeMs } from '@/lib/timeFormat'
import { useTimelineStore } from '@/stores/timeline'
import { clipToSource, envelopeAt, visiblePoints } from '@/timeline/envelope'
import {
  MAX_CLIP_GAIN,
  MAX_ENVELOPE_POINTS,
  timeToSeconds,
  type AudioClip,
  type VolumePoint,
} from '@/timeline/model'

/**
 * Lautstärke-Kurve eines Ton-Clips: Punkte am Abspielkopf setzen, je Punkt
 * die Lautstärke einstellen, Punkte entfernen. Die Linie liegt auf dem Clip.
 */
const props = defineProps<{ clip: AudioClip }>()

const { t } = useI18n()
const store = useTimelineStore()

const points = computed<VolumePoint[]>(() => props.clip.envelope ?? [])
/** Punkte im sichtbaren Teil des Clips, mit ihrer Zeit auf der Timeline. */
const rows = computed(() =>
  visiblePoints(props.clip).map((p) => {
    const time = props.clip.start + p.offset
    return { ...p, time, label: formatTimeMs(timeToSeconds(time)) }
  }),
)
const hidden = computed(() => points.value.length - rows.value.length)

/** Zeit des Abspielkopfs im Clip, oder `null`, wenn er nicht auf dem Clip steht. */
const offset = computed(() => {
  const o = store.playhead - props.clip.start
  return o >= 0 && o <= props.clip.duration ? o : null
})
const full = computed(() => points.value.length >= MAX_ENVELOPE_POINTS)

let editing = false
function commit(): void {
  if (!editing) return
  editing = false
  store.endGesture()
}
onBeforeUnmount(commit)

/** Neuer Punkt mit dem Wert, den die Kurve dort schon hat: Zu hören ist erst die Änderung. */
function add(): void {
  commit()
  if (offset.value === null || full.value) return
  const at = clipToSource(props.clip, offset.value)
  if (points.value.some((p) => p.at === at)) return
  store.setClipEnvelope(props.clip.id, [
    ...points.value,
    { at, gain: envelopeAt(points.value, at) },
  ])
}

/** Regler ziehen: bis `commit` ein einziger Rückgängig-Schritt. */
function onGain(index: number, e: Event): void {
  const percent = Number((e.target as HTMLInputElement).value)
  if (!Number.isFinite(percent)) return
  if (!editing) {
    store.beginGesture()
    editing = true
  }
  store.setClipEnvelope(
    props.clip.id,
    points.value.map((p, i) => (i === index ? { ...p, gain: percent / 100 } : p)),
  )
}

function remove(index: number): void {
  commit()
  store.setClipEnvelope(
    props.clip.id,
    points.value.filter((_, i) => i !== index),
  )
}

function clear(): void {
  commit()
  store.setClipEnvelope(props.clip.id, null)
}
</script>

<template>
  <fieldset class="envelope" data-testid="clip-envelope">
    <legend>{{ t('timeline.clipInspector.envelope.title') }}</legend>
    <button
      type="button"
      class="action"
      data-testid="clip-envelope-add"
      :disabled="offset === null || full"
      @click="add"
    >
      {{ t('timeline.clipInspector.envelope.add') }}
    </button>
    <p v-if="full" class="hint">{{ t('timeline.clipInspector.envelope.full') }}</p>
    <p v-else-if="offset === null" class="hint">
      {{ t('timeline.clipInspector.envelope.addOutside') }}
    </p>
    <ul v-if="rows.length" class="points" data-testid="clip-envelope-points">
      <li v-for="row in rows" :key="row.index">
        <button
          type="button"
          class="time"
          :title="t('timeline.clipInspector.envelope.seek', { time: row.label })"
          @click="store.seek(row.time)"
        >
          {{ row.label }}
        </button>
        <RangeSpinner
          min="0"
          :max="MAX_CLIP_GAIN * 100"
          step="5"
          :value="Math.round(row.gain * 100)"
          :aria-label="t('timeline.clipInspector.envelope.gain', { time: row.label })"
          :reset="100"
          :data-testid="`clip-envelope-gain-${row.index}`"
          @input="onGain(row.index, $event)"
          @change="commit"
        />
        <span class="value">%</span>
        <button
          type="button"
          class="remove"
          :title="t('timeline.clipInspector.envelope.remove', { time: row.label })"
          :aria-label="t('timeline.clipInspector.envelope.remove', { time: row.label })"
          :data-testid="`clip-envelope-remove-${row.index}`"
          @click="remove(row.index)"
        >
          ✕
        </button>
      </li>
    </ul>
    <p v-if="hidden > 0" class="hint" data-testid="clip-envelope-hidden">
      {{ t('timeline.clipInspector.envelope.hidden', hidden) }}
    </p>
    <button
      v-if="points.length"
      type="button"
      class="action"
      data-testid="clip-envelope-clear"
      @click="clear"
    >
      {{ t('timeline.clipInspector.envelope.clear') }}
    </button>
    <p class="hint">{{ t('timeline.clipInspector.envelope.hint') }}</p>
  </fieldset>
</template>

<style scoped>
.envelope {
  display: flex;
  flex-direction: column;
  gap: var(--ds-space-2);
  margin: 0;
  padding: 0;
  border: 0;
  min-width: 0;
}
legend {
  padding: 0;
  margin-bottom: var(--ds-space-2);
  color: var(--ds-text-2);
}
.action {
  height: var(--ds-control-sm);
  padding: 0 var(--ds-space-3);
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  background: var(--ds-surface-2);
  color: var(--ds-text);
  font-size: var(--ds-text-sm);
  cursor: pointer;
}
.action:hover:not(:disabled) {
  border-color: var(--ds-accent);
}
.action:disabled {
  opacity: 0.45;
  cursor: default;
}
.points {
  display: flex;
  flex-direction: column;
  gap: var(--ds-space-1);
  margin: 0;
  padding: 0;
  list-style: none;
}
.points li {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  align-items: center;
  gap: var(--ds-space-2);
}
.time {
  padding: 0;
  border: 0;
  background: none;
  color: var(--ds-text);
  font-family: var(--ds-font-mono);
  font-size: var(--ds-text-xs);
  font-variant-numeric: tabular-nums;
  text-decoration: underline;
  cursor: pointer;
}
.value {
  font-size: var(--ds-text-sm);
  font-variant-numeric: tabular-nums;
  text-align: right;
  color: var(--ds-text-2);
}
.remove {
  width: 22px;
  height: 22px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--ds-radius-sm);
  background: none;
  color: var(--ds-text-2);
  cursor: pointer;
}
.remove:hover {
  border-color: var(--ds-border-strong);
}
.action:focus-visible,
.time:focus-visible,
.remove:focus-visible {
  outline: none;
  box-shadow: var(--ds-focus-ring);
}
.hint {
  margin: 0;
  font-size: var(--ds-text-xs);
  color: var(--ds-text-2);
}
</style>
