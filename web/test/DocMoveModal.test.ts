/**
 * "Move page", the keyboard path for reorganising the tree.
 *
 * The same rule as dragging: a page can go under any page except itself and
 * the pages below it, or to the top level. The real keyboard walk (focus,
 * arrows, Enter, Tab to submit) is checked in a browser. Here: what is
 * offered, and which op each choice sends.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { NbSelect } from '@nubisco/ui'

const FLAT = [
  { slug: 'home', title: 'Nubisco Home', depth: 0 },
  { slug: 'home/manual', title: 'The Nubisco Manual', depth: 1 },
  { slug: 'home/manual/icons', title: 'Icon System', depth: 2 },
  { slug: 'home/roadmap', title: 'Roadmap', depth: 1 },
  { slug: 'runbook', title: 'Runbook', depth: 0 },
  { slug: 'changelog', title: 'Changelog', depth: 0 },
].map((d) => ({ ...d, rev: 1, updated: 0 }))

const docWrite = vi.fn(async (ops: unknown[]) => ({
  results: ops.map(() => ({ ok: true })),
}))

vi.mock('@/api/client', () => ({
  api: {
    docTree: vi.fn(async () => ({ docs: FLAT })),
    docWrite: (ops: unknown[]) => docWrite(ops),
  },
  newOpId: () => 'op-test',
  ApiHttpError: class extends Error {
    status = 0
  },
}))

import DocMoveModal from '@/components/DocMoveModal.vue'

const mounted: VueWrapper[] = []

beforeEach(() => {
  docWrite.mockClear()
})
afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
})

async function openFor(slug: string): Promise<VueWrapper> {
  const modal = mount(DocMoveModal, {
    props: { open: true, slug },
    attachTo: document.body,
  })
  mounted.push(modal)
  await flushPromises()
  return modal
}

function select(modal: VueWrapper) {
  return modal.findComponent(NbSelect)
}

async function submit(): Promise<void> {
  const form = document.getElementById('move-doc-form') as HTMLFormElement
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await flushPromises()
}

describe('Move page', () => {
  it('offers the top level and every page but itself and its subpages', async () => {
    const modal = await openFor('home/manual')
    const options = select(modal).props('options') as { value: string }[]
    expect(options.map((o) => o.value)).toEqual([
      ':top',
      'home',
      'home/roadmap',
      'runbook',
      'changelog',
    ])
    // Starts on where the page is now.
    expect(select(modal).props('modelValue')).toBe('home')
  })

  it('moves under the chosen page', async () => {
    const modal = await openFor('home/manual')
    await select(modal).vm.$emit('update:modelValue', 'runbook')
    await submit()
    expect(docWrite).toHaveBeenCalledWith([
      { op: 'move', op_id: 'op-test', ref: 'home/manual', parent: 'runbook' },
    ])
    expect(modal.emitted('moved')).toEqual([['home/manual']])
  })

  it('moves to the end of the top level', async () => {
    const modal = await openFor('home/manual/icons')
    await select(modal).vm.$emit('update:modelValue', ':top')
    await submit()
    expect(docWrite).toHaveBeenCalledWith([
      {
        op: 'move',
        op_id: 'op-test',
        ref: 'home/manual/icons',
        after: 'changelog',
      },
    ])
  })

  it('writes nothing when the parent is left as it was', async () => {
    const modal = await openFor('home/roadmap')
    await submit()
    expect(docWrite).not.toHaveBeenCalled()
    expect(modal.emitted('close')).toHaveLength(1)
  })

  it('shows a refusal in the dialog and stays open', async () => {
    docWrite.mockResolvedValueOnce({
      results: [{ ok: false, error: 'cannot move that there' } as never],
    })
    const modal = await openFor('runbook')
    await select(modal).vm.$emit('update:modelValue', 'changelog')
    await submit()
    expect(document.body.textContent).toContain('cannot move that there')
    expect(modal.emitted('moved')).toBeUndefined()
  })
})
