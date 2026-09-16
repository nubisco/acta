import BaseTable from '@tiptap/extension-table'
import BaseTableCell from '@tiptap/extension-table-cell'
import BaseTableHeader from '@tiptap/extension-table-header'
import {
  CellSelection,
  TableMap,
  moveTableColumn,
  moveTableRow,
} from '@tiptap/pm/tables'
import type { Node as PMNode } from '@tiptap/pm/model'
import type { EditorState } from '@tiptap/pm/state'

/**
 * GFM tables, and only GFM tables.
 *
 * Documents are stored as markdown and the storage decision is portability:
 * a table written here stays readable and editable in GitHub, Obsidian, VS
 * Code and pandoc. That rules out an HTML escape hatch, which is what
 * `tiptap-markdown` falls back to the moment a table has a merged cell or a
 * cell holding more than one block. The fallback is not a richer table, it is
 * a document that has stopped being markdown.
 *
 * So this serializer never gives up. It flattens instead:
 *
 * - merged cells are expanded through the table map, so a cell spanning two
 *   columns writes its content once and an empty cell beside it
 * - a cell holding several blocks (a list, two paragraphs) is written as its
 *   text, joined with spaces, on the one line GFM allows
 * - a newline inside a cell would end the row, so it becomes a space
 * - a literal pipe is escaped, which is the classic GFM trap: before this,
 *   `x \| y` came back as two columns and silently widened the table
 *
 * Alignment is the one piece of table formatting markdown genuinely supports
 * (`:---`, `:---:`, `---:`), so it is modelled as a cell attribute and written
 * back into the delimiter row exactly as it was read.
 */

/** The three alignments GFM can write. `null` is "unset", written `---`. */
export const TABLE_ALIGNMENTS = ['left', 'center', 'right'] as const

export type TTableAlignment = (typeof TABLE_ALIGNMENTS)[number]

function isAlignment(value: unknown): value is TTableAlignment {
  return TABLE_ALIGNMENTS.includes(value as TTableAlignment)
}

/** The delimiter-row cell that carries one column's alignment. */
export function alignmentDelimiter(alignment: TTableAlignment | null): string {
  if (alignment === 'left') return ':---'
  if (alignment === 'center') return ':---:'
  if (alignment === 'right') return '---:'
  return '---'
}

/**
 * The alignment attribute, shared by header cells and body cells.
 *
 * markdown-it writes GFM alignment as `style="text-align:center"` on the cell,
 * so that is what the parse reads. `data-align` is accepted as well because a
 * paste from another editor is the other way this arrives.
 */
function alignmentAttribute() {
  return {
    alignment: {
      default: null as TTableAlignment | null,
      parseHTML: (element: HTMLElement): TTableAlignment | null => {
        const inline = element.style.textAlign
        if (isAlignment(inline)) return inline
        const data = element.getAttribute('data-align')
        return isAlignment(data) ? data : null
      },
      renderHTML: (attributes: Record<string, unknown>) => {
        const alignment = attributes.alignment
        if (!isAlignment(alignment)) return {}
        return { style: `text-align: ${alignment}`, 'data-align': alignment }
      },
    },
  }
}

export const TableHeader = BaseTableHeader.extend({
  addAttributes() {
    return { ...this.parent?.(), ...alignmentAttribute() }
  },
})

export const TableCell = BaseTableCell.extend({
  addAttributes() {
    return { ...this.parent?.(), ...alignmentAttribute() }
  },
})

/** The slice of `tiptap-markdown`'s serializer state this file needs. */
interface IMarkdownState {
  out: string
  inTable: boolean
  write(content: string): void
  ensureNewLine(): void
  closeBlock(node: PMNode): void
  renderInline(node: PMNode): void
}

/**
 * Every textblock inside a cell, in order.
 *
 * A GFM cell is one line of inline content, so a cell holding a list or two
 * paragraphs has to be reduced to one. Reducing it to its textblocks keeps the
 * words and loses only the block structure, which is the trade the storage
 * decision already made.
 */
