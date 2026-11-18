<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { storeToRefs } from 'pinia'
import {
  AI_CANCELLED,
  AI_UNSUPPORTED,
  TRANSCRIBE_LANGUAGES,
  type SubtitleTarget,
  type TranscribeLanguage,
  type TranslateTarget,
} from '@/lib/aiApi'
import { formatTimeMs } from '@/lib/timeFormat'
import { useMediaPoolStore } from '@/stores/mediaPool'
import { useTimelineStore } from '@/stores/timeline'
import { useTimelineAiStore } from '@/stores/timelineAi'
import { timeToSeconds, type AudioClip, type VideoClip } from '@/timeline/model'
import { SILENCE_LEVELS, type SilenceLevel } from '@/timeline/silence'
import HighlightsPanel from './HighlightsPanel.vue'
import PublishPanel from './PublishPanel.vue'
import BrollPanel from './BrollPanel.vue'

/**
 * KI-Assistent des Timeline-Editors: Untertitel für den markierten Clip
 * (Sprache erkennen + Claude) als Text-Clips auf einer Ebenen-Spur, alle
 * Texte übersetzen, Schnittvorschläge und Highlights (kurzer Clip) für den
 * markierten Clip sowie Titel, Beschreibung, Hashtags und Kapitel für die
 * ganze Timeline. Die Aufträge laufen auf dem Server wie im bisherigen Editor.
 */
const { t } = useI18n()
const store = useTimelineStore()
const pool = useMediaPoolStore()
const ai = useTimelineAiStore()
const {
  status,
  statusChecked,
  task,
  progress,
  running,
  textClips,
  suggestions,
  skipChecked,
  audition,
} = storeToRefs(ai)

onMounted(() => void ai.loadStatus())

const language = ref<TranscribeLanguage>('auto')
const target = ref<SubtitleTarget>('original')
const translateTarget = ref<TranslateTarget>('en')
const error = ref('')
const notice = ref('')

/** Markierter Clip mit Ton: der Ton-Clip eines Paars, sonst ein Video mit Tonspur. */
const clip = computed<VideoClip | AudioClip | null>(() => {
  const media = store.selectedClips.filter(
    (c): c is VideoClip | AudioClip => c.kind === 'video' || c.kind === 'audio',
  )
  if (media.length === 0 || media.length !== store.selectedClips.length) return null
  const assets = new Set(media.map((c) => c.asset))
  if (assets.size !== 1) return null
  const pick = media.find((c) => c.kind === 'audio') ?? media[0]
  return store.doc.assets[pick.asset]?.hasAudio ? pick : null
})
const clipName = computed(() =>
  clip.value ? (store.doc.assets[clip.value.asset]?.name ?? '') : '',
)
const hasMedia = computed(() =>
  store.doc.tracks.some((tr) => tr.kind !== 'overlay' && tr.clips.length > 0),
)

// Nur ein anderer Clip räumt die Meldungen ab, nicht eine Änderung am selben
// (nach dem Herausschneiden bleibt der vordere Teil markiert).
watch(
  () => clip.value?.id,
  () => {
    if (running.value) return
    error.value = ''
    notice.value = ''
  },
)

const outdated = computed(() => statusChecked.value && status.value === null)
const canTranscribe = computed(() => status.value?.transcribe === true)
const canClaude = computed(() => status.value?.claude === true)

const taskLabel = computed(() => {
  if (!task.value) return ''
  const percent = task.value === 'transcribe' ? ` ${progress.value}%` : ''
  return `${t(`ai.running.${task.value}`)}${percent}`
})

function fail(e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e)
  if (msg === AI_CANCELLED) return
  error.value = msg === AI_UNSUPPORTED ? t('ai.outdated') : msg
}

async function onSubtitles(): Promise<void> {
  const c = clip.value
  if (!c || running.value) return
  error.value = ''
  notice.value = ''
  try {
    const r = await ai.makeSubtitles(c.id, language.value, target.value)
    if (r.added === 0) notice.value = t('ai.noSpeech')
    else if (r.truncated) notice.value = t('ai.subtitlesLimited', { n: r.added })
    else if (r.dropped > 0) {
      notice.value = t('timeline.ai.subtitlesPartly', { n: r.added, m: r.dropped })
    } else notice.value = t('ai.subtitlesAdded', { n: r.added })
  } catch (e) {
    fail(e)
  }
}

// --- Schnittvorschläge -------------------------------------------------------

const minPause = ref(1.2)
/** Vorschläge des markierten Clips mit ihrer Lage auf der Timeline. */
const cutList = computed(() => {
  const current = suggestions.value
  if (!current || current.clipId !== clip.value?.id) return []
  return current.items.flatMap((s) => {
    const range = ai.suggestionRange(s)
    return range ? [{ ...s, range }] : []
  })
})
const cutChecked = computed(() => cutList.value.filter((s) => s.checked))
const cutSeconds = computed(() =>
  cutChecked.value.reduce((sum, s) => sum + timeToSeconds(s.range.end - s.range.start), 0),
)

