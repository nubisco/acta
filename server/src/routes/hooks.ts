/**
 * Provider webhook receivers.
 *
 * Three rules hold for every provider added here:
 *
 *  1. Verify before you read. The signature check runs against the raw body
 *     before anything is parsed, and a failure returns 401 without touching
 *     the database. The URL is not a credential.
 *  2. Deliveries repeat. Providers retry on timeout, and GitHub has a
 *     "redeliver" button a human can press. Every handler resolves an
 *     existing `external_link` first, so the second delivery of an event
 *     updates or no-ops rather than creating a second card.
 *  3. Never 500 on a payload we simply do not handle. An unhandled action
 *     is a 200 with `ignored`, because a provider that sees errors starts
 *     disabling the hook.
 */

import { Hono } from 'hono'
import { newId } from '@nubisco/acta-shared'
import { now, type IActorCtx, type ICtx } from '../core/ctx'
import type { ISqlDriver } from '../db'
import { itemWrite } from '../services/items'
import {
  noteConnectionDelivery,
  type TConnectionConfig,
} from '../services/connections'

interface IHookEnv {
  Variables: { db: ISqlDriver }
}

interface IConnectionRow {
  id: string
  workspace_id: string
  provider: string
  secret: string
  actor_id: string
  board_key: string
  list_name: string | null
  board_id: string
  config: string
  handle: string
}

/**
 * Constant-time comparison. A fast `===` on a signature leaks how many
 * leading bytes were right, which is enough to forge one byte at a time.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

async function hmacSha256Hex(secret: string, body: string): Promise<string> {
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

/** GitHub sends `sha256=<hex>` in X-Hub-Signature-256. */
export async function verifyGithubSignature(
  secret: string,
  body: string,
  header: string | undefined,
): Promise<boolean> {
  if (!header?.startsWith('sha256=')) return false
  return timingSafeEqual(header.slice(7), await hmacSha256Hex(secret, body))
}

/**
 * The list a new card lands in: the connection's configured list, else the
 * board's inbox or backlog, else whatever comes first. Same precedence the
 * ingest route uses, so both inbound paths behave alike.
 */
async function landingList(
  db: ISqlDriver,
  connection: IConnectionRow,
): Promise<string> {
  if (connection.list_name) return connection.list_name
  const rows = await db.query<{ name: string }>(
    `SELECT name FROM list WHERE board_id = ? AND archived = 0
      ORDER BY CASE role WHEN 'inbox' THEN 0 WHEN 'backlog' THEN 1 ELSE 2 END, pos
      LIMIT 1`,
    [connection.board_id],
  )
  return rows[0]?.name ?? 'Backlog'
}

async function linkedItemKey(
  db: ISqlDriver,
  workspaceId: string,
  provider: string,
  externalId: string,
): Promise<string | null> {
  const rows = await db.query<{ key: string }>(
    `SELECT i.key FROM external_link e JOIN item i ON i.id = e.item_id
      WHERE e.workspace_id = ? AND e.provider = ? AND e.external_id = ?`,
    [workspaceId, provider, externalId],
  )
  return rows[0]?.key ?? null
}

interface IGithubIssuePayload {
  action?: string
  issue?: {
    id?: number
    number?: number
    title?: string
    body?: string | null
    html_url?: string
    state?: string
    user?: { login?: string }
    labels?: { name?: string }[]
  }
  repository?: { full_name?: string; html_url?: string }
  sender?: { login?: string }
}

/** Actions we act on. Anything else is acknowledged and ignored. */
const HANDLED = new Set(['opened', 'closed', 'reopened', 'edited'])

/**
 * The card body for a GitHub issue. The issue text is quoted rather than
 * inlined so a card that later gets its own notes keeps them distinguishable
 * from what GitHub said, and so a very long issue cannot impersonate our own
 * structure.
 */
function issueDescription(payload: IGithubIssuePayload): string {
  const issue = payload.issue ?? {}
  const repo = payload.repository?.full_name ?? 'unknown repository'
  const author = issue.user?.login ?? 'someone'
  const lines = [
    `[${repo}#${issue.number}](${issue.html_url}) opened by \`${author}\`.`,
    '',
  ]
  const body = (issue.body ?? '').trim()
  if (body) {
    lines.push(
      ...body
        .split('\n')
        .slice(0, 400)
        .map((line) => `> ${line}`),
    )
  } else {
    lines.push('> _No description._')
  }
  return lines.join('\n')
}

