import type { StarterKitOptions } from '@tiptap/starter-kit'

/**
 * What StarterKit 3 bundles that StarterKit 2 did not, switched off.
 *
 * Tiptap 3 folded four extensions into the kit. Each one changes what the
 * editor does or writes, and none of them was asked for here:
 *
 * - `link`: the editor registers its own Link (with `openOnClick: false`), so
 *   the kit's copy would be a second extension of the same name
 * - `underline`: markdown has no underline, so Ctrl+U would make a mark the
 *   serializer can only write back as HTML
 * - `listKeymap`: changes what Backspace and Delete do at the edge of a list
 *   item
 * - `trailingNode`: appends an empty paragraph after a final table, code
 *   block or callout, which is a document change nobody made
 *
 * Spread into every StarterKit.configure() that has to match the editor's
 * schema: the editor, the import normalizer and the tests that stand in for
 * them.
 */
export const STARTER_KIT_PARITY = {
  link: false,
  underline: false,
  listKeymap: false,
  trailingNode: false,
} as const satisfies Partial<StarterKitOptions>
