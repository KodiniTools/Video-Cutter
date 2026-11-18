<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { storeToRefs } from 'pinia'
import {
  AI_CANCELLED,
  AI_UNSUPPORTED,
  type PublishTexts,
  type SubtitleTarget,
  type TranscribeLanguage,
} from '@/lib/aiApi'
import { useTimelineStore } from '@/stores/timeline'
import { NO_SPEECH, TOO_MANY_MEDIA, useTimelineAiStore } from '@/stores/timelineAi'
import { chapterTime } from '@/timeline/markers'
import { secondsToTime } from '@/timeline/model'
import {
  descriptionText,
  MAX_PUBLISH_MEDIA,
  replaceableChapterMarkers,
  speechSegments,
} from '@/timeline/publish'

/**
 * Titel, Beschreibung, Hashtags und Kapitel: Claude liest das Gesprochene der
 * ganzen Timeline. Alles lässt sich vor dem Kopieren bearbeiten; die Kapitel
 * werden auf Wunsch zu Markern (und damit zu Kapiteln in der Exportdatei).
 */
const props = defineProps<{
  language: TranscribeLanguage
  /** Transkription und Claude sind eingerichtet. */
  ready: boolean
}>()

const { t } = useI18n()
const store = useTimelineStore()
const ai = useTimelineAiStore()
const { running, publish } = storeToRefs(ai)

const target = ref<SubtitleTarget>('original')
const error = ref('')
const notice = ref('')
const copied = ref('')

/** Bearbeitbare Kopie der Ergebnisse. */
const titles = ref<string[]>([])
const description = ref('')
const hashtagText = ref('')
const chapters = ref<{ id: number; at: number; title: string; checked: boolean }[]>([])
const replace = ref(true)

function load(r: PublishTexts | null): void {
  titles.value = r ? [...r.titles] : []
  description.value = r?.description ?? ''
  hashtagText.value = r ? r.hashtags.join(' ') : ''
  chapters.value = (r?.chapters ?? []).map((c, i) => ({ ...c, id: i, checked: true }))
  copied.value = ''
}
load(publish.value)
watch(publish, load)

const hasSpeech = computed(() => speechSegments(store.doc).length > 0)
const hasResult = computed(() => publish.value !== null)
const empty = computed(
  () =>
    hasResult.value &&
    titles.value.length === 0 &&
    description.value.trim() === '' &&
    hashtagText.value.trim() === '' &&
    chapters.value.length === 0,
)

const hashtags = computed(() =>
  hashtagText.value
    .split(/[\s,]+/)
    .map((h) => h.trim())
    .filter((h) => h !== '' && h !== '#')
    .map((h) => (h.startsWith('#') ? h : `#${h}`)),
)
const checkedChapters = computed(() =>
  chapters.value
    .filter((c) => c.checked)
    .map((c) => ({ at: c.at, title: c.title.trim() || t('timeline.marker.chapter') })),
)
/** YouTube zeigt Kapitel nur ab 3 Stück, das erste bei 0:00. */
const chapterWarning = computed(() => {
  const list = checkedChapters.value
  if (list.length === 0) return ''
  if (list.length < 3) return t('timeline.ai.publish.fewChapters')
  if (list[0].at !== 0) return t('timeline.ai.publish.firstChapter')
  return ''
})
const replaceable = computed(() => replaceableChapterMarkers(store.doc).length)

function fail(e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e)
  if (msg === AI_CANCELLED) return
  if (msg === AI_UNSUPPORTED) error.value = t('ai.outdated')
  else if (msg === NO_SPEECH) error.value = t('timeline.ai.publish.noSpeech')
  else if (msg === TOO_MANY_MEDIA) {
    error.value = t('timeline.ai.publish.tooMany', { n: MAX_PUBLISH_MEDIA })
  } else error.value = msg
}

async function onCreate(): Promise<void> {
  if (running.value) return
  error.value = ''
  notice.value = ''
  try {
    const r = await ai.suggestPublish(props.language, target.value)
    const nothing = r.titles.length === 0 && r.description === '' && r.chapters.length === 0
    notice.value = nothing ? t('ai.noSpeech') : t('timeline.ai.publish.created')
  } catch (e) {
    fail(e)
  }
}

