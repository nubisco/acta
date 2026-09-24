import { InputRule, Node, mergeAttributes } from '@tiptap/core'
import { VueNodeViewRenderer } from '@tiptap/vue-3'
import type { MarkdownSerializerState } from '@tiptap/pm/markdown'
import type { Node as PMNode } from '@tiptap/pm/model'
import RefChip from '@/components/decorations/RefChip.vue'
import { useWorkspace } from '@/stores/workspace'

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

  /**
   * Typing `@handle` and carrying on makes a mention, without going near the
   * typeahead.
   *
   * The typeahead inserts `[[@handle]]` when you pick somebody from it. The
   * evidence is that nobody does: of every mention in our own workspace, not
   * one was bracketed. People type `@ivan` and keep going, and until now that
   * stayed grey text that notified nobody.
   *
   * Only a handle that names somebody converts, which is what keeps a stray
   * `@` in prose, or a handle from an imported tool, as the text it is. The
   * boundary character that triggered the rule is put back, so typing does
   * not eat the space or the comma after the name.
   */
  addInputRules() {
    return [
      new InputRule({
        find: /(^|[^A-Za-z0-9._%+\-/@])@([a-z0-9][a-z0-9-]{1,39})([\s,.;:!?])$/i,
        handler: ({ range, match, chain }) => {
          const lead = match[1] ?? ''
          const handle = match[2].toLowerCase()
          const boundary = match[3] ?? ''
          const known = useWorkspace().overview.value?.actors ?? []
          if (!known.some((a) => a.handle.toLowerCase() === handle)) return null
          chain()
            .deleteRange({ from: range.from + lead.length, to: range.to })
            .insertContent([
              { type: 'ref', attrs: { target: `@${handle}`, alias: null } },
              { type: 'text', text: boundary },
            ])
            .run()
          return undefined
        },
      }),
    ]
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
                  // Reset before the test, not only before the replacement
                  // below. `test` on a global regex advances `lastIndex` and
                  // the walker calls this once per text node, so the position
                  // left behind by one paragraph decided where the search
                  // started in the next. A reference late in a long paragraph
                  // therefore hid every reference in the short paragraph after
                  // it, which rendered as raw `[[@handle]]` in the editor while
                  // the reader showed a pill for the same text.
                  REF_PATTERN.lastIndex = 0
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