export function hookRoutes(): Hono<IHookEnv> {
  const app = new Hono<IHookEnv>()

  app.post('/github/:id', async (c) => {
    const db = c.get('db')
    const rows = await db.query<IConnectionRow>(
      `SELECT c.id, c.workspace_id, c.provider, c.secret, c.actor_id,
              c.board_id, c.config, b.key AS board_key, l.name AS list_name,
              a.handle
         FROM connection c
         JOIN board b ON b.id = c.board_id
         JOIN actor a ON a.id = c.actor_id
         LEFT JOIN list l ON l.id = c.list_id
        WHERE c.id = ? AND c.provider = 'github' AND c.enabled = 1`,
      [c.req.param('id')],
    )
    if (rows.length === 0) return c.json({ error: 'unknown connection' }, 404)
    const connection = rows[0]

    // Raw body first: re-serialising parsed JSON would not reproduce the
    // bytes GitHub signed.
    const raw = await c.req.text()
    const ok = await verifyGithubSignature(
      connection.secret,
      raw,
      c.req.header('x-hub-signature-256'),
    )
    if (!ok) {
      await noteConnectionDelivery(
        { db },
        connection.id,
        'signature verification failed',
      )
      return c.json({ error: 'invalid signature' }, 401)
    }

    const event = c.req.header('x-github-event') ?? ''
    if (event === 'ping') {
      await noteConnectionDelivery({ db }, connection.id, null)
      return c.json({ ok: true, pong: true })
    }
    if (event !== 'issues') {
      await noteConnectionDelivery({ db }, connection.id, null)
      return c.json({ ok: true, ignored: `event ${event}` })
    }

    let payload: IGithubIssuePayload
    try {
      payload = JSON.parse(raw) as IGithubIssuePayload
    } catch {
      return c.json({ error: 'invalid json' }, 400)
    }
    const issue = payload.issue
    const action = payload.action ?? ''
    if (!issue?.id || !HANDLED.has(action)) {
      await noteConnectionDelivery({ db }, connection.id, null)
      return c.json({ ok: true, ignored: `action ${action}` })
    }

    // GitHub reuses the delivery GUID when a human presses "Redeliver", and
    // mints a new one for a genuinely new event. That makes it exactly the
    // idempotency key we want: keying on the action instead would swallow
    // the second close of a close-reopen-close sequence.
    const delivery = c.req.header('x-github-delivery') || newId('evt')

    const config = JSON.parse(connection.config) as TConnectionConfig
    const repo = payload.repository?.full_name
    if (config.repos?.length && (!repo || !config.repos.includes(repo))) {
      await noteConnectionDelivery({ db }, connection.id, null)
      return c.json({ ok: true, ignored: `repository ${repo ?? 'unknown'}` })
    }

    const actor: IActorCtx = {
      id: connection.actor_id,
      kind: 'agent',
      handle: connection.handle,
      role: 'member',
      scopes: ['write'],
    }
    const ctx: ICtx = { db, workspaceId: connection.workspace_id, actor }
    const externalId = String(issue.id)
    const existing = await linkedItemKey(
      db,
      connection.workspace_id,
      'github',
      externalId,
    )

    try {
      if (!existing) {
        // Only `opened` creates. A close arriving for an issue we never saw
        // (hook added mid-life) should not resurrect it as a fresh card.
        if (action !== 'opened') {
          await noteConnectionDelivery({ db }, connection.id, null)
          return c.json({ ok: true, ignored: `${action} for unlinked issue` })
        }
        const results = await itemWrite(ctx, [
          {
            op: 'create',
            op_id: `github:${delivery}`,
            board: connection.board_key,
            list: await landingList(db, connection),
            title: issue.title?.slice(0, 500) || `Issue #${issue.number}`,
            description: issueDescription(payload),
          },
        ])
        const result = results[0]
        if (!result.ok) {
          await noteConnectionDelivery({ db }, connection.id, result.error)
          return c.json({ error: result.error }, 400)
        }
        const createdKey = result.key
        if (!createdKey) {
          await noteConnectionDelivery({ db }, connection.id, 'no key returned')
          return c.json({ error: 'item created without a key' }, 500)
        }
        // Labels are applied separately and allowed to fail. Creating them
        // inline would mean a label deleted after the connection was set up
        // silently stops every incoming issue from becoming a card, which is
        // a far worse outcome than an unlabelled one.
        if (config.labels?.length) {
          const labelled = await itemWrite(ctx, [
            {
              op: 'label',
              op_id: `github:${delivery}:labels`,
              key: createdKey,
              add: config.labels,
            },
          ])
          if (!labelled[0].ok) {
            await noteConnectionDelivery(
              { db },
              connection.id,
              `card created, labels not applied: ${labelled[0].error}`,
            )
          }
        }
        const itemId = (
          await db.query<{ id: string }>(
            'SELECT id FROM item WHERE workspace_id = ? AND key = ?',
            [connection.workspace_id, createdKey],
          )
        )[0]?.id
        if (itemId) {
          await db.run(
            `INSERT INTO external_link (workspace_id, provider, external_id, item_id, url, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
              connection.workspace_id,
              'github',
              externalId,
              itemId,
              issue.html_url ?? null,
              now(),
            ],
          )
        }
        await noteConnectionDelivery({ db }, connection.id, null)
        return c.json({ ok: true, key: createdKey, created: true })
      }

      // Linked already: reflect the issue's state onto the card it tracks.
      const ops: Parameters<typeof itemWrite>[1] = []
      if (action === 'closed') {
        ops.push({
          op: 'complete',
          op_id: `github:${delivery}`,
          key: existing,
        })
      } else if (action === 'reopened') {
        ops.push({
          op: 'reopen',
          op_id: `github:${delivery}`,
          key: existing,
        })
      } else if (action === 'edited' && issue.title) {
        ops.push({
          op: 'update',
          op_id: `github:${delivery}`,
          key: existing,
          title: issue.title.slice(0, 500),
        })
      }
      if (ops.length === 0) {
        await noteConnectionDelivery({ db }, connection.id, null)
        return c.json({ ok: true, key: existing, ignored: `action ${action}` })
      }
      const results = await itemWrite(ctx, ops)
      const result = results[0]
      if (!result.ok) {
        await noteConnectionDelivery({ db }, connection.id, result.error)
        return c.json({ error: result.error }, 400)
      }
      await noteConnectionDelivery({ db }, connection.id, null)
      return c.json({ ok: true, key: existing, updated: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await noteConnectionDelivery({ db }, connection.id, message)
      return c.json({ error: message }, 500)
    }
  })

  return app
}
