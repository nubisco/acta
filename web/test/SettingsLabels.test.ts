/**
 * Settings, Labels: the two things a group now has beyond a list of names.
 *
 * A group can name a single answer ("Fixes version" is one release), and its
 * labels have an order of their own, because 1.9.0 belongs before 1.11.0 and
 * no amount of sorting by name will agree.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'

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
]

const overview = {
  workspace: { id: 'w1', name: 'Nubisco' },
  spaces: [{ key: 'ST', name: 'Stagewright', lists: [] }],
  labels: LABELS,
  actors: [],
  doc_roots: [],
}

const refresh = vi.fn()
vi.mock('@/stores/workspace', () => ({
  useWorkspace: () => ({
    overview: { value: overview },
    isAdmin: { value: true },
    refresh,
    onLive: () => () => undefined,
  }),
}))

const labelWrite = vi.fn()
vi.mock('@/api/client', () => ({
  api: {
    labelWrite: (...a: unknown[]) => labelWrite(...(a as [])),
  },
  newOpId: () => 'op',
}))

import SettingsLabels from '@/components/settings/SettingsLabels.vue'

function render() {
  return mount(SettingsLabels, { global: { stubs: { teleport: true } } })
}

/** The panel for a group, found by its heading rather than by position. */
function panel(view: ReturnType<typeof render>, name: string) {
  const found = view
    .findAll('.labels-settings__group')
    .find((p) => p.find('h2').text() === name)
  expect(found).toBeDefined()
  return found!
}

describe('Settings, Labels', () => {
  beforeEach(() => {
    labelWrite.mockReset()
    labelWrite.mockResolvedValue({ results: [{ ok: true }] })
    refresh.mockReset()
  })

  // Catalogue order, which is the server's: by group, then by each group's
  // own arrangement. Sorting here would undo the thing this pane sets.
  it('lists each group’s labels in the order the group is arranged', () => {
    const view = render()
    const rows = panel(view, 'Fixes version')
      .findAll('.labels-settings__row .nb-badge')
      .map((b) => b.text())
    expect(rows).toEqual(['1.9.0', '1.11.0', '1.12.0'])
  })

  // Worded for a person. "Exclusive" is a column name, not an explanation.
  it('says what the setting does, in words, and that it is not retroactive', () => {
    const view = render()
    expect(view.text()).toContain('One value per card')
    expect(view.find('.labels-settings__lede').text()).toMatch(
      /already carry several keep them/i,
    )
  })

  it('writes group_update with exclusive when the group is switched', async () => {
    const view = render()
    const input = panel(view, 'Affects version').find(
      '.labels-settings__option input[type="checkbox"]',
    )
    expect((input.element as HTMLInputElement).checked).toBe(false)
    await input.setValue(true)

    expect(labelWrite).toHaveBeenCalledTimes(1)
    expect(labelWrite.mock.calls[0][0]).toEqual([
      {
        op: 'group_update',
        op_id: 'op',
        group: 'lgr_affects_version',
        exclusive: true,
      },
    ])
  })

  it('shows a group that already names a single answer as switched on', () => {
    const view = render()
    const input = panel(view, 'Fixes version').find(
      '.labels-settings__option input[type="checkbox"]',
    )
    expect((input.element as HTMLInputElement).checked).toBe(true)
  })

  // One op carrying the whole group in the order the drag produced, so the
  // server assigns the positions and nothing here invents numbers.
  it('writes one label_reorder with the whole group, in order', async () => {
    const view = render()
    const grabs = panel(view, 'Fixes version').findAll('.nb-reorder-list__grab')
    expect(grabs.length).toBe(3)
    // Pick the first row up and move it down one, by keyboard: a drag is a
    // pointer gesture jsdom has no layout for, and the component routes both
    // through the same move.
    await grabs[0].trigger('keydown', { key: ' ' })
    await grabs[0].trigger('keydown', { key: 'ArrowDown' })

    expect(labelWrite).toHaveBeenCalledTimes(1)
    expect(labelWrite.mock.calls[0][0]).toEqual([
      {
        op: 'label_reorder',
        op_id: 'op',
        group: 'lgr_fixes_version',
        labels: ['fix-1110', 'fix-190', 'fix-1120'],
      },
    ])
  })
})
