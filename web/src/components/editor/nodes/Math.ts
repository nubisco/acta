import { Node, mergeAttributes, nodeInputRule } from '@tiptap/core'
import Text from '@tiptap/extension-text'
import { VueNodeViewRenderer } from '@tiptap/vue-3'
import type { MarkdownIt } from 'markdown-it'
import type { MarkdownSerializerState } from '@tiptap/pm/markdown'
import type { Node as PMNode } from '@tiptap/pm/model'
import { guardMathDelimiters, mathPlugin } from '@/lib/math'
import MathView from '@/components/decorations/MathView.vue'

/**
 * `$$ ... $$` and `$...$` as real nodes.
 *
 * The reader has rendered maths since this feature landed, and a construct the
 * reader renders but the editor's schema does not know is the exact shape of
 * the bug that deleted every table and then every image in this application:
 * a node the schema does not know is a node the serializer cannot write back,
 * so opening a document and saving it with no edit removes the formula from
 * the file. So the nodes land in the same change as the rendering, never after
 * it.
 *
 * ## How editing works
 *
 * Both nodes are atoms holding the LaTeX in an attribute, and the node view
 * shows the rendered formula when the node is not selected and an editable
 * field holding the source when it is. Clicking a formula selects it, which is
 * what reveals the source, and clicking away renders it again.
 *
 * That choice cannot lose content, and the reason is the attribute. The source
 * is never "the text currently visible in a box": it is a document attribute,
 * written on every keystroke through `updateAttributes`, serialized straight
 * back out between its delimiters. Hiding the field hides a view of the
 * attribute, it does not discard it. A formula that will not parse keeps its
 * attribute too, so a typo is something you can click into and fix rather than
 * something that disappears.
 */

const BLOCK = 'mathBlock'
const INLINE = 'mathInline'

/** Both nodes parse the elements `lib/math.ts` emits, and only those. */
function parse(attr: string) {
  return {
    latex: {
      default: '',
      parseHTML: (el: HTMLElement) =>
        el.getAttribute('data-math') ?? el.textContent ?? '',
      renderHTML: (attrs: Record<string, unknown>) => ({
        'data-math': String(attrs.latex ?? ''),
        [attr]: '1',
      }),
    },
  }
}

/**
 * tiptap-markdown builds its own markdown-it, so the plugin has to be handed
 * to it as well as to the reader's instance. Same plugin, so the editor and
 * the reader cannot disagree about what counts as a formula.
 */
const setup = {
  setup(markdownit: MarkdownIt) {
    mathPlugin(markdownit)
  },
}

export const MathBlock = Node.create({
  name: BLOCK,
  group: 'block',
  atom: true,
  draggable: true,
  // Above `paragraph`, which would otherwise claim the div as a text block.
  priority: 120,

  addAttributes: () => parse('data-math-block'),

  parseHTML() {
    return [{ tag: 'div[data-math-block]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { class: 'md__math' })]
  },

  addNodeView() {
    return VueNodeViewRenderer(MathView)
  },

  /** Typing `$$` and a space opens an empty formula, ready to type into. */
  addInputRules() {
    return [
      nodeInputRule({
        find: /^\$\$[\s]$/,
        type: this.type,
        getAttributes: () => ({ latex: '' }),
      }),
    ]
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: MarkdownSerializerState, node: PMNode) {
          state.write('$$\n')
          // `state.text(..., false)` writes the LaTeX verbatim. Escaping it
          // would turn every `\frac` into `\\frac` on the first save.
          state.text(String(node.attrs.latex ?? ''), false)
          state.ensureNewLine()
          state.write('$$')
          state.closeBlock(node)
        },
        parse: setup,
      },
    }
  },
})

/**
 * Plain text, with dollars that would be read back as maths kept escaped.
 *
 * markdown-it drops the backslash from `\$` on the way in, so without this the
 * author's literal `\$x\$` is written back as `$x$` and becomes a formula on
 * the next open. That is a save changing what a document says, which is the
 * whole failure this feature is under instructions not to repeat.
 *
 * The escaping is applied to what `state.text` already wrote rather than to
 * the text going in, because `state.text` escapes backslashes: adding one
 * first would have it doubled and the dollar left bare. Patching `state.out`
 * is how tiptap-markdown's own state class does its inline trimming.
 */
export const MathText = Text.extend({
  addStorage() {
    return {
      markdown: {
        serialize(state: MarkdownSerializerState, node: PMNode) {
          // `out` is the serializer's accumulated markdown. It is absent from
          // prosemirror-markdown's published types and present on every
          // instance, and tiptap-markdown's own state class already rewrites
          // it to trim inline delimiters.
          const buffer = state as unknown as { out: string }
          const from = buffer.out.length
          // What tiptap-markdown's own text serializer passes: `html: false`
          // means angle brackets are entities rather than markup.
          state.text(
            (node.text ?? '').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
          )
          const written = buffer.out.slice(from)
          const guarded = guardMathDelimiters(written)
          if (guarded !== written)
            buffer.out = buffer.out.slice(0, from) + guarded
        },
      },
    }
  },
})

export const MathInline = Node.create({
  name: INLINE,
  group: 'inline',
  inline: true,
  atom: true,
  priority: 120,

  addAttributes: () => parse('data-math-inline'),

  parseHTML() {
    return [{ tag: 'span[data-math-inline]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, { class: 'md__math-inline' }),
    ]
  },

  addNodeView() {
    return VueNodeViewRenderer(MathView)
  },

  /**
   * Closing a formula with `$` turns it into a node as you type.
   *
   * The pattern is the parser's rule restated for the one case an input rule
   * can see: no space against either delimiter, which is what keeps `$5 and $`
   * from becoming a formula the moment somebody types a second dollar.
   */
  addInputRules() {
    return [
      nodeInputRule({
        find: /\$([^\s$][^$\n]*[^\s$]|[^\s$])\$$/,
        type: this.type,
        getAttributes: (match) => ({ latex: match[1] }),
      }),
    ]
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: MarkdownSerializerState, node: PMNode) {
          state.write(`$${String(node.attrs.latex ?? '')}$`)
        },
        parse: setup,
      },
    }
  },
})
