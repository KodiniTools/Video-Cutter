<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { DEFAULT_DUCK, type Track, type TrackPatch } from '@/timeline/model'

/** Kopf einer Spur: Name (Doppelklick zum Umbenennen) und Schalter der Spur. */
const props = defineProps<{
  track: Track
  /** Lässt sich die Spur nach oben/unten schieben? */
  canMoveUp: boolean
  canMoveDown: boolean
  /** Ist die Spur Ziel-Ebene für neue Texte, Formen und Bilder? (nur Ebenen-Spuren) */
  isTarget?: boolean
}>()

const emit = defineEmits<{
  (e: 'update', patch: TrackPatch): void
  (e: 'move', delta: -1 | 1): void
  (e: 'remove'): void
  (e: 'target'): void
}>()

const { t } = useI18n()

const MAX_NAME = 24
const editing = ref(false)
const draft = ref('')
const input = ref<HTMLInputElement | null>(null)

const duck = computed(() => (props.track.kind === 'audio' ? props.track.duck : undefined))
const duckPercent = computed(() => Math.round((duck.value ?? 0) * 100))

/** Stärke des Absenkens aus dem Zahlenfeld (5 … 100 %); Unsinn stellt den alten Wert wieder her. */
function onDuckLevel(event: Event): void {
  const field = event.target as HTMLInputElement
  const typed = field.value.trim() === '' ? Number.NaN : Number(field.value)
  if (Number.isFinite(typed)) {
    const percent = Math.min(100, Math.max(5, Math.round(typed / 5) * 5))
    if (percent !== duckPercent.value) emit('update', { duck: percent / 100 })
  }
  void nextTick(() => (field.value = String(duckPercent.value)))
}

function startRename(): void {
  draft.value = props.track.name
  editing.value = true
  void nextTick(() => {
    input.value?.focus()
    input.value?.select()
  })
}

function commitRename(): void {
  if (!editing.value) return
  editing.value = false
  const name = draft.value.trim().slice(0, MAX_NAME)
  if (name && name !== props.track.name) emit('update', { name })
}

function cancelRename(): void {
  editing.value = false
}
</script>

<template>
  <div class="track-head" :data-locked="track.locked">
    <div class="line">
      <input
        v-if="editing"
        ref="input"
        v-model="draft"
        class="name-input"
        :maxlength="MAX_NAME"
        :aria-label="t('timeline.track.rename')"
        @keydown.enter.prevent="commitRename"
        @keydown.esc.prevent.stop="cancelRename"
        @keydown.stop
        @blur="commitRename"
      />
      <button
        v-else
        type="button"
        class="track-name"
        :title="t('timeline.track.renameTitle')"
        @dblclick="startRename"
        @keydown.enter.prevent="startRename"
        @keydown.f2.prevent="startRename"
      >
        {{ track.name }}
      </button>
      <label v-if="duck !== undefined" class="duck-level" :title="t('timeline.track.duckLevel')">
        <span aria-hidden="true">−</span>
        <input
          type="number"
          min="5"
          max="100"
          step="5"
          data-action="duck-level"
          :value="duckPercent"
          :aria-label="t('timeline.track.duckLevelNamed', { name: track.name })"
          @change="onDuckLevel"
          @keydown.enter.prevent="onDuckLevel"
          @keydown.stop
        />
        <span aria-hidden="true">%</span>
      </label>
      <span v-else class="track-kind">{{ t(`timeline.kind.${track.kind}`) }}</span>
    </div>
    <div class="line buttons">
      <button
        type="button"
        class="mini"
        :disabled="!canMoveUp"
        :title="t('timeline.track.up')"
        :aria-label="t('timeline.track.upNamed', { name: track.name })"
        @click="emit('move', -1)"
      >
        ▲
      </button>
      <button
        type="button"
        class="mini"
        :disabled="!canMoveDown"
        :title="t('timeline.track.down')"
        :aria-label="t('timeline.track.downNamed', { name: track.name })"
        @click="emit('move', 1)"
      >
        ▼
      </button>
      <button
        type="button"
        class="mini"
        data-action="lock"
        :aria-pressed="track.locked"
        :title="t(track.locked ? 'timeline.track.unlock' : 'timeline.track.lock')"
        :aria-label="t('timeline.track.lockNamed', { name: track.name })"
        @click="emit('update', { locked: !track.locked })"
      >
        🔒
      </button>
      <button
        v-if="track.kind === 'audio'"
        type="button"
        class="mini"
        data-action="mute"
        :aria-pressed="track.muted"
        :title="t(track.muted ? 'timeline.track.unmute' : 'timeline.track.mute')"
        :aria-label="t('timeline.track.muteNamed', { name: track.name })"
        @click="emit('update', { muted: !track.muted })"
      >
        🔇
      </button>
      <button
        v-if="track.kind === 'audio'"
        type="button"
        class="mini"
        data-action="duck"
        :aria-pressed="track.duck !== undefined"
        :title="t(track.duck !== undefined ? 'timeline.track.unduck' : 'timeline.track.duck')"
        :aria-label="t('timeline.track.duckNamed', { name: track.name })"
        @click="emit('update', { duck: track.duck !== undefined ? null : DEFAULT_DUCK })"
      >
        🔉
      </button>
      <button
        v-else
        type="button"
        class="mini"
        data-action="hide"
        :aria-pressed="track.hidden"
        :title="t(track.hidden ? 'timeline.track.show' : 'timeline.track.hide')"
        :aria-label="t('timeline.track.hideNamed', { name: track.name })"
        @click="emit('update', { hidden: !track.hidden })"
      >
        🚫
      </button>
      <button
        v-if="track.kind === 'overlay'"
        type="button"
        class="mini"
        data-action="target"
        :aria-pressed="!!isTarget"
        :title="t(isTarget ? 'timeline.track.untarget' : 'timeline.track.target')"
        :aria-label="t('timeline.track.targetNamed', { name: track.name })"
        @click="emit('target')"
      >
        🎯
      </button>
      <button
        type="button"
        class="mini"
        data-action="remove"
        :disabled="track.locked"
        :title="t('timeline.track.remove')"
        :aria-label="t('timeline.track.removeNamed', { name: track.name })"
        @click="emit('remove')"
      >
        ✕
      </button>
    </div>
  </div>
