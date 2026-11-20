<script setup lang="ts">
import { computed, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import RangeSpinner from './RangeSpinner.vue'
import { formatTimeMs } from '@/lib/timeFormat'
import { useTimelineStore } from '@/stores/timeline'
import {
  canAddGraphicKey,
  graphicKeyIndexAt,
  graphicKeys,
  graphicMotionAt,
  graphicSmooth,
  MAX_KEY_SCALE,
  MIN_KEY_SCALE,
  visibleGraphicKeys,
  withGraphicChange,
  withGraphicKeyAt,
  withoutGraphicKey,
} from '@/timeline/graphicKeys'
import { timeToSeconds, type OverlayClip } from '@/timeline/model'

/**
 * Keyframes eines Clips auf einer Ebenen-Spur (Text, Form, Symbol, Emoji,
 * Bild): Keyframe am Abspielkopf setzen, Liste zum Anspringen und Entfernen,
 * Größe am Abspielkopf und weiche Bewegung. `prefix` steht vor den Test-IDs.
 */
const props = defineProps<{ clip: OverlayClip; prefix: 'graphic' | 'text'; hint: string }>()

const { t } = useI18n()
const store = useTimelineStore()

/** Zeit im Clip, an der der Abspielkopf steht (in den Clip geholt). */
const offset = computed(() =>
  Math.min(props.clip.duration, Math.max(0, store.playhead - props.clip.start)),
)
/** Steht der Abspielkopf auf dem Clip? Nur dort lässt sich ein Keyframe setzen. */
const playheadOnClip = computed(
  () =>
    store.playhead >= props.clip.start && store.playhead <= props.clip.start + props.clip.duration,
)
const hasKeys = computed(() => graphicKeys(props.clip.data).length > 0)
const scale = computed(() => graphicMotionAt(props.clip, offset.value).scale)
const keyList = computed(() => {
  const current = graphicKeyIndexAt(props.clip, offset.value)
  return visibleGraphicKeys(props.clip).map((k) => ({
    ...k,
    time: formatTimeMs(timeToSeconds(k.offset)),
    current: playheadOnClip.value && k.index === current,
  }))
})
const hiddenKeys = computed(() => graphicKeys(props.clip.data).length - keyList.value.length)
const canKey = computed(() => playheadOnClip.value && canAddGraphicKey(props.clip, offset.value))
const smooth = computed(() => graphicSmooth(props.clip.data))

let editing = false

/** Größe ziehen: bis `commit` ein Rückgängig-Schritt. */
function onScale(e: Event): void {
  if (!editing) {
    store.beginGesture()
    editing = true
  }
  const value = Number((e.target as HTMLInputElement).value)
  store.updateClipData(props.clip.id, withGraphicChange(props.clip, offset.value, { scale: value }))
}

function commit(): void {
  if (!editing) return
  editing = false
  store.endGesture()
}

function set(patch: Record<string, unknown>): void {
  commit()
  store.updateClipData(props.clip.id, patch)
}

function addKey(): void {
  if (canKey.value) set(withGraphicKeyAt(props.clip, offset.value))
}

function setSmooth(e: Event): void {
  set({ ease: (e.target as HTMLInputElement).checked ? 'smooth' : null })
}

onBeforeUnmount(commit)
</script>

<template>
  <div class="keys" :data-testid="`${prefix}-keys`" @focusout="commit">
    <label v-if="hasKeys" class="field">
      <span>{{ t('timeline.graphicKeys.scale') }} {{ Math.round(scale * 100) }} %</span>
      <RangeSpinner
        :scale="100"
        :min="MIN_KEY_SCALE"
        :max="MAX_KEY_SCALE"
        step="0.01"
        :value="scale"
        :reset="1"
        :data-testid="`${prefix}-key-scale`"
        @input="onScale"
        @change="commit"
      />
    </label>
    <button
      type="button"
      class="plain"
      :disabled="!canKey"
      :title="playheadOnClip ? undefined : t('timeline.clipInspector.keys.addOutside')"
      :data-testid="`${prefix}-key-add`"
      @click="addKey"
    >
      {{ t('timeline.clipInspector.keys.add') }}
    </button>
    <ul v-if="keyList.length" class="key-list">
      <li v-for="key in keyList" :key="key.index" :class="{ current: key.current }">
        <button
          type="button"
          class="key-time"
          :title="t('timeline.clipInspector.keys.seek', { time: key.time })"
          :aria-current="key.current ? 'true' : undefined"
          :data-testid="`${prefix}-key-${key.index}`"
          @click="store.seek(clip.start + key.offset)"
        >
          ◆ {{ key.time }}
        </button>
        <button
          type="button"
          class="key-remove"
          :aria-label="t('timeline.clipInspector.keys.remove', { time: key.time })"
          :title="t('timeline.clipInspector.keys.remove', { time: key.time })"
          :data-testid="`${prefix}-key-remove-${key.index}`"
          @click="set(withoutGraphicKey(clip, key.index))"
        >
          ✕
        </button>
      </li>
    </ul>
    <label v-if="hasKeys" class="check">
      <input
        type="checkbox"
        :checked="smooth"
        :data-testid="`${prefix}-key-ease`"
        @change="setSmooth"
      />
      <span>{{ t('timeline.clipInspector.keys.smooth') }}</span>
    </label>
    <p v-if="hiddenKeys > 0" class="hint" :data-testid="`${prefix}-keys-hidden`">
      {{ t('timeline.clipInspector.keys.hidden', hiddenKeys) }}
    </p>
    <p class="hint">{{ hint }}</p>
  </div>
</template>

<style scoped>
.keys {
  display: flex;
  flex-direction: column;
  gap: var(--ds-space-2);
}
.field {
  display: flex;
  flex-direction: column;
  gap: var(--ds-space-1, 4px);
  min-width: 0;
  color: var(--ds-text-2);
}
.check {
  display: inline-flex;
  align-items: center;
  gap: var(--ds-space-2);
  color: var(--ds-text-2);
  cursor: pointer;
}
.hint {
  margin: 0;
  color: var(--ds-text-2);
  font-size: var(--ds-text-xs, var(--ds-text-sm));
}
.plain {
  align-self: flex-start;
  padding: 0;
  border: 0;
  background: none;
  color: var(--ds-link);
  font: inherit;
  cursor: pointer;
  text-decoration: underline;
}
.plain:disabled {
  color: var(--ds-text-2);
  cursor: default;
}
.key-list {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ds-space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}
.key-list li {
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-full);
  background: var(--ds-surface-1);
}
.key-list li.current {
  border-color: var(--ds-accent);
  background: var(--ds-accent-soft);
}
.key-time,
.key-remove {
  height: var(--ds-control-sm);
  border: 0;
  background: transparent;
  color: var(--ds-text);
  font-size: var(--ds-text-xs);
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}
.key-time {
  padding: 0 var(--ds-space-1) 0 var(--ds-space-2);
}
.key-remove {
  padding: 0 var(--ds-space-2) 0 var(--ds-space-1);
  color: var(--ds-text-2);
}
.key-time:focus-visible,
.key-remove:focus-visible {
  outline: none;
  box-shadow: var(--ds-focus-ring);
  border-radius: var(--ds-radius-full);
}
</style>
