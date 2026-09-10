/**
 * Thin live-API fetcher (optional path of mvp F11). The converter and loader
 * work purely from export files; this module only turns a board id into the
 * same JSON shape, and downloads file attachments when credentials allow.
 */

export const TRELLO_API = 'https://api.trello.com/1'

export interface ITrelloCreds {
  key: string
  token: string
}

export function trelloCredsFromEnv(): ITrelloCreds | null {
  const key = process.env.TRELLO_KEY
  const token = process.env.TRELLO_TOKEN
  if (!key || !token) return null
  return { key, token }
}

/** Trello's hard ceiling for a single actions page. */
const ACTIONS_PAGE = 1000

/** Politeness between the per-card follow-up calls. */
const CARD_PACE_MS = 120

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function fetchTrelloBoard(
  idOrShortLink: string,
  creds: ITrelloCreds,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const params = new URLSearchParams({
    fields: 'all',
    cards: 'all',
    lists: 'all',
    labels: 'all',
    checklists: 'all',
    actions: 'commentCard',
    actions_limit: String(ACTIONS_PAGE),
    attachments: 'true',
    members: 'all',
    key: creds.key,
    token: creds.token,
  })
  const res = await fetchImpl(`${TRELLO_API}/boards/${idOrShortLink}?${params}`)
  if (!res.ok)
    throw new Error(`trello api ${res.status} for board ${idOrShortLink}`)
  const board = (await res.json()) as Record<string, unknown>
  await backfillCardComments(board, creds, fetchImpl)
  return board
}

/**
 * Fill in comments the board's own action feed did not carry.
 *
 * `?actions=commentCard` on a board returns a slice of the BOARD's activity,
 * not the union of its cards' comments. Once a board has more activity than
 * the window holds, older comments simply are not in the response, and the
 * card they belong to imports looking like it never had a conversation. That
 * is not hypothetical: it is how a card with two comments arrived with none,
 * and it is silent because every card the feed DID mention imports perfectly.
 *
 * Each card carries its own count in `badges.comments`, so the shortfall is
 * knowable per card. Where the two disagree, ask that card directly. Only
 * where they disagree, so a board whose feed was complete costs no extra
 * calls.
 */
async function backfillCardComments(
  board: Record<string, unknown>,
  creds: ITrelloCreds,
  fetchImpl: typeof fetch,
): Promise<void> {
  const cards = Array.isArray(board.cards)
    ? (board.cards as Record<string, unknown>[])
    : []
  const actions = Array.isArray(board.actions)
    ? (board.actions as Record<string, unknown>[])
    : []

  const seen = new Map<string, number>()
  const haveActionId = new Set<string>()
  for (const action of actions) {
    if (action.type !== 'commentCard') continue
    haveActionId.add(String(action.id))
    const data = action.data as { card?: { id?: string } } | undefined
    const cardId = data?.card?.id
    if (!cardId) continue
    seen.set(cardId, (seen.get(cardId) ?? 0) + 1)
  }

  for (const card of cards) {
    const id = typeof card.id === 'string' ? card.id : null
    if (!id) continue
    const badges = card.badges as { comments?: number } | undefined
    const expected = badges?.comments ?? 0
    if (expected <= (seen.get(id) ?? 0)) continue

    for (const action of await fetchCardComments(id, creds, fetchImpl)) {
      // The two sources overlap, so dedupe on the action id rather than
      // trusting that a card is either wholly present or wholly absent.
      if (haveActionId.has(String(action.id))) continue
      haveActionId.add(String(action.id))
      actions.push(action)
    }
    await sleep(CARD_PACE_MS)
  }
  board.actions = actions
}

/** Every comment on one card, oldest last, paging back through `before`. */
async function fetchCardComments(
  cardId: string,
  creds: ITrelloCreds,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>[]> {
  const all: Record<string, unknown>[] = []
  let before: string | undefined
  for (;;) {
    const params = new URLSearchParams({
      filter: 'commentCard',
      limit: String(ACTIONS_PAGE),
      key: creds.key,
      token: creds.token,
    })
    if (before) params.set('before', before)
    const res = await fetchImpl(
      `${TRELLO_API}/cards/${cardId}/actions?${params}`,
    )
    if (!res.ok)
      throw new Error(`trello api ${res.status} for card ${cardId} comments`)
    const page = (await res.json()) as Record<string, unknown>[]
    if (!Array.isArray(page) || page.length === 0) return all
    all.push(...page)
    if (page.length < ACTIONS_PAGE) return all
    // Actions come newest first, so the oldest of this page bounds the next.
    const oldest = page[page.length - 1]
    const date = typeof oldest.date === 'string' ? oldest.date : undefined
    if (!date || date === before) return all
    before = date
    await sleep(CARD_PACE_MS)
  }
}

/** Download an uploaded attachment (Trello requires the OAuth header). */
export async function downloadTrelloAttachment(
  url: string,
  creds: ITrelloCreds,
  fetchImpl: typeof fetch = fetch,
): Promise<{ bytes: Uint8Array; mime: string | null } | null> {
  const res = await fetchImpl(url, {
    headers: {
      authorization: `OAuth oauth_consumer_key="${creds.key}", oauth_token="${creds.token}"`,
    },
  })
  if (!res.ok) return null
  return {
    bytes: new Uint8Array(await res.arrayBuffer()),
    mime: res.headers.get('content-type'),
  }
}