async function copy(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    copied.value = t('timeline.ai.publish.copied', { what })
  } catch {
    copied.value = t('timeline.marker.copyFailed')
  }
}

function setTitle(i: number, value: string): void {
  titles.value = titles.value.map((v, j) => (j === i ? value : v))
}

function onApplyChapters(): void {
  if (running.value || checkedChapters.value.length === 0) return
  error.value = ''
  try {
    const r = ai.applyChapters(checkedChapters.value, replace.value)
    notice.value = t('timeline.ai.publish.applied', {
      n: r.added + r.renamed,
      m: r.removed,
    })
  } catch (e) {
    fail(e)
  }
}

const timeOf = (at: number) => chapterTime(secondsToTime(at))
</script>

<template>
  <div class="block" data-testid="timeline-ai-publish">
    <span class="label">{{ t('timeline.ai.publish.title') }}</span>
    <p class="hint">{{ t('timeline.ai.publish.hint') }}</p>
    <p v-if="!hasSpeech" class="hint warn" data-testid="timeline-ai-publish-no-speech">
      {{ t('timeline.ai.publish.noSpeech') }}
    </p>
    <template v-else>
      <label class="field">
        <span>{{ t('timeline.ai.publish.language') }}</span>
        <select v-model="target" :disabled="running" data-testid="timeline-ai-publish-target">
          <option value="original">{{ t('ai.target.original') }}</option>
          <option value="de">{{ t('ai.target.de') }}</option>
          <option value="en">{{ t('ai.target.en') }}</option>
        </select>
      </label>
      <button
        type="button"
        class="action"
        :disabled="running || !ready"
        data-testid="timeline-ai-publish-create"
        @click="onCreate"
      >
        {{ hasResult ? t('timeline.ai.publish.recreate') : t('timeline.ai.publish.create') }}
      </button>
    </template>

    <template v-if="hasResult && !empty">
      <div v-if="titles.length" class="part" data-testid="timeline-ai-publish-titles">
        <span class="sub">{{ t('timeline.ai.publish.titles') }}</span>
        <div v-for="(title, i) in titles" :key="i" class="row">
          <input
            type="text"
            :value="title"
            maxlength="100"
            :aria-label="t('timeline.ai.publish.titleN', { n: i + 1 })"
            @input="setTitle(i, ($event.target as HTMLInputElement).value)"
          />
          <button
            type="button"
            class="copy"
            :title="t('timeline.ai.publish.copy')"
            :aria-label="t('timeline.ai.publish.copy')"
            data-testid="timeline-ai-publish-copy-title"
            @click="copy(title, t('timeline.ai.publish.what.title'))"
          >
            ⧉
          </button>
        </div>
        <small class="count">{{ t('timeline.ai.publish.titleHint') }}</small>
      </div>

      <div class="part">
        <span class="sub">{{ t('timeline.ai.publish.description') }}</span>
        <textarea
          v-model="description"
          rows="6"
          maxlength="5000"
          data-testid="timeline-ai-publish-description"
        ></textarea>
        <button
          type="button"
          class="plain"
          @click="copy(description, t('timeline.ai.publish.what.description'))"
        >
          {{ t('timeline.ai.publish.copyDescription') }}
        </button>
      </div>

      <div class="part">
        <span class="sub">{{ t('timeline.ai.publish.hashtags') }}</span>
        <input
          v-model="hashtagText"
          type="text"
          :aria-label="t('timeline.ai.publish.hashtags')"
          data-testid="timeline-ai-publish-hashtags"
        />
        <button
          type="button"
          class="plain"
          :disabled="!hashtags.length"
          @click="copy(hashtags.join(' '), t('timeline.ai.publish.what.hashtags'))"
        >
          {{ t('timeline.ai.publish.copyHashtags') }}
        </button>
      </div>

      <div class="part" data-testid="timeline-ai-publish-chapters">
        <span class="sub">{{ t('timeline.ai.publish.chapters') }}</span>
        <p v-if="!chapters.length" class="hint">{{ t('timeline.ai.publish.noChapters') }}</p>
        <ul v-else class="items">
          <li v-for="c in chapters" :key="c.id" :class="{ off: !c.checked }">
            <input
              v-model="c.checked"
              type="checkbox"
              :disabled="running"
              :aria-label="t('ai.toggle')"
            />
            <button
              type="button"
              class="time"
              :title="t('timeline.ai.publish.seek')"
              @click="store.seek(secondsToTime(c.at))"
            >
              {{ timeOf(c.at) }}
            </button>
            <input
              v-model="c.title"
              type="text"
              maxlength="80"
              :aria-label="t('timeline.ai.publish.chapterTitle')"
            />
          </li>
        </ul>
        <p v-if="chapterWarning" class="hint warn" data-testid="timeline-ai-publish-chapter-warn">
          {{ chapterWarning }}
        </p>
        <template v-if="checkedChapters.length">
          <label class="check">
            <input
              v-model="replace"
              type="checkbox"
              :disabled="running"
              data-testid="timeline-ai-publish-replace"
            />
            <span>{{ t('timeline.ai.publish.replace', { n: replaceable }) }}</span>
          </label>
          <button
            type="button"
            class="action primary"
            :disabled="running"
            data-testid="timeline-ai-publish-apply"
            @click="onApplyChapters"
          >
            {{ t('timeline.ai.publish.apply', { n: checkedChapters.length }) }}
          </button>
          <p class="hint">{{ t('timeline.ai.publish.applyHint') }}</p>
        </template>
      </div>

      <button
        type="button"
        class="action"
        data-testid="timeline-ai-publish-copy-all"
        @click="
          copy(
            descriptionText(description, checkedChapters, hashtags),
            t('timeline.ai.publish.what.all'),
          )
        "
      >
        {{ t('timeline.ai.publish.copyAll') }}
      </button>
      <p class="hint">{{ t('timeline.ai.publish.copyAllHint') }}</p>
    </template>

    <p v-if="copied" class="hint ok" role="status" data-testid="timeline-ai-publish-copied">
      {{ copied }}
    </p>
    <p v-if="notice" class="hint ok" role="status" data-testid="timeline-ai-publish-notice">
      {{ notice }}
    </p>
    <p v-if="error" class="hint warn" role="alert" data-testid="timeline-ai-publish-error">
      {{ error }}
    </p>
  </div>
