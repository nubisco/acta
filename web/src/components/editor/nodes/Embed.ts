import { Node, mergeAttributes } from '@tiptap/core'
import type { MarkdownSerializerState } from '@tiptap/pm/markdown'
import type { Node as PMNode } from '@tiptap/pm/model'

/**
 * `![[query:...]]`, the live item list placeholder.
 *
 * A reference with a `!` in front is an embed, not a link, which is why the
 * reference pattern refuses to match it. That left it as the last enhanced
 * construct still travelling as prose, so a save escaped its brackets exactly
 * as it used to escape a callout marker: `!\[\[query:...\]\]`, which the
 * reader would then render as literal text rather than an embed.
 */

export const EMBED_PATTERN = /!\[\[([^\][<>]+)\]\]/g

export const Embed = Node.create({
  name: 'embed',
  group: 'inline',
  inline: true,
  atom: true,
  // Above Ref, so the `!` form is claimed before the plain form looks at it.
  priority: 210,

  addAttributes() {
    return {
      query: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-embed') ?? '',
        renderHTML: (attrs) => ({ 'data-embed': attrs.query }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-embed]' }]
  },

  renderHTML({ HTMLAttributes, node }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, { class: 'md__embed' }),
      `Live item list (${String(node.attrs.query ?? '').replace(/^query:/, '')})`,
    ]
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: MarkdownSerializerState, node: PMNode) {
          state.write(`![[${String(node.attrs.query ?? '')}]]`)
        },
        parse: {
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
                  return (node.nodeValue ?? '').includes('![[')
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
              EMBED_PATTERN.lastIndex = 0
              let match = EMBED_PATTERN.exec(source)
              while (match) {
                if (match.index > last)
                  fragment.append(source.slice(last, match.index))
                const span = document.createElement('span')
                span.setAttribute('data-embed', match[1].trim())
                fragment.append(span)
                last = match.index + match[0].length
                match = EMBED_PATTERN.exec(source)
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
