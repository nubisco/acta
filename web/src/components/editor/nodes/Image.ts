import { Node, mergeAttributes } from '@tiptap/core'
import type { MarkdownSerializerState } from '@tiptap/pm/markdown'
import type { Node as PMNode } from '@tiptap/pm/model'
import { safeUrl } from '@/lib/safeUrl'
import {
  formatImageAttrs,
  imageClass,
  imageStyle,
  matchImageAttrs,
  parseImageAttrs,
  type TImageAlign,
} from '@/lib/imageAttrs'

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
      /*
       * The attribute block, kept as three separate attributes so the toolbar
       * can set one without reading and rewriting the others.
       *
       * Each is mirrored onto a `data-` attribute rather than inferred from
       * the class or the style, so a copy inside the editor and a paste back
       * recovers the same values. The class and the style are presentation
       * and are rebuilt from these, never read back out of.
       */
      align: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-align'),
        renderHTML: (attrs) =>
          attrs.align ? { 'data-align': String(attrs.align) } : {},
      },
      width: {
        default: null,
        parseHTML: (el) => {
          const raw = el.getAttribute('data-width') ?? ''
          return /^[1-9][0-9]*$/.test(raw) ? Number(raw) : null
        },
        renderHTML: (attrs) =>
          attrs.width ? { 'data-width': String(attrs.width) } : {},
      },
      /** Attributes another tool wrote, carried verbatim. */
      extra: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-extra') ?? '',
        renderHTML: (attrs) =>
          attrs.extra ? { 'data-extra': String(attrs.extra) } : {},
      },
    }
  },

  parseHTML() {
    return [{ tag: 'img[src]' }]
  },

  renderHTML({ HTMLAttributes, node }) {
    const raw = String(node.attrs.src ?? '')
    const resolved = imageSrc(raw)
    const style = imageStyle(node.attrs.width as number | null)
    // A refused or empty source still renders an element, so the image is
    // selectable and deletable rather than an invisible node someone cannot
    // get rid of.
    return [
      'img',
      mergeAttributes(HTMLAttributes, {
        class: imageClass(node.attrs.align as TImageAlign | null),
        'data-src': raw,
        loading: 'lazy',
        ...(resolved ? { src: resolved } : {}),
        ...(style ? { style } : {}),
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
          // Empty when there is nothing to say, so an untouched image is
          // written back as the plain `![alt](src)` it was read as, with no
          // trailing `{}` accumulating in the file.
          const attrs = formatImageAttrs({
            align: node.attrs.align as TImageAlign | null,
            width: node.attrs.width as number | null,
            extra: String(node.attrs.extra ?? ''),
          })
          state.write(`![${state.esc(alt)}](${src}${title})${attrs}`)
          state.closeBlock(node)
        },

        parse: {
          /**
           * Hoists `{align=center width=640}` off the text that follows an
           * image and onto the image itself.
           *
           * markdown-it has no idea the block belongs to the picture, so it
           * renders it as literal text after the `<img>`. Left there it does
           * not merely look wrong: the image is a block node, so the
           * paragraph splits around it and the braces survive a save as a
           * stray paragraph of their own, growing a line of noise in the file
           * every time somebody opens the document.
           *
           * Adjacency is the whole rule. Only a block that starts at the very
           * first character after the image is the image's, which is what
           * leaves `{align=center}` written in ordinary prose alone.
           */
          updateDOM(element: HTMLElement) {
            for (const img of Array.from(element.querySelectorAll('img'))) {
              const next = img.nextSibling
              if (!next || next.nodeType !== 3) continue
              const text = next.nodeValue ?? ''
              const block = matchImageAttrs(text)
              if (!block) continue
              const attrs = parseImageAttrs(block)
              if (attrs.align) img.setAttribute('data-align', attrs.align)
              if (attrs.width)
                img.setAttribute('data-width', String(attrs.width))
              if (attrs.extra) img.setAttribute('data-extra', attrs.extra)
              next.nodeValue = text.slice(block.length)
            }
          },
        },
      },
    }
  },
})