/** Arten in der Liste mit Anzahl; Häkchen = alle dieser Art angehakt. */
const cutKinds = computed(() => {
  const order = ['filler', 'slip', 'repeat', 'pause'] as const
  return order.flatMap((kind) => {
    const all = cutList.value.filter((s) => s.kind === kind)
    if (all.length === 0) return []
    const on = all.filter((s) => s.checked).length
    return [
      { kind, count: all.length, checked: on === all.length, mixed: on > 0 && on < all.length },
    ]
  })
})

function onAudition(id: number): void {
  if (running.value) return
  if (audition.value?.id === id && store.playing) {
    store.playing = false
    return
  }
  ai.auditionSuggestion(id)
}

async function onSuggest(): Promise<void> {
  const c = clip.value
  if (!c || running.value) return
  error.value = ''
  notice.value = ''
  try {
    const n = await ai.suggestCuts(c.id, language.value, minPause.value)
    if (n === 0) notice.value = t('ai.noSuggestions')
  } catch (e) {
    fail(e)
  }
}

// --- Stille finden (ohne KI, aus der Wellenform) ------------------------------

const silenceLevel = ref<SilenceLevel>('normal')
/** Wellenform des Mediums; fehlt sie noch, lässt sich keine Stille finden. */
const wave = computed(() => {
  const item = clip.value ? pool.byAsset(clip.value.asset) : undefined
  const rate = item?.derived?.peaks.rate ?? 0
  return item?.peaks && rate > 0 ? { peaks: item.peaks, rate } : null
})

function onSilence(): void {
  const c = clip.value
  if (!c || !wave.value || running.value) return
  error.value = ''
  const n = ai.suggestSilence(c.id, wave.value.peaks, wave.value.rate, {
    minLength: minPause.value,
    level: silenceLevel.value,
  })
  notice.value = n === 0 ? t('timeline.ai.noSilence') : ''
}

function onApplyCuts(): void {
  if (running.value || cutChecked.value.length === 0) return
  error.value = ''
  try {
    const r = ai.applyCuts()
    notice.value = r.dropped
      ? t('timeline.ai.cutsAppliedPartly', { n: r.cut, m: r.dropped })
      : t('timeline.ai.cutsApplied', { n: r.cut })
  } catch (e) {
    fail(e)
  }
}

async function onTranslate(): Promise<void> {
  if (running.value || textClips.value.length === 0) return
  error.value = ''
  notice.value = ''
  try {
    const r = await ai.translateTexts(translateTarget.value)
    notice.value = r.missing
      ? t('ai.translatedPartly', { n: r.translated, m: r.missing })
      : t('ai.translated', { n: r.translated })
  } catch (e) {
    fail(e)
  }
}
</script>

