<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { storeToRefs } from 'pinia'
import {
  AI_CANCELLED,
  AI_UNSUPPORTED,
  BROLL_MODES,
  DEFAULT_BROLLS,
  IMAGE_STYLES,
  MAX_BROLLS,
  type BrollKind,
  type BrollMode,
  type ImageStyle,
  type TranscribeLanguage,
} from '@/lib/aiApi'
import { useTimelineStore } from '@/stores/timeline'
import { NO_SPEECH, TOO_MANY_MEDIA, useTimelineAiStore } from '@/stores/timelineAi'
import { useTimelineBrollStore, type BrollItem } from '@/stores/timelineBroll'
import { chapterTime } from '@/timeline/markers'
import { secondsToTime } from '@/timeline/model'
import { MAX_PUBLISH_MEDIA, speechSegments } from '@/timeline/publish'

/**
 * Zwischenbilder (B-Roll): Claude sucht im Gesprochenen der ganzen Timeline
 * Stellen für passende Bilder oder kurze Videos und schreibt die Prompts. Die
 * Vorschläge lassen sich prüfen und ändern, bevor Gemini sie erzeugt; die
 * fertigen Zwischenbilder kommen erst mit „Einfügen“ auf die Timeline.
 */
const props = defineProps<{
  language: TranscribeLanguage
  /** Transkription und Claude sind eingerichtet. */
  ready: boolean
  /** Gemini (Bilder/Videos) ist eingerichtet. */
  gemini: boolean
}>()

const { t, locale } = useI18n()
const store = useTimelineStore()
const ai = useTimelineAiStore()
const broll = useTimelineBrollStore()
const { running } = storeToRefs(ai)
const { items, current, progress, generating, models, model, insertable } = storeToRefs(broll)

const mode = ref<BrollMode>('auto')
const style = ref<ImageStyle>('auto')
const count = ref(DEFAULT_BROLLS)
const error = ref('')
const notice = ref('')

onMounted(() => void broll.loadModels())

const hasSpeech = computed(() => speechSegments(store.doc).length > 0)
const busy = computed(() => running.value || generating.value)
const checked = computed(() => items.value.filter((i) => i.checked))
const toGenerate = computed(() => checked.value.filter((i) => i.state !== 'ready'))
const videosToGenerate = computed(() => toGenerate.value.filter((i) => i.kind === 'video').length)

function fail(e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e)
  if (msg === AI_CANCELLED) return
  if (msg === AI_UNSUPPORTED) error.value = t('ai.outdated')
  else if (msg === NO_SPEECH) error.value = t('timeline.ai.publish.noSpeech')
  else if (msg === TOO_MANY_MEDIA) {
    error.value = t('timeline.ai.publish.tooMany', { n: MAX_PUBLISH_MEDIA })
  } else error.value = msg
}

function clampCount(): void {
  const n = Math.round(Number(count.value))
  count.value = Number.isFinite(n) ? Math.min(MAX_BROLLS, Math.max(1, n)) : DEFAULT_BROLLS
}

async function onSuggest(): Promise<void> {
  if (busy.value) return
  clampCount()
  error.value = ''
  notice.value = ''
  try {
    const list = await ai.suggestBroll(props.language, {
      mode: mode.value,
      style: style.value,
      count: count.value,
      promptLanguage: locale.value === 'en' ? 'en' : 'de',
    })
    broll.setSuggestions(list)
    notice.value =
      list.length === 0
        ? t('timeline.ai.broll.none')
        : t('timeline.ai.broll.found', { n: list.length })
  } catch (e) {
    fail(e)
  }
}

async function onGenerate(ids?: number[]): Promise<void> {
  if (busy.value) return
  error.value = ''
  notice.value = ''
  try {
    const r = await broll.generate(ids)
    if (r.done || r.failed) {
      notice.value = r.failed
        ? t('timeline.ai.broll.generatedPartly', { n: r.done, m: r.failed })
        : t('timeline.ai.broll.generated', { n: r.done })
    }
  } catch (e) {
    fail(e)
  }
}

function onInsert(): void {
  if (busy.value) return
  error.value = ''
  try {
    const n = broll.insert()
    notice.value = t('timeline.ai.broll.inserted', { n })
  } catch (e) {
    fail(e)
  }
}

function setKind(item: BrollItem, kind: BrollKind): void {
  broll.update(item.id, { kind })
}

const timeOf = (s: number) => chapterTime(secondsToTime(s))
const seconds = (item: BrollItem) =>
  (Math.round((item.end - item.at) * 10) / 10).toLocaleString(locale.value)

