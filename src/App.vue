<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { useFullscreen } from '@/composables/useFullscreen'
import { useSettingsStore } from '@/stores/settings'

// Settings-Store früh initialisieren: Theme-Watcher und Listener der globalen
// Navigation (localStorage 'theme'/'locale', 'locale-changed') sind ab App-Start aktiv.
useSettingsStore()

const { t } = useI18n()
const route = useRoute()

// Vollbild für die ganze App (Kopfzeile + Editor); Esc oder der Knopf beenden es.
const shell = ref<HTMLElement | null>(null)
const {
  supported: fullscreenSupported,
  active: isFullscreen,
  toggle: toggleFullscreen,
} = useFullscreen(shell)
</script>

<template>
  <div ref="shell" class="shell" :class="{ 'is-fullscreen': isFullscreen }">
    <header class="topbar">
      <div class="brand">
        <span class="logo" aria-hidden="true">✂</span>
        <div>
          <h1 data-slot="app.title">{{ t('app.title') }}</h1>
          <p data-slot="app.subtitle">{{ t('app.subtitle') }}</p>
        </div>
      </div>
      <span class="top-actions">
        <RouterLink
          v-if="route.name === 'classic'"
          class="beta-link"
          :to="{ name: 'timeline' }"
          data-testid="open-timeline-editor"
        >
          {{ t('timelineEditor.open') }}
        </RouterLink>
        <button
          v-if="fullscreenSupported"
          type="button"
          class="beta-link fullscreen-btn"
          data-testid="toggle-fullscreen"
          :aria-pressed="isFullscreen"
          :title="isFullscreen ? t('fullscreen.exitTitle') : t('fullscreen.enterTitle')"
          @click="toggleFullscreen"
        >
          <span aria-hidden="true">⛶</span>
          {{ isFullscreen ? t('fullscreen.exit') : t('fullscreen.enter') }}
        </button>
      </span>
    </header>

    <main class="content">
      <RouterView />
    </main>

    <footer v-if="!isFullscreen" class="footer" data-slot="footer">{{ t('footer') }}</footer>
  </div>
</template>

<style scoped>
.shell {
  max-width: var(--ds-container);
  margin: 0 auto;
  padding: var(--ds-space-6) var(--ds-space-5) var(--ds-space-10);
  display: flex;
  flex-direction: column;
  gap: var(--ds-gap);
}
/* Große Bildschirme: mehr Breite für das dreispaltige Editor-Layout
   (Meine Videos | Video | Auswahl), damit das Video in der Mitte groß bleibt. */
@media (min-width: 1100px) {
  .shell {
    max-width: 1600px;
  }
}
/* Vollbild: die ganze Bildschirmfläche nutzen. Die Website-Navigation liegt
   außerhalb und ist nicht zu sehen, also klebt der Arbeitsbereich ganz oben
   (--site-nav-offset 0). Das Vollbild-Element ist selbst der Scroll-Container. */
.shell.is-fullscreen,
.shell:fullscreen {
  --site-nav-offset: 0px;
  max-width: none;
  margin: 0;
  padding: var(--ds-space-3) var(--ds-space-5) var(--ds-space-4);
  overflow-y: auto;
  background: var(--ds-surface-0);
  color: var(--ds-text);
}
.shell::backdrop {
  background: var(--ds-surface-0);
}
.top-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  align-items: center;
  gap: var(--ds-space-3);
}
.fullscreen-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--ds-space-2);
}
.fullscreen-btn:focus-visible {
  outline: none;
  box-shadow: var(--ds-focus-ring);
}
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--ds-space-4);
}
.brand {
  display: flex;
  align-items: center;
  gap: var(--ds-space-3);
}
.logo {
  width: var(--ds-control-lg);
  height: var(--ds-control-lg);
  display: grid;
  place-items: center;
  border-radius: var(--ds-radius-md);
  background: var(--ds-accent);
  color: var(--ds-on-accent);
  font-size: var(--ds-text-xl);
}
.brand h1 {
  margin: 0;
  font-size: var(--ds-text-xl);
  font-weight: var(--ds-weight-bold);
  line-height: var(--ds-leading-tight);
  letter-spacing: var(--ds-tracking-tight);
}
.brand p {
  margin: 2px 0 0;
  font-size: var(--ds-text-sm);
  color: var(--ds-text-2);
}
.footer {
  font-size: var(--ds-text-xs);
  color: var(--ds-text-3);
  text-align: center;
}
.beta-link {
  padding: var(--ds-space-2) var(--ds-space-3);
  border: 1px solid var(--ds-border);
  border-radius: var(--ds-radius-md);
  background: transparent;
  color: var(--ds-link);
  font: inherit;
  font-size: var(--ds-text-sm);
  cursor: pointer;
  white-space: nowrap;
  text-decoration: none;
}
.beta-link:hover {
  border-color: var(--ds-link);
}
</style>
