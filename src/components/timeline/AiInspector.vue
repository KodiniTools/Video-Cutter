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
import { useTimelineStore } from '@/stores/timeline'
import { useTimelineAiStore } from '@/stores/timelineAi'
import type { AudioClip, VideoClip } from '@/timeline/model'

/**
 * KI-Assistent des Timeline-Editors: Untertitel für den markierten Clip
 * (Sprache erkennen + Claude) als Text-Clips auf einer Ebenen-Spur, und alle
 * Texte übersetzen. Die Aufträge laufen auf dem Server wie im bisherigen Editor.
 */
const { t } = useI18n()
const store = useTimelineStore()
const ai = useTimelineAiStore()
const { status, statusChecked, task, progress, running, textClips } = storeToRefs(ai)

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

watch(clip, () => {
  if (running.value) return
  error.value = ''
  notice.value = ''
})

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
            <span>{{ t('ai.language') }}</span>
            <select v-model="language" :disabled="running" data-testid="timeline-ai-language">
              <option v-for="code in TRANSCRIBE_LANGUAGES" :key="code" :value="code">
                {{ t(`ai.lang.${code}`) }}
              </option>
            </select>
          </label>
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
