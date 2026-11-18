<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { storeToRefs } from 'pinia'
import RangeSpinner from './RangeSpinner.vue'
import {
  AI_CANCELLED,
  AI_UNSUPPORTED,
  DEFAULT_HIGHLIGHT_TARGET,
  MAX_HIGHLIGHT_TARGET,
  MIN_HIGHLIGHT_TARGET,
  type TranscribeLanguage,
} from '@/lib/aiApi'
import { formatTimeMs } from '@/lib/timeFormat'
import { useTimelineStore } from '@/stores/timeline'
import { ALL_HIGHLIGHTS, useTimelineAiStore } from '@/stores/timelineAi'
import { useTimelineProjectStore } from '@/stores/timelineProjects'
import { SHORT_FORMATS, type ShortFormat } from '@/timeline/highlights'
import {
  findClip,
  linkGroupIds,
  timeToSeconds,
  type AudioClip,
  type VideoClip,
} from '@/timeline/model'

/**
 * Highlights als kurzer Clip: Claude wählt die besten Stellen des markierten
 * Clips, der Nutzer prüft sie (ansehen, an-/abhaken) und übernimmt sie als
 * neue, kurze Timeline im Hochformat.
 */
const props = defineProps<{
  clip: VideoClip | AudioClip
  language: TranscribeLanguage
  /** Transkription und Claude sind eingerichtet. */
  ready: boolean
}>()

const { t } = useI18n()
const store = useTimelineStore()
const ai = useTimelineAiStore()
const projects = useTimelineProjectStore()
const { running, highlights, audition } = storeToRefs(ai)

const target = ref(DEFAULT_HIGHLIGHT_TARGET)
const format = ref<ShortFormat>('9:16')
const error = ref('')
const notice = ref('')

/** Ein Short braucht ein Bild: der Clip selbst oder sein verknüpftes Video. */
const hasVideo = computed(() =>
  linkGroupIds(store.doc, props.clip.id).some(
    (id) => findClip(store.doc, id)?.clip.kind === 'video',
  ),
)

/** Nach dem Übernehmen ist die erste Stelle markiert: Die Meldung soll bleiben. */
let keepMessages = false

watch(
  () => props.clip.id,
  () => {
    if (keepMessages) {
      keepMessages = false
      return
    }
    if (running.value) return
    error.value = ''
    notice.value = ''
  },
)

/** Highlights des markierten Clips (bzw. seines verknüpften Partners). */
const list = computed(() => {
  const current = highlights.value
  if (!current || !linkGroupIds(store.doc, props.clip.id).includes(current.clipId)) return []
  return current.items.flatMap((h) => {
    const range = ai.highlightRange(h)
    return range ? [{ ...h, range }] : []
  })
})
const checked = computed(() => list.value.filter((h) => h.checked))
const totalSeconds = computed(() =>
  checked.value.reduce((sum, h) => sum + timeToSeconds(h.range.end - h.range.start), 0),
)
const outside = computed(
  () => checked.value.length > 0 && (totalSeconds.value < 30 || totalSeconds.value > 60),
)

function fail(e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e)
  if (msg === AI_CANCELLED) return
  error.value = msg === AI_UNSUPPORTED ? t('ai.outdated') : msg
}

async function onFind(): Promise<void> {
  if (running.value || !hasVideo.value) return
  error.value = ''
  notice.value = ''
  try {
    const n = await ai.suggestHighlights(props.clip.id, props.language, target.value)
    notice.value =
      n === 0 ? t('timeline.ai.highlights.none') : t('timeline.ai.highlights.found', { n })
  } catch (e) {
    fail(e)
  }
}

const playing = (id: number) => audition.value?.id === id && store.playing

function onPlay(id: number): void {
  if (running.value) return
  if (playing(id)) {
    store.playing = false
    return
  }
  if (id === ALL_HIGHLIGHTS) ai.playAllHighlights()
  else ai.playHighlight(id)
}

function onApply(): void {
  if (running.value || checked.value.length === 0) return
  error.value = ''
  const name = projects.current?.name ?? projects.suggestedName
  try {
    keepMessages = true
    const n = ai.applyHighlights(format.value)
    // Das geöffnete Projekt bleibt, wie es ist; der Short wird ein neues.
    projects.detach(name ? `${name} – Short` : 'Short')
    notice.value = t('timeline.ai.highlights.applied', {
      n,
      s: formatTimeMs(timeToSeconds(store.duration)),
    })
  } catch (e) {
    keepMessages = false
    fail(e)
  }
}
</script>

