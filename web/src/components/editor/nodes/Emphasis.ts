import Italic from '@tiptap/extension-italic'

/**
 * Italic written back with `*`, not `_`.
 *
 * The default serializer emits `_text_`, so opening any document and saving
 * it rewrote every `*emphasis*` in the file. Nothing rendered differently,
 * which is exactly what made it worth fixing: a diff that touches every
 * italic in a page, says nothing, and buries the one line somebody actually
 * changed.
 *
 * `*` because that is what the stored documents already use, and because it
 * matches the `**` used for bold, so the two read as a pair.
 */
export const Emphasis = Italic.extend({
  addStorage() {
    return {
      markdown: {
        serialize: {
          open: '*',
          close: '*',
          mixable: true,
          expelEnclosingWhitespace: true,
        },
        parse: {
          // handled by markdown-it
        },
      },
    }
  },
})
