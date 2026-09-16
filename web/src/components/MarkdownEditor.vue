<template>
  <BubbleMenu
    :editor="editor"
    :tippy-options="{ duration: 120 }"
    class="md-editor__bubble"
  >
    <button
      v-for="action in bubbleActions"
      :key="action.label"
      type="button"
      class="md-editor__bubble-btn"
      :class="{ 'is-active': action.isActive() }"
      :aria-label="action.label"
      :aria-pressed="action.isActive()"
      @click="action.run"
    >
      <NbIcon :name="action.icon" :size="15" />
    </button>
  </BubbleMenu>
  <!--
    Table row and column controls.

    Teleported into a decoration inside the selected band's first cell, so the
    bar sits against the thing it acts on without a single measured
    coordinate, and the buttons are still `@nubisco/ui` buttons rather than
    DOM the editor drew for itself.

    Revealed by selecting a band, which a grip click does and the keyboard
    shortcuts do too, so this is not a mouse-only affordance. Alignment is
    offered on columns only, because that is the only place GFM can store it:
    one marker per column in the delimiter row.
  -->
  <Teleport v-if="rowControls" :to="rowControls">
    <div class="md-editor__table-bar" @mousedown.prevent>
      <NbButton
        size="xxs"
        variant="ghost"
        icon="rows-plus-top"
        aria-label="Insert row above"
        @click="editor.chain().focus().addRowBefore().run()"
      />
      <NbButton
        size="xxs"
        variant="ghost"
        icon="rows-plus-bottom"
        aria-label="Insert row below"
        @click="editor.chain().focus().addRowAfter().run()"
      />
      <NbButton
        size="xxs"
        variant="danger"
        icon="trash-simple"
        aria-label="Delete row"
        @click="editor.chain().focus().deleteRow().run()"
      />
    </div>
  </Teleport>

  <Teleport v-if="columnControls" :to="columnControls">
    <div class="md-editor__table-bar" @mousedown.prevent>
      <NbButton
        size="xxs"
        variant="ghost"
        icon="columns-plus-left"
        aria-label="Insert column before"
        @click="editor.chain().focus().addColumnBefore().run()"
      />
      <NbButton
        size="xxs"
        variant="ghost"
        icon="columns-plus-right"
        aria-label="Insert column after"
        @click="editor.chain().focus().addColumnAfter().run()"
      />
      <NbButton
        size="xxs"
        variant="ghost"
        icon="text-align-left"
        aria-label="Align left"
        :aria-pressed="columnAlignment === 'left'"
        @click="align('left')"
      />
      <NbButton
        size="xxs"
        variant="ghost"
        icon="text-align-center"
        aria-label="Align centre"
        :aria-pressed="columnAlignment === 'center'"
        @click="align('center')"
      />
      <NbButton
        size="xxs"
        variant="ghost"
        icon="text-align-right"
        aria-label="Align right"
        :aria-pressed="columnAlignment === 'right'"
        @click="align('right')"
      />
      <NbButton
        size="xxs"
        variant="danger"
        icon="trash-simple"
        aria-label="Delete column"
        @click="editor.chain().focus().deleteColumn().run()"
      />
    </div>
  </Teleport>
  <!-- The positioning context the image controls measure against. They are
       absolutely placed over whichever picture is hovered or selected, so
       they need a frame that does not move when the page scrolls. -->
  <div class="md-editor__frame">
    <EditorContent :editor="editor" class="md-editor" />
    <ImageTools
      :editor="editor"
      :upload="owner ? uploadReplacement : undefined"
    />
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { BubbleMenu, Editor, EditorContent } from '@tiptap/vue-3'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import TableRow from '@tiptap/extension-table-row'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import { Markdown } from 'tiptap-markdown'
import { useToast } from '@nubisco/ui'
import { api } from '@/api/client'
import { humanise } from '@/lib/state'
import {
  MentionTypeahead,
  RefTypeahead,
  SlashMenu,
} from '@/components/editor/suggestions'
import { Callout } from '@/components/editor/nodes/Callout'
import { Emphasis } from '@/components/editor/nodes/Emphasis'
import { Ref } from '@/components/editor/nodes/Ref'
import { Embed } from '@/components/editor/nodes/Embed'
import { Image } from '@/components/editor/nodes/Image'
import ImageTools from '@/components/editor/ImageTools.vue'
import { Details } from '@/components/editor/nodes/Details'
import {
  Table,
  TableCell,
  TableHeader,
  selectedColumnAlignment,
} from '@/components/editor/nodes/Table'
import type { TTableAlignment } from '@/components/editor/nodes/Table'
import { TableGrips, selectedTableBand } from '@/components/editor/tableGrips'
import { MathBlock, MathInline, MathText } from '@/components/editor/nodes/Math'
import { MermaidBlock } from '@/components/editor/nodes/MermaidBlock'
import { LinkCard } from '@/components/editor/nodes/LinkCard'
import { ColorSwatches } from '@/components/editor/decorations'

