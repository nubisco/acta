import { newId } from '@nubisco/acta-shared'
import type { ISqlDriver } from '../db'
import { ApiError, now, type ICtx } from './ctx'
import { seedDefaultLabels } from '../services/labels'

/**
 * Creating a workspace, the one way it is done.
 *
 * Bootstrap creates the instance's first workspace with it, and signup (the
 * EE, LA-398) creates every other one. Both get the same rows: the workspace,
 * its first admin when there is a person to be one, the system actor that
 * automations act as, and the default labels.
 */

/** URL-safe form of a workspace name: "Acme Corp." becomes "acme-corp". */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
  return slug || 'workspace'
}

/**
 * Addresses no workspace may take. Every top-level path the app or the server
 * answers on, so a workspace can never shadow a page, plus names that would
 * let a workspace pass itself off as us.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  // Paths the SPA and the server answer on.
  'api',
  'auth',
  'login',
  'logout',
  'signup',
  'invite',
  'oauth',
  'mcp',
  'healthz',
  'version',
  'assets',
  'static',
  'icons',
  'w',
  's',
  'b',
  'docs',
  'search',
  'activity',
  'settings',
  'goals',
  'workspaces',
  'well-known',
  'favicon-ico',
  'manifest-webmanifest',
  // Words a stranger could use to look official.
  'admin',
  'administrator',
  'root',
  'system',
  'support',
  'help',
  'status',
  'billing',
  'pricing',
  'sales',
  'security',
  'legal',
  'terms',
  'privacy',
  'abuse',
  'official',
  'staff',
  'team',
  'app',
  'www',
  'mail',
  'new',
  'null',
  'undefined',
  // Our own names.
  'acta',
  'nubisco',
  'platform',
  'verba',
  'stagewright',
  'prelo',
  'analytics',
  'cms',
])

/** 3 to 40 characters, lowercase letters, digits and inner hyphens. */
const SLUG_SHAPE = /^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$/

/** Why a slug cannot be used, or null when it can (taken aside). */
export function slugProblem(slug: string): string | null {
  if (!SLUG_SHAPE.test(slug) || slug.includes('--'))
    return 'use 3 to 40 lowercase letters, digits and single hyphens'
  if (RESERVED_SLUGS.has(slug)) return 'that address is reserved'
  return null
}

/**
 * A slug no other workspace holds, and not a reserved one. Two workspaces
 * called "Support" would otherwise collide on the unique index and fail the
 * insert, which is a confusing way to learn the name is taken.
 */
export async function uniqueSlug(
  db: ISqlDriver,
  name: string,
  ownId: string,
  /** The instance's own workspace may be called what the instance is. */
  allowReserved = false,
): Promise<string> {
  let base = slugify(name)
  if (base.length < 3) base = `${base}-workspace`.replace(/^-/, '')
  for (let n = 0; n < 100; n++) {
    const candidate = n === 0 ? base : `${base}-${n + 1}`
    if (!allowReserved && RESERVED_SLUGS.has(candidate)) continue
    const taken = await db.query<{ id: string }>(
      'SELECT id FROM workspace WHERE slug = ? AND id != ?',
      [candidate, ownId],
    )
    if (taken.length === 0) return candidate
  }
  return `${base}-${ownId.slice(-6)}`
}

export interface IWorkspaceAdmin {
  email: string
  name: string
  handle?: string
  /** The identity provider's id for this person, when one vouched for them. */
  platformUserId?: string
  /** Set when the address is already proved (a provider sign-in). */
  emailConfirmed?: boolean
}

export interface ICreateWorkspace {
  name: string
  /** Asked for explicitly. Checked, never adjusted: a taken one is a 409. */
  slug?: string
  /** The first admin. Bootstrap without ACTA_ADMIN_EMAIL has none. */
  admin?: IWorkspaceAdmin
  /** Signup records who created it, which the per-account cap counts. */
  owner?: { email: string; platformUserId?: string }
  terms?: { version: string; acceptedAt: number }
  /**
   * Bootstrap only: the instance's own workspace is named by its operator,
   * and an instance run by Nubisco is rightly called "nubisco".
   */
  allowReservedSlug?: boolean
}

export interface ICreatedWorkspace {
  workspaceId: string
  slug: string
  adminId: string | null
}

