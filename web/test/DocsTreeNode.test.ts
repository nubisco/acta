/**
 * Leaf pages in the documents tree.
 *
 * NbTreeNode treats a node as a branch only when its slot renders a child, so
 * a page with no subpages has no caret, no toggle and no aria-expanded. Every
 * page is still `droppable`, so a page can be dropped inside one that has no
 * subpages yet.
 */
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import { NbTree } from '@nubisco/ui'
import DocsTreeNode from '@/components/DocsTreeNode.vue'
import type { IDocTreeNode } from '@/types/docs'

const leaf = (slug: string, title: string): IDocTreeNode => ({
  slug,
  title,
  children: [],
})

function renderTree(nodes: { value: IDocTreeNode[] }) {
  return mount(
    defineComponent({
      setup: () => () =>
        h(NbTree, { draggable: true }, () =>
          nodes.value.map((node) => h(DocsTreeNode, { key: node.slug, node })),
        ),
    }),
    { attachTo: document.body },
  )
}

const rowOf = (slug: string): HTMLElement =>
  Array.from(document.body.querySelectorAll<HTMLElement>('li[data-slug]')).find(
    (li) => li.dataset.slug === slug,
  )!

const hasCaret = (slug: string): boolean =>
  !!rowOf(slug).querySelector(
    ':scope > .nb-tree-node__label .nb-tree-node__toggle',
  )

describe('DocsTreeNode leaves', () => {
  it('shows a caret only on pages with subpages', () => {
    const view = renderTree(
      ref([
        leaf('my-first-doc', 'my first doc'),
        {
          slug: 'nubisco-home',
          title: 'Nubisco Home',
          children: [leaf('marketing', 'Marketing')],
        },
        leaf('archive', 'Archive'),
      ]),
    )
    for (const slug of ['my-first-doc', 'archive']) {
      expect(hasCaret(slug)).toBe(false)
      expect(rowOf(slug).hasAttribute('aria-expanded')).toBe(false)
      expect(rowOf(slug).classList).toContain('nb-tree-node--leaf')
    }
    expect(hasCaret('nubisco-home')).toBe(true)
    expect(rowOf('nubisco-home').hasAttribute('aria-expanded')).toBe(true)
    view.unmount()
  })

  it('grows a caret when a page gains a subpage, without remounting', async () => {
    const nodes = ref([leaf('archive', 'Archive')])
    const view = renderTree(nodes)
    const before = rowOf('archive')
    expect(hasCaret('archive')).toBe(false)
    nodes.value = [
      { ...nodes.value[0], children: [leaf('archive/2025', '2025')] },
    ]
    await nextTick()
    expect(rowOf('archive')).toBe(before)
    expect(hasCaret('archive')).toBe(true)
    expect(rowOf('archive').classList).toContain('nb-tree-node--branch')
    view.unmount()
  })

  it('keeps a leaf a valid drop target inside it', async () => {
    const view = renderTree(
      ref([leaf('runbook', 'Runbook'), leaf('archive', 'Archive')]),
    )
    const target = rowOf('archive')
    const label = target.querySelector<HTMLElement>('.nb-tree-node__label')!
    vi.spyOn(label, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      height: 24,
      bottom: 24,
      left: 0,
      right: 200,
      width: 200,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })
    const fire = (el: Element, type: string, clientY = 0) => {
      const event = new Event(type, { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'clientY', { value: clientY })
      Object.defineProperty(event, 'dataTransfer', {
        value: { setData: () => undefined, effectAllowed: '', dropEffect: '' },
      })
      el.dispatchEvent(event)
    }
    fire(rowOf('runbook'), 'dragstart')
    await nextTick()
    // The middle of the row: "inside" on a droppable node, "before" or
    // "after" on a plain leaf.
    fire(label, 'dragover', 12)
    await nextTick()
    expect(target.classList).toContain('nb-tree-node--drop-inside')
    expect(hasCaret('archive')).toBe(false)
    view.unmount()
  })
})