<template>
  <div class="block" data-testid="timeline-ai-highlights">
    <span class="label">{{ t('timeline.ai.highlights.title') }}</span>
    <p class="hint">{{ t('timeline.ai.highlights.hint') }}</p>
    <p v-if="!hasVideo" class="hint warn" data-testid="timeline-ai-highlights-need-video">
      {{ t('timeline.ai.highlights.needVideo') }}
    </p>
    <template v-else>
      <label class="field">
        <span>{{ t('timeline.ai.highlights.target') }}</span>
        <RangeSpinner
          :min="MIN_HIGHLIGHT_TARGET"
          :max="MAX_HIGHLIGHT_TARGET"
          step="5"
          :value="target"
          :disabled="running"
          data-testid="timeline-ai-highlights-target"
          @input="target = Number(($event.target as HTMLInputElement).value)"
        />
      </label>
      <button
        type="button"
        class="action"
        :disabled="running || !ready"
        data-testid="timeline-ai-highlights-find"
        @click="onFind"
      >
        {{ list.length ? t('timeline.ai.highlights.refind') : t('timeline.ai.highlights.find') }}
      </button>
    </template>

    <template v-if="list.length">
      <div class="list-head">
        <button
          type="button"
          class="plain"
          :disabled="running"
          @click="ai.setAllHighlightsChecked(checked.length !== list.length)"
        >
          {{ checked.length === list.length ? t('ai.none') : t('ai.all') }}
        </button>
        <small :class="{ warn: outside }" data-testid="timeline-ai-highlights-total">
          {{
            t('timeline.ai.highlights.total', {
              n: checked.length,
              s: formatTimeMs(totalSeconds),
            })
          }}
          <template v-if="outside"> · {{ t('timeline.ai.highlights.outside') }}</template>
        </small>
      </div>
      <ul class="items" data-testid="timeline-ai-highlights-list">
        <li v-for="h in list" :key="h.id" :class="{ off: !h.checked }">
          <input
            type="checkbox"
            :checked="h.checked"
            :disabled="running"
            :aria-label="t('ai.toggle')"
            @change="ai.setHighlightChecked(h.id, ($event.target as HTMLInputElement).checked)"
          />
          <button type="button" class="item" @click="store.seek(h.range.start)">
            <span class="top">
              <span class="title">{{ h.title || '–' }}</span>
              <span class="score" :title="t('timeline.ai.highlights.score', { n: h.score })">
                {{ h.score }}/10
              </span>
            </span>
            <small>
              {{ formatTimeMs(timeToSeconds(h.range.start)) }} –
              {{ formatTimeMs(timeToSeconds(h.range.end)) }}
              ({{ timeToSeconds(h.range.end - h.range.start).toFixed(1) }} s)
            </small>
            <small v-if="h.reason">{{ h.reason }}</small>
          </button>
          <button
            type="button"
            class="listen"
            :class="{ active: playing(h.id) }"
            :disabled="running"
            :title="t('timeline.ai.highlights.play')"
            :aria-label="t('timeline.ai.highlights.play')"
            data-testid="timeline-ai-highlight-play"
            @click="onPlay(h.id)"
          >
            {{ playing(h.id) ? '■' : '▶' }}
          </button>
        </li>
      </ul>
      <button
        type="button"
        class="action"
        :class="{ active: playing(ALL_HIGHLIGHTS) }"
        :disabled="running || !checked.length"
        data-testid="timeline-ai-highlights-play-all"
        @click="onPlay(ALL_HIGHLIGHTS)"
      >
        {{
          playing(ALL_HIGHLIGHTS)
            ? t('timeline.ai.highlights.stop')
            : t('timeline.ai.highlights.playAll')
        }}
      </button>
      <p class="hint">{{ t('timeline.ai.highlights.reviewHint') }}</p>
      <label class="field">
        <span>{{ t('timeline.ai.highlights.format') }}</span>
        <select v-model="format" :disabled="running" data-testid="timeline-ai-highlights-format">
          <option v-for="(_, f) in SHORT_FORMATS" :key="f" :value="f">
            {{ t(`timeline.ai.highlights.formats.${f}`) }}
          </option>
        </select>
      </label>
      <button
        type="button"
        class="action primary"
        :disabled="running || !checked.length"
        data-testid="timeline-ai-highlights-apply"
        @click="onApply"
      >
        {{ t('timeline.ai.highlights.apply', { n: checked.length }) }}
      </button>
      <p class="hint">{{ t('timeline.ai.highlights.applyHint') }}</p>
    </template>

    <p v-if="notice" class="hint ok" role="status" data-testid="timeline-ai-highlights-notice">
      {{ notice }}
    </p>
    <p v-if="error" class="hint warn" role="alert" data-testid="timeline-ai-highlights-error">
      {{ error }}
    </p>
  </div>
</template>

<style scoped>
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
.action.active,
.action.primary {
  border-color: var(--ds-accent);
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
.hint.warn,
small.warn {
  color: var(--ds-danger, #b3261e);
}
.hint.ok {
  color: var(--ds-success, #2e7d32);
}
.list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--ds-space-2);
  color: var(--ds-text-2);
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
  align-items: flex-start;
  gap: var(--ds-space-2);
}
.items li.off {
  opacity: 0.55;
}
.item {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  padding: var(--ds-space-1) var(--ds-space-2);
  border: 1px solid var(--ds-border);
  border-left: 3px solid var(--ds-success, #2e7d32);
  border-radius: var(--ds-radius-md);
  background: var(--ds-surface-2);
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.item .top {
  display: flex;
  justify-content: space-between;
  gap: var(--ds-space-2);
}
.item .title {
  font-weight: var(--ds-weight-semibold);
}
.item small,
.item .score {
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
