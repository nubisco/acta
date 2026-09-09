/**
 * Shared test environment.
 *
 * Two things every component here needs, both of which are supplied by
 * main.ts in the real app and would otherwise fail at mount rather than at
 * the assertion, which makes for confusing failures:
 *
 *  - vue-i18n, because several @nubisco/ui components call `t()` during setup
 *    and throw NOT_INSTALLED without a plugin.
 *  - the icon catalogue, because the bundler plugin resolves glyphs from
 *    literals at build time but a runtime-named icon has nothing to resolve
 *    against under test. The catalogue costs nothing here: test bundles are
 *    never shipped.
 */
import { config } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import NubiscoUI from '@nubisco/ui'
import '@nubisco/ui/icons/all'
import { vi } from 'vitest'

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  fallbackLocale: 'en',
  messages: { en: {} },
  missingWarn: false,
  fallbackWarn: false,
})

config.global.plugins = [NubiscoUI as never, i18n as never]

// jsdom has no layout engine, so anything measuring an element gets zeros and
// some components guard on that. These are the two that components in this
// app actually call.
Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
  get: () => document.body,
})
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: () => false,
  })) as never
}