const props = defineProps<{
  modelValue: string
  placeholder?: string
  autofocus?: boolean
  /**
   * What a dropped or pasted image should attach to. Without it the editor
   * still works and simply does not accept files, which is right for a
   * surface with nothing to attach them to.
   */
  owner?: { item?: string; doc?: string }
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  blur: []
  /** An upload finished, so the owner can refresh its attachment list. */
  attached: []
}>()

/**
 * Files dropped or pasted into the document.
 *
 * Uploaded first, then embedded as `![name](attachment:<id>)`, which is the
 * same syntax somebody would type. The markdown carries an id rather than a
 * URL so it survives the instance moving host.
 *
 * `at` is where a drop landed. Without it a dropped file went in at whatever
 * the caret happened to be, which for a document somebody had scrolled down
 * to meant the picture appeared somewhere off screen. A paste passes no
 * position, because the caret IS where a paste belongs.
 *
 * Several files keep their order. Awaiting each in turn is slower than firing
 * them together, but a race would insert them in whatever order the server
 * happened to answer, which is not the order they were dropped.
 */
async function attachFiles(files: File[], at?: number): Promise<void> {
  const owner = props.owner
  if (!owner || files.length === 0) return
  // Held across the awaits so several files land in order rather than all at
  // the same spot, and mapped through the document's changes so a slow upload
  // does not insert at a position that has since moved.
  let target = at
  for (const file of files) {
    try {
      const made = await api.attachmentUpload(owner, file)
      const alt = file.name.replace(/\.[^.]+$/, '')
      const markdown = `![${alt}](attachment:${made.id})`
      if (target === undefined) {
        editor.chain().focus().insertContent(markdown).run()
      } else {
        const pos = Math.min(target, editor.state.doc.content.size)
        editor.chain().focus().insertContentAt(pos, markdown).run()
        // Past what was just inserted, so the next file follows it.
        target = editor.state.selection.from
      }
    } catch (err) {
      toast.error(humanise(err), { title: `Could not attach ${file.name}` })
    }
  }
  emit('attached')
}

/**
 * A file chosen to replace a picture already in the document.
 *
 * Answers with the markdown `src`, not with a URL and not by editing the
 * document: the image controls own the node they are pointing at, and this
 * owns knowing where a file goes. Null when the upload failed, so nothing is
 * written and the old picture stays where it was.
 */
async function uploadReplacement(file: File): Promise<string | null> {
  const owner = props.owner
  if (!owner) return null
  try {
    const made = await api.attachmentUpload(owner, file)
    emit('attached')
    return `attachment:${made.id}`
  } catch (err) {
    toast.error(humanise(err), { title: `Could not attach ${file.name}` })
    return null
  }
}

/** Images only. A dropped folder or archive is not something to embed. */
function imagesFrom(list: FileList | null | undefined): File[] {
  return Array.from(list ?? []).filter((f) => f.type.startsWith('image/'))
}

/**
 * The document IS the editing surface (Typora-style): markdown in, markdown
 * out, WYSIWYG in between. Every enhanced construct the reader renders has a
 * node here (callouts, toggles, [[refs]], embeds, images), because a node the
 * schema does not know is a node the serializer cannot write back.
 */
const toast = useToast()

