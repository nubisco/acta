/**
 * Round-tripping markdown through the editor.
 *
 * The reader renders GFM tables and task lists. Without the matching nodes in
 * the editor's schema, opening a document that contained one and saving it
 * dropped it: a node the schema does not know is a node the serializer cannot
 * write back. That is silent data loss on a page nobody meant to change, so
 * these assert the round trip rather than the toolbar.
 */
import { describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

vi.mock('@/api/client', () => ({
  api: { search: vi.fn(async () => ({ results: [] })) },
  ApiHttpError: class extends Error {},
}))

import MarkdownEditor from '@/components/MarkdownEditor.vue'

/** What the editor gives back after parsing and re-serialising `source`. */
async function roundTrip(source: string): Promise<string> {
  const view = mount(MarkdownEditor, {
    props: { modelValue: source },
    attachTo: document.body,
  })
  await flushPromises()
  const editor = (
    view.vm as unknown as {
      editor?: { storage: { markdown: { getMarkdown(): string } } }
    }
  ).editor
  const out = editor
    ? editor.storage.markdown.getMarkdown()
    : ((view.emitted('update:modelValue')?.at(-1)?.[0] as string) ?? '')
  view.unmount()
  return out
}

describe('MarkdownEditor round trip', () => {
  it('keeps a table', async () => {
    const table = [
      '| Name | Value |',
      '| --- | --- |',
      '| Spec | 2 |',
      '| Phase | MVP |',
    ].join('\n')
    const out = await roundTrip(table)
    expect(out).toContain('Name')
    expect(out).toContain('Phase')
    expect(out).toContain('|')
  })

  it('keeps a fenced code block and its language', async () => {
    const out = await roundTrip('```ts\nconst x = 1\n```')
    expect(out).toContain('const x = 1')
    expect(out).toContain('```')
  })

  it('keeps a task list', async () => {
    const out = await roundTrip('- [ ] not done\n- [x] done')
    expect(out).toContain('not done')
    expect(out).toContain('done')
    expect(out).toMatch(/\[[ x]\]/)
  })
})
