import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorState, Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { EditorView } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'
import { CellSelection, TableMap } from '@tiptap/pm/tables'

/**
 * Row and column grips.
 *
 * The affordance every table editor people already use has: a bar on the left
 * edge of a row and along the top of a column, appearing on hover. Clicking
 * one selects that band, and a selected band is what reveals the inline
 * controls (insert before, insert after, delete, alignment), which live in
 * MarkdownEditor.vue so they can be `@nubisco/ui` buttons rather than DOM this
 * file hand-rolls.
 *
 * Decorations rather than a node view. ProseMirror owns the table's DOM and
 * reconciles away anything written into it behind its back, and a grip put in
 * the document would be content the author never typed and the serializer
 * would write into the file. A widget decoration is neither: it never reaches
 * the document, and it is recomputed from the state, so grips follow the table
 * as it is edited.
 *
 * They sit inside the first cell of their band rather than floating over the
 * table. An overlay would need measured coordinates, which means it is wrong
 * for one frame after every edit and untestable without a layout engine. A
 * widget is positioned by CSS against the cell it belongs to, which is correct
 * by construction.
 */

export const tableGripsKey = new PluginKey<ITableGripsState>('acta-table-grips')

export type TGripKind = 'row' | 'column'

/** A grip being dragged: which band, and which table it belongs to. */
export interface IGripDrag {
  kind: TGripKind
  index: number
  /** The table's content start, which identifies the table in the document. */
  tableStart: number
}

interface ITableGripsState {
  decorations: DecorationSet
  drag: IGripDrag | null
}

/** The band the current selection covers, when it covers a whole one. */
function selectedBand(state: EditorState): {
  tableStart: number
  rows: [number, number] | null
  columns: [number, number] | null
} | null {
  const selection = state.selection
  if (!(selection instanceof CellSelection)) return null
  const tableStart = selection.$anchorCell.start(-1)
  const table = selection.$anchorCell.node(-1)
  const map = TableMap.get(table)
  const rect = map.rectBetween(
    selection.$anchorCell.pos - tableStart,
    selection.$headCell.pos - tableStart,
  )
  return {
    tableStart,
    rows: selection.isRowSelection() ? [rect.top, rect.bottom] : null,
    columns: selection.isColSelection() ? [rect.left, rect.right] : null,
  }
}

/**
 * Whether a whole row or a whole column is selected, which is the condition
 * the inline controls appear on. Both are true when the selection covers the
 * entire table, and both sets of controls are correct in that case.
 */
export function selectedTableBand(
  state: EditorState,
): { row: boolean; column: boolean } | null {
  const band = selectedBand(state)
  if (!band || (!band.rows && !band.columns)) return null
  return { row: !!band.rows, column: !!band.columns }
}

function grip(
  kind: TGripKind,
  index: number,
  label: string,
  active: boolean,
  dragging: boolean,
): HTMLElement {
  const element = document.createElement('button')
  element.type = 'button'
  element.className = `md-table__grip md-table__grip--${kind}`
  if (active) element.classList.add('is-active')
  if (dragging) element.classList.add('is-dragging')
  element.contentEditable = 'false'
  element.draggable = true
  element.tabIndex = -1
  element.setAttribute('data-table-grip', kind)
  element.setAttribute('data-index', String(index))
  element.setAttribute('aria-label', label)
  element.setAttribute('aria-pressed', String(active))
  return element
}

/**
 * Where a grip goes inside its cell.
 *
 * Inside the cell's first textblock when there is one, so the widget is inline
 * content the browser is happy to render, and directly inside the cell
 * otherwise (a cell holding a list, which a paste can produce).
 */
function gripPosition(cell: PMNode, cellPos: number): number {
  return cell.firstChild?.isTextblock ? cellPos + 2 : cellPos + 1
}

/**
 * Where the inline controls are rendered.
 *
 * An empty element, put in the selected band's first cell, that
 * MarkdownEditor.vue teleports its `@nubisco/ui` buttons into. The controls
 * therefore sit against the cell they act on with no measurement involved,
 * and they are still real library buttons rather than DOM this file drew.
 */
