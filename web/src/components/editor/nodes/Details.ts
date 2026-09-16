import { Node, mergeAttributes } from '@tiptap/core'
import { VueNodeViewRenderer } from '@tiptap/vue-3'
import type { MarkdownIt } from 'markdown-it'
import type { MarkdownSerializerState } from '@tiptap/pm/markdown'
import type { Node as PMNode } from '@tiptap/pm/model'
import { detailsPlugin } from '@/lib/details'
import DetailsView from '@/components/decorations/DetailsView.vue'

/**
 * Toggles (`:::details Title` ... `:::`), as real nodes.
 *
 * `:::details` was the last enhanced construct with no node at all. It showed
 * in the editor as three lines of literal fence text, and it survived a save
 * only because nothing had claimed it: the serializer was quoting a paragraph
 * that happened to start with colons. That is the position callouts and images
 * were both in before they were destroyed by an edit, so it was one keystroke
 * from being the third.
 *
 * Three nodes rather than one, which is the shape ProseMirror wants for a
 * disclosure and the shape Tiptap's own details extension uses:
 *
 *  - `details` holds the pair and is what a document contains;
 *  - `detailsSummary` is the title, as editable text;
 *  - `detailsContent` is the body, `block+`, so a toggle can hold lists, code,
 *    a callout, or another toggle.
 *
 * Whether a toggle is open is NOT here, on purpose. It is how somebody is
 * reading the document, not something the document says, so it lives in the
 * node view. As an attribute, every click on a caret would be a transaction,
 * the editor would emit an update, and a page nobody edited would come back
 * dirty.
 */

declare module '@tiptap/core' {
  /* eslint-disable-next-line @typescript-eslint/naming-convention --
     Module augmentation: the name is Tiptap's, not ours. Prefixing it would
     declare a new interface instead of extending theirs, and the commands
     would not type-check at the call site. */
  interface Commands<ReturnType> {
    details: {
      /** Wrap the selection in a new toggle, or insert an empty one. */
      setDetails: () => ReturnType
    }
  }
}

/**
 * The title.
 *
 * `text*` with no marks, because the title is written back onto the fence line
 * as plain text. Allowing bold there would produce `:::details **Title**`,
 * which the reader shows with the asterisks in it: the two surfaces would
 * disagree about the same file.
 */
const DetailsSummary = Node.create({
  name: 'detailsSummary',
  content: 'text*',
  marks: '',
  defining: true,
  isolating: true,

  parseHTML() {
    return [{ tag: 'summary' }]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'summary',
      mergeAttributes(HTMLAttributes, { class: 'md__details-summary' }),
      0,
    ]
  },

  addStorage() {
    return {
      markdown: {
        // The `details` serializer writes the title onto the fence line, so
        // the summary never serializes itself. A spec is still required: a
        // node without one falls back to tiptap-markdown's HTML serializer,
        // which would write a `<summary>` tag into the file.
        serialize() {},
      },
    }
  },
})

/** The body: arbitrary blocks, which is what people put in a toggle. */
const DetailsContent = Node.create({
  name: 'detailsContent',
  content: 'block+',
  defining: true,

  parseHTML() {
    return [{ tag: 'div[data-details-content]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        class: 'md__details-body',
        'data-details-content': '',
      }),
      0,
    ]
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: MarkdownSerializerState, node: PMNode) {
          state.renderContent(node)
        },
      },
    }
  },
})

const DetailsBlock = Node.create({
  name: 'details',
  group: 'block',
  content: 'detailsSummary detailsContent',
  defining: true,
  // Above the fence rule's neighbours for the same reason the callout sits
  // above blockquote: the `<details>` element must be claimed by this node
  // before anything more generic looks at it.
  priority: 200,

  parseHTML() {
    return [{ tag: 'details' }]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'details',
      mergeAttributes(HTMLAttributes, { class: 'md__details' }),
      0,
    ]
  },

  addNodeView() {
    return VueNodeViewRenderer(DetailsView)
  },

  addCommands() {
    return {
      setDetails:
        () =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            content: [
              {
                type: 'detailsSummary',
                content: [{ type: 'text', text: 'Title' }],
              },
              { type: 'detailsContent', content: [{ type: 'paragraph' }] },
            ],
          }),
    }
  },

  addStorage() {
    return {
      markdown: {
        /**
         * Written back as the fence people typed: the title on the opening
         * line, the body between blank lines, and a bare `:::` to close.
         *
         * `closeBlock` rather than hand-written newlines, so the blank line
         * either side comes from the same place prosemirror-markdown separates
         * every other block with. A nested toggle is just another block inside
         * the body, so nesting needs no special case here.
         */
        serialize(state: MarkdownSerializerState, node: PMNode) {
          const summary = node.firstChild
          const body = node.lastChild
          const title = (summary?.textContent ?? '').trim()
          state.write(`:::details${title ? ` ${title}` : ''}`)
          state.closeBlock(node)
          if (body) state.renderContent(body)
          state.write(':::')
          state.closeBlock(node)
        },
        parse: {
          /**
           * The block rule that gives the reader its `<details>` element, so
           * the editor parses the fence exactly as the reader renders it.
           *
           * It has to run inside markdown-it rather than over the HTML it
           * produced: with `breaks: true`, `:::details T\nbody\n:::` is ONE
           * paragraph holding two hard breaks, and recovering a block from
           * that is guesswork. Measured, not reasoned about.
           */
          setup(markdownit: MarkdownIt) {
            markdownit.use(detailsPlugin)
          },
        },
      },
    }
  },
})

/** All three, in schema order. Registered as a set so none can be forgotten. */
export const Details = [DetailsBlock, DetailsSummary, DetailsContent]
