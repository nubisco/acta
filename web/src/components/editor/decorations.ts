import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'
import { isDarkColor, parseColor } from '@/components/decorations/colors'

/**
 * Colour swatches while editing.
 *
 * The reader hydrates these by walking its own HTML and prepending a dot. The
 * editor cannot: ProseMirror owns its DOM and reconciles away anything written
 * into it behind its back, and a node inserted into the document would be text
 * the author never typed and the serializer would write to the file.
 *
 * A decoration is neither. It is presentation attached to a range, it never
 * reaches the document or the markdown, and it is recomputed from the document
 * on every change, so a swatch follows the value as somebody edits it.
 *
 * Deliberately the same class names and the same `parseColor` the reader uses,
 * so the two surfaces cannot drift apart. See styles/decorations.scss.
 */

const key = new PluginKey('acta-color-swatches')

/** The dot, built the same way the reader builds it. */
function swatch(color: string): HTMLElement {
  const dot = document.createElement('span')
  dot.className = 'md__color-dot'
  dot.setAttribute('aria-hidden', 'true')
  dot.style.background = color
  if (isDarkColor(color) === false) dot.classList.add('md__color-dot--light')
  return dot
}

function build(doc: PMNode): DecorationSet {
  const found: Decoration[] = []
  doc.descendants((node, pos) => {
    if (!node.isText) return
    // Only inside a code span. The detection is strict for the same reason it
    // is in the reader: this sees every code span in the document, and
    // `#include` must not sprout a swatch.
    if (!node.marks.some((mark) => mark.type.name === 'code')) return
    const color = parseColor(node.text ?? '')
    if (!color) return
    found.push(
      Decoration.inline(pos, pos + node.nodeSize, { class: 'md__color' }),
      // `side: -1` puts the dot before the text rather than after it, and
      // matches the reader, which prepends. `marks` puts it inside the code
      // span, where the reader has it, so it is sized against the code's font
      // rather than the paragraph's.
      Decoration.widget(pos, () => swatch(color), {
        side: -1,
        marks: node.marks,
      }),
    )
  })
  return DecorationSet.create(doc, found)
}

export const ColorSwatches = Extension.create({
  name: 'colorSwatches',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key,
        state: {
          init: (_config, state) => build(state.doc),
          // Rebuilt only when the text actually changed. Moving the caret
          // through a document full of swatches should not rebuild them.
          apply: (tr, previous) => (tr.docChanged ? build(tr.doc) : previous),
        },
        props: {
          decorations: (state: EditorState) => key.getState(state),
        },
      }),
    ]
  },
})
