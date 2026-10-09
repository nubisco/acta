/**
 * Label groups as fields: grouped in the picker, ordered the way the group is
 * arranged, and a group that names a single answer replacing rather than
 * accumulating.
 *
 * The case throughout is the real one. "Fixes version" names one release and
 * "Affects version" names several, both hold 1.9.0, 1.11.0 and 1.12.0, and a
 * bare name therefore cannot say which field a card's 1.12.0 belongs to.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { NbSelect } from '@nubisco/ui'
import type { VueWrapper } from '@vue/test-utils'

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useRoute: () => ({ query: {}, params: {} }),
}))
vi.mock('@/lib/paths', () => ({ wpath: (p: string) => `/nubisco${p}` }))

const itemGet = vi.fn()
const itemWrite = vi.fn()
const overview = vi.fn()
vi.mock('@/api/client', () => ({
  api: {
    itemGet: (...a: unknown[]) => itemGet(...(a as [])),
    itemWrite: (...a: unknown[]) => itemWrite(...(a as [])),
    overview: () => overview(),
  },
  attachmentHref: (id: string) => `/api/v1/attachments/${id}`,
  newOpId: () => 'op',
  ApiHttpError: class extends Error {},
}))

import ItemInspector from '@/components/ItemInspector.vue'
import { useInspector, useWorkspace } from '@/stores/workspace'

/**
 * Deliberately not in alphabetical order, in either direction: "Fixes
 * version" before "Affects version", and 1.9.0 before 1.11.0. This is the
 * order the server computes, and anything that sorts it undoes the feature.
 */
const LABELS = [
  {
    group_id: 'lgr_fixes_version',
    group_name: 'Fixes version',
    space_key: 'ST',
    id: 'fix-190',
    name: '1.9.0',
    color: 'blue',
    exclusive: true as const,
  },
  {
    group_id: 'lgr_fixes_version',
    group_name: 'Fixes version',
    space_key: 'ST',
    id: 'fix-1110',
    name: '1.11.0',
    color: 'blue',
    exclusive: true as const,
  },
  {
    group_id: 'lgr_fixes_version',
    group_name: 'Fixes version',
    space_key: 'ST',
    id: 'fix-1120',
    name: '1.12.0',
    color: 'blue',
    exclusive: true as const,
  },
  {
    group_id: 'lgr_affects_version',
    group_name: 'Affects version',
    space_key: 'ST',
    id: 'aff-190',
    name: '1.9.0',
    color: 'orange',
  },
  {
    group_id: 'lgr_affects_version',
    group_name: 'Affects version',
    space_key: 'ST',
    id: 'aff-1110',
    name: '1.11.0',
    color: 'orange',
  },
  {
    group_id: 'lgr_affects_version',
    group_name: 'Affects version',
    space_key: 'ST',
    id: 'aff-1120',
    name: '1.12.0',
    color: 'orange',
  },
]

const OVERVIEW = {
  workspace: { id: 'w1', name: 'Nubisco' },
  spaces: [
    {
      key: 'ST',
      name: 'Stagewright',
      lists: [{ id: 'l1', name: 'Doing', items: 1 }],
    },
  ],
  labels: LABELS,
  actors: [],
  doc_roots: [],
}

const byId = new Map(LABELS.map((l) => [l.id, l]))

/** The card, as the server would keep it: ids are the truth, names follow. */
let card: { ids: string[] }

function detail() {
  return {
    key: 'ST-73',
    space: 'ST',
    list: 'Doing',
    title: 'First customer reward',
    description: '',
    rev: 4,
    labels: card.ids.map((id) => byId.get(id)!.name),
    label_ids: [...card.ids],
    assignees: [],
    comments: [],
    attachments: [],
    checklists: [],
  }
}

/**
 * A write that actually changes the card, so a second pick is made against
 * what the first one left behind rather than against a frozen fixture. The
 * exclusive replacement is the client's here: the test is about what this
 * app sends and shows, and the server's own replacement is tested there.
 */
function applyWrite(ops: { op: string; add?: string[]; remove?: string[] }[]) {
  for (const op of ops) {
    if (op.op !== 'label') continue
    card.ids = card.ids.filter((id) => !(op.remove ?? []).includes(id))
    for (const id of op.add ?? []) if (!card.ids.includes(id)) card.ids.push(id)
  }
  return { results: ops.map(() => ({ ok: true })) }
}

async function render() {
  const view = mount(ItemInspector, {
    props: { itemKey: 'ST-73' },
    global: { stubs: { teleport: true } },
  })
  await flushPromises()
  return view
}

