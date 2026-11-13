<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { storeToRefs } from 'pinia'
import { useAiStore } from '@/stores/ai'
import { useTextOverlayStore } from '@/stores/textOverlays'
import { useVideoEditorStore } from '@/stores/videoEditor'
import {
  AI_CANCELLED,
  AI_UNSUPPORTED,
  type SubtitleTarget,
  type TranscribeLanguage,
  type TranslateTarget,
} from '@/lib/aiApi'
import { formatTimeMs } from '@/lib/timeFormat'

/**
 * Seitenleisten-Karte „KI-Assistent": Sprache erkennen (Whisper auf dem
 * Server), daraus Untertitel (Claude) als Text-Einblendungen erzeugen und
 * Schnittvorschläge (Füllwörter, Versprecher, Pausen) als Schnittmarken
 * übernehmen.
 */
const props = defineProps<{
  /** Lokale ID des markierten Videos. */
  itemId: number | null
  mediaId: string | null
  /** Video fertig hochgeladen? */
  ready: boolean
  hasAudio: boolean
  /** Läuft ein Schnitt-/Einbrenn-Job? */
  busy: boolean
}>()

const emit = defineEmits<{ (e: 'seek', sec: number): void }>()

const { t, te } = useI18n()
const ai = useAiStore()
const { status, statusChecked, task, taskItemId, progress, running } = storeToRefs(ai)
const texts = useTextOverlayStore()
const editor = useVideoEditorStore()

onMounted(() => void ai.loadStatus())

const language = ref<TranscribeLanguage>('auto')
const target = ref<SubtitleTarget>('original')
const replaceTexts = ref(false)
const minPause = ref(1.2)
const translateTarget = ref<TranslateTarget>('en')
const error = ref('')
const notice = ref('')

// Meldungen gehören zum Video, bei dem sie entstanden sind.
watch(
  () => props.itemId,
  () => {
    error.value = ''
    notice.value = ''
  },
)

const data = computed(() =>
  props.itemId === null ? null : ai.dataFor(props.itemId, props.mediaId),
)
const transcript = computed(() => data.value?.transcript ?? null)
const suggestions = computed(() => data.value?.suggestions ?? [])
const checked = computed(() => suggestions.value.filter((s) => s.checked))
const checkedSeconds = computed(() => checked.value.reduce((n, s) => n + (s.end - s.start), 0))

const outdated = computed(() => statusChecked.value && status.value === null)
const canTranscribe = computed(() => status.value?.transcribe === true)
const canClaude = computed(() => status.value?.claude === true)
const disabled = computed(
  () => props.busy || running.value || !props.ready || !props.mediaId || props.itemId === null,
)
/** Läuft der aktuelle KI-Auftrag für dieses Video? */
const runningHere = computed(() => running.value && taskItemId.value === props.itemId)

function langName(code: string): string {
  return te(`ai.lang.${code}`) ? t(`ai.lang.${code}`) : code
}

function fail(e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e)
  if (msg === AI_CANCELLED) return
  error.value = msg === AI_UNSUPPORTED ? t('ai.outdated') : msg
}

async function onTranscribe(): Promise<void> {
  if (disabled.value || props.itemId === null || !props.mediaId) return
  error.value = ''
  notice.value = ''
  try {
    await ai.transcribe(props.itemId, props.mediaId, language.value)
  } catch (e) {
    fail(e)
  }
}

async function onSubtitles(): Promise<void> {
  const itemId = props.itemId
  if (disabled.value || itemId === null || !props.mediaId) return
  error.value = ''
  notice.value = ''
  try {
    const { cues, truncated } = await ai.subtitles(itemId, props.mediaId, target.value)
    // Das Video könnte inzwischen gewechselt sein: Texte nur beim richtigen einfügen.
    if (texts.itemId !== itemId) return
    if (!cues.length) {
      notice.value = t('ai.noSpeech')
      return
    }
    const n = texts.addMany(cues, replaceTexts.value)
    notice.value =
      n < cues.length || truncated ? t('ai.subtitlesLimited', { n }) : t('ai.subtitlesAdded', { n })
  } catch (e) {
    fail(e)
  }
}

async function onSuggest(): Promise<void> {
  if (disabled.value || props.itemId === null || !props.mediaId) return
  error.value = ''
  notice.value = ''
  try {
    await ai.suggestCuts(props.itemId, props.mediaId, minPause.value)
    if (!suggestions.value.length) notice.value = t('ai.noSuggestions')
  } catch (e) {
    fail(e)
  }
}

/**
 * Alle Texte des Videos übersetzen und ERSETZEN (Zeit, Position, Design
 * bleiben). Zuordnung über die ID, damit zwischendurch gelöschte Texte nicht
 * verrutschen.
 */
