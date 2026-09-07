import type { InjectionKey } from 'vue'

/**
 * Overrides what a doc ref click does inside MarkdownView. The docs space
 * provides real navigation (it IS the destination); everywhere else the
 * absence of a provider means "open the quick-look modal".
 */
export const DOC_NAV_KEY: InjectionKey<(slug: string) => void> =
  Symbol('doc-nav')
