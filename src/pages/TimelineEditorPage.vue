<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import ExportDialog from '@/components/timeline/ExportDialog.vue'
import MediaPool from '@/components/timeline/MediaPool.vue'
import PreviewPlayer from '@/components/timeline/PreviewPlayer.vue'
import ProjectSettings from '@/components/timeline/ProjectSettings.vue'
import GraphicInspector from '@/components/timeline/GraphicInspector.vue'
import TextInspector from '@/components/timeline/TextInspector.vue'
import TimelineView from '@/components/timeline/TimelineView.vue'

import { useSiteNavOffset } from '@/composables/useSiteNavOffset'
import { useTimelineStore } from '@/stores/timeline'

const { t } = useI18n()
const store = useTimelineStore()
const exporting = ref(false)

// Höhe der fixierten Website-Navigation -> --site-nav-offset (fixierter Arbeitsbereich).
useSiteNavOffset()

function openExport(): void {
  store.playing = false
  exporting.value = true
}
</script>

<template>
  <div class="editor" data-testid="timeline-editor">
    <header class="editor-head">
      <h2>{{ t('timelineEditor.title') }}</h2>
      <span class="head-actions">
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
        <TextInspector />
        <GraphicInspector />
      </div>
      <div class="stage">
        <PreviewPlayer />
        <TimelineView />
      </div>
    </div>
    <ExportDialog v-if="exporting" @close="exporting = false" />
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
   Seitenleiste (Medien, Einstellungen) scrollt für sich. Vorschau und Spuren
   sind in der Höhe so begrenzt, dass beides zusammen ins Fenster passt. */
@media (min-width: 1100px) and (min-height: 640px) {
  .stage,
  .side {
    position: sticky;
    top: calc(var(--site-nav-offset, 0px) + var(--ds-space-3));
  }
  .side {
    max-height: calc(100dvh - var(--site-nav-offset, 0px) - 2 * var(--ds-space-3));
    padding-right: var(--ds-space-1, 4px);
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-gutter: stable;
  }
  .stage {
    /* Freie Höhe ohne Bedienleisten, Ränder und Abstände (zusammen rund 230 px). */
    --stage-free: calc(100dvh - var(--site-nav-offset, 0px) - 230px);
  }
  .stage :deep(.screen) {
    max-height: max(180px, calc(var(--stage-free) * 0.6));
  }
  .stage :deep(.scroller) {
    max-height: max(140px, calc(var(--stage-free) * 0.4));
    overflow-y: auto;
  }
}
</style>
