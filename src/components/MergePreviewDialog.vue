<script lang="ts">
/** Ein Clip der Vorschau mit dem verwendeten Bereich (Von/Bis aus der Liste). */
export interface MergePreviewClip {
  name: string
  start: number
  /** Ende des verwendeten Bereichs (Dateiende, wenn nicht gekürzt). */
  end: number
  /** In der Liste gekürzt (Von > 0 oder Bis gesetzt)? */
  trimmed: boolean
  /** Standbild danach (Sekunden, Lücke bis zum nächsten Clip). */
  hold?: number
}
</script>

<script setup lang="ts">
/**
 * Vorschau des Zusammenfügens: spielt die vom Server erzeugte, kleine
 * Vorschaudatei in einem modalen Dialog ab. „Jetzt zusammenfügen" startet
 * das echte Zusammenfügen mit denselben Einstellungen.
 */
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { formatTimeMs } from '@/lib/timeFormat'

const props = defineProps<{
  /** Objekt-URL der Vorschaudatei; `null` = Dialog geschlossen. */
  src: string | null
  /** Zusammenfügen gerade nicht möglich (z. B. Liste geändert, Vorgang läuft). */
  mergeDisabled?: boolean
  /** Clips in Reihenfolge mit dem Bereich, den diese Vorschau verwendet. */
  clips?: MergePreviewClip[]
}>()

const emit = defineEmits<{
  close: []
  merge: []
}>()

const { t } = useI18n()
const dialogEl = ref<HTMLDialogElement | null>(null)
const videoEl = ref<HTMLVideoElement | null>(null)

function sync(open: boolean): void {
  const d = dialogEl.value
  if (!d) return
  if (open && !d.open) {
    // showModal fehlt in alten Browsern/jsdom -> Fallback auf open-Attribut.
    if (typeof d.showModal === 'function') d.showModal()
    else d.setAttribute('open', '')
  } else if (!open && d.open) {
    videoEl.value?.pause()
    if (typeof d.close === 'function') d.close()
    else d.removeAttribute('open')
  }
}

watch(
  () => props.src,
  (src) => sync(src !== null),
)
onMounted(() => sync(props.src !== null))
onBeforeUnmount(() => videoEl.value?.pause())

/** Esc schließt den nativen Dialog selbst – den Zustand nachziehen. */
function onCancel(e: Event): void {
  e.preventDefault()
  emit('close')
}
/** Klick auf den abgedunkelten Hintergrund schließt. */
function onBackdrop(e: MouseEvent): void {
  if (e.target === dialogEl.value) emit('close')
}
</script>

<template>
  <dialog
    ref="dialogEl"
    class="merge-preview"
    :aria-label="t('mergePreview.title')"
    @cancel="onCancel"
    @click="onBackdrop"
  >
    <div v-if="src" class="box">
      <header class="head">
        <h2 class="title">{{ t('mergePreview.title') }}</h2>
        <button
          class="btn tiny ghost"
          type="button"
          :aria-label="t('mergePreview.close')"
          @click="emit('close')"
        >
          ✕
        </button>
      </header>
      <video ref="videoEl" class="video" :src="src" controls autoplay playsinline></video>
      <div v-if="clips?.length" class="clips">
        <p class="clips-title">{{ t('mergePreview.clips') }}</p>
        <ol class="clip-list">
          <li v-for="(c, i) in clips" :key="i" class="clip" :class="{ trimmed: c.trimmed }">
            <span class="clip-name">{{ c.name }}</span>
            <span class="clip-range">
              {{ formatTimeMs(c.start) }} – {{ formatTimeMs(c.end) }}
              <template v-if="c.end > c.start"> · {{ formatTimeMs(c.end - c.start) }} </template>
              <em v-if="c.trimmed" class="clip-tag">{{ t('mergePreview.trimmed') }}</em>
              <em v-if="(c.hold ?? 0) > 0.001" class="clip-tag">
                {{ t('mergePreview.hold', { sec: formatTimeMs(c.hold ?? 0) }) }}
              </em>
            </span>
          </li>
        </ol>
      </div>
      <p class="hint">{{ t('mergePreview.hint') }}</p>
      <div class="actions">
        <button class="btn" type="button" @click="emit('close')">
          {{ t('mergePreview.close') }}
        </button>
        <button class="btn primary" type="button" :disabled="mergeDisabled" @click="emit('merge')">
          {{ t('mergePreview.merge') }}
        </button>
      </div>
    </div>
  </dialog>
</template>

<style scoped>
.merge-preview {
  /* Globales Reset setzt margin: 0 – zentrieren wie der Browser-Standard. */
  margin: auto;
  padding: 0;
  border: 1px solid var(--ds-border-strong);
  border-radius: var(--ds-radius-lg);
  background: var(--ds-surface-1);
  color: var(--ds-text);
  box-shadow: var(--ds-shadow-overlay);
  width: min(920px, calc(100vw - 32px));
  max-height: calc(100vh - 32px);
}
.merge-preview::backdrop {
  background: rgb(0 0 0 / 0.65);
}
.box {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.title {
  margin: 0;
  font-size: var(--ds-text-lg);
  font-weight: var(--ds-weight-semibold);
}
.video {
  display: block;
  width: 100%;
  max-height: calc(100vh - 320px);
  min-height: 120px;
  background: #000;
  border-radius: var(--ds-radius-sm);
}
.clips {
  max-height: 110px;
  overflow-y: auto;
  font-size: var(--ds-text-sm);
}
.clips-title {
  margin: 0 0 4px;
  color: var(--ds-text-2);
}
.clip-list {
  margin: 0;
  padding-left: 22px;
}
.clip {
  line-height: 1.5;
}
.clip-name {
  margin-right: 8px;
  overflow-wrap: anywhere;
}
.clip-range {
  font-family: var(--ds-font-mono);
  font-size: var(--ds-text-xs);
  font-variant-numeric: tabular-nums;
  color: var(--ds-text-2);
  white-space: nowrap;
}
.clip.trimmed .clip-range {
  color: var(--ds-text);
}
.clip-tag {
  margin-left: 6px;
  font-family: inherit;
  font-style: normal;
  color: var(--ds-success);
}
.hint {
  margin: 0;
  font-size: var(--ds-text-sm);
  color: var(--ds-text-2);
}
.actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
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
.btn:hover {
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
  border-color: transparent;
}
.btn.primary {
  background: var(--ds-accent);
  border-color: var(--ds-accent);
  color: var(--ds-on-accent);
  font-weight: var(--ds-weight-semibold);
}
.btn.primary:hover:not(:disabled) {
  background: var(--ds-accent-hover);
  border-color: var(--ds-accent-hover);
}
</style>
