import { Hono } from 'hono'
import { z } from 'zod'
import {
  zActivityQuery,
  zBoardGet,
  zBoardWrite,
  zDocSlug,
  zDocWrite,
  zItemGet,
  zItemWrite,
  zLabelWrite,
  zSearch,
} from '@nubisco/acta-shared'
import { ApiError, type ICtx } from '../core/ctx'
import { createToken } from '../core/auth'
import { emitEvent, flushPendingEvents, onEvent } from '../core/events'
import { boardWrite } from '../services/boards'
import { docWrite } from '../services/docs'
import { itemWrite } from '../services/items'
import { labelWrite } from '../services/labels'
import {
  activityQuery,
  boardGet,
  docGet,
  docTree,
  itemGet,
  search,
  workspaceOverview,
} from '../services/reads'
import type { IAuthEnv } from './auth'
import { newId } from '@nubisco/acta-shared'
import { now } from '../core/ctx'
import {
  attachmentAdd,
  attachmentGet,
  zAttachmentAdd,
  type AttachmentStore,
} from '../services/attachments'
import { ruleList, ruleWrite, zRuleWrite } from '../services/rules'
import { webhookList, webhookWrite, zWebhookWrite } from '../services/webhooks'
import { createIngestToken, zIngestTokenCreate } from './ingest'

function ctxOf(c: {
  get: (key: 'db' | 'workspaceId' | 'actor') => unknown
}): ICtx {
  return {
    db: c.get('db') as ICtx['db'],
    workspaceId: c.get('workspaceId') as string,
    actor: c.get('actor') as ICtx['actor'],
  }
}

function requireScope(ctx: ICtx, scope: string): void {
  if (!ctx.actor.scopes.includes(scope))
    throw new ApiError(403, `missing scope ${scope}`)
}

