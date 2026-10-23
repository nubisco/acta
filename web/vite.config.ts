// vitest's defineConfig, not vite's: the `test` block below is vitest's and
// vite's own typing does not know about it.
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { fonts } from '@nubisco/ui/plugins/fonts'
import { nubiscoUI } from '@nubisco/ui/vite'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'

/**
 * Builds monaco-editor against the DOMPurify in our own dependencies.
 *
 * monaco does not import the dompurify package. It ships a vendored copy of it
 * at esm/vs/base/browser/dompurify/dompurify.js (3.4.8 in monaco 0.56.0, 3.4.15
 * in 0.57.0, both with known advisories), so the override in
 * pnpm-workspace.yaml quiets the audit without changing a byte of what ships.
 * This swaps the vendored file for the real package at build time. Both export
 * the same DOMPurify instance as their default, so monaco's only importer
 * (vs/base/browser/domSanitize.js) is unaffected.
 *
 * Drop it, together with the direct dompurify dependency and the override, once
 * monaco vendors a patched release: check the @license line of that file.
 */
function monacoUsesPatchedDompurify(): Plugin {
  const vendored =
    /[\\/]monaco-editor[\\/]esm[\\/]vs[\\/]base[\\/]browser[\\/]dompurify[\\/]dompurify\.js$/
  const self = fileURLToPath(import.meta.url)
  return {
    name: 'acta:monaco-patched-dompurify',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer || !source.endsWith('dompurify/dompurify.js')) return null
      const resolved = await this.resolve(source, importer, {
        ...options,
        skipSelf: true,
      })
      if (!resolved || !vendored.test(resolved.id)) return null
      return this.resolve('dompurify', self, { ...options, skipSelf: true })
    },
  }
}

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
  plugins: [
    vue(),
    fonts(),
    ...nubiscoUI({ glyphs: { catalog: 'off' } }),
    monacoUsesPatchedDompurify(),
  ],
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
    // Scoped styles are not applied under test by default, which means a rule
    // that never reaches an element looks exactly like one that does. That is
    // the bug the comment composer had for months: `class="thread__editor"`
    // on a multi-root component, silently dropped. Processing this one
    // component's CSS lets its test measure the box instead of trusting it.
    css: { include: [/CommentThread\.vue/] },
  },
})
