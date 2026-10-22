/**
 * The workspace's own AI provider, for the features that write prose.
 *
 * The same bring-your-own-key deal Analytics and Verba offer, and the same
 * code shape (analytics/server/ai.ts): an admin supplies a provider key, we
 * never ship one, and nothing here falls back to a Nubisco-owned key. A
 * workspace with no key configured simply has the AI-written parts off.
 *
 * One consumer today, the daily report (services/dailyReport.ts).
 */
import type { ISqlDriver } from '../db'

export type TAiProvider = 'anthropic' | 'openai' | 'gemini'

export const AI_PROVIDERS: TAiProvider[] = ['anthropic', 'openai', 'gemini']

/**
 * Chosen for cost: a report is a small writing job over a page of facts, not
 * a reasoning task. Admins can override per workspace.
 *
 * These rot. Providers retire models on their own schedule, and a default
 * that points at a retired one turns every report into an opaque provider
 * error. Kept identical to Analytics' list (verified there 2026-08-21), so
 * the two products move together: re-check both when one starts failing
 * with a model-not-found error.
 */
export const DEFAULT_MODELS: Record<TAiProvider, string> = {
  anthropic: 'claude-haiku-4-5',
  openai: 'gpt-5.6-luna',
  gemini: 'gemini-3.5-flash-lite',
}

const MAX_OUTPUT_TOKENS = 1200
const REQUEST_TIMEOUT_MS = 30000

export interface IAiSettings {
  provider: TAiProvider
  model: string | null
  hasKey: boolean
  updatedAt: number | null
}

export interface IAiConfig {
  provider: TAiProvider
  model: string
  apiKey: string
}

export class AiConfigError extends Error {
  status: number
  constructor(message: string, status = 422) {
    super(message)
    this.name = 'AiConfigError'
    this.status = status
  }
}

// ─── Key encryption ──────────────────────────────────────────────────────────

/**
 * The secret the key is encrypted under. Undefined means none is configured,
 * and then a key cannot be stored at all: encrypting a provider key under a
 * published constant is worse than not storing it, because the ciphertext
 * reads as protected when it is not. `devSecret` is the one exception, and
 * only a local Bun instance passes it.
 */
export interface IAiSecret {
  secret?: string
  devSecret?: boolean
}

const ENCRYPTION_VERSION = 'v1'
const IV_BYTES = 12
const DEV_FALLBACK_SECRET = 'nubisco-acta-dev-ai-key'

function encryptionSecret(secret: IAiSecret): string {
  if (secret.secret) return secret.secret
  if (secret.devSecret) return DEV_FALLBACK_SECRET
  throw new AiConfigError(
    'ACTA_AI_ENCRYPTION_KEY is not configured on this deployment',
    500,
  )
}

async function cryptoKey(
  secret: IAiSecret,
  usage: ('encrypt' | 'decrypt')[],
): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(encryptionSecret(secret)),
  )
  return crypto.subtle.importKey(
    'raw',
    digest,
    { name: 'AES-GCM' },
    false,
    usage,
  )
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export async function encryptApiKey(
  plaintext: string,
  secret: IAiSecret,
): Promise<string> {
  const key = await cryptoKey(secret, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext),
  )
  return `${ENCRYPTION_VERSION}:${toBase64(iv)}:${toBase64(new Uint8Array(ciphertext))}`
}

export async function decryptApiKey(
  encoded: string,
  secret: IAiSecret,
): Promise<string> {
  const parts = encoded.split(':')
  if (parts.length !== 3 || parts[0] !== ENCRYPTION_VERSION)
    throw new AiConfigError(
      'The stored AI key is unreadable. Enter it again in Settings.',
      500,
    )
  const key = await cryptoKey(secret, ['decrypt'])
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(parts[1]) },
      key,
      fromBase64(parts[2]),
    )
    return new TextDecoder().decode(plaintext)
  } catch {
    // A different ACTA_AI_ENCRYPTION_KEY from the one it was written under.
    throw new AiConfigError(
      'The stored AI key could not be decrypted. Enter it again in Settings.',
      500,
    )
  }
}

// ─── Settings storage ────────────────────────────────────────────────────────

interface IAiSettingsRow {
  provider: string
  model: string | null
  api_key_encrypted: string | null
  updated_at: number
}

function isProvider(value: unknown): value is TAiProvider {
  return (
    typeof value === 'string' && AI_PROVIDERS.includes(value as TAiProvider)
  )
}

async function fetchRow(
  db: ISqlDriver,
  workspaceId: string,
): Promise<IAiSettingsRow | null> {
  const rows = await db.query<IAiSettingsRow>(
    'SELECT provider, model, api_key_encrypted, updated_at FROM ai_settings WHERE workspace_id = ?',
    [workspaceId],
  )
  return rows[0] ?? null
}

