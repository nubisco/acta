/**
 * A board card's slots: what each one says, empty or full. The shape is the
 * same on every card (Jose, 2026-10-08), so these answer "what goes in the
 * slot", never "whether there is one".
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { countView, dueView, parseProgress, sizeText } from '@/lib/cards'
import BoardCard from '@/components/BoardCard.vue'
import type { ISpaceItemRow } from '@/types/api'

const NOON = new Date(2026, 9, 8, 12).getTime()
const day = (offset: number) => new Date(2026, 9, 8 + offset, 9).getTime()

describe('a due date', () => {
  it('reads today and tomorrow as words, and soon', () => {
    expect(dueView(day(0), false, NOON)).toMatchObject({
      tone: 'soon',
      text: 'Today',
    })
    expect(dueView(day(1), false, NOON)).toMatchObject({
      tone: 'soon',
      text: 'Tomorrow',
    })
  })

  it('counts the days it is late', () => {
    expect(dueView(day(-1), false, NOON)).toMatchObject({
      tone: 'late',
      text: '1 day late',
    })
    expect(dueView(day(-3), false, NOON)).toMatchObject({
      tone: 'late',
      text: '3 days late',
    })
  })

  it('is a plain date further out, and history once done', () => {
    expect(dueView(day(16), false, NOON).tone).toBe('later')
    expect(dueView(day(-3), true, NOON).tone).toBe('met')
    expect(dueView(undefined, false, NOON)).toMatchObject({
      tone: 'none',
      text: '',
    })
  })
})

describe('a footer count', () => {
  it('is dimmed at zero and green when a pair is complete', () => {
    expect(countView(0)).toEqual({ text: '0', tone: 'zero' })
    expect(countView(3)).toEqual({ text: '3', tone: 'some' })
    expect(countView(0, 0)).toEqual({ text: '0', tone: 'zero' })
    expect(countView(1, 3)).toEqual({ text: '1/3', tone: 'some' })
    expect(countView(3, 3)).toEqual({ text: '3/3', tone: 'full' })
  })

  it('reads the board’s "3/5" and sizes without inventing units', () => {
    expect(parseProgress('3/5')).toEqual([3, 5])
    expect(parseProgress(undefined)).toEqual([0, 0])
    expect(sizeText(3)).toBe('3')
    expect(sizeText(0.5)).toBe('0.5')
    expect(sizeText(undefined)).toBe('')
  })
})

describe('the card', () => {
  const stubs = {
    RouterLink: { template: '<a><slot /></a>' },
    ActorAvatar: {
      props: ['handle'],
      template: '<span class="face">{{ handle }}</span>',
    },
    LabelBadge: {
      props: ['id', 'name'],
      template: '<span class="label">{{ name ?? id }}</span>',
    },
  }
  const mountCard = (row: Partial<ISpaceItemRow>) =>
    mount(BoardCard, {
      props: {
        row: {
          key: 'MA-1',
          title: 'A card',
          list: 'Backlog',
          rev: 1,
          updated: 0,
          pos: 1,
          ...row,
        },
      },
      global: { stubs, directives: { nbTooltip: {} } },
    })

  it('keeps every row when the card is empty, each saying so', () => {
    const text = mountCard({}).text()
    for (const slot of ['No description', 'No goal', 'No labels'])
      expect(text).toContain(slot)
    // The four counters are always there.
    expect(mountCard({}).findAll('.board-card__count')).toHaveLength(4)
  })

  it('shows the goal it serves, and how many more', () => {
    const wrapper = mountCard({
      goals: [
        {
          number: 6,
          key: 'G-6',
          title: 'Nubisco.io: shipped and selling',
          status: 'on_track',
        },
        { number: 2, key: 'G-2', title: 'One voice', status: 'at_risk' },
      ],
    })
    expect(wrapper.find('.board-card__goal').text()).toContain('G-6')
    expect(wrapper.find('.board-card__goal').text()).toContain(
      'Nubisco.io: shipped and selling',
    )
    expect(wrapper.text()).toContain('+1')
    expect(wrapper.text()).not.toContain('No goal')
  })

  it('stops at three faces', () => {
    const wrapper = mountCard({ assignees: ['a', 'b', 'c', 'd', 'e'] })
    expect(wrapper.findAll('.face')).toHaveLength(3)
    expect(wrapper.text()).toContain('+2')
  })

  it('asks to set a field from its empty slot, anchored to it', async () => {
    const wrapper = mountCard({})
    const slot = wrapper
      .findAll('button')
      .find((b) => b.text().includes('No goal'))!
    await slot.trigger('click')
    const [field, key, anchor] = wrapper.emitted('edit')![0] as [
      string,
      string,
      HTMLElement,
    ]
    expect([field, key]).toEqual(['goal', 'MA-1'])
    expect(anchor).toBeInstanceOf(HTMLElement)
  })

  it('names the open blockers', () => {
    expect(mountCard({ blocked_by: ['MA-3', 'MA-4'] }).text()).toContain(
      'Blocked by MA-3 +1',
    )
  })
})