</template>

<style scoped>
.track-head {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
  min-width: 0;
}
.line {
  display: flex;
  align-items: baseline;
  gap: var(--ds-space-2);
  min-width: 0;
}
.buttons {
  align-items: center;
  gap: 2px;
}
.track-name {
  min-width: 0;
  padding: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border: 0;
  background: none;
  color: var(--ds-text);
  font: inherit;
  font-size: var(--ds-text-sm);
  font-weight: var(--ds-weight-semibold);
  text-align: left;
  cursor: text;
}
.name-input {
  width: 100%;
  min-width: 0;
  padding: 0 2px;
  border: 1px solid var(--ds-accent);
  border-radius: var(--ds-radius-sm);
  background: var(--ds-surface-0);
  color: var(--ds-text);
  font: inherit;
  font-size: var(--ds-text-sm);
}
.track-kind {
  flex: none;
  font-size: var(--ds-text-xs);
  color: var(--ds-text-3);
}
.duck-level {
  flex: none;
  display: inline-flex;
  align-items: baseline;
  gap: 2px;
  font-size: var(--ds-text-xs);
  color: var(--ds-text-2);
}
.duck-level input {
  width: 3.4em;
  height: 18px;
  padding: 0 0 0 3px;
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-sm);
  background: var(--ds-surface-0);
  color: var(--ds-text);
  font: inherit;
  font-variant-numeric: tabular-nums;
}
.duck-level input::-webkit-inner-spin-button {
  opacity: 1;
}
.duck-level input:focus-visible {
  outline: none;
  box-shadow: var(--ds-focus-ring);
}
.mini {
  width: 22px;
  height: 20px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--ds-radius-sm);
  background: none;
  color: var(--ds-text-2);
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
  filter: grayscale(1);
  opacity: 0.6;
}
.mini:hover:not(:disabled) {
  border-color: var(--ds-border-strong);
  opacity: 1;
}
.mini[aria-pressed='true'] {
  border-color: var(--ds-accent);
  background: var(--ds-accent-soft);
  filter: none;
  opacity: 1;
}
.mini:disabled {
  opacity: 0.25;
  cursor: default;
}
.mini:focus-visible,
.track-name:focus-visible {
  outline: none;
  box-shadow: var(--ds-focus-ring);
}
</style>
