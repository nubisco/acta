/**
 * AI cost estimates from LiteLLM's public price list, fetched at runtime.
 *
 * What has to be true: the list is fetched at most once a day across
 * restarts and instances, a failed refresh keeps the last good copy, and a
 * model the list does not have (or no list at all) shows tokens and no cost
 * rather than a wrong number. The fetch is always mocked here.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import { openDb, type BunSqliteDriver } from '../src/db'
import { bootstrapWorkspace } from '../src/core/bootstrap'
import {
  getUsageSummary,
  recordUsage,
  type IAiConfig,
} from '../src/services/ai'
import {
  PRICE_LIST_URL,
  PRICE_TTL_MS,
  RETRY_AFTER_FAILURE_MS,
  extractPrices,
  findPrice,
  getPriceList,
  resetPriceCache,
  type IPriceList,
} from '../src/services/aiPrices'

const NOW = Date.UTC(2026, 9, 23, 12, 0)

/** A slice of the real file, with its real key spellings and fields. */
const SAMPLE = {
  sample_spec: {
    litellm_provider: 'one of https://docs.litellm.ai/docs/providers',
    input_cost_per_token: 0.0,
    output_cost_per_token: 0.0,
  },
  'claude-haiku-4-5': {
    litellm_provider: 'anthropic',
    input_cost_per_token: 1e-6,
    output_cost_per_token: 5e-6,
  },
  'claude-haiku-4-5-20251001': {
    litellm_provider: 'anthropic',
    input_cost_per_token: 1e-6,
    output_cost_per_token: 5e-6,
  },
  'anthropic.claude-haiku-4-5-20251001-v1:0': {
    litellm_provider: 'bedrock_converse',
    input_cost_per_token: 1.1e-6,
    output_cost_per_token: 5.5e-6,
  },
  'gpt-5.6-luna': {
    litellm_provider: 'openai',
    input_cost_per_token: 2e-7,
    output_cost_per_token: 1.2e-6,
  },
  'azure/gpt-5.6-luna': {
    litellm_provider: 'azure',
    input_cost_per_token: 9e-7,
    output_cost_per_token: 9e-6,
  },
  // Vertex's price under the bare name, AI Studio's under the prefix.
  'gemini-3.5-flash-lite': {
    litellm_provider: 'vertex_ai-language-models',
    input_cost_per_token: 9e-7,
    output_cost_per_token: 9e-6,
  },
  'gemini/gemini-3.5-flash-lite': {
    litellm_provider: 'gemini',
    input_cost_per_token: 3e-7,
    output_cost_per_token: 2.5e-6,
  },
  'chatgpt/gpt-5.6-luna': { litellm_provider: 'openai' },
}

let db: BunSqliteDriver
let workspaceId: string

