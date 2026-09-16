/**
 * The document chrome on the real docs page: width, focus mode, contents and
 * stats, and the guarantee that none of it touches the markdown.
 *
 * The round trip at the bottom is the one that matters most. Every control
 * here sits on top of a document that is saved as markdown, and a chrome
 * control that nudged the text (a stray decoration serialised, a draft
 * marked dirty, a body sent along with a width change) would be silent
 * damage to somebody's page. So it drives every control in both the reader
 * and the editor and then compares bytes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { computed, defineComponent, nextTick, ref } from 'vue'

const PROSE =
  'Operators read this page when something is on fire, so it stays short and plain. '
    .repeat(12)
    .trim()

/** Written the way the editor writes markdown, so a no-op round trip is exact. */
const BODY = [
  '# Overview',
  '',
  PROSE,
  '',
  '## Install',
  '',
  PROSE,
  '',
  '### Requirements',
  '',
  '- a database',
  '- a queue',
  '',
  '## Configure',
  '',
  PROSE,
  '',
  '# Operate',
  '',
  PROSE,
].join('\n')

const docWrite = vi.fn(async (ops: unknown[]) => ({
  results: ops.map(() => ({ ok: true })),
}))
const docGet = vi.fn(async () => ({
  slug: 'runbook',
  title: 'Runbook',
  tags: [],
  rev: 3,
  updated: 0,
  body: BODY,
  attachments: [],
  backlinks: [],
  versions: [],
  comments: [],
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
  return { ...actual, useShellSlot: () => ({ Outlet }) }
})

const scopes = ref<string[]>(['read', 'write'])
vi.mock('@/stores/workspace', () => ({
  useWorkspace: () => ({
    me: computed(() => ({ id: 'a', handle: 'jose', scopes: scopes.value })),
    overview: ref(null),
    onLive: () => () => undefined,
  }),
  useInspector: () => ({ open: vi.fn() }),
  useDocPreview: () => ({ open: vi.fn() }),
}))

import DocsView from '@/views/DocsView.vue'
import MarkdownView from '@/components/MarkdownView.vue'
import { DOC_CHROME_STORAGE_KEY, useDocChrome } from '@/lib/docChrome'
import type { Editor } from '@tiptap/core'

const mounted: VueWrapper[] = []

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

function key(init: KeyboardEventInit): void {
  window.dispatchEvent(
    new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
  )
}

function button(view: VueWrapper, label: string) {
  return view.get(`button[aria-label="${label}"]`)
}

function editorOf(view: VueWrapper): Editor {
  const dom = view.element.querySelector('.ProseMirror') as unknown as {
    editor: Editor
  }
  return dom.editor
}

function markdownOf(editor: Editor): string {
  return (
    editor.storage as unknown as { markdown: { getMarkdown(): string } }
  ).markdown.getMarkdown()
}

/** Every body a write carried, whatever op it was. */
function bodiesWritten(): unknown[] {
  return docWrite.mock.calls.flatMap(([ops]) =>
    (ops as { body?: unknown }[])
      .filter((op) => 'body' in op)
      .map((op) => op.body),
  )
}

beforeEach(() => {
  docWrite.mockClear()
  docGet.mockClear()
  scopes.value = ['read', 'write']
  window.localStorage.clear()
  const chrome = useDocChrome()
  chrome.reload()
})

afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount()
  document.body.innerHTML = ''
})

