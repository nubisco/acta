/**
 * Reorganising the documents tree by dragging, on the real panel and the real
 * NbTree.
 *
 * jsdom has no drag and drop, so these dispatch the same events the browser
 * does (dragstart, dragover, drop, dragend) with the pointer placed in the
 * top, middle or bottom of a row. Real pointer drags need a real browser (see
 * the run-acta skill). What these pin down is the contract:
 * which op a drop sends, that a page can never be offered its own subtree,
 * that a refused move puts the tree back, and that a reader cannot drag.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { computed, nextTick, ref } from 'vue'

const FLAT = [
  { slug: 'home', title: 'Nubisco Home', depth: 0 },
  { slug: 'home/manual', title: 'The Nubisco Manual', depth: 1 },
  { slug: 'home/manual/icons', title: 'Icon System', depth: 2 },
  { slug: 'home/manual/colour', title: 'Colour', depth: 2 },
  { slug: 'home/roadmap', title: 'Roadmap', depth: 1 },
  { slug: 'runbook', title: 'Runbook', depth: 0 },
  { slug: 'changelog', title: 'Changelog', depth: 0 },
].map((d) => ({ ...d, rev: 1, updated: 0 }))

type TResult = { ok: boolean; error?: string }
const docWrite = vi.fn(
  async (ops: unknown[]): Promise<{ results: TResult[] }> => ({
    results: ops.map(() => ({ ok: true })),
  }),
)

const docTree = vi.fn(async () => ({ docs: FLAT }))

vi.mock('@/api/client', () => ({
  api: {
    docTree: () => docTree(),
    docWrite: (ops: unknown[]) => docWrite(ops),
  },
  newOpId: () => 'op-test',
  ApiHttpError: class extends Error {
    status = 0
  },
}))

vi.mock('@/lib/commands', () => ({ useViewCommands: () => undefined }))

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useRoute: () => ({ params: { slug: 'home/manual/icons' } }),
}))

vi.mock('@/components/NewDocModal.vue', () => ({
  default: { name: 'NewDocModalStub', render: () => null },
}))

const toastError = vi.fn()
vi.mock('@nubisco/ui', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    useToast: () => ({ error: toastError, success: vi.fn() }),
  }
})

const scopes = ref<string[]>(['read', 'write'])
const liveListeners: ((event: { entity: string; verb: string }) => void)[] = []
vi.mock('@/stores/workspace', () => ({
  useWorkspace: () => ({
    me: computed(() => ({ id: 'a', handle: 'jose', scopes: scopes.value })),
    onLive: (listener: (event: { entity: string; verb: string }) => void) => {
      liveListeners.push(listener)
      return () => liveListeners.splice(liveListeners.indexOf(listener), 1)
    },
  }),
}))

import DocsTreePanel from '@/components/DocsTreePanel.vue'

const ROW_HEIGHT = 24
const Y = { before: 2, inside: 12, after: 22 } as const

const mounted: VueWrapper[] = []

beforeEach(() => {
  docWrite.mockClear()
  docTree.mockClear()
  docTree.mockImplementation(async () => ({ docs: FLAT }))
  toastError.mockClear()
  scopes.value = ['read', 'write']
  // Every row is 24px tall at the top of its own box, so a pointer at 2, 12
  // or 22 lands in the before, inside or after band of whichever row it is on.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    top: 0,
    height: ROW_HEIGHT,
    bottom: ROW_HEIGHT,
    left: 0,
    right: 200,
    width: 200,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  })
  HTMLElement.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
  vi.restoreAllMocks()
})

async function openPanel(): Promise<VueWrapper> {
  const panel = mount(DocsTreePanel, { attachTo: document.body })
  mounted.push(panel)
  await flushPromises()
  await nextTick()
  await flushPromises()
  return panel
}

function row(_panel: VueWrapper, slug: string): HTMLElement {
  const el = Array.from(
    document.body.querySelectorAll<HTMLElement>('li[data-slug]'),
  ).find((li) => li.dataset.slug === slug)
  if (!el) throw new Error(`no row for ${slug}`)
  return el
}

function fire(
  target: Element,
  type: string,
  clientY = 0,
): { event: Event; prevented: boolean } {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clientY', { value: clientY })
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      effectAllowed: '',
      dropEffect: '',
      setData: () => undefined,
      getData: () => '',
    },
  })
  target.dispatchEvent(event)
  return { event, prevented: event.defaultPrevented }
}

/** The label row inside a node, which is where the pointer actually is. */
function label(li: HTMLElement): HTMLElement {
  return li.querySelector<HTMLElement>(':scope > .nb-tree-node__label')!
}

