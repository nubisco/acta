/**
 * A thread has to read as a sequence of people saying things.
 *
 * Imported comments carry the original author's display NAME and no handle,
 * and used to render as a bold name with no avatar. Half a migrated thread
 * was therefore a wall of identical bold text with nothing to follow down
 * the column, which is what made an eleven-comment card unreadable even once
 * the comments were on screen.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { dismissConfirms } from '@nubisco/ui'

// Only the overview call is stubbed; everything else in the client stays
// real, because a partial mock of the module breaks MarkdownView's setup
// silently rather than failing loudly.
const overview = vi.fn(async () => ({ spaces: [], labels: [], actors: [] }))
vi.mock('@/api/client', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    api: { ...(actual.api as object), overview: () => overview() },
  }
})

import CommentThread from '@/components/CommentThread.vue'
import { useWorkspace } from '@/stores/workspace'

/** Populate the store the way the app does, since `overview` is read-only. */
async function seedActors(actors: unknown[]) {
  overview.mockResolvedValue({ spaces: [], labels: [], actors } as never)
  await useWorkspace().refresh()
}

interface ITestComment {
  id: string
  by: string
  ts: number
  body: string
  agent?: boolean
  imported?: { source: string; author?: string; created_at?: string }
  edited?: number
  /**
   * The server decides these and the thread only obeys them. Stubbed here
   * because the read that returns them is still being built: nothing in the
   * component derives them, so a stub is the whole contract.
   */
  can_edit?: true
  can_delete?: true
}

function render(comments: ITestComment[]) {
  return mount(CommentThread, {
    props: { modelValue: '', comments, commenting: false },
    global: { stubs: { teleport: true } },
  })
}

const BASE = { id: 'c1', by: 'acta', ts: 1756000000000, body: 'hello' }

describe('CommentThread', () => {
  it('gives an imported comment an avatar, not just a name', () => {
    const view = render([
      { ...BASE, imported: { source: 'trello', author: 'José Silva' } },
    ])
    expect(view.findAllComponents({ name: 'ActorAvatar' })).toHaveLength(1)
    expect(view.text()).toContain('José Silva')
    expect(view.text()).toContain('imported')
  })

  // One person, one face, across the seam between what was migrated and what
  // was written here.
  it('matches an imported author to the member of the same name', async () => {
    await seedActors([{ handle: 'jose', name: 'José Silva', kind: 'human' }])

    const avatar = render([
      { ...BASE, imported: { source: 'trello', author: 'José Silva' } },
    ]).findComponent({ name: 'ActorAvatar' })
    expect(avatar.props('handle')).toBe('jose')

    // And an author who is nobody here still gets a stable identity rather
    // than being shown as a handle that does not exist.
    const stranger = render([
      { ...BASE, imported: { source: 'trello', author: 'Someone Else' } },
    ]).findComponent({ name: 'ActorAvatar' })
    expect(stranger.props('handle')).toBe('Someone Else')
    expect(stranger.props('name')).toBe('Someone Else')
  })

  it('still shows a member comment with their handle', () => {
    const avatar = render([{ ...BASE, by: 'ivan' }]).findComponent({
      name: 'ActorAvatar',
    })
    expect(avatar.props('handle')).toBe('ivan')
    expect(avatar.props('name')).toBeUndefined()
  })

  // The import runs as an agent, so every migrated comment claimed to have
  // been written by an AI when it was written by a person, years before Acta
  // existed.
  it('does not call an imported comment AI-written', () => {
    const view = render([
      {
        ...BASE,
        agent: true,
        imported: { source: 'trello', author: 'Ivan Marjanovic' },
      },
    ])
    expect(view.html()).not.toContain('nb-ai-label')
    expect(view.text()).toContain('imported')
  })

  it('still labels a genuinely agent-written comment', () => {
    const view = render([{ ...BASE, agent: true }])
    expect(view.html()).toContain('nb-ai-label')
  })
})

/**
 * Everything below drives the thread the way a person does, so it mounts for
 * real: attached to the document, with Teleport left alone, because the menu
 * and the confirm dialog both live outside the component's own tree.
 */
const live: VueWrapper[] = []

afterEach(() => {
  dismissConfirms()
  while (live.length) live.pop()!.unmount()
  document.body.innerHTML = ''
})

function open(comments: ITestComment[]) {
  const view = mount(CommentThread, {
    props: { modelValue: '', comments, commenting: false },
    attachTo: document.body,
  })
  live.push(view)
  return view
}

/**
 * The whole pointer sequence, not a bare click: the menu closes on a press it
 * considers outside itself, and a lone `click` arrives after that has already
 * happened (see DocTransferMenu.test.ts).
 */
function press(el: Element): void {
  for (const type of ['mousedown', 'mouseup', 'click'])
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }))
}

function menuItems(): string[] {
  return Array.from(document.querySelectorAll('[role="menuitem"]')).map(
    (el) => el.textContent?.trim() ?? '',
  )
}