function stateText(item: BrollItem): string {
  if (item.state === 'generating') {
    return t('timeline.ai.broll.generating', { p: current.value === item.id ? progress.value : 0 })
  }
  if (item.state === 'error') return item.error
  if (broll.isInserted(item)) return t('timeline.ai.broll.isInserted')
  if (item.state === 'ready') return t('timeline.ai.broll.ready', { name: item.media?.name ?? '' })
  return ''
}
</script>

<template>
  <div class="block" data-testid="timeline-ai-broll">
    <span class="label">{{ t('timeline.ai.broll.title') }}</span>
    <p class="hint">{{ t('timeline.ai.broll.hint') }}</p>
    <p v-if="!hasSpeech" class="hint warn" data-testid="timeline-ai-broll-no-speech">
      {{ t('timeline.ai.publish.noSpeech') }}
    </p>
    <template v-else>
      <label class="field">
        <span>{{ t('timeline.ai.broll.mode') }}</span>
        <select v-model="mode" :disabled="busy" data-testid="timeline-ai-broll-mode">
          <option v-for="m in BROLL_MODES" :key="m" :value="m">
            {{ t(`timeline.ai.broll.modes.${m}`) }}
          </option>
        </select>
      </label>
      <label class="field">
        <span>{{ t('stillAi.style') }}</span>
        <select v-model="style" :disabled="busy" data-testid="timeline-ai-broll-style">
          <option v-for="s in IMAGE_STYLES" :key="s" :value="s">
            {{ t(`stillAi.styles.${s}`) }}
          </option>
        </select>
      </label>
      <label class="field inline">
        <span>{{ t('timeline.ai.broll.count') }}</span>
        <input
          v-model.number="count"
          type="number"
          class="num"
          min="1"
          :max="MAX_BROLLS"
          step="1"
          :disabled="busy"
          data-testid="timeline-ai-broll-count"
          @change="clampCount"
        />
      </label>
      <button
        type="button"
        class="action"
        :disabled="busy || !ready"
        data-testid="timeline-ai-broll-suggest"
        @click="onSuggest"
      >
        {{ items.length ? t('timeline.ai.broll.resuggest') : t('timeline.ai.broll.suggest') }}
      </button>
    </template>

    <template v-if="items.length">
      <p v-if="!gemini" class="hint warn">{{ t('stillAi.noImageKey') }}</p>
      <ul class="items" data-testid="timeline-ai-broll-list">
        <li
          v-for="item in items"
          :key="item.id"
          :class="{ off: !item.checked }"
          :data-state="item.state"
          data-testid="timeline-ai-broll-item"
        >
          <div class="head">
            <input
              type="checkbox"
              :checked="item.checked"
              :disabled="item.state === 'generating'"
              :aria-label="t('ai.toggle')"
              @change="
                broll.update(item.id, { checked: ($event.target as HTMLInputElement).checked })
              "
            />
            <button
              type="button"
              class="time"
              :title="t('timeline.ai.broll.seek')"
              @click="store.seek(secondsToTime(item.at))"
            >
              {{ timeOf(item.at) }}
            </button>
            <span class="name" :title="item.reason">{{ item.title || '–' }}</span>
            <small class="len">{{ t('timeline.ai.broll.seconds', { s: seconds(item) }) }}</small>
          </div>
          <p v-if="item.reason" class="reason">{{ item.reason }}</p>
          <div class="kinds" role="radiogroup" :aria-label="t('timeline.ai.broll.kind')">
            <label v-for="k in ['image', 'video'] as const" :key="k" class="check">
              <input
                type="radio"
                :name="`broll-kind-${item.id}`"
                :checked="item.kind === k"
                :disabled="busy"
                :data-testid="`timeline-ai-broll-kind-${k}`"
                @change="setKind(item, k)"
              />
              <span>{{ t(`timeline.ai.broll.kinds.${k}`) }}</span>
            </label>
          </div>
          <textarea
            :value="item.prompt"
            rows="4"
            maxlength="2000"
            :disabled="busy"
            :aria-label="t('timeline.ai.broll.prompt')"
            data-testid="timeline-ai-broll-prompt"
            @change="
              broll.update(item.id, { prompt: ($event.target as HTMLTextAreaElement).value })
            "
          ></textarea>
          <img
            v-if="item.thumb"
            :src="item.thumb"
            class="thumb"
            :alt="item.title"
            data-testid="timeline-ai-broll-thumb"
          />
          <p
            v-if="stateText(item)"
            class="hint"
            :class="{ warn: item.state === 'error', ok: item.state === 'ready' }"
            data-testid="timeline-ai-broll-state"
          >
            {{ stateText(item) }}
          </p>
          <button
            type="button"
            class="plain"
            :disabled="busy || !gemini || !item.prompt.trim()"
            data-testid="timeline-ai-broll-generate-one"
            @click="onGenerate([item.id])"
          >
            {{
              item.state === 'ready'
                ? t('timeline.ai.broll.regenerate')
                : t('timeline.ai.broll.generateOne')
            }}
          </button>
        </li>
      </ul>

      <label v-if="models && videosToGenerate" class="field">
        <span>{{ t('timeline.ai.broll.videoModel') }}</span>
        <select
          :value="model.video"
          :disabled="busy"
          @change="broll.setModel('video', ($event.target as HTMLSelectElement).value)"
        >
          <option v-for="m in models.video.models" :key="m" :value="m">
            {{ m === models.video.default ? t('stillAi.modelDefault', { model: m }) : m }}
          </option>
        </select>
      </label>
      <label v-if="models && toGenerate.length > videosToGenerate" class="field">
        <span>{{ t('timeline.ai.broll.imageModel') }}</span>
        <select
          :value="model.image"
          :disabled="busy"
          @change="broll.setModel('image', ($event.target as HTMLSelectElement).value)"
        >
          <option v-for="m in models.image.models" :key="m" :value="m">
            {{ m === models.image.default ? t('stillAi.modelDefault', { model: m }) : m }}
          </option>
        </select>
      </label>

      <button
        v-if="!generating"
        type="button"
        class="action"
        :disabled="busy || !gemini || toGenerate.length === 0"
        data-testid="timeline-ai-broll-generate"
        @click="onGenerate()"
      >
        {{ t('timeline.ai.broll.generate', { n: toGenerate.length }) }}
      </button>
      <button
        v-else
        type="button"
        class="action"
        data-testid="timeline-ai-broll-cancel"
        @click="broll.cancel()"
      >
        {{ t('timeline.ai.broll.cancel') }}
      </button>
      <p v-if="videosToGenerate" class="hint">
        {{ t('timeline.ai.broll.videoHint', { n: videosToGenerate }) }}
      </p>
      <button
        type="button"
        class="action primary"
        :disabled="busy || insertable.length === 0"
        data-testid="timeline-ai-broll-insert"
        @click="onInsert"
      >
        {{ t('timeline.ai.broll.insert', { n: insertable.length }) }}
      </button>
      <p class="hint">{{ t('timeline.ai.broll.insertHint') }}</p>
    </template>

    <p v-if="notice" class="hint ok" role="status" data-testid="timeline-ai-broll-notice">
      {{ notice }}
    </p>
    <p v-if="error" class="hint warn" role="alert" data-testid="timeline-ai-broll-error">
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
.field.inline {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
}
select,
textarea,
.num {
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
.num {
  width: 5em;
}
textarea {
  resize: vertical;
  line-height: 1.4;
  font-size: var(--ds-text-sm);
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
.action:disabled,
.plain:disabled {
  opacity: 0.5;
  cursor: default;
}
.time {
  flex: none;
  min-width: 3.6em;
  padding: 0 var(--ds-space-2);
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  background: var(--ds-surface-2);
  color: inherit;
  font: inherit;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}
.hint {
  margin: 0;
  color: var(--ds-text-2);
  line-height: 1.5;
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
  gap: var(--ds-space-2);
  max-height: 520px;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}
.items li {
  display: flex;
  flex-direction: column;
  gap: var(--ds-space-1);
  padding: var(--ds-space-2);
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
}
.items li.off {
  opacity: 0.55;
}
.head {
  display: flex;
  align-items: center;
  gap: var(--ds-space-1);
}
.name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: var(--ds-weight-semibold);
}
.len,
.reason {
  color: var(--ds-text-2);
}
.reason {
  margin: 0;
  font-size: var(--ds-text-sm);
}
.kinds {
  display: flex;
  gap: var(--ds-space-3);
}
.check {
  display: flex;
  align-items: center;
  gap: var(--ds-space-1);
  color: var(--ds-text-2);
}
.thumb {
  width: 100%;
  max-height: 140px;
  object-fit: contain;
  border-radius: var(--ds-radius-sm, 4px);
  background: #000;
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
</style>
