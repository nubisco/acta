import type { MarkdownStorage } from 'tiptap-markdown'

/**
 * Tiptap 3 types `editor.storage` as an interface each extension adds its own
 * key to. tiptap-markdown does not add its key, so this does, and
 * `editor.storage.markdown.getMarkdown()` type-checks without a cast.
 */
declare module '@tiptap/core' {
  // Tiptap's own interface name, merged into, so the I prefix cannot apply.
  // eslint-disable-next-line @typescript-eslint/naming-convention
  interface Storage {
    markdown: MarkdownStorage
  }
}
