/**
 * The table of contents as DocsView wires it: NbTableOfContents fed by Acta's
 * outline and heading lookup, against real rendered headings.
 *
 * Whether the contents show on a short page and whether a reader's choice to
 * hide them is remembered are page decisions, tested in DocsView.chrome.
 *
 * jsdom has no layout, so where a test needs a heading to be somewhere on the
 * page it says where, by giving that heading a bounding box. Everything else
 * (the outline, the slugs, the DOM the links point at) is the real reader and
 * the real editor.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'

vi.mock('@/api/client', () => ({
  api: { search: vi.fn(async () => ({ results: [] })) },
  ApiHttpError: class extends Error {},
}))

import { NbTableOfContents } from '@nubisco/ui'
import MarkdownView from '@/components/MarkdownView.vue'
import MarkdownEditor from '@/components/MarkdownEditor.vue'
import { headingByIndex, tocItems } from '@/lib/docToc'

const PROSE = 'Words that a reader actually reads on the page. '.repeat(40)

const LONG = [
  '# Overview',
  PROSE,
  '## Install',
  PROSE,
  '### Requirements',
  PROSE,
  '## Configure',
  PROSE,
  '# Operate',
  PROSE,
].join('\n\n')

const mounted: VueWrapper[] = []
function track<T extends VueWrapper>(wrapper: T): T {
  mounted.push(wrapper)
  return wrapper
}

afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount()
  document.body.innerHTML = ''
})

/** Waits out the rAF the contents measure in. */
async function frame(): Promise<void> {
  await flushPromises()
  await new Promise((resolve) => setTimeout(resolve, 40))
  await nextTick()
}

async function readerWithToc(source: string) {
  const reader = track(
    mount(MarkdownView, { props: { source }, attachTo: document.body }),
  )
  await flushPromises()
  const root = reader.element as HTMLElement
  const toc = track(
    mount(NbTableOfContents, {
      props: {
        items: tocItems(source),
        root,
        resolveTarget: headingByIndex(() => root),
        followHash: true,
      },
      attachTo: document.body,
    }),
  )
  await frame()
  return { reader, toc }
}

function placeHeadings(root: Element, tops: number[]): void {
  root.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((el, i) => {
    el.getBoundingClientRect = () =>
      ({ top: tops[i], bottom: tops[i] + 30, height: 30 }) as DOMRect
  })
}

describe('contents', () => {
  it('nests sections by heading level', async () => {
    const { toc } = await readerWithToc(LONG)
    const nav = toc.get('nav[aria-label="Table of contents"]')
    const top = nav.element.querySelector(':scope > ol')!
    const topLinks = Array.from(top.querySelectorAll(':scope > li > a')).map(
      (a) => a.textContent,
    )
    expect(topLinks).toEqual(['Overview', 'Operate'])
    const install = nav.get('a[href="#install"]').element
    expect(
      install.closest('ol')?.parentElement?.querySelector('a')?.textContent,
    ).toBe('Overview')
    const requirements = nav.get('a[href="#requirements"]').element
    expect(
      requirements.closest('ol')?.parentElement?.querySelector('a')
        ?.textContent,
    ).toBe('Install')
  })

  it('links to the same ids the reader puts on its headings', async () => {
    const { reader, toc } = await readerWithToc(LONG)
    const ids = Array.from(
      (reader.element as HTMLElement).querySelectorAll('h1, h2, h3'),
    ).map((h) => h.id)
    const hrefs = toc.findAll('a').map((a) => a.attributes('href')?.slice(1))
    expect(hrefs).toEqual(ids)
  })

  it('highlights the section being read as the page scrolls', async () => {
    const { reader, toc } = await readerWithToc(LONG)
    placeHeadings(reader.element, [-2000, -900, -300, 60, 900])
    window.dispatchEvent(new Event('scroll'))
    await frame()
    expect(toc.get('a[aria-current="location"]').text()).toBe('Configure')

    placeHeadings(reader.element, [-2000, -900, 40, 700, 1600])
    window.dispatchEvent(new Event('scroll'))
    await frame()
    expect(toc.get('a[aria-current="location"]').text()).toBe('Requirements')
    expect(toc.findAll('a[aria-current]')).toHaveLength(1)
  })

  it('scrolls to a section and puts its link in the address bar', async () => {
    const { reader, toc } = await readerWithToc(LONG)
    const heading = (reader.element as HTMLElement).querySelector<HTMLElement>(
      '#configure',
    )!
    const scrollIntoView = vi.fn()
    heading.scrollIntoView = scrollIntoView
    await toc.get('a[href="#configure"]').trigger('click')
    expect(scrollIntoView).toHaveBeenCalledOnce()
    expect(window.location.hash).toBe('#configure')
    expect(toc.get('a[aria-current="location"]').text()).toBe('Configure')
    // Keyboard and screen reader users continue from the section.
    expect(document.activeElement).toBe(heading)
  })

  it('does not animate the scroll when reduced motion is asked for', async () => {
    const original = window.matchMedia
    window.matchMedia = ((query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as never
    try {
      const { reader, toc } = await readerWithToc(LONG)
      const heading = (
        reader.element as HTMLElement
      ).querySelector<HTMLElement>('#operate')!
      const scrollIntoView = vi.fn()
      heading.scrollIntoView = scrollIntoView
      await toc.get('a[href="#operate"]').trigger('click')
      expect(scrollIntoView).toHaveBeenCalledWith(
        expect.objectContaining({ behavior: 'auto' }),
      )
    } finally {
      window.matchMedia = original
    }
  })

  it('follows headings as they are typed in the editor', async () => {
    const editorView = track(
      mount(MarkdownEditor, {
        props: { modelValue: LONG },
        attachTo: document.body,
      }),
    )
    await flushPromises()
    const root = (
      editorView.vm as unknown as { root: () => HTMLElement }
    ).root()
    const toc = track(
      mount(NbTableOfContents, {
        props: {
          items: tocItems(LONG),
          root,
          resolveTarget: headingByIndex(() => root),
        },
        attachTo: document.body,
      }),
    )
    await frame()
    expect(toc.findAll('a')).toHaveLength(5)

    const editor = (
      root as unknown as { editor: import('@tiptap/core').Editor }
    ).editor
    editor
      .chain()
      .focus('end')
      .insertContent([
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: 'Rollback plan' }],
        },
      ])
      .run()
    await flushPromises()
    const draft = editorView.emitted('update:modelValue')!.at(-1)![0] as string
    expect(draft).toContain('## Rollback plan')
    await toc.setProps({ items: tocItems(draft) })
    await frame()

    const link = toc.get('a[href="#rollback-plan"]')
    expect(link.text()).toBe('Rollback plan')
    // Nested under the h1 it was typed after.
    expect(
      link.element.closest('ol')?.parentElement?.querySelector('a')
        ?.textContent,
    ).toBe('Operate')
    // And the link lands on the heading that was typed, not a neighbour.
    const headings = root.querySelectorAll('h1, h2, h3')
    const typed = headings[headings.length - 1] as HTMLElement
    expect(typed.textContent).toBe('Rollback plan')
    typed.scrollIntoView = vi.fn()
    await link.trigger('click')
    expect(typed.scrollIntoView).toHaveBeenCalledOnce()
  })
})
