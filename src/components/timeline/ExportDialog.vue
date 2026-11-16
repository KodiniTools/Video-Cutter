<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  cancelRender,
  RENDER_QUALITIES,
  RENDER_UNSUPPORTED,
  renderDownloadUrl,
  startRender,
  watchRender,
  type RenderQuality,
  type RenderWatch,
} from '@/lib/renderApi'
import { GRAPHICS_UNSUPPORTED, MissingGraphicsError } from '@/lib/graphicsApi'
import { formatTimeMs } from '@/lib/timeFormat'
import { useTimelineStore } from '@/stores/timeline'
import { graphicImages } from '@/timeline/graphics'
import { timeToSeconds } from '@/timeline/model'

/**
 * Export der Timeline: Der Server rendert in voller Größe mit demselben Code
 * wie die Vorschau. Der Dialog zeigt den Fortschritt und bietet das Ergebnis
 * zum Herunterladen an.
 */

const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const store = useTimelineStore()

type Phase = 'setup' | 'running' | 'done' | 'error'

const dialogEl = ref<HTMLDialogElement | null>(null)
const phase = ref<Phase>('setup')
const quality = ref<RenderQuality>('standard')
const name = ref('projekt')
const normalizeAudio = ref(false)
const progress = ref(0)
const error = ref('')
const downloaded = ref(false)

let jobId: string | null = null
let watch: RenderWatch | null = null
let startCtrl: AbortController | null = null

const summary = computed(() =>
  t('timelineExport.summary', {
    width: store.doc.settings.width,
    height: store.doc.settings.height,
    fps: Math.round(store.doc.settings.fps * 100) / 100,
    duration: formatTimeMs(timeToSeconds(store.duration)),
  }),
)
const downloadUrl = computed(() =>
  phase.value === 'done' && jobId ? renderDownloadUrl(jobId) : '',
)

async function start(): Promise<void> {
  phase.value = 'running'
  progress.value = 0
  error.value = ''
  downloaded.value = false
  const ctrl = (startCtrl = new AbortController())
  try {
    const options = {
      quality: quality.value,
      name: name.value.trim() || 'projekt',
      normalizeAudio: normalizeAudio.value,
    }
    // Formen und Emojis zeichnet der Browser: Bilder vorab hochladen. Hat der
    // Server eines nicht mehr, einmal neu hochladen und wiederholen.
    const begin = async () =>
      startRender(await graphicImages.prepare(store.doc), options, ctrl.signal)
    const id = await begin().catch((e: unknown) => {
      if (!(e instanceof MissingGraphicsError)) throw e
      graphicImages.forget(e.ids)
      return begin()
    })
    if (ctrl.signal.aborted) {
      void cancelRender(id)
      return
    }
    jobId = id
    watch = watchRender(id, (p) => (progress.value = p))
    await watch.done
    if (jobId !== id) return
    watch = null
    progress.value = 100
    phase.value = 'done'
  } catch (e) {
    if (ctrl.signal.aborted) return
    watch = null
    jobId = null
    const msg = e instanceof Error ? e.message : String(e)
    error.value =
      msg === RENDER_UNSUPPORTED || msg === GRAPHICS_UNSUPPORTED
        ? t('timelineExport.unsupported')
        : msg
    phase.value = 'error'
  }
}

/** Laufenden Export abbrechen bzw. nicht abgeholtes Ergebnis verwerfen. */
function discard(): void {
  startCtrl?.abort()
  startCtrl = null
  watch?.stop()
  watch = null
  // Nach dem Download hat der Server bereits aufgeräumt.
  if (jobId && !downloaded.value) void cancelRender(jobId)
  jobId = null
}

function cancel(): void {
  discard()
  phase.value = 'setup'
}

function close(): void {
  discard()
  emit('close')
}

function onCancel(e: Event): void {
  e.preventDefault()
  close()
}

onMounted(() => {
  const d = dialogEl.value
  if (!d) return
  // showModal fehlt in alten Browsern/jsdom -> Fallback auf open-Attribut.
  if (typeof d.showModal === 'function') d.showModal()
  else d.setAttribute('open', '')
})

onBeforeUnmount(discard)
</script>

