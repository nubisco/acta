import { newId } from '@nubisco/acta-shared'
import { z } from 'zod'
import type { ICtx } from '../core/ctx'
import { ApiError, now } from '../core/ctx'
import { emitEvent, onEvent, type IEvent } from '../core/events'
import { withOp } from '../core/ops'
import type { ISqlDriver } from '../db'

export const zWebhookOp = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('create'),
    op_id: z.string().min(1).max(200),
    url: z.url(),
    events: z.array(z.string().min(1)).min(1).max(20),
    secret: z.string().max(200).optional(),
  }),
  z.object({
    op: z.literal('update'),
    op_id: z.string().min(1).max(200),
    id: z.string().min(1),
    url: z.url().optional(),
    events: z.array(z.string().min(1)).min(1).max(20).optional(),
    enabled: z.boolean().optional(),
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

export function webhookWrite(ctx: ICtx, ops: TWebhookOp[]) {
  return ops.map((op) =>
    withOp(ctx, op.op_id, () => {
      switch (op.op) {
        case 'create': {
          const id = newId('whk')
          ctx.db.run(
            'INSERT INTO webhook (id, workspace_id, url, events, secret, created_at) VALUES (?, ?, ?, ?, ?, ?)',
            [
              id,
              ctx.workspaceId,
              op.url,
              JSON.stringify(op.events),
              op.secret ?? null,
              now(),
            ],
          )
          emitEvent(
            ctx,
            'webhook.created',
            'webhook',
            id,
            `created webhook ${op.url}`,
          )
          return { id }
        }
        case 'update': {
          const rows = ctx.db.query<{ id: string }>(
            'SELECT id FROM webhook WHERE workspace_id = ? AND id = ?',
            [ctx.workspaceId, op.id],
          )
          if (rows.length === 0)
            throw new ApiError(404, `webhook ${op.id} not found`)
          ctx.db.run(
            `UPDATE webhook SET url = COALESCE(?, url), events = COALESCE(?, events),
                    enabled = COALESCE(?, enabled), failure_count = CASE WHEN ? THEN 0 ELSE failure_count END
              WHERE id = ?`,
            [
              op.url ?? null,
              op.events ? JSON.stringify(op.events) : null,
              op.enabled === undefined ? null : op.enabled ? 1 : 0,
              op.enabled === true ? 1 : 0,
              op.id,
            ],
          )
          emitEvent(ctx, 'webhook.updated', 'webhook', op.id, `updated webhook`)
          return { id: op.id }
        }
        case 'delete': {
          ctx.db.run('DELETE FROM webhook WHERE workspace_id = ? AND id = ?', [
            ctx.workspaceId,
            op.id,
          ])
          emitEvent(ctx, 'webhook.deleted', 'webhook', op.id, `deleted webhook`)
          return { id: op.id }
        }
      }
    }),
  )
}

export function webhookList(ctx: ICtx) {
  return {
    webhooks: ctx.db
      .query<{
        id: string
        url: string
        events: string
        enabled: number
        failure_count: number
      }>(
        'SELECT id, url, events, enabled, failure_count FROM webhook WHERE workspace_id = ?',
        [ctx.workspaceId],
      )
      .map((w) => ({
        id: w.id,
        url: w.url,
        events: JSON.parse(w.events) as string[],
        enabled: w.enabled === 1,
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

  return onEvent((event) => {
    // Never deliver webhook admin events to webhooks (noise + loop risk).
    if (event.verb.startsWith('webhook.')) return
    const hooks = db.query<{
      id: string
      url: string
      events: string
      secret: string | null
      failure_count: number
    }>(
      'SELECT id, url, events, secret, failure_count FROM webhook WHERE workspace_id = ? AND enabled = 1',
      [event.workspace_id],
    )
    for (const hook of hooks) {
      const patterns = JSON.parse(hook.events) as string[]
      if (!patterns.some((p) => matchesPattern(p, event.verb))) continue
      void deliver(db, hook, event, fetchImpl, backoffMs)
    }
  })
}

async function deliver(
  db: ISqlDriver,
  hook: { id: string; url: string; secret: string | null },
  event: IEvent,
  fetchImpl: typeof fetch,
  backoffMs: number,
): Promise<void> {
  const body = JSON.stringify({
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
  if (hook.secret)
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
  db.run(
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
    db.run('UPDATE webhook SET failure_count = 0 WHERE id = ?', [hook.id])
  } else {
    db.run(
      `UPDATE webhook SET failure_count = failure_count + 1,
              enabled = CASE WHEN failure_count + 1 >= ? THEN 0 ELSE enabled END
        WHERE id = ?`,
      [DISABLE_AFTER, hook.id],
    )
  }
}