describe('page width', () => {
  it('persists through the doc write API as the stored layout', async () => {
    const view = await openPage()
    expect(view.find('.docs--wide').exists()).toBe(false)

    await button(view, 'Wide page').trigger('click')
    await flushPromises()
    expect(docWrite).toHaveBeenCalledWith([
      { op: 'set_layout', op_id: 'op-test', ref: 'runbook', layout: 'wide' },
    ])
    expect(view.find('.docs--wide').exists()).toBe(true)
    expect(view.findComponent(MarkdownView).props('wide')).toBe(true)
    expect(button(view, 'Wide page').attributes('aria-pressed')).toBe('true')

    await button(view, 'Wide page').trigger('click')
    await flushPromises()
    expect(docWrite).toHaveBeenLastCalledWith([
      { op: 'set_layout', op_id: 'op-test', ref: 'runbook', layout: 'default' },
    ])
    expect(view.find('.docs--wide').exists()).toBe(false)
  })

  it('puts the width back when the write is refused', async () => {
    docWrite.mockResolvedValueOnce({
      results: [{ ok: false, error: 'missing scope write' }],
    } as never)
    const view = await openPage()
    await button(view, 'Wide page').trigger('click')
    await flushPromises()
    expect(view.find('.docs--wide').exists()).toBe(false)
  })

  it('is not offered to a read-only viewer', async () => {
    scopes.value = ['read']
    const view = await openPage()
    expect(view.find('button[aria-label="Wide page"]').exists()).toBe(false)
    // Everything that is this viewer's own is still there.
    expect(view.find('button[aria-label="Focus mode"]').exists()).toBe(true)
    expect(docWrite).not.toHaveBeenCalled()
  })
})

describe('focus mode', () => {
  it('hides the frame, and Escape or the shortcut brings it back', async () => {
    const chrome = useDocChrome()
    const view = await openPage()
    expect(chrome.frameHidden.value).toBe(false)

    await button(view, 'Focus mode').trigger('click')
    expect(chrome.frameHidden.value).toBe(true)
    expect(button(view, 'Focus mode').attributes('aria-pressed')).toBe('true')

    key({ key: 'Escape' })
    await nextTick()
    expect(chrome.frameHidden.value).toBe(false)

    key({ key: 'F', code: 'KeyF', ctrlKey: true, shiftKey: true })
    await nextTick()
    expect(chrome.frameHidden.value).toBe(true)
    key({ key: 'F', code: 'KeyF', metaKey: true, shiftKey: true })
    await nextTick()
    expect(chrome.frameHidden.value).toBe(false)
  })

  it('does not strip the frame from pages that are not a document', async () => {
    const chrome = useDocChrome()
    const view = await openPage()
    await button(view, 'Focus mode').trigger('click')
    expect(chrome.frameHidden.value).toBe(true)
    view.unmount()
    mounted.splice(mounted.indexOf(view), 1)
    // Still this viewer's preference, but nothing here to focus on.
    expect(chrome.prefs.page).toBe(true)
    expect(chrome.frameHidden.value).toBe(false)
  })

  it('dims every block but the caret one while editing, from the button or the shortcut', async () => {
    const view = await openPage()
    const edit = view.findAll('button').find((b) => b.text() === 'Edit')!
    await edit.trigger('click')
    await flushPromises()

    const root = view.get('.ProseMirror').element
    expect(root.classList.contains('acta-focus-mode')).toBe(false)

    await button(view, 'Dim other blocks').trigger('click')
    await flushPromises()
    expect(root.classList.contains('acta-focus-mode')).toBe(true)
    const editor = editorOf(view)
    editor.commands.setTextSelection(3)
    await nextTick()
    const current = root.querySelectorAll('.acta-focus-current')
    expect(current).toHaveLength(1)
    expect(current[0]).toBe(root.firstElementChild)

    key({ key: 'ƒ', code: 'KeyF', metaKey: true, altKey: true })
    await flushPromises()
    expect(root.classList.contains('acta-focus-mode')).toBe(false)
    expect(root.querySelectorAll('.acta-focus-current')).toHaveLength(0)
  })

  it('is kept in this browser only, never in a write, and survives a reload', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const view = await openPage()
    await button(view, 'Focus mode').trigger('click')
    const edit = view.findAll('button').find((b) => b.text() === 'Edit')!
    await edit.trigger('click')
    await flushPromises()
    await button(view, 'Dim other blocks').trigger('click')
    await flushPromises()

    expect(docWrite).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()

    expect(
      JSON.parse(window.localStorage.getItem(DOC_CHROME_STORAGE_KEY) ?? '{}'),
    ).toEqual({ dimBlocks: true, page: true, tocClosed: false })

    // A reload is a fresh module reading storage from scratch.
    vi.resetModules()
    const fresh = await import('@/lib/docChrome')
    expect(fresh.useDocChrome().prefs).toEqual({
      dimBlocks: true,
      page: true,
      tocClosed: false,
    })
  })
})

