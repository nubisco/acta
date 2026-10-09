/** A line of markdown as a reader would say it (UX audit, 2026-10-09). */
import { describe, expect, it } from 'vitest'
import { plainExcerpt } from '@/lib/excerpt'

const names: Record<string, string> = {
  daniela: 'Daniela Pinho',
  ivan: 'Ivan Petrov',
}
const say = (text: string) => plainExcerpt(text, (h) => names[h])

describe('plainExcerpt', () => {
  it('shows people by name, never by handle', () => {
    expect(say('See ST-23 and @daniela for details.')).toBe(
      'See ST-23 and Daniela Pinho for details.',
    )
    expect(say('owner: [[@ivan]]')).toBe('owner: Ivan Petrov')
    expect(say('mail me@example.com')).toBe('mail me@example.com')
    expect(say('ask @nobody')).toBe('ask nobody')
  })

  it('keeps card keys, which RefText makes openable', () => {
    expect(say('Related to [[WEB-19]] and ST-4.')).toBe(
      'Related to WEB-19 and ST-4.',
    )
    expect(say('See [[doc:runbook|the runbook]]')).toBe('See the runbook')
  })

  it('drops markdown syntax but keeps the words', () => {
    expect(
      say('# Release runbook\n\n## Steps\n\n- **Tag** it\n- `npm run build`'),
    ).toBe('Release runbook Steps Tag it npm run build')
    expect(say('[the site](https://x.y) and ![logo](a.png)')).toBe(
      'the site and logo',
    )
    expect(say('Draft for \\[\\[x\\]\\] _later_')).toBe('Draft for [[x]] later')
    expect(say('> quoted\n1. first\n- [x] done task')).toBe(
      'quoted first done task',
    )
  })
})
