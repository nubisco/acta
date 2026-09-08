import { newId } from '@nubisco/acta-shared'
import { z } from 'zod'
import type { ICtx } from '../core/ctx'
import { ApiError, now } from '../core/ctx'
import { defer } from '../core/defer'
import { emitEvent, onEvent, type IEvent } from '../core/events'
import { withOp } from '../core/ops'
import type { ISqlDriver } from '../db'
import { slackPayload, type ISlackContext } from './slack'

/**
 * How a destination wants the body shaped. `generic` is Acta's own signed
 * envelope; `slack` is Block Kit for an Incoming Webhook URL.
 */
export const WEBHOOK_FORMATS = ['generic', 'slack'] as const
export type TWebhookFormat = (typeof WEBHOOK_FORMATS)[number]

export const zWebhookOp = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('create'),
    op_id: z.string().min(1).max(200),
    url: z.url(),
    events: z.array(z.string().min(1)).min(1).max(20),
    secret: z.string().max(200).optional(),
    format: z.enum(WEBHOOK_FORMATS).optional(),
  }),
  z.object({
    op: z.literal('update'),
    op_id: z.string().min(1).max(200),
    id: z.string().min(1),
    url: z.url().optional(),
    events: z.array(z.string().min(1)).min(1).max(20).optional(),
    enabled: z.boolean().optional(),
    format: z.enum(WEBHOOK_FORMATS).optional(),
  }),
  z.object({
    op: z.literal('delete'),
    op_id: z.string().min(1).max(200),
    id: z.string().min(1),
  }),
])
export type TWebhookOp = z.infer<typeof zWebhookOp>
export const zWebhookWrite = z.object({
  ops: z.array(zWebhookOp).min(1).max(20),
})

/** Event pattern matching: exact, prefix wildcard (item.*), or *. */
export function matchesPattern(pattern: string, verb: string): boolean {
  if (pattern === '*') return true
  if (pattern.endsWith('.*')) return verb.startsWith(pattern.slice(0, -1))
  return pattern === verb
}

export async function webhookWrite(ctx: ICtx, ops: TWebhookOp[]) {
  const results = []
  for (const op of ops) {
    results.push(
      await withOp(ctx, op.op_id, async () => {
        switch (op.op) {
          case 'create': {
            const id = newId('whk')
            await ctx.db.run(
              'INSERT INTO webhook (id, workspace_id, url, events, secret, format, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
              [
                id,
                ctx.workspaceId,
                op.url,
                JSON.stringify(op.events),
                op.secret ?? null,
                op.format ?? 'generic',
                now(),
              ],
            )
            await emitEvent(
              ctx,
              'webhook.created',
              'webhook',
              id,
              `created webhook ${op.url}`,
            )
            return { id }
          }
          case 'update': {
            const rows = await ctx.db.query<{ id: string }>(
              'SELECT id FROM webhook WHERE workspace_id = ? AND id = ?',
              [ctx.workspaceId, op.id],
            )
            if (rows.length === 0)
              throw new ApiError(404, `webhook ${op.id} not found`)
            await ctx.db.run(
              `UPDATE webhook SET url = COALESCE(?, url), events = COALESCE(?, events),
                    enabled = COALESCE(?, enabled), format = COALESCE(?, format),
                    failure_count = CASE WHEN ? THEN 0 ELSE failure_count END
              WHERE id = ?`,
              [
                op.url ?? null,
                op.events ? JSON.stringify(op.events) : null,
                op.enabled === undefined ? null : op.enabled ? 1 : 0,
                op.format ?? null,
                op.enabled === true ? 1 : 0,
                op.id,
              ],
            )
            await emitEvent(
              ctx,
              'webhook.updated',
              'webhook',
              op.id,
              `updated webhook`,
            )
            return { id: op.id }
          }
          case 'delete': {
            await ctx.db.run(
              'DELETE FROM webhook WHERE workspace_id = ? AND id = ?',
              [ctx.workspaceId, op.id],
            )
            await emitEvent(
              ctx,
              'webhook.deleted',
              'webhook',
              op.id,
              `deleted webhook`,
            )
            return { id: op.id }
          }
        }
      }),
    )
  }
  return results
}

export async function webhookList(ctx: ICtx) {
  return {
    webhooks: (
      await ctx.db.query<{
        id: string
        url: string
        events: string
        enabled: number
        format: string
        failure_count: number
      }>(
        'SELECT id, url, events, enabled, format, failure_count FROM webhook WHERE workspace_id = ?',
        [ctx.workspaceId],
      )
    ).map((w) => ({
      id: w.id,
      url: w.url,
      events: JSON.parse(w.events) as string[],
      enabled: w.enabled === 1,
      format: (w.format ?? 'generic') as TWebhookFormat,
      failures: w.failure_count,
    })),
  }
}

