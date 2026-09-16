/**
 * Whole-block operations for the grip menu: move, duplicate, delete, and turn
 * one kind of block into another.
 *
 * Top-level blocks only. A top-level block is the unit markdown itself is made
 * of (each one is separated from the next by a blank line), so any of them can
 * be moved, copied or removed and the file is still a valid sequence of
 * blocks. A block nested in a list item, a callout, a toggle or a table cell
 * is not free in the same way: a list item must open with a paragraph, a cell
 * holds nothing but inline text, and a toggle title is plain text. Focus mode
 * already treats the top-level block as the unit somebody is working on (see
 * focusMode.ts), and this follows it.
 *
 * Every function takes a state and an optional `dispatch`, the way ProseMirror
 * commands do, so a caller can ask whether something is possible without
 * doing it, and a test can run it against a bare state.
 *
 * Nothing here touches markdown directly. What it guarantees instead is that
 * the document it leaves behind is one the serializer writes back and the
 * parser reads in as the same document. The one place that took work is
 * adjacent lists, see `joinAdjacentLists`.
 */
import { Fragment, type Node as PMNode, type Schema } from '@tiptap/pm/model'
import {
  TextSelection,
  type EditorState,
  type Transaction,
} from '@tiptap/pm/state'
import { CALLOUT_KINDS } from '@/lib/callouts'

export type TDispatch = (tr: Transaction) => void

/** A top-level block: where it starts, and the node. */
export interface ITopBlock {
  index: number
  pos: number
  node: PMNode
}

export function topBlock(doc: PMNode, index: number): ITopBlock | null {
  if (index < 0 || index >= doc.childCount) return null
  let pos = 0
  for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize
  return { index, pos, node: doc.child(index) }
}

/** Which top-level block a document position falls in. */
export function topBlockIndexAt(doc: PMNode, pos: number): number {
  const clamped = Math.max(0, Math.min(pos, doc.content.size))
  return doc.resolve(clamped).index(0)
}

// ---------------------------------------------------------------------------
// Lists that touch
// ---------------------------------------------------------------------------

const LIST_TYPES = new Set(['bulletList', 'orderedList', 'taskList'])

/**
 * Two lists of the same kind next to each other become one.
 *
 * Markdown cannot write two adjacent bullet lists: whatever separates them,
 * `- a` followed by `- b` is read back as one list. Measured with this
 * editor's own parser, `- a\n- b\n\n\n- c` comes back as a single loose list.
 * So a move, a delete or a conversion that leaves two such lists touching
 * would show two lists now and one after the next save, which is the editor
 * disagreeing with the file. Joining them in the same transaction shows what
 * the file will say.
 */
function joinAdjacentLists(tr: Transaction): void {
  for (let i = tr.doc.childCount - 1; i > 0; i--) {
    const before = tr.doc.child(i - 1)
    const after = tr.doc.child(i)
    if (before.type !== after.type || !LIST_TYPES.has(after.type.name)) continue
    let pos = 0
    for (let j = 0; j < i; j++) pos += tr.doc.child(j).nodeSize
    tr.join(pos)
  }
}

/** Puts the caret inside the block that now sits at `index`. */
function selectBlock(tr: Transaction, index: number): void {
  const block = topBlock(tr.doc, Math.min(index, tr.doc.childCount - 1))
  if (!block) return
  tr.setSelection(TextSelection.near(tr.doc.resolve(block.pos + 1)))
}

// ---------------------------------------------------------------------------
// Move, duplicate, delete
// ---------------------------------------------------------------------------

/**
 * Moves block `from` so that it ends up at index `to`.
 *
 * `to` is the block's index AFTER the move, which is what a keyboard step
 * ("one up") and a drop ("between the second and third") both reduce to.
 */
