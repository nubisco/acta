/**
 * The response-times report in a space (LA-370): which week it asks about,
 * how it says how long, and what it draws from what the server returns.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { IResponseTimes } from '@/types/api'
import {
  formatDuration,
  periodRange,
  rangeText,
  weekStart,
} from '@/lib/responseTimes'

const responseTimes = vi.fn()
vi.mock('@/api/client', () => ({
  api: { responseTimes: (p: unknown) => responseTimes(p) },
}))
vi.mock('@/stores/workspace', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    useWorkspace: () => ({ overview: { value: null } }),
  }
})

import ResponseTimesView from '@/components/views/ResponseTimesView.vue'

const HOUR = 3_600_000

describe('ranges', () => {
  // Wednesday 22 October 2026, mid-afternoon, local time.
  const wednesday = new Date(2026, 9, 22, 15, 30).getTime()
  const monday = new Date(2026, 9, 19).getTime()

  it('starts a week on Monday at midnight', () => {
    expect(weekStart(wednesday)).toBe(monday)
    expect(weekStart(monday)).toBe(monday)
    // Sunday belongs to the week that started six days before.
    expect(weekStart(new Date(2026, 9, 25, 23).getTime())).toBe(monday)
  })

  it('asks for this week up to now, and last week as a closed range', () => {
    expect(periodRange('this-week', wednesday)).toEqual({ from: monday })
    expect(periodRange('last-week', wednesday)).toEqual({
      from: new Date(2026, 9, 12).getTime(),
      to: monday,
    })
    expect(periodRange('last-30-days', wednesday)).toEqual({
      from: wednesday - 30 * 24 * HOUR,
    })
  })

  it('names the last day of a range, not the first moment after it', () => {
    const text = rangeText(monday, new Date(2026, 9, 26).getTime())
    expect(text).toContain('19')
    expect(text).toContain('25')
    expect(text).not.toContain('26')
  })
})

describe('durations', () => {
  it('reads in the two largest units that matter', () => {
    expect(formatDuration(null)).toBe('None')
    expect(formatDuration(0)).toBe('0 min')
    expect(formatDuration(45 * 60_000)).toBe('45 min')
    expect(formatDuration(3 * HOUR)).toBe('3 h')
    expect(formatDuration(3.5 * HOUR)).toBe('3 h 30 min')
    expect(formatDuration(52 * HOUR)).toBe('2 d 4 h')
    expect(formatDuration(48 * HOUR)).toBe('2 d')
  })
})

const stats = (received: number, firstMedian: number | null) => ({
  received,
  unanswered: 1,
  first_response: {
    count: firstMedian === null ? 0 : 3,
    median_ms: firstMedian,
    p90_ms: firstMedian === null ? null : firstMedian * 2,
  },
  resolution: { count: 0, median_ms: null, p90_ms: null },
})

describe('the view', () => {
  beforeEach(() => responseTimes.mockReset())

  it('shows the space, then each label, and asks for this week by default', async () => {
    const report: IResponseTimes = {
      from: 0,
      to: 7 * 24 * HOUR,
      spaces: [
        {
          key: 'SU',
          name: 'Support',
          all: stats(4, 2 * HOUR),
          labels: [
            {
              id: 'lbl_bug',
              name: 'Bug report',
              color: 'red',
              group: 'Need',
              ...stats(3, 90 * 60_000),
            },
          ],
        },
      ],
    }
    responseTimes.mockResolvedValue(report)
    const wrapper = mount(ResponseTimesView, { props: { spaceKey: 'SU' } })
    await flushPromises()

    expect(responseTimes).toHaveBeenCalledTimes(1)
    const asked = responseTimes.mock.calls[0][0] as {
      space: string
      from: number
      to?: number
    }
    expect(asked.space).toBe('SU')
    expect(asked.from).toBe(weekStart(Date.now()))
    expect(asked.to).toBeUndefined()

    const text = wrapper.text()
    expect(text).toContain('All cards')
    expect(text).toContain('Bug report')
    expect(text).toContain('1 h 30 min')
    expect(text).toContain('3 h')
    expect(text).toContain('First response is the first comment or move')
  })

  it('says there is nothing to measure rather than drawing a row of zeroes', async () => {
    responseTimes.mockResolvedValue({
      from: 0,
      to: 1,
      spaces: [
        {
          key: 'SU',
          name: 'Support',
          all: { ...stats(0, null), unanswered: 0 },
          labels: [],
        },
      ],
    })
    const wrapper = mount(ResponseTimesView, { props: { spaceKey: 'SU' } })
    await flushPromises()
    expect(wrapper.text()).toContain('Nothing to measure')
    expect(wrapper.text()).not.toContain('All cards')
  })
})
