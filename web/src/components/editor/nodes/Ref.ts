import { Node, mergeAttributes } from '@tiptap/core'
import { VueNodeViewRenderer } from '@tiptap/vue-3'
import type { MarkdownSerializerState } from '@tiptap/pm/markdown'
import type { Node as PMNode } from '@tiptap/pm/model'
import RefChip from '@/components/decorations/RefChip.vue'

/**
 * `[[SU-12]]`, `[[doc:handbook]]`, `[[@jose]]` as a single inline object.
 *
 * These were plain text in the editor: you saw the brackets, you could put
 * the caret in the middle of a card key and break it, and nothing told you
 * whether the thing you were linking to existed. In the reader they were
 * chips the whole time, so the two surfaces disagreed about what a reference
 * even is.
 *
 * An atom, because a reference is one thing. Selecting it selects all of it,
 * backspace removes all of it, and there is no way to end up with `[[SU-1`.
 */

/** `[[target]]` or `[[target|alias]]`, not preceded by `!` (that is an embed). */
export const REF_PATTERN = /(?<!!)\[\[([^\][<>|]+)(?:\|([^\][<>]*))?\]\]/g

export const Ref = Node.create({
  name: 'ref',
  group: 'inline',
  inline: true,
  atom: true,
  // Higher than the default so the chip claims its span before anything
  // generic tries to read it as text.
  priority: 200,

  addAttributes() {
    return {
      target: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-ref-target') ?? '',
        renderHTML: (attrs) => ({ 'data-ref-target': attrs.target }),
      },
      /** The `|alias` half, kept so a save writes back what was written. */
      alias: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-ref-alias'),
        renderHTML: (attrs) =>
          attrs.alias ? { 'data-ref-alias': attrs.alias } : {},
      },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-ref-target]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { class: 'md__ref' })]
  },

  addNodeView() {
    return VueNodeViewRenderer(RefChip)
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: MarkdownSerializerState, node: PMNode) {
          const target = String(node.attrs.target ?? '')
          const alias = node.attrs.alias as string | null
          // Written raw: the brackets are syntax, and escaping them is the
          // bug this node exists to stop.
          state.write(`[[${target}${alias ? `|${alias}` : ''}]]`)
        },
        parse: {
          /**
           * The brackets survive markdown-it as ordinary text, so the DOM is
           * where they are recognised. Code is skipped: `[[x]]` inside a code
           * span or a fence is a literal the author wrote on purpose.
           */
          updateDOM(element: HTMLElement) {
            const walker = document.createTreeWalker(
              element,
              NodeFilter.SHOW_TEXT,
              {
                acceptNode(node) {
                  let parent = node.parentElement
                  while (parent && parent !== element) {
                    const tag = parent.tagName
                    if (tag === 'CODE' || tag === 'PRE')
                      return NodeFilter.FILTER_REJECT
                    parent = parent.parentElement
                  }
                  return REF_PATTERN.test(node.nodeValue ?? '')
                    ? NodeFilter.FILTER_ACCEPT
                    : NodeFilter.FILTER_REJECT
                },
              },
            )

            const texts: Text[] = []
            let current = walker.nextNode()
            while (current) {
              texts.push(current as Text)
              current = walker.nextNode()
            }

            for (const text of texts) {
              const source = text.nodeValue ?? ''
              const fragment = document.createDocumentFragment()
              let last = 0
              // `lastIndex` is shared state on a global regex, so it is reset
              // per node rather than trusted from the walker's test above.
              REF_PATTERN.lastIndex = 0
              let match = REF_PATTERN.exec(source)
              while (match) {
                if (match.index > last)
                  fragment.append(source.slice(last, match.index))
                const span = document.createElement('span')
                span.setAttribute('data-ref-target', match[1].trim())
                if (match[2] !== undefined)
                  span.setAttribute('data-ref-alias', match[2].trim())
                fragment.append(span)
                last = match.index + match[0].length
                match = REF_PATTERN.exec(source)
              }
              if (last < source.length) fragment.append(source.slice(last))
              text.replaceWith(fragment)
            }
          },
        },
      },
    }
  },
})
