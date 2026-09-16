import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorState } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'
import { docTextIndex, resolveInDoc, type IAnchor } from '@/lib/anchors'

/**
 * Inline comment highlights while editing.
 *
 * A ProseMirror decoration, for the reason every other editor decoration here
 * is one: it is presentation attached to a range, it never reaches the
 * document, and so it can never reach the markdown. A mark would be written
 * to the file, which is the one thing an inline comment must not do.
 *
 * Anchors are resolved against the document text when they are handed in,
 * then mapped through each edit rather than re-resolved, so typing inside a
 * highlighted sentence stretches the highlight with it, and deleting the
 * sentence removes it. The comment itself is untouched either way: the server
 * reports it as detached and the thread list still shows it.
 *
 * Clicking a highlight announces which comment it belongs to with a
 * `COMMENT_OPEN_EVENT` on the editor's DOM, so whoever owns the thread can
 * open it without this extension knowing anything about threads.
 */

export const COMMENT_OPEN_EVENT = 'acta-comment-open'

export interface ICommentHighlight {
  id: string
  anchor: IAnchor
}

interface IHighlightState {
  decorations: DecorationSet
}

interface IHighlightMeta {
  highlights: ICommentHighlight[]
  active: string | null
}

export const commentHighlightsKey = new PluginKey<IHighlightState>(
  'acta-comment-highlights',
)

function build(doc: PMNode, meta: IHighlightMeta): DecorationSet {
  const index = docTextIndex(doc)
  const found: Decoration[] = []
  for (const { id, anchor } of meta.highlights) {
    const range = resolveInDoc(index, anchor)
    if (!range) continue
    const active = id === meta.active
    found.push(
      Decoration.inline(
        range.from,
        range.to,
        {
          class: active
            ? 'md__comment-anchor md__comment-anchor--active'
            : 'md__comment-anchor',
          'data-comment-id': id,
        },
        { commentId: id },
      ),
    )
  }
  return DecorationSet.create(doc, found)
}

/**
 * Hand the editor the comments to highlight. Not an undoable step: showing a
 * comment is not an edit, and undo must not hide one.
 */
export function setCommentHighlights(
  view: EditorView,
  highlights: ICommentHighlight[],
  active: string | null = null,
): void {
  const meta: IHighlightMeta = { highlights, active }
  view.dispatch(
    view.state.tr
      .setMeta(commentHighlightsKey, meta)
      .setMeta('addToHistory', false),
  )
}

/** The comment ids highlighted at a document position. */
export function commentsAt(state: EditorState, pos: number): string[] {
  const set = commentHighlightsKey.getState(state)?.decorations
  if (!set) return []
  return set
    .find(pos, pos)
    .map((d) => (d.spec as { commentId?: string }).commentId)
    .filter((id): id is string => !!id)
}

export const CommentHighlights = Extension.create({
  name: 'commentHighlights',

  addProseMirrorPlugins() {
    return [
      new Plugin<IHighlightState>({
        key: commentHighlightsKey,
        state: {
          init: () => ({ decorations: DecorationSet.empty }),
          apply: (tr, previous) => {
            const meta = tr.getMeta(commentHighlightsKey) as
              IHighlightMeta | undefined
            if (meta) return { decorations: build(tr.doc, meta) }
            if (!tr.docChanged) return previous
            return { decorations: previous.decorations.map(tr.mapping, tr.doc) }
          },
        },
        props: {
          decorations: (state) =>
            commentHighlightsKey.getState(state)?.decorations,
          handleClick: (view, pos) => {
            // Not while selecting: a click that ends a drag is choosing
            // text, not asking to read a comment.
            if (!view.state.selection.empty) return false
            const ids = commentsAt(view.state, pos)
            if (ids.length === 0) return false
            view.dom.dispatchEvent(
              new CustomEvent(COMMENT_OPEN_EVENT, {
                bubbles: true,
                detail: { id: ids[0] },
              }),
            )
            // The caret still goes where the click landed.
            return false
          },
        },
      }),
    ]
  },
})