describe('stats', () => {
  it('shows counts inline and follows the draft while editing', async () => {
    const view = await openPage()
    const stats = view.get('.doc-chrome__stats')
    // Four paragraphs of 180 words, five one-word headings, and two list
    // items of two words each.
    expect(stats.text()).toContain('729 words')
    expect(stats.text()).toContain('4 min read')

    const edit = view.findAll('button').find((b) => b.text() === 'Edit')!
    await edit.trigger('click')
    await flushPromises()
    const editor = editorOf(view)
    editor.chain().focus('end').insertContent(' plus three more').run()
    await flushPromises()
    expect(view.get('.doc-chrome__stats').text()).toContain('732 words')
    // The same listener the round trip below relies on does hear real edits.
    expect(
      view
        .findComponent({ name: 'MarkdownEditor' })
        .emitted('update:modelValue'),
    ).toBeDefined()
  })
})

describe('contents on the page', () => {
  it('is shown for a long document and hidden while comparing versions', async () => {
    const view = await openPage()
    expect(view.find('nav[aria-label="Table of contents"]').exists()).toBe(true)
    expect(view.findAll('.doc-toc a').map((a) => a.text())).toEqual([
      'Overview',
      'Install',
      'Requirements',
      'Configure',
      'Operate',
    ])
  })
})

describe('round trip', () => {
  it('leaves the markdown byte-identical after focus, contents and width', async () => {
    const view = await openPage()
    const reader = () => view.findComponent(MarkdownView)

    // Reader: every control, in both directions.
    await button(view, 'Focus mode').trigger('click')
    for (const slug of ['configure', 'requirements', 'overview']) {
      const heading = (
        reader().element as HTMLElement
      ).querySelector<HTMLElement>(`#${slug}`)!
      heading.scrollIntoView = vi.fn()
      await view.get(`.doc-toc a[href="#${slug}"]`).trigger('click')
    }
    window.dispatchEvent(new Event('scroll'))
    await button(view, 'Wide page').trigger('click')
    await flushPromises()
    key({ key: 'Escape' })
    await nextTick()
    expect(reader().props('source')).toBe(BODY)

    // Editor: the same, plus block dimming and moving the caret around.
    const edit = view.findAll('button').find((b) => b.text() === 'Edit')!
    await edit.trigger('click')
    await flushPromises()
    const editorView = view.findComponent({ name: 'MarkdownEditor' })
    expect(editorView.exists()).toBe(true)
    const editor = editorOf(view)
    const baseline = markdownOf(editor)
    expect(baseline).toBe(BODY)

    await button(view, 'Dim other blocks').trigger('click')
    await flushPromises()
    for (const pos of [1, 40, 400, editor.state.doc.content.size - 1]) {
      editor.commands.setTextSelection(pos)
    }
    await button(view, 'Focus mode').trigger('click')
    key({ key: 'F', code: 'KeyF', ctrlKey: true, altKey: true })
    key({ key: 'F', code: 'KeyF', ctrlKey: true, altKey: true })
    const headings = (
      view.element as HTMLElement
    ).querySelectorAll<HTMLElement>(
      '.ProseMirror h1, .ProseMirror h2, .ProseMirror h3',
    )
    headings.forEach((h) => (h.scrollIntoView = vi.fn()))
    await view.get('.doc-toc a[href="#operate"]').trigger('click')
    await view.get('.doc-toc a[href="#install"]').trigger('click')
    await button(view, 'Wide page').trigger('click')
    await flushPromises()
    key({ key: 'Escape' })
    await flushPromises()

    expect(markdownOf(editor)).toBe(baseline)
    // The draft never moved, so the page does not think it has unsaved edits.
    expect(editorView.emitted('update:modelValue')).toBeUndefined()
    // Width went through its own op, twice, and nothing carried a body.
    expect(
      docWrite.mock.calls.map(([ops]) => (ops as { op: string }[])[0].op),
    ).toEqual(['set_layout', 'set_layout'])
    expect(bodiesWritten()).toEqual([])
    expect(docGet).toHaveBeenCalledTimes(1)
  })
})
