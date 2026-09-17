/**
 * The page's import and export menu, driven the way a person drives it.
 *
 * The export formats sit in submenus. Before @nubisco/ui 5.5.0 a click on a
 * submenu item never fired `select`: the item's mousedown reached the parent
 * menu first, which saw a press outside itself and closed, taking the
 * submenu with it before the click landed. So these dispatch the whole
 * pointer sequence (mousedown, mouseup, click) rather than a bare click.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'

const exporter = {
  browserExportApi: vi.fn(async () => ({})),
  collectTree: vi.fn(async () => ({ slug: 'runbook' })),
  exportMarkdown: vi.fn(async () => ({ warnings: [] as string[] })),
  exportHtml: vi.fn(async () => ({ warnings: [] as string[] })),
  exportHtmlDocument: vi.fn(async () => '<html></html>'),
  printHtml: vi.fn(async () => undefined),
  download: vi.fn(),
}

vi.mock('@/lib/transfer/exporter', () => exporter)
vi.mock('@/lib/transfer/print', () => ({ installPrintStyles: () => undefined }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/components/DocImportModal.vue', () => ({
  default: { name: 'DocImportModalStub', render: () => null },
}))

import DocTransferMenu from '@/components/DocTransferMenu.vue'

const mounted: VueWrapper[] = []

beforeEach(() => {
  for (const fn of Object.values(exporter)) fn.mockClear()
})

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
})

async function openMenu(): Promise<void> {
  const view = mount(DocTransferMenu, {
    props: { doc: { slug: 'runbook', title: 'Runbook' } },
    attachTo: document.body,
  })
  mounted.push(view)
  await view.get('button[aria-label="Import and export"]').trigger('click')
  await flushPromises()
}

function item(label: string, within: ParentNode = document): HTMLElement {
  const found = Array.from(
    within.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ).find((el) => el.textContent?.trim() === label)
  if (!found) throw new Error(`no menu item "${label}"`)
  return found
}

function submenu(): HTMLElement {
  return document.querySelector<HTMLElement>('.nb-submenu')!
}

/**
 * A press as a browser delivers it: separate tasks, so Vue re-renders between
 * the mousedown and the click, the way it does for a real pointer. A click on
 * an element removed by then never arrives.
 */
async function press(el: HTMLElement): Promise<void> {
  for (const type of ['mousedown', 'mouseup', 'click']) {
    if (el.isConnected)
      el.dispatchEvent(
        new MouseEvent(type, { bubbles: true, cancelable: true }),
      )
    await flushPromises()
    await nextTick()
  }
}

async function key(el: HTMLElement, k: string): Promise<void> {
  el.dispatchEvent(
    new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }),
  )
  await flushPromises()
  await nextTick()
}

describe('DocTransferMenu', () => {
  it('exports the page as Markdown from a mouse click on a submenu item', async () => {
    await openMenu()
    await press(item('Export this page'))
    await nextTick()
    expect(submenu()).not.toBeNull()
    await press(item('Markdown', submenu()))
    expect(exporter.collectTree).toHaveBeenCalledWith({}, 'runbook', false)
    expect(exporter.exportMarkdown).toHaveBeenCalledTimes(1)
    expect(exporter.download).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })

  it('exports with subpages as HTML by click', async () => {
    await openMenu()
    await press(item('Export with subpages'))
    await nextTick()
    await press(item('HTML', submenu()))
    expect(exporter.collectTree).toHaveBeenCalledWith({}, 'runbook', true)
    expect(exporter.exportHtml).toHaveBeenCalledTimes(1)
  })

  it('exports by keyboard alone', async () => {
    await openMenu()
    const trigger = item('Export this page')
    await key(trigger, 'ArrowRight')
    expect(document.activeElement).toBe(item('Markdown', submenu()))
    await key(document.activeElement as HTMLElement, 'ArrowDown')
    expect(document.activeElement).toBe(item('HTML', submenu()))
    await key(document.activeElement as HTMLElement, 'Enter')
    expect(exporter.exportHtml).toHaveBeenCalledTimes(1)
    expect(exporter.collectTree).toHaveBeenCalledWith({}, 'runbook', false)
  })
})
