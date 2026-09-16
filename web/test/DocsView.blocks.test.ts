/**
 * Block tools on the real docs page: following a block link, what happens when
 * the block is gone, heading links still working beside them, and the grip
 * tools leaving the page's markdown alone.
 */
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { computed, defineComponent, ref } from 'vue'

const PROSE =
  'Operators read this page when something is on fire, so it stays short and plain. '
    .repeat(12)
    .trim()

const BODY = [
  '# Overview',
  '',
  PROSE,
  '',
  '## Install',
  '',
  'Install the service with the package manager your platform ships.',
  '',
  '### Requirements',
  '',
  '- a database that accepts connections',
  '- a queue with at least one worker',
  '',
  '## Configure',
  '',
  PROSE,
].join('\n')

const body = ref(BODY)

const docWrite = vi.fn(async (ops: unknown[]) => ({
  results: ops.map(() => ({ ok: true })),
}))
const docGet = vi.fn(async () => ({
  slug: 'runbook',
  title: 'Runbook',
  tags: [],
  rev: 3,
  updated: 0,
  body: body.value,
  attachments: [],
  backlinks: [],
  versions: [],
  comments: [],
}))

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  api: {
    docGet: (...args: unknown[]) => docGet(...(args as [])),
    docWrite: (ops: unknown[]) => docWrite(ops),
    search: vi.fn(async () => ({ results: [] })),
  },
  newOpId: () => 'op-test',
  ApiHttpError: class extends Error {
    status = 0
  },
}))

vi.mock('@/lib/commands', () => ({ useViewCommands: () => undefined }))

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useRoute: () => ({ params: {} }),
  onBeforeRouteLeave: () => undefined,
}))

vi.mock('@/components/DocsTreePanel.vue', () => ({
  default: { name: 'DocsTreePanelStub', render: () => null },
}))

vi.mock('@nubisco/ui', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  const Outlet = defineComponent({
    name: 'ShellSlotOutletStub',
    setup:
      (_props, { slots }) =>
      () =>
        slots.default?.(),
  })
  return {
    ...actual,
    useShellSlot: () => ({ Outlet }),
    useToast: () => toast,
  }
})

vi.mock('@/stores/workspace', () => ({
  useWorkspace: () => ({
    me: computed(() => ({
      id: 'a',
      handle: 'jose',
      scopes: ['read', 'write'],
    })),
    overview: ref(null),
    onLive: () => () => undefined,
  }),
  useInspector: () => ({ open: vi.fn() }),
  useDocPreview: () => ({ open: vi.fn() }),
}))

import type { Editor } from '@tiptap/core'
import DocsView from '@/views/DocsView.vue'
import MarkdownEditor from '@/components/MarkdownEditor.vue'
import { blockAnchor, blockFragment, isBlockFragment } from '@/lib/blockLinks'

/** Every element scrollIntoView was called on, in order. */
const scrolled: Element[] = []

beforeAll(() => {
  // jsdom has no layout: no scrolling, no rectangles, no hit testing.
  const proto = Element.prototype as unknown as Record<string, unknown>
  proto.scrollIntoView = function (this: Element) {
    scrolled.push(this)
  }
  proto.getClientRects ??= () => []
  const doc = document as unknown as Record<string, unknown>
  doc.elementFromPoint ??= () => null
})

const mounted: VueWrapper[] = []

beforeEach(() => {
  body.value = BODY
  docWrite.mockClear()
  docGet.mockClear()
  Object.values(toast).forEach((fn) => fn.mockClear())
  scrolled.length = 0
  window.history.replaceState(null, '', '/docs/runbook')
})

afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount()
  document.body.innerHTML = ''
  window.history.replaceState(null, '', '/docs/runbook')
})

async function openPage(): Promise<VueWrapper> {
  const view = mount(DocsView, {
    props: { slug: 'runbook' },
    attachTo: document.body,
  })
  mounted.push(view)
  await flushPromises()
  await new Promise((resolve) => setTimeout(resolve, 30))
  return view
}

/** The link the grip menu would copy for top-level block `index` of BODY. */
async function linkTo(index: number): Promise<string> {
  const view = mount(MarkdownEditor, {
    props: { modelValue: BODY },
    attachTo: document.body,
  })
  await flushPromises()
  const editor = (view.vm as unknown as { editor: Editor }).editor
  let pos = 0
  for (let i = 0; i < index; i++) pos += editor.state.doc.child(i).nodeSize
  const anchor = blockAnchor(editor.state.doc, pos)!
  view.unmount()
  return `#${blockFragment(anchor)}`
}

function markdownOf(editor: Editor): string {
  return (
    editor.storage as unknown as { markdown: { getMarkdown(): string } }
  ).markdown.getMarkdown()
}

