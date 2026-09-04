import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fonts } from '@nubisco/ui/plugins/fonts'
import { icons } from '@nubisco/ui/plugins/icons'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  plugins: [vue(), fonts(), icons()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  css: {
    preprocessorOptions: {
      scss: {
        additionalData: `@use '@nubisco/ui/variables';`,
      },
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:4460',
      '/mcp': 'http://localhost:4460',
    },
  },
})