export function moveBlock(
  state: EditorState,
  from: number,
  to: number,
  dispatch?: TDispatch,
): boolean {
  const block = topBlock(state.doc, from)
  const count = state.doc.childCount
  if (!block || to < 0 || to >= count || to === from) return false
  if (dispatch) {
    const tr = state.tr.delete(block.pos, block.pos + block.node.nodeSize)
    const target = topBlock(tr.doc, to)
    const at = target ? target.pos : tr.doc.content.size
    tr.insert(at, block.node)
    selectBlock(tr, to)
    joinAdjacentLists(tr)
    dispatch(tr.scrollIntoView())
  }
  return true
}

/** A copy of the block, directly below it. */
export function duplicateBlock(
  state: EditorState,
  index: number,
  dispatch?: TDispatch,
): boolean {
  const block = topBlock(state.doc, index)
  if (!block) return false
  if (dispatch) {
    const tr = state.tr.insert(block.pos + block.node.nodeSize, block.node)
    selectBlock(tr, index + 1)
    joinAdjacentLists(tr)
    dispatch(tr.scrollIntoView())
  }
  return true
}

/**
 * Removes the block. The last block in a document is replaced by an empty
 * paragraph rather than removed, because a document is never empty of blocks.
 */
export function deleteBlock(
  state: EditorState,
  index: number,
  dispatch?: TDispatch,
): boolean {
  const block = topBlock(state.doc, index)
  if (!block) return false
  if (dispatch) {
    const end = block.pos + block.node.nodeSize
    const tr =
      state.doc.childCount === 1
        ? state.tr.replaceWith(
            block.pos,
            end,
            state.schema.nodes.paragraph.create(),
          )
        : state.tr.delete(block.pos, end)
    joinAdjacentLists(tr)
    selectBlock(tr, index)
    dispatch(tr.scrollIntoView())
  }
  return true
}

// ---------------------------------------------------------------------------
// Turn into
// ---------------------------------------------------------------------------

export type TBlockKind =
  | 'paragraph'
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'heading4'
  | 'bulletList'
  | 'orderedList'
  | 'taskList'
  | 'blockquote'
  | `callout:${string}`
  | 'codeBlock'
  | 'details'

export interface IBlockConversion {
  target: TBlockKind
  label: string
  icon: string
  /**
   * Set when the conversion keeps the words but not everything else, and
   * says what goes. Conversions that would lose words are never offered.
   */
  warning?: string
}

const CALLOUT_LABEL: Record<string, string> = {
  note: 'Note callout',
  info: 'Info callout',
  tip: 'Tip callout',
  warning: 'Warning callout',
  danger: 'Danger callout',
}

const CALLOUT_ICON: Record<string, string> = {
  note: 'note',
  info: 'info',
  tip: 'lightbulb',
  warning: 'warning',
  danger: 'warning-octagon',
}

/** Every target, in the order the menu shows them. */
export const BLOCK_TARGETS: {
  target: TBlockKind
  label: string
  icon: string
}[] = [
  { target: 'paragraph', label: 'Paragraph', icon: 'text-t' },
  { target: 'heading1', label: 'Heading 1', icon: 'text-h-one' },
  { target: 'heading2', label: 'Heading 2', icon: 'text-h-two' },
  { target: 'heading3', label: 'Heading 3', icon: 'text-h-three' },
  { target: 'heading4', label: 'Heading 4', icon: 'text-h-four' },
  { target: 'bulletList', label: 'Bullet list', icon: 'list-bullets' },
  { target: 'orderedList', label: 'Numbered list', icon: 'list-numbers' },
  { target: 'taskList', label: 'Task list', icon: 'list-checks' },
  { target: 'blockquote', label: 'Quote', icon: 'quotes' },
  ...CALLOUT_KINDS.map((kind) => ({
    target: `callout:${kind}` as TBlockKind,
    label: CALLOUT_LABEL[kind] ?? `${kind} callout`,
    icon: CALLOUT_ICON[kind] ?? 'info',
  })),
  { target: 'codeBlock', label: 'Code block', icon: 'code-block' },
  { target: 'details', label: 'Toggle', icon: 'caret-circle-right' },
]

