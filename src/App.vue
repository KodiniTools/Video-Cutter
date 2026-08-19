<script setup lang="ts">
import { onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import VideoTrimmer from '@/components/VideoTrimmer.vue'
import type { AppLocale } from '@/i18n'

const { t, locale } = useI18n()

// Sprache mit der globalen Navigation synchron halten (Theme + Sprache steuert
// die Nav via localStorage 'theme'/'locale' und dem 'locale-changed'-Event).
function onLocaleChanged(e: Event): void {
  const detail = (e as CustomEvent<{ locale?: string }>).detail
  const l = detail?.locale
  if (l === 'de' || l === 'en') locale.value = l satisfies AppLocale
}

onMounted(() => {
  const stored = localStorage.getItem('locale')
  if (stored === 'de' || stored === 'en') locale.value = stored satisfies AppLocale
  window.addEventListener('locale-changed', onLocaleChanged)
})
onBeforeUnmount(() => window.removeEventListener('locale-changed', onLocaleChanged))
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
.footer { font-size: 12px; color: var(--vc-text-dim); text-align: center; }
</style>
