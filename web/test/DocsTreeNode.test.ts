/**
 * Leaf pages in the documents tree.
 *
 * Two library behaviours pull against each other (@nubisco/ui 5.3.0):
 * NbTreeNode draws an expand caret for any row given a children slot, and it
 * only accepts a drop *inside* a row that has one. A page must be droppable
 * into a page with no subpages yet, so every row keeps the slot, and a leaf is
 * marked `data-leaf` so its caret can be hidden. jsdom applies no component
 * CSS, so this asserts the marking. The hidden caret is checked in a browser.
 */
import { describe, expect, it } from 'vitest'
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
        h(NbTree, null, () =>
          nodes.value.map((node) => h(DocsTreeNode, { key: node.slug, node })),
        ),
    }),
    { attachTo: document.body },
  )
}

const leaves = (view: ReturnType<typeof renderTree>) =>
  view.findAll('[data-leaf="true"]').map((el) => el.attributes('data-slug'))

describe('DocsTreeNode leaves', () => {
  it('marks only pages without subpages as leaves', () => {
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
    expect(leaves(view)).toEqual(['my-first-doc', 'archive'])
    view.unmount()
  })

  it('stops marking a page once it gains a subpage', async () => {
    const nodes = ref([leaf('archive', 'Archive')])
    const view = renderTree(nodes)
    expect(leaves(view)).toEqual(['archive'])
    nodes.value = [
      { ...nodes.value[0], children: [leaf('archive/2025', '2025')] },
    ]
    await nextTick()
    expect(leaves(view)).not.toContain('archive')
    view.unmount()
  })

  it('keeps a leaf a valid drop target inside it', () => {
    // The reason every row keeps the slot: the library offers "inside" only
    // on a row it considers a branch.
    const view = renderTree(ref([leaf('archive', 'Archive')]))
    const row = view.get('[data-slug="archive"]')
    expect(row.classes()).toContain('nb-tree-node--branch')
    view.unmount()
  })
})
