<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { PROJECTS_UNSUPPORTED } from '@/lib/projectApi'
import {
  TIMELINE_PROJECT_BUSY,
  TIMELINE_PROJECT_EMPTY,
  TIMELINE_PROJECT_INVALID,
  TIMELINE_PROJECT_MEDIA_GONE,
  TIMELINE_PROJECT_TOO_MANY,
  TIMELINE_PROJECT_UPLOADS_PENDING,
  useTimelineProjectStore,
} from '@/stores/timelineProjects'
import { useTimelineStore } from '@/stores/timeline'

/**
 * Projekte des Timeline-Editors: aktuellen Stand unter einem Namen auf dem
 * Server speichern, gespeicherte Projekte öffnen (ersetzt die Bearbeitung)
 * oder löschen, leeres Projekt beginnen.
 */
const emit = defineEmits<{ close: [] }>()
const { t, locale } = useI18n()
const store = useTimelineProjectStore()
const timeline = useTimelineStore()
const {
  projects,
  loaded,
  current,
  busy,
  progress,
  hasContent,
  dirty,
  autosave,
  autosaveState,
  autosaveError,
  incomplete,
} = storeToRefs(store)

const dialogEl = ref<HTMLDialogElement | null>(null)
const name = ref('')
const error = ref('')
const notice = ref('')
/** Inline-Bestätigung: Projekt-ID (bzw. `new`) + Aktion. */
const confirm = ref<{ id: string; action: 'open' | 'delete' | 'new' } | null>(null)
/** Umbenennen in der Liste: Projekt-ID + eingegebener Name. */
const editing = ref<{ id: string; name: string } | null>(null)
const renameInput = ref<HTMLInputElement[] | HTMLInputElement | null>(null)

const locked = computed(() => busy.value !== null)
const canSave = computed(() => hasContent.value && !locked.value && name.value.trim().length > 0)

/** Vorschlag: Name des geöffneten Projekts, sonst der des ersten Videos ohne Endung. */
function suggestName(): string {
  if (current.value) return current.value.name
  if (store.suggestedName) return store.suggestedName
  const first = Object.values(timeline.doc.assets)[0]?.name ?? ''
  return first.replace(/\.[^.]+$/, '')
}

watch(
  () => current.value?.id ?? null,
  () => (name.value = suggestName()),
  { immediate: true },
)

function messageOf(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  const map: Record<string, string> = {
    [PROJECTS_UNSUPPORTED]: 'timelineProjects.outdated',
    [TIMELINE_PROJECT_EMPTY]: 'timelineProjects.empty',
    [TIMELINE_PROJECT_UPLOADS_PENDING]: 'projects.uploadsPending',
    [TIMELINE_PROJECT_MEDIA_GONE]: 'timelineProjects.mediaGone',
    [TIMELINE_PROJECT_TOO_MANY]: 'timelineProjects.tooMany',
    [TIMELINE_PROJECT_INVALID]: 'timelineProjects.invalid',
    [TIMELINE_PROJECT_BUSY]: 'timelineProjects.busy',
  }
  return map[msg] ? t(map[msg]) : msg
}

function clearMessages(): void {
  confirm.value = null
  editing.value = null
  error.value = ''
  notice.value = ''
}

async function load(): Promise<void> {
  try {
    await store.refresh()
  } catch (e) {
    error.value = messageOf(e)
  }
}

onMounted(() => {
  dialogEl.value?.showModal()
  void load()
})

function close(): void {
  dialogEl.value?.close()
  emit('close')
}

async function onSave(asNew: boolean): Promise<void> {
  clearMessages()
  try {
    const p = await store.save(name.value.trim(), asNew)
    name.value = p.name
    notice.value = t('projects.saved', { name: p.name })
  } catch (e) {
    error.value = messageOf(e)
  }
}

function askOpen(id: string): void {
  clearMessages()
  // Ohne ungesicherte Änderungen direkt öffnen.
  if (!dirty.value) void doOpen(id)
  else confirm.value = { id, action: 'open' }
}

