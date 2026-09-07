/**
 * The two editor typeaheads (Confluence-style insertion):
 *
 *  - typing `[[` searches docs and cards and inserts a `[[ref]]` that every
 *    markdown surface already renders (chips for cards, links for docs);
 *  - typing `/` opens the insert menu: reference pickers plus the enhanced-
 *    markdown blocks (callouts, details) the WYSIWYG cannot otherwise reach.
 *
 * Both ride @tiptap/suggestion (MIT), render through one SuggestionList and
 * insert plain enhanced-markdown text, so the editing and reading engines
 * stay byte-compatible.
 */
import { Extension } from '@tiptap/core'
import type { Editor, Range } from '@tiptap/core'
import { PluginKey } from '@tiptap/pm/state'
import Suggestion, { type SuggestionOptions } from '@tiptap/suggestion'
import { VueRenderer } from '@tiptap/vue-3'
import tippy, { type Instance } from 'tippy.js'
import { api } from '@/api/client'
import SuggestionList from '@/components/editor/SuggestionList.vue'

export interface ISuggestionItem {
  id: string
  label: string
  icon: string
  hint?: string
  apply: (editor: Editor, range: Range) => void
}

interface ISearchHit {
  type: string
  ref: string
  title: string
  board?: string
}

function inserter(text: string): ISuggestionItem['apply'] {
  return (editor, range) =>
    editor.chain().focus().deleteRange(range).insertContent(text).run()
}

/** FTS5 chokes on raw punctuation; the last token becomes a prefix match. */
function ftsQuery(raw: string): string {
  const tokens = raw
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (tokens.length === 0) return ''
  return tokens.map((t, i) => (i === tokens.length - 1 ? `${t}*` : t)).join(' ')
}

async function refItems(query: string): Promise<ISuggestionItem[]> {
  const out: ISuggestionItem[] = []
  // A literal card key beats the index: SU-4 style input resolves directly.
  if (/^[A-Za-z][A-Za-z0-9]{1,4}-\d+$/.test(query.trim())) {
    const key = query.trim().toUpperCase()
    out.push({
      id: `key:${key}`,
      label: `Link card ${key}`,
      icon: 'kanban',
      hint: key,
      apply: inserter(`[[${key}]] `),
    })
  }
  const fts = ftsQuery(query)
  if (!fts) return out
  try {
    const { results } = (await api.search(fts, ['doc', 'item'])) as {
      results: ISearchHit[]
    }
    // Docs above cards: "link the manual" is the common intent, and cards
    // already have the direct-key shortcut above.
    const ranked = [...results].sort(
      (a, b) => Number(b.type === 'doc') - Number(a.type === 'doc'),
    )
    for (const hit of ranked.slice(0, 8)) {
      if (hit.type === 'doc') {
        out.push({
          id: `doc:${hit.ref}`,
          label: hit.title,
          icon: 'file-text',
          hint: 'doc',
          apply: inserter(`[[doc:${hit.ref}|${hit.title}]] `),
        })
      } else {
        out.push({
          id: `item:${hit.ref}`,
          label: hit.title,
          icon: 'kanban',
          hint: hit.ref,
          apply: inserter(`[[${hit.ref}]] `),
        })
      }
    }
  } catch {
    // Search hiccups leave the direct-key entry (if any) standing.
  }
  return out
}

function slashItems(query: string): ISuggestionItem[] {
  const all: ISuggestionItem[] = [
    {
      id: 'doc',
      label: 'Link a document',
      icon: 'file-text',
      hint: '[[',
      apply: inserter('[['),
    },
    {
      id: 'card',
      label: 'Link a card',
      icon: 'kanban',
      hint: '[[',
      apply: inserter('[['),
    },
    ...(['note', 'info', 'tip', 'warning', 'danger'] as const).map((kind) => ({
      id: `callout-${kind}`,
      label: `${kind[0].toUpperCase()}${kind.slice(1)} callout`,
      icon: kind === 'danger' || kind === 'warning' ? 'warning' : 'info',
      apply: inserter(`\n> [!${kind.toUpperCase()}]\n> callout text\n\n`),
    })),
    {
      id: 'details',
      label: 'Collapsible section',
      icon: 'caret-down',
      apply: inserter('\n:::details Title\ncontent\n:::\n\n'),
    },
    {
      id: 'task-list',
      label: 'Task list',
      icon: 'check-square',
      apply: inserter('\n- [ ] first task\n'),
    },
  ]
  const needle = query.trim().toLowerCase()
  return needle
    ? all.filter((i) => i.label.toLowerCase().includes(needle))
    : all
}

/** One popover lifecycle shared by both triggers. */
function makeRender(): SuggestionOptions<ISuggestionItem>['render'] {
  return () => {
    let component: VueRenderer | null = null
    let popup: Instance | null = null
    return {
      onStart(props) {
        component = new VueRenderer(SuggestionList, {
          props: { items: props.items, command: props.command },
          editor: props.editor,
        })
        if (!props.clientRect) return
        popup = tippy(document.body, {
          getReferenceClientRect: () =>
            props.clientRect?.() ?? new DOMRect(0, 0, 0, 0),
          appendTo: () => document.body,
          content: component.element as Element,
          showOnCreate: true,
          interactive: true,
          trigger: 'manual',
          placement: 'bottom-start',
        })
      },
      onUpdate(props) {
        component?.updateProps({ items: props.items, command: props.command })
        if (props.clientRect)
          popup?.setProps({
            getReferenceClientRect: () =>
              props.clientRect?.() ?? new DOMRect(0, 0, 0, 0),
          })
      },
      onKeyDown(props) {
        if (props.event.key === 'Escape') {
          popup?.hide()
          return true
        }
        return (
          (
            component?.ref as { onKeyDown?: (e: KeyboardEvent) => boolean }
          )?.onKeyDown?.(props.event) ?? false
        )
      },
      onExit() {
        popup?.destroy()
        component?.destroy()
        popup = null
        component = null
      },
    }
  }
}

const applyCommand: SuggestionOptions<ISuggestionItem>['command'] = ({
  editor,
  range,
  props,
}) => props.apply(editor, range)

export const RefTypeahead = Extension.create({
  name: 'refTypeahead',
  addProseMirrorPlugins() {
    return [
      Suggestion<ISuggestionItem>({
        editor: this.editor,
        char: '[[',
        pluginKey: new PluginKey('refTypeahead'),
        allowSpaces: true,
        // allowSpaces makes the matcher greedy enough to re-activate on a
        // COMPLETED [[ref]] earlier in the line whenever the caret lands
        // after it, and the ghost popup then eats keystrokes. A completed
        // ref contains ]] so its presence in the would-be query means this
        // is not a live typeahead.
        allow: ({ state, range }) => {
          const text = state.doc.textBetween(range.from, range.to, '\n', '\n')
          return text.length <= 64 && !text.includes(']]')
        },
        items: ({ query }) => refItems(query),
        command: applyCommand,
        render: makeRender(),
      }),
    ]
  },
})

export const SlashMenu = Extension.create({
  name: 'slashMenu',
  addProseMirrorPlugins() {
    return [
      Suggestion<ISuggestionItem>({
        editor: this.editor,
        char: '/',
        pluginKey: new PluginKey('slashMenu'),
        items: ({ query }) => slashItems(query),
        command: applyCommand,
        render: makeRender(),
      }),
    ]
  },
})
