<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAiStore } from '@/stores/ai'
import {
  AI_CANCELLED,
  AI_UNSUPPORTED,
  DEFAULT_VIDEO_DURATION,
  IMAGE_STYLES,
  MAX_IMAGE_COUNT,
  MAX_IMAGE_IDEA,
  MAX_IMAGE_PROMPT,
  MIN_IMAGE_COUNT,
  VIDEO_DURATIONS,
  fetchAiModels,
  fetchGeneratedImage,
  parseGeneratedImages,
  parseGeneratedVideo,
  parseImagePrompt,
  runAiJob,
  type AiModels,
  type AiRun,
  type ImageStyle,
} from '@/lib/aiApi'
import { saveFile } from '@/lib/download'
import type { MediaView } from '@/lib/mediaApi'
import StillGallery from './StillGallery.vue'

/**
 * KI-Hintergrund für einen Bild-Clip: Claude schreibt aus Stichworten, Stil
 * und den Nachbarclips (Standbild + Transkript) einen Prompt, den man sieht
 * und ändern kann; Gemini erzeugt daraus 1–4 Varianten. Die gewählte Variante
 * geht als Datei an den Bild-Clip (wie ein hochgeladenes Bild).
 *
 * Modus „Video“: derselbe Weg mit Video-Prompt; Gemini erzeugt einen kurzen
 * Clip, der als normales Video an der Einfügestelle in die Liste kommt.
 */
export interface SceneRef {
  mediaId: string
  /** Zeit im Clip (Sekunden), aus der das Standbild stammt. */
  time: number
  name: string
}

const props = defineProps<{
  width: number
  height: number
  before: SceneRef | null
  after: SceneRef | null
  disabled: boolean
}>()

const emit = defineEmits<{
  pick: [file: File]
  /** Fertiges KI-Video (liegt schon in der Server-Bibliothek). */
  video: [media: MediaView]
  busy: [busy: boolean]
}>()

const { t, locale } = useI18n()
const ai = useAiStore()

const idea = ref('')
const style = ref<ImageStyle>('auto')
const count = ref(2)
const useContext = ref(true)
/** Bild oder Video erzeugen; jeder Modus behält seinen eigenen Prompt. */
const mode = ref<'image' | 'video'>('image')
const duration = ref<number>(DEFAULT_VIDEO_DURATION)
const prompts = ref({ image: '', video: '' })
const prompt = computed({
  get: () => prompts.value[mode.value],
  set: (v: string) => (prompts.value[mode.value] = v),
})
const phase = ref<'prompt' | 'images' | 'video' | null>(null)
const progress = ref(0)
const error = ref('')
const notice = ref('')
const run = shallowRef<AiRun<unknown> | null>(null)

interface Variant {
  file: File
  url: string
}
const variants = ref<Variant[]>([])
const selected = ref(-1)

// --- Modellauswahl (je Modus, im Browser gemerkt) ---
const MODEL_KEY = 'vc.aiModel.'
const models = ref<AiModels | null>(null)
const chosen = ref({ image: '', video: '' })
const modelOptions = computed(() => models.value?.[mode.value].models ?? [])
const model = computed({
  get: () => chosen.value[mode.value],
  set: (v: string) => {
    chosen.value[mode.value] = v
    try {
      localStorage.setItem(MODEL_KEY + mode.value, v)
    } catch {
      /* Speicher gesperrt – Auswahl gilt nur für diese Sitzung */
    }
  },
})

async function loadModels(): Promise<void> {
  try {
    const m = await fetchAiModels()
    if (!m) return
    for (const kind of ['image', 'video'] as const) {
      let saved = ''
      try {
        saved = localStorage.getItem(MODEL_KEY + kind) ?? ''
      } catch {
        /* ohne gemerkte Auswahl */
      }
      // Gemerktes Modell nur, wenn Google es noch anbietet.
      chosen.value[kind] = m[kind].models.includes(saved) ? saved : m[kind].default
    }
    models.value = m
  } catch {
    /* ohne Liste gilt die Voreinstellung des Servers */
  }
}