<template>
  <dialog
    ref="dialogEl"
    class="export"
    data-testid="export-dialog"
    :aria-label="t('timelineExport.title')"
    @cancel="onCancel"
  >
    <div class="box">
      <header class="head">
        <h2>{{ t('timelineExport.title') }}</h2>
        <button
          type="button"
          class="btn ghost"
          :aria-label="t('timelineExport.close')"
          @click="close"
        >
          ✕
        </button>
      </header>
      <p class="summary" data-testid="export-summary">{{ summary }}</p>

      <form v-if="phase === 'setup' || phase === 'error'" class="form" @submit.prevent="start">
        <label class="field">
          <span>{{ t('timelineExport.name') }}</span>
          <span class="name">
            <input v-model="name" type="text" maxlength="80" data-testid="export-name" />
            <span class="ext">.mp4</span>
          </span>
        </label>
        <fieldset class="field">
          <legend>{{ t('timelineExport.quality') }}</legend>
          <label v-for="q in RENDER_QUALITIES" :key="q" class="option">
            <input v-model="quality" type="radio" name="export-quality" :value="q" />
            <span>
              <strong>{{ t(`timelineExport.qualities.${q}.label`) }}</strong>
              <small>{{ t(`timelineExport.qualities.${q}.hint`) }}</small>
            </span>
          </label>
        </fieldset>
        <label class="option">
          <input v-model="normalizeAudio" type="checkbox" data-testid="export-normalize" />
          <span>
            <strong>{{ t('timelineExport.normalize') }}</strong>
            <small>{{ t('timelineExport.normalizeHint') }}</small>
          </span>
        </label>
        <p v-if="phase === 'error'" class="error" role="alert" data-testid="export-error">
          {{ error }}
        </p>
        <div class="actions">
          <button type="button" class="btn" @click="close">{{ t('timelineExport.cancel') }}</button>
          <button type="submit" class="btn primary" data-testid="export-start">
            {{ t(phase === 'error' ? 'timelineExport.retry' : 'timelineExport.start') }}
          </button>
        </div>
      </form>

      <div v-else-if="phase === 'running'" class="form">
        <p role="status">{{ t('timelineExport.running', { pct: Math.round(progress) }) }}</p>
        <progress max="100" :value="progress" data-testid="export-progress" />
        <div class="actions">
          <button type="button" class="btn" data-testid="export-cancel" @click="cancel">
            {{ t('timelineExport.abort') }}
          </button>
        </div>
      </div>

      <div v-else class="form">
        <p role="status">
          {{ t(downloaded ? 'timelineExport.downloaded' : 'timelineExport.done') }}
        </p>
        <div class="actions">
          <button type="button" class="btn" @click="close">{{ t('timelineExport.close') }}</button>
          <a
            v-if="!downloaded"
            class="btn primary"
            :href="downloadUrl"
            download
            data-testid="export-download"
            @click="downloaded = true"
          >
            {{ t('timelineExport.download') }}
          </a>
        </div>
      </div>
    </div>
  </dialog>
</template>

<style scoped>
.export {
  /* Globales Reset setzt margin: 0 – zentrieren wie der Browser-Standard. */
  margin: auto;
  padding: 0;
  border: 1px solid var(--ds-border-strong);
  border-radius: var(--ds-radius-lg);
  background: var(--ds-surface-1);
  color: var(--ds-text);
  box-shadow: var(--ds-shadow-overlay);
  width: min(480px, calc(100vw - 32px));
}
.export::backdrop {
  background: rgb(0 0 0 / 0.65);
}
.box {
  display: flex;
  flex-direction: column;
  gap: var(--ds-space-3);
  padding: var(--ds-space-4);
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--ds-space-3);
}
.head h2 {
  margin: 0;
  font-size: var(--ds-text-lg);
  font-weight: var(--ds-weight-semibold);
}
.summary {
  margin: 0;
  color: var(--ds-text-2);
  font-size: var(--ds-text-sm);
  font-variant-numeric: tabular-nums;
}
.form {
  display: flex;
  flex-direction: column;
  gap: var(--ds-space-3);
}
.form p {
  margin: 0;
}
.field {
  display: flex;
  flex-direction: column;
  gap: var(--ds-space-2);
  margin: 0;
  padding: 0;
  border: 0;
  font-size: var(--ds-text-sm);
}
.field legend {
  padding: 0;
  margin-bottom: var(--ds-space-2);
}
.name {
  display: flex;
  align-items: center;
  gap: var(--ds-space-2);
}
.name input {
  flex: 1;
  min-width: 0;
  height: var(--ds-control-sm);
  padding: 0 var(--ds-space-2);
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  background: var(--ds-surface-2);
  color: var(--ds-text);
}
.ext {
  color: var(--ds-text-2);
}
.option {
  display: flex;
  align-items: flex-start;
  gap: var(--ds-space-2);
  cursor: pointer;
}
.option span {
  display: flex;
  flex-direction: column;
}
.option small {
  color: var(--ds-text-2);
}
.error {
  color: var(--ds-danger);
  font-size: var(--ds-text-sm);
}
progress {
  width: 100%;
  accent-color: var(--ds-accent);
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--ds-space-2);
}
.btn {
  display: inline-flex;
  align-items: center;
  height: var(--ds-control-sm);
  padding: 0 var(--ds-space-3);
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  background: var(--ds-surface-2);
  color: var(--ds-text);
  font-size: var(--ds-text-sm);
  text-decoration: none;
  cursor: pointer;
}
.btn:hover {
  border-color: var(--ds-accent);
}
.btn.primary {
  border-color: var(--ds-accent);
  background: var(--ds-accent);
  color: var(--ds-on-accent);
}
.btn.ghost {
  border-color: transparent;
  background: transparent;
}
.btn:focus-visible,
.name input:focus-visible {
  outline: none;
  box-shadow: var(--ds-focus-ring);
}
</style>
