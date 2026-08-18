<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import VideoTrimmer from '@/components/VideoTrimmer.vue'
import type { AppLocale } from '@/i18n'

const { t, locale } = useI18n()
const isDark = ref(true)

function applyTheme(): void {
  document.documentElement.dataset.theme = isDark.value ? 'dark' : 'light'
}
function toggleTheme(): void {
  isDark.value = !isDark.value
  applyTheme()
}
function toggleLocale(): void {
  locale.value = (locale.value === 'de' ? 'en' : 'de') satisfies AppLocale
}

onMounted(applyTheme)
</script>

<template>
  <div class="shell">
    <header class="topbar">
      <div class="brand">
        <span class="logo" aria-hidden="true">✂</span>
        <div>
          <h1>{{ t('app.title') }}</h1>
          <p>{{ t('app.subtitle') }}</p>
        </div>
      </div>
      <div class="controls">
        <button class="chip" type="button" @click="toggleLocale">{{ locale === 'de' ? 'EN' : 'DE' }}</button>
        <button class="chip" type="button" :aria-label="'Theme'" @click="toggleTheme">
          {{ isDark ? '☀' : '☾' }}
        </button>
      </div>
    </header>

    <main class="content">
      <VideoTrimmer />
    </main>

    <footer class="footer">{{ t('footer') }}</footer>
  </div>
</template>

<style scoped>
.shell {
  max-width: 820px;
  margin: 0 auto;
  padding: 24px 20px 40px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.brand { display: flex; align-items: center; gap: 12px; }
.logo {
  width: 40px; height: 40px;
  display: grid; place-items: center;
  border-radius: 10px;
  background: var(--vc-accent);
  color: #fff; font-size: 20px;
}
.brand h1 { margin: 0; font-size: 20px; }
.brand p { margin: 2px 0 0; font-size: 13px; color: var(--vc-text-dim); }
.controls { display: flex; gap: 8px; }
.chip {
  min-width: 40px;
  padding: 8px 10px;
  border: 1px solid var(--vc-border);
  border-radius: 8px;
  background: var(--vc-surface);
  color: var(--vc-text);
  cursor: pointer;
  font-size: 14px;
}
.chip:hover { border-color: var(--vc-accent); }
.chip:focus-visible { outline: 2px solid var(--vc-focus); outline-offset: 2px; }
.footer { font-size: 12px; color: var(--vc-text-dim); text-align: center; }
</style>