/**
 * Which band a table grip has selected, and how that column is aligned.
 *
 * Mirrored into refs rather than read from the editor in the template,
 * because the editor is not reactive: a selection change does not re-render
 * anything unless something tells Vue it happened.
 */
const rowControls = ref<HTMLElement | null>(null)
const columnControls = ref<HTMLElement | null>(null)
const columnAlignment = ref<TTableAlignment | null>(null)

/**
 * Clicking the same alignment again clears it, which writes `---` rather than
 * `:---`. The two are not the same marker, and a document that never asked for
 * alignment should not grow one it cannot get rid of.
 */
function align(alignment: TTableAlignment): void {
  const next = columnAlignment.value === alignment ? null : alignment
  editor.chain().focus().setColumnAlignment(next).run()
  readTableSelection()
}

function readTableSelection(): void {
  const band = selectedTableBand(editor.state)
  // Re-queried every time rather than held, because the decoration carrying
  // the host is rebuilt whenever the selection or the document changes, and a
  // remembered element would be one ProseMirror has already thrown away.
  const host = (kind: string) =>
    band
      ? editor.view.dom.querySelector<HTMLElement>(
          `[data-table-controls="${kind}"]`,
        )
      : null
  rowControls.value = band?.row ? host('row') : null
  columnControls.value = band?.column ? host('column') : null
  columnAlignment.value = selectedColumnAlignment(editor.state)
}

const editor = new Editor({
  content: props.modelValue,
  autofocus: props.autofocus ? 'end' : false,
  extensions: [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4] },
      // Replaced below by the same code block carrying a node view, so a
      // mermaid fence draws its diagram. The node, its parse rule and its
      // serializer are untouched.
      codeBlock: false,
      // Replaced below by the same text node, so an escaped dollar stays
      // escaped and is not read back as a formula. See nodes/Math.ts.
      text: false,
    }),
    MermaidBlock,
    Link.configure({ openOnClick: false }),
    // The reader renders GFM tables and task lists. Without the matching
    // nodes here the editor did not merely fail to CREATE them: opening a
    // document that contained one and saving dropped it, because a node the
    // schema does not know is a node the serializer cannot write back.
    Table.configure({ resizable: true }),
    TableRow,
    TableHeader,
    TableCell,
    TableGrips,
    TaskList,
    TaskItem.configure({ nested: true }),
    // Before the typeaheads, so `> [!NOTE] ` is claimed as a callout rather
    // than left to the blockquote it came from.
    Callout,
    // `:::details` is a block the schema has to know, for the same reason as
    // the tables above: unclaimed, it travelled as literal fence text that any
    // edit could escape or lose.
    ...Details,
    Emphasis,
    Ref,
    Embed,
    Image,
    // The reader renders `$$ ... $$` and `$...$`. Without these the editor
    // would parse a formula to nothing and write nothing back, which is how
    // tables and then images were silently deleted from documents here.
    MathText,
    MathBlock,
    MathInline,
    // A bare URL alone in a paragraph is a preview card in the reader, so it
    // has to be a node here too. Without one the editor would show the plain
    // link, which is harmless, and then write it back as `<https://...>`,
    // which is not: the two surfaces would disagree about the text.
    LinkCard,
    ColorSwatches,
    Placeholder.configure({
      placeholder: props.placeholder ?? 'Type here...',
    }),
    Markdown.configure({
      html: false,
      linkify: true,
      breaks: true,
      transformPastedText: true,
    }),
    // `[[` searches docs and cards; `/` opens the insert menu. Both write
    // plain enhanced-markdown, keeping editor and reader byte-compatible.
    RefTypeahead,
    MentionTypeahead,
    SlashMenu,
  ],
  editorProps: {
    handlePaste: (_view, event) => {
      // Only when there is a file. A paste carrying both an image and text,
      // as a screenshot tool often does, should still paste the text.
      const files = imagesFrom(event.clipboardData?.files)
      if (files.length === 0 || !props.owner) return false
      event.preventDefault()
      void attachFiles(files)
      return true
    },
    handleDrop: (view, event) => {
      const files = imagesFrom((event as DragEvent).dataTransfer?.files)
      if (files.length === 0 || !props.owner) return false
      event.preventDefault()
      // Where the pointer let go, so the picture lands where it was aimed.
      // posAtCoords returns null for a drop outside any content, and the
      // caret is the sensible fallback for that.
      const drop = view.posAtCoords({
        left: (event as DragEvent).clientX,
        top: (event as DragEvent).clientY,
      })
      void attachFiles(files, drop?.pos)
      return true
    },
  },
  onBlur: () => emit('blur'),
  onSelectionUpdate: () => readTableSelection(),
  onUpdate: ({ editor: instance }) => {
    readTableSelection()
    emit(
      'update:modelValue',
      (
        instance.storage as { markdown: { getMarkdown: () => string } }
      ).markdown.getMarkdown(),
    )
  },
})