function textblocksOf(cell: PMNode): PMNode[] {
  const blocks: PMNode[] = []
  cell.descendants((child) => {
    if (!child.isTextblock) return true
    blocks.push(child)
    return false
  })
  return blocks
}

/**
 * Written content is escaped after the fact rather than during rendering.
 *
 * By the time a cell has been rendered, every `|` left in the output is a
 * literal the author typed: the serializer's own syntax never produces one.
 * That includes pipes inside a code span, which GFM also requires escaping,
 * and which is exactly the case a pre-render escape would have missed.
 */
function escapeCell(rendered: string): string {
  return rendered.replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|')
}

function renderCell(state: IMarkdownState, cell: PMNode): void {
  const start = state.out.length
  for (const block of textblocksOf(cell)) {
    if (!block.textContent.trim()) continue
    // A separator only once something is there, or a cell whose first block is
    // empty would be written with a leading space it never had.
    if (state.out.length > start) state.out += ' '
    state.renderInline(block)
  }
  state.out = state.out.slice(0, start) + escapeCell(state.out.slice(start))
}

/** One alignment per column, taken from the header row GFM will write. */
function columnAlignments(
  table: PMNode,
  map: TableMap,
): (TTableAlignment | null)[] {
  const alignments: (TTableAlignment | null)[] = []
  for (let column = 0; column < map.width; column++) {
    const cell = table.nodeAt(map.map[column])
    const value = cell?.attrs.alignment
    alignments.push(isAlignment(value) ? value : null)
  }
  return alignments
}

function serializeTable(
  this: unknown,
  state: IMarkdownState,
  node: PMNode,
): void {
  const map = TableMap.get(node)
  const alignments = columnAlignments(node, map)
  // Which cells have already been written, so the second half of a merged
  // cell writes an empty column rather than repeating the content.
  const written = new Set<number>()

  state.inTable = true
  for (let row = 0; row < map.height; row++) {
    state.write('| ')
    for (let column = 0; column < map.width; column++) {
      if (column > 0) state.write(' | ')
      const at = map.map[row * map.width + column]
      if (written.has(at)) continue
      written.add(at)
      const cell = node.nodeAt(at)
      if (cell) renderCell(state, cell)
    }
    state.write(' |')
    state.ensureNewLine()
    if (row === 0) {
      state.write(`| ${alignments.map(alignmentDelimiter).join(' | ')} |`)
      state.ensureNewLine()
    }
  }
  state.closeBlock(node)
  state.inTable = false
}

/** The table containing `pos`, or the one containing the selection. */
function tableAround(
  state: EditorState,
  pos?: number,
): { table: PMNode; start: number } | null {
  if (pos !== undefined) {
    const $pos = state.doc.resolve(
      Math.min(Math.max(pos, 0), state.doc.content.size),
    )
    for (let depth = $pos.depth; depth > 0; depth--) {
      const node = $pos.node(depth)
      if (node.type.spec.tableRole === 'table')
        return { table: node, start: $pos.start(depth) }
    }
    const node = state.doc.nodeAt($pos.pos)
    if (node?.type.spec.tableRole === 'table')
      return { table: node, start: $pos.pos + 1 }
    return null
  }
  const $from = state.selection.$from
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth)
    if (node.type.spec.tableRole === 'table')
      return { table: node, start: $from.start(depth) }
  }
  return null
}

/** Which row and column the current selection sits in, if it is in a table. */
export function tableSelectionIndex(
  state: EditorState,
): { row: number; column: number } | null {
  const found = tableAround(state)
  if (!found) return null
  const map = TableMap.get(found.table)
  const at = state.selection.$from.pos - found.start
  for (let index = 0; index < map.map.length; index++) {
    const cell = found.table.nodeAt(map.map[index])
    if (!cell) continue
    if (at >= map.map[index] && at <= map.map[index] + cell.nodeSize)
      return { row: Math.floor(index / map.width), column: index % map.width }
  }
  return null
}

