/**
 * Thin live-API fetcher (optional path of mvp F11). The converter and loader
 * work purely from export files; this module only turns a board id into the
 * same JSON shape, and downloads file attachments when credentials allow.
 */

const TRELLO_API = 'https://api.trello.com/1'

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
    actions_limit: '1000',
    attachments: 'true',
    members: 'all',
    key: creds.key,
    token: creds.token,
  })
  const res = await fetchImpl(`${TRELLO_API}/boards/${idOrShortLink}?${params}`)
  if (!res.ok)
    throw new Error(`trello api ${res.status} for board ${idOrShortLink}`)
  return res.json()
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
