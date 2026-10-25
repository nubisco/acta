/**
 * Automation at two levels (Jose, 2026-10-24). What files cards into one
 * space (its ingest endpoints, its connections, its rules) is in that space's
 * Settings. Workspace Settings keeps what runs across every space, and says
 * where the rest went, because old links to its Automation tab still land
 * there.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { ruleSpace } from '@/components/settings/rules'

const RULES = [
  {
    id: 'r-st',
    name: 'Bugs to triage',
    trigger: 'item.created',
    condition: 'space=ST label=bug',
    action: { kind: 'move_item', list: 'Triage' },
    enabled: true,
  },
  {
    id: 'r-into-de',
    name: 'Done work to the archive board',
    trigger: 'item.completed',
    action: { kind: 'move_item', space: 'DE', list: 'Shipped' },
    enabled: true,
  },
  {
    id: 'r-all',
    name: 'Thank whoever reports',
    trigger: 'item.created',
    action: { kind: 'comment', body: 'Thanks' },
    enabled: true,
  },
  {
    id: 'r-gone',
    name: 'From a deleted space',
    trigger: 'item.created',
    condition: 'space=OLD',
    action: { kind: 'complete' },
    enabled: false,
  },
]

const ingestTokens = vi.fn(async () => ({
  tokens: [
    { id: 't1', name: 'Contact form', space: 'ST', list: null, items: 3 },
    { id: 't2', name: 'Bug form', space: 'DE', list: null, items: 0 },
  ],
}))
const connections = vi.fn(async () => ({
  connections: [
    {
      id: 'c1',
      name: 'GitHub',
      provider: 'github',
      space: 'ST',
      list: null,
      enabled: true,
    },
  ],
}))
const webhooks = vi.fn(async () => ({ webhooks: [] }))
const rules = vi.fn(async () => ({ rules: RULES }))

vi.mock('@/api/client', () => ({
  api: { ingestTokens, webhooks, rules, connections },
  getWorkspaceSlug: () => 'nubisco',
  newOpId: () => 'op',
}))

vi.mock('@/stores/workspace', () => ({
  useWorkspace: () => ({
    overview: {
      value: {
        spaces: [
          { key: 'DE', name: 'Design', lists: [] },
          { key: 'ST', name: 'Stagewright', lists: [] },
        ],
        labels: [],
        actors: [],
      },
    },
    isAdmin: { value: true },
    refresh: vi.fn(),
  }),
}))

const ruleEditorSpace = vi.fn()
const RuleEditStub = defineComponent({
  props: { open: Boolean, rule: Object, space: String },
  setup(props) {
    return () => {
      ruleEditorSpace(props.space)
      return h('div')
    }
  },
})
const Inert = defineComponent({ render: () => h('div') })

async function mountAt(space?: string) {
  const Page = (await import('@/components/settings/SettingsAutomation.vue'))
    .default
  const wrapper = mount(Page, {
    props: space ? { space } : {},
    global: {
      stubs: {
        NewTokenModal: Inert,
        NewWebhookModal: Inert,
        NewConnectionModal: Inert,
        RuleEditModal: RuleEditStub,
      },
    },
  })
  await flushPromises()
  return wrapper
}

function headings(wrapper: Awaited<ReturnType<typeof mountAt>>): string[] {
  return wrapper.findAll('h2').map((h) => h.text())
}

function table(wrapper: Awaited<ReturnType<typeof mountAt>>, label: string) {
  return wrapper.find(`[aria-label="${label}"]`)
}

beforeEach(() => ruleEditorSpace.mockClear())

describe('ruleSpace: where a rule belongs, read from what it says', () => {
  it('is the space its condition names', () => {
    expect(
      ruleSpace({
        condition: 'space=ST label=bug',
        action: { kind: 'complete' },
      }),
    ).toBe('ST')
  })

  it('is the space a move files cards into, when the condition names none', () => {
    expect(
      ruleSpace({ action: { kind: 'move_item', space: 'DE', list: 'X' } }),
    ).toBe('DE')
  })

  it('prefers where it fires over where it sends', () => {
    expect(
      ruleSpace({
        condition: 'space=ST',
        action: { kind: 'move_item', space: 'DE', list: 'X' },
      }),
    ).toBe('ST')
  })

  it('is null for a rule that runs on every space', () => {
    expect(
      ruleSpace({ condition: 'label=bug', action: { kind: 'complete' } }),
    ).toBeNull()
  })
})

describe("a space's Settings, Automation", () => {
  it('shows what files cards into this space, and nothing workspace-wide', async () => {
    const wrapper = await mountAt('ST')
    expect(headings(wrapper)).toEqual([
      'Ingest endpoints',
      'Connections',
      'Rules',
    ])
    const ingest = table(wrapper, 'Ingest endpoints').text()
    expect(ingest).toContain('Contact form')
    expect(ingest).not.toContain('Bug form')
    expect(table(wrapper, 'Connections').text()).toContain('GitHub')
    const ruleText = table(wrapper, 'Rules').text()
    expect(ruleText).toContain('Bugs to triage')
    expect(ruleText).not.toContain('Thank whoever reports')
    expect(ruleText).not.toContain('Done work to the archive board')
  })

  it('lists a rule that moves cards in from anywhere under its target', async () => {
    const wrapper = await mountAt('DE')
    const ruleText = table(wrapper, 'Rules').text()
    expect(ruleText).toContain('Done work to the archive board')
    expect(table(wrapper, 'Connections').text()).toContain('No connections yet')
  })

  it('hands the space to the rule editor, so a new rule starts narrowed to it', async () => {
    await mountAt('ST')
    expect(ruleEditorSpace).toHaveBeenLastCalledWith('ST')
  })
})

describe('workspace Settings, Automation', () => {
  it('keeps what runs across every space, and points at the rest', async () => {
    const wrapper = await mountAt()
    expect(headings(wrapper)).toEqual([
      'Webhooks',
      'Rules',
      'Agent tokens',
      'For one space',
    ])
    const ruleText = table(wrapper, 'Rules').text()
    expect(ruleText).toContain('Thank whoever reports')
    // A rule naming a space that is gone stays reachable here.
    expect(ruleText).toContain('From a deleted space')
    expect(ruleText).not.toContain('Bugs to triage')
  })

  it('lists each space with something of its own, with a link to its Settings', async () => {
    const wrapper = await mountAt()
    const pointer = table(wrapper, 'Automation by space')
    expect(pointer.text()).toContain('Design')
    expect(pointer.text()).toContain('Stagewright')
    const hrefs = pointer.findAll('a').map((a) => a.attributes('href'))
    expect(hrefs).toEqual([
      '/nubisco/s/DE/settings?tab=automation',
      '/nubisco/s/ST/settings?tab=automation',
    ])
  })
})
