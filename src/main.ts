import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from '@/App.vue'
import { i18n } from '@/i18n'
import '@/style.css'

// Anfangssprache aus der globalen Navigation übernehmen (localStorage 'locale').
const storedLocale = localStorage.getItem('locale')
if (storedLocale === 'de' || storedLocale === 'en') {
  i18n.global.locale.value = storedLocale
}

createApp(App).use(createPinia()).use(i18n).mount('#app')
