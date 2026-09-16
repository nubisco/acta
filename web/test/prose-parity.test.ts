/**
 * The structural contract that keeps the editor looking like the reader.
 *
 * Clicking Edit used to reflow the whole document: the editor had its own
 * copy of the prose styles, at a different font size and spacing, and its
 * blockquote rule outranked the shared callout rule. jsdom has no layout, so
 * it cannot measure that (web/e2e/parity.mjs does, in a real browser). What it
 * can hold is the contract that makes parity possible:
 *
 * - both surfaces put `md-prose` on the element that holds the blocks, so one
 *   stylesheet (styles/prose.scss) sizes and spaces both;
 * - neither component carries its own typography or block rules, so nothing
 *   overrides that sheet on one side only;
 * - prose element rules carry no specificity, so a decoration class such as
 *   `.md__callout` always wins over the element it decorates.
 */
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'

vi.mock('@/api/client', () => ({
  api: { search: vi.fn(async () => ({ results: [] })) },
  ApiHttpError: class extends Error {},
}))

import MarkdownEditor from '@/components/MarkdownEditor.vue'
import MarkdownView from '@/components/MarkdownView.vue'

const SOURCE = [
  '# Overview',
  'A paragraph.',
  '> [!NOTE]',
  '> A callout.',
  '',
  '> A quote.',
].join('\n\n')

const mounted: VueWrapper[] = []
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount()
  document.body.innerHTML = ''
})

/** A component's style block, without comments. */
function styleOf(path: string): string {
  const file = readFileSync(path, 'utf8')
  const match = /<style[^>]*>([\s\S]*?)<\/style>/.exec(file)
  return (match?.[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '')
}

/** Selectors (the text before each `{`) in a stylesheet. */
function selectors(css: string): string[] {
  return [...css.matchAll(/([^{};]+)\{/g)].map((m) => m[1].trim())
}

const BLOCK_ELEMENT =
  /(^|[\s,>+~(])(p|h[1-6]|ul|ol|li|blockquote|pre|code|hr|a|table|th|td)(?=$|[\s,:.[)>+~])/

describe('both surfaces render into the shared prose class', () => {
  it('the reader', () => {
    const view = mount(MarkdownView, { props: { source: SOURCE } })
    mounted.push(view)
    expect(view.find('.md.md-prose').exists()).toBe(true)
    expect(view.find('.md-prose .md__callout').exists()).toBe(true)
  })

  it('the editor', async () => {
    const view = mount(MarkdownEditor, {
      props: { modelValue: SOURCE },
      attachTo: document.body,
    })
    mounted.push(view)
    await flushPromises()
    const root = document.querySelector('.tiptap')
    expect(root?.classList.contains('md-prose')).toBe(true)
    expect(root?.querySelector('.md__callout')).not.toBeNull()
  })
})

describe('no component keeps its own copy of the prose styles', () => {
  const TYPOGRAPHY =
    /(^|[;{\s])(font-size|line-height|letter-spacing|font-weight|margin-block(-start|-end)?|border-inline-start|max-width)\s*:/m

  it('the editor sets no typography or block spacing', () => {
    const css = styleOf('src/components/MarkdownEditor.vue')
    expect(css).not.toMatch(TYPOGRAPHY)
    // Grips, cells and the placeholder are editor affordances. A rule on a
    // bare block element is a second copy of prose.scss.
    const onBlocks = selectors(css).filter(
      (s) => BLOCK_ELEMENT.test(s) && !/^(th|td|th,\s*td)$/.test(s),
    )
    expect(onBlocks).toEqual([
      'table',
      'table:hover .md-table__grip',
      'p.is-editor-empty:first-child::before',
    ])
  })

  it('the editor never restyles a callout', () => {
    const css = styleOf('src/components/MarkdownEditor.vue')
    expect(css).not.toMatch(/blockquote|md__callout/)
  })

  it('the reader keeps no prose or decoration rules of its own', () => {
    // From the `.md` rule on: before it are the wrapper's "Show more" button
    // and the clamp, which are not document content.
    const all = styleOf('src/components/MarkdownView.vue')
    const css = all.slice(all.indexOf('\n.md {'))
    expect(css.length).toBeLessThan(all.length)
    expect(css).not.toMatch(TYPOGRAPHY)
    expect(css).not.toMatch(/\.md__/)
    expect(
      selectors(css).filter((s) =>
        BLOCK_ELEMENT.test(s.replace(/:deep\(/g, '(')),
      ),
    ).toEqual([])
  })
})

describe('prose rules lose to decoration classes', () => {
  it('every element rule in prose.scss sits under :where(.md-prose)', () => {
    const css = readFileSync('src/styles/prose.scss', 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    )
    const whereAt = css.indexOf(':where(.md-prose) {')
    expect(whereAt).toBeGreaterThan(-1)
    // Before the :where block only the container itself is styled.
    const before = selectors(css.slice(0, whereAt))
    expect(before).toEqual([
      '.md-prose',
      '&.ProseMirror',
      '> :first-child',
      '> :last-child',
    ])
  })

  it('no editor-scoped rule in the shared sheets sets a callout border', () => {
    for (const path of [
      'src/styles/prose.scss',
      'src/styles/decorations.scss',
    ]) {
      const css = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
      for (const m of css.matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
        const [selector, body] = [m[1], m[2]]
        if (
          /\.(ProseMirror|tiptap)\b/.test(selector) &&
          /callout|blockquote/.test(selector)
        ) {
          expect(body, `${path}: ${selector.trim()}`).not.toMatch(/border/)
        }
      }
    }
  })
})
