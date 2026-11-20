<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { storeToRefs } from 'pinia'
import RangeSpinner from './RangeSpinner.vue'
import {
  AI_CANCELLED,
  AI_UNSUPPORTED,
  MAX_SCRIPT_IDEA,
  MAX_SCRIPT_LENGTH,
  MAX_SCRIPT_SECONDS,
  MAX_VOICE_SPEED,
  MIN_SCRIPT_SECONDS,
  MIN_VOICE_SPEED,
  SCRIPT_LANGUAGES,
  fetchVoices,
  parseScript,
  parseVoiceOver,
  runAiJob,
  type AiRun,
  type ScriptLanguage,
  type Voice,
} from '@/lib/aiApi'
import { formatClockDuration, formatTimeMs } from '@/lib/timeFormat'
import { useMediaPoolStore } from '@/stores/mediaPool'
import { useTimelineStore } from '@/stores/timeline'
import { useTimelineAiStore } from '@/stores/timelineAi'
import { timeToSeconds, type Time } from '@/timeline/model'

/**
 * KI-Sprecher: Ein Text (selbst geschrieben, von Claude geschrieben oder
 * übersetzt) wird auf dem Server mit ElevenLabs vertont. Die Tondatei kommt
 * in die Medienliste und auf eine Ton-Spur an die Stelle, an der der
 * Abspielkopf beim Klick stand (wie die Sprachaufnahme).
 *
 * Die Komponente bleibt beim Zuklappen erhalten (v-show), damit Text und ein
 * laufender Auftrag nicht verloren gehen.
 */
const { t } = useI18n()
const pool = useMediaPoolStore()
const timeline = useTimelineStore()
const ai = useTimelineAiStore()
const { status, statusChecked } = storeToRefs(ai)

const VOICE_KEY = 'videoCutter.voiceOver'
/** Startwerte der Regler (auch Ziel des Knopfs ↺). */
const DEFAULT_SECONDS = 30
const DEFAULT_SPEED = 1
const DEFAULT_STABILITY = 0.5

type Task = 'write' | 'translate' | 'speak'

const text = ref('')
const idea = ref('')
const seconds = ref(DEFAULT_SECONDS)
const language = ref<ScriptLanguage>('de')
const voices = ref<Voice[]>([])
const voicesState = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
const voiceId = ref('')
const speed = ref(DEFAULT_SPEED)
const stability = ref(DEFAULT_STABILITY)
const task = ref<Task | null>(null)
const error = ref('')
const notice = ref('')
/** Text vor dem letzten Schreiben/Übersetzen (zum Zurückholen). */
const previous = ref<string | null>(null)

let run: AiRun<unknown> | null = null
let audio: HTMLAudioElement | null = null
const previewing = ref(false)

const outdated = computed(
  () => statusChecked.value && (status.value === null || status.value.voice === null),
)
const canVoice = computed(() => status.value?.voice === true)
const canClaude = computed(() => status.value?.claude === true)
const running = computed(() => task.value !== null)
const voice = computed(() => voices.value.find((v) => v.id === voiceId.value) ?? null)
const tooLong = computed(() => text.value.length > MAX_SCRIPT_LENGTH)
const insertAt = computed(() => formatTimeMs(timeToSeconds(timeline.playhead)))

function loadSettings(): void {
  try {
    const raw = localStorage.getItem(VOICE_KEY)
    const s = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
    if (typeof s.voiceId === 'string') voiceId.value = s.voiceId
    if (typeof s.speed === 'number') speed.value = s.speed
    if (typeof s.stability === 'number') stability.value = s.stability
    if (
      typeof s.language === 'string' &&
      (SCRIPT_LANGUAGES as readonly string[]).includes(s.language)
    ) {
      language.value = s.language as ScriptLanguage
    }
  } catch {
    // Ohne gespeicherte Auswahl gelten die Standardwerte.
  }
}

function saveSettings(): void {
  try {
    localStorage.setItem(
      VOICE_KEY,
      JSON.stringify({
        voiceId: voiceId.value,
        speed: speed.value,
        stability: stability.value,
        language: language.value,
      }),
    )
  } catch {
    // Speichern ist nur Komfort.
  }
}

watch([voiceId, speed, stability, language], saveSettings)