/**
 * The alignment of the column the selection is in, for the controls to show
 * as pressed. The leftmost when several columns are selected, because GFM
 * stores one alignment per column and a mixed selection has to show something.
 */
export function selectedColumnAlignment(
  state: EditorState,
): TTableAlignment | null {
  const found = tableAround(state)
  if (!found) return null
  const map = TableMap.get(found.table)
  let column = tableSelectionIndex(state)?.column ?? null
  const selection = state.selection
  if (selection instanceof CellSelection) {
    const columns: number[] = []
    selection.forEachCell((_cell, pos) => {
      columns.push(map.colCount(pos - found.start))
    })
    if (columns.length > 0) column = Math.min(...columns)
  }
  if (column === null) return null
  const value = found.table.nodeAt(map.map[column])?.attrs.alignment
  return isAlignment(value) ? value : null
}

interface ITableIndexOptions {
  index: number
  /** A document position inside the table, when the selection is elsewhere. */
  pos?: number
}

interface ITableMoveOptions {
  from: number
  to: number
  pos?: number
}

declare module '@tiptap/core' {
  /* eslint-disable-next-line @typescript-eslint/naming-convention --
     Module augmentation: the name is Tiptap's, not ours. Prefixing it would
     declare a new interface instead of extending theirs, and the commands
     below would not exist as far as the type checker is concerned. */
  interface Commands<ReturnType> {
    actaTable: {
      /** Select a whole row, which is what a row grip does. */
      selectTableRow: (options: ITableIndexOptions) => ReturnType
      /** Select a whole column, which is what a column grip does. */
      selectTableColumn: (options: ITableIndexOptions) => ReturnType
      /**
       * Set the alignment of every column the selection touches. Per column
       * rather than per cell, because that is all GFM can write.
       */
      setColumnAlignment: (alignment: TTableAlignment | null) => ReturnType
      /** Reorder: move a row to another index. */
      moveTableRowTo: (options: ITableMoveOptions) => ReturnType
      /** Reorder: move a column to another index. */
      moveTableColumnTo: (options: ITableMoveOptions) => ReturnType
    }
  }
}