function priceFetch(body: unknown = SAMPLE, ok = true) {
  const calls: string[] = []
  const fetchImpl = (async (url: string | URL | Request) => {
    calls.push(String(url))
    if (!ok) return new Response('down', { status: 503 })
    return Response.json(body)
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

const failingFetch = () => {
  const calls: string[] = []
  const fetchImpl = (async (url: string | URL | Request) => {
    calls.push(String(url))
    throw new TypeError('network down')
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

async function storedFetchedAt(): Promise<number | null> {
  const rows = await db.query<{ fetched_at: number }>(
    'SELECT fetched_at FROM ai_price_list',
  )
  return rows[0]?.fetched_at ?? null
}

beforeEach(async () => {
  resetPriceCache()
  db = await openDb(':memory:')
  workspaceId = await bootstrapWorkspace(db, {
    workspaceName: 'Test',
    adminEmail: 'admin@example.com',
    adminHandle: 'admin',
    adminName: 'Admin',
  })
})

describe('extracting the price list', () => {
  it('keeps only the three providers, keyed without their prefix', () => {
    const table = extractPrices(SAMPLE)
    expect(Object.keys(table).sort()).toEqual(['anthropic', 'gemini', 'openai'])
    expect(table.anthropic?.['claude-haiku-4-5']).toEqual([1e-6, 5e-6])
    expect(table.gemini?.['gemini-3.5-flash-lite']).toEqual([3e-7, 2.5e-6])
    // Resellers' prices and entries with no token price are left out.
    expect(table.openai?.['gpt-5.6-luna']).toEqual([2e-7, 1.2e-6])
    expect(Object.keys(table.openai ?? {})).toEqual(['gpt-5.6-luna'])
  })
})

describe('matching the model ids Acta stores', () => {
  const list: IPriceList = { prices: extractPrices(SAMPLE), fetchedAt: NOW }

  it('finds an exact alias', () => {
    expect(findPrice(list, 'anthropic', 'claude-haiku-4-5')).toEqual([
      1e-6, 5e-6,
    ])
  })

  it('reads a Gemini key from its gemini/ prefixed entry, not Vertex', () => {
    expect(findPrice(list, 'gemini', 'gemini-3.5-flash-lite')).toEqual([
      3e-7, 2.5e-6,
    ])
    expect(findPrice(list, 'gemini', 'models/gemini-3.5-flash-lite')).toEqual([
      3e-7, 2.5e-6,
    ])
    expect(findPrice(list, 'gemini', 'gemini/gemini-3.5-flash-lite')).toEqual([
      3e-7, 2.5e-6,
    ])
  })

  it('prices a dated snapshot as its alias when the list lacks it', () => {
    expect(findPrice(list, 'anthropic', 'claude-haiku-4-5-20251001')).toEqual([
      1e-6, 5e-6,
    ])
    expect(findPrice(list, 'openai', 'gpt-5.6-luna-2026-07-09')).toEqual([
      2e-7, 1.2e-6,
    ])
    expect(findPrice(list, 'gemini', 'gemini-3.5-flash-lite-001')).toEqual([
      3e-7, 2.5e-6,
    ])
  })

  it('does not borrow a price across providers', () => {
    expect(findPrice(list, 'openai', 'claude-haiku-4-5')).toBeNull()
  })

  it('returns null for an unknown model or no list', () => {
    expect(findPrice(list, 'openai', 'gpt-made-up')).toBeNull()
    expect(findPrice(null, 'anthropic', 'claude-haiku-4-5')).toBeNull()
  })
})

describe('the price cache', () => {
  it('fetches once and serves the fresh copy from memory and the store', async () => {
    const { calls, fetchImpl } = priceFetch()
    const first = await getPriceList(db, { fetchImpl, now: NOW })
    expect(calls).toEqual([PRICE_LIST_URL])
    expect(first?.fetchedAt).toBe(NOW)
    expect(await storedFetchedAt()).toBe(NOW)

    await getPriceList(db, { fetchImpl, now: NOW + 1000 })
    expect(calls.length).toBe(1)

    // A restart, or another instance: memory is empty, the stored copy is fresh.
    resetPriceCache()
    const again = await getPriceList(db, { fetchImpl, now: NOW + 60_000 })
    expect(calls.length).toBe(1)
    expect(again?.prices.openai?.['gpt-5.6-luna']).toEqual([2e-7, 1.2e-6])
  })

  it('serves a stale copy at once and keeps it when the refresh fails', async () => {
    await getPriceList(db, { fetchImpl: priceFetch().fetchImpl, now: NOW })

    const later = NOW + PRICE_TTL_MS + 1
    const { calls, fetchImpl } = failingFetch()
    const stale = await getPriceList(db, { fetchImpl, now: later })
    expect(stale?.fetchedAt).toBe(NOW)
    // Let the background refresh settle.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls.length).toBe(1)
    expect(await storedFetchedAt()).toBe(NOW)

    // Still the last good copy, and no refetch until the back-off passes.
    const kept = await getPriceList(db, { fetchImpl, now: later + 1000 })
    expect(kept?.fetchedAt).toBe(NOW)
    expect(calls.length).toBe(1)

    const ok = priceFetch()
    const retry = later + RETRY_AFTER_FAILURE_MS + 1
    await getPriceList(db, { fetchImpl: ok.fetchImpl, now: retry })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(ok.calls.length).toBe(1)
    expect(await storedFetchedAt()).toBe(retry)
  })

  it('refuses a list with no usable prices and keeps the old copy', async () => {
    await getPriceList(db, { fetchImpl: priceFetch().fetchImpl, now: NOW })
    const later = NOW + PRICE_TTL_MS + 1
    await getPriceList(db, {
      fetchImpl: priceFetch({ unrelated: {} }).fetchImpl,
      now: later,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(await storedFetchedAt()).toBe(NOW)
  })

  it('returns null when it has never fetched and the fetch fails', async () => {
    const { fetchImpl } = priceFetch(SAMPLE, false)
    expect(await getPriceList(db, { fetchImpl, now: NOW })).toBeNull()
    expect(await storedFetchedAt()).toBeNull()
  })
})

describe('the usage summary', () => {
  const config = (
    provider: IAiConfig['provider'],
    model: string,
  ): IAiConfig => ({
    provider,
    model,
    apiKey: 'unused-in-these-tests',
  })

  it('prices every model it can, from the fetched list', async () => {
    await recordUsage(
      db,
      workspaceId,
      'daily_report',
      config('gemini', 'gemini-3.5-flash-lite'),
      {
        inputTokens: 1_000_000,
        outputTokens: 100_000,
      },
    )
    await recordUsage(
      db,
      workspaceId,
      'daily_report',
      config('anthropic', 'claude-haiku-4-5-20251001'),
      {
        inputTokens: 1_000_000,
        outputTokens: 0,
      },
    )
    const summary = await getUsageSummary(db, workspaceId, 30, {
      fetchImpl: priceFetch().fetchImpl,
    })
    // 0.30 + 0.25 for Gemini at AI Studio prices, 1.00 for Haiku.
    expect(summary.estimatedCostUsd).toBeCloseTo(1.55, 6)
    expect(summary.unpricedModels).toEqual([])
    expect(summary.pricingVerifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('shows tokens and no cost for a model the list does not have', async () => {
    await recordUsage(
      db,
      workspaceId,
      'daily_report',
      config('openai', 'gpt-made-up'),
      {
        inputTokens: 500,
        outputTokens: 50,
      },
    )
    const summary = await getUsageSummary(db, workspaceId, 30, {
      fetchImpl: priceFetch().fetchImpl,
    })
    expect(summary.inputTokens).toBe(500)
    expect(summary.estimatedCostUsd).toBeNull()
    expect(summary.unpricedModels).toEqual(['gpt-made-up'])
  })

  it('shows tokens and no cost when there has never been a price list', async () => {
    await recordUsage(
      db,
      workspaceId,
      'daily_report',
      config('anthropic', 'claude-haiku-4-5'),
      {
        inputTokens: 500,
        outputTokens: 50,
      },
    )
    const summary = await getUsageSummary(db, workspaceId, 30, {
      fetchImpl: failingFetch().fetchImpl,
    })
    expect(summary.requests).toBe(1)
    expect(summary.outputTokens).toBe(50)
    expect(summary.estimatedCostUsd).toBeNull()
    expect(summary.unpricedModels).toEqual(['claude-haiku-4-5'])
    expect(summary.pricingVerifiedOn).toBe('')
  })

  it('does not fetch prices when there is no usage to price', async () => {
    const { calls, fetchImpl } = priceFetch()
    const summary = await getUsageSummary(db, workspaceId, 30, { fetchImpl })
    expect(calls.length).toBe(0)
    expect(summary.estimatedCostUsd).toBe(0)
  })
})