/** What kind a block is, or null for the kinds that cannot be converted. */
export function blockKind(node: PMNode): TBlockKind | null {
  switch (node.type.name) {
    case 'paragraph':
      return 'paragraph'
    case 'heading': {
      const level = Number(node.attrs.level)
      return level >= 1 && level <= 4 ? (`heading${level}` as TBlockKind) : null
    }
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
    case 'blockquote':
    case 'details':
      return node.type.name
    case 'callout':
      return `callout:${String(node.attrs.kind ?? 'note')}`
    case 'codeBlock':
      // A diagram is a code block to the schema, and a picture to the person
      // who wrote it. Turning it into prose would be turning it into source.
      return node.attrs.language === 'mermaid' ? null : 'codeBlock'
    default:
      // Tables, images, maths, link cards and rules: none of them has an
      // equivalent that keeps what they are, so nothing is offered.
      return null
  }
}

function isPlainInline(node: PMNode): boolean {
  let plain = true
  node.content.forEach((child) => {
    if (!child.isText || child.marks.length > 0) plain = false
  })
  return plain
}

/**
 * Whether code can become prose without losing anything: one line, and no
 * indentation for markdown to swallow. Several lines would be folded into one
 * paragraph, and leading spaces are not kept in a paragraph at all.
 */
function codeFitsProse(node: PMNode): boolean {
  const text = node.textContent
  return !text.includes('\n') && text === text.trim()
}

/** Whether a textblock holds a line break, which a heading cannot. */
function hasHardBreak(node: PMNode): boolean {
  let found = false
  node.forEach((child) => {
    if (child.type.name === 'hardBreak') found = true
  })
  return found
}

/** A textblock's text as code: line breaks become newlines. */
function codeTextOf(node: PMNode): string {
  if (node.type.name === 'codeBlock') return node.textContent
  let text = ''
  node.forEach((child) => {
    if (child.type.name === 'hardBreak') text += '\n'
    else text += child.textContent
  })
  return text
}

/** A textblock's content as paragraph content. */
function inlineOf(node: PMNode, schema: Schema): Fragment {
  if (node.type.name !== 'codeBlock') return node.content
  return node.textContent
    ? Fragment.from(schema.text(node.textContent))
    : Fragment.empty
}

function paragraphOf(node: PMNode, schema: Schema): PMNode {
  if (node.type.name === 'paragraph') return node
  return schema.nodes.paragraph.create(null, inlineOf(node, schema))
}

/** The blocks inside a container, with its title turned into a paragraph. */
function childrenOf(node: PMNode, schema: Schema): PMNode[] {
  const out: PMNode[] = []
  if (node.type.name === 'details') {
    const title = node.firstChild?.textContent ?? ''
    if (title) out.push(schema.nodes.paragraph.create(null, schema.text(title)))
    node.lastChild?.forEach((child) => {
      // The empty paragraph a toggle with no body carries, which is a schema
      // requirement rather than anything somebody wrote.
      if (child.type.name === 'paragraph' && child.content.size === 0) return
      out.push(child)
    })
    return out
  }
  if (node.type.name === 'callout') {
    const title = String(node.attrs.title ?? '')
    if (title) out.push(schema.nodes.paragraph.create(null, schema.text(title)))
  }
  node.forEach((child) => out.push(child))
  return out
}

/** The paragraphs of a list whose items are each one paragraph, or null. */
function flatListParagraphs(node: PMNode): PMNode[] | null {
  const out: PMNode[] = []
  let flat = true
  node.forEach((item) => {
    if (item.childCount !== 1 || item.firstChild?.type.name !== 'paragraph')
      flat = false
    else out.push(item.firstChild)
  })
  return flat ? out : null
}

