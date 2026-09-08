/**
 * Inbound provider connections: something outside Acta pushes an event and a
 * card appears on a board.
 *
 * This is deliberately not the same mechanism as `ingest_token`. There, the
 * URL *is* the credential, which suits a form handler we control. A provider
 * webhook URL gets pasted into someone else's settings UI, shows up in their
 * delivery logs, and is generally not a secret; what makes it trustworthy is
 * that the provider signs each delivery. So a connection stores a shared
 * secret and every receiver verifies a signature before anything is written.
 *
 * Each connection carries its own agent actor, so a card created from GitHub
 * is attributed to that connection rather than to whichever human happens to
 * hold an admin session.
 */

import { newId } from '@nubisco/acta-shared'
import { z } from 'zod'
import { ApiError, now, type ICtx } from '../core/ctx'
import { emitEvent } from '../core/events'
import { withOp } from '../core/ops'

export const CONNECTION_PROVIDERS = ['github'] as const
export type TConnectionProvider = (typeof CONNECTION_PROVIDERS)[number]

/** Per-provider settings. Kept small: routing lives in the columns. */
export const zConnectionConfig = z.object({
  /** Labels applied to every card this connection creates. */
  labels: z.array(z.string().min(1)).max(20).optional(),
  /**
   * Only accept events from these `owner/repo` values. Empty means accept
   * whatever the signature proves came from the configured secret.
   */
  repos: z.array(z.string().min(1)).max(50).optional(),
})
export type TConnectionConfig = z.infer<typeof zConnectionConfig>

export const zConnectionOp = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('create'),
    op_id: z.string().min(1).max(200),
    provider: z.enum(CONNECTION_PROVIDERS),
    name: z.string().min(1).max(100),
    board: z.string().min(2).max(5),
    list: z.string().optional(),
    config: zConnectionConfig.optional(),
  }),
  z.object({
    op: z.literal('update'),
    op_id: z.string().min(1).max(200),
    id: z.string().min(1),
    name: z.string().min(1).max(100).optional(),
    list: z.string().optional(),
    enabled: z.boolean().optional(),
    config: zConnectionConfig.optional(),
  }),
  z.object({
    op: z.literal('delete'),
    op_id: z.string().min(1).max(200),
    id: z.string().min(1),
  }),
])
export type TConnectionOp = z.infer<typeof zConnectionOp>
export const zConnectionWrite = z.object({
  ops: z.array(zConnectionOp).min(1).max(20),
})

/**
 * The signing secret. Returned exactly once, at creation, the same way agent
 * tokens are: it has to be pasted into the provider's UI, and we would rather
 * re-issue than store something we hand back on every list call.
 */
function newSecret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

async function resolveBoard(ctx: ICtx, key: string): Promise<string> {
  const rows = await ctx.db.query<{ id: string }>(
    'SELECT id FROM board WHERE workspace_id = ? AND key = ?',
    [ctx.workspaceId, key],
  )
  if (rows.length === 0) throw new ApiError(404, `board ${key} not found`)
  return rows[0].id
}

/**
 * Labels are checked when the connection is saved rather than when an event
 * arrives. A name that does not resolve is an admin's typo, and telling them
 * now beats discovering it as cards that never appeared.
 */
async function assertLabelsExist(
  ctx: ICtx,
  boardId: string,
  labels: string[] | undefined,
): Promise<void> {
  for (const name of labels ?? []) {
    // Board scoping lives on the group, not the label: a label is reachable
    // from this board when its group is global or belongs to this board.
    const rows = await ctx.db.query<{ id: string }>(
      `SELECT l.id FROM label l JOIN label_group g ON g.id = l.group_id
        WHERE l.workspace_id = ? AND lower(l.name) = lower(?)
          AND (g.board_id IS NULL OR g.board_id = ?)`,
      [ctx.workspaceId, name, boardId],
    )
    if (rows.length === 0)
      throw new ApiError(404, `label ${name} not found on this board`)
  }
}

async function resolveList(
  ctx: ICtx,
  boardId: string,
  name: string | undefined,
): Promise<string | null> {
  if (!name) return null
  const rows = await ctx.db.query<{ id: string }>(
    'SELECT id FROM list WHERE board_id = ? AND lower(name) = lower(?)',
    [boardId, name],
  )
  if (rows.length === 0) throw new ApiError(404, `list ${name} not found`)
  return rows[0].id
}