watch(
  () => props.modelValue,
  (value) => {
    const current = (
      editor.storage as { markdown: { getMarkdown: () => string } }
    ).markdown.getMarkdown()
    if (value !== current) editor.commands.setContent(value)
  },
)

onBeforeUnmount(() => editor.destroy())

defineExpose({ focus: () => editor.commands.focus('end') })

/* The selection bubble: inline styling first, block moves after. */
const bubbleActions = [
  {
    label: 'Bold',
    icon: 'text-b',
    isActive: () => editor.isActive('bold'),
    run: () => editor.chain().focus().toggleBold().run(),
  },
  {
    label: 'Italic',
    icon: 'text-italic',
    isActive: () => editor.isActive('italic'),
    run: () => editor.chain().focus().toggleItalic().run(),
  },
  {
    label: 'Strikethrough',
    icon: 'text-strikethrough',
    isActive: () => editor.isActive('strike'),
    run: () => editor.chain().focus().toggleStrike().run(),
  },
  {
    label: 'Inline code',
    icon: 'code',
    isActive: () => editor.isActive('code'),
    run: () => editor.chain().focus().toggleCode().run(),
  },
  {
    label: 'Heading 2',
    icon: 'text-h-two',
    isActive: () => editor.isActive('heading', { level: 2 }),
    run: () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
  },
  {
    label: 'Heading 3',
    icon: 'text-h-three',
    isActive: () => editor.isActive('heading', { level: 3 }),
    run: () => editor.chain().focus().toggleHeading({ level: 3 }).run(),
  },
  {
    label: 'Bullet list',
    icon: 'list-bullets',
    isActive: () => editor.isActive('bulletList'),
    run: () => editor.chain().focus().toggleBulletList().run(),
  },
  {
    label: 'Numbered list',
    icon: 'list-numbers',
    isActive: () => editor.isActive('orderedList'),
    run: () => editor.chain().focus().toggleOrderedList().run(),
  },
  {
    label: 'Quote',
    icon: 'quotes',
    isActive: () => editor.isActive('blockquote'),
    run: () => editor.chain().focus().toggleBlockquote().run(),
  },
]
</script>

<style scoped lang="scss">
.md-editor__bubble {
  display: flex;
  gap: 2px;
  padding: var(--nb-spacing-2);
  background: var(--nb-c-layer-3);
  border: 1px solid var(--nb-c-layer-border-3);
  border-radius: var(--nb-radius-md);
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.25);
  z-index: var(--nb-zindex-dropdown);
}

.md-editor__bubble-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  inline-size: 28px;
  block-size: 28px;
  border: 0;
  border-radius: var(--nb-radius-sm);
  background: transparent;
  color: var(--nb-c-text);
  cursor: pointer;

  &:hover {
    background: var(--nb-c-surface-hover);
  }

  &.is-active {
    background: var(--nb-c-primary);
    color: var(--nb-c-primary-a11y);
  }

  &:focus-visible {
    outline: 2px solid var(--nb-c-focus-ring);
    outline-offset: 1px;
  }
}

/* The frame the image controls are measured and placed against. */
.md-editor__frame {
  position: relative;
}

.md-editor__table-bar {
  display: flex;
  gap: 2px;
  padding: var(--nb-spacing-2);
  background: var(--nb-c-layer-3);
  border: 1px solid var(--nb-c-layer-border-3);
  border-radius: var(--nb-radius-md);
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.25);
  white-space: nowrap;
}

