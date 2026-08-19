import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import pluginVue from 'eslint-plugin-vue'
import configPrettier from 'eslint-config-prettier'

// Flat-Config (ESLint 9). Deckt Frontend (src/, .vue) und Backend (server/src) ab.
// Formatierung übernimmt Prettier – eslint-config-prettier schaltet daher alle
// stilistischen Regeln ab, damit sich beide nicht in die Quere kommen.
export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '**/*.d.ts', 'vite.config.js'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/recommended'],
  {
    // In .vue-SFCs den TypeScript-Parser für <script lang="ts"> nutzen.
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
      },
    },
  },
  {
    rules: {
      // TypeScript prüft undefinierte Bezeichner bereits (empfohlen: aus).
      'no-undef': 'off',
      // Mit `_` präfixierte Argumente/Variablen bewusst ungenutzt (z. B. Express-Handler).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // Interne App-Komponentennamen dürfen einwortig sein (Timeline, App …).
      'vue/multi-word-component-names': 'off',
    },
  },
  {
    // vitest/config wird idiomatisch per Triple-Slash-Referenz typisiert.
    files: ['vite.config.ts', 'vitest.config.ts', '**/vitest.config.ts'],
    rules: {
      '@typescript-eslint/triple-slash-reference': 'off',
    },
  },
  configPrettier,
)