function controlsHost(kind: TGripKind): HTMLElement {
  const element = document.createElement('div')
  element.className = `md-table__controls md-table__controls--${kind}`
  element.contentEditable = 'false'
  element.setAttribute('data-table-controls', kind)
  return element
}

function build(state: EditorState, drag: IGripDrag | null): DecorationSet {
  const found: Decoration[] = []
  const band = selectedBand(state)

  state.doc.descendants((node, pos) => {
    if (node.type.spec.tableRole !== 'table') return true
    const map = TableMap.get(node)
    const tableStart = pos + 1
    const selected = band && band.tableStart === tableStart ? band : null

    for (let row = 0; row < map.height; row++) {
      const at = map.map[row * map.width]
      const cell = node.nodeAt(at)
      if (!cell) continue
      const active =
        !!selected?.rows && row >= selected.rows[0] && row < selected.rows[1]
      const held =
        drag?.kind === 'row' &&
        drag.index === row &&
        drag.tableStart === tableStart
      found.push(
        Decoration.widget(
          gripPosition(cell, tableStart + at),
          () => grip('row', row, `Row ${row + 1}`, active, held),
          {
            side: -1,
            key: `row-${row}-${active}-${held}`,
            ignoreSelection: true,
          },
        ),
      )
    }

    for (let column = 0; column < map.width; column++) {
      const at = map.map[column]
      const cell = node.nodeAt(at)
      if (!cell) continue
      const active =
        !!selected?.columns &&
        column >= selected.columns[0] &&
        column < selected.columns[1]
      const held =
        drag?.kind === 'column' &&
        drag.index === column &&
        drag.tableStart === tableStart
      found.push(
        Decoration.widget(
          gripPosition(cell, tableStart + at),
          () => grip('column', column, `Column ${column + 1}`, active, held),
          {
            side: -1,
            key: `column-${column}-${active}-${held}`,
            ignoreSelection: true,
          },
        ),
      )
    }
    // One host per selected band, in the first cell of it, which is where the
    // grip that opened it lives.
    if (selected?.rows) {
      const at = map.map[selected.rows[0] * map.width]
      const cell = node.nodeAt(at)
      if (cell)
        found.push(
          Decoration.widget(
            gripPosition(cell, tableStart + at),
            () => controlsHost('row'),
            { side: -1, key: 'controls-row', stopEvent: () => true },
          ),
        )
    }
    if (selected?.columns) {
      const at = map.map[selected.columns[0]]
      const cell = node.nodeAt(at)
      if (cell)
        found.push(
          Decoration.widget(
            gripPosition(cell, tableStart + at),
            () => controlsHost('column'),
            { side: -1, key: 'controls-column', stopEvent: () => true },
          ),
        )
    }

    // Nested tables are not a thing GFM can write, so there is nothing below.
    return false
  })

  return DecorationSet.create(state.doc, found)
}

/** The grip an event landed on, if it landed on one. */
function gripAt(
  target: EventTarget | null,
): { kind: TGripKind; index: number } | null {
  if (!(target instanceof Element)) return null
  const element = target.closest('[data-table-grip]')
  if (!(element instanceof HTMLElement)) return null
  const kind = element.getAttribute('data-table-grip')
  if (kind !== 'row' && kind !== 'column') return null
  return { kind, index: Number(element.getAttribute('data-index')) }
}

/** The table content start for a DOM node inside the editor. */
function tableStartAt(
  view: EditorView,
  target: EventTarget | null,
): number | null {
  if (!(target instanceof Node)) return null
  const pos = view.posAtDOM(target, 0)
  if (pos < 0) return null
  const $pos = view.state.doc.resolve(pos)
  for (let depth = $pos.depth; depth > 0; depth--) {
    if ($pos.node(depth).type.spec.tableRole === 'table')
      return $pos.start(depth)
  }
  return null
}