/** What an admin sees. Never the key itself, only whether one is set. */
export async function getAiSettings(
  db: ISqlDriver,
  workspaceId: string,
): Promise<IAiSettings> {
  const row = await fetchRow(db, workspaceId)
  return {
    provider: row && isProvider(row.provider) ? row.provider : 'anthropic',
    model: row?.model ?? null,
    hasKey: Boolean(row?.api_key_encrypted),
    updatedAt: row?.updated_at ?? null,
  }
}

export interface IAiSettingsInput {
  provider?: unknown
  model?: unknown
  /** Write-only. Omitted or empty keeps the stored key, null clears it. */
  apiKey?: unknown
}

export async function saveAiSettings(
  db: ISqlDriver,
  workspaceId: string,
  input: IAiSettingsInput,
  secret: IAiSecret,
): Promise<IAiSettings> {
  const existing = await fetchRow(db, workspaceId)

  const provider =
    input.provider === undefined
      ? (existing?.provider ?? 'anthropic')
      : input.provider
  if (!isProvider(provider))
    throw new AiConfigError(
      `provider must be one of: ${AI_PROVIDERS.join(', ')}`,
      400,
    )

  const model =
    input.model === undefined
      ? (existing?.model ?? null)
      : typeof input.model === 'string' && input.model.trim()
        ? input.model.trim().slice(0, 120)
        : null

  let apiKeyEncrypted = existing?.api_key_encrypted ?? null
  if (input.apiKey === null) apiKeyEncrypted = null
  else if (typeof input.apiKey === 'string' && input.apiKey.trim()) {
    const raw = input.apiKey.trim()
    if (raw.length < 12)
      throw new AiConfigError('That does not look like a provider API key', 400)
    apiKeyEncrypted = await encryptApiKey(raw, secret)
  }

  await db.run(
    `INSERT INTO ai_settings (workspace_id, provider, model, api_key_encrypted, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (workspace_id) DO UPDATE SET
       provider = excluded.provider, model = excluded.model,
       api_key_encrypted = excluded.api_key_encrypted, updated_at = excluded.updated_at`,
    [workspaceId, provider, model, apiKeyEncrypted, Date.now()],
  )
  return getAiSettings(db, workspaceId)
}

/** A usable, decrypted config, or null when the workspace has no key. */
export async function resolveAiConfig(
  db: ISqlDriver,
  workspaceId: string,
  secret: IAiSecret,
): Promise<IAiConfig | null> {
  const row = await fetchRow(db, workspaceId)
  if (!row?.api_key_encrypted) return null
  const provider = isProvider(row.provider) ? row.provider : 'anthropic'
  return {
    provider,
    model: row.model || DEFAULT_MODELS[provider],
    apiKey: await decryptApiKey(row.api_key_encrypted, secret),
  }
}

// ─── Provider calls ──────────────────────────────────────────────────────────

/**
 * A retired or misspelled model reads as a bare "model not found" from the
 * provider, which gives an admin no idea which field to touch. Naming the
 * field turns a dead end into a one-line fix.
 */
const MODEL_ERROR_PATTERN = /model/i

async function readProviderError(
  response: Response,
  fallback: string,
  model: string,
): Promise<never> {
  const body = (await response.json().catch(() => ({}))) as {
    error?: { message?: string } | string
  }
  const raw =
    typeof body.error === 'string'
      ? body.error
      : (body.error?.message ?? `${fallback} (HTTP ${response.status})`)
  const modelProblem =
    (response.status === 404 || response.status === 400) &&
    MODEL_ERROR_PATTERN.test(raw)
  const message = modelProblem
    ? `${raw} (using model "${model}". Set a different one in Settings, AI briefings.)`
    : raw
  // 401/403 means the workspace's own key is bad, which is theirs to fix.
  throw new AiConfigError(
    message,
    response.status === 401 || response.status === 403 ? 400 : 502,
  )
}

export interface ITokenUsage {
  inputTokens: number
  outputTokens: number
}

export interface IModelReply {
  text: string
  /** What the provider says it billed, read from its response. */
  usage: ITokenUsage
}

function readUsage(raw: unknown): ITokenUsage {
  const body = (raw ?? {}) as {
    usage?: {
      input_tokens?: number
      output_tokens?: number
      prompt_tokens?: number
      completion_tokens?: number
    }
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
  }
  // Three providers, three spellings for the same two numbers.
  const input =
    body.usage?.input_tokens ??
    body.usage?.prompt_tokens ??
    body.usageMetadata?.promptTokenCount ??
    0
  const output =
    body.usage?.output_tokens ??
    body.usage?.completion_tokens ??
    body.usageMetadata?.candidatesTokenCount ??
    0
  return { inputTokens: Number(input) || 0, outputTokens: Number(output) || 0 }
}

