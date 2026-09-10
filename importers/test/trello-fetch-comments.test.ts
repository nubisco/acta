/**
 * Reading comments from Trello.
 *
 * `?actions=commentCard` on a board returns a slice of the BOARD's activity,
 * not the union of its cards' comments. Once a board has more activity than
 * that window holds, older comments are simply absent, the card imports
 * looking like it never had a conversation, and nothing complains: every card
 * the feed DID mention imports perfectly. That is how a real migration lost
 * comments while reporting success.
 *
 * Each card carries its own count in badges.comments, which is what makes the
 * shortfall knowable per card and therefore fixable.
 */
import { describe, expect, it } from 'bun:test'
import { fetchTrelloBoard } from '../src/trello/fetch'

const CREDS = { key: 'k', token: 't' }

function commentAction(id: string, cardId: string, date: string) {
  return { id, type: 'commentCard', date, data: { card: { id: cardId } } }
}

/** A board whose action feed carries only SOME of its cards' comments. */
function boardPayload() {
  return {
    id: 'b1',
    cards: [
      { id: 'c1', badges: { comments: 2 } },
      { id: 'c2', badges: { comments: 1 } },
      { id: 'c3', badges: { comments: 0 } },
    ],
    // Only c2's comment made the window. c1's two did not.
    actions: [commentAction('a-c2', 'c2', '2026-08-01T00:00:00.000Z')],
  }
}

function stubFetch(
  perCard: Record<string, unknown[]>,
  calls: string[] = [],
): typeof fetch {
  return (async (url: string) => {
    calls.push(String(url))
    const cardMatch = /\/cards\/([^/]+)\/actions/.exec(String(url))
    if (cardMatch) {
      return new Response(JSON.stringify(perCard[cardMatch[1]] ?? []), {
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify(boardPayload()), {
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
}

describe('fetchTrelloBoard comment backfill', () => {
  it('asks each short card directly and merges what the feed missed', async () => {
    const calls: string[] = []
    const board = (await fetchTrelloBoard(
      'b1',
      CREDS,
      stubFetch(
        {
          c1: [
            commentAction('a-c1-1', 'c1', '2026-07-02T00:00:00.000Z'),
            commentAction('a-c1-2', 'c1', '2026-07-01T00:00:00.000Z'),
          ],
        },
        calls,
      ),
    )) as { actions: { id: string }[] }

    const ids = board.actions.map((a) => a.id).sort()
    expect(ids).toEqual(['a-c1-1', 'a-c1-2', 'a-c2'])

    // Only the short card is asked. A board whose feed was complete must not
    // pay for a request per card.
    expect(calls.filter((u) => u.includes('/cards/')).length).toBe(1)
    expect(calls.some((u) => u.includes('/cards/c1/actions'))).toBe(true)
    expect(calls.some((u) => u.includes('/cards/c2/'))).toBe(false)
    expect(calls.some((u) => u.includes('/cards/c3/'))).toBe(false)
  })

  it('does not duplicate a comment present in both sources', async () => {
    const board = (await fetchTrelloBoard(
      'b1',
      CREDS,
      // c1's per-card response also repeats c2's comment, as an overlapping
      // window would.
      stubFetch({
        c1: [
          commentAction('a-c1-1', 'c1', '2026-07-02T00:00:00.000Z'),
          commentAction('a-c1-2', 'c1', '2026-07-01T00:00:00.000Z'),
          commentAction('a-c2', 'c2', '2026-08-01T00:00:00.000Z'),
        ],
      }),
    )) as { actions: { id: string }[] }

    expect(board.actions.filter((a) => a.id === 'a-c2')).toHaveLength(1)
    expect(board.actions).toHaveLength(3)
  })

  it('surfaces a failed card read rather than importing a card as silent', async () => {
    const failing = (async (url: string) => {
      if (String(url).includes('/cards/'))
        return new Response('nope', { status: 500 })
      return new Response(JSON.stringify(boardPayload()), {
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    expect(fetchTrelloBoard('b1', CREDS, failing)).rejects.toThrow(
      /card c1 comments/,
    )
  })
})