/** Which row and column a document position falls in. */
function cellIndexAt(
  state: EditorState,
  pos: number,
): { tableStart: number; row: number; column: number } | null {
  const $pos = state.doc.resolve(
    Math.min(Math.max(pos, 0), state.doc.content.size),
  )
  for (let depth = $pos.depth; depth > 0; depth--) {
    const node = $pos.node(depth)
    if (node.type.spec.tableRole !== 'table') continue
    // table > row > cell, so the cell is two levels in. A position resting on
    // the row itself has no cell to name, which is a drop between rows.
    if ($pos.depth < depth + 2) return null
    const tableStart = $pos.start(depth)
    const map = TableMap.get(node)
    const rect = map.findCell($pos.before(depth + 2) - tableStart)
    return { tableStart, row: rect.top, column: rect.left }
  }
  return null
}

export const TableGrips = Extension.create({
  name: 'tableGrips',

  addProseMirrorPlugins() {
    const editor = this.editor

    return [
      new Plugin<ITableGripsState>({
        key: tableGripsKey,

        state: {
          init: (_config, state) => ({
            decorations: build(state, null),
            drag: null,
          }),
          apply: (
            tr: Transaction,
            previous: ITableGripsState,
            _old: EditorState,
            next: EditorState,
          ) => {
            const meta = tr.getMeta(tableGripsKey) as
              { drag: IGripDrag | null } | undefined
            const drag = meta ? meta.drag : previous.drag
            // Grips carry the selected state, so a selection change rebuilds
            // them. Anything else leaves them alone.
            if (!tr.docChanged && !tr.selectionSet && !meta) return previous
            return { decorations: build(next, drag), drag }
          },
        },

        props: {
          decorations: (state) => tableGripsKey.getState(state)?.decorations,

          handleDOMEvents: {
            mousedown: (view, event) => {
              const hit = gripAt(event.target)
              if (!hit) return false
              const tableStart = tableStartAt(view, event.target)
              if (tableStart === null) return false
              // The grip owns the click: without this the caret lands in the
              // cell behind it and the band selection is thrown away.
              event.preventDefault()
              const options = { index: hit.index, pos: tableStart }
              if (hit.kind === 'row') editor.commands.selectTableRow(options)
              else editor.commands.selectTableColumn(options)
              return true
            },

            dragstart: (view, event) => {
              const hit = gripAt(event.target)
              if (!hit) return false
              const tableStart = tableStartAt(view, event.target)
              if (tableStart === null) return false
              const drag: IGripDrag = { ...hit, tableStart }
              // A payload is required or Firefox refuses to start the drag,
              // and the real payload is the plugin state, not the clipboard.
              event.dataTransfer?.setData('text/plain', '')
              if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
              view.dispatch(view.state.tr.setMeta(tableGripsKey, { drag }))
              return true
            },

            dragover: (view, event) => {
              if (!tableGripsKey.getState(view.state)?.drag) return false
              event.preventDefault()
              if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
              return true
            },

            dragend: (view) => {
              if (!tableGripsKey.getState(view.state)?.drag) return false
              view.dispatch(
                view.state.tr.setMeta(tableGripsKey, { drag: null }),
              )
              return false
            },
          },

          /**
           * Dropping a grip reorders, it does not insert.
           *
           * ProseMirror's own drop handling would paste the dragged slice,
           * which for a grip is the whole selected band appearing twice. So
           * this claims the drop whenever a grip started it.
           */
          handleDrop: (view, event) => {
            const drag = tableGripsKey.getState(view.state)?.drag
            if (!drag) return false
            event.preventDefault()
            const clear = view.state.tr.setMeta(tableGripsKey, { drag: null })
            const at = view.posAtCoords({
              left: (event as DragEvent).clientX,
              top: (event as DragEvent).clientY,
            })
            const target = at ? cellIndexAt(view.state, at.pos) : null
            view.dispatch(clear)
            if (!target || target.tableStart !== drag.tableStart) return true
            const to = drag.kind === 'row' ? target.row : target.column
            if (to === drag.index) return true
            if (drag.kind === 'row')
              editor.commands.moveTableRowTo({
                from: drag.index,
                to,
                pos: drag.tableStart,
              })
            else
              editor.commands.moveTableColumnTo({
                from: drag.index,
                to,
                pos: drag.tableStart,
              })
            return true
          },
        },
      }),
    ]
  },
})
