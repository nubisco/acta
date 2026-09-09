// vitest's defineConfig, not vite's: the `test` block below is vitest's and
// vite's own typing does not know about it.
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { fonts } from '@nubisco/ui/plugins/fonts'
import { nubiscoUI } from '@nubisco/ui/vite'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  // @nubisco/ui 4.0.0 resolves components and glyphs at compile time instead
  // of registering all 86 components in the app plugin. nubiscoUI() replaces
  // the old `icons()` virtual-module plugin and brings each component's own
  // stylesheet with it, which is why main.ts no longer imports the whole
  // sheet.
  //
  // `catalog: 'off'` because src/lib/icons.ts declares every name we resolve
  // at runtime. Left on 'auto' the plugin cannot see that registration and
  // injects the whole 1,500-icon catalogue into each file that computes a
  // name, which is the payload this release exists to avoid. The trade is
  // that a name we forget to register raises at first render; that error
  // names the icon, and the fix is one line in lib/icons.ts.
  plugins: [vue(), fonts(), ...nubiscoUI({ glyphs: { catalog: 'off' } })],
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
  test: {
    // jsdom rather than happy-dom: the components under test lean on layout
    // and pointer APIs that happy-dom fakes less completely, and a test that
    // passes because the environment shrugged is worse than no test.
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.ts'],
  },
})