const REQUIREMENTS_LIST = 5

describe('following a block link', () => {
  it('scrolls to the block and marks it for a moment', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      window.history.replaceState(
        null,
        '',
        `/docs/runbook${await linkTo(REQUIREMENTS_LIST)}`,
      )
      const view = await openPage()
      const list = view.element.querySelector('.md ul')!
      expect(scrolled).toContain(list)
      expect(list.classList.contains('md__block-target')).toBe(true)
      expect(toast.warning).not.toHaveBeenCalled()
      vi.advanceTimersByTime(3000)
      expect(list.classList.contains('md__block-target')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('still lands after the page was edited around the block', async () => {
    const fragment = await linkTo(REQUIREMENTS_LIST)
    body.value = BODY.replace(
      '### Requirements',
      '### What you need first\n\nRead this before installing anything at all.',
    ).replace(
      '- a queue with at least one worker',
      '- a queue with at least one worker\n- an object store',
    )
    window.history.replaceState(null, '', `/docs/runbook${fragment}`)
    const view = await openPage()
    const list = view.element.querySelector('.md ul')!
    expect(scrolled).toContain(list)
    expect(list.textContent).toContain('an object store')
    expect(toast.warning).not.toHaveBeenCalled()
  })

  it('opens at the top and says so when the block is gone', async () => {
    const fragment = await linkTo(REQUIREMENTS_LIST)
    body.value = BODY.replace(
      '- a database that accepts connections\n- a queue with at least one worker',
      'Nothing is required any more.',
    )
    window.history.replaceState(null, '', `/docs/runbook${fragment}`)
    const view = await openPage()
    expect(toast.warning).toHaveBeenCalledTimes(1)
    expect(String(toast.warning.mock.calls[0][0])).toMatch(
      /moved or been removed/,
    )
    // The top of the page, not some other block.
    expect(scrolled).toEqual([view.element])
    expect(view.element.querySelector('.md__block-target')).toBeNull()
  })

  it('says so when the link itself is damaged', async () => {
    window.history.replaceState(null, '', '/docs/runbook#block=eyJub3QiOg')
    await openPage()
    expect(toast.warning).toHaveBeenCalledTimes(1)
    expect(String(toast.warning.mock.calls[0][0])).toMatch(/incomplete/)
  })

  it('follows a block link changed on a page already open', async () => {
    const view = await openPage()
    expect(scrolled).toEqual([])
    window.history.replaceState(
      null,
      '',
      `/docs/runbook${await linkTo(REQUIREMENTS_LIST)}`,
    )
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    await flushPromises()
    expect(scrolled).toContain(view.element.querySelector('.md ul'))
  })

  it('leaves heading links to the contents, and the two do not collide', async () => {
    window.history.replaceState(null, '', '/docs/runbook#install')
    const view = await openPage()
    const heading = view.element.querySelector('.md #install')!
    expect(scrolled).toContain(heading)
    expect(toast.warning).not.toHaveBeenCalled()
    expect(isBlockFragment('#install')).toBe(false)
    // And the heading's own copy button still builds a heading link.
    expect(heading.querySelector('.md__anchor')).not.toBeNull()
  })
})

describe('round trip on the page', () => {
  it('writes nothing from hovering, the grip menu, the + menu and copying a link', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    const view = await openPage()
    const edit = view.findAll('button').find((b) => b.text() === 'Edit')!
    await edit.trigger('click')
    await flushPromises()
    const editorView = view.findComponent(MarkdownEditor)
    const editor = (editorView.vm as unknown as { editor: Editor }).editor
    expect(markdownOf(editor)).toBe(BODY)

    const blocks = Array.from(editor.view.dom.children) as HTMLElement[]
    for (const block of blocks)
      block.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    blocks[1].dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    await flushPromises()

    const handle = () =>
      document.querySelector<HTMLButtonElement>(
        '[data-testid="block-gutter"] .nb-drag-handle',
      )!
    const escape = async () => {
      document
        .querySelector('[role="menu"]')!
        .dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        )
      await flushPromises()
    }
    handle().click()
    await flushPromises()
    await escape()
    document
      .querySelector<HTMLButtonElement>(
        '[data-testid="block-gutter"] button[aria-label="Insert a block below"]',
      )!
      .click()
    await flushPromises()
    await escape()
    handle().click()
    await flushPromises()
    Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      .find((el) => el.textContent?.trim() === 'Copy link to block')!
      .click()
    await flushPromises()
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(toast.success).toHaveBeenCalledWith('Link to block copied')

    expect(markdownOf(editor)).toBe(BODY)
    expect(editorView.emitted('update:modelValue')).toBeUndefined()
    expect(docWrite).not.toHaveBeenCalled()
  })
})
