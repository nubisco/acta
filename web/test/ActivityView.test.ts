/**
 * The Activity view, which had no test at all and shipped as a wall of dead
 * text.
 *
 * Jose: "what's the point of those activity lines if I cannot click on one
 * which feature a card and at least open the inspector". The feed names
 * cards and pages in the open and gave you no way to reach them, so the view
 * was a report you read and then went hunting from.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'

/**
 * A real anchor, because that is the point of using RouterLink here: a feed
 * row should be middle-clickable and openable in a new tab. Stubbed rather
 * than mounting a router, since the route table is not what is under test.
 */
const RouterLinkStub = defineComponent({
  name: 'RouterLink',
  props: { to: { type: [String, Object], required: true } },
  setup:
    (props, { slots }) =>
    () =>
      h('a', { href: String(props.to) }, slots.default?.()),
})

const activity = vi.fn()
const push = vi.fn()
const inspectorOpen = vi.fn()

vi.mock('@/api/client', () => ({
  api: { activity: (...a: unknown[]) => activity(...(a as [])) },
  getWorkspaceSlug: () => 'nubisco',
}))

vi.mock('vue-router', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, useRouter: () => ({ push }) }
})

const overview = ref<{ actors: unknown[] } | null>({
  actors: [
    {
      id: 'a1',
      handle: 'daniela',
      kind: 'human',
      name: 'Daniela Pinho',
      role: 'member',
    },
  ],
})

vi.mock('@/stores/workspace', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    useWorkspace: () => ({ overview, onLive: () => () => {} }),
    useInspector: () => ({ open: inspectorOpen }),
  }
})

const EVENT = {
  id: 'evt_1',
  ts: Date.now(),
  actor_id: 'a1',
  actor_kind: 'human',
  on_behalf_of: null,
  verb: 'comment.created',
  entity: 'item',
  entity_id: 'itm_1',
  summary: 'commented on ST-1',
  caused_by: null,
  item_key: 'ST-1',
}

async function render(events: unknown[] = [EVENT]) {
  vi.resetModules()
  activity.mockResolvedValue({ events, cursor: undefined })
  const ActivityView = (await import('@/views/ActivityView.vue')).default
  const view = mount(ActivityView, {
    global: { stubs: { teleport: true, RouterLink: RouterLinkStub } },
  })
  await flushPromises()
  return view
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('the activity feed', () => {
  it('turns a card key into something that opens the card', async () => {
    const view = await render()
    const refs = view.findAll('.md__ref')

    expect(refs).toHaveLength(1)
    expect(refs[0].text()).toBe('ST-1')
    await refs[0].trigger('click')
    expect(inspectorOpen).toHaveBeenCalledWith('ST-1')
  })

  it('keeps the words around it as words', async () => {
    const view = await render()
    expect(view.text()).toContain('commented on')
  })

  it('offers both ends of a summary that names two cards', async () => {
    const view = await render([
      { ...EVENT, verb: 'item.blocked', summary: 'ST-4 now waits on ST-9' },
    ])
    const refs = view.findAll('.md__ref')
    expect(refs.map((r) => r.text())).toEqual(['ST-4', 'ST-9'])
  })

  it('links a document to the page rather than the inspector', async () => {
    const view = await render([
      {
        ...EVENT,
        verb: 'comment.created',
        entity: 'doc',
        summary: 'commented on spec',
        item_key: undefined,
        doc_slug: 'spec',
      },
    ])
    const link = view.find('a.md__ref')
    expect(link.exists()).toBe(true)
    expect(link.attributes('href')).toContain('/docs/spec')
  })

  it('offers nothing to click when the summary names nothing', async () => {
    const view = await render([
      {
        ...EVENT,
        verb: 'label.created',
        entity: 'label',
        summary: 'created label Urgent',
        item_key: undefined,
      },
    ])
    // A control that goes nowhere is worse than plain text, which is what
    // this row correctly stays.
    expect(view.findAll('.md__ref')).toHaveLength(0)
    expect(view.text()).toContain('created label Urgent')
  })

  it('narrows the feed to the person whose name you clicked', async () => {
    const view = await render()
    activity.mockClear()
    await view.find('.activity-view__who--live').trigger('click')
    await flushPromises()

    expect(activity).toHaveBeenCalled()
    const [params] = activity.mock.calls.at(-1) as [{ actor?: string }]
    expect(params.actor).toBe('daniela')
  })

  it('does not offer that on a row with no person behind it', async () => {
    const view = await render([
      { ...EVENT, actor_id: 'system', actor_kind: 'system' },
    ])
    // The system actor has no handle, so filtering by it would narrow the
    // feed to nobody.
    expect(view.find('.activity-view__who--live').exists()).toBe(false)
  })
})