async function doOpen(id: string): Promise<void> {
  clearMessages()
  try {
    const r = await store.open(id)
    const parts = [
      r.missing
        ? t('projects.openedMissing', { n: r.missing })
        : t('projects.opened', { name: r.name }),
    ]
    if (r.converted) {
      // Umgewandelt aus der bisherigen App: gilt als neues Projekt.
      name.value = r.name
      parts.push(t('timelineProjects.converted'))
      if (r.skipped.length) {
        const list = r.skipped.map((k) => t(`timelineProjects.skipped.${k}`)).join(', ')
        parts.push(t('timelineProjects.notConverted', { list }))
      }
    }
    notice.value = parts.join(' ')
  } catch (e) {
    error.value = messageOf(e)
  }
}

async function doDelete(id: string): Promise<void> {
  clearMessages()
  try {
    await store.remove(id)
  } catch (e) {
    error.value = messageOf(e)
  }
}

async function startRename(id: string, current: string): Promise<void> {
  clearMessages()
  editing.value = { id, name: current }
  await nextTick()
  const el = Array.isArray(renameInput.value) ? renameInput.value[0] : renameInput.value
  el?.focus()
  el?.select()
}

const canRename = computed(() => !locked.value && (editing.value?.name.trim().length ?? 0) > 0)

async function doRename(): Promise<void> {
  const e = editing.value
  if (!e || !canRename.value) return
  const next = e.name.trim()
  const old = projects.value.find((p) => p.id === e.id)?.name
  if (next === old) {
    editing.value = null
    return
  }
  try {
    const p = await store.rename(e.id, next)
    editing.value = null
    // Das geöffnete Projekt: auch das Namensfeld oben nachziehen.
    if (current.value?.id === p.id) name.value = p.name
    notice.value = t('timelineProjects.renamed', { name: p.name })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    error.value =
      msg === PROJECTS_UNSUPPORTED ? t('timelineProjects.renameOutdated') : messageOf(err)
  }
}

function askNew(): void {
  clearMessages()
  if (!dirty.value) doNew()
  else confirm.value = { id: 'new', action: 'new' }
}

function doNew(): void {
  clearMessages()
  store.startNew()
  name.value = ''
}

