import { Node, mergeAttributes, wrappingInputRule } from '@tiptap/core'
import type { MarkdownSerializerState } from '@tiptap/pm/markdown'
import type { Node as PMNode } from '@tiptap/pm/model'
import {
  CALLOUT_KEYWORD,
  CALLOUT_KINDS,
  calloutIconSvg,
  parseCalloutMarker,
} from '@/lib/callouts'

/**
 * Callouts as a real node, rather than a blockquote whose first line happens
 * to read `[!NOTE]`.
 *
 * As plain text inside a blockquote, the serializer treated the marker as
 * prose and escaped it: `> [!NOTE]` came back as `> \[!NOTE\]\`, with the
 * brackets escaped and a hard break appended. Measured on the Icon System
 * page, that happened on open-and-save with no edit at all, so any document
 * with a callout that anybody had edited was already carrying the scar. It
 * converged rather than compounding, which is why it went unnoticed.
 *
 * A node cannot be escaped, because the serializer is handed the marker to
 * write rather than asked to quote a paragraph that starts with a bracket.
 */

declare module '@tiptap/core' {
  /* eslint-disable-next-line @typescript-eslint/naming-convention --
     Module augmentation: the name is Tiptap's, not ours. Prefixing it would
     declare a new interface instead of extending theirs, and the commands
     would not type-check at the call site. */
  interface Commands<ReturnType> {
    callout: {
      setCallout: (attrs?: { kind?: string }) => ReturnType
      toggleCallout: (attrs?: { kind?: string }) => ReturnType
    }
  }
}

export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  // Above Blockquote, whose `blockquote` rule would otherwise claim the
  // element first and leave the marker as ordinary text inside a quotation.
  priority: 200,
  // Whole blocks, so a callout can hold lists, code and several paragraphs,
  // which is what people already write inside them.
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      kind: {
        default: 'note',
        parseHTML: (el) => el.getAttribute('data-callout') ?? 'note',
        renderHTML: (attrs) => ({ 'data-callout': attrs.kind }),
      },
      /** The optional text on the marker line, as in `[!NOTE] Heads up`. */
      title: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-callout-title') ?? '',
        renderHTML: (attrs) =>
          attrs.title ? { 'data-callout-title': attrs.title } : {},
      },
    }
  },

  parseHTML() {
    return [{ tag: 'blockquote[data-callout]' }]
  },

  renderHTML({ HTMLAttributes, node }) {
    const kind = String(node.attrs.kind ?? 'note')
    return [
      'blockquote',
      mergeAttributes(HTMLAttributes, {
        class: `md__callout md__callout--${kind}`,
      }),
      0,
    ]
  },

  addCommands() {
    return {
      setCallout:
        (attrs) =>
        ({ commands }) =>
          commands.wrapIn(this.name, attrs),
      toggleCallout:
        (attrs) =>
        ({ commands }) =>
          commands.toggleWrap(this.name, attrs),
    }
  },

  /**
   * Typing `> [!NOTE] ` wraps the block, so the markdown people already know
   * is also the way to make one here. The keyword is captured so the style
   * follows what they typed.
   */
  addInputRules() {
    return CALLOUT_KINDS.map((kind) =>
      wrappingInputRule({
        find: new RegExp(`^\\s*>\\s\\[!(${CALLOUT_KEYWORD[kind]})\\]\\s$`, 'i'),
        type: this.type,
        getAttributes: () => ({ kind }),
      }),
    )
  },

  addStorage() {
    return {
      markdown: {
        /**
         * Written back as the marker plus the body, every line prefixed with
         * `> `, which is the form the reader parses and the form a person
         * would have typed.
         */
        serialize(state: MarkdownSerializerState, node: PMNode) {
          const kind = String(node.attrs.kind ?? 'note')
          const title = String(node.attrs.title ?? '').trim()
          const keyword = CALLOUT_KEYWORD[kind] ?? 'NOTE'
          // One `wrapBlock` for the whole thing, so every line gets the `> `
          // prefix from the same place. Writing the marker outside the wrap
          // and the body inside produced a prefix on one and not the other.
          state.wrapBlock('> ', null, node, () => {
            state.write(`[!${keyword}]${title ? ` ${title}` : ''}`)
            // A single newline, not `closeBlock`, which would put a blank
            // quoted line between the marker and the first line of the body.
            state.ensureNewLine()
            state.renderContent(node)
          })
          state.closeBlock(node)
        },
        parse: {
          /**
           * markdown-it gives us a `blockquote`, and the marker is the first
           * LINE of its first paragraph rather than a block of its own.
           *
           * `breaks: true` is why. Every surface here renders typed text,
           * where a newline means a newline, so `> [!NOTE]\n> Body` parses
           * as one paragraph holding a hard break. That is also the whole
           * cause of the escaping: the marker was inline prose, so the
           * serializer quoted its brackets and wrote the break as a trailing
           * backslash.
           *
           * The marker nodes are removed one at a time rather than by
           * rewriting `textContent`, which would flatten any bold, link or
           * code in the rest of the line.
           */
          updateDOM(element: HTMLElement) {
            for (const quote of Array.from(
              element.querySelectorAll('blockquote'),
            )) {
              const first = quote.firstElementChild
              if (!first || first.tagName !== 'P') continue

              // The first line is everything before the first hard break.
              const nodes = Array.from(first.childNodes)
              const breakAt = nodes.findIndex((n) => n.nodeName === 'BR')
              const lineNodes = breakAt === -1 ? nodes : nodes.slice(0, breakAt)
              const line = lineNodes.map((n) => n.textContent ?? '').join('')

              const marker = parseCalloutMarker(line)
              if (!marker) continue

              quote.setAttribute('data-callout', marker.kind)
              if (marker.title)
                quote.setAttribute('data-callout-title', marker.title)

              // Drop the marker line and the break that ended it, leaving
              // the rest of the paragraph exactly as it was.
              for (const n of lineNodes) n.remove()
              if (breakAt !== -1) nodes[breakAt].remove()

              // A marker with nothing after it is a callout someone is still
              // typing. The schema needs a block, so the empty paragraph
              // stays rather than leaving the node invalid.
              if (
                quote.children.length > 1 &&
                (first.textContent ?? '').trim() === ''
              )
                first.remove()
            }
          },
        },
      },
    }
  },
})

/** The icon, for a node view or a decorated reader. Kept next to the node. */
export { calloutIconSvg }