<template>
  <section v-if="hasMedia || textClips.length" class="inspector" data-testid="timeline-ai">
    <h3>{{ t('ai.title') }}</h3>
    <p v-if="!statusChecked" class="hint">…</p>
    <p v-else-if="outdated" class="hint warn" data-testid="timeline-ai-outdated">
      {{ t('ai.outdated') }}
    </p>
    <template v-else>
      <p v-if="!canTranscribe" class="hint warn">{{ t('ai.noWhisper') }}</p>
      <p v-else-if="!canClaude" class="hint warn">{{ t('ai.noClaude') }}</p>

      <label v-if="hasMedia" class="field">
        <span>{{ t('ai.language') }}</span>
        <select v-model="language" :disabled="running" data-testid="timeline-ai-language">
          <option v-for="code in TRANSCRIBE_LANGUAGES" :key="code" :value="code">
            {{ t(`ai.lang.${code}`) }}
          </option>
        </select>
      </label>

      <div class="block">
        <span class="label">{{ t('ai.subtitles') }}</span>
        <p v-if="!clip" class="hint" data-testid="timeline-ai-pick">
          {{ t('timeline.ai.pickClip') }}
        </p>
        <template v-else>
          <p class="hint name" :title="clipName">
            {{ t('timeline.ai.forClip', { name: clipName }) }}
          </p>
          <label class="field">
            <span>{{ t('timeline.ai.subtitleLanguage') }}</span>
            <select v-model="target" :disabled="running" data-testid="timeline-ai-target">
              <option value="original">{{ t('ai.target.original') }}</option>
              <option value="de">{{ t('ai.target.de') }}</option>
              <option value="en">{{ t('ai.target.en') }}</option>
            </select>
          </label>
          <button
            type="button"
            class="action"
            :disabled="running || !canTranscribe || !canClaude"
            data-testid="timeline-ai-subtitles"
            @click="onSubtitles"
          >
            {{ t('ai.makeSubtitles') }}
          </button>
          <p class="hint">{{ t('timeline.ai.subtitlesHint') }}</p>
        </template>
      </div>

      <div v-if="clip" class="block" data-testid="timeline-ai-cuts">
        <span class="label">{{ t('ai.cuts') }}</span>
        <label class="pause">
          <span>{{ t('ai.minPause') }}</span>
          <input
            v-model.number="minPause"
            type="number"
            min="0.5"
            max="10"
            step="0.1"
            :disabled="running"
            data-testid="timeline-ai-min-pause"
          />
          <span>s</span>
        </label>
        <button
          type="button"
          class="action"
          :disabled="running || !canTranscribe || !canClaude"
          data-testid="timeline-ai-suggest"
          @click="onSuggest"
        >
          {{ cutList.length ? t('ai.resuggest') : t('ai.suggest') }}
        </button>
        <div class="silence">
          <button
            type="button"
            class="action"
            :disabled="running || !wave"
            data-testid="timeline-ai-silence"
            @click="onSilence"
          >
            {{ t('timeline.ai.findSilence') }}
          </button>
          <select
            v-model="silenceLevel"
            :disabled="running"
            :aria-label="t('timeline.ai.silenceLevel')"
            :title="t('timeline.ai.silenceLevel')"
            data-testid="timeline-ai-silence-level"
          >
            <option v-for="(_, level) in SILENCE_LEVELS" :key="level" :value="level">
              {{ t(`timeline.ai.silenceLevels.${level}`) }}
            </option>
          </select>
        </div>
        <p class="hint">
          {{ wave ? t('timeline.ai.silenceHint') : t('timeline.ai.silenceWait') }}
        </p>
        <template v-if="cutList.length">
          <div class="list-head">
            <button
              type="button"
              class="plain"
              :disabled="running"
              @click="ai.setAllSuggestionsChecked(cutChecked.length !== cutList.length)"
            >
              {{ cutChecked.length === cutList.length ? t('ai.none') : t('ai.all') }}
            </button>
            <small>{{
              t('ai.selected', { n: cutChecked.length, s: cutSeconds.toFixed(1) })
            }}</small>
          </div>
          <div v-if="cutKinds.length > 1" class="kinds" data-testid="timeline-ai-kinds">
            <label v-for="k in cutKinds" :key="k.kind" class="kind-filter">
              <input
                type="checkbox"
                :checked="k.checked"
                :indeterminate.prop="k.mixed"
                :disabled="running"
                :data-kind="k.kind"
                @change="ai.setKindChecked(k.kind, ($event.target as HTMLInputElement).checked)"
              />
              <span>{{ t(`timeline.ai.kinds.${k.kind}`, { n: k.count }) }}</span>
            </label>
          </div>
          <ul class="cuts" data-testid="timeline-ai-cut-list">
            <li v-for="s in cutList" :key="s.id" :class="{ off: !s.checked }">
              <input
                type="checkbox"
                :checked="s.checked"
                :disabled="running"
                :aria-label="t('ai.toggle')"
                @change="ai.setSuggestionChecked(s.id, ($event.target as HTMLInputElement).checked)"
              />
              <button type="button" class="cut" @click="store.seek(s.range.start)">
                <span class="top">
                  <span class="kind">{{ t(`ai.kind.${s.kind}`) }}</span>
                  <small>
                    {{ formatTimeMs(timeToSeconds(s.range.start)) }} –
                    {{ formatTimeMs(timeToSeconds(s.range.end)) }}
                  </small>
                </span>
                <span v-if="s.text">„{{ s.text }}“</span>
                <small v-if="s.reason">{{ s.reason }}</small>
              </button>
              <button
                type="button"
                class="listen"
                :class="{ active: audition?.id === s.id && store.playing }"
                :disabled="running"
                :title="t('timeline.ai.audition')"
                :aria-label="t('timeline.ai.audition')"
                data-testid="timeline-ai-audition"
                @click="onAudition(s.id)"
              >
                {{ audition?.id === s.id && store.playing ? '■' : '▶' }}
              </button>
            </li>
          </ul>
          <label class="skip">
            <input v-model="skipChecked" type="checkbox" data-testid="timeline-ai-skip" />
            <span>{{ t('timeline.ai.skipChecked') }}</span>
          </label>
          <p class="hint">{{ t('timeline.ai.reviewHint') }}</p>
          <button
            type="button"
            class="action"
            :disabled="running || !cutChecked.length"
            data-testid="timeline-ai-apply-cuts"
            @click="onApplyCuts"
          >
            {{ t('timeline.ai.applyCuts', { n: cutChecked.length }) }}
          </button>
          <p class="hint">{{ t('timeline.ai.applyCutsHint') }}</p>
        </template>
        <p v-else class="hint">{{ t('timeline.ai.cutsHint') }}</p>
      </div>

      <HighlightsPanel
        v-if="clip"
        :clip="clip"
        :language="language"
        :ready="canTranscribe && canClaude"
      />

      <PublishPanel v-if="hasMedia" :language="language" :ready="canTranscribe && canClaude" />

      <BrollPanel
        v-if="hasMedia"
        :language="language"
        :ready="canTranscribe && canClaude"
        :gemini="status?.image === true"
      />

      <div v-if="textClips.length" class="block">
        <span class="label">{{ t('ai.translate') }}</span>
        <select
          v-model="translateTarget"
          :disabled="running"
          :aria-label="t('ai.translate')"
          data-testid="timeline-ai-translate-target"
        >
          <option value="en">{{ t('ai.target.en') }}</option>
          <option value="de">{{ t('ai.target.de') }}</option>
        </select>
        <button
          type="button"
          class="action"
          :disabled="running || !canClaude"
          data-testid="timeline-ai-translate"
          @click="onTranslate"
        >
          {{ t('ai.translateCount', { n: textClips.length }) }}
        </button>
        <p class="hint">{{ t('timeline.ai.translateHint') }}</p>
      </div>

      <div v-if="running" class="running" role="status" data-testid="timeline-ai-running">
        <span class="spinner" aria-hidden="true"></span>
        <span class="grow">{{ taskLabel }}</span>
        <button type="button" class="plain" data-testid="timeline-ai-cancel" @click="ai.cancel()">
          {{ t('ai.cancel') }}
        </button>
      </div>
      <p v-if="notice" class="hint ok" role="status" data-testid="timeline-ai-notice">
        {{ notice }}
      </p>
      <p v-if="error" class="hint warn" role="alert" data-testid="timeline-ai-error">
        {{ error }}
      </p>
    </template>
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
.block {
  display: flex;
  flex-direction: column;
  gap: var(--ds-space-2);
}
.label {
  font-weight: var(--ds-weight-semibold);
}
.field {
  display: flex;
  flex-direction: column;
  gap: var(--ds-space-1);
  color: var(--ds-text-2);
}
select {
  width: 100%;
  padding: var(--ds-space-2);
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  background: var(--ds-surface-2);
  color: inherit;
  font: inherit;
}
.action {
  padding: var(--ds-space-2) var(--ds-space-3);
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  background: var(--ds-surface-2);
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.action:disabled {
  opacity: 0.5;
  cursor: default;
}
.hint {
  margin: 0;
  color: var(--ds-text-2);
  line-height: 1.5;
}
.hint.name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hint.warn {
  color: var(--ds-danger, #b3261e);
}
.hint.ok {
  color: var(--ds-success, #2e7d32);
}
.running {
  display: flex;
  align-items: center;
  gap: var(--ds-space-2);
}
.grow {
  flex: 1;
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
.pause {
  display: flex;
  align-items: center;
  gap: var(--ds-space-2);
  color: var(--ds-text-2);
}
.pause input {
  width: 5em;
  padding: var(--ds-space-1) var(--ds-space-2);
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  background: var(--ds-surface-2);
  color: inherit;
  font: inherit;
}
.silence {
  display: flex;
  gap: var(--ds-space-2);
}
.silence .action {
  flex: 1;
}
.silence select {
  padding: var(--ds-space-1) var(--ds-space-2);
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  background: var(--ds-surface-2);
  color: inherit;
  font: inherit;
}
.list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--ds-space-2);
  color: var(--ds-text-2);
}
.cuts {
  display: flex;
  flex-direction: column;
  gap: var(--ds-space-1);
  max-height: 260px;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}
.cuts li {
  display: flex;
  align-items: flex-start;
  gap: var(--ds-space-2);
}
.cuts li.off {
  opacity: 0.55;
}
.cut {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  padding: var(--ds-space-1) var(--ds-space-2);
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  background: var(--ds-surface-2);
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.cut .top {
  display: flex;
  justify-content: space-between;
  gap: var(--ds-space-2);
}
.cut .kind {
  font-weight: var(--ds-weight-semibold);
}
.cut small {
  color: var(--ds-text-2);
}
.kinds {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ds-space-1) var(--ds-space-3);
}
.kind-filter,
.skip {
  display: flex;
  align-items: center;
  gap: var(--ds-space-1);
  color: var(--ds-text-2);
}
.listen {
  flex: none;
  width: 2em;
  align-self: stretch;
  padding: 0;
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  background: var(--ds-surface-2);
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.listen.active {
  border-color: var(--ds-accent);
  color: var(--ds-accent);
}
.listen:disabled {
  opacity: 0.5;
  cursor: default;
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
</style>
