import { Node, mergeAttributes } from '@tiptap/core'
import { VueNodeViewRenderer } from '@tiptap/vue-3'
import type { MarkdownSerializerState } from '@tiptap/pm/markdown'
import type { Node as PMNode } from '@tiptap/pm/model'
import LinkCardView from '@/components/decorations/LinkCardView.vue'
import { bareUrlParagraph } from '@/components/decorations/linkCards'

/**
 * A bare URL that is the whole paragraph, as a preview card.
 *
 * The node exists so that the editor agrees with the reader about what such a
 * paragraph is. A construct that renders in the reader with no matching node
 * in the editor is not merely invisible while editing, it is deleted on save,
 * because a node the schema does not know is a node the serializer cannot
 * write back. That has shipped as a bug here twice, for GFM tables and for
 * images, and this is the same shape of thing.
 *
 * What it writes back is the URL and nothing else. Measured before this node
 * existed: `https://example.com/page` in, `<https://example.com/page>` out,
 * because prosemirror-markdown serialises a link whose text is its own href
 * as an autolink. So the node does not merely avoid damaging the markdown, it
 * is what makes a bare URL round-trip at all.
 */
export const LinkCard = Node.create({
  name: 'linkCard',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      /**
       * The URL as the author typed it, not the href the renderer derived.
       * They differ whenever a path needs percent-encoding, and writing the
       * derived form back would rewrite somebody's document into an encoded
       * shape they did not choose.
       */
      url: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-link-card') ?? '',
        renderHTML: (attrs) => ({ 'data-link-card': attrs.url }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-link-card]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { class: 'md__card-slot' })]
  },

  addNodeView() {
    return VueNodeViewRenderer(LinkCardView)
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: MarkdownSerializerState, node: PMNode) {
          // Raw. A URL needs no escaping, and escaping it is exactly the bug
          // this node exists to stop.
          state.write(String(node.attrs.url ?? ''))
          state.closeBlock(node)
        },
        parse: {
          /**
           * markdown-it has already turned the bare URL into an anchor by the
           * time this runs, so the recognition happens in the DOM, against
           * the same rule the reader applies.
           */
          updateDOM(element: HTMLElement) {
            for (const paragraph of [
              ...element.querySelectorAll<HTMLElement>('p'),
            ]) {
              const url = bareUrlParagraph(paragraph)
              if (!url) continue
              const slot = document.createElement('div')
              slot.setAttribute('data-link-card', url)
              paragraph.replaceWith(slot)
            }
          },
        },
      },
    }
  },
})