/** Zusatz für die Aufträge: gewähltes Modell (leer = Voreinstellung des Servers). */
const modelParam = computed(() => (model.value ? { model: model.value } : {}))
/** Zuletzt tatsächlich verwendetes Modell (Anzeige nach dem Erzeugen). */
const usedModel = ref('')

onMounted(() => {
  void ai.loadStatus()
  void loadModels()
})

const claudeOk = computed(() => ai.status?.claude === true)
const imageOk = computed(() => ai.status?.image === true)
const hasContext = computed(() => !!(props.before || props.after))
const contextOn = computed(() => useContext.value && hasContext.value)
const busy = computed(() => phase.value !== null)

const canWritePrompt = computed(
  () =>
    !props.disabled &&
    !busy.value &&
    claudeOk.value &&
    (idea.value.trim() !== '' || contextOn.value),
)
const canGenerate = computed(
  () => !props.disabled && !busy.value && imageOk.value && prompt.value.trim() !== '',
)

function setPhase(p: 'prompt' | 'images' | 'video' | null): void {
  phase.value = p
  progress.value = 0
  emit('busy', p !== null)
}

function message(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  if (msg === AI_UNSUPPORTED) return t('stillAi.outdated')
  return msg || t('stillAi.failed')
}

async function writePrompt(): Promise<void> {
  if (!canWritePrompt.value) return
  error.value = ''
  notice.value = ''
  setPhase('prompt')
  const r = runAiJob(
    mode.value === 'video' ? 'video-prompt' : 'image-prompt',
    {
      ...(mode.value === 'video' ? { duration: duration.value } : {}),
      idea: idea.value.trim(),
      style: style.value,
      width: props.width,
      height: props.height,
      language: locale.value === 'en' ? 'en' : 'de',
      ...(contextOn.value && props.before
        ? { before: { mediaId: props.before.mediaId, time: props.before.time } }
        : {}),
      ...(contextOn.value && props.after
        ? { after: { mediaId: props.after.mediaId, time: props.after.time } }
        : {}),
    },
    parseImagePrompt,
    (p) => (progress.value = p),
  )
  run.value = r as AiRun<unknown>
  try {
    prompt.value = (await r.promise).slice(0, MAX_IMAGE_PROMPT)
  } catch (e) {
    if (!(e instanceof Error && e.message === AI_CANCELLED)) error.value = message(e)
  } finally {
    run.value = null
    setPhase(null)
  }
}

function clearVariants(): void {
  for (const v of variants.value) URL.revokeObjectURL(v.url)
  variants.value = []
  selected.value = -1
}

async function generateVideo(): Promise<void> {
  if (!canGenerate.value) return
  error.value = ''
  notice.value = ''
  setPhase('video')
  const r = runAiJob(
    'video',
    {
      prompt: prompt.value.trim(),
      width: props.width,
      height: props.height,
      duration: duration.value,
      ...modelParam.value,
    },
    parseGeneratedVideo,
    (p) => (progress.value = p),
  )
  run.value = r as AiRun<unknown>
  try {
    const res = await r.promise
    notice.value = res.galleryError
    usedModel.value = res.model
    if (res.saved) galleryRefresh.value++
    emit('video', res.media)
  } catch (e) {
    if (!(e instanceof Error && e.message === AI_CANCELLED)) error.value = message(e)
  } finally {
    run.value = null
    setPhase(null)
  }
}

async function generate(): Promise<void> {
  if (mode.value === 'video') return generateVideo()
  if (!canGenerate.value) return
  error.value = ''
  notice.value = ''
  setPhase('images')
  const r = runAiJob(
    'images',
    {
      prompt: prompt.value.trim(),
      width: props.width,
      height: props.height,
      count: count.value,
      ...modelParam.value,
    },
    parseGeneratedImages,
    (p) => (progress.value = p),
  )
  run.value = r as AiRun<unknown>
  try {
    const res = await r.promise
    const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '')
    const files = await Promise.all(
      res.images.map((img, i) => fetchGeneratedImage(img, `ki-bild-${stamp}-${i + 1}`)),
    )
    clearVariants()
    variants.value = files.map((file) => ({ file, url: URL.createObjectURL(file) }))
    notice.value = [res.failed > 0 ? t('stillAi.partial', { n: res.failed }) : '', res.galleryError]
      .filter(Boolean)
      .join(' ')
    usedModel.value = res.model
    if (res.saved) galleryRefresh.value++
    choose(0)
  } catch (e) {
    if (!(e instanceof Error && e.message === AI_CANCELLED)) error.value = message(e)
  } finally {
    run.value = null
    setPhase(null)
  }
}

