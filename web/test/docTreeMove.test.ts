/**
 * The tree-move rules, as data: which op a placement becomes, what the tree
 * looks like afterwards, and which targets are never allowed.
 */
import { describe, expect, it } from 'vitest'
import {
  ancestorsOf,
  isInvalidTarget,
  moveTargets,
  nestDocs,
  planMove,
} from '@/lib/docTreeMove'
import type { IDocTreeNode } from '@/types/docs'

const FLAT = [
  { slug: 'home', title: 'Nubisco Home', depth: 0 },
  { slug: 'home/manual', title: 'The Nubisco Manual', depth: 1 },
  { slug: 'home/manual/icons', title: 'Icon System', depth: 2 },
  { slug: 'home/manual/colour', title: 'Colour', depth: 2 },
  { slug: 'home/roadmap', title: 'Roadmap', depth: 1 },
  { slug: 'runbook', title: 'Runbook', depth: 0 },
  { slug: 'changelog', title: 'Changelog', depth: 0 },
]

/** `depth:slug` lines, the same shape the server tests use. */
function outline(nodes: IDocTreeNode[], depth = 0): string[] {
  return nodes.flatMap((n) => [
    `${depth}:${n.slug}`,
    ...outline(n.children, depth + 1),
  ])
}

const tree = () => nestDocs(FLAT)

describe('planMove', () => {
  it('inside a leaf sets the parent', () => {
    const plan = planMove(
      tree(),
      'runbook',
      { kind: 'inside', target: 'changelog' },
      'o1',
    )
    expect(plan?.op).toEqual({
      op: 'move',
      op_id: 'o1',
      ref: 'runbook',
      parent: 'changelog',
    })
    expect(outline(plan!.tree).slice(-2)).toEqual(['0:changelog', '1:runbook'])
  })

  it('inside a page with children goes after its last child', () => {
    const plan = planMove(
      tree(),
      'runbook',
      { kind: 'inside', target: 'home' },
      'o1',
    )
    expect(plan?.op).toMatchObject({ ref: 'runbook', after: 'home/roadmap' })
    expect(outline(plan!.tree)).toContain('1:runbook')
  })

  it('before and after name the sibling', () => {
    expect(
      planMove(tree(), 'changelog', { kind: 'before', target: 'home' }, 'o')
        ?.op,
    ).toMatchObject({ ref: 'changelog', before: 'home' })
    expect(
      planMove(
        tree(),
        'home/manual/icons',
        { kind: 'after', target: 'home/manual/colour' },
        'o',
      )?.op,
    ).toMatchObject({ ref: 'home/manual/icons', after: 'home/manual/colour' })
  })

  it('to the top level goes after the last root', () => {
    const plan = planMove(tree(), 'home/manual', { kind: 'root' }, 'o')
    expect(plan?.op).toMatchObject({ ref: 'home/manual', after: 'changelog' })
    expect(outline(plan!.tree).slice(-3)).toEqual([
      '0:home/manual',
      '1:home/manual/icons',
      '1:home/manual/colour',
    ])
  })

  it('refuses the page itself and anything under it', () => {
    for (const target of ['home', 'home/manual', 'home/manual/icons'])
      for (const kind of ['inside', 'before', 'after'] as const)
        expect(planMove(tree(), 'home', { kind, target }, 'o')).toBeNull()
    expect(isInvalidTarget(tree(), 'home', 'home/manual/colour')).toBe(true)
    expect(isInvalidTarget(tree(), 'home/manual', 'home')).toBe(false)
  })

  it('returns nothing for a drop that changes nothing', () => {
    expect(
      planMove(tree(), 'runbook', { kind: 'before', target: 'changelog' }, 'o'),
    ).toBeNull()
    expect(
      planMove(tree(), 'home/roadmap', { kind: 'inside', target: 'home' }, 'o'),
    ).toBeNull()
    expect(planMove(tree(), 'changelog', { kind: 'root' }, 'o')).toBeNull()
  })

  it('leaves the tree it was given untouched', () => {
    const before = tree()
    const snapshot = JSON.stringify(before)
    planMove(before, 'home', { kind: 'root' }, 'o')
    planMove(before, 'runbook', { kind: 'inside', target: 'home' }, 'o')
    expect(JSON.stringify(before)).toBe(snapshot)
  })
})

describe('tree helpers', () => {
  it('finds ancestors from the tree, not the slug', () => {
    const moved = planMove(
      tree(),
      'home/manual/icons',
      { kind: 'inside', target: 'runbook' },
      'o',
    )!.tree
    expect(ancestorsOf(moved, 'home/manual/icons')).toEqual(['runbook'])
    expect(ancestorsOf(tree(), 'home/manual/icons')).toEqual([
      'home',
      'home/manual',
    ])
  })

  it('offers every target but the page and its subtree', () => {
    expect(moveTargets(tree(), 'home/manual').map((t) => t.slug)).toEqual([
      'home',
      'home/roadmap',
      'runbook',
      'changelog',
    ])
  })
})