// ---------------------------------------------------------------------------
// Delivery (design-spec §5): HMAC-signed POST, 3 attempts with backoff,
// delivery log, auto-disable after sustained failure.
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 3
const DISABLE_AFTER = 10

export interface IDispatcherOptions {
  fetchImpl?: typeof fetch
  /** Backoff between attempts, ms. Overridable for tests. */
  backoffMs?: number
  /** Acta's public address, so Slack messages can link back to a card. */
  baseUrl?: string
}

/**
 * Names the actor and the card for a Slack message. Both are best-effort: a
 * missing lookup costs a link or a display name, never the delivery.
 */
async function slackContextFor(
  db: ISqlDriver,
  event: IEvent,
  baseUrl?: string,
): Promise<ISlackContext> {
  const actor = await db.query<{ name: string }>(
    'SELECT name FROM actor WHERE id = ?',
    [event.actor_id],
  )
  const item =
    event.entity === 'item'
      ? await db.query<{ key: string }>('SELECT key FROM item WHERE id = ?', [
          event.entity_id,
        ])
      : []
  return {
    actorName: actor[0]?.name,
    itemKey: item[0]?.key,
    baseUrl,
  }
}

export async function signPayload(
  secret: string,
  body: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(body),
  )
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Subscribe the dispatcher to the event stream. Returns an unsubscribe fn. */
export function startWebhookDispatcher(
  db: ISqlDriver,
  opts: IDispatcherOptions = {},
): () => void {
  const fetchImpl = opts.fetchImpl ?? fetch
  const backoffMs = opts.backoffMs ?? 2000

  return onEvent(async (event) => {
    // Never deliver webhook admin events to webhooks (noise + loop risk).
    if (event.verb.startsWith('webhook.')) return
    const hooks = await db.query<{
      id: string
      url: string
      events: string
      secret: string | null
      format: string
      failure_count: number
    }>(
      'SELECT id, url, events, secret, format, failure_count FROM webhook WHERE workspace_id = ? AND enabled = 1',
      [event.workspace_id],
    )
    const matching = hooks.filter((hook) =>
      (JSON.parse(hook.events) as string[]).some((p) =>
        matchesPattern(p, event.verb),
      ),
    )
    if (matching.length === 0) return
    // Resolved once per event rather than per hook: two Slack destinations
    // subscribed to the same verb should not cost two lookups.
    const context = matching.some((hook) => hook.format === 'slack')
      ? await slackContextFor(db, event, opts.baseUrl)
      : {}
    for (const hook of matching) {
      defer(deliver(db, hook, event, fetchImpl, backoffMs, context))
    }
  })
}

async function deliver(
  db: ISqlDriver,
  hook: { id: string; url: string; secret: string | null; format?: string },
  event: IEvent,
  fetchImpl: typeof fetch,
  backoffMs: number,
  slack: ISlackContext = {},
): Promise<void> {
  const body =
    hook.format === 'slack'
      ? JSON.stringify(slackPayload(event, slack))
      : JSON.stringify({
          event: event.verb,
          ts: event.ts,
          actor: {
            id: event.actor_id,
            kind: event.actor_kind,
            on_behalf_of: event.on_behalf_of,
          },
          entity: event.entity,
          entity_id: event.entity_id,
          summary: event.summary,
          payload: event.payload,
        })
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  // A Slack webhook URL is itself the credential and Slack has no signature
  // header to check, so signing it would only add a header nobody reads.
  if (hook.secret && hook.format !== 'slack')
    headers['x-acta-signature'] =
      `sha256=${await signPayload(hook.secret, body)}`

  const deliveryId = newId('whk')
  let status: number | null = null
  let lastError = ''
  let attempts = 0
  for (attempts = 1; attempts <= MAX_ATTEMPTS; attempts++) {
    try {
      const res = await fetchImpl(hook.url, { method: 'POST', headers, body })
      status = res.status
      if (res.ok) break
      lastError = `http ${res.status}`
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
    if (attempts < MAX_ATTEMPTS)
      await new Promise((r) => setTimeout(r, backoffMs * attempts))
  }
  const ok = status !== null && status >= 200 && status < 300
  await db.run(
    'INSERT INTO webhook_delivery (id, webhook_id, event, status, attempts, last_error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [
      deliveryId,
      hook.id,
      event.verb,
      status,
      Math.min(attempts, MAX_ATTEMPTS),
      ok ? null : lastError,
      now(),
    ],
  )
  if (ok) {
    await db.run('UPDATE webhook SET failure_count = 0 WHERE id = ?', [hook.id])
  } else {
    await db.run(
      `UPDATE webhook SET failure_count = failure_count + 1,
              enabled = CASE WHEN failure_count + 1 >= ? THEN 0 ELSE enabled END
        WHERE id = ?`,
      [DISABLE_AFTER, hook.id],
    )
  }
}