// --- Galerie (dauerhaft gespeicherte Bilder) ---
const galleryOpen = ref(false)
const galleryRefresh = ref(0)

function onGalleryPick(file: File): void {
  selected.value = -1
  emit('pick', file)
}

function onGalleryPrompt(text: string, kind: 'image' | 'video'): void {
  if (!busy.value) mode.value = kind
  prompts.value[kind] = text.slice(0, MAX_IMAGE_PROMPT)
}

function choose(i: number): void {
  const v = variants.value[i]
  if (!v) return
  selected.value = i
  emit('pick', v.file)
}

/** Speichert eine Variante als Bilddatei (Originalgröße von Gemini). */
async function download(i: number): Promise<void> {
  const v = variants.value[i]
  if (!v) return
  try {
    await saveFile({ blob: v.file, name: v.file.name })
  } catch {
    error.value = t('stillAi.downloadFailed')
  }
}

function cancel(): void {
  run.value?.cancel()
}

onBeforeUnmount(() => {
  run.value?.cancel()
  clearVariants()
})
</script>

<template>
  <div class="ai-img" data-test="still-ai">
    <p v-if="ai.statusChecked && !ai.status" class="hint warn" role="alert">
      {{ t('stillAi.outdated') }}
    </p>
    <p v-else-if="ai.statusChecked && !imageOk" class="hint warn" data-test="still-ai-nokey">
      {{ t('stillAi.noImageKey') }}
    </p>

    <div class="modes" role="group" :aria-label="t('stillAi.mode')">
      <button
        v-for="m in ['image', 'video'] as const"
        :key="m"
        type="button"
        class="mode"
        :class="{ on: mode === m }"
        :aria-pressed="mode === m"
        :disabled="busy"
        :data-test="`still-ai-mode-${m}`"
        @click="mode = m"
      >
        {{ t(`stillAi.modes.${m}`) }}
      </button>
    </div>

    <label class="field stack">
      <span class="field-label">{{ t('stillAi.idea') }}</span>
      <input
        v-model="idea"
        type="text"
        class="input"
        :maxlength="MAX_IMAGE_IDEA"
        :placeholder="t('stillAi.ideaPlaceholder')"
        :disabled="busy"
        data-test="still-ai-idea"
      />
    </label>

    <div class="row2">
      <label class="field stack">
        <span class="field-label">{{ t('stillAi.style') }}</span>
        <select v-model="style" class="input" :disabled="busy" data-test="still-ai-style">
          <option v-for="s in IMAGE_STYLES" :key="s" :value="s">
            {{ t(`stillAi.styles.${s}`) }}
          </option>
        </select>
      </label>
      <label v-if="mode === 'video'" class="field stack narrow">
        <span class="field-label">{{ t('stillAi.duration') }}</span>
        <select
          v-model.number="duration"
          class="input"
          :disabled="busy"
          data-test="still-ai-duration"
        >
          <option v-for="d in VIDEO_DURATIONS" :key="d" :value="d">{{ d }} s</option>
        </select>
      </label>
      <label v-else class="field stack narrow">
        <span class="field-label">{{ t('stillAi.count') }}</span>
        <select v-model.number="count" class="input" :disabled="busy" data-test="still-ai-count">
          <option v-for="n in MAX_IMAGE_COUNT - MIN_IMAGE_COUNT + 1" :key="n" :value="n">
            {{ n }}
          </option>
        </select>
      </label>
    </div>

    <label v-if="modelOptions.length" class="field stack">
      <span class="field-label">{{ t('stillAi.model') }}</span>
      <select v-model="model" class="input" :disabled="busy" data-test="still-ai-model">
        <option v-for="m in modelOptions" :key="m" :value="m">
          {{ m === models?.[mode].default ? t('stillAi.modelDefault', { model: m }) : m }}
        </option>
      </select>
    </label>

    <label class="check" :class="{ off: !hasContext }">
      <input v-model="useContext" type="checkbox" :disabled="busy || !hasContext" />
      <span>
        {{ hasContext ? t('stillAi.useContext') : t('stillAi.noContext') }}
        <small v-if="hasContext" class="ctx">
          <template v-if="before">◀ {{ before.name }}</template>
          <template v-if="before && after"> · </template>
          <template v-if="after">{{ after.name }} ▶</template>
        </small>
      </span>
    </label>

    <button
      type="button"
      class="btn small"
      :disabled="!canWritePrompt"
      :title="claudeOk ? '' : t('stillAi.noClaude')"
      data-test="still-ai-write"
      @click="writePrompt"
    >
      {{ phase === 'prompt' ? t('stillAi.writing') : t('stillAi.write') }}
    </button>

    <label class="field stack">
      <span class="field-label">{{ t('stillAi.prompt') }}</span>
      <textarea
        v-model="prompt"
        class="input area"
        rows="4"
        :maxlength="MAX_IMAGE_PROMPT"
        :placeholder="t('stillAi.promptPlaceholder')"
        :disabled="busy"
        data-test="still-ai-prompt"
      />
    </label>

    <div class="actions">
      <button
        type="button"
        class="btn primary"
        :disabled="!canGenerate"
        data-test="still-ai-generate"
        @click="generate"
      >
        <template v-if="mode === 'video'">
          {{
            phase === 'video'
              ? t('stillAi.generatingVideo', { pct: progress })
              : t('stillAi.generateVideo')
          }}
        </template>
        <template v-else>
          {{
            phase === 'images'
              ? t('stillAi.generating', { pct: progress })
              : variants.length
                ? t('stillAi.regenerate')
                : t('stillAi.generate')
          }}
        </template>
      </button>
      <button v-if="busy" type="button" class="btn ghost" @click="cancel">
        {{ t('stillAi.cancel') }}
      </button>
    </div>

    <p v-if="error" class="hint warn" role="alert">{{ error }}</p>
    <p v-if="notice" class="hint">{{ notice }}</p>
    <p v-if="usedModel" class="hint" data-test="still-ai-used-model">
      {{ t('stillAi.usedModel', { model: usedModel }) }}
    </p>

    <div
      v-if="variants.length && mode === 'image'"
      class="grid"
      role="group"
      :aria-label="t('stillAi.variants')"
    >
      <div v-for="(v, i) in variants" :key="v.url" class="cell">
        <button
          type="button"
          class="thumb"
          :class="{ on: selected === i }"
          :aria-pressed="selected === i"
          :title="t('stillAi.useVariant', { n: i + 1 })"
          :disabled="busy"
          data-test="still-ai-variant"
          @click="choose(i)"
        >
          <img :src="v.url" :alt="t('stillAi.useVariant', { n: i + 1 })" />
        </button>
        <button
          type="button"
          class="dl"
          :title="t('stillAi.download', { n: i + 1 })"
          :aria-label="t('stillAi.download', { n: i + 1 })"
          data-test="still-ai-download"
          @click="download(i)"
        >
          ⬇
        </button>
      </div>
    </div>
    <p class="hint" data-test="still-ai-hint">
      {{ mode === 'video' ? t('stillAi.hintVideo') : t('stillAi.hint') }}
    </p>

    <button
      type="button"
      class="btn small"
      :aria-expanded="galleryOpen"
      data-test="gallery-toggle"
      @click="galleryOpen = !galleryOpen"
    >
      {{ galleryOpen ? t('gallery.close') : t('gallery.open') }}
    </button>
    <StillGallery
      v-if="galleryOpen"
      :disabled="busy || disabled"
      :refresh-key="galleryRefresh"
      @pick="onGalleryPick"
      @video="emit('video', $event)"
      @prompt="onGalleryPrompt"
    />
  </div>