/** One system and user prompt to the configured provider, and its reply. */
export async function callModel(
  config: IAiConfig,
  systemPrompt: string,
  userPrompt: string,
  fetchImpl: typeof fetch = fetch,
): Promise<IModelReply> {
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)

  if (config.provider === 'anthropic') {
    const response = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
      signal,
    })
    if (!response.ok)
      await readProviderError(
        response,
        'Anthropic request failed',
        config.model,
      )
    const data = (await response.json()) as {
      content: { type: string; text?: string }[]
    }
    const text = (data.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('')
      .trim()
    return { text, usage: readUsage(data) }
  }

  if (config.provider === 'openai') {
    const response = await fetchImpl(
      'https://api.openai.com/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          max_completion_tokens: MAX_OUTPUT_TOKENS,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
        }),
        signal,
      },
    )
    if (!response.ok)
      await readProviderError(response, 'OpenAI request failed', config.model)
    const data = (await response.json()) as {
      choices: { message: { content: string | null } }[]
    }
    return {
      text: (data.choices?.[0]?.message?.content ?? '').trim(),
      usage: readUsage(data),
    }
  }

  if (config.provider === 'gemini') {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:generateContent`
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': config.apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: {
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          temperature: 0.3,
        },
      }),
      signal,
    })
    if (!response.ok)
      await readProviderError(response, 'Gemini request failed', config.model)
    const data = (await response.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[]
    }
    const text = (data.candidates?.[0]?.content?.parts ?? [])
      .map((part) => part.text ?? '')
      .join('')
      .trim()
    return { text, usage: readUsage(data) }
  }

  throw new AiConfigError(`Unsupported AI provider: ${String(config.provider)}`)
}

// ─── Usage and cost ──────────────────────────────────────────────────────────

/**
 * USD per million tokens, per exact model id.
 *
 * Deliberately incomplete, and identical to Analytics' table. Admins can type
 * any model, providers change prices, and a confidently wrong number is worse
 * than none. An unknown model reports tokens and no cost.
 */
const PRICE_PER_MILLION: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5': { input: 1.0, output: 5.0 },
  'gpt-5.6-luna': { input: 0.2, output: 1.2 },
  'gemini-3.5-flash-lite': { input: 0.3, output: 2.5 },
}

export const PRICING_VERIFIED_ON = '2026-08-21'

export function estimateCost(model: string, usage: ITokenUsage): number | null {
  const price = PRICE_PER_MILLION[model]
  if (!price) return null
  return (
    (usage.inputTokens / 1_000_000) * price.input +
    (usage.outputTokens / 1_000_000) * price.output
  )
}

/** Never throws: a lost usage row must not cost the report already paid for. */
export async function recordUsage(
  db: ISqlDriver,
  workspaceId: string,
  source: string,
  config: IAiConfig,
  usage: ITokenUsage,
): Promise<void> {
  try {
    await db.run(
      `INSERT INTO ai_usage_log (workspace_id, source, provider, model, input_tokens, output_tokens, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        workspaceId,
        source,
        config.provider,
        config.model,
        usage.inputTokens,
        usage.outputTokens,
        Date.now(),
      ],
    )
  } catch (err) {
    console.error('Failed to record AI usage', err)
  }
}

export interface IAiUsageSummary {
  days: number
  requests: number
  inputTokens: number
  outputTokens: number
  /** Null when any model used has no published price on file. */
  estimatedCostUsd: number | null
  unpricedModels: string[]
  pricingVerifiedOn: string
}

export async function getUsageSummary(
  db: ISqlDriver,
  workspaceId: string,
  days = 30,
): Promise<IAiUsageSummary> {
  const rows = await db.query<{
    model: string
    requests: number
    input_tokens: number
    output_tokens: number
  }>(
    `SELECT model, COUNT(*) AS requests, SUM(input_tokens) AS input_tokens,
            SUM(output_tokens) AS output_tokens
       FROM ai_usage_log WHERE workspace_id = ? AND created_at >= ?
      GROUP BY model`,
    [workspaceId, Date.now() - days * 86_400_000],
  )
  let cost: number | null = 0
  const unpriced: string[] = []
  let requests = 0
  let inputTokens = 0
  let outputTokens = 0
  for (const row of rows) {
    const usage = {
      inputTokens: Number(row.input_tokens) || 0,
      outputTokens: Number(row.output_tokens) || 0,
    }
    requests += Number(row.requests) || 0
    inputTokens += usage.inputTokens
    outputTokens += usage.outputTokens
    const priced = estimateCost(row.model, usage)
    if (priced === null) unpriced.push(row.model)
    else if (cost !== null) cost += priced
  }
  if (unpriced.length > 0) cost = null
  return {
    days,
    requests,
    inputTokens,
    outputTokens,
    estimatedCostUsd: cost,
    unpricedModels: unpriced,
    pricingVerifiedOn: PRICING_VERIFIED_ON,
  }
}
