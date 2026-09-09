/**
 * Labels render as their own colour wherever they appear, which is how people
 * recognise them. A select showing plain text is showing a different thing to
 * the one on the card.
 */
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import LabelBadge from '@/components/LabelBadge.vue'

vi.mock('@/stores/workspace', () => ({
  useWorkspace: () => ({
    overview: {
      value: {
        labels: [
          {
            group_name: 'Type',
            board_key: null,
            id: '1',
            name: 'Bug',
            color: 'red',
          },
          {
            group_name: 'Type',
            board_key: null,
            id: '2',
            name: 'Feature',
            color: 'lime',
          },
        ],
      },
    },
  }),
}))

describe('LabelBadge', () => {
  it('uses the label’s own colour', () => {
    expect(mount(LabelBadge, { props: { name: 'Bug' } }).html()).toContain(
      'nb-badge--red',
    )
  })

  it('maps a server colour with no badge variant onto the nearest one', () => {
    // The server's palette is wider than the badge variants, so lime lands on
    // green rather than falling through to grey.
    expect(mount(LabelBadge, { props: { name: 'Feature' } }).html()).toContain(
      'nb-badge--green',
    )
  })

  it('falls back to grey for a label it does not know', () => {
    const html = mount(LabelBadge, { props: { name: 'Nope' } }).html()
    expect(html).toContain('nb-badge--grey')
    expect(html).toContain('Nope')
  })
})