export function apiRoutes(store: AttachmentStore): Hono<IAuthEnv> {
  const app = new Hono<IAuthEnv>()

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json(
        { error: err.message, current: err.current },
        err.status as 400,
      )
    }
    if (err instanceof z.ZodError) {
      return c.json({ error: 'validation', issues: err.issues }, 400)
    }
    console.error(err)
    return c.json({ error: 'internal' }, 500)
  })

  // Reads -------------------------------------------------------------------
  app.get('/overview', async (c) => c.json(await workspaceOverview(ctxOf(c))))

  app.get('/boards/:key', async (c) => {
    const params = zBoardGet.parse({
      board: c.req.param('key'),
      ...c.req.query(),
      updated_since: c.req.query('updated_since')
        ? Number(c.req.query('updated_since'))
        : undefined,
      limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
    })
    return c.json(await boardGet(ctxOf(c), params))
  })

  app.post('/items/get', async (c) =>
    c.json(await itemGet(ctxOf(c), zItemGet.parse(await c.req.json()))),
  )

  app.get('/docs', async (c) =>
    c.json(
      await docTree(
        ctxOf(c),
        c.req.query('root'),
        c.req.query('depth') ? Number(c.req.query('depth')) : undefined,
      ),
    ),
  )

  app.get('/docs/:slug{.+}', async (c) => {
    const slug = zDocSlug.parse(c.req.param('slug'))
    const include = c.req.query('include')?.split(',')
    const atVersion = c.req.query('at_version')
    return c.json(
      await docGet(ctxOf(c), slug, {
        include,
        at_version: atVersion ? Number(atVersion) : undefined,
      }),
    )
  })

  app.get('/search', async (c) =>
    c.json(
      await search(
        ctxOf(c),
        zSearch.parse({
          query: c.req.query('q'),
          types: c.req.query('types')?.split(','),
          board: c.req.query('board'),
          limit: c.req.query('limit')
            ? Number(c.req.query('limit'))
            : undefined,
        }),
      ),
    ),
  )

  app.get('/activity', async (c) =>
    c.json(
      await activityQuery(
        ctxOf(c),
        zActivityQuery.parse({
          ...c.req.query(),
          limit: c.req.query('limit')
            ? Number(c.req.query('limit'))
            : undefined,
        }),
      ),
    ),
  )

  // Writes ------------------------------------------------------------------
  app.post('/items/write', async (c) => {
    const ctx = ctxOf(c)
    requireScope(ctx, 'write')
    const body = zItemWrite.parse(await c.req.json())
    return c.json({
      results: await itemWrite(ctx, body.ops, body.default_board),
    })
  })

  app.post('/boards/write', async (c) => {
    const ctx = ctxOf(c)
    requireScope(ctx, 'write')
    const body = zBoardWrite.parse(await c.req.json())
    return c.json({ results: await boardWrite(ctx, body.ops) })
  })

  app.post('/docs/write', async (c) => {
    const ctx = ctxOf(c)
    requireScope(ctx, 'write')
    const body = zDocWrite.parse(await c.req.json())
    return c.json({ results: await docWrite(ctx, body.ops) })
  })

  app.post('/labels/write', async (c) => {
    const ctx = ctxOf(c)
    requireScope(ctx, 'write')
    const body = zLabelWrite.parse(await c.req.json())
    return c.json({ results: await labelWrite(ctx, body.ops) })
  })

  app.post('/webhooks/write', async (c) => {
    const ctx = ctxOf(c)
    requireScope(ctx, 'write')
    const body = zWebhookWrite.parse(await c.req.json())
    return c.json({
      results: await webhookWrite(ctx, body.ops),
      ...(await webhookList(ctx)),
    })
  })
  app.get('/webhooks', async (c) => c.json(await webhookList(ctxOf(c))))

  app.get('/webhooks/:id/deliveries', async (c) => {
    const ctx = ctxOf(c)
    return c.json({
      deliveries: await ctx.db.query(
        `SELECT d.event, d.status, d.attempts, d.last_error, d.created_at
           FROM webhook_delivery d JOIN webhook w ON w.id = d.webhook_id
          WHERE w.workspace_id = ? AND d.webhook_id = ?
          ORDER BY d.created_at DESC LIMIT 100`,
        [ctx.workspaceId, c.req.param('id')],
      ),
    })
  })

  app.post('/rules/write', async (c) => {
    const ctx = ctxOf(c)
    requireScope(ctx, 'write')
    const body = zRuleWrite.parse(await c.req.json())
    return c.json({
      results: await ruleWrite(ctx, body.ops),
      ...(await ruleList(ctx)),
    })
  })
  app.get('/rules', async (c) => c.json(await ruleList(ctxOf(c))))

  app.post('/ingest_tokens', async (c) => {
    const ctx = ctxOf(c)
    requireScope(ctx, 'admin')
    const body = zIngestTokenCreate.parse(await c.req.json())
    return c.json(await createIngestToken(ctx, body))
  })

  app.post('/attachments', async (c) => {
    const ctx = ctxOf(c)
    requireScope(ctx, 'write')
    const body = zAttachmentAdd.parse(await c.req.json())
    return c.json(await attachmentAdd(ctx, store, body))
  })

  app.get('/attachments/:id', async (c) => {
    const ctx = ctxOf(c)
    const { meta, bytes } = await attachmentGet(ctx, store, c.req.param('id'))
    if (!bytes)
      return c.json({ kind: 'url', url: meta.url, filename: meta.filename })
    return new Response(new Uint8Array(bytes), {
      headers: {
        'content-type': meta.mime ?? 'application/octet-stream',
        'content-disposition': `attachment; filename="${meta.filename.replace(/"/g, '')}"`,
      },
    })
  })

  // Members (admin) ---------------------------------------------------------
  app.post('/members', async (c) => {
    const ctx = ctxOf(c)
    requireScope(ctx, 'admin')
    const body = z
      .object({
        email: z.email(),
        handle: z
          .string()
          .min(2)
          .max(40)
          .regex(/^[a-z0-9-]+$/),
        name: z.string().min(1).max(120),
        role: z.enum(['admin', 'member']).default('member'),
      })
      .parse(await c.req.json())
    const clash = await ctx.db.query(
      'SELECT id FROM actor WHERE workspace_id = ? AND (handle = ? OR email = ?)',
      [ctx.workspaceId, body.handle, body.email],
    )
    if (clash.length > 0)
      throw new ApiError(409, 'a member with that handle or email exists')
    const id = newId('act')
    await ctx.db.run(
      `INSERT INTO actor (id, workspace_id, kind, handle, name, email, role, created_at)
       VALUES (?, ?, 'human', ?, ?, ?, ?, ?)`,
      [
        id,
        ctx.workspaceId,
        body.handle,
        body.name,
        body.email,
        body.role,
        now(),
      ],
    )
    await emitEvent(
      ctx,
      'member.added',
      'actor',
      id,
      `added member @${body.handle}`,
    )
    flushPendingEvents()
    return c.json({ id, handle: body.handle })
  })

  app.patch('/members/:id', async (c) => {
    const ctx = ctxOf(c)
    requireScope(ctx, 'admin')
    const body = z
      .object({
        role: z.enum(['admin', 'member']).optional(),
        disabled: z.boolean().optional(),
        name: z.string().min(1).max(120).optional(),
      })
      .parse(await c.req.json())
    if (c.req.param('id') === ctx.actor.id && body.disabled)
      throw new ApiError(400, 'you cannot disable yourself')
    await ctx.db.run(
      `UPDATE actor SET role = COALESCE(?, role), name = COALESCE(?, name),
              disabled = COALESCE(?, disabled)
        WHERE workspace_id = ? AND id = ? AND kind = 'human'`,
      [
        body.role ?? null,
        body.name ?? null,
        body.disabled === undefined ? null : body.disabled ? 1 : 0,
        ctx.workspaceId,
        c.req.param('id'),
      ],
    )
    if (body.disabled) {
      await ctx.db.run(
        'UPDATE auth_token SET revoked_at = ? WHERE workspace_id = ? AND actor_id = ?',
        [now(), ctx.workspaceId, c.req.param('id')],
      )
    }
    await emitEvent(
      ctx,
      'member.updated',
      'actor',
      c.req.param('id'),
      'updated member',
    )
    flushPendingEvents()
    return c.json({ ok: true })
  })

  // Agent tokens (admin, human sessions only: design-spec §4) ---------------
  app.post('/tokens', async (c) => {
    const ctx = ctxOf(c)
    requireScope(ctx, 'admin')
    if (ctx.actor.kind !== 'human')
      throw new ApiError(403, 'agent tokens are managed by humans')
    const body = z
      .object({
        name: z.string().min(1).max(100),
        scopes: z
          .array(z.enum(['read', 'write', 'admin']))
          .default(['read', 'write']),
        on_behalf_of: z.string().optional(),
      })
      .parse(await c.req.json())
    const handleBase = body.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
    const actorId = newId('act')
    await ctx.db.run(
      `INSERT INTO actor (id, workspace_id, kind, handle, name, role, on_behalf_of, created_at)
       VALUES (?, ?, 'agent', ?, ?, 'member', ?, ?)`,
      [
        actorId,
        ctx.workspaceId,
        `${handleBase}-${actorId.slice(-4)}`,
        body.name,
        body.on_behalf_of ?? null,
        now(),
      ],
    )
    const token = await createToken(
      ctx.db,
      ctx.workspaceId,
      actorId,
      'agent',
      body.scopes,
    )
    return c.json({ actor_id: actorId, token })
  })

  app.delete('/tokens/:actorId', async (c) => {
    const ctx = ctxOf(c)
    requireScope(ctx, 'admin')
    await ctx.db.run(
      'UPDATE auth_token SET revoked_at = ? WHERE workspace_id = ? AND actor_id = ?',
      [now(), ctx.workspaceId, c.req.param('actorId')],
    )
    await ctx.db.run(
      'UPDATE actor SET disabled = 1 WHERE workspace_id = ? AND id = ? AND kind = ?',
      [ctx.workspaceId, c.req.param('actorId'), 'agent'],
    )
    return c.json({ ok: true })
  })

  // SSE ---------------------------------------------------------------------
  app.get('/events/stream', (c) => {
    const workspaceId = c.get('workspaceId')
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder()
        controller.enqueue(encoder.encode(': connected\n\n'))
        const off = onEvent((event) => {
          if (event.workspace_id !== workspaceId) return
          const data = JSON.stringify({
            id: event.id,
            verb: event.verb,
            entity: event.entity,
            entity_id: event.entity_id,
            actor_kind: event.actor_kind,
          })
          controller.enqueue(encoder.encode(`data: ${data}\n\n`))
        })
        c.req.raw.signal.addEventListener('abort', () => {
          off()
          controller.close()
        })
      },
    })
    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      },
    })
  })

  return app
}
