import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from '@/App.vue'
import { i18n } from '@/i18n'
import { applySiteTheme } from '@/content/site'
import '@/style.css'

// Farben aus dem Kodini Designer (src/content/site.json) als Overrides der
// Design-Tokens anwenden – nach style.css, damit sie gewinnen.
applySiteTheme(document)

// Theme/Sprache übernimmt der Settings-Store (App.vue) aus localStorage und
// der globalen Navigation.
createApp(App).use(createPinia()).use(i18n).mount('#app')
