/**
 * Shared cache of link preview metadata, so every surface that renders
 * markdown resolves the same URL to the same card.
 *
 * The same shape as the ref-card store, and for the same reasons: requests
 * batch across surfaces, so a document with twenty links is one call rather
 * than twenty, and a URL that appears in both a document and a comment is
 * asked about once.
 *
 * Nothing here fetches the page itself. The browser cannot read another
 * origin's HTML, and even if it could, a document full of links would mean
 * the reader's machine announcing to twenty sites that somebody is reading
 * this document. The server fetches, and it caches, so the answer is usually
 * already waiting.
 */
import { reactive, ref } from 'vue'
import { api } from '@/api/client'
import type { ILinkPreview } from '@/components/decorations/linkCards'

/** Absent = not asked yet. A refusal comes back as a row with status 'none'. */
const previews = reactive(new Map<string, ILinkPreview>())
/** Bumped on every cache change so DOM hydrators know to re-run. */
const version = ref(0)

/** Matches the server's own cap, so a batch is never refused for being long. */
const BATCH = 30

const pending = new Set<string>()
let flushTimer: ReturnType<typeof setTimeout> | null = null

async function flush(): Promise<void> {
  flushTimer = null
  const urls = [...pending].slice(0, BATCH)
  for (const url of urls) pending.delete(url)
  if (urls.length === 0) return
  try {
    const { previews: rows } = await api.linkPreviews(urls)
    for (const row of rows) previews.set(row.url, row)
    version.value++
  } catch {
    // Transient failure: leave the URLs unfetched so a later render retries
    // rather than caching a "no card" that is really "no network".
  }
  // More than one screenful of links: the rest go in the next batch.
  if (pending.size > 0) flushTimer ??= setTimeout(() => void flush(), 50)
}

function request(url: string): void {
  if (previews.has(url) || pending.has(url)) return
  pending.add(url)
  flushTimer ??= setTimeout(() => void flush(), 50)
}

export function useLinkPreviews() {
  return { previews, version, request }
}
