import { Node, mergeAttributes } from '@tiptap/core'
import type { MarkdownSerializerState } from '@tiptap/pm/markdown'
import type { Node as PMNode } from '@tiptap/pm/model'
import { safeUrl } from '@/lib/safeUrl'

/**
 * `![alt](src)`, shown as the picture it names.
 *
 * StarterKit has no image node, and a node the schema does not know is a node
 * the serializer cannot write back. Measured before this node existed: opening
 * a document containing `![Stagewright icon](attachment:att_...)` and saving
 * it with no edit returned the document with the image line gone. Not merely
 * invisible while editing, deleted from the file. The Icon System page had
 * fourteen of them.
 *
 * The `src` attribute keeps whatever the markdown said, so a save writes back
 * the same text it read. Only the DOM gets the resolved URL, which is why
 * `attachment:` survives the instance moving host.
 */

const ATTACHMENT = 'attachment:'

/**
 * What to actually load for a given markdown `src`.
 *
 * `attachment:<id>` is our own served path. Anything else is a URL somebody
 * typed, so it goes through the same allowlist the reader uses: `src` does not
 * execute the way `href` does, but a scheme nobody has thought about should be
 * refused in both places rather than only one.
 */
export function imageSrc(raw: string): string | null {
  const value = raw.trim()
  if (value.startsWith(ATTACHMENT)) {
    const id = value.slice(ATTACHMENT.length).trim()
    return id ? `/api/v1/attachments/${encodeURIComponent(id)}` : null
  }
  return safeUrl(value)
}

export const Image = Node.create({
  name: 'image',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      /*
       * The markdown text, not the URL that gets loaded. Read from `data-src`
       * in preference to `src` so that copying an image inside the editor and
       * pasting it back recovers `attachment:<id>` rather than the resolved
       * path it happened to be displayed with.
       */
      src: {
        default: '',
        parseHTML: (el) =>
          el.getAttribute('data-src') ?? el.getAttribute('src') ?? '',
        renderHTML: () => ({}),
      },
      alt: {
        default: '',
        parseHTML: (el) => el.getAttribute('alt') ?? '',
        renderHTML: (attrs) => ({ alt: String(attrs.alt ?? '') }),
      },
      title: {
        default: null,
        parseHTML: (el) => el.getAttribute('title'),
        renderHTML: (attrs) =>
          attrs.title ? { title: String(attrs.title) } : {},
      },
    }
  },

  parseHTML() {
    return [{ tag: 'img[src]' }]
  },

  renderHTML({ HTMLAttributes, node }) {
    const raw = String(node.attrs.src ?? '')
    const resolved = imageSrc(raw)
    // A refused or empty source still renders an element, so the image is
    // selectable and deletable rather than an invisible node someone cannot
    // get rid of.
    return [
      'img',
      mergeAttributes(HTMLAttributes, {
        class: 'md__img',
        'data-src': raw,
        loading: 'lazy',
        ...(resolved ? { src: resolved } : {}),
      }),
    ]
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: MarkdownSerializerState, node: PMNode) {
          const alt = String(node.attrs.alt ?? '')
          // Parentheses in a URL end the destination early, so they are the
          // one thing that has to be escaped in `src`. Escaping the rest
          // would corrupt perfectly ordinary paths.
          const src = String(node.attrs.src ?? '').replace(/[()]/g, '\\$&')
          const title = node.attrs.title
            ? ` "${String(node.attrs.title).replace(/"/g, '\\"')}"`
            : ''
          state.write(`![${state.esc(alt)}](${src}${title})`)
          state.closeBlock(node)
        },
      },
    }
  },
})