async function loadVoices(): Promise<void> {
  if (!canVoice.value || voicesState.value === 'loading') return
  voicesState.value = 'loading'
  error.value = ''
  try {
    voices.value = await fetchVoices()
    voicesState.value = 'ready'
    if (!voices.value.some((v) => v.id === voiceId.value)) voiceId.value = voices.value[0]?.id ?? ''
  } catch (e) {
    voicesState.value = 'error'
    fail(e)
  }
}

onMounted(async () => {
  loadSettings()
  await ai.loadStatus()
  if (canVoice.value) void loadVoices()
})

function fail(e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e)
  if (msg === AI_CANCELLED) return
  error.value = msg === AI_UNSUPPORTED ? t('ai.outdated') : msg
}

async function start<T>(kind: Task, r: AiRun<T>): Promise<T> {
  task.value = kind
  run = r as AiRun<unknown>
  try {
    return await r.promise
  } finally {
    task.value = null
    run = null
  }
}

async function onWrite(): Promise<void> {
  if (running.value || !idea.value.trim()) return
  error.value = ''
  notice.value = ''
  try {
    const result = await start(
      'write',
      runAiJob(
        'script',
        { mode: 'write', idea: idea.value, language: language.value, seconds: seconds.value },
        parseScript,
      ),
    )
    previous.value = text.value
    text.value = result
  } catch (e) {
    fail(e)
  }
}

async function onTranslate(): Promise<void> {
  if (running.value || !text.value.trim() || tooLong.value) return
  error.value = ''
  notice.value = ''
  try {
    const result = await start(
      'translate',
      runAiJob(
        'script',
        { mode: 'translate', text: text.value, language: language.value },
        parseScript,
      ),
    )
    previous.value = text.value
    text.value = result
  } catch (e) {
    fail(e)
  }
}

function onRestore(): void {
  if (previous.value === null || running.value) return
  text.value = previous.value
  previous.value = null
}

async function onSpeak(): Promise<void> {
  if (running.value || !text.value.trim() || tooLong.value || !voice.value) return
  error.value = ''
  notice.value = ''
  stopPreview()
  const at: Time = timeline.playhead
  try {
    const media = await start(
      'speak',
      runAiJob(
        'voice-over',
        {
          text: text.value,
          voiceId: voice.value.id,
          voiceName: voice.value.name,
          speed: speed.value,
          stability: stability.value,
        },
        parseVoiceOver,
      ),
    )
    pool.addMedia(media)
    const placed = timeline.insertAudioAt(media.id, at)
    notice.value = t(placed ? 'timeline.voiceOver.added' : 'timeline.voiceOver.addedPoolOnly', {
      name: media.name,
      duration: formatClockDuration(media.duration),
      at: formatTimeMs(timeToSeconds(at)),
    })
  } catch (e) {
    fail(e)
  }
}

function onCancel(): void {
  run?.cancel()
}

function stopPreview(): void {
  audio?.pause()
  audio = null
  previewing.value = false
}

function onPreview(): void {
  if (previewing.value) {
    stopPreview()
    return
  }
  const url = voice.value?.previewUrl
  if (!url) return
  const a = new Audio(url)
  audio = a
  previewing.value = true
  a.onended = () => {
    if (audio === a) previewing.value = false
  }
  a.onerror = () => {
    if (audio === a) previewing.value = false
  }
  a.play().catch(() => {
    if (audio === a) previewing.value = false
  })
}

watch(voiceId, stopPreview)

onBeforeUnmount(() => {
  stopPreview()
  run?.cancel()
})

const taskLabel = computed(() => (task.value ? t(`timeline.voiceOver.running.${task.value}`) : ''))
</script>

