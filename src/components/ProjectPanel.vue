<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { storeToRefs } from 'pinia'
import { PROJECT_EMPTY, PROJECT_UPLOADS_PENDING, useProjectStore } from '@/stores/projects'
import { useLibraryStore } from '@/stores/library'
import { PROJECTS_UNSUPPORTED } from '@/lib/projectApi'
import { MEDIA_UNSUPPORTED } from '@/lib/mediaApi'

/**
 * Karte „Projekte": aktuellen Bearbeitungsstand unter einem Namen auf dem
 * Server speichern, gespeicherte Projekte öffnen (ersetzt die aktuelle
 * Bearbeitung) oder löschen.
 */
const props = defineProps<{
  /** Ein Job läuft – Speichern/Öffnen sperren. */
  disabled: boolean
}>()

const { t, locale } = useI18n()
const store = useProjectStore()
const library = useLibraryStore()
// Meldungen im Store: Die Karte wird beim Öffnen (Startseite -> Editor) neu erzeugt.
const { projects, loaded, current, busy, progress, error, notice } = storeToRefs(store)

const name = ref('')
/** Inline-Bestätigung: Projekt-ID + Aktion. */
const confirm = ref<{ id: string; action: 'open' | 'delete' } | null>(null)

const hasItems = computed(() => library.items.length > 0)
const locked = computed(() => props.disabled || busy.value !== null)
const canSave = computed(() => hasItems.value && !locked.value && name.value.trim().length > 0)

/** Vorschlag: aktueller Projektname, sonst Name des ersten Videos ohne Endung. */
function suggestName(): string {
  if (current.value) return current.value.name
  const first = library.items[0]?.name ?? ''
  return first.replace(/\.[^.]+$/, '')
}

// Projekt geöffnet/gespeichert -> dessen Name; sonst Vorschlag aus dem ersten Video.
watch(
  () => current.value?.id ?? null,
  () => (name.value = suggestName()),
  { immediate: true },
)
watch(
  () => library.items[0]?.name ?? '',
  () => {
    if (!current.value && !name.value.trim()) name.value = suggestName()
  },
  { immediate: true },
)

function messageOf(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  const map: Record<string, string> = {
    [PROJECTS_UNSUPPORTED]: 'projects.outdated',
    [MEDIA_UNSUPPORTED]: 'errors.mediaUnsupported',
    [PROJECT_UPLOADS_PENDING]: 'projects.uploadsPending',
    [PROJECT_EMPTY]: 'projects.empty',
  }
  return map[msg] ? t(map[msg]) : msg
}

async function load(): Promise<void> {
  try {
    await store.refresh()
  } catch (e) {
    error.value = messageOf(e)
  }
}

onMounted(() => {
  if (!loaded.value) void load()
})

async function onSave(asNew: boolean): Promise<void> {
  error.value = ''
  notice.value = ''
  try {
    const p = await store.save(name.value.trim(), asNew)
    name.value = p.name
    notice.value = t('projects.saved', { name: p.name })
  } catch (e) {
    error.value = messageOf(e)
  }
}

function askOpen(id: string): void {
  error.value = ''
  notice.value = ''
  // Ohne laufende Bearbeitung direkt öffnen.
  if (!hasItems.value) void doOpen(id)
  else confirm.value = { id, action: 'open' }
}

async function doOpen(id: string): Promise<void> {
  confirm.value = null
  error.value = ''
  notice.value = ''
  try {
    const r = await store.open(id)
    notice.value = r.missing
      ? t('projects.openedMissing', { n: r.missing })
      : t('projects.opened', { name: current.value?.name ?? '' })
  } catch (e) {
    error.value = messageOf(e)
  }
}

async function doDelete(id: string): Promise<void> {
  confirm.value = null
  error.value = ''
  notice.value = ''
  try {
    await store.remove(id)
  } catch (e) {
    error.value = messageOf(e)
  }
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
  <section class="card projects" data-test="project-panel">
    <div class="card-head">
      <h3 class="panel-title">{{ t('projects.title') }}</h3>
      <span v-if="projects.length" class="count">{{ projects.length }}</span>
    </div>

    <form v-if="hasItems" class="save" @submit.prevent="onSave(false)">
      <label for="project-name" class="field-label">{{ t('projects.name') }}</label>
      <input
        id="project-name"
        v-model="name"
        class="input"
        type="text"
        maxlength="120"
        :disabled="locked"
        data-test="project-name"
      />
      <div class="save-actions">
        <button class="btn primary" type="submit" :disabled="!canSave" data-test="project-save">
          💾 {{ current ? t('projects.save') : t('projects.saveNew') }}
        </button>
        <button
          v-if="current"
          class="btn ghost"
          type="button"
          :disabled="!canSave"
          :title="t('projects.saveAsHint')"
          @click="onSave(true)"
        >
          {{ t('projects.saveAs') }}
        </button>
      </div>
      <p v-if="current" class="hint">
        {{ t('projects.currentInfo', { name: current.name, time: formatDate(current.savedAt) }) }}
      </p>
    </form>

    <p v-if="progress" class="hint status" role="status">
      <span class="spinner" aria-hidden="true" />
      {{ t(progress.key, progress.params ?? {}) }}
    </p>
    <p v-if="error" class="hint warn" role="alert">{{ error }}</p>
    <p v-else-if="notice" class="hint ok" role="status">{{ notice }}</p>

    <ul v-if="projects.length" class="list">
      <li
        v-for="p in projects"
        :key="p.id"
        class="row"
        :class="{ active: current?.id === p.id }"
        :data-test="`project-${p.id}`"
      >
        <div class="row-main">
          <span class="row-name" :title="p.name">{{ p.name }}</span>
          <small class="row-meta">
            {{ formatDate(p.updatedAt) }} ·
            {{ t('projects.videos', { n: p.videoCount }, p.videoCount) }} ·
            {{ formatSize(p.size) }}
          </small>
        </div>
        <div v-if="confirm?.id === p.id" class="confirm" role="group">
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
            data-test="project-confirm"
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
            data-test="project-open"
            @click="askOpen(p.id)"
          >
            {{ t('projects.open') }}
          </button>
          <button
            class="btn tiny ghost danger"
            type="button"
            :disabled="locked"
            :title="t('projects.delete')"
            :aria-label="t('projects.delete')"
            @click="confirm = { id: p.id, action: 'delete' }"
          >
            🗑
          </button>
        </div>
      </li>
    </ul>
    <p v-else-if="loaded" class="hint">{{ t('projects.none') }}</p>

    <p class="hint">{{ t('projects.hint') }}</p>
  </section>
</template>

<style scoped>
.card {
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  padding: 12px;
  background: var(--ds-surface-1);
}
.projects {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
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
.count {
  display: inline-grid;
  place-items: center;
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border-radius: var(--ds-radius-full);
  background: var(--ds-accent);
  color: var(--ds-on-accent);
  font-size: var(--ds-text-xs);
  font-weight: var(--ds-weight-semibold);
  font-variant-numeric: tabular-nums;
}
.save {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.field-label {
  font-size: var(--ds-text-sm);
  color: var(--ds-text-2);
}
.input {
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
.save-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.save-actions .btn.primary {
  flex: 1;
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
  gap: 6px;
  max-height: 320px;
  overflow-y: auto;
}
.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
  padding: 8px;
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
