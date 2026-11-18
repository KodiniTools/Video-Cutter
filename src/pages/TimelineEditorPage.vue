<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AiInspector from '@/components/timeline/AiInspector.vue'
import ClipInspector from '@/components/timeline/ClipInspector.vue'
import ExportDialog from '@/components/timeline/ExportDialog.vue'
import MediaPool from '@/components/timeline/MediaPool.vue'
import PreviewPlayer from '@/components/timeline/PreviewPlayer.vue'
import ProjectDialog from '@/components/timeline/ProjectDialog.vue'
import ProjectSettings from '@/components/timeline/ProjectSettings.vue'
import GraphicInspector from '@/components/timeline/GraphicInspector.vue'
import TextInspector from '@/components/timeline/TextInspector.vue'
import TimelineView from '@/components/timeline/TimelineView.vue'

import { useSiteNavOffset } from '@/composables/useSiteNavOffset'
import { useTimelineStore } from '@/stores/timeline'
import { useTimelineProjectStore } from '@/stores/timelineProjects'

const { t } = useI18n()
const store = useTimelineStore()
const projects = useTimelineProjectStore()
const exporting = ref(false)
const projectsOpen = ref(false)

// Höhe der fixierten Website-Navigation -> --site-nav-offset (fixierter Arbeitsbereich).
useSiteNavOffset()

function openExport(): void {
  store.playing = false
  exporting.value = true
}

/** Hinweis am Projekt-Knopf: was mit den letzten Änderungen geschieht. */
const projectStatus = computed(() => {
  if (projects.autosaveState === 'error') return t('timelineProjects.statusError')
  if (projects.autosaveState === 'saving') return t('timelineProjects.statusSaving')
  if (projects.dirty) return t('timelineProjects.unsaved')
  return projects.current ? t('timelineProjects.statusSaved') : ''
})

// Ungespeicherte Änderungen: Der Browser fragt nach, bevor die Seite verschwindet.
function onBeforeUnload(event: BeforeUnloadEvent): void {
  if (!projects.dirty) return
  event.preventDefault()
  event.returnValue = ''
}
onMounted(() => window.addEventListener('beforeunload', onBeforeUnload))
onBeforeUnmount(() => window.removeEventListener('beforeunload', onBeforeUnload))

function openProjects(): void {
  store.playing = false
  projectsOpen.value = true
}
</script>

<template>
  <div class="editor" data-testid="timeline-editor">
    <header class="editor-head">
      <h2>{{ t('timelineEditor.title') }}</h2>
      <span class="head-actions">
        <button
          type="button"
          class="project-btn"
          data-testid="open-projects"
          :title="t('timelineProjects.openTitle')"
          @click="openProjects"
        >
          <span class="project-name">{{
            projects.current ? projects.current.name : t('timelineProjects.button')
          }}</span>
          <span
            v-if="projects.dirty || projects.autosaveState === 'error'"
            class="project-dirty"
            :class="{ failed: projects.autosaveState === 'error' }"
            data-testid="project-dirty"
            :title="projectStatus"
            >●</span
          >
          <span class="sr-only" role="status" data-testid="project-status">{{
            projectStatus
          }}</span>
        </button>
        <ProjectSettings />
        <RouterLink :to="{ name: 'classic' }">{{ t('timelineEditor.back') }}</RouterLink>
        <button
          type="button"
          class="export-btn"
          data-testid="open-export"
          :disabled="store.duration <= 0"
          :title="store.duration <= 0 ? t('timelineExport.empty') : undefined"
          @click="openExport"
        >
          {{ t('timelineExport.open') }}
        </button>
      </span>
    </header>
    <div class="layout">
      <div class="side">
        <MediaPool />
        <ClipInspector />
        <TextInspector />
        <GraphicInspector />
        <AiInspector />
      </div>
      <div class="stage">
        <PreviewPlayer />
        <TimelineView />
      </div>
    </div>
    <ExportDialog v-if="exporting" @close="exporting = false" />
    <ProjectDialog v-if="projectsOpen" @close="projectsOpen = false" />
  </div>
</template>

<style scoped>
.editor {
  display: flex;
  flex-direction: column;
  gap: var(--ds-space-4);
}
.editor-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--ds-space-4);
}
.editor-head h2 {
  margin: 0;
  font-size: var(--ds-text-xl);
}
.editor-head a {
  color: var(--ds-link);
  font-size: var(--ds-text-sm);
}
.head-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  align-items: center;
  gap: var(--ds-space-4);
}
.export-btn {
  height: var(--ds-control-sm);
  padding: 0 var(--ds-space-4);
  border: 1px solid var(--ds-accent);
  border-radius: var(--ds-radius-md);
  background: var(--ds-accent);
  color: var(--ds-on-accent);
  font-weight: var(--ds-weight-semibold);
  cursor: pointer;
}
.project-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--ds-space-2);
  max-width: 260px;
  height: var(--ds-control-sm);
  padding: 0 var(--ds-space-3);
  border: 1px solid var(--ds-border-strong);
  border-radius: var(--ds-radius-md);
  background: var(--ds-surface-2);
  color: var(--ds-text);
  font-size: var(--ds-text-sm);
  cursor: pointer;
}
.project-btn:hover {
  border-color: var(--ds-accent);
}
.project-btn:focus-visible {
  outline: none;
  box-shadow: var(--ds-focus-ring);
}
.project-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.project-dirty {
  color: var(--ds-accent);
  font-size: var(--ds-text-xs);
}
.project-dirty.failed {
  color: var(--ds-danger);
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.export-btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.export-btn:focus-visible {
  outline: none;
  box-shadow: var(--ds-focus-ring);
}
.side {
  display: flex;
  flex-direction: column;
  gap: var(--ds-gap);
  min-width: 0;
}
.layout {
  display: grid;
  grid-template-columns: minmax(280px, 360px) minmax(0, 1fr);
  gap: var(--ds-gap);
  align-items: start;
}
/* Vorschau und Timeline: gleich breit, direkt untereinander. */
.stage {
  display: flex;
  flex-direction: column;
  gap: var(--ds-space-3);
  min-width: 0;
}
/* Hoch und breit genug: Vorschau und Timeline bleiben beim Scrollen stehen –
   direkt unter der fixierten Website-Navigation (--site-nav-offset). Die
   Seitenleiste (Medien, Einstellungen) scrollt für sich, der Arbeitsbereich
   ebenfalls: Die Vorschau darf gut die Hälfte der Fensterhöhe füllen, und
   passt die Timeline mit vielen Spuren nicht mehr darunter, lässt sich der
   Arbeitsbereich nach unten scrollen. Sehr viele Spuren scrollen zusätzlich
   in der Spurliste (das Lineal bleibt oben stehen). */
@media (min-width: 1100px) and (min-height: 640px) {
  .stage,
  .side {
    position: sticky;
    top: calc(var(--site-nav-offset, 0px) + var(--ds-space-3));
    max-height: calc(100dvh - var(--site-nav-offset, 0px) - 2 * var(--ds-space-3));
    padding-right: var(--ds-space-1, 4px);
    overflow-y: auto;
    scrollbar-gutter: stable;
  }
  .side {
    overscroll-behavior: contain;
  }
  .stage {
    /* Sichtbare Höhe unter der Navigation. */
    --stage-room: calc(100dvh - var(--site-nav-offset, 0px));
  }
  .stage :deep(.screen) {
    max-height: max(220px, calc(var(--stage-room) * 0.56));
  }
  .stage :deep(.scroller) {
    max-height: max(180px, calc(var(--stage-room) * 0.5));
    overflow-y: auto;
  }
}
</style>