async function onTranslate(): Promise<void> {
  const itemId = props.itemId
  const list = texts.overlays.filter((o) => o.text.trim())
  if (disabled.value || itemId === null || !list.length) return
  error.value = ''
  notice.value = ''
  try {
    const r = await ai.translate(
      itemId,
      list.map((o) => o.text),
      translateTarget.value,
    )
    if (texts.itemId !== itemId) return
    let n = 0
    list.forEach((o, i) => {
      const next = r.texts[i]
      if (next === undefined || next === o.text) return
      if (!texts.overlays.some((x) => x.id === o.id)) return
      texts.update(o.id, { text: next })
      n++
    })
    notice.value = r.missing
      ? t('ai.translatedPartly', { n, m: r.missing })
      : t('ai.translated', { n })
  } catch (e) {
    fail(e)
  }
}

function onApply(): void {
  if (props.itemId === null || !checked.value.length) return
  const list = checked.value
  editor.addRemoveRanges(list.map((s) => ({ start: s.start, end: s.end })))
  ai.dropSuggestions(
    props.itemId,
    list.map((s) => s.id),
  )
  notice.value = t('ai.applied', { n: list.length })
}

function toggleAll(): void {
  if (props.itemId === null) return
  ai.setAllChecked(props.itemId, checked.value.length !== suggestions.value.length)
}

const taskLabel = computed(() => {
  if (!task.value) return ''
  return `${t(`ai.running.${task.value}`)} ${task.value === 'transcribe' ? `${progress.value}%` : ''}`.trim()
})
</script>

<template>
  <section class="card ai-panel">
    <div class="card-head">
      <h3 class="panel-title">{{ t('ai.title') }}</h3>
    </div>

    <p v-if="outdated" class="hint warn">{{ t('ai.outdated') }}</p>
    <template v-else-if="statusChecked">
      <p v-if="!canTranscribe" class="hint warn">{{ t('ai.noWhisper') }}</p>
      <p v-else-if="!canClaude" class="hint warn">{{ t('ai.noClaude') }}</p>
      <p v-if="ready && !hasAudio" class="hint">{{ t('ai.noAudio') }}</p>

      <!-- 1. Sprache erkennen -->
      <label class="field-col">
        <span class="field-label">{{ t('ai.language') }}</span>
        <select v-model="language" class="input" :disabled="disabled">
          <option value="auto">{{ t('ai.lang.auto') }}</option>
          <option value="de">{{ t('ai.lang.de') }}</option>
          <option value="en">{{ t('ai.lang.en') }}</option>
        </select>
      </label>
      <button
        class="btn block"
        type="button"
        :disabled="disabled || !canTranscribe || !hasAudio"
        :title="t('ai.transcribeHint')"
        @click="onTranscribe"
      >
        {{ transcript ? t('ai.retranscribe') : t('ai.transcribe') }}
      </button>

      <div v-if="runningHere" class="running" role="status">
        <span class="spinner" aria-hidden="true"></span>
        <span class="running-label">{{ taskLabel }}</span>
        <button class="btn tiny" type="button" @click="ai.cancel()">{{ t('ai.cancel') }}</button>
      </div>

      <p v-if="!transcript" class="hint">{{ t('ai.intro') }}</p>
      <details v-else class="transcript">
        <summary>
          {{ t('ai.transcriptInfo', { n: transcript.words, lang: langName(transcript.language) }) }}
        </summary>
        <p class="transcript-text">{{ transcript.text || '—' }}</p>
      </details>

      <!-- Vorhandene Texte übersetzen (braucht kein Transkript) -->
      <div v-if="texts.overlays.length" class="block-sep">
        <span class="field-label">{{ t('ai.translate') }}</span>
        <select v-model="translateTarget" class="input" :disabled="disabled">
          <option value="en">{{ t('ai.target.en') }}</option>
          <option value="de">{{ t('ai.target.de') }}</option>
        </select>
        <button
          class="btn block"
          type="button"
          :disabled="disabled || !canClaude"
          @click="onTranslate"
        >
          {{ t('ai.translateCount', { n: texts.overlays.length }) }}
        </button>
        <p class="hint">{{ t('ai.translateHint') }}</p>
      </div>

      <template v-if="transcript">
        <!-- 2. Untertitel -->
        <div class="block-sep">
          <span class="field-label">{{ t('ai.subtitles') }}</span>
          <select v-model="target" class="input" :disabled="disabled">
            <option value="original">{{ t('ai.target.original') }}</option>
            <option value="de">{{ t('ai.target.de') }}</option>
            <option value="en">{{ t('ai.target.en') }}</option>
          </select>
          <label v-if="texts.overlays.length" class="check">
            <input v-model="replaceTexts" type="checkbox" :disabled="disabled" />
            {{ t('ai.replaceTexts', { n: texts.overlays.length }) }}
          </label>
          <button
            class="btn block"
            type="button"
            :disabled="disabled || !canClaude"
            @click="onSubtitles"
          >
            {{ t('ai.makeSubtitles') }}
          </button>
          <p class="hint">{{ t('ai.subtitlesHint') }}</p>
        </div>

        <!-- 3. Schnittvorschläge -->
        <div class="block-sep">
          <span class="field-label">{{ t('ai.cuts') }}</span>
          <label class="pause-row">
            <span>{{ t('ai.minPause') }}</span>
            <input
              v-model.number="minPause"
              class="input pause"
              type="number"
              min="0.5"
              max="10"
              step="0.1"
              :disabled="disabled"
            />
            <span>s</span>
          </label>
          <button
            class="btn block"
            type="button"
            :disabled="disabled || !canClaude"
            @click="onSuggest"
          >
            {{ suggestions.length ? t('ai.resuggest') : t('ai.suggest') }}
          </button>

          <template v-if="suggestions.length">
            <div class="list-head">
              <button class="btn tiny" type="button" :disabled="busy" @click="toggleAll">
                {{ checked.length === suggestions.length ? t('ai.none') : t('ai.all') }}
              </button>
              <small>{{
                t('ai.selected', { n: checked.length, s: checkedSeconds.toFixed(1) })
              }}</small>
            </div>
            <ul class="sugg-list">
              <li
                v-for="s in suggestions"
                :key="s.id"
                class="sugg-row"
                :class="{ off: !s.checked }"
              >
                <input
                  type="checkbox"
                  :checked="s.checked"
                  :disabled="busy"
                  :aria-label="t('ai.toggle')"
                  @change="
                    ai.setChecked(itemId!, s.id, ($event.target as HTMLInputElement).checked)
                  "
                />
                <button class="sugg-pick" type="button" @click="emit('seek', s.start)">
                  <span class="sugg-top">
                    <span class="kind" :class="s.kind">{{ t(`ai.kind.${s.kind}`) }}</span>
                    <small>{{ formatTimeMs(s.start) }} – {{ formatTimeMs(s.end) }}</small>
                  </span>
                  <span v-if="s.text" class="sugg-text">„{{ s.text }}“</span>
                  <span v-if="s.reason" class="sugg-reason">{{ s.reason }}</span>
                </button>
              </li>
            </ul>
            <button
              class="btn block primary"
              type="button"
              :disabled="busy || !checked.length"
              @click="onApply"
            >
              {{ t('ai.apply', { n: checked.length }) }}
            </button>
            <p class="hint">{{ t('ai.applyHint') }}</p>
          </template>
        </div>
      </template>

      <p v-if="notice" class="hint ok" role="status">{{ notice }}</p>
      <p v-if="error" class="hint warn" role="alert">{{ error }}</p>
    </template>
  </section>