function menuItem(label: string): Element {
  const found = Array.from(document.querySelectorAll('[role="menuitem"]')).find(
    (el) => el.textContent?.trim() === label,
  )
  if (!found) throw new Error(`no menu item "${label}"`)
  return found
}

async function openMenu(view: VueWrapper): Promise<void> {
  await view.get('.thread__menu').trigger('click')
  await flushPromises()
}

describe('the comment composer', () => {
  /**
   * The bug this exists for: `class="thread__editor"` sat on MarkdownEditor,
   * which has four top-level nodes and is therefore a fragment. Vue drops a
   * fallthrough class and the scoped-style attribute on one of those, so the
   * border, the padding and the resting height never reached any element and
   * the composer read as a caption. Measured, not snapshotted: a snapshot of
   * the broken markup was perfectly stable.
   */
  it('is a box you can see before you click it', () => {
    const view = open([])
    const field = view.get('.thread__field').element
    const style = getComputedStyle(field)
    expect(style.borderTopStyle).toBe('solid')
    expect(style.borderTopWidth).toBe('1px')
    // And it is genuinely the editor's wrapper, not an empty div beside it.
    expect(field.querySelector('.md-editor')).not.toBeNull()
  })
})

describe('editing and deleting a comment', () => {
  /**
   * `can_edit` and `can_delete` are the server's decision. The thread shows
   * what it was told to show and derives nothing: no handle comparison, no
   * admin check, because the policy lives in one place on purpose.
   */
  it('offers nothing at all unless the server said so', () => {
    expect(
      open([{ ...BASE }])
        .find('.thread__menu')
        .exists(),
    ).toBe(false)
  })

  it('offers only Edit when only editing is allowed', async () => {
    const view = open([{ ...BASE, can_edit: true }])
    await openMenu(view)
    expect(menuItems()).toEqual(['Edit'])
  })

  it('offers only Delete when only deleting is allowed', async () => {
    const view = open([{ ...BASE, can_delete: true }])
    await openMenu(view)
    expect(menuItems()).toEqual(['Delete'])
  })

  it('emits the rewritten body when the edit is saved', async () => {
    const view = open([{ ...BASE, can_edit: true }])
    await openMenu(view)
    press(menuItem('Edit'))
    await flushPromises()

    const box = view.get('.thread__edit').findComponent({
      name: 'MarkdownEditor',
    })
    expect(box.props('modelValue')).toBe('hello')
    box.vm.$emit('update:modelValue', 'hello, again')
    await nextTick()

    await view.get('.thread__edit-actions button').trigger('click')
    expect(view.emitted('edit')).toEqual([['c1', 'hello, again']])
  })

  it('emits nothing when the edit is cancelled', async () => {
    const view = open([{ ...BASE, can_edit: true }])
    await openMenu(view)
    press(menuItem('Edit'))
    await flushPromises()

    view
      .get('.thread__edit')
      .findComponent({ name: 'MarkdownEditor' })
      .vm.$emit('update:modelValue', 'never mind')
    await nextTick()

    const buttons = view.get('.thread__edit-actions').findAll('button')
    await buttons[buttons.length - 1].trigger('click')
    expect(view.emitted('edit')).toBeUndefined()
    expect(view.find('.thread__edit').exists()).toBe(false)
  })

  // Emptying the box and pressing Save is the shape of a mistake. Removing a
  // comment has its own control and its own confirmation.
  it('will not save an empty body', async () => {
    const view = open([{ ...BASE, can_edit: true }])
    await openMenu(view)
    press(menuItem('Edit'))
    await flushPromises()

    view
      .get('.thread__edit')
      .findComponent({ name: 'MarkdownEditor' })
      .vm.$emit('update:modelValue', '   ')
    await nextTick()
    await view.get('.thread__edit-actions button').trigger('click')
    expect(view.emitted('edit')).toBeUndefined()
  })

  it('asks before it deletes, and only then emits', async () => {
    const view = open([{ ...BASE, can_delete: true }])
    await openMenu(view)
    press(menuItem('Delete'))
    await flushPromises()

    const dialog = document.querySelector('[role="alertdialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog!.textContent).toContain('cannot be undone')
    expect(view.emitted('delete')).toBeUndefined()

    const confirmButton = Array.from(dialog!.querySelectorAll('button')).find(
      (el) => el.textContent?.trim() === 'Delete comment',
    )
    expect(confirmButton).toBeTruthy()
    press(confirmButton!)
    await flushPromises()
    expect(view.emitted('delete')).toEqual([['c1']])
  })
})

describe('an edited comment', () => {
  it('says so, with the moment in a tooltip', () => {
    const edited = 1756500000000
    const view = open([{ ...BASE, edited }])
    expect(view.text()).toContain('(edited)')
    expect(
      view.get('.thread__edited').attributes('aria-describedby'),
    ).toBeTruthy()
  })

  it('says nothing when it was never edited', () => {
    expect(open([{ ...BASE }]).text()).not.toContain('(edited)')
  })
})