/** The label picker, found by the options it carries rather than by position. */
function picker(view: VueWrapper) {
  const found = view
    .findAllComponents(NbSelect)
    .find((s) =>
      ((s.props('options') ?? []) as { value: string }[]).some(
        (o) => o.value === 'fix-1120',
      ),
    )
  expect(found).toBeDefined()
  return found!
}

async function open(view: VueWrapper) {
  const select = picker(view)
  await select.find('.nb-select__trigger').trigger('click')
  await flushPromises()
  return select
}

async function pick(view: VueWrapper, id: string) {
  const select = await open(view)
  const index = (
    (select.props('options') ?? []) as { value: string }[]
  ).findIndex((o) => o.value === id)
  await select.findAll('.nb-select__option')[index].trigger('click')
  await flushPromises()
}

describe('the label picker', () => {
  beforeEach(() => {
    useInspector().close()
    useInspector().open('ST-73')
    itemGet.mockReset()
    itemWrite.mockReset()
    overview.mockReset()
    overview.mockResolvedValue(OVERVIEW)
    itemGet.mockImplementation(async () => ({ items: [detail()] }))
    itemWrite.mockImplementation(async (ops: never) => applyWrite(ops))
    card = { ids: [] }
    return useWorkspace().refresh()
  })

  it('groups the options, and keeps the catalogue order', async () => {
    const view = await render()
    const select = await open(view)
    const rows = select.findAll('.nb-select__option').map((o) => o.text())
    expect(rows).toEqual([
      'Fixes version',
      '1.9.0',
      '1.11.0',
      '1.12.0',
      'Affects version',
      '1.9.0',
      '1.11.0',
      '1.12.0',
    ])
  })

  // A heading is a heading. If it could be picked it would land on the card
  // as a label nobody chose.
  it('leaves the group headings inert', async () => {
    const view = await render()
    const select = await open(view)
    const heading = select.findAll('.nb-select__option')[0]
    expect(heading.attributes('aria-disabled')).toBe('true')
    await heading.trigger('click')
    await flushPromises()
    expect(itemWrite).not.toHaveBeenCalled()
  })

  it('replaces the value in a group that names a single answer', async () => {
    card = { ids: ['fix-190'] }
    const view = await render()
    await pick(view, 'fix-1120')

    expect(itemWrite).toHaveBeenCalledTimes(1)
    expect(itemWrite.mock.calls[0][0]).toEqual([
      {
        op: 'label',
        op_id: 'op',
        key: 'ST-73',
        add: ['fix-1120'],
        remove: ['fix-190'],
      },
    ])
    expect(card.ids).toEqual(['fix-1120'])
    // And the panel says so, rather than showing two and disagreeing with
    // the server after the next reload.
    const values = picker(view).findAll('.nb-select__value .nb-badge')
    expect(values.map((b) => b.text())).toEqual(['Fixes version: 1.12.0'])
  })

  it('keeps both values in an ordinary group', async () => {
    card = { ids: ['aff-190'] }
    const view = await render()
    await pick(view, 'aff-1120')

    expect(itemWrite.mock.calls[0][0]).toEqual([
      {
        op: 'label',
        op_id: 'op',
        key: 'ST-73',
        add: ['aff-1120'],
        remove: undefined,
      },
    ])
    expect(card.ids).toEqual(['aff-190', 'aff-1120'])
    const values = picker(view).findAll('.nb-select__value .nb-badge')
    expect(values.map((b) => b.text())).toEqual(['1.9.0', '1.12.0'])
  })

  // The reason ids exist at all. With names, one of these two would select
  // the other's row, or both rows at once.
  it('shows the same value name in two groups under the group it belongs to', async () => {
    card = { ids: ['aff-1120', 'fix-1120'] }
    const view = await render()
    const select = await open(view)
    const options = (select.props('options') ?? []) as { value: string }[]
    const rows = select.findAll('.nb-select__option')
    const selected = options
      .map((o, i) =>
        rows[i].classes().includes('nb-select__option--selected')
          ? o.value
          : null,
      )
      .filter((v) => v !== null)
    expect(selected).toEqual(['fix-1120', 'aff-1120'])

    // And on the field itself the exclusive one reads as the field it is.
    const values = picker(view).findAll('.nb-select__value .nb-badge')
    expect(values.map((b) => b.text())).toEqual([
      '1.12.0',
      'Fixes version: 1.12.0',
    ])
  })
})