export const Table = BaseTable.extend({
  addStorage() {
    return {
      ...this.parent?.(),
      markdown: { serialize: serializeTable, parse: {} },
    }
  },

  addCommands() {
    return {
      ...this.parent?.(),

      selectTableRow:
        ({ index, pos }: ITableIndexOptions) =>
        ({ state, tr, dispatch }) => {
          const found = tableAround(state, pos)
          if (!found) return false
          const map = TableMap.get(found.table)
          if (index < 0 || index >= map.height) return false
          const cell = found.start + map.positionAt(index, 0, found.table)
          if (dispatch)
            dispatch(
              tr.setSelection(CellSelection.rowSelection(tr.doc.resolve(cell))),
            )
          return true
        },

      selectTableColumn:
        ({ index, pos }: ITableIndexOptions) =>
        ({ state, tr, dispatch }) => {
          const found = tableAround(state, pos)
          if (!found) return false
          const map = TableMap.get(found.table)
          if (index < 0 || index >= map.width) return false
          const cell = found.start + map.positionAt(0, index, found.table)
          if (dispatch)
            dispatch(
              tr.setSelection(CellSelection.colSelection(tr.doc.resolve(cell))),
            )
          return true
        },

      setColumnAlignment:
        (alignment: TTableAlignment | null) =>
        ({ state, tr, dispatch }) => {
          const found = tableAround(state)
          if (!found) return false
          const map = TableMap.get(found.table)
          const here = tableSelectionIndex(state)
          const selection = state.selection
          const columns = new Set<number>()
          if (selection instanceof CellSelection) {
            selection.forEachCell((_cell, pos) => {
              columns.add(map.colCount(pos - found.start))
            })
          } else if (here) {
            columns.add(here.column)
          }
          if (columns.size === 0) return false

          const touched = new Set<number>()
          for (const column of columns) {
            for (let row = 0; row < map.height; row++) {
              const at = map.map[row * map.width + column]
              if (touched.has(at)) continue
              touched.add(at)
              const cell = found.table.nodeAt(at)
              if (!cell || cell.attrs.alignment === alignment) continue
              tr.setNodeMarkup(found.start + at, undefined, {
                ...cell.attrs,
                alignment,
              })
            }
          }
          if (!tr.docChanged) return false
          if (dispatch) dispatch(tr)
          return true
        },

      moveTableRowTo:
        ({ from, to, pos }: ITableMoveOptions) =>
        ({ chain }) =>
          chain()
            .selectTableRow({ index: from, pos })
            .command(({ state, dispatch }) =>
              moveTableRow({ from, to, select: true })(state, dispatch),
            )
            .run(),

      moveTableColumnTo:
        ({ from, to, pos }: ITableMoveOptions) =>
        ({ chain }) =>
          chain()
            .selectTableColumn({ index: from, pos })
            .command(({ state, dispatch }) =>
              moveTableColumn({ from, to, select: true })(state, dispatch),
            )
            .run(),
    }
  },

  /**
   * The keyboard path.
   *
   * Grips are a mouse affordance, and a table that can only be edited with a
   * mouse is not finished. Every grip action has a shortcut here, and every
   * one of them declines (returns false) outside a table, so none of them
   * shadows an editing key in ordinary prose.
   *
   * The selection pair is the spreadsheet convention people already know:
   * Ctrl/Cmd-Space selects the column, Shift-Space the row. Selecting is what
   * opens the inline controls, so the whole bar is reachable from the keyboard.
   */
  addKeyboardShortcuts() {
    const inTable = () => this.editor.isActive('table')
    const run = (fn: () => boolean) => () => (inTable() ? fn() : false)
    const commands = () => this.editor.commands
    const here = () => tableSelectionIndex(this.editor.state)

    return {
      ...this.parent?.(),

      'Mod-Space': run(() => {
        const at = here()
        return at ? commands().selectTableColumn({ index: at.column }) : false
      }),
      'Shift-Space': run(() => {
        const at = here()
        return at ? commands().selectTableRow({ index: at.row }) : false
      }),

      'Mod-Alt-ArrowUp': run(() => commands().addRowBefore()),
      'Mod-Alt-ArrowDown': run(() => commands().addRowAfter()),
      'Mod-Alt-ArrowLeft': run(() => commands().addColumnBefore()),
      'Mod-Alt-ArrowRight': run(() => commands().addColumnAfter()),

      'Mod-Alt-Backspace': run(() => commands().deleteRow()),
      'Mod-Alt-Shift-Backspace': run(() => commands().deleteColumn()),

      'Mod-Shift-l': run(() => commands().setColumnAlignment('left')),
      'Mod-Shift-e': run(() => commands().setColumnAlignment('center')),
      'Mod-Shift-r': run(() => commands().setColumnAlignment('right')),
      'Mod-Shift-0': run(() => commands().setColumnAlignment(null)),

      // Reorder without a mouse. Same modifier as insert, plus Shift, so the
      // arrow keys read as one family: insert beside, or move there.
      'Mod-Alt-Shift-ArrowUp': run(() => {
        const at = here()
        return at && at.row > 0
          ? commands().moveTableRowTo({ from: at.row, to: at.row - 1 })
          : false
      }),
      'Mod-Alt-Shift-ArrowDown': run(() => {
        const at = here()
        return at
          ? commands().moveTableRowTo({ from: at.row, to: at.row + 1 })
          : false
      }),
      'Mod-Alt-Shift-ArrowLeft': run(() => {
        const at = here()
        return at && at.column > 0
          ? commands().moveTableColumnTo({
              from: at.column,
              to: at.column - 1,
            })
          : false
      }),
      'Mod-Alt-Shift-ArrowRight': run(() => {
        const at = here()
        return at
          ? commands().moveTableColumnTo({
              from: at.column,
              to: at.column + 1,
            })
          : false
      }),
    }
  },
})