function lit(_panel: VueWrapper): string[] {
  return Array.from(
    document.body.querySelectorAll<HTMLElement>(
      '.nb-tree-node--drop-before, .nb-tree-node--drop-after, .nb-tree-node--drop-inside',
    ),
  ).map(
    (li) =>
      `${li.dataset.slug} ${/drop-(before|after|inside)/.exec(li.className)![1]}`,
  )
}

function order(_panel: VueWrapper): string[] {
  return Array.from(
    document.body.querySelectorAll<HTMLElement>('li[data-slug]'),
  ).map((li) => {
    let depth = 0
    let up = li.parentElement?.closest('li[data-slug]')
    while (up) {
      depth++
      up = up.parentElement?.closest('li[data-slug]')
    }
    return `${depth}:${li.dataset.slug}`
  })
}

async function drag(
  panel: VueWrapper,
  source: string,
  target: string,
  position: keyof typeof Y,
): Promise<void> {
  const from = row(panel, source)
  fire(from, 'dragstart')
  await nextTick()
  fire(label(row(panel, target)), 'dragover', Y[position])
  await nextTick()
  fire(label(row(panel, target)), 'drop', Y[position])
  fire(from, 'dragend')
  await new Promise((resolve) => setTimeout(resolve, 5))
  await flushPromises()
}

function sentOp(): Record<string, unknown> {
  expect(docWrite).toHaveBeenCalledTimes(1)
  return (docWrite.mock.calls[0][0] as Record<string, unknown>[])[0]
}

describe('dropping a page in the tree', () => {
  it('inside a leaf makes it the parent', async () => {
    const panel = await openPanel()
    await drag(panel, 'runbook', 'changelog', 'inside')
    expect(sentOp()).toEqual({
      op: 'move',
      op_id: 'op-test',
      ref: 'runbook',
      parent: 'changelog',
    })
  })

  it('inside a page with children appends after the last child', async () => {
    const panel = await openPanel()
    await drag(panel, 'changelog', 'home', 'inside')
    expect(sentOp()).toMatchObject({ ref: 'changelog', after: 'home/roadmap' })
  })

  it('before a sibling', async () => {
    const panel = await openPanel()
    await drag(panel, 'changelog', 'home', 'before')
    expect(sentOp()).toMatchObject({ ref: 'changelog', before: 'home' })
    expect(order(panel)[0]).toBe('0:changelog')
  })

  it('after a sibling', async () => {
    const panel = await openPanel()
    await drag(panel, 'home/manual/icons', 'home/manual/colour', 'after')
    expect(sentOp()).toMatchObject({
      ref: 'home/manual/icons',
      after: 'home/manual/colour',
    })
  })

  it('drags the node that was grabbed, not its outermost ancestor', async () => {
    // dragstart bubbles through every ancestor row. The tree must still
    // report the grabbed page as the source, not "home".
    const panel = await openPanel()
    await drag(panel, 'home/manual/icons', 'runbook', 'inside')
    expect(sentOp()).toMatchObject({
      ref: 'home/manual/icons',
      parent: 'runbook',
    })
  })

  it('on the root drop zone moves it to the end of the top level', async () => {
    const panel = await openPanel()
    const from = row(panel, 'home/manual')
    fire(from, 'dragstart')
    await nextTick()
    const zone = document.body.querySelector(
      '[data-testid="doc-tree-root-drop"]',
    )!
    expect(zone).toBeTruthy()
    fire(zone, 'dragover')
    fire(zone, 'drop')
    fire(from, 'dragend')
    await new Promise((resolve) => setTimeout(resolve, 5))
    await flushPromises()
    expect(sentOp()).toMatchObject({ ref: 'home/manual', after: 'changelog' })
    expect(order(panel).slice(-3)).toEqual([
      '0:home/manual',
      '1:home/manual/icons',
      '1:home/manual/colour',
    ])
    expect(
      document.body.querySelector('[data-testid="doc-tree-root-drop"]'),
    ).toBeNull()
  })

  it('updates the tree at once and keeps the moved page in view', async () => {
    let settle!: (v: { results: TResult[] }) => void
    docWrite.mockImplementationOnce(
      () => new Promise((resolve) => (settle = resolve)),
    )
    const panel = await openPanel()
    await drag(panel, 'home/manual/colour', 'runbook', 'inside')
    // The server has not answered yet.
    expect(order(panel)).toContain('1:home/manual/colour')
    expect(order(panel).indexOf('1:home/manual/colour')).toBe(
      order(panel).indexOf('0:runbook') + 1,
    )
    expect(row(panel, 'runbook').getAttribute('aria-expanded')).toBe('true')
    settle({ results: [{ ok: true }] })
    await flushPromises()
    expect(toastError).not.toHaveBeenCalled()
  })
})