<template>
  <div class="voice-over" data-testid="voice-over">
    <h4>{{ t('timeline.voiceOver.title') }}</h4>
    <p v-if="!statusChecked" class="note">…</p>
    <p v-else-if="outdated" class="note error" data-testid="voice-over-outdated">
      {{ t('timeline.voiceOver.outdated') }}
    </p>
    <template v-else>
      <p v-if="!canVoice" class="note warn" data-testid="voice-over-no-key">
        {{ t('timeline.voiceOver.noKey') }}
      </p>

      <label class="field">
        <span>{{ t('timeline.voiceOver.language') }}</span>
        <select v-model="language" :disabled="running" data-testid="voice-over-language">
          <option v-for="code in SCRIPT_LANGUAGES" :key="code" :value="code">
            {{ t(`ai.lang.${code}`) }}
          </option>
        </select>
      </label>

      <details class="write" data-testid="voice-over-write">
        <summary>{{ t('timeline.voiceOver.writeOpen') }}</summary>
        <label class="field">
          <span>{{ t('timeline.voiceOver.idea') }}</span>
          <textarea
            v-model="idea"
            rows="3"
            :maxlength="MAX_SCRIPT_IDEA"
            :placeholder="t('timeline.voiceOver.ideaPlaceholder')"
            :disabled="running"
            data-testid="voice-over-idea"
          />
        </label>
        <label class="field">
          <span>{{ t('timeline.voiceOver.seconds') }}</span>
          <RangeSpinner
            :min="MIN_SCRIPT_SECONDS"
            :max="MAX_SCRIPT_SECONDS"
            step="5"
            :value="seconds"
            :disabled="running"
            :reset="DEFAULT_SECONDS"
            data-testid="voice-over-seconds"
            @input="seconds = Number(($event.target as HTMLInputElement).value)"
          />
        </label>
        <button
          type="button"
          class="btn"
          :disabled="running || !canClaude || !idea.trim()"
          data-testid="voice-over-write-run"
          @click="onWrite"
        >
          {{ t('timeline.voiceOver.write') }}
        </button>
        <p v-if="!canClaude" class="note">{{ t('ai.noClaude') }}</p>
      </details>

      <label class="field">
        <span class="row-label">
          {{ t('timeline.voiceOver.text') }}
          <small :class="{ over: tooLong }" data-testid="voice-over-count">
            {{ text.length }} / {{ MAX_SCRIPT_LENGTH }}
          </small>
        </span>
        <textarea
          v-model="text"
          rows="6"
          :placeholder="t('timeline.voiceOver.textPlaceholder')"
          :disabled="running"
          data-testid="voice-over-text"
        />
      </label>
      <div class="row">
        <button
          type="button"
          class="btn"
          :disabled="running || !canClaude || !text.trim() || tooLong"
          data-testid="voice-over-translate"
          @click="onTranslate"
        >
          {{ t('timeline.voiceOver.translate', { lang: t(`ai.lang.${language}`) }) }}
        </button>
        <button
          v-if="previous !== null"
          type="button"
          class="plain"
          :disabled="running"
          data-testid="voice-over-restore"
          @click="onRestore"
        >
          {{ t('timeline.voiceOver.restore') }}
        </button>
      </div>

      <template v-if="canVoice">
        <div class="field">
          <span id="voice-over-voice-label">{{ t('timeline.voiceOver.voice') }}</span>
          <div class="row">
            <select
              v-model="voiceId"
              aria-labelledby="voice-over-voice-label"
              class="grow"
              :disabled="running || voicesState !== 'ready' || voices.length === 0"
              data-testid="voice-over-voice"
            >
              <option v-if="voicesState === 'loading'" value="">
                {{ t('timeline.voiceOver.loadingVoices') }}
              </option>
              <option v-for="v in voices" :key="v.id" :value="v.id">
                {{ v.description ? `${v.name} – ${v.description}` : v.name }}
              </option>
            </select>
            <button
              type="button"
              class="btn icon"
              :disabled="!voice?.previewUrl"
              :title="t('timeline.voiceOver.preview')"
              :aria-label="t('timeline.voiceOver.preview')"
              data-testid="voice-over-preview"
              @click="onPreview"
            >
              {{ previewing ? '■' : '▶' }}
            </button>
            <button
              type="button"
              class="btn icon"
              :disabled="running || voicesState === 'loading'"
              :title="t('timeline.voiceOver.reloadVoices')"
              :aria-label="t('timeline.voiceOver.reloadVoices')"
              data-testid="voice-over-reload"
              @click="loadVoices"
            >
              ⟳
            </button>
          </div>
        </div>
        <p v-if="voicesState === 'ready' && voices.length === 0" class="note warn">
          {{ t('timeline.voiceOver.noVoices') }}
        </p>
        <label class="field">
          <span>{{ t('timeline.voiceOver.speed') }}</span>
          <RangeSpinner
            :min="MIN_VOICE_SPEED"
            :max="MAX_VOICE_SPEED"
            step="0.05"
            :value="speed"
            :disabled="running"
            :reset="DEFAULT_SPEED"
            data-testid="voice-over-speed"
            @input="speed = Number(($event.target as HTMLInputElement).value)"
          />
        </label>
        <label class="field">
          <span>{{ t('timeline.voiceOver.stability') }}</span>
          <RangeSpinner
            min="0"
            max="1"
            step="0.05"
            :scale="100"
            :value="stability"
            :disabled="running"
            :reset="DEFAULT_STABILITY"
            data-testid="voice-over-stability"
            @input="stability = Number(($event.target as HTMLInputElement).value)"
          />
        </label>
        <p class="note">{{ t('timeline.voiceOver.stabilityHint') }}</p>
        <button
          type="button"
          class="btn primary"
          :disabled="running || !voice || !text.trim() || tooLong"
          data-testid="voice-over-speak"
          @click="onSpeak"
        >
          {{ t('timeline.voiceOver.speak') }}
        </button>
        <p class="note">{{ t('timeline.voiceOver.speakHint', { at: insertAt }) }}</p>
      </template>

      <div v-if="running" class="running" role="status" data-testid="voice-over-running">
        <span class="spinner" aria-hidden="true"></span>
        <span class="grow">{{ taskLabel }}</span>
        <button type="button" class="plain" data-testid="voice-over-cancel" @click="onCancel">
          {{ t('ai.cancel') }}
        </button>
      </div>
      <p v-if="notice" class="note ok" role="status" data-testid="voice-over-notice">
        {{ notice }}
      </p>
      <p v-if="error" class="note error" role="alert" data-testid="voice-over-error">
        {{ error }}
      </p>
    </template>
  </div>
