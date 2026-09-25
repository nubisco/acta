import { Hono } from 'hono'
import { z } from 'zod'
import {
  zActivityQuery,
  zSpaceGet,
  zSpaceWrite,
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
import { spaceWrite } from '../services/spaces'
import { docWrite } from '../services/docs'
import {
  notificationList,
  notificationPrefs,
  notificationPrefsSet,
  notificationRead,
  REMINDER_DELAYS,
} from '../services/notifications'
import { sequenceGet } from '../services/sequence'
import { itemWrite } from '../services/items'
import { labelWrite } from '../services/labels'
import {
  activityQuery,
  spaceGet,
  docGet,
  docTree,
  itemGet,
  myWork,
  search,
  workspaceOverview,
} from '../services/reads'
import type { IAuthEnv } from './auth'
import { newId } from '@nubisco/acta-shared'
import { now } from '../core/ctx'
import {
  attachmentAdd,
  attachmentAddBatch,
  attachmentDelete,
  attachmentGet,
  attachmentHeaders,
  attachmentUpload,
  zAttachmentUpload,
  zAttachmentAdd,
  zAttachmentAddBatch,
  type AttachmentStore,
} from '../services/attachments'
import { linkPreviewGet, zLinkPreviewRequest } from '../services/linkPreviews'
import {
  attachmentFetchRemote,
  zAttachmentFetch,
} from '../services/remoteImages'
import type { IFetchDeps } from '../core/safeFetch'
import { ruleList, ruleWrite, zRuleWrite } from '../services/rules'
import {
  connectionList,
  connectionWrite,
  zConnectionWrite,
} from '../services/connections'
import { webhookList, webhookWrite, zWebhookWrite } from '../services/webhooks'
import {
  createIngestToken,
  listIngestTokens,
  revokeIngestToken,
  zIngestTokenCreate,
} from './ingest'

function ctxOf(c: {
  get: (key: 'db' | 'workspaceId' | 'actor') => unknown
}): ICtx {
  return {
    db: c.get('db') as ICtx['db'],
    workspaceId: c.get('workspaceId') as string,
    actor: c.get('actor') as ICtx['actor'],
  }
}

/** A space id from its key, scoped to the workspace on the request. */
async function spaceIdFor(ctx: ICtx, key: string): Promise<string> {
  const rows = await ctx.db.query<{ id: string }>(
    'SELECT id FROM space WHERE workspace_id = ? AND key = ?',
    [ctx.workspaceId, key],
  )
  if (rows.length === 0) throw new ApiError(404, `space ${key} not found`)
  return rows[0].id
}

function requireScope(ctx: ICtx, scope: string): void {
  if (!ctx.actor.scopes.includes(scope))
    throw new ApiError(403, `missing scope ${scope}`)
}

/** Avatars are small by nature; 2 MB is generous for a cropped square. */
const AVATAR_MAX_BYTES = 2 * 1024 * 1024

export interface IApiRouteOptions {
  /**
   * Resolver and fetch for requests to addresses users supply. Tests pass
   * their own, so no test touches the network.
   */
  remoteFetchDeps?: IFetchDeps
}

export function apiRoutes(
  store: AttachmentStore,
  options: IApiRouteOptions = {},
): Hono<IAuthEnv> {
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

  app.get('/spaces/:key', async (c) => {
    const params = zSpaceGet.parse({
      space: c.req.param('key'),
      ...c.req.query(),
      updated_since: c.req.query('updated_since')
        ? Number(c.req.query('updated_since'))
        : undefined,
      limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
    })
    return c.json(await spaceGet(ctxOf(c), params))
  })

  /**
   * What is mine, across every space. Every other item read is space-scoped,
   * which cannot answer the question Home is for.
   */
  app.get('/me/work', async (c) => c.json(await myWork(ctxOf(c))))

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
          space: c.req.query('space'),
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
      results: await itemWrite(ctx, body.ops, body.default_space, store),
    })
  })

  app.post('/spaces/write', async (c) => {
    const ctx = ctxOf(c)
    requireScope(ctx, 'write')
    const body = zSpaceWrite.parse(await c.req.json())
    return c.json({ results: await spaceWrite(ctx, body.ops) })
  })

  app.post('/docs/write', async (c) => {
    const ctx = ctxOf(c)
    requireScope(ctx, 'write')
    const body = zDocWrite.parse(await c.req.json())
    return c.json({ results: await docWrite(ctx, body.ops, store) })
  })

  /**
   * The plan for one space: what can start now, what waits on what, and the
   * chain that decides the finish.
   */
  app.get('/spaces/:key/sequence', async (c) =>
    c.json(await sequenceGet(ctxOf(c), c.req.param('key'))),
  )

  // Notifications ------------------------------------------------------------
  app.get('/notifications', async (c) =>
    c.json(await notificationList(ctxOf(c))),
  )

  /** No id marks everything read, which is what the bell's own control does. */
  app.post('/notifications/read', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { id?: string }
    return c.json(await notificationRead(ctxOf(c), body.id))
  })

  /**
   * How long this person's unread notifications wait before Acta reaches
   * them some other way. Their own setting, so no scope check beyond being
   * signed in: there is nobody else's preference to read or write here.
   */
  app.get('/notifications/prefs', async (c) =>
    c.json(await notificationPrefs(ctxOf(c))),
  )

  app.put('/notifications/prefs', async (c) => {
    const body = z
      .object({
        // A closed set, not a free number. The sweep runs on a fixed tick,
        // so a value between two of these would only look precise.
        notify_after_seconds: z
          .number()
          .int()
          .refine((n) => (REMINDER_DELAYS as readonly number[]).includes(n), {
            message: `expected one of ${REMINDER_DELAYS.join(', ')}`,
          }),
      })
      .parse(await c.req.json())
    return c.json(
      await notificationPrefsSet(ctxOf(c), body.notify_after_seconds),
    )
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

  app.post('/connections/write', async (c) => {
    const ctx = ctxOf(c)
    requireScope(ctx, 'write')
    const body = zConnectionWrite.parse(await c.req.json())
    // The results carry the signing secret for a freshly created connection,
    // which is the only time it is ever returned; the list beside it never
    // includes one.
    return c.json({
      results: await connectionWrite(ctx, body.ops),
      ...(await connectionList(ctx)),
    })
  })
  app.get('/connections', async (c) => c.json(await connectionList(ctxOf(c))))

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

  /**
   * Starring is a personal opinion about attention, so it is a plain toggle
   * on the actor rather than an op with provenance and an event: nobody needs
   * an audit trail of who favourited what.
   */
  app.put('/spaces/:key/star', async (c) => {
    const ctx = ctxOf(c)
    requireScope(ctx, 'write')
    const space = await spaceIdFor(ctx, c.req.param('key'))
    await ctx.db.run(
      `INSERT OR IGNORE INTO space_star (workspace_id, actor_id, space_id, created_at)
       VALUES (?, ?, ?, ?)`,
      [ctx.workspaceId, ctx.actor.id, space, now()],
    )
    return c.json({ ok: true, starred: true })
  })

  app.delete('/spaces/:key/star', async (c) => {
    const ctx = ctxOf(c)
    requireScope(ctx, 'write')
    const space = await spaceIdFor(ctx, c.req.param('key'))
    await ctx.db.run(
      'DELETE FROM space_star WHERE actor_id = ? AND space_id = ?',
      [ctx.actor.id, space],
    )
    return c.json({ ok: true, starred: false })
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

  app.get('/ingest_tokens', async (c) => {
    const ctx = ctxOf(c)
    requireScope(ctx, 'admin')
    return c.json(await listIngestTokens(ctx))
  })

  app.post('/ingest_tokens', async (c) => {
    const ctx = ctxOf(c)
    requireScope(ctx, 'admin')
    const body = zIngestTokenCreate.parse(await c.req.json())
    return c.json(await createIngestToken(ctx, body))
  })

  app.delete('/ingest_tokens/:id', async (c) => {
    const ctx = ctxOf(c)
    requireScope(ctx, 'admin')
    const result = await revokeIngestToken(ctx, c.req.param('id'))
    await emitEvent(
      ctx,
      'ingest_token.revoked',
      'ingest_token',
      c.req.param('id'),
      'revoked ingest token',
    )
    flushPendingEvents()
    return c.json(result)
  })

  /**
   * Metadata for the bare URLs in a document, so each can render as a card.
   *
   * POST rather than GET because a document's worth of URLs does not fit in a
   * query string, and one request rather than one per link because the point
   * of the batch is that opening a document is one round trip whatever it
   * contains. Everything outbound from here goes through the SSRF guard in
   * core/safeFetch.ts, and every failure comes back as status 'none' so the
   * reader can keep showing the plain link.
   */
  app.post('/link-previews', async (c) => {
    const body = zLinkPreviewRequest.parse(await c.req.json())
    return c.json({ previews: await linkPreviewGet(ctxOf(c), body.urls) })
  })

  app.post('/attachments', async (c) => {
    const ctx = ctxOf(c)
    requireScope(ctx, 'write')
    const body = zAttachmentAdd.parse(await c.req.json())
    return c.json(await attachmentAdd(ctx, store, body))
  })

  /**
   * A picture on another site, copied into an attachment on a page.
   *
   * The import's fallback for images the browser is not allowed to read. It
   * goes through the SSRF guard, and every failure answers with the same 422
   * so it cannot be used to tell which internal addresses exist. See
   * services/remoteImages.ts.
   */
  app.post('/attachments/fetch', async (c) => {
    const ctx = ctxOf(c)
    requireScope(ctx, 'write')
    const body = zAttachmentFetch.parse(await c.req.json())
    return c.json(
      await attachmentFetchRemote(ctx, store, body, options.remoteFetchDeps),
    )
  })

  app.post('/attachments/batch', async (c) => {
    const ctx = ctxOf(c)
    requireScope(ctx, 'write')
    const body = zAttachmentAddBatch.parse(await c.req.json())
    return c.json(await attachmentAddBatch(ctx, store, body))
  })

  // Binary upload path: metadata in the query, the body is the file itself.
  app.post('/attachments/raw', async (c) => {
    const ctx = ctxOf(c)
    requireScope(ctx, 'write')
    const params = zAttachmentUpload.parse({
      item: c.req.query('item'),
      doc: c.req.query('doc'),
      filename: c.req.query('filename'),
      mime: c.req.query('mime'),
    })
    const bytes = new Uint8Array(await c.req.arrayBuffer())
    return c.json(await attachmentUpload(ctx, store, params, bytes))
  })

  app.delete('/attachments/:id', async (c) => {
    const ctx = ctxOf(c)
    requireScope(ctx, 'write')
    return c.json(await attachmentDelete(ctx, store, c.req.param('id')))
  })

  app.get('/attachments/:id', async (c) => {
    const ctx = ctxOf(c)
    const { meta, bytes } = await attachmentGet(ctx, store, c.req.param('id'))
    if (!bytes)
      return c.json({ kind: 'url', url: meta.url, filename: meta.filename })
    return new Response(new Uint8Array(bytes), {
      headers: attachmentHeaders(meta.mime, meta.filename),
    })
  })

  // Workspaces (multi-tenant groundwork: one today, Trello-style many later)
  app.get('/workspaces', async (c) => {
    const ctx = ctxOf(c)
    const me = (
      await ctx.db.query<{ email: string | null }>(
        'SELECT email FROM actor WHERE id = ?',
        [ctx.actor.id],
      )
    )[0]
    if (!me?.email) {
      const current = (
        await ctx.db.query<{ id: string; name: string }>(
          'SELECT id, name FROM workspace WHERE id = ?',
          [ctx.workspaceId],
        )
      )[0]
      return c.json({
        workspaces: [{ id: current.id, name: current.name, current: true }],
      })
    }
    const rows = await ctx.db.query<{ id: string; name: string }>(
      `SELECT w.id, w.name FROM workspace w
         JOIN actor a ON a.workspace_id = w.id
        WHERE a.email = ? AND a.kind = 'human' AND a.disabled = 0
        ORDER BY w.name`,
      [me.email],
    )
    return c.json({
      workspaces: rows.map((w) => ({
        id: w.id,
        name: w.name,
        current: w.id === ctx.workspaceId,
      })),
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

  /**
   * A person's own picture. Uploaded here rather than only through an
   * identity provider, because anything only the hosted product can do is
   * something a self-hosted workspace can never do: the initials fallback
   * would stop being a graceful default and become the ceiling.
   *
   * The bytes are already cropped by the client, so this stores what it is
   * given rather than resizing server-side.
   */
  app.post('/members/:id/avatar', async (c) => {
    const ctx = ctxOf(c)
    const target = c.req.param('id')
    // Your own face is yours to change; anyone else's needs admin.
    if (target !== ctx.actor.id) requireScope(ctx, 'admin')
    else requireScope(ctx, 'write')

    const mime = c.req.header('content-type') ?? 'image/png'
    if (!mime.startsWith('image/'))
      throw new ApiError(415, 'avatar must be an image')
    const bytes = new Uint8Array(await c.req.arrayBuffer())
    if (bytes.byteLength === 0) throw new ApiError(400, 'empty upload')
    if (bytes.byteLength > AVATAR_MAX_BYTES)
      throw new ApiError(413, 'avatars are capped at 2 MB')

    const rows = await ctx.db.query<{ avatar_url: string | null }>(
      "SELECT avatar_url FROM actor WHERE workspace_id = ? AND id = ? AND kind = 'human'",
      [ctx.workspaceId, target],
    )
    if (rows.length === 0) throw new ApiError(404, 'member not found')

    const id = newId('att')
    await store.write(id, bytes)
    const url = `/api/v1/avatars/${id}`
    await ctx.db.run(
      `UPDATE actor SET avatar_url = ?, avatar_source = 'upload'
        WHERE workspace_id = ? AND id = ?`,
      [url, ctx.workspaceId, target],
    )
    // The old blob is unreachable the moment the row stops naming it, so it
    // goes with the row rather than lingering in the bucket forever.
    const previous = rows[0].avatar_url
    if (previous?.startsWith('/api/v1/avatars/')) {
      await store.remove(previous.slice('/api/v1/avatars/'.length))
    }
    return c.json({ ok: true, avatar_url: url })
  })

  app.delete('/members/:id/avatar', async (c) => {
    const ctx = ctxOf(c)
    const target = c.req.param('id')
    if (target !== ctx.actor.id) requireScope(ctx, 'admin')
    else requireScope(ctx, 'write')
    const rows = await ctx.db.query<{ avatar_url: string | null }>(
      'SELECT avatar_url FROM actor WHERE workspace_id = ? AND id = ?',
      [ctx.workspaceId, target],
    )
    const previous = rows[0]?.avatar_url
    await ctx.db.run(
      `UPDATE actor SET avatar_url = NULL, avatar_source = 'sso'
        WHERE workspace_id = ? AND id = ?`,
      [ctx.workspaceId, target],
    )
    if (previous?.startsWith('/api/v1/avatars/')) {
      await store.remove(previous.slice('/api/v1/avatars/'.length))
    }
    return c.json({ ok: true })
  })

  /**
   * Avatars are readable by anyone signed in: they appear on every card and
   * comment, so gating each one behind a per-member check would be a lot of
   * work to protect something already on the screen.
   */
  app.get('/avatars/:id', async (c) => {
    const bytes = await store.read(c.req.param('id'))
    if (!bytes) return c.json({ error: 'not found' }, 404)
    return new Response(new Uint8Array(bytes), {
      headers: {
        'content-type': 'image/png',
        // Content-addressed by id: a new upload gets a new id, so this can be
        // cached hard without anyone ever seeing a stale face.
        'cache-control': 'public, max-age=31536000, immutable',
      },
    })
  })

  /**
   * Workspace-wide policy. Admin only, and deliberately not part of
   * PATCH /members: this is a fact about the workspace rather than about a
   * person, and the two have different blast radii.
   */
  app.put('/workspace/policy', async (c) => {
    const ctx = ctxOf(c)
    requireScope(ctx, 'admin')
    const body = z
      .object({ comment_delete: z.enum(['author', 'admin']) })
      .parse(await c.req.json())
    await ctx.db.run('UPDATE workspace SET comment_delete = ? WHERE id = ?', [
      body.comment_delete,
      ctx.workspaceId,
    ])
    return c.json({ comment_delete: body.comment_delete })
  })

  app.patch('/members/:id', async (c) => {
    const ctx = ctxOf(c)
    requireScope(ctx, 'admin')
    const body = z
      .object({
        role: z.enum(['admin', 'member']).optional(),
        disabled: z.boolean().optional(),
        name: z.string().min(1).max(120).optional(),
        /** Core identity field; SSO providers and self-hosted uploads both
         * write it here. null clears back to the initials fallback. */
        avatar_url: z.string().url().max(2000).nullable().optional(),
      })
      .parse(await c.req.json())
    if (c.req.param('id') === ctx.actor.id && body.disabled)
      throw new ApiError(400, 'you cannot disable yourself')
    // An identity provider seeds an avatar so a new member arrives with a
    // face, but it must not overwrite one the person chose themselves: an
    // upload that silently reverts on the next sign-in reads as a bug.
    await ctx.db.run(
      `UPDATE actor SET role = COALESCE(?, role), name = COALESCE(?, name),
              disabled = COALESCE(?, disabled),
              avatar_url = CASE WHEN ? AND avatar_source != 'upload'
                                THEN ? ELSE avatar_url END
        WHERE workspace_id = ? AND id = ? AND kind = 'human'`,
      [
        body.role ?? null,
        body.name ?? null,
        body.disabled === undefined ? null : body.disabled ? 1 : 0,
        body.avatar_url !== undefined ? 1 : 0,
        body.avatar_url ?? null,
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
      body.role
        ? `you are now ${body.role === 'admin' ? 'an admin' : 'a member'}`
        : 'updated member',
      undefined,
      // Only a role change, and only to the person it happened to. Being
      // made an admin changes what the app will let you do, so finding out
      // by trying something and having it work is the wrong way round. A
      // renamed member or a new avatar is not news to anybody.
      body.role
        ? {
            to: [{ actorId: c.req.param('id'), reason: 'assigned' as const }],
          }
        : undefined,
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
        // Keepalive: Cloudflare (and some proxies) close idle streams.
        const keepalive = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(': ping\n\n'))
          } catch {
            clearInterval(keepalive)
          }
        }, 20_000)
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
          clearInterval(keepalive)
          off()
          try {
            controller.close()
          } catch {
            // already closed
          }
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