describe('invalid drops', () => {
  it('shows no indicator over the page itself or its subtree', async () => {
    const panel = await openPanel()
    fire(row(panel, 'home'), 'dragstart')
    await nextTick()
    for (const slug of ['home', 'home/manual', 'home/manual/icons']) {
      const { prevented } = fire(label(row(panel, slug)), 'dragover', Y.inside)
      await nextTick()
      expect(prevented).toBe(false)
      expect(lit(panel)).toEqual([])
    }
    // A valid target still lights up during the same drag.
    fire(label(row(panel, 'runbook')), 'dragover', Y.inside)
    await nextTick()
    expect(lit(panel)).toEqual(['runbook inside'])
  })

  it('clears an ancestor indicator when the pointer moves into the dragged subtree', async () => {
    const panel = await openPanel()
    fire(row(panel, 'home/manual'), 'dragstart')
    await nextTick()
    fire(label(row(panel, 'home')), 'dragover', Y.inside)
    await nextTick()
    expect(lit(panel)).toEqual(['home inside'])
    fire(label(row(panel, 'home/manual/icons')), 'dragover', Y.inside)
    await nextTick()
    expect(lit(panel)).toEqual([])
  })

  it('never sends a move into its own subtree', async () => {
    const panel = await openPanel()
    await drag(panel, 'home', 'home/manual/icons', 'inside')
    await drag(panel, 'home/manual', 'home/manual/colour', 'after')
    expect(docWrite).not.toHaveBeenCalled()
  })
})

describe('when the server refuses', () => {
  it('puts the tree back and says why', async () => {
    docWrite.mockResolvedValueOnce({
      results: [{ ok: false, error: 'cannot move that there' }],
    })
    const panel = await openPanel()
    const before = order(panel)
    await drag(panel, 'runbook', 'home', 'before')
    await flushPromises()
    expect(order(panel)).toEqual(before)
    expect(toastError).toHaveBeenCalledWith('cannot move that there', {
      title: 'Could not move "Runbook"',
    })
  })

  it('puts the tree back when the request fails outright', async () => {
    docWrite.mockRejectedValueOnce(new TypeError('offline'))
    const panel = await openPanel()
    const before = order(panel)
    await drag(panel, 'changelog', 'runbook', 'inside')
    await flushPromises()
    expect(order(panel)).toEqual(before)
    expect(toastError).toHaveBeenCalledTimes(1)
  })
})

describe('a move made by somebody else', () => {
  it('arrives through doc.moved without collapsing the tree', async () => {
    const panel = await openPanel()
    expect(row(panel, 'home/manual').getAttribute('aria-expanded')).toBe('true')
    // Runbook moved under the manual, elsewhere.
    docTree.mockImplementation(async () => ({
      docs: [...FLAT.slice(0, 4), { ...FLAT[5], depth: 2 }, FLAT[4], FLAT[6]],
    }))
    for (const listener of liveListeners)
      listener({ entity: 'doc', verb: 'doc.moved' })
    await flushPromises()
    expect(order(panel)).toEqual([
      '0:home',
      '1:home/manual',
      '2:home/manual/icons',
      '2:home/manual/colour',
      '2:runbook',
      '1:home/roadmap',
      '0:changelog',
    ])
    // Still the same tree: nothing went back through a loading skeleton.
    expect(row(panel, 'home/manual').getAttribute('aria-expanded')).toBe('true')
    expect(panel.find('.doc-tree__loading').exists()).toBe(false)
  })
})

describe('a read-only viewer', () => {
  it('gets no drag affordance and cannot move anything', async () => {
    scopes.value = ['read']
    const panel = await openPanel()
    const rows = document.body.querySelectorAll('li[data-slug]')
    expect(rows.length).toBeGreaterThan(0)
    expect(document.body.querySelectorAll('li[draggable="true"]')).toHaveLength(
      0,
    )
    await drag(panel, 'runbook', 'home', 'inside')
    expect(docWrite).not.toHaveBeenCalled()
    expect(
      document.body.querySelector('[data-testid="doc-tree-root-drop"]'),
    ).toBeNull()
  })
})
