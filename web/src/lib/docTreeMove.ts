/**
 * Moving pages around the documents tree, as data.
 *
 * Both ways of moving a page use this: dragging it in the tree, and the
 * keyboard "Move page" dialog. It answers three questions without touching
 * the DOM or the network, which is what lets them be tested directly:
 *
 *  - is this a place the page may go (never into itself or its own subtree),
 *  - which `move` op says so, and
 *  - what the tree looks like afterwards, for the optimistic update.
 *
 * A move never changes a slug. The server keeps every slug as it was, so the
 * tree is keyed by slug before and after, and links to the page keep working.
 */
import type { TDocOp } from '@nubisco/acta-shared'
import type { IDocTreeNode } from '@/types/docs'

/** Where a page goes, relative to another page or to the top level. */
export type TMovePlacement =
  | { kind: 'inside'; target: string }
  | { kind: 'before'; target: string }
  | { kind: 'after'; target: string }
  | { kind: 'root' }

export type TMoveOp = Extract<TDocOp, { op: 'move' }>

export interface IMovePlan {
  op: TMoveOp
  tree: IDocTreeNode[]
}

interface ILocated {
  node: IDocTreeNode
  /** The list holding the node: the roots, or its parent's children. */
  siblings: IDocTreeNode[]
  parent: IDocTreeNode | null
}

function locate(
  nodes: IDocTreeNode[],
  slug: string,
  parent: IDocTreeNode | null = null,
): ILocated | null {
  for (const node of nodes) {
    if (node.slug === slug) return { node, siblings: nodes, parent }
    const found = locate(node.children, slug, node)
    if (found) return found
  }
  return null
}

/** The pages above `slug`, top level first. Empty for a root or a stranger. */
export function ancestorsOf(nodes: IDocTreeNode[], slug: string): string[] {
  for (const node of nodes) {
    if (node.slug === slug) return []
    const below = ancestorsOf(node.children, slug)
    if (below.length > 0 || node.children.some((c) => c.slug === slug))
      return [node.slug, ...below]
  }
  return []
}

/** The title of `slug`, or an empty string when it is not in the tree. */
export function findTitle(nodes: IDocTreeNode[], slug: string): string {
  return locate(nodes, slug)?.node.title ?? ''
}

/** `slug` and every page under it. */
export function subtreeOf(nodes: IDocTreeNode[], slug: string): Set<string> {
  const out = new Set<string>()
  const found = locate(nodes, slug)
  const walk = (node: IDocTreeNode) => {
    out.add(node.slug)
    node.children.forEach(walk)
  }
  if (found) walk(found.node)
  return out
}

/** Whether `target` is `source` itself or somewhere under it. */
export function isInvalidTarget(
  nodes: IDocTreeNode[],
  source: string,
  target: string,
): boolean {
  return subtreeOf(nodes, source).has(target)
}

function clone(nodes: IDocTreeNode[]): IDocTreeNode[] {
  return nodes.map((n) => ({ ...n, children: clone(n.children) }))
}

/**
 * The op and the resulting tree for moving `source` to `placement`, or null
 * when the move is refused (into its own subtree) or would change nothing.
 *
 * "Inside" appends as the last child. It is sent as `after` the current last
 * child when there is one, so a page already under that parent really moves to
 * the end instead of keeping its place. The top level works the same way.
 */
export function planMove(
  nodes: IDocTreeNode[],
  source: string,
  placement: TMovePlacement,
  opId: string,
): IMovePlan | null {
  const from = locate(nodes, source)
  if (!from) return null
  if (placement.kind !== 'root') {
    if (isInvalidTarget(nodes, source, placement.target)) return null
    if (!locate(nodes, placement.target)) return null
  }

  const tree = clone(nodes)
  const moving = locate(tree, source)!
  moving.siblings.splice(moving.siblings.indexOf(moving.node), 1)

  let op: TMoveOp
  if (placement.kind === 'root' || placement.kind === 'inside') {
    const list =
      placement.kind === 'root'
        ? tree
        : locate(tree, placement.target)!.node.children
    const last = list[list.length - 1]
    op = last
      ? { op: 'move', op_id: opId, ref: source, after: last.slug }
      : {
          op: 'move',
          op_id: opId,
          ref: source,
          parent: placement.kind === 'root' ? null : placement.target,
        }
    list.push(moving.node)
  } else {
    const anchor = locate(tree, placement.target)!
    const index = anchor.siblings.indexOf(anchor.node)
    anchor.siblings.splice(
      placement.kind === 'before' ? index : index + 1,
      0,
      moving.node,
    )
    op =
      placement.kind === 'before'
        ? { op: 'move', op_id: opId, ref: source, before: placement.target }
        : { op: 'move', op_id: opId, ref: source, after: placement.target }
  }

  const after = locate(tree, source)!
  const unchanged =
    after.parent?.slug === from.parent?.slug &&
    after.siblings.indexOf(after.node) === from.siblings.indexOf(from.node)
  return unchanged ? null : { op, tree }
}

/** A page where the "Move page" dialog can put `source`, in reading order. */
export interface IMoveTarget {
  slug: string
  title: string
  depth: number
}

/** Every page `source` may move under: all of them but itself and its subtree. */
export function moveTargets(
  nodes: IDocTreeNode[],
  source: string,
): IMoveTarget[] {
  const out: IMoveTarget[] = []
  const walk = (list: IDocTreeNode[], depth: number) => {
    for (const node of list) {
      if (node.slug === source) continue
      out.push({ slug: node.slug, title: node.title, depth })
      walk(node.children, depth + 1)
    }
  }
  walk(nodes, 0)
  return out
}

/** The API's flat, depth-ordered list rebuilt into nesting. */
export function nestDocs(
  rows: { slug: string; title: string; depth: number }[],
): IDocTreeNode[] {
  const roots: IDocTreeNode[] = []
  const stack: { node: IDocTreeNode; depth: number }[] = []
  for (const row of rows) {
    const node: IDocTreeNode = {
      slug: row.slug,
      title: row.title,
      children: [],
    }
    while (stack.length > 0 && stack[stack.length - 1].depth >= row.depth)
      stack.pop()
    if (stack.length === 0) roots.push(node)
    else stack[stack.length - 1].node.children.push(node)
    stack.push({ node, depth: row.depth })
  }
  return roots
}