export async function connectionWrite(ctx: ICtx, ops: TConnectionOp[]) {
  const results = []
  for (const op of ops) {
    results.push(
      await withOp(ctx, op.op_id, async () => {
        switch (op.op) {
          case 'create': {
            const boardId = await resolveBoard(ctx, op.board)
            const listId = await resolveList(ctx, boardId, op.list)
            await assertLabelsExist(ctx, boardId, op.config?.labels)
            const id = newId('con')
            const secret = newSecret()
            // The connection's own actor. Named after the connection so the
            // activity feed reads "opened by GitHub" rather than naming a
            // person who was not involved.
            const actorId = newId('act')
            const handle = `${op.name
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '-')
              .replace(/^-|-$/g, '')}-${actorId.slice(-4)}`
            await ctx.db.run(
              `INSERT INTO actor (id, workspace_id, kind, handle, name, role, created_at)
               VALUES (?, ?, 'agent', ?, ?, 'member', ?)`,
              [actorId, ctx.workspaceId, handle, op.name, now()],
            )
            await ctx.db.run(
              `INSERT INTO connection (id, workspace_id, provider, name, secret, actor_id, board_id, list_id, config, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                id,
                ctx.workspaceId,
                op.provider,
                op.name,
                secret,
                actorId,
                boardId,
                listId,
                JSON.stringify(op.config ?? {}),
                now(),
              ],
            )
            await emitEvent(
              ctx,
              'connection.created',
              'connection',
              id,
              `connected ${op.provider} to ${op.board}`,
            )
            return { id, secret }
          }
          case 'update': {
            const rows = await ctx.db.query<{ id: string; board_id: string }>(
              'SELECT id, board_id FROM connection WHERE workspace_id = ? AND id = ?',
              [ctx.workspaceId, op.id],
            )
            if (rows.length === 0)
              throw new ApiError(404, `connection ${op.id} not found`)
            const listId =
              op.list === undefined
                ? undefined
                : await resolveList(ctx, rows[0].board_id, op.list)
            await assertLabelsExist(ctx, rows[0].board_id, op.config?.labels)
            await ctx.db.run(
              `UPDATE connection
                  SET name = COALESCE(?, name),
                      list_id = CASE WHEN ? THEN ? ELSE list_id END,
                      enabled = COALESCE(?, enabled),
                      config = COALESCE(?, config)
                WHERE id = ?`,
              [
                op.name ?? null,
                op.list === undefined ? 0 : 1,
                listId,
                op.enabled === undefined ? null : op.enabled ? 1 : 0,
                op.config ? JSON.stringify(op.config) : null,
                op.id,
              ],
            )
            await emitEvent(
              ctx,
              'connection.updated',
              'connection',
              op.id,
              'updated connection',
            )
            return { id: op.id }
          }
          case 'delete': {
            await ctx.db.run(
              'DELETE FROM connection WHERE workspace_id = ? AND id = ?',
              [ctx.workspaceId, op.id],
            )
            await emitEvent(
              ctx,
              'connection.deleted',
              'connection',
              op.id,
              'deleted connection',
            )
            return { id: op.id }
          }
        }
      }),
    )
  }
  return results
}

export interface IConnectionView {
  id: string
  provider: TConnectionProvider
  name: string
  board: string
  list: string | null
  enabled: boolean
  config: TConnectionConfig
  last_event_at: number | null
  last_error: string | null
}

export async function connectionList(
  ctx: ICtx,
): Promise<{ connections: IConnectionView[] }> {
  const rows = await ctx.db.query<{
    id: string
    provider: TConnectionProvider
    name: string
    board_key: string
    list_name: string | null
    enabled: number
    config: string
    last_event_at: number | null
    last_error: string | null
  }>(
    `SELECT c.id, c.provider, c.name, b.key AS board_key, l.name AS list_name,
            c.enabled, c.config, c.last_event_at, c.last_error
       FROM connection c
       JOIN board b ON b.id = c.board_id
       LEFT JOIN list l ON l.id = c.list_id
      WHERE c.workspace_id = ?
      ORDER BY c.created_at`,
    [ctx.workspaceId],
  )
  return {
    connections: rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      name: r.name,
      board: r.board_key,
      list: r.list_name,
      enabled: r.enabled === 1,
      config: JSON.parse(r.config) as TConnectionConfig,
      last_event_at: r.last_event_at,
      last_error: r.last_error,
    })),
  }
}

/** Records the outcome of a delivery so a misconfigured hook is visible. */
export async function noteConnectionDelivery(
  ctx: Pick<ICtx, 'db'>,
  id: string,
  error: string | null,
): Promise<void> {
  await ctx.db.run(
    'UPDATE connection SET last_event_at = ?, last_error = ? WHERE id = ?',
    [now(), error, id],
  )
}
