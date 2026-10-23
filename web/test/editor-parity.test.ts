/**
 * The editor does what it did before the Tiptap 3 upgrade.
 *
 * Documents are stored as the editor's own markdown serialization, so a
 * library upgrade that changes a byte of that output rewrites every page the
 * next time somebody saves it. The golden file below was written by the
 * Tiptap 2 editor and is the format stored documents are in. The rest pins the
 * behaviours Tiptap 3 changed by default and this editor switched back.
 */
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mount, flushPromises } from '@vue/test-utils'
import type { Editor } from '@tiptap/core'

vi.mock('@/api/client', () => ({
  api: { search: vi.fn(async () => ({ results: [] })) },
  ApiHttpError: class extends Error {},
}))

import MarkdownEditor from '@/components/MarkdownEditor.vue'
import { serializeOnce } from '@/lib/transfer/normalize'

const fixture = (name: string) =>
  readFileSync(resolve(__dirname, 'fixtures/format', name), 'utf8')

/** Long enough for the end of the page to be off screen in a real browser. */
const LONG = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1}.`).join(
  '\n\n',
)

/** Lets the editor's create timeout and focus frame run. */
const settle = () => new Promise((r) => setTimeout(r, 50))

function editorOf(view: { vm: unknown }): Editor {
  return (view.vm as { editor: Editor }).editor
}

describe('stored markdown format', () => {
  it('writes every construct exactly as the Tiptap 2 editor did', () => {
    expect(serializeOnce(fixture('kitchen-sink.md'))).toBe(
      fixture('kitchen-sink.saved.md'),
    )
  })

  it('leaves a page saved by the Tiptap 2 editor untouched', () => {
    const saved = fixture('kitchen-sink.saved.md')
    expect(serializeOnce(saved)).toBe(saved)
  })
})

describe('what Tiptap 3 changed, switched back', () => {
  it('has no underline mark, trailing node or list keymap, and one link', async () => {
    const view = mount(MarkdownEditor, {
      props: { modelValue: 'Text.' },
      attachTo: document.body,
    })
    await flushPromises()
    const editor = editorOf(view)
    const names = editor.extensionManager.extensions.map((e) => e.name)
    expect(editor.schema.marks.underline).toBeUndefined()
    expect(names).not.toContain('underline')
    expect(names).not.toContain('trailingNode')
    expect(names).not.toContain('listKeymap')
    expect(names.filter((n) => n === 'link')).toHaveLength(1)
    view.unmount()
  })

  it('adds no empty paragraph after a final table', async () => {
    const source = '| a | b |\n| --- | --- |\n| 1 | 2 |'
    const view = mount(MarkdownEditor, {
      props: { modelValue: source, autofocus: true },
      attachTo: document.body,
    })
    await flushPromises()
    await settle()
    const editor = editorOf(view)
    expect(editor.state.doc.lastChild?.type.name).toBe('table')
    expect(view.emitted('update:modelValue')).toBeUndefined()
    view.unmount()
  })

  it('does not echo text handed in by its owner as an edit', async () => {
    const view = mount(MarkdownEditor, {
      props: { modelValue: 'First.' },
      attachTo: document.body,
    })
    await flushPromises()
    // `_x_` is written back as `*x*`, so an echo would differ from the input
    // and read as a change to an untouched page.
    await view.setProps({ modelValue: 'Second with _emphasis_.' })
    await flushPromises()
    expect(editorOf(view).getText()).toBe('Second with emphasis.')
    expect(view.emitted('update:modelValue')).toBeUndefined()
    view.unmount()
  })

  it('focuses the end on open without scrolling the page there', async () => {
    const scrolled: boolean[] = []
    const view = mount(MarkdownEditor, {
      props: { modelValue: LONG, autofocus: true },
      attachTo: document.body,
    })
    const editor = editorOf(view)
    editor.on('transaction', ({ transaction }) =>
      scrolled.push(transaction.scrolledIntoView),
    )
    await flushPromises()
    await settle()
    expect(editor.state.selection.from).toBe(editor.state.doc.content.size - 1)
    expect(scrolled).not.toContain(true)

    // The same for focus() as the owner calls it (a comment being edited).
    ;(view.vm as unknown as { focus: () => void }).focus()
    await settle()
    expect(scrolled).not.toContain(true)
    view.unmount()
  })
})

describe('links Tiptap 2 dropped on save', () => {
  // Tiptap 2 wrote these back without the link or without its title. Tiptap 3
  // keeps them, so a page that has one is no longer changed by being saved.
  it('keeps a link title', () => {
    expect(serializeOnce('[a](https://x.example "t") z').trim()).toBe(
      '[a](https://x.example "t") z',
    )
  })

  it('keeps a relative link with no leading dot or slash', () => {
    expect(serializeOnce('[a](docs/x.md) z').trim()).toBe('[a](docs/x.md) z')
  })

  it('still refuses a javascript: link, writing it back as plain text', () => {
    expect(serializeOnce('[a](javascript:alert(1)) z').trim()).toBe(
      '\\[a\\](javascript:alert(1)) z',
    )
  })
})
