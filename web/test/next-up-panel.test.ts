/** Home opens with a greeting and a ranked "Next up", reasons first. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { INextUp } from '@/types/api'

const myNext = vi.fn()
const open = vi.fn()
vi.mock('@/api/client', () => ({ api: { myNext: () => myNext() } }))
vi.mock('@/stores/workspace', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    useWorkspace: () => ({
      me: { value: { name: 'José Silva' } },
      onLive: () => () => {},
    }),
    useInspector: () => ({ open, itemKey: { value: null } }),
  }
})

import NextUpPanel from '@/components/NextUpPanel.vue'

const DATA: INextUp = {
  counts: {
    overdue: 1,
    due_today: 0,
    due_week: 2,
    mentions: 1,
    blocking: 0,
    waiting: 1,
  },
  items: [
    {
      key: 'ST-2',
      title: 'Late one',
      space: 'Stagewright',
      space_key: 'ST',
      list: 'To Do',
      list_role: 'backlog',
      assigned: true,
      score: 95,
      reasons: [
        { code: 'overdue', label: 'Overdue 3 days', points: 65 },
        { code: 'mention', label: 'Ana mentioned you', points: 35 },
        { code: 'active', label: 'In progress', points: 15 },
      ],
    },
  ],
  waiting: [
    {
      key: 'ST-4',
      title: 'Stuck',
      space: 'Stagewright',
      space_key: 'ST',
      list: 'To Do',
      list_role: 'backlog',
      assigned: true,
      score: 0,
      reasons: [],
      waiting_on: 'ST-1',
    },
  ],
}

beforeEach(() => {
  myNext.mockReset()
  open.mockReset()
})

describe('Next up', () => {
  it('greets by first name and sums up what is waiting', async () => {
    myNext.mockResolvedValue(DATA)
    const view = mount(NextUpPanel)
    await flushPromises()
    expect(view.find('h1').text()).toMatch(
      /^Good (morning|afternoon|evening), José$/,
    )
    expect(view.text()).toContain(
      '1 card overdue, 1 mention waiting, 2 more due this week.',
    )
  })

  it('shows two reasons per card, the rest behind a count, and opens it', async () => {
    myNext.mockResolvedValue(DATA)
    const view = mount(NextUpPanel)
    await flushPromises()
    const row = view.find('.next-up__row')
    expect(row.text()).toContain('Overdue 3 days')
    expect(row.text()).toContain('Ana mentioned you')
    expect(row.text()).toContain('+1')
    await row.trigger('click')
    expect(open).toHaveBeenCalledWith('ST-2')
  })

  it('keeps waiting cards apart, saying what they wait on', async () => {
    myNext.mockResolvedValue(DATA)
    const view = mount(NextUpPanel)
    await flushPromises()
    expect(view.find('.next-up__waiting').text()).toContain('Waiting on ST-1')
  })

  it('says so when nothing is waiting', async () => {
    myNext.mockResolvedValue({
      ...DATA,
      items: [],
      waiting: [],
      counts: { ...DATA.counts, overdue: 0, mentions: 0, due_week: 0 },
    })
    const view = mount(NextUpPanel)
    await flushPromises()
    expect(view.text()).toContain('Nothing is waiting on you')
    expect(view.text()).toContain('Nothing is overdue or waiting on you.')
  })
})
