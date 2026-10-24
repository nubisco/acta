// Copyright (c) Nubisco, Lda. All Rights Reserved.
// Acta Enterprise Edition. See packages/ee/LICENSE.

/**
 * Self-serve signup (LA-398): creating a workspace of your own.
 *
 * Two kinds of person get here. Someone the identity provider vouched for who
 * belongs to no workspace, sent on by the sign-in callback with a signup
 * cookie (intent.ts). And someone already signed in, creating one from the
 * workspaces page. Both are identified by the server, never by a field in the
 * request: the address a workspace is created for is one already proved.
 *
 * Joining a workspace that exists is not signup. That stays by invitation
 * (LA-397), so nothing here ever adds anyone to a workspace but the one it
 * creates.
 */

import type { Context, Hono } from 'hono'
import { z } from 'zod'
import type { IAppEnv } from '../../../../server/src/app'
import { ApiError, now, type ICtx } from '../../../../server/src/core/ctx'
import type { IEditionDeps } from '../../../../server/src/core/edition'
import {
  emitEvent,
  flushPendingEvents,
} from '../../../../server/src/core/events'
import {
  createWorkspace,
  handleFromEmail,
  ownedWorkspaceCount,
  slugProblem,
  uniqueSlug,
} from '../../../../server/src/core/workspaces'
import type { ISqlDriver } from '../../../../server/src/db'
import { authedFrom, startSession } from '../../../../server/src/routes/auth'
import { finishIntent, pendingSignup } from './intent'

/** Decided by Jose, 2026-10-24: one workspace per account. Above it, sales. */
export const WORKSPACES_PER_ACCOUNT = 1

/** The legal documents a creator accepts, when the deployment names them. */
export interface ITermsConfig {
  version: string
  terms_url: string | null
  privacy_url: string | null
}

export function termsConfig(
  env: Record<string, string | undefined> = {},
): ITermsConfig | null {
  const version = env.ACTA_TERMS_VERSION?.trim()
  if (!version) return null
  return {
    version,
    terms_url: env.ACTA_TERMS_URL?.trim() || null,
    privacy_url: env.ACTA_PRIVACY_URL?.trim() || null,
  }
}

interface ISignupIdentity {
  source: 'session' | 'pending'
  email: string
  name: string
  platformUserId: string | null
  picture: string | null
  /** Set for a pending signup, which is finished once the workspace exists. */
  tokenHash?: string
}

/** Who is asking, from their session or their signup cookie. */
async function identityOf(
  c: Context,
  db: ISqlDriver,
): Promise<ISignupIdentity | null> {
  const authed = await authedFrom(
    c as unknown as Parameters<typeof authedFrom>[0],
  )
  // Only a person in a browser. A token is a grant on one workspace, not a
  // person who may found another.
  if (authed && authed.tokenKind === 'session' && authed.email) {
    const row = (
      await db.query<{
        name: string
        platform_user_id: string | null
        avatar_url: string | null
      }>('SELECT name, platform_user_id, avatar_url FROM actor WHERE id = ?', [
        authed.id,
      ])
    )[0]
    return {
      source: 'session',
      email: authed.email,
      name: row?.name ?? authed.email,
      platformUserId: row?.platform_user_id ?? null,
      picture: row?.avatar_url ?? null,
    }
  }
  const pending = await pendingSignup(c, db)
  if (!pending) return null
  return {
    source: 'pending',
    email: pending.email,
    name: pending.name ?? pending.email,
    platformUserId: pending.platformUserId,
    picture: pending.picture,
    tokenHash: pending.tokenHash,
  }
}

async function ownedBy(db: ISqlDriver, who: ISignupIdentity): Promise<number> {
  return ownedWorkspaceCount(db, {
    email: who.email,
    platformUserId: who.platformUserId ?? undefined,
  })
}

const zCreate = z.object({
  name: z.string().trim().min(1).max(80),
  slug: z.string().trim().toLowerCase().max(40).optional(),
  /** The terms version the person ticked, when the deployment has terms. */
  terms_version: z.string().max(40).optional(),
})