.md-editor {
  :deep(.tiptap) {
    outline: none;
    min-height: 8rem;
    line-height: var(--nb-type-body-md-line-height);
    caret-color: var(--nb-c-primary);

    > * + * {
      margin-block-start: var(--nb-spacing-8);
    }

    p,
    li,
    blockquote {
      max-width: 68ch;
    }

    h1,
    h2,
    h3,
    h4 {
      margin-block: var(--nb-spacing-24) var(--nb-spacing-8);

      &:first-child {
        margin-block-start: 0;
      }
    }

    ul,
    ol {
      padding-inline-start: var(--nb-spacing-24);
    }

    blockquote {
      border-inline-start: 2px solid var(--nb-c-border);
      padding-inline-start: var(--nb-spacing-12);
      margin-inline: 0;
      color: var(--nb-c-text-muted);
    }

    pre {
      overflow-x: auto;
      padding: var(--nb-spacing-12);
      border-radius: var(--nb-radius-sm);
      background: var(--nb-c-surface);
      border: 1px solid var(--nb-c-border);
      font-family: var(--nb-font-family-mono);
      font-size: var(--nb-type-code-sm-size);
    }

    code {
      font-family: var(--nb-font-family-mono);
      font-size: var(--nb-type-code-sm-size);
    }

    a {
      color: var(--nb-c-primary);
    }

    hr {
      border: 0;
      border-block-start: 1px solid var(--nb-c-border);
      margin-block: var(--nb-spacing-16);
    }

    /* Tables, matching the reader's borders so switching into edit mode is
       not a change of appearance. */
    table {
      border-collapse: collapse;
      table-layout: fixed;
      /* Room in the margin for the grips, which sit outside the table edge. */
      margin-block: var(--nb-spacing-16);
      margin-inline-start: var(--nb-spacing-12);

      th,
      td {
        position: relative;
        border: 1px solid var(--nb-c-border);
        padding: var(--nb-spacing-4) var(--nb-spacing-8);

        > p {
          margin: 0;
          max-width: none;
        }
      }

      /* prosemirror-tables marks a cell selection with this class. Without it
         a band selected from a grip looks like nothing happened. */
      .selectedCell::after {
        content: '';
        position: absolute;
        inset: 0;
        background: var(--nb-c-primary);
        opacity: 0.12;
        pointer-events: none;
      }
    }

    /* The grips.

       Positioned against the first cell of their band rather than measured
       against the table, so they stay correct while the table is edited. They
       appear on hover of the table, and stay visible once their band is
       selected, which is how the inline controls are kept reachable. */
    .md-table__grip {
      position: absolute;
      padding: 0;
      border: 0;
      border-radius: var(--nb-radius-xs);
      background: var(--nb-c-border);
      opacity: 0;
      transition: opacity 120ms ease;
      cursor: grab;

      &:hover,
      &.is-active {
        background: var(--nb-c-primary);
        opacity: 1;
      }

      &.is-dragging {
        cursor: grabbing;
        opacity: 1;
      }

      &:focus-visible {
        outline: 2px solid var(--nb-c-focus-ring);
        outline-offset: 1px;
        opacity: 1;
      }
    }

    .md-table__grip--row {
      inset-inline-start: -9px;
      inset-block: 1px;
      inline-size: 5px;
    }

    /* The inline controls, floating above the band they act on. Absolute so
       they never change the cell's size, which would make the table jump every
       time somebody selected a row. */
    .md-table__controls {
      position: absolute;
      z-index: 1;
      inset-block-end: calc(100% + var(--nb-spacing-4));
      inset-inline-start: 0;
    }

    .md-table__grip--column {
      inset-block-start: -9px;
      inset-inline: 1px;
      block-size: 5px;
    }

    table:hover .md-table__grip {
      opacity: 0.6;
    }

    p.is-editor-empty:first-child::before {
      content: attr(data-placeholder);
      float: inline-start;
      color: var(--nb-c-text-subtle);
      pointer-events: none;
      height: 0;
    }
  }
}
</style>