</template>

<style scoped>
.card {
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  padding: 12px;
  background: var(--ds-surface-1);
}
.ai-panel {
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
.hint {
  margin: 0;
  font-size: var(--ds-text-xs);
  color: var(--ds-text-2);
}
.hint.warn {
  color: var(--ds-danger);
}
.hint.ok {
  color: var(--ds-text);
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
.btn.block {
  width: 100%;
  text-align: center;
  border-color: var(--ds-accent);
  font-weight: var(--ds-weight-semibold);
}
.btn.block:hover:not(:disabled) {
  background: var(--ds-accent-soft);
}
.btn.primary {
  background: var(--ds-accent);
  color: var(--ds-on-accent);
}
.btn.primary:hover:not(:disabled) {
  background: var(--ds-accent-hover);
  border-color: var(--ds-accent-hover);
}
.field-col {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.field-label {
  font-size: var(--ds-text-sm);
  color: var(--ds-text-2);
}
.input {
  width: 100%;
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
.block-sep {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 10px;
  border-top: 1px dashed var(--ds-border);
}
.running {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--ds-text-sm);
}
.running-label {
  flex: 1;
  font-variant-numeric: tabular-nums;
}
.spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--ds-border-strong);
  border-top-color: var(--ds-accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .spinner {
    animation: none;
  }
}
.transcript summary {
  cursor: pointer;
  font-size: var(--ds-text-sm);
}
.transcript-text {
  margin: 6px 0 0;
  max-height: 160px;
  overflow-y: auto;
  font-size: var(--ds-text-xs);
  color: var(--ds-text-2);
  white-space: pre-wrap;
}
.check,
.pause-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--ds-text-sm);
}
.input.pause {
  width: 72px;
  flex: none;
}
.list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: var(--ds-text-xs);
  color: var(--ds-text-2);
}
.sugg-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 320px;
  overflow-y: auto;
}
.sugg-row {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 6px;
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  background: var(--ds-surface-2);
}
.sugg-row.off {
  opacity: 0.55;
}
.sugg-row input {
  margin-top: 3px;
  accent-color: var(--ds-accent);
}
.sugg-pick {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.sugg-pick:focus-visible {
  outline: none;
  box-shadow: var(--ds-focus-ring);
  border-radius: var(--ds-radius-sm);
}
.sugg-top {
  display: flex;
  align-items: center;
  gap: 6px;
}
.sugg-top small {
  color: var(--ds-text-2);
  font-size: var(--ds-text-xs);
  font-variant-numeric: tabular-nums;
}
.kind {
  padding: 1px 6px;
  border-radius: var(--ds-radius-full);
  background: var(--ds-accent-soft);
  font-size: var(--ds-text-xs);
  font-weight: var(--ds-weight-semibold);
}
.kind.pause {
  background: var(--ds-surface-0);
  border: 1px solid var(--ds-border-strong);
}
.sugg-text {
  font-size: var(--ds-text-sm);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sugg-reason {
  font-size: var(--ds-text-xs);
  color: var(--ds-text-2);
}
</style>
