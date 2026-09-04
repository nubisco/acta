/**
 * Thin live-API fetcher (optional path of mvp F12). Pulls a space's pages in
 * the Confluence REST shape the normalizer already accepts; the converter and
 * loader work purely from files.
 */

export interface IConfluenceCreds {
  base: string
  email: string
  apiToken: string
}

export function confluenceCredsFromEnv(): IConfluenceCreds | null {
  const base = process.env.CONFLUENCE_BASE
  const email = process.env.CONFLUENCE_EMAIL
  const apiToken = process.env.CONFLUENCE_API_TOKEN
  if (!base || !email || !apiToken) return null
  return { base: base.replace(/\/+$/, ''), email, apiToken }
}

export async function fetchConfluenceSpace(
  spaceKey: string,
  creds: IConfluenceCreds,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown[]> {
  const pages: unknown[] = []
  let start = 0
  const limit = 50
  for (;;) {
    const params = new URLSearchParams({
      spaceKey,
      type: 'page',
      status: 'current',
      expand:
        'body.storage,ancestors,version,history,space,metadata.properties',
      limit: String(limit),
      start: String(start),
    })
    const res = await fetchImpl(
      `${creds.base}/wiki/rest/api/content?${params}`,
      {
        headers: {
          authorization: `Basic ${Buffer.from(
            `${creds.email}:${creds.apiToken}`,
          ).toString('base64')}`,
          accept: 'application/json',
        },
      },
    )
    if (!res.ok)
      throw new Error(`confluence api ${res.status} for space ${spaceKey}`)
    const data = (await res.json()) as { results: unknown[]; size: number }
    pages.push(...data.results)
    if (data.results.length < limit) return pages
    start += limit
  }
}