</template>

<style scoped>
.block,
.part {
  display: flex;
  flex-direction: column;
  gap: var(--ds-space-2);
}
.part {
  gap: var(--ds-space-1);
}
.label {
  font-weight: var(--ds-weight-semibold);
}
.sub {
  color: var(--ds-text-2);
  font-weight: var(--ds-weight-semibold);
}
.field {
  display: flex;
  flex-direction: column;
  gap: var(--ds-space-1);
  color: var(--ds-text-2);
}
select,
textarea,
input[type='text'] {
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  padding: var(--ds-space-1) var(--ds-space-2);
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  background: var(--ds-surface-2);
  color: inherit;
  font: inherit;
}
select {
  padding: var(--ds-space-2);
}
textarea {
  resize: vertical;
  line-height: 1.5;
}
.row {
  display: flex;
  gap: var(--ds-space-1);
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
.action.primary {
  border-color: var(--ds-accent);
}
.action:disabled {
  opacity: 0.5;
  cursor: default;
}
.copy,
.time {
  flex: none;
  padding: 0 var(--ds-space-2);
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  background: var(--ds-surface-2);
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.time {
  min-width: 3.6em;
  font-variant-numeric: tabular-nums;
}
.hint {
  margin: 0;
  color: var(--ds-text-2);
  line-height: 1.5;
}
.count {
  color: var(--ds-text-2);
}
.hint.warn {
  color: var(--ds-danger, #b3261e);
}
.hint.ok {
  color: var(--ds-success, #2e7d32);
}
.items {
  display: flex;
  flex-direction: column;
  gap: var(--ds-space-1);
  max-height: 300px;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}
.items li {
  display: flex;
  align-items: center;
  gap: var(--ds-space-1);
}
.items li.off {
  opacity: 0.55;
}
.check {
  display: flex;
  align-items: center;
  gap: var(--ds-space-1);
  color: var(--ds-text-2);
}
.plain {
  align-self: flex-start;
  padding: 0;
  border: 0;
  background: none;
  color: var(--ds-link);
  font: inherit;
  text-decoration: underline;
  cursor: pointer;
}
.plain:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
