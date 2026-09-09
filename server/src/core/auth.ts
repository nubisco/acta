import { newId } from '@nubisco/acta-shared'
import type { ISqlDriver } from '../db'
import type { IActorCtx } from './ctx'
import { now } from './ctx'

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  )
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export interface IAuthedActor extends IActorCtx {
  tokenKind: 'session' | 'agent'
  /**
   * The workspace the token was minted in, and the email that identifies the
   * person across workspaces. A session grants a person, not a place: the URL
   * says which workspace, and the actor is resolved as (email, workspace) per
   * request. Agent tokens have no email and stay bound to their own workspace.
   */
  workspaceId: string
  email?: string
}

/** Resolve a bearer/cookie token to an actor, or null. */
export async function resolveToken(
  db: ISqlDriver,
  token: string,
): Promise<IAuthedActor | null> {
  const hash = await sha256Hex(token)
  const rows = await db.query<{
    kind: 'session' | 'agent'
    scopes: string
    expires_at: number | null
    revoked_at: number | null
    actor_id: string
    actor_kind: 'human' | 'agent' | 'system'
    handle: string
    role: 'admin' | 'member'
    on_behalf_of: string | null
    disabled: number
    workspace_id: string
    email: string | null
  }>(
    `SELECT t.kind, t.scopes, t.expires_at, t.revoked_at, t.workspace_id,
            a.id AS actor_id, a.kind AS actor_kind, a.handle, a.role, a.on_behalf_of,
            a.disabled, a.email
       FROM auth_token t JOIN actor a ON a.id = t.actor_id
      WHERE t.token_hash = ?`,
    [hash],
  )
  if (rows.length === 0) return null
  const r = rows[0]
  if (r.revoked_at !== null || r.disabled === 1) return null
  if (r.expires_at !== null && r.expires_at < now()) return null
  return {
    id: r.actor_id,
    kind: r.actor_kind,
    handle: r.handle,
    role: r.role,
    onBehalfOf: r.on_behalf_of ?? undefined,
    scopes: r.scopes.split(','),
    tokenKind: r.kind,
    workspaceId: r.workspace_id,
    email: r.email ?? undefined,
  }
}

export interface IWorkspaceRow {
  id: string
  name: string
  slug: string
}

/** A workspace by its URL segment. */
export async function workspaceBySlug(
  db: ISqlDriver,
  slug: string,
): Promise<IWorkspaceRow | null> {
  const rows = await db.query<IWorkspaceRow>(
    'SELECT id, name, slug FROM workspace WHERE slug = ?',
    [slug],
  )
  return rows[0] ?? null
}

/**
 * The actor this token's holder is inside `workspaceId`, or null if they are
 * not a member there.
 *
 * A session carries the person's email, so entering another workspace is a
 * lookup rather than a re-login. An agent token has no email and is a grant
 * on one workspace only, so it matches by its own workspace instead.
 */
export async function actorInWorkspace(
  db: ISqlDriver,
  authed: IAuthedActor,
  workspaceId: string,
): Promise<IActorCtx | null> {
  if (authed.workspaceId === workspaceId) return authed
  if (!authed.email) return null
  const rows = await db.query<{
    id: string
    kind: 'human' | 'agent' | 'system'
    handle: string
    role: 'admin' | 'member'
    on_behalf_of: string | null
  }>(
    `SELECT id, kind, handle, role, on_behalf_of FROM actor
      WHERE workspace_id = ? AND lower(email) = lower(?) AND disabled = 0
        AND kind = 'human'`,
    [workspaceId, authed.email],
  )
  const row = rows[0]
  if (!row) return null
  return {
    id: row.id,
    kind: row.kind,
    handle: row.handle,
    role: row.role,
    onBehalfOf: row.on_behalf_of ?? undefined,
    // Authority is a property of membership in *this* workspace, so it comes
    // from the row we just found rather than from the token. Being an admin
    // somewhere else must not carry over, and neither must being merely a
    // member elsewhere strip admin here.
    scopes:
      row.role === 'admin' ? ['read', 'write', 'admin'] : ['read', 'write'],
  }
}

/** Every workspace this person can reach, for the picker. */
export async function workspacesForEmail(
  db: ISqlDriver,
  email: string,
): Promise<IWorkspaceRow[]> {
  return db.query<IWorkspaceRow>(
    `SELECT w.id, w.name, w.slug FROM workspace w
       JOIN actor a ON a.workspace_id = w.id
      WHERE lower(a.email) = lower(?) AND a.disabled = 0 AND a.kind = 'human'
      ORDER BY w.name`,
    [email],
  )
}

export async function createToken(
  db: ISqlDriver,
  workspaceId: string,
  actorId: string,
  kind: 'session' | 'agent',
  scopes: string[],
  ttlMs?: number,
): Promise<string> {
  const token = randomToken()
  await db.run(
    `INSERT INTO auth_token (id, workspace_id, actor_id, kind, token_hash, scopes, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newId('act'),
      workspaceId,
      actorId,
      kind,
      await sha256Hex(token),
      scopes.join(','),
      ttlMs ? now() + ttlMs : null,
      now(),
    ],
  )
  return token
}

/** Six-digit OTP; delivery is pluggable (console by default, mvp F6). */
export type TOtpSender = (email: string, code: string) => Promise<void> | void

export const consoleOtpSender: TOtpSender = (email, code) => {
  console.log(`[acta] OTP for ${email}: ${code}`)
}
