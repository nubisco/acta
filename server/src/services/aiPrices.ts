/**
 * What a model costs, read from LiteLLM's public price list at runtime.
 *
 * AGENTS.md ("Prices are fetched, never hard-coded"): no product keeps its own
 * price table. A table copied in by hand is right on the day it is written and
 * wrong from then on, silently, because providers change prices and admins
 * type models nobody listed. So the list is fetched, cached for a day, and a
 * model that is not in it reports tokens and no cost rather than a guess.
 *
 * The cache has two layers. Memory serves every read in an isolate. The
 * `ai_price_list` row is the last good copy, so a restart, a cold Worker
 * isolate or a second instance reads it instead of fetching again. A stale
 * copy keeps being served while one refresh runs in the background, and a
 * failed refresh keeps the copy it had. Nothing here sits in front of a
 * provider call: prices are only read when usage is summarised.
 */
import type { ISqlDriver } from '../db'
import { defer } from '../core/defer'
import type { ITokenUsage, TAiProvider } from './ai'

export const PRICE_LIST_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'

/** How long a copy counts as fresh. */
export const PRICE_TTL_MS = 86_400_000

/**
 * After a failed fetch, how long before trying again. Without it, a price
 * list that is down would be refetched on every settings page load.
 */
export const RETRY_AFTER_FAILURE_MS = 3_600_000

const FETCH_TIMEOUT_MS = 10_000

/** USD per token, input then output. */
export type TPrice = [input: number, output: number]

/** Per provider, per model id with any provider prefix removed. */
export type TPriceTable = Partial<Record<TAiProvider, Record<string, TPrice>>>

export interface IPriceList {
  prices: TPriceTable
  fetchedAt: number
}

/**
 * LiteLLM's name for the API each of our providers calls. The list also
 * carries the same models resold through Bedrock, Vertex, Azure and others,
 * at other prices, which is why the bare `gemini-*` keys (Vertex) are not the
 * ones to read for a key from Google AI Studio.
 */
const LITELLM_PROVIDER: Record<string, TAiProvider> = {
  anthropic: 'anthropic',
  openai: 'openai',
  gemini: 'gemini',
}

/**
 * The fields used from the full file, for the three providers, and nothing
 * else. The full file is about 3 MB, which is too much to keep in a row or
 * re-parse on every cold isolate. This is a few hundred entries.
 */
export function extractPrices(raw: unknown): TPriceTable {
  const table: TPriceTable = {}
  if (!raw || typeof raw !== 'object') return table
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue
    const entry = value as {
      litellm_provider?: unknown
      input_cost_per_token?: unknown
      output_cost_per_token?: unknown
    }
    const provider = LITELLM_PROVIDER[String(entry.litellm_provider)]
    if (!provider) continue
    const input = entry.input_cost_per_token
    const output = entry.output_cost_per_token
    if (typeof input !== 'number' || typeof output !== 'number') continue
    if (!Number.isFinite(input) || !Number.isFinite(output)) continue
    const model = stripPrefix(provider, key)
    ;(table[provider] ??= {})[model] = [input, output]
  }
  return table
}

/**
 * The id without a leading `gemini/`, `openai/` or `models/`. LiteLLM writes
 * Gemini keys as `gemini/gemini-3.5-flash-lite`, Google's own API names a
 * model `models/gemini-3.5-flash-lite`, and an admin may paste either.
 */
function stripPrefix(provider: TAiProvider, id: string): string {
  let model = id.trim()
  for (const prefix of [`${provider}/`, 'models/']) {
    if (model.toLowerCase().startsWith(prefix))
      model = model.slice(prefix.length)
  }
  return model
}

/**
 * A dated snapshot names the same model as its alias, at the same price:
 * `claude-haiku-4-5-20251001`, `gpt-5.6-luna-2026-07-09`, and Gemini's
 * numbered `-001`. The list usually carries both spellings, so this is only
 * the second try, for a snapshot it has not added yet.
 */
const SNAPSHOT_SUFFIX = /-(\d{8}|\d{4}-\d{2}-\d{2}|\d{3})$/