/** The replacement for `node` as `target`, or null when there is none. */
function convert(
  node: PMNode,
  target: TBlockKind,
  schema: Schema,
): PMNode[] | null {
  const n = schema.nodes
  const name = node.type.name
  const isList = LIST_TYPES.has(name)
  const isContainer =
    name === 'blockquote' || name === 'callout' || name === 'details'

  // Into a textblock.
  if (target === 'paragraph') {
    if (node.isTextblock) {
      if (name === 'codeBlock' && !codeFitsProse(node)) return null
      return [paragraphOf(node, schema)]
    }
    if (isList) return flatListParagraphs(node)
    if (isContainer) {
      const children = childrenOf(node, schema)
      return children.length > 0 ? children : [n.paragraph.create()]
    }
    return null
  }

  if (target.startsWith('heading') || target === 'codeBlock') {
    let source: PMNode | null = node.isTextblock ? node : null
    if (!source && isContainer) {
      const children = childrenOf(node, schema)
      if (children.length === 1 && children[0].isTextblock) source = children[0]
    }
    if (!source && isList) {
      const items = flatListParagraphs(node)
      if (items && items.length === 1) source = items[0]
    }
    if (!source) return null
    if (target === 'codeBlock') {
      const text = codeTextOf(source)
      return [n.codeBlock.create(null, text ? schema.text(text) : null)]
    }
    // A heading is one line of prose.
    if (source.type.name === 'codeBlock' && !codeFitsProse(source)) return null
    if (hasHardBreak(source)) return null
    return [
      n.heading.create(
        { level: Number(target.slice('heading'.length)) },
        inlineOf(source, schema),
      ),
    ]
  }

  // Into a list.
  if (
    target === 'bulletList' ||
    target === 'orderedList' ||
    target === 'taskList'
  ) {
    const item = target === 'taskList' ? n.taskItem : n.listItem
    const list = n[target]
    if (isList) {
      const items: PMNode[] = []
      node.forEach((child) => {
        const attrs = target === 'taskList' ? { checked: false } : null
        items.push(item.create(attrs, child.content))
      })
      return [
        list.create(
          target === 'orderedList' ? { start: node.attrs.start ?? 1 } : null,
          items,
        ),
      ]
    }
    let paragraphs: PMNode[] | null = null
    if (node.isTextblock) {
      if (name === 'codeBlock' && !codeFitsProse(node)) return null
      paragraphs = [paragraphOf(node, schema)]
    } else if (isContainer) {
      const children = childrenOf(node, schema)
      const prose = (c: PMNode) =>
        c.isTextblock && (c.type.name !== 'codeBlock' || codeFitsProse(c))
      if (children.length > 0 && children.every(prose))
        paragraphs = children.map((c) => paragraphOf(c, schema))
    }
    if (!paragraphs) return null
    return [
      list.create(
        null,
        paragraphs.map((p) =>
          item.create(target === 'taskList' ? { checked: false } : null, p),
        ),
      ),
    ]
  }

  // Into a container.
  const blocks = isContainer ? childrenOf(node, schema) : [node]
  const body = blocks.length > 0 ? blocks : [n.paragraph.create()]

  if (target === 'blockquote') return [n.blockquote.create(null, body)]

  if (target.startsWith('callout:')) {
    const kind = target.slice('callout:'.length)
    if (name === 'callout')
      // Another style of the same callout: the title stays a title.
      return [node.type.create({ ...node.attrs, kind }, node.content)]
    return [n.callout.create({ kind }, body)]
  }

  if (target === 'details') {
    let title = ''
    let rest = body
    const first = blocks[0]
    // The first line becomes the title when it can be one: a title is plain
    // text, so a paragraph with bold or a link in it stays in the body.
    if (
      first &&
      first.type.name !== 'codeBlock' &&
      first.isTextblock &&
      isPlainInline(first) &&
      first.textContent
    ) {
      title = first.textContent
      rest = blocks.slice(1)
    }
    return [
      n.details.create(null, [
        n.detailsSummary.create(null, title ? schema.text(title) : null),
        n.detailsContent.create(
          null,
          rest.length > 0 ? rest : [n.paragraph.create()],
        ),
      ]),
    ]
  }

  return null
}