/** A handle from an email's local part: "Ana.Silva@x" becomes "ana-silva". */
export function handleFromEmail(email: string): string {
  const base = email
    .split('@')[0]
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-|-$/g, '')
  return base || 'member'
}

export async function createWorkspace(
  db: ISqlDriver,
  opts: ICreateWorkspace,
): Promise<ICreatedWorkspace> {
  const ts = now()
  const workspaceId = newId('ws')
  const adminId = opts.admin ? newId('act') : null
  const name = opts.name.trim() || 'Workspace'
  let slug: string
  if (opts.slug !== undefined) {
    const problem = slugProblem(opts.slug)
    if (problem) throw new ApiError(400, problem)
    const taken = await db.query('SELECT id FROM workspace WHERE slug = ?', [
      opts.slug,
    ])
    if (taken.length > 0)
      throw new ApiError(409, 'that address is already taken')
    slug = opts.slug
  } else {
    slug = await uniqueSlug(db, name, workspaceId, opts.allowReservedSlug)
  }

  await db.transaction(async () => {
    await db.run(
      `INSERT INTO workspace (id, name, slug, owner_email, owner_platform_user_id,
                              terms_version, terms_accepted_at, last_seen_at,
                              created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        workspaceId,
        name,
        slug,
        opts.owner ? opts.owner.email.toLowerCase() : null,
        opts.owner?.platformUserId ?? null,
        opts.terms?.version ?? null,
        opts.terms?.acceptedAt ?? null,
        // Its creator is looking at it right now.
        ts,
        ts,
      ],
    )
    // Only when there is an address to reach them at. An admin actor with a
    // null email is a seat nobody can sit in: OTP finds people by email and
    // SSO matches on it, so a seeded admin without one locks the workspace
    // into having an administrator that no human can ever be. Instances that
    // delegate identity to an SSO provider leave this unset and get their
    // administrator from the first person through the door instead; see
    // `firstAdmin` in the SSO callback.
    if (opts.admin && adminId) {
      await db.run(
        `INSERT INTO actor (id, workspace_id, kind, handle, name, email, role,
                            platform_user_id, email_confirmed_at, created_at)
         VALUES (?, ?, 'human', ?, ?, ?, 'admin', ?, ?, ?)`,
        [
          adminId,
          workspaceId,
          opts.admin.handle ?? handleFromEmail(opts.admin.email),
          opts.admin.name,
          opts.admin.email,
          opts.admin.platformUserId ?? null,
          opts.admin.emailConfirmed ? ts : null,
          ts,
        ],
      )
    }
    const systemId = newId('act')
    await db.run(
      `INSERT INTO actor (id, workspace_id, kind, handle, name, role, created_at)
       VALUES (?, ?, 'system', 'acta', 'Acta', 'member', ?)`,
      [systemId, workspaceId, ts],
    )
    // Attributed to whoever exists. Without an admin there is no actor to
    // credit the default labels to, and crediting them to an id that was never
    // inserted is a foreign key away from failing the whole creation.
    const seeder: ICtx['actor'] =
      opts.admin && adminId
        ? {
            id: adminId,
            kind: 'human',
            handle: opts.admin.handle ?? handleFromEmail(opts.admin.email),
            role: 'admin',
            scopes: ['read', 'write', 'admin'],
          }
        : {
            id: systemId,
            kind: 'system',
            handle: 'acta',
            role: 'member',
            scopes: ['read', 'write', 'admin'],
          }
    await seedDefaultLabels({ db, workspaceId, actor: seeder })
  })
  return { workspaceId, slug, adminId }
}

/**
 * How many workspaces this person has created through signup. Counts every
 * row still in the database, so one scheduled for deletion keeps counting
 * until it is purged: deleting and recreating is not a way round the cap.
 */
export async function ownedWorkspaceCount(
  db: ISqlDriver,
  who: { email: string; platformUserId?: string },
): Promise<number> {
  const rows = await db.query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM workspace
      WHERE owner_email = ?
         OR (? IS NOT NULL AND owner_platform_user_id = ?)`,
    [
      who.email.toLowerCase(),
      who.platformUserId ?? null,
      who.platformUserId ?? null,
    ],
  )
  return rows[0]?.n ?? 0
}