</template>

<style scoped>
.voice-over {
  display: flex;
  flex-direction: column;
  gap: var(--ds-space-2);
  padding: var(--ds-space-3);
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  background: var(--ds-surface-1);
  font-size: var(--ds-text-sm);
}
h4 {
  margin: 0;
  font-weight: var(--ds-weight-semibold);
}
.field {
  display: flex;
  flex-direction: column;
  gap: var(--ds-space-1);
  color: var(--ds-text-2);
}
.row-label {
  display: flex;
  justify-content: space-between;
  gap: var(--ds-space-2);
}
.row-label .over {
  color: var(--ds-danger);
}
select,
textarea {
  width: 100%;
  box-sizing: border-box;
  padding: var(--ds-space-2);
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  background: var(--ds-surface-2);
  color: var(--ds-text);
  font: inherit;
}
textarea {
  resize: vertical;
  line-height: 1.5;
}
.write[open] {
  padding-bottom: var(--ds-space-2);
}
.write > * + * {
  margin-top: var(--ds-space-2);
}
.write summary {
  cursor: pointer;
  color: var(--ds-link);
}
.row {
  display: flex;
  align-items: center;
  gap: var(--ds-space-2);
  flex-wrap: wrap;
}
.grow {
  flex: 1;
  min-width: 0;
}
.btn {
  min-height: var(--ds-control-sm);
  padding: 0 var(--ds-space-3);
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  background: var(--ds-surface-2);
  color: var(--ds-text);
  font: inherit;
  cursor: pointer;
}
.btn.icon {
  width: var(--ds-control-sm);
  padding: 0;
}
.btn.primary {
  min-height: var(--ds-control-md);
  border-color: var(--ds-accent);
  font-weight: var(--ds-weight-semibold);
}
.btn:hover:not(:disabled) {
  background: var(--ds-accent-soft);
}
.btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.btn:focus-visible,
.plain:focus-visible {
  outline: none;
  box-shadow: var(--ds-focus-ring);
}
.plain {
  padding: 0;
  border: 0;
  background: none;
  color: var(--ds-link);
  font: inherit;
  text-decoration: underline;
  cursor: pointer;
}
.note {
  margin: 0;
  color: var(--ds-text-2);
  line-height: 1.5;
}
.note.warn,
.note.error {
  color: var(--ds-danger, #b3261e);
}
.note.ok {
  color: var(--ds-success, #2e7d32);
}
.running {
  display: flex;
  align-items: center;
  gap: var(--ds-space-2);
}
.spinner {
  width: 1em;
  height: 1em;
  border: 2px solid var(--ds-border);
  border-top-color: currentColor;
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
</style>