/**
 * What a block holds that a person would miss: its words, its formatting, the
 * things embedded in it and which of its tasks were ticked. Compared before
 * and after a conversion to decide whether it is offered, and with a warning.
 */
function contentOf(nodes: PMNode[]): {
  text: string
  marks: number
  atoms: number
  checked: number
} {
  let text = ''
  let marks = 0
  let atoms = 0
  let checked = 0
  const visit = (node: PMNode) => {
    if (node.isText) {
      text += node.text
      marks += node.marks.length
      return
    }
    if (node.type.name === 'taskItem' && node.attrs.checked) checked += 1
    // A callout's title is an attribute, and still words somebody wrote.
    if (node.type.name === 'callout' && node.attrs.title)
      text += ` ${String(node.attrs.title)} `
    if (node.type.name === 'hardBreak') text += ' '
    else if (node.isAtom) atoms += 1
    if (node.isBlock) text += ' '
    node.forEach(visit)
  }
  nodes.forEach(visit)
  return { text: text.replace(/\s+/g, ' ').trim(), marks, atoms, checked }
}

function sameBlocks(a: PMNode, b: PMNode[]): boolean {
  return b.length === 1 && a.eq(b[0])
}

/**
 * The conversions offered for block `index`, each checked by actually doing it.
 *
 * A conversion that would lose words is left out. One that keeps the words
 * but drops formatting, an embedded reference or a ticked box is offered with
 * a warning that says so. The block's own kind is left out, since turning a
 * paragraph into a paragraph is not a choice.
 */
export function blockConversions(
  state: EditorState,
  index: number,
): IBlockConversion[] {
  const block = topBlock(state.doc, index)
  if (!block) return []
  const kind = blockKind(block.node)
  if (!kind) return []
  const before = contentOf([block.node])
  const out: IBlockConversion[] = []
  for (const option of BLOCK_TARGETS) {
    if (option.target === kind) continue
    const made = safeConvert(block.node, option.target, state.schema)
    if (!made || sameBlocks(block.node, made)) continue
    const after = contentOf(made)
    if (after.text !== before.text) continue
    const lost: string[] = []
    if (after.marks < before.marks || after.atoms < before.atoms)
      lost.push('removes formatting')
    if (after.checked < before.checked) lost.push('clears ticked tasks')
    out.push(lost.length > 0 ? { ...option, warning: lost.join(', ') } : option)
  }
  return out
}

function safeConvert(
  node: PMNode,
  target: TBlockKind,
  schema: Schema,
): PMNode[] | null {
  try {
    const made = convert(node, target, schema)
    if (!made || made.length === 0) return null
    for (const m of made) m.check()
    return made
  } catch {
    return null
  }
}

/** Turns block `index` into `target`, when that is one of its conversions. */
export function convertBlock(
  state: EditorState,
  index: number,
  target: TBlockKind,
  dispatch?: TDispatch,
): boolean {
  const block = topBlock(state.doc, index)
  if (!block) return false
  if (!blockConversions(state, index).some((c) => c.target === target))
    return false
  const made = safeConvert(block.node, target, state.schema)
  if (!made) return false
  if (dispatch) {
    const tr = state.tr.replaceWith(
      block.pos,
      block.pos + block.node.nodeSize,
      made,
    )
    selectBlock(tr, index)
    joinAdjacentLists(tr)
    dispatch(tr.scrollIntoView())
  }
  return true
}

/**
 * Where a new block goes, below block `index`: an empty paragraph, with the
 * caret in it. Used by the insert menu only once something has been chosen,
 * so opening and closing that menu writes nothing.
 */
export function insertParagraphBelow(
  state: EditorState,
  index: number,
  dispatch?: TDispatch,
): boolean {
  const block = topBlock(state.doc, index)
  if (!block) return false
  if (dispatch) {
    const at = block.pos + block.node.nodeSize
    const tr = state.tr.insert(at, state.schema.nodes.paragraph.create())
    tr.setSelection(TextSelection.create(tr.doc, at + 1))
    dispatch(tr)
  }
  return true
}
