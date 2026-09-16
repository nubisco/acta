/**
 * Focus mode in the editor: every top-level block except the one holding the
 * caret is dimmed.
 *
 * Decorations only. The plugin adds a class to the editor root while focus
 * mode is on and a class to the current block, and CSS does the dimming. A
 * decoration is not part of the document, so nothing here can reach the
 * markdown: toggling it is a transaction that changes no content, and tiptap
 * emits `update` (and so `update:modelValue`) only when the document changed.
 *
 * Top-level, not the innermost node, because the unit a writer is working on
 * is the paragraph, the list or the table, not the single list item or cell.
 */
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

export const FOCUS_MODE_CLASS = 'acta-focus-mode'
export const FOCUS_CURRENT_CLASS = 'acta-focus-current'

export const focusModeKey = new PluginKey<boolean>('actaFocusMode')

declare module '@tiptap/core' {
  /* eslint-disable-next-line @typescript-eslint/naming-convention --
     Module augmentation: the name is Tiptap's, not ours. Prefixing it would
     declare a new interface instead of extending theirs, and the command
     would not type-check at the call site. */
  interface Commands<ReturnType> {
    focusMode: {
      /** Turn block dimming on or off. Never changes the document. */
      setFocusMode: (enabled: boolean) => ReturnType
    }
  }
}

/** The position and size of the top-level block the selection starts in. */
export function currentTopLevelBlock(
  state: EditorState,
): { from: number; to: number } | null {
  const { $from } = state.selection
  if ($from.depth >= 1) {
    const from = $from.before(1)
    return { from, to: from + $from.node(1).nodeSize }
  }
  // A node selection of a whole top-level block sits at depth 0.
  const node = state.doc.nodeAt(state.selection.from)
  if (!node) return null
  return {
    from: state.selection.from,
    to: state.selection.from + node.nodeSize,
  }
}

export const FocusMode = Extension.create<{ enabled: boolean }>({
  name: 'focusMode',

  addOptions() {
    return { enabled: false }
  },

  addCommands() {
    return {
      setFocusMode:
        (enabled) =>
        ({ tr, dispatch }) => {
          if (dispatch) {
            tr.setMeta(focusModeKey, enabled)
            // Not something undo should step through.
            tr.setMeta('addToHistory', false)
          }
          return true
        },
    }
  },

  addProseMirrorPlugins() {
    const initial = this.options.enabled
    return [
      new Plugin<boolean>({
        key: focusModeKey,
        state: {
          init: () => initial,
          apply: (tr, value) => {
            const meta = tr.getMeta(focusModeKey) as boolean | undefined
            return typeof meta === 'boolean' ? meta : value
          },
        },
        props: {
          attributes: (state): Record<string, string> =>
            focusModeKey.getState(state) ? { class: FOCUS_MODE_CLASS } : {},
          decorations: (state) => {
            if (!focusModeKey.getState(state)) return null
            const block = currentTopLevelBlock(state)
            if (!block) return null
            return DecorationSet.create(state.doc, [
              Decoration.node(block.from, block.to, {
                class: FOCUS_CURRENT_CLASS,
              }),
            ])
          },
        },
      }),
    ]
  },
})
