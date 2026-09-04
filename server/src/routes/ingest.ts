import { Hono } from 'hono'
import { z } from 'zod'
import { newId, zIngest } from '@nubisco/acta-shared'
import { sha256Hex } from '../core/auth'
import { ApiError, now, type IActorCtx, type ICtx } from '../core/ctx'
import type { ISqlDriver } from '../db'
import { itemWrite } from '../services/items'

interface IIngestEnv {
  Variables: {
    db: ISqlDriver
    workspaceId: string
    actor: IActorCtx
  }
}

/**
 * Inbound ingest (design-spec §5): the contact-form replacement. Public
 * endpoint authenticated by the path token; items are attributed to the
 * token's agent actor.
 */
export function ingestRoutes(): Hono<IIngestEnv> {
  const app = new Hono<IIngestEnv>()

  app.post('/:token', async (c) => {
    const db = c.get('db')
    const tokenHash = await sha256Hex(c.req.param('token'))
    const rows = await db.query<{
      id: string
      workspace_id: string
      actor_id: string
      board_id: string
      list_id: string | null
      handle: string
    }>(
      `SELECT t.id, t.workspace_id, t.actor_id, t.board_id, t.list_id, a.handle
         FROM ingest_token t JOIN actor a ON a.id = t.actor_id
        WHERE t.token_hash = ? AND a.disabled = 0`,
      [tokenHash],
    )
    if (rows.length === 0) return c.json({ error: 'unauthorized' }, 401)
    const token = rows[0]

    let body: z.infer<typeof zIngest>
    try {
      body = zIngest.parse(await c.req.json())
    } catch (err) {
      return c.json({ error: 'validation', detail: String(err) }, 400)
    }

    const board = (
      await db.query<{ key: string }>('SELECT key FROM board WHERE id = ?', [
        token.board_id,
      ])
    )[0]
    const list =
      body.list ??
      (
        await db.query<{ name: string }>(`SELECT name FROM list WHERE id = ?`, [
          token.list_id ?? '',
        ])
      )[0]?.name ??
      (
        await db.query<{ name: string }>(
          `SELECT name FROM list WHERE board_id = ? AND archived = 0 ORDER BY CASE role WHEN 'inbox' THEN 0 WHEN 'backlog' THEN 1 ELSE 2 END, pos LIMIT 1`,
          [token.board_id],
        )
      )[0]?.name

    const ctx: ICtx = {
      db,
      workspaceId: token.workspace_id,
      actor: {
        id: token.actor_id,
        kind: 'agent',
        handle: token.handle,
        role: 'member',
        scopes: ['write'],
      },
    }
    const description = [
      body.description ?? '',
      body.meta
        ? '\n' +
          Object.entries(body.meta)
            .map(([k, v]) => `- **${k}**: ${v}`)
            .join('\n')
        : '',
    ]
      .join('')
      .trim()

    const results = await itemWrite(
      ctx,
      [
        {
          op: 'create',
          op_id: `ingest:${newId('itm')}`,
          board: body.board ?? board.key,
          list: list ?? 'Backlog',
          title: body.title,
          description,
          labels: body.labels,
        },
      ],
      undefined,
    )
    const result = results[0]
    if (!result.ok) return c.json({ error: result.error }, 400)
    return c.json({ ok: true, key: result.key })
  })

  return app
}

/** Admin management of ingest tokens (REST only). */
export const zIngestTokenCreate = z.object({
  name: z.string().min(1).max(100),
  board: z.string().min(2).max(5),
  list: z.string().optional(),
})

export async function createIngestToken(
  ctx: ICtx,
  input: z.infer<typeof zIngestTokenCreate>,
): Promise<{ token: string; actor_id: string }> {
  const board = await ctx.db.query<{ id: string }>(
    'SELECT id FROM board WHERE workspace_id = ? AND key = ?',
    [ctx.workspaceId, input.board],
  )
  if (board.length === 0)
    throw new ApiError(404, `board ${input.board} not found`)
  let listId: string | null = null
  if (input.list) {
    const list = await ctx.db.query<{ id: string }>(
      'SELECT id FROM list WHERE board_id = ? AND lower(name) = lower(?)',
      [board[0].id, input.list],
    )
    if (list.length === 0)
      throw new ApiError(404, `list ${input.list} not found`)
    listId = list[0].id
  }
  const actorId = newId('act')
  const handle = `${input.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')}-${actorId.slice(-4)}`
  await ctx.db.run(
    `INSERT INTO actor (id, workspace_id, kind, handle, name, role, created_at) VALUES (?, ?, 'agent', ?, ?, 'member', ?)`,
    [actorId, ctx.workspaceId, handle, input.name, now()],
  )
  // The raw ingest token doubles as a bearer credential hash source; it is
  // stored only hashed, same as auth tokens.
  const raw = await createIngestSecret(ctx, actorId, board[0].id, listId)
  return { token: raw, actor_id: actorId }
}

async function createIngestSecret(
  ctx: ICtx,
  actorId: string,
  boardId: string,
  listId: string | null,
): Promise<string> {
  const raw = crypto
    .getRandomValues(new Uint8Array(24))
    .reduce((s, b) => s + b.toString(16).padStart(2, '0'), '')
  await ctx.db.run(
    'INSERT INTO ingest_token (id, workspace_id, token_hash, actor_id, board_id, list_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [
      newId('act'),
      ctx.workspaceId,
      await sha256Hex(raw),
      actorId,
      boardId,
      listId,
      now(),
    ],
  )
  return raw
}
