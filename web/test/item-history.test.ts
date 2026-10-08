/**
 * A card's history, as sentences. The changes are the shapes the server
 * records in `server/src/services/items.ts` and resolves in `reads.ts`.
 */
import { describe, expect, it } from 'vitest'
import { describe as sentence, shownInHistory } from '@/lib/history'
import type { IItemEvent } from '@/types/api'

const ev = (
  verb: string,
  changes?: Record<string, unknown>,
  summary = '',
): IItemEvent => ({
  id: 'e',
  ts: 0,
  verb,
  summary,
  actor_kind: 'human',
  changes,
})

const flat = (e: IItemEvent) =>
  sentence(e)
    .map((s) =>
      s.kind === 'text'
        ? s.text
        : s.kind === 'person'
          ? `@${s.handle}`
          : s.kind === 'label'
            ? `[${s.name}]`
            : s.kind === 'item'
              ? `<${s.key}>`
              : `G-${s.number}`,
    )
    .join('')

describe('card history sentences', () => {
  it('names who was put on and taken off, as people', () => {
    expect(flat(ev('item.assigned', { added: ['ivan'], removed: [] }))).toBe(
      'assigned @ivan',
    )
    expect(
      flat(ev('item.assigned', { added: ['jose'], removed: ['ivan', 'dana'] })),
    ).toBe('assigned @jose, and took @ivan and @dana off')
  })

  it('names labels, and keeps the group for the tooltip', () => {
    expect(
      flat(
        ev('item.labeled', { added: ['Type/Bug', 'Type/Acta'], removed: [] }),
      ),
    ).toBe('added the labels [Type/Bug] and [Type/Acta]')
  })

  it('reads an old event that recorded nothing as the vaguer thing it was', () => {
    expect(flat(ev('item.labeled'))).toBe('changed the labels')
    expect(flat(ev('item.updated'))).toBe('edited it')
  })

  it('says what an update touched', () => {
    expect(
      flat(
        ev('item.updated', {
          title: { from: 'a', to: 'b' },
          description: true,
        }),
      ),
    ).toBe('renamed it from “a” to “b”, edited the description')
  })

  it('links the card a move came from', () => {
    expect(
      flat(
        ev('item.moved', { from_key: 'NU-134', space: 'LA', list: 'To Do' }),
      ),
    ).toBe('moved it from <NU-134> to the LA space, into To Do')
  })

  it('falls back to the server summary for anything it does not know', () => {
    expect(
      flat(ev('attachment.added', undefined, 'attached a.png to NU-1')),
    ).toBe('attached a.png to NU-1')
  })

  it('hides the second row a removal writes', () => {
    expect(shownInHistory(ev('item.unassigned'))).toBe(false)
    expect(shownInHistory(ev('item.assigned'))).toBe(true)
  })
})
