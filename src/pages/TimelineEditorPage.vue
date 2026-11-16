<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import MediaPool from '@/components/timeline/MediaPool.vue'
import TimelineView from '@/components/timeline/TimelineView.vue'

// Vorschau und Export folgen in den nächsten Phasen.
const { t } = useI18n()
</script>

<template>
  <div class="editor" data-testid="timeline-editor">
    <header class="editor-head">
      <h2>{{ t('timelineEditor.title') }}</h2>
      <RouterLink :to="{ name: 'classic' }">{{ t('timelineEditor.back') }}</RouterLink>
    </header>
    <div class="layout">
      <MediaPool class="side" />
      <section class="stage">
        <p>{{ t('timelineEditor.placeholder') }}</p>
      </section>
    </div>
    <TimelineView />
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
.layout {
  display: grid;
  grid-template-columns: minmax(280px, 360px) 1fr;
  gap: var(--ds-gap);
  align-items: start;
}
.stage {
  min-height: 240px;
  padding: var(--ds-space-6);
  border: 1px dashed var(--ds-border);
  border-radius: var(--ds-radius-lg);
  color: var(--ds-text-2);
}
.stage p {
  margin: 0;
}
</style>