</template>

<style scoped>
.ai-img {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px;
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-sm);
  background: var(--ds-surface-1);
}
.modes {
  display: flex;
  gap: 4px;
}
.mode {
  appearance: none;
  flex: 1;
  padding: 6px 8px;
  border: 1px solid var(--ds-border-strong);
  border-radius: var(--ds-radius-sm);
  background: var(--ds-surface-0);
  color: var(--ds-text-2);
  font-size: var(--ds-text-sm);
  cursor: pointer;
}
.mode.on {
  border-color: var(--ds-accent);
  background: var(--ds-accent-soft);
  color: var(--ds-text);
  font-weight: var(--ds-weight-semibold);
}
.mode:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}
.mode:focus-visible {
  outline: none;
  box-shadow: var(--ds-focus-ring);
}
.row2 {
  display: flex;
  gap: 8px;
}
.row2 .field {
  flex: 1;
  min-width: 0;
}
.row2 .field.narrow {
  flex: 0 0 76px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.field-label {
  font-size: var(--ds-text-sm);
  color: var(--ds-text-2);
}
.input {
  min-width: 0;
  padding: 5px 8px;
  border: 1px solid var(--ds-border-strong);
  border-radius: var(--ds-radius-sm);
  background: var(--ds-surface-0);
  color: var(--ds-text);
  font: inherit;
  font-size: var(--ds-text-sm);
}
.input.area {
  resize: vertical;
  min-height: 70px;
  line-height: 1.4;
}
.input:focus-visible {
  outline: none;
  border-color: var(--ds-accent);
  box-shadow: var(--ds-focus-ring);
}
.check {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: var(--ds-text-sm);
  color: var(--ds-text-2);
  cursor: pointer;
}
.check.off {
  cursor: default;
  opacity: 0.7;
}
.check input {
  margin-top: 2px;
}
.ctx {
  display: block;
  font-size: var(--ds-text-xs);
  overflow-wrap: anywhere;
}
.actions {
  display: flex;
  gap: 6px;
}
.actions .btn.primary {
  flex: 1;
}
.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}
.cell {
  position: relative;
  line-height: 0;
}
.dl {
  appearance: none;
  position: absolute;
  right: 6px;
  bottom: 6px;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid var(--ds-border-strong);
  border-radius: var(--ds-radius-sm);
  background: var(--ds-surface-0);
  color: var(--ds-text);
  font-size: var(--ds-text-sm);
  line-height: 1;
  cursor: pointer;
}
.dl:hover {
  border-color: var(--ds-accent);
}
.dl:focus-visible {
  outline: none;
  box-shadow: var(--ds-focus-ring);
}
.thumb {
  appearance: none;
  display: block;
  width: 100%;
  padding: 0;
  border: 2px solid var(--ds-border);
  border-radius: var(--ds-radius-sm);
  background: var(--ds-surface-2);
  cursor: pointer;
  overflow: hidden;
  line-height: 0;
}
.thumb img {
  width: 100%;
  height: auto;
  display: block;
}
.thumb.on {
  border-color: var(--ds-accent);
  box-shadow: var(--ds-focus-ring);
}
.thumb:focus-visible {
  outline: none;
  box-shadow: var(--ds-focus-ring);
}
.btn {
  appearance: none;
  border: 1px solid var(--ds-border-strong);
  background: var(--ds-surface-2);
  color: var(--ds-text);
  padding: 8px 12px;
  border-radius: var(--ds-radius-md);
  font-size: var(--ds-text-sm);
  cursor: pointer;
}
.btn:hover:not(:disabled) {
  border-color: var(--ds-accent);
}
.btn.small {
  padding: 5px 10px;
  font-size: var(--ds-text-xs);
}
.btn.ghost {
  background: transparent;
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
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.btn:focus-visible {
  outline: none;
  box-shadow: var(--ds-focus-ring);
}
.hint {
  margin: 0;
  font-size: var(--ds-text-xs);
  color: var(--ds-text-2);
  line-height: 1.4;
}
.hint.warn {
  color: var(--ds-danger);
}
</style>
