import CodeBlock from '@tiptap/extension-code-block'
import { VueNodeViewRenderer } from '@tiptap/vue-3'
import MermaidView from '@/components/decorations/MermaidView.vue'

/**
 * ```` ```mermaid ```` drawn as the diagram it describes.
 *
 * Deliberately the existing code block with a node view on it, rather than a
 * node of its own. A mermaid fence already parses and serializes correctly:
 * it is a code block whose language happens to be `mermaid`, and the round
 * trip through `tiptap-markdown` has always been byte-clean. The only thing
 * missing was the picture.
 *
 * Replacing the node would have meant a new parse rule and a new serializer
 * standing between every existing diagram and the file it lives in, which is
 * precisely the change that deleted tables and then images from documents in
 * this application. Adding a view changes what is drawn and nothing about what
 * is written, so the worst case of a bug in here is a diagram that looks wrong
 * rather than a diagram that is gone.
 *
 * The view also serves ordinary fences, unchanged: same `<pre><code>`, same
 * language class. One node, one view, one branch inside it.
 */
export const MermaidBlock = CodeBlock.extend({
  addNodeView() {
    return VueNodeViewRenderer(MermaidView)
  },
})