/** The price for a stored model id, or null when the list does not have it. */
export function findPrice(
  list: IPriceList | null,
  provider: string,
  model: string,
): TPrice | null {
  if (!list) return null
  const table = list.prices[provider as TAiProvider]
  if (!table) return null
  const id = stripPrefix(provider as TAiProvider, model)
  const candidates = [id, id.toLowerCase()]
  const base = id.replace(SNAPSHOT_SUFFIX, '')
  if (base !== id) candidates.push(base, base.toLowerCase())
  for (const candidate of candidates) {
    const price = table[candidate]
    if (price) return price
  }
  return null
}

export function costOf(price: TPrice, usage: ITokenUsage): number {
  return usage.inputTokens * price[0] + usage.outputTokens * price[1]
}

// ─── Cache ───────────────────────────────────────────────────────────────────

let memory: IPriceList | null = null
let lastFailureAt = 0
let refreshing: Promise<IPriceList | null> | null = null

/** Tests only: forget everything this isolate has cached. */
export function resetPriceCache(): void {
  memory = null
  lastFailureAt = 0
  refreshing = null
}

async function readStored(db: ISqlDriver): Promise<IPriceList | null> {
  try {
    const rows = await db.query<{ prices: string; fetched_at: number }>(
      "SELECT prices, fetched_at FROM ai_price_list WHERE id = 'litellm'",
    )
    const row = rows[0]
    if (!row) return null
    return {
      prices: JSON.parse(row.prices) as TPriceTable,
      fetchedAt: Number(row.fetched_at),
    }
  } catch (err) {
    console.error('Failed to read the stored AI price list', err)
    return null
  }
}

async function fetchAndStore(
  db: ISqlDriver,
  fetchImpl: typeof fetch,
  now: number,
): Promise<IPriceList | null> {
  try {
    const response = await fetchImpl(PRICE_LIST_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const prices = extractPrices(await response.json())
    // An empty table means the file changed shape, not that every model
    // became free. Keep the copy we have.
    if (Object.keys(prices).length === 0)
      throw new Error('no prices for any supported provider')
    const list = { prices, fetchedAt: now }
    await db.run(
      `INSERT INTO ai_price_list (id, prices, fetched_at) VALUES ('litellm', ?, ?)
       ON CONFLICT (id) DO UPDATE SET prices = excluded.prices, fetched_at = excluded.fetched_at`,
      [JSON.stringify(prices), now],
    )
    memory = list
    lastFailureAt = 0
    return list
  } catch (err) {
    console.error('Failed to refresh the AI price list', err)
    lastFailureAt = now
    return null
  }
}

export interface IPriceOptions {
  fetchImpl?: typeof fetch
  now?: number
}

/**
 * The best price list there is, refreshed when it is a day old.
 *
 * With a copy in hand (fresh or stale) this answers at once and any refresh
 * runs in the background. Only when there has never been a copy does it wait
 * for the fetch, because the alternative is an answer with no prices at all.
 * Null means no copy exists and the fetch failed: callers show tokens only.
 */
export async function getPriceList(
  db: ISqlDriver,
  options: IPriceOptions = {},
): Promise<IPriceList | null> {
  const now = options.now ?? Date.now()
  const fetchImpl = options.fetchImpl ?? fetch

  // Another instance may have refreshed since this one cached its copy.
  if (!memory || now - memory.fetchedAt >= PRICE_TTL_MS) {
    const stored = await readStored(db)
    if (stored && (!memory || stored.fetchedAt > memory.fetchedAt))
      memory = stored
  }

  const stale = !memory || now - memory.fetchedAt >= PRICE_TTL_MS
  const backingOff =
    lastFailureAt > 0 && now - lastFailureAt < RETRY_AFTER_FAILURE_MS
  if (!stale || backingOff) return memory

  if (!refreshing) {
    refreshing = fetchAndStore(db, fetchImpl, now).finally(() => {
      refreshing = null
    })
  }
  if (memory) {
    defer(refreshing)
    return memory
  }
  return refreshing
}
