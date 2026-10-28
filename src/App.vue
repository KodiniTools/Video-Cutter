<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import VideoTrimmer from '@/components/VideoTrimmer.vue'
import { useSettingsStore } from '@/stores/settings'

// Settings-Store früh initialisieren: Theme-Watcher und Listener der globalen
// Navigation (localStorage 'theme'/'locale', 'locale-changed') sind ab App-Start aktiv.
useSettingsStore()

const { t } = useI18n()
</script>

<template>
  <div class="shell">
    <header class="topbar">
      <div class="brand">
        <span class="logo" aria-hidden="true">✂</span>
        <div>
          <h1 data-slot="app.title">{{ t('app.title') }}</h1>
          <p data-slot="app.subtitle">{{ t('app.subtitle') }}</p>
        </div>
      </div>
    </header>

    <main class="content">
      <VideoTrimmer />
    </main>

    <footer class="footer" data-slot="footer">{{ t('footer') }}</footer>
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
</style>