function formatDate(ms: number): string {
  if (!ms) return ''
  return new Date(ms).toLocaleString(locale.value, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  return `${Math.max(0.1, bytes / 1024 ** 2).toFixed(1)} MB`
}
</script>

<template>
  <dialog
    ref="dialogEl"
    class="projects"
    data-testid="project-dialog"
    :aria-label="t('timelineProjects.title')"
    @cancel.prevent="close"
  >
    <div class="box">
      <header class="head">
        <h2>{{ t('timelineProjects.title') }}</h2>
        <button
          type="button"
          class="btn ghost"
          :aria-label="t('timelineExport.close')"
          @click="close"
        >
          ✕
        </button>
      </header>

      <form class="save" @submit.prevent="onSave(false)">
        <label for="timeline-project-name" class="field-label">{{ t('projects.name') }}</label>
        <input
          id="timeline-project-name"
          v-model="name"
          class="input"
          type="text"
          maxlength="120"
          :disabled="locked || !hasContent"
          data-testid="project-name"
        />
        <div class="save-actions">
          <button class="btn primary" type="submit" :disabled="!canSave" data-testid="project-save">
            {{ current ? t('projects.save') : t('projects.saveNew') }}
          </button>
          <button
            v-if="current"
            class="btn"
            type="button"
            :disabled="!canSave"
            :title="t('projects.saveAsHint')"
            data-testid="project-save-as"
            @click="onSave(true)"
          >
            {{ t('projects.saveAs') }}
          </button>
          <button
            class="btn"
            type="button"
            :disabled="locked || (!hasContent && !current)"
            data-testid="project-new"
            @click="askNew"
          >
            {{ t('timelineProjects.startNew') }}
          </button>
        </div>
        <div v-if="confirm?.action === 'new'" class="confirm" role="group">
          <span class="confirm-text">{{ t('projects.confirmOpen') }}</span>
          <button
            class="btn tiny primary"
            type="button"
            data-testid="project-confirm"
            @click="doNew"
          >
            {{ t('timelineProjects.startNew') }}
          </button>
          <button class="btn tiny ghost" type="button" @click="confirm = null">
            {{ t('projects.cancel') }}
          </button>
        </div>
        <p v-if="!hasContent" class="hint">{{ t('timelineProjects.empty') }}</p>
        <p v-else-if="current" class="hint" data-testid="project-current">
          {{ t('projects.currentInfo', { name: current.name, time: formatDate(current.savedAt) }) }}
          <template v-if="dirty"> · {{ t('timelineProjects.unsaved') }}</template>
        </p>
      </form>

      <label class="auto">
        <input
          type="checkbox"
          :checked="autosave"
          data-testid="project-autosave"
          @change="store.setAutosave(($event.target as HTMLInputElement).checked)"
        />
        <span>
          {{ t('timelineProjects.autosave') }}
          <small>{{ t('timelineProjects.autosaveHint') }}</small>
        </span>
      </label>
      <p v-if="autosave && incomplete" class="hint" data-testid="project-autosave-paused">
        {{ t('timelineProjects.autosavePaused') }}
      </p>
      <p
        v-if="autosaveState === 'error'"
        class="hint warn"
        role="alert"
        data-testid="project-autosave-error"
      >
        {{ t('timelineProjects.autosaveFailed', { error: messageOf(new Error(autosaveError)) }) }}
      </p>

      <p v-if="progress" class="hint status" role="status">
        <span class="spinner" aria-hidden="true" />
        {{ t(progress.key, progress.params ?? {}) }}
      </p>
      <p v-if="error" class="hint warn" role="alert" data-testid="project-error">{{ error }}</p>
      <p v-else-if="notice" class="hint ok" role="status" data-testid="project-notice">
        {{ notice }}
      </p>

      <h3 class="list-title">{{ t('timelineProjects.saved') }}</h3>
      <ul v-if="projects.length" class="list" data-testid="project-list">
        <li
          v-for="p in projects"
          :key="p.id"
          class="row"
          :class="{ active: current?.id === p.id }"
          data-testid="project-row"
        >
          <div class="row-main">
            <span class="row-name" :title="p.name">
              {{ p.name }}
              <span
                v-if="p.kind === 'classic'"
                class="badge"
                data-testid="project-classic"
                :title="t('timelineProjects.classicTitle')"
                >{{ t('timelineProjects.classic') }}</span
              >
            </span>
            <small class="row-meta">
              {{ formatDate(p.updatedAt) }} ·
              {{ t('projects.videos', { n: p.videoCount }, p.videoCount) }} ·
              {{ formatSize(p.size) }}
            </small>
          </div>
          <form
            v-if="editing?.id === p.id"
            class="rename"
            data-testid="project-rename-form"
            @submit.prevent="doRename"
          >
            <input
              ref="renameInput"
              v-model="editing.name"
              class="input"
              type="text"
              maxlength="120"
              :aria-label="t('timelineProjects.renameLabel')"
              :disabled="locked"
              data-testid="project-rename-input"
              @keydown.esc.stop.prevent="editing = null"
            />
            <button
              class="btn tiny primary"
              type="submit"
              :disabled="!canRename"
              data-testid="project-rename-save"
            >
              {{ t('timelineProjects.renameSave') }}
            </button>
            <button class="btn tiny ghost" type="button" @click="editing = null">
              {{ t('projects.cancel') }}
            </button>
          </form>
          <div v-else-if="confirm?.id === p.id" class="confirm" role="group">
            <span class="confirm-text">
              {{
                confirm.action === 'open' ? t('projects.confirmOpen') : t('projects.confirmDelete')
              }}
            </span>
            <button
              class="btn tiny"
              :class="confirm.action === 'delete' ? 'danger' : 'primary'"
              type="button"
              :disabled="locked"
              data-testid="project-confirm"
              @click="confirm.action === 'open' ? doOpen(p.id) : doDelete(p.id)"
            >
              {{ confirm.action === 'open' ? t('projects.open') : t('projects.delete') }}
            </button>
            <button class="btn tiny ghost" type="button" @click="confirm = null">
              {{ t('projects.cancel') }}
            </button>
          </div>
          <div v-else class="row-actions">
            <button
              class="btn tiny"
              type="button"
              :disabled="locked"
              data-testid="project-open"
              @click="askOpen(p.id)"
            >
              {{ t('projects.open') }}
            </button>
            <button
              class="btn tiny ghost"
              type="button"
              :disabled="locked"
              :title="t('timelineProjects.rename')"
              :aria-label="t('timelineProjects.renameNamed', { name: p.name })"
              data-testid="project-rename"
              @click="startRename(p.id, p.name)"
            >
              ✎
            </button>
            <button
              v-if="p.kind === 'timeline'"
              class="btn tiny ghost danger"
              type="button"
              :disabled="locked"
              :title="t('projects.delete')"
              :aria-label="t('projects.delete')"
              data-testid="project-delete"
              @click="confirm = { id: p.id, action: 'delete' }"
            >
              🗑
            </button>
          </div>
        </li>
      </ul>
      <p v-else-if="loaded" class="hint">{{ t('projects.none') }}</p>

      <p class="hint">{{ t('timelineProjects.hint') }}</p>
    </div>
  </dialog>
</template>

<style scoped>
.projects {
  /* Globales Reset setzt margin: 0 – zentrieren wie der Browser-Standard. */
  margin: auto;
  padding: 0;
  border: 1px solid var(--ds-border-strong);
  border-radius: var(--ds-radius-lg);
  background: var(--ds-surface-1);
  color: var(--ds-text);
  box-shadow: var(--ds-shadow-overlay);
  width: min(520px, calc(100vw - 32px));
  max-height: calc(100dvh - 32px);
}
.projects::backdrop {
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
.list-title {
  margin: 0;
  font-size: var(--ds-text-sm);
  color: var(--ds-text-2);
}
.save {
  display: flex;
  flex-direction: column;
  gap: var(--ds-space-2);
}
.auto {
  display: flex;
  align-items: flex-start;
  gap: var(--ds-space-2);
  font-size: var(--ds-text-sm);
}
.auto small {
  display: block;
  color: var(--ds-text-2);
  font-size: var(--ds-text-xs);
}
.field-label {
  font-size: var(--ds-text-sm);
  color: var(--ds-text-2);
}
.input {
  min-width: 0;
  height: var(--ds-control-sm);
  padding: 0 var(--ds-space-2);
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  background: var(--ds-surface-2);
  color: var(--ds-text);
  font: inherit;
  font-size: var(--ds-text-sm);
}
.input:focus-visible {
  outline: none;
  border-color: var(--ds-accent);
  box-shadow: var(--ds-focus-ring);
}
.save-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ds-space-2);
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
.btn.danger,
.btn.ghost.danger {
  color: var(--ds-danger);
}
.btn.danger:not(.ghost) {
  border-color: var(--ds-danger);
}
.btn.tiny {
  padding: 4px 8px;
  font-size: var(--ds-text-xs);
}
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.btn:focus-visible {
  outline: none;
  box-shadow: var(--ds-focus-ring);
}
.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--ds-space-2);
  max-height: min(320px, 40dvh);
  overflow-y: auto;
}
.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
  padding: var(--ds-space-2);
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-sm);
  background: var(--ds-surface-0);
}
.row.active {
  border-color: var(--ds-accent);
}
.row-main {
  flex: 1 1 140px;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.row-name {
  font-size: var(--ds-text-sm);
  font-weight: var(--ds-weight-semibold);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.badge {
  margin-left: var(--ds-space-2);
  padding: 1px 6px;
  border: 1px solid var(--ds-border-strong);
  border-radius: var(--ds-radius-full);
  color: var(--ds-text-2);
  font-size: var(--ds-text-xs);
  font-weight: var(--ds-weight-regular, 400);
}
.row-meta {
  font-size: var(--ds-text-xs);
  color: var(--ds-text-2);
}
.row-actions,
.confirm {
  display: flex;
  align-items: center;
  gap: 6px;
}
.confirm {
  flex-wrap: wrap;
  flex-basis: 100%;
}
.rename {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-basis: 100%;
}
.rename .input {
  flex: 1;
  min-width: 0;
}
.confirm-text {
  flex-basis: 100%;
  font-size: var(--ds-text-xs);
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
  color: var(--ds-success, var(--ds-text));
}
.status {
  display: flex;
  align-items: center;
  gap: 6px;
}
.spinner {
  width: 12px;
  height: 12px;
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
</style>