export function mountSignupRoutes(
  app: Hono<IAppEnv>,
  deps: IEditionDeps,
): void {
  const { db } = deps
  const salesUrl = () => deps.env?.ACTA_SALES_URL?.trim() || null

  /**
   * Everything the signup page needs to draw itself: who is signing up, how
   * many workspaces they may still create, and what they must accept.
   */
  app.get('/api/v1/auth/signup/state', async (c) => {
    const who = await identityOf(c, db)
    const terms = termsConfig(deps.env)
    if (!who)
      return c.json({ identity: null, terms, sales_url: salesUrl() }, 200, {
        'cache-control': 'no-store',
      })
    const owned = await ownedBy(db, who)
    return c.json(
      {
        identity: { email: who.email, name: who.name, source: who.source },
        owned,
        cap: WORKSPACES_PER_ACCOUNT,
        can_create: owned < WORKSPACES_PER_ACCOUNT,
        terms,
        sales_url: salesUrl(),
      },
      200,
      { 'cache-control': 'no-store' },
    )
  })

  /** What address a name would get, and whether a chosen one is free. */
  app.get('/api/v1/auth/signup/slug', async (c) => {
    if (!(await identityOf(c, db)))
      return c.json({ error: 'unauthorized' }, 401)
    const wanted = (c.req.query('slug') ?? '').trim().toLowerCase()
    if (wanted) {
      const problem = slugProblem(wanted)
      if (problem) return c.json({ slug: wanted, available: false, problem })
      const taken = await db.query('SELECT id FROM workspace WHERE slug = ?', [
        wanted,
      ])
      return c.json({
        slug: wanted,
        available: taken.length === 0,
        problem: taken.length === 0 ? null : 'that address is already taken',
      })
    }
    const suggested = await uniqueSlug(db, c.req.query('name') ?? '', '')
    return c.json({ slug: suggested, available: true, problem: null })
  })

  app.post('/api/v1/auth/signup/workspaces', async (c) => {
    const who = await identityOf(c, db)
    if (!who) return c.json({ error: 'unauthorized' }, 401)
    const parsed = zCreate.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success)
      return c.json({ error: 'name your workspace (up to 80 characters)' }, 400)
    const body = parsed.data

    const terms = termsConfig(deps.env)
    if (terms && body.terms_version !== terms.version)
      return c.json(
        {
          error: 'accept the terms and the privacy notice to continue',
          terms,
        },
        400,
      )

    const owned = await ownedBy(db, who)
    if (owned >= WORKSPACES_PER_ACCOUNT)
      return c.json(
        {
          error: 'workspace_limit',
          message: `An account can create ${WORKSPACES_PER_ACCOUNT} workspace. Contact sales for more.`,
          cap: WORKSPACES_PER_ACCOUNT,
          sales_url: salesUrl(),
        },
        403,
      )

    const at = now()
    let created
    try {
      created = await createWorkspace(db, {
        name: body.name,
        slug: body.slug || undefined,
        admin: {
          email: who.email,
          name: who.name,
          platformUserId: who.platformUserId ?? undefined,
          // Proved: the provider vouched for it, or the person signed in.
          emailConfirmed: true,
        },
        owner: {
          email: who.email,
          platformUserId: who.platformUserId ?? undefined,
        },
        terms: terms ? { version: terms.version, acceptedAt: at } : undefined,
      })
    } catch (err) {
      if (err instanceof ApiError)
        return c.json({ error: err.message }, err.status as 400 | 409)
      throw err
    }
    const adminId = created.adminId!
    if (who.picture) {
      await db.run('UPDATE actor SET avatar_url = ? WHERE id = ?', [
        who.picture,
        adminId,
      ])
    }

    const ctx: ICtx = {
      db,
      workspaceId: created.workspaceId,
      actor: {
        id: adminId,
        kind: 'human',
        handle: handleFromEmail(who.email),
        role: 'admin',
        scopes: ['read', 'write', 'admin'],
      },
    }
    await emitEvent(
      ctx,
      'workspace.created',
      'workspace',
      created.workspaceId,
      `created this workspace${terms ? `, accepting terms ${terms.version}` : ''}`,
      { slug: created.slug, terms_version: terms?.version ?? null },
    )
    flushPendingEvents()
    console.log(
      `signup: workspace ${created.slug} created by ${who.source} sign-in`,
    )

    // Someone with no workspace had no session either. They have one now, in
    // the workspace they just made. A signed-in person keeps theirs: it opens
    // every workspace that has them, this one included.
    if (who.source === 'pending' && who.tokenHash) {
      await finishIntent(c, db, who.tokenHash)
      await startSession(c, db, created.workspaceId, adminId, 'admin')
    }
    return c.json(
      { workspace_id: created.workspaceId, slug: created.slug },
      201,
    )
  })
}
